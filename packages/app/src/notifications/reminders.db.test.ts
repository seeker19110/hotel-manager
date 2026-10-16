// PLAN đợt 3 T-215 — nhắc theo lịch trên Postgres thật (SPEC-notifications S-007, S-008, S-013…S-016, S-020, S-021).
import { randomUUID } from "node:crypto";
import { seedLease } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { markNoticeSubmitted } from "../stay/residence-notices.ts";
import { walkIn } from "../stay/stays.ts";
import { okAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { runReminders, scanLeaseExpiry, scanOverdue, scanStayNotice } from "./reminders.ts";

let h: Hotel;
let tenant: Actor;
let leaseId: string;
const pii = createPiiCipher(devKeyring());
/** Giờ cơ sở (Asia/Ho_Chi_Minh, UTC+7) → UTC. */
const vn = (local: string) => new Date(`${local}:00+07:00`);

const count = async (prefix: string) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from notifications where organization_id = ${h.org.orgId} and dedupe_key like ${`${prefix}%`}`.execute(
      h.t.admin,
    )
  ).rows[0]?.n ?? 0;

async function activate(id: string, effectiveTo: string) {
  await h.t.admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set effective_to = ${effectiveTo}::date, signed_at = now(), terms_hash = ${"0".repeat(64)},
                     terms_snapshot = '{}' where lease_id = ${id}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${id}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${id}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${id}, 'move_in', '2026-09-01', ${h.org.ownerMembershipId},
                      now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${id}`.execute(trx);
  });
}

beforeAll(async () => {
  h = await seedHotel();
  tenant = await seedMember(h.t, h.org, "tenant", { name: "Người thuê An" });
  leaseId = (
    await seedLease(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      representativePersonId: tenant.personId,
      effectiveFrom: "2026-09-01",
    })
  ).leaseId;
  await activate(leaseId, "2026-11-30");
});

afterAll(async () => {
  await h?.t.drop();
});

async function invoice(total: number): Promise<string> {
  const id = randomUUID();
  await h.t.admin.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, lease_id, number, memo_ref, payer_person_id,
                                    business_date, due_on, total)
              values (${id}, ${h.org.orgId}, ${h.org.propertyId}, 'fee', ${leaseId}, ${`R-${id.slice(0, 8)}`},
                      ${`HM${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`}, ${tenant.personId}, '2026-10-01', '2026-10-10',
                      ${total})`.execute(trx);
    await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                         quantity, unit_price, amount, rounding_rule, formula_version)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${id}, 1, 'fee', 'Tiền phòng (giả)', 'REV_FEE', 1,
                      ${total}, ${total}, 'HALF_UP_1', 1)`.execute(trx);
  });
  return id;
}

