// PLAN đợt 3 T-214 — tuỳ chọn, hộp thông báo, lịch sử gửi, cấu hình trên Postgres thật (SPEC-notifications S-009…S-011,
// S-017…S-019).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { handleUnsubscribe } from "../http/unsubscribe.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { createNotification } from "./dispatch.ts";
import { FakeEmailSender } from "./email.ts";
import {
  getPreferences,
  listDeliveries,
  listMyNotifications,
  markAllRead,
  markRead,
  retryDelivery,
  signUnsubscribe,
  unsubscribe,
  unsubscribeKey,
  updatePreference,
  updateSettings,
} from "./preferences.ts";
import { sendDueEmails } from "./send.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let manager: Actor;
let managerOther: Actor;
let hk: Actor;
let an: Actor;
let binh: Actor;
let P2: string;
// Bí mật phiên giả cho DB test tạm — ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
const SECRET = ["phien", "gia", "cho", "test"].join("-").padEnd(48, "x");
const key = unsubscribeKey(SECRET);
const NOW = new Date("2026-10-16T02:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ khác");
  P2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template, timezone)
            select ${P2}, organization_id, 'Cơ sở 2', template, timezone from properties where id = ${A.propertyId}`.execute(
    t.admin,
  );
  owner = await ownerOf(t, A);
  manager = await seedMember(t, A, "manager");
  managerOther = await seedMember(t, A, "manager", { properties: [P2] });
  hk = await seedMember(t, A, "housekeeping");
  an = await seedMember(t, A, "tenant", { name: "An" });
  binh = await seedMember(t, A, "tenant", { name: "Bình" });
  await sql`update persons set email = 'an@example.test' where id = ${an.personId}`.execute(t.admin);
});

afterAll(async () => {
  await t?.drop();
});

async function notify(
  person: Actor,
  type: "invoice_issued" | "invoice_overdue" = "invoice_issued",
  propertyId?: string,
) {
  const id = randomUUID();
  return (await withTenant(t.worker, { orgId: A.orgId }, (trx) =>
    createNotification(
      trx,
      A.orgId,
      {
        propertyId: propertyId ?? A.propertyId,
        recipientPersonId: person.personId,
        type,
        vars: {
          propertyName: "Nhà trọ Hoa Sen",
          period: "10/2026",
          dueOn: "2026-10-10",
          amount: 1_580_000,
          invoiceId: id,
        },
        dedupeKey: `${type}:${id}`,
      },
      { now: NOW },
    ),
  )) as string;
}

describe("S-017 hộp thông báo của mình", () => {
  it("chỉ thấy của mình + số chưa đọc; đánh dấu thông báo người khác → 404, không đổi; đọc tất cả", async () => {
    const n1 = await notify(an);
    await notify(an);
    const nb = await notify(binh);
    const mine = await listMyNotifications(t.runtime, an);
    expect(mine.items.every((x) => x.id !== nb)).toBe(true);
    expect(mine.unreadCount).toBe(2);
    expect(await codeOf(runAs(t, an, (ctx) => markRead(ctx, { notificationId: nb })))).toBe("NOT_FOUND");
    const rb = await sql<{
      read_at: Date | null;
    }>`select read_at from notifications where id = ${nb}`.execute(t.admin);
    expect(rb.rows[0]?.read_at).toBeNull();
    await okAs(t, an, (ctx) => markRead(ctx, { notificationId: n1 }));
    expect((await listMyNotifications(t.runtime, an)).unreadCount).toBe(1);
    expect(await okAs(t, an, (ctx) => markAllRead(ctx))).toEqual({ updated: 1 });
    expect((await listMyNotifications(t.runtime, an)).unreadCount).toBe(0);
    expect((await listMyNotifications(t.runtime, binh)).unreadCount).toBe(1);
  });
});

describe("S-009/S-011 tuỳ chọn theo loại", () => {
  it("mặc định nhận (D-015); tắt invoice_overdue có audit; tắt account_security → 422 PREFERENCE_REQUIRED, không đổi", async () => {
    const before = await getPreferences(t.runtime, an);
    expect(before.find((p) => p.type === "invoice_overdue")?.state).toBe("opted_in");
    expect(before.find((p) => p.type === "account_security")).toMatchObject({
      required: true,
      state: "opted_in",
    });
    await okAs(t, an, (ctx) => updatePreference(ctx, { type: "invoice_overdue", state: "opted_out" }));
    expect((await getPreferences(t.runtime, an)).find((p) => p.type === "invoice_overdue")?.state).toBe(
      "opted_out",
    );
    expect(
      await codeOf(
        runAs(t, an, (ctx) => updatePreference(ctx, { type: "account_security", state: "opted_out" })),
      ),
    ).toBe("PREFERENCE_REQUIRED");
    expect(
      await codeOf(runAs(t, an, (ctx) => updatePreference(ctx, { type: "khong_co", state: "opted_out" }))),
    ).toBe("VALIDATION_FAILED");
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'notification.preference_changed' and entity_id = ${an.personId}`.execute(
      t.admin,
    );
    expect(a.rows[0]?.n).toBe(1);
    await okAs(t, an, (ctx) => updatePreference(ctx, { type: "invoice_overdue", state: "opted_in" }));
  });
});