describe("S-007/S-008 nhắc quá hạn", () => {
  it("+1 ngày lúc 08:00 giờ cơ sở → 1 nhắc dedupe theo ngày; chạy lại không lặp; trước khung giờ / ngày không thuộc lịch → không; tất toán → hết nhắc", async () => {
    const inv = await invoice(1_580_000);
    expect(await scanOverdue(h.t.worker, vn("2026-10-11T07:59"))).toBe(0);
    expect(await scanOverdue(h.t.worker, vn("2026-10-11T08:00"))).toBe(1);
    expect(await scanOverdue(h.t.worker, vn("2026-10-11T15:00"))).toBe(0);
    const n = await sql<{ dedupe_key: string; recipient_person_id: string; body: string; severity: string }>`
      select dedupe_key, recipient_person_id, body, severity from notifications where dedupe_key like ${`invoice_overdue:${inv}%`}`.execute(
      h.t.admin,
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({
      dedupe_key: `invoice_overdue:${inv}:2026-10-11`,
      recipient_person_id: tenant.personId,
      severity: "overdue",
    });
    expect(n.rows[0]?.body).toContain("1.580.000 đ");
    expect(await scanOverdue(h.t.worker, vn("2026-10-12T09:00"))).toBe(0);
    // Tất toán trước mốc +3 → không nhắc nữa (S-008 "ngày sau không tạo nhắc mới").
    await sql`update invoices set allocated_total = total where id = ${inv}`.execute(h.t.admin);
    expect(await scanOverdue(h.t.worker, vn("2026-10-13T09:00"))).toBe(0);
  });

  it("cấu hình cơ sở đổi lịch nhắc và khung giờ", async () => {
    const inv = await invoice(500_000);
    await sql`insert into notification_settings (id, organization_id, property_id, overdue_reminder_offsets_days, send_window_start,
                                                 send_window_end, updated_by)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, '{2}', '06:00', '21:00', ${h.org.ownerMembershipId})
              on conflict (organization_id, property_id) do update set overdue_reminder_offsets_days = '{2}',
                send_window_start = '06:00', send_window_end = '21:00'`.execute(h.t.admin);
    expect(await scanOverdue(h.t.worker, vn("2026-10-11T09:00"))).toBe(0);
    expect(await scanOverdue(h.t.worker, vn("2026-10-12T06:30"))).toBe(1);
    expect(await count(`invoice_overdue:${inv}:2026-10-12`)).toBe(1);
    await sql`update notification_settings set overdue_reminder_offsets_days = '{1,3,7}', send_window_start = '08:00',
                     send_window_end = '20:00' where property_id = ${h.org.propertyId}`.execute(h.t.admin);
  });
});

describe("S-013 nhắc hợp đồng sắp hết hạn", () => {
  it("mốc 30 ngày: quản lý/owner + người đại diện mỗi người 1; chạy lại sau sự cố không lặp; ngày khác mốc không nhắc", async () => {
    expect(await scanLeaseExpiry(h.t.worker, vn("2026-10-30T09:00"))).toBe(0);
    const first = await scanLeaseExpiry(h.t.worker, vn("2026-10-31T09:00"));
    expect(first).toBeGreaterThanOrEqual(3);
    expect(await scanLeaseExpiry(h.t.worker, vn("2026-10-31T18:00"))).toBe(0);
    const r = await sql<{ recipient_person_id: string; link: string }>`
      select recipient_person_id, link from notifications where dedupe_key = ${`lease_expiring:${leaseId}:1:30`}`.execute(
      h.t.admin,
    );
    const who = r.rows.map((x) => x.recipient_person_id);
    // Người thuê mở portal; nhân viên mở trang hợp đồng (review PR #10).
    const linkOf = (p: string) => r.rows.find((x) => x.recipient_person_id === p)?.link;
    expect(linkOf(tenant.personId)).toBe("/portal/hop-dong");
    expect(linkOf(h.manager.personId)).toBe(`/hop-dong/${leaseId}`);
    expect(who).toContain(h.manager.personId);
    expect(who).toContain(h.owner.personId);
    expect(who).toContain(tenant.personId);
    expect(who).not.toContain(h.frontDesk.personId);
  });

  it("đã gia hạn (phiên bản ký mới có ngày kết thúc mới) → không nhắc theo ngày cũ", async () => {
    const tenant2 = await seedMember(h.t, h.org, "tenant", { name: "Người thuê Bình" });
    const l2 = (
      await seedLease(h.t.admin, {
        orgId: h.org.orgId,
        propertyId: h.org.propertyId,
        representativePersonId: tenant2.personId,
        effectiveFrom: "2026-09-01",
      })
    ).leaseId;
    await activate(l2, "2026-11-07");
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, effective_to,
                                          rent_amount, deposit_amount, signed_at, terms_hash, terms_snapshot)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${l2}, 2, 'appendix', '2026-11-08', '2027-11-07',
                      3000000, 3000000, now(), ${"1".repeat(64)}, '{}')`.execute(h.t.admin);
    await scanLeaseExpiry(h.t.worker, vn("2026-10-31T09:00"));
    expect(await count(`lease_expiring:${l2}:`)).toBe(0);
  });
});

describe("S-014…S-016, S-021 nhắc thông báo lưu trú", () => {
  let unitSeq = 0;
  async function stayAt(local: string) {
    const unit = randomUUID();
    unitSeq += 1;
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
              values (${unit}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`6${String(unitSeq).padStart(2, "0")}`}, 'inspected')`.execute(
      h.t.admin,
    );
    return okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: unit,
        departureDate: "2026-10-17",
        guests: [
          {
            fullName: "Khách lưu trú",
            phone: "0911222333",
            docType: "cccd",
            docNumber: `0019${String(unitSeq).padStart(8, "0")}`,
          },
        ],
        now: vn(local),
      }),
    );
  }

  it("có hạn 23:00 → nhắc thường 1 lần; ≤ 30 phút → Khẩn; quá hạn → 1 lần mỗi ngày kinh doanh; đã nộp → ngừng", async () => {
    await sql`insert into notification_settings (id, organization_id, property_id, stay_notice_deadline, updated_by)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId},
                      '{"domestic_cutoff":"23:00","domestic_next_day_before":"08:00","foreign_hours":12}', ${h.org.ownerMembershipId})
              on conflict (organization_id, property_id) do update set stay_notice_deadline = excluded.stay_notice_deadline`.execute(
      h.t.admin,
    );
    const s = await stayAt("2026-10-15T20:10");
    const due = await sql<{
      due_at: Date;
    }>`select due_at from residence_notices where id = ${s.noticeId}`.execute(h.t.admin);
    expect(due.rows[0]?.due_at.toISOString()).toBe(vn("2026-10-15T23:00").toISOString());
    await scanStayNotice(h.t.worker, vn("2026-10-15T20:15"));
    expect(await count(`stay_notice_due:${s.noticeId}`)).toBeGreaterThanOrEqual(2); // lễ tân + quản lý
    const body = await sql<{ body: string; recipient_person_id: string }>`
      select body, recipient_person_id from notifications where dedupe_key = ${`stay_notice_due:${s.noticeId}`}`.execute(
      h.t.admin,
    );
    expect(body.rows[0]?.body).toMatch(/^Phòng 6\d\d: cần thông báo lưu trú trước 23:00 15\/10\/2026/);
    expect(body.rows.map((x) => x.recipient_person_id)).not.toContain(h.housekeeping.personId);
    await scanStayNotice(h.t.worker, vn("2026-10-15T21:00"));
    expect(await count(`stay_notice_urgent:${s.noticeId}`)).toBe(0);
    await scanStayNotice(h.t.worker, vn("2026-10-15T22:40"));
    const urgent = await sql<{ title: string; severity: string }>`
      select title, severity from notifications where dedupe_key = ${`stay_notice_urgent:${s.noticeId}`} limit 1`.execute(
      h.t.admin,
    );
    expect(urgent.rows[0]).toMatchObject({ severity: "urgent" });
    expect(urgent.rows[0]?.title).toMatch(/^Khẩn: /);
    await scanStayNotice(h.t.worker, vn("2026-10-15T23:10"));
    await scanStayNotice(h.t.worker, vn("2026-10-15T23:50"));
    const perDay = await count(`stay_notice_overdue:${s.noticeId}:2026-10-15`);
    expect(perDay).toBeGreaterThanOrEqual(2);
    await scanStayNotice(h.t.worker, vn("2026-10-16T09:00"));
    expect(await count(`stay_notice_overdue:${s.noticeId}:2026-10-16`)).toBe(perDay);
    // Đánh dấu đã nộp (kể cả sau hạn) → ngừng nhắc; bản ghi quá hạn giữ để báo cáo.
    await okAs(h.t, h.frontDesk, (ctx) =>
      markNoticeSubmitted(ctx, {
        noticeId: s.noticeId,
        submittedAt: vn("2026-10-16T09:30"),
        channel: "online",
      }),
    );
    await scanStayNotice(h.t.worker, vn("2026-10-17T09:00"));
    expect(await count(`stay_notice_overdue:${s.noticeId}:2026-10-17`)).toBe(0);
  });

  it("S-020 chưa cấu hình hạn → không tính hạn, không nhắc; owner/manager nhận cảnh báo cấu hình tối đa 1 lần/ngày", async () => {
    await sql`update notification_settings set stay_notice_deadline = null where property_id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    const s = await stayAt("2026-10-15T14:00");
    const due = await sql<{ due_at: Date | null; status: string }>`
      select due_at, status from residence_notices where id = ${s.noticeId}`.execute(h.t.admin);
    expect(due.rows[0]).toEqual({ due_at: null, status: "pending" });
    await scanStayNotice(h.t.worker, vn("2026-10-15T15:00"));
    await scanStayNotice(h.t.worker, vn("2026-10-15T18:00"));
    expect(await count(`stay_notice_due:${s.noticeId}`)).toBe(0);
    const warn = await sql<{ recipient_person_id: string; title: string }>`
      select recipient_person_id, title from notifications
      where dedupe_key = ${`stay_notice_config_missing:${h.org.propertyId}:2026-10-15`}`.execute(h.t.admin);
    expect(warn.rows.map((x) => x.recipient_person_id).sort()).toEqual(
      [h.owner.personId, h.manager.personId].sort(),
    );
    expect(warn.rows[0]?.title).toBe("Chưa cấu hình hạn thông báo lưu trú");
    await scanStayNotice(h.t.worker, vn("2026-10-16T09:00"));
    expect(await count(`stay_notice_config_missing:${h.org.propertyId}:2026-10-16`)).toBe(2);
  });

  it("tổ chức khác không nhận gì (quét theo từng tổ chức)", async () => {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from notifications where organization_id = ${h.other.orgId}`.execute(
      h.t.admin,
    );
    expect(r.rows[0]?.n).toBe(0);
  });
});