describe("S-010 huỷ đăng ký từ email", () => {
  it("email có liên kết; mở bằng POST không đăng nhập → opted_out đúng loại + audit; dùng lại cùng kết quả; hết hạn 410; sai chữ ký 404", async () => {
    await notify(an, "invoice_overdue");
    const fake = new FakeEmailSender();
    await sendDueEmails(t.worker, fake, { now: NOW, baseUrl: "https://app.example", unsubscribeKey: key });
    const mail = fake.sent.find((m) => m.subject.includes("quá hạn"));
    const link = /https:\/\/app\.example\/huy-dang-ky\?t=(\S+)/.exec(mail?.text ?? "")?.[1];
    expect(link).toBeTruthy();
    const post = (token: string) =>
      handleUnsubscribe(
        new Request("https://app.example/api/v1/notifications/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
        { db: t.runtime, secret: SECRET },
      );
    const r1 = await post(link as string);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { data: { message: string } }).data.message).toBe(
      "Bạn sẽ không nhận email nhắc quá hạn từ Nhà trọ Hoa Sen nữa.",
    );
    const r2 = await post(link as string);
    expect(r2.status).toBe(200);
    const pref = await sql<{ state: string; source: string }>`
      select state, source from notification_preferences where person_id = ${an.personId} and type = 'invoice_overdue'`.execute(
      t.admin,
    );
    expect(pref.rows[0]).toEqual({ state: "opted_out", source: "email_link" });
    const audits = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'notification.preference_changed' and entity_id = ${an.personId}
        and after->>'source' = 'email_link'`.execute(t.admin);
    expect(audits.rows[0]?.n).toBe(1);
    // Loại khác không đổi.
    expect((await getPreferences(t.runtime, an)).find((p) => p.type === "invoice_issued")?.state).toBe(
      "opted_in",
    );
    const expired = signUnsubscribe(key, {
      orgId: A.orgId,
      personId: an.personId,
      type: "invoice_issued",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await post(expired)).status).toBe(410);
    const forged = signUnsubscribe(unsubscribeKey("khoa-khac-khoa-khac-khoa-khac-khoa-khac"), {
      orgId: A.orgId,
      personId: an.personId,
      type: "invoice_issued",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await post(forged)).status).toBe(404);
    const required = signUnsubscribe(key, {
      orgId: A.orgId,
      personId: an.personId,
      type: "account_security",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(
      await unsubscribe(t.runtime, key, { token: required, correlationId: "test-corr" }).catch((e) => e.code),
    ).toBe("PREFERENCE_REQUIRED");
    expect((await getPreferences(t.runtime, an)).find((p) => p.type === "invoice_issued")?.state).toBe(
      "opted_in",
    );
    await sql`delete from notification_preferences where person_id = ${an.personId}`.execute(t.admin);
  });
});

describe("S-018 lịch sử gửi theo quyền", () => {
  it("buồng phòng/người thuê → 403; manager chỉ cơ sở trong phạm vi; owner toàn tổ chức; khác tổ chức không thấy; nhãn trung thực", async () => {
    await notify(an, "invoice_issued", A.propertyId);
    await notify(an, "invoice_issued", P2);
    await expect(listDeliveries(t.runtime, hk)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listDeliveries(t.runtime, an)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const all = await listDeliveries(t.runtime, owner);
    expect(new Set(all.map((d) => d.propertyId))).toEqual(new Set([A.propertyId, P2]));
    const m = await listDeliveries(t.runtime, manager);
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((d) => d.propertyId === A.propertyId)).toBe(true);
    await expect(listDeliveries(t.runtime, managerOther, { propertyId: A.propertyId })).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    expect((await listDeliveries(t.runtime, managerOther)).every((d) => d.propertyId === P2)).toBe(true);
    const ownerB = await ownerOf(t, B);
    expect(await listDeliveries(t.runtime, ownerB)).toEqual([]);
    const queued = all.find((d) => d.status === "queued");
    expect(queued?.statusLabel).toBe("Đang chờ gửi");
  });
});

describe("S-019 gửi lại thủ công", () => {
  it("dead → queued, attempts 0, audit; cùng Idempotency-Key không lần hai; sent → 409 DELIVERY_NOT_RETRYABLE; buồng phòng 403", async () => {
    const n = await notify(an);
    const d = await sql<{
      id: string;
    }>`select id from notification_deliveries where notification_id = ${n}`.execute(t.admin);
    const id = d.rows[0]?.id as string;
    await sql`update notification_deliveries set status = 'sending', attempts = 6, locked_until = now() where id = ${id}`.execute(
      t.admin,
    );
    await sql`update notification_deliveries set status = 'dead', locked_until = null where id = ${id}`.execute(
      t.admin,
    );
    expect(await codeOf(runAs(t, hk, (ctx) => retryDelivery(ctx, { deliveryId: id })))).toBe("FORBIDDEN");
    const key2 = randomUUID();
    const send = () =>
      runAs(t, manager, (ctx) => retryDelivery(ctx, { deliveryId: id }), {
        key: key2,
        command: "notifications.retryDelivery",
        payload: { delivery_id: id },
      });
    expect((await send()).status).toBe("committed");
    expect(await send()).toMatchObject({ status: "committed", replayed: true });
    const row = await sql<{ status: string; attempts: number }>`
      select status, attempts from notification_deliveries where id = ${id}`.execute(t.admin);
    expect(row.rows[0]).toEqual({ status: "queued", attempts: 0 });
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'notification.delivery_retried' and entity_id = ${id}
        and actor_person_id = ${manager.personId}`.execute(t.admin);
    expect(a.rows[0]?.n).toBe(1);
    await sendDueEmails(t.worker, new FakeEmailSender(), { now: new Date() });
    expect(await codeOf(runAs(t, manager, (ctx) => retryDelivery(ctx, { deliveryId: id })))).toBe(
      "DELIVERY_NOT_RETRYABLE",
    );
  });
});