describe("Review PR #10 — cô lập lỗi khi nhắc theo lịch", () => {
  async function leaseEnding(end: string, name: string): Promise<{ leaseId: string; unitId: string }> {
    const p = await seedMember(h.t, h.org, "tenant", { name });
    const l = await seedLease(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      representativePersonId: p.personId,
      effectiveFrom: "2026-09-01",
    });
    await activate(l.leaseId, end);
    return l;
  }

  it("một hợp đồng không render được (mã phòng chỉ ký tự điều khiển) → bỏ riêng mục đó + log, hợp đồng khác vẫn nhắc", async () => {
    const bad = await leaseEnding("2026-12-15", "Người thuê C");
    const good = await leaseEnding("2026-12-15", "Người thuê D");
    await sql`update units set code = ${"\u0001"} where id = ${bad.unitId}`.execute(h.t.admin);
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    await scanLeaseExpiry(h.t.worker, vn("2026-11-15T09:00"), (event, fields) =>
      logs.push({ event, fields }),
    );
    expect(await count(`lease_expiring:${good.leaseId}:`)).toBeGreaterThanOrEqual(3);
    expect(await count(`lease_expiring:${bad.leaseId}:`)).toBe(0);
    const te = logs.filter((l) => l.event === "notification.template_error");
    expect(te.length).toBeGreaterThanOrEqual(1);
    expect(te.every((l) => l.fields.type === "lease_expiring")).toBe(true);
    expect(JSON.stringify(te)).not.toContain("Người thuê");
  });

  it("một tổ chức lỗi khi ghi → tổ chức khác vẫn được nhắc, các loại quét sau vẫn chạy; runReminders ném AggregateError sau khi chạy hết", async () => {
    const inv = await invoice(700_000);
    const l = await leaseEnding("2026-11-10", "Người thuê E");
    // Tổ chức kia có một phiếu quá hạn thật; ghi thông báo của tổ chức đó bị lỗi (trigger tạm — mô phỏng lỗi CSDL).
    const otherTenant = await seedMember(h.t, h.other, "tenant", { name: "Người thuê khác" });
    const otherLease = await seedLease(h.t.admin, {
      orgId: h.other.orgId,
      propertyId: h.other.propertyId,
      representativePersonId: otherTenant.personId,
      effectiveFrom: "2026-09-01",
    });
    const otherInv = randomUUID();
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`insert into invoices (id, organization_id, property_id, kind, lease_id, number, memo_ref, payer_person_id,
                                      business_date, due_on, total)
                values (${otherInv}, ${h.other.orgId}, ${h.other.propertyId}, 'fee', ${otherLease.leaseId}, ${`R-${otherInv.slice(0, 8)}`},
                        ${`HM${otherInv.replaceAll("-", "").slice(0, 10).toUpperCase()}`}, ${otherTenant.personId}, '2026-10-01',
                        '2026-10-10', 400000)`.execute(trx);
      await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                           quantity, unit_price, amount, rounding_rule, formula_version)
                values (${randomUUID()}, ${h.other.orgId}, ${h.other.propertyId}, ${otherInv}, 1, 'fee', 'Phí (giả)', 'REV_FEE', 1,
                        400000, 400000, 'HALF_UP_1', 1)`.execute(trx);
    });
    await sql
      .raw(`
      CREATE FUNCTION pg_temp_fail_org() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.organization_id = '${h.other.orgId}' THEN RAISE EXCEPTION 'lỗi giả cho tổ chức kia'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_test_fail_org BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_org();
    `)
      .execute(h.t.admin);
    try {
      const logs: { event: string; fields: Record<string, unknown> }[] = [];
      const err = await runReminders(h.t.worker, vn("2026-10-11T09:00"), (event, fields) =>
        logs.push({ event, fields }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(AggregateError);
      const failed = logs.filter((x) => x.event === "reminder.org_failed");
      expect(failed).toEqual([
        {
          event: "reminder.org_failed",
          fields: { scan: "overdue", org_id: h.other.orgId, error: "error", code: "P0001" },
        },
      ]);
      // Tổ chức còn lại: nhắc quá hạn (cùng loại quét với tổ chức lỗi) VÀ nhắc hợp đồng (loại quét sau) vẫn được tạo.
      expect(await count(`invoice_overdue:${inv}:2026-10-11`)).toBe(1);
      expect(await count(`lease_expiring:${l.leaseId}:1:30`)).toBeGreaterThanOrEqual(3);
    } finally {
      await sql
        .raw("DROP TRIGGER trg_test_fail_org ON notifications; DROP FUNCTION pg_temp_fail_org();")
        .execute(h.t.admin);
    }
  });
});