describe("notifications.updateSettings", () => {
  it("owner/manager trong phạm vi lưu cấu hình (mốc sắp xếp, hạn lưu trú, khung giờ) có audit; sai → 422; buồng phòng 403; cơ sở ngoài phạm vi 404", async () => {
    await okAs(t, manager, (ctx) =>
      updateSettings(ctx, {
        propertyId: A.propertyId,
        overdueReminderOffsetsDays: [7, 1, 3, 1],
        stayNoticeDeadline: {
          domestic_cutoff: "23:00",
          domestic_next_day_before: "08:00",
          foreign_hours: 12,
        },
        sendWindowStart: "07:30",
      }),
    );
    const s = await sql<{ o: number[]; d: unknown; ws: string; we: string }>`
      select overdue_reminder_offsets_days as o, stay_notice_deadline as d, send_window_start::text as ws, send_window_end::text as we
      from notification_settings where property_id = ${A.propertyId}`.execute(t.admin);
    expect(s.rows[0]).toEqual({
      o: [7, 3, 1],
      d: { domestic_cutoff: "23:00", domestic_next_day_before: "08:00", foreign_hours: 12 },
      ws: "07:30:00",
      we: "20:00:00",
    });
    // Cập nhật một phần giữ phần còn lại; null = bỏ hạn lưu trú (chưa cấu hình, Q-08).
    await okAs(t, owner, (ctx) =>
      updateSettings(ctx, { propertyId: A.propertyId, stayNoticeDeadline: null }),
    );
    const s2 = await sql<{ o: number[]; d: unknown }>`
      select overdue_reminder_offsets_days as o, stay_notice_deadline as d from notification_settings where property_id = ${A.propertyId}`.execute(
      t.admin,
    );
    expect(s2.rows[0]).toEqual({ o: [7, 3, 1], d: null });
    const bad = (input: Parameters<typeof updateSettings>[1]) =>
      codeOf(runAs(t, owner, (ctx) => updateSettings(ctx, input)));
    expect(await bad({ propertyId: A.propertyId, overdueReminderOffsetsDays: [-1] })).toBe(
      "VALIDATION_FAILED",
    );
    expect(await bad({ propertyId: A.propertyId, sendWindowStart: "21:00" })).toBe("VALIDATION_FAILED");
    expect(await bad({ propertyId: A.propertyId, stayNoticeDeadline: { domestic_cutoff: "23:00" } })).toBe(
      "VALIDATION_FAILED",
    );
    expect(await bad({ propertyId: A.propertyId, stayNoticeDeadline: { foreign_hours: 0 } })).toBe(
      "VALIDATION_FAILED",
    );
    expect(await codeOf(runAs(t, hk, (ctx) => updateSettings(ctx, { propertyId: A.propertyId })))).toBe(
      "FORBIDDEN",
    );
    expect(
      await codeOf(runAs(t, managerOther, (ctx) => updateSettings(ctx, { propertyId: A.propertyId }))),
    ).toBe("NOT_FOUND");
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'notification.settings_updated' and property_id = ${A.propertyId}`.execute(
      t.admin,
    );
    expect(a.rows[0]?.n).toBe(2);
  });
});
