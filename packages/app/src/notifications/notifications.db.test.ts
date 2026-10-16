// PLAN đợt 3 T-211 — thông báo trên Postgres thật (SPEC-notifications S-001…S-006, S-008…S-012, S-017…S-019; INV-G6, INV-G1).
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  findIsolationLeaks,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { handleUnsubscribe } from "../http/unsubscribe-route.ts";
import { createLogger } from "../logging/logger.ts";
import { type CommandContext, executeCommand } from "../pipeline/command.ts";
import {
  BACKOFF_SECONDS,
  createNotification,
  DELIVERY_STATUS_LABEL,
  dispatchNotificationEvent,
  MAX_ATTEMPTS,
  NOTIFICATION_TYPES,
  type NotificationEvent,
  type SendConfig,
  sendDueEmails,
} from "./dispatch.ts";
import { FakeEmailSender } from "./email.ts";
import {
  getPreferences,
  getSettings,
  listDeliveries,
  listMine,
  markAllRead,
  markRead,
  retryDelivery,
  unsubscribeByToken,
  updatePreferences,
  updateSettings,
} from "./notifications.ts";
import { signUnsubscribeToken } from "./token.ts";

const SECRET = "s".repeat(48);
const CFG: SendConfig = { baseUrl: "https://app.hoasen.example", tokenSecret: SECRET };

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let P2: string;
let owner: Actor;
let manager: Actor;
let housekeeping: Actor;
let an: Actor;
let binh: Actor;
let ownerB: Actor;
let anPerson: string;
let binhPerson: string;
const fake = new FakeEmailSender();
let nowMs = Date.parse("2026-10-16T01:00:00Z");
const clock = () => new Date(nowMs);

async function addPerson(orgId: string, name: string, email: string | null, phone?: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email, phone) values (${id}, ${orgId}, ${name}, ${email}, ${phone ?? null})`.execute(
    t.admin,
  );
  return id;
}

async function member(
  orgId: string,
  role: string,
  email: string | null,
  props: string[],
  name = role,
): Promise<{ actor: Actor; personId: string }> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const personId = await addPerson(orgId, name, email);
  const membership = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${orgId}, ${user}, ${personId}, ${role})`.execute(t.admin);
  for (const p of props) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${orgId}, ${membership}, ${p})`.execute(t.admin);
  }
  return {
    actor: await resolveActor(t.runtime, { authUserId: user, orgId, twoFactorEnabled: true }),
    personId,
  };
}

function run<T>(
  actor: Actor,
  fn: (ctx: CommandContext) => Promise<{ data: T; httpStatus?: number }>,
  key = randomUUID(),
) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "notifications.test", idempotencyKey: key, payload: { key }, correlationId: "corr-test-1" },
    fn,
  );
}

async function ok<T>(p: ReturnType<typeof run<T>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function failure(p: ReturnType<typeof run<unknown>>): Promise<{ code: string; status: number }> {
  const r = await p;
  if (r.status !== "failed") throw new Error("mong đợi lỗi");
  return { code: r.problem.code, status: r.problem.status };
}

/** Phát sự kiện bằng command thật (ghi outbox cùng transaction) rồi dựng job như relay sẽ giao. */
async function emit(
  eventType: string,
  payload: Record<string, string | number>,
  orgId = A.orgId,
  actor = owner,
): Promise<NotificationEvent> {
  const key = randomUUID();
  await ok(
    run(
      actor,
      async (ctx) => {
        await ctx.emit({ eventType, payload, aggregateId: randomUUID() });
        return { data: {} };
      },
      key,
    ),
  );
  const r = await sql<{
    id: string;
  }>`select id from outbox where organization_id = ${orgId} and command_id = ${key}`.execute(t.admin);
  return { organization_id: orgId, outbox_id: r.rows[0]?.id as string, event_type: eventType, payload };
}

async function invoiceFor(payer: string, propertyId = A.propertyId, orgId = A.orgId, amount = 1_580_000) {
  return seedIssuedInvoice(t.admin, { orgId, propertyId, payerPersonId: payer, lines: [{ amount }] });
}

const deliveries = async (where = sql`true`) =>
  (
    await sql<{
      id: string;
      status: string;
      attempts: number;
      last_error_code: string | null;
      suppressed_reason: string | null;
      next_attempt_at: Date | null;
      notification_id: string;
      property_id: string | null;
    }>`select id, status, attempts, last_error_code, suppressed_reason, next_attempt_at, notification_id, property_id
       from notification_deliveries where ${where} order by created_at, id`.execute(t.admin)
  ).rows;

const count = async (table: string) =>
  Number(
    (await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(t.admin)).rows[0]?.n,
  );

const send = (limit = 50) => sendDueEmails(t.worker, fake, CFG, { now: clock, limit });

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ B");
  P2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${P2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
    t.admin,
  );
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  ownerB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  const m = await member(A.orgId, "manager", "quanly@example.test", [A.propertyId]);
  manager = m.actor;
  housekeeping = (await member(A.orgId, "housekeeping", null, [A.propertyId])).actor;
  const a = await member(A.orgId, "tenant", "an@example.test", [], "An");
  an = a.actor;
  anPerson = a.personId;
  const b = await member(A.orgId, "tenant", "binh@example.test", [], "Bình");
  binh = b.actor;
  binhPerson = b.personId;
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  fake.clear();
  fake.behavior = "ok";
  fake.latencyMs = 0;
  // Mỗi test bắt đầu không còn lần gửi nào tới hạn từ test trước.
  await sql`update notification_deliveries set status = 'suppressed', suppressed_reason = 'OPTED_OUT', next_attempt_at = null,
            locked_until = null, last_error_code = null, sent_at = null, provider_message_id = null
            where status in ('queued','retrying','sending')`.execute(t.admin);
  await sql`delete from notification_preferences`.execute(t.admin);
});

describe("S-001/S-006 phát hành phiếu → thông báo trong app + email", () => {
  it("1 thông báo + 1 delivery queued → sending → sent; email mẫu invoice_issued; UI không báo 'đã gửi' khi mới queued", async () => {
    const inv = await invoiceFor(anPerson);
    const ev = await emit("invoice.issued", { invoice_id: inv.invoiceId, total: inv.total });
    const r = await dispatchNotificationEvent(t.worker, ev, clock());
    expect(r).toEqual({ created: 1, duplicates: 0 });

    const mine = await listMine(t.runtime, an, {});
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ type: "invoice_issued", read_at: null });
    expect(mine.unread_count).toBe(1);
    expect(mine.items[0]?.body).toContain("1.580.000 đ"); // trong app (đã đăng nhập) có số tiền

    // Mới xếp hàng: nhãn "Đang chờ gửi", KHÔNG có chữ "đã chuyển/đã gửi".
    const queued = await listDeliveries(t.runtime, manager, {});
    expect(queued.items).toHaveLength(1);
    expect(queued.items[0]).toMatchObject({
      status: "queued",
      status_label: "Đang chờ gửi",
      type: "invoice_issued",
    });
    expect(queued.items[0]?.status_label).not.toMatch(/Đã/);
    expect(fake.mailbox).toHaveLength(0);

    const s = await send();
    expect(s).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.mailbox).toHaveLength(1);
    const mail = fake.mailbox[0];
    expect(mail).toMatchObject({ to: "an@example.test", template: "invoice_issued" });
    expect(mail?.idempotencyKey).toBe(queued.items[0]?.id);
    const sent = await listDeliveries(t.runtime, manager, { status: "sent" });
    expect(sent.items[0]?.status_label).toBe("Đã chuyển cho nhà cung cấp email");
    // Nhãn: chỉ `sent` mới chứa "Đã chuyển"; failed/dead đều "cần xử lý".
    for (const [st, label] of Object.entries(DELIVERY_STATUS_LABEL)) {
      if (st !== "sent") expect(label).not.toMatch(/Đã chuyển|Đã gửi|Đã nhận/);
    }
    expect(DELIVERY_STATUS_LABEL.dead).toBe("Gửi thất bại — cần xử lý");
    expect(DELIVERY_STATUS_LABEL.failed).toBe("Gửi thất bại — cần xử lý");
  });

  it("email chỉ có tên cơ sở, kỳ, hạn, liên kết portal + huỷ đăng ký; không số tiền (Q-03)", async () => {
    const mail = fake.mailbox[0];
    expect(mail).toBeUndefined(); // beforeEach đã xoá; dựng lại
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    await send();
    const m = fake.mailbox[0];
    expect(m?.rendered.text).toContain("Nhà trọ Hoa Sen — CS1");
    expect(m?.rendered.text).toContain("https://app.hoasen.example/hoa-don/");
    expect(m?.rendered.text).toContain("/api/v1/notifications/unsubscribe?token=");
    expect(`${m?.rendered.text}${m?.rendered.subject}`).not.toMatch(/\d[\d.]*\s?đ(?!\p{L})|1\.580|1580000/u);
  });
});

describe("S-002 outbox chỉ phát sau commit", () => {
  it("command rollback sau khi ghi outbox → không có outbox, không thông báo, không email", async () => {
    const inv = await invoiceFor(anPerson);
    const before = { n: await count("notifications"), o: await count("outbox") };
    const key = randomUUID();
    await expect(
      run(
        owner,
        async (ctx) => {
          await ctx.emit({ eventType: "invoice.issued", payload: { invoice_id: inv.invoiceId } });
          throw new Error("lỗi sau khi ghi outbox, trước COMMIT");
        },
        key,
      ),
    ).rejects.toThrow(/trước COMMIT/);
    const o = await sql<{ n: string }>`select count(*) as n from outbox where command_id = ${key}`.execute(
      t.admin,
    );
    expect(Number(o.rows[0]?.n)).toBe(0);
    expect(await count("outbox")).toBe(before.o);
    // Relay không còn gì để nhận cho sự kiện này (hàng chưa từng được commit).
    const claimed = await t.worker
      .transaction()
      .execute((trx) =>
        sql<{ payload: { invoice_id?: string } }>`select payload from app.outbox_claim(1000)`.execute(trx),
      );
    expect(claimed.rows.filter((x) => x.payload.invoice_id === inv.invoiceId)).toHaveLength(0);
    expect(await count("notifications")).toBe(before.n);
    expect((await send()).claimed).toBe(0);
    expect(fake.mailbox).toHaveLength(0);
  });
});

describe("S-003 dedupe và hai worker", () => {
  it("sự kiện giao 2 lần → 1 thông báo, 1 delivery, 1 email (adapter nhận idempotencyKey = delivery_id)", async () => {
    const inv = await invoiceFor(anPerson);
    const ev = await emit("invoice.issued", { invoice_id: inv.invoiceId });
    const first = await dispatchNotificationEvent(t.worker, ev, clock());
    const second = await dispatchNotificationEvent(t.worker, ev, clock());
    expect(first.created).toBe(1);
    expect(second).toEqual({ created: 0, duplicates: 1 });
    const n = await sql<{
      n: string;
    }>`select count(*) as n from notifications where dedupe_key = ${`invoice_issued:${inv.invoiceId}`}`.execute(
      t.admin,
    );
    expect(Number(n.rows[0]?.n)).toBe(1);
    expect(
      await deliveries(
        sql`notification_id in (select id from notifications where dedupe_key = ${`invoice_issued:${inv.invoiceId}`})`,
      ),
    ).toHaveLength(1);
    await send();
    await send();
    expect(fake.mailbox).toHaveLength(1);
  });

  it("worker chết sau khi gửi, trước khi ghi `sent`: nhận lại 'sending' quá hạn khoá → nhà cung cấp khử trùng, vẫn 1 thư", async () => {
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    await send();
    expect(fake.mailbox).toHaveLength(1);
    const [d] = await deliveries(
      sql`notification_id in (select id from notifications where dedupe_key = ${`invoice_issued:${inv.invoiceId}`})`,
    );
    // Mô phỏng: kết quả `sent` chưa kịp ghi — hàng còn 'sending' với khoá đã hết hạn.
    await sql`update notification_deliveries set status = 'sending', sent_at = null, provider_message_id = null,
              locked_until = ${new Date(nowMs - 1000)} where id = ${d?.id}`.execute(t.admin);
    const s = await send();
    expect(s.sent).toBe(1);
    expect(fake.calls).toBe(2);
    expect(fake.mailbox).toHaveLength(1);
    expect((await deliveries(sql`id = ${d?.id}`))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("hai worker chạy đồng thời → mỗi delivery gửi đúng một lần", async () => {
    const people = await Promise.all(
      Array.from({ length: 12 }, (_, i) => addPerson(A.orgId, `Khách ${i}`, `khach${i}@example.test`)),
    );
    for (const p of people) {
      const inv = await invoiceFor(p, A.propertyId, A.orgId, 1000);
      await dispatchNotificationEvent(
        t.worker,
        await emit("invoice.issued", { invoice_id: inv.invoiceId }),
        clock(),
      );
    }
    fake.latencyMs = 20;
    const [s1, s2] = await Promise.all([send(8), send(8)]);
    expect(s1.sent + s2.sent).toBe(12);
    expect(fake.calls).toBe(12);
    expect(new Set(fake.mailbox.map((m) => m.idempotencyKey)).size).toBe(12);
    expect(fake.mailbox).toHaveLength(12);
  });
});

describe("S-004/S-005 retry, dead, lỗi vĩnh viễn", () => {
  it("lỗi tạm: retrying attempts 1…5 với backoff tăng dần, lần 6 → dead, metric + audit, thông báo trong app còn", async () => {
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    fake.behavior = "temporary";
    const dead: string[] = [];
    const filter = sql`notification_id in (select id from notifications where dedupe_key = ${`invoice_issued:${inv.invoiceId}`})`;
    expect(MAX_ATTEMPTS).toBe(6);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const s = await sendDueEmails(t.worker, fake, CFG, { now: clock });
      expect(s.retrying).toBe(1);
      const [d] = await deliveries(filter);
      expect(d).toMatchObject({
        status: "retrying",
        attempts: attempt,
        last_error_code: "PROVIDER_TEMPORARY",
      });
      const wait = BACKOFF_SECONDS[attempt - 1] as number;
      expect((d?.next_attempt_at?.getTime() ?? 0) - nowMs).toBe(wait * 1000);
      // Chưa tới hạn → chưa được nhận.
      nowMs += (wait - 1) * 1000;
      expect((await send()).claimed).toBe(0);
      nowMs += 1000;
    }
    expect([...BACKOFF_SECONDS]).toEqual([60, 300, 1800, 7200, 21600]);
    const last = await sendDueEmails(t.worker, fake, CFG, {
      now: clock,
      onMetric: (name) => dead.push(name),
    });
    expect(last.dead).toBe(1);
    expect(dead).toEqual(["notification_dead_total"]);
    expect((await deliveries(filter))[0]).toMatchObject({ status: "dead", attempts: 6 });
    expect((await send()).claimed).toBe(0); // dead không tự thử lại
    const audit = await sql<{
      n: string;
    }>`select count(*) as n from audit_events where action = 'notification.delivery_dead'`.execute(t.admin);
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    expect((await listMine(t.runtime, an, {})).items.some((i) => i.type === "invoice_issued")).toBe(true);
    expect(fake.mailbox).toHaveLength(0);
    nowMs += 24 * 3600 * 1000;
  });

  it("lỗi vĩnh viễn (địa chỉ không hợp lệ): failed ngay, attempts=1, RECIPIENT_INVALID, không retry", async () => {
    const bad = await addPerson(A.orgId, "Khách sai email", "khong-phai-email");
    const inv = await invoiceFor(bad);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    const callsBefore = fake.calls;
    const s = await send();
    expect(s.failed).toBe(1);
    const [d] = await deliveries(
      sql`notification_id in (select id from notifications where recipient_person_id = ${bad})`,
    );
    expect(d).toMatchObject({ status: "failed", attempts: 1, last_error_code: "RECIPIENT_INVALID" });
    nowMs += 7 * 24 * 3600 * 1000;
    expect((await send()).claimed).toBe(0);
    expect(fake.calls).toBe(callsBefore + 1);
    const l = await listDeliveries(t.runtime, manager, { status: "failed" });
    expect(l.items[0]).toMatchObject({
      status_label: "Gửi thất bại — cần xử lý",
      detail: "Địa chỉ email không hợp lệ",
    });
  });

  it("thiếu biến mẫu → failed TEMPLATE_ERROR, không gửi email rỗng", async () => {
    await sql.raw("select 1").execute(t.admin);
    const id = await t.worker.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      const r = await createNotification(
        trx,
        A.orgId,
        {
          propertyId: A.propertyId,
          recipientPersonId: anPerson,
          type: "invoice_issued",
          title: "Thiếu tham số",
          body: "x",
          link: null,
          dedupeKey: `tpl-error:${randomUUID()}`,
          params: {},
        },
        clock(),
      );
      return r?.deliveryId;
    });
    await send();
    expect((await deliveries(sql`id = ${id}`))[0]).toMatchObject({
      status: "failed",
      last_error_code: "TEMPLATE_ERROR",
    });
    expect(fake.mailbox).toHaveLength(0);
  });

  it("người nhận không có email → chỉ thông báo trong app, delivery suppressed NO_ADDRESS", async () => {
    const noMail = await addPerson(A.orgId, "Không email", null);
    const inv = await invoiceFor(noMail);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    const [d] = await deliveries(
      sql`notification_id in (select id from notifications where recipient_person_id = ${noMail})`,
    );
    expect(d).toMatchObject({ status: "suppressed", suppressed_reason: "NO_ADDRESS" });
    expect((await send()).claimed).toBe(0);
  });
});

describe("S-008/S-009 opt-out và phiếu đã tất toán", () => {
  it("S-009: tắt invoice_overdue → issued gửi, overdue suppressed OPTED_OUT; trong app vẫn tạo cả hai", async () => {
    await ok(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [{ type: "invoice_overdue", state: "opted_out" }]),
      })),
    );
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.overdue", { invoice_id: inv.invoiceId, business_date: "2026-10-11" }),
      clock(),
    );
    const mine = await listMine(t.runtime, an, { limit: 100 });
    expect(
      mine.items
        .filter((i) => i.link?.endsWith(inv.invoiceId))
        .map((i) => i.type)
        .sort(),
    ).toEqual(["invoice_issued", "invoice_overdue"]);
    const ds = await deliveries(
      sql`notification_id in (select id from notifications where dedupe_key like ${`%${inv.invoiceId}%`})`,
    );
    expect(ds.map((d) => `${d.status}:${d.suppressed_reason}`).sort()).toEqual([
      "queued:null",
      "suppressed:OPTED_OUT",
    ]);
    await send();
    expect(fake.mailbox.map((m) => m.template)).toEqual(["invoice_issued"]);
  });

  it("S-009: tắt SAU khi đã xếp hàng nhưng trước khi gửi → suppressed OPTED_OUT, không có email", async () => {
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    await ok(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [{ type: "invoice_issued", state: "opted_out" }]),
      })),
    );
    const s = await send();
    expect(s.suppressed).toBe(1);
    expect(fake.mailbox).toHaveLength(0);
  });

  it("S-008: phiếu được phân bổ đủ sau khi nhắc xếp hàng → suppressed SETTLED, không email", async () => {
    const inv = await invoiceFor(anPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.overdue", { invoice_id: inv.invoiceId, business_date: "2026-10-11" }),
      clock(),
    );
    const key = `invoice_overdue:${inv.invoiceId}:2026-10-11`;
    const filter = sql`notification_id in (select id from notifications where dedupe_key = ${key})`;
    expect((await deliveries(filter))[0]?.status).toBe("queued");
    await sql`update invoices set allocated_total = total where id = ${inv.invoiceId}`.execute(t.admin);
    await send();
    expect((await deliveries(filter))[0]).toMatchObject({
      status: "suppressed",
      suppressed_reason: "SETTLED",
    });
    expect(fake.mailbox).toHaveLength(0);
    // Ngày sau: phiếu đã tất toán nên không tạo nhắc mới.
    const again = await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.overdue", { invoice_id: inv.invoiceId, business_date: "2026-10-12" }),
      clock(),
    );
    expect(again.created).toBe(0);
  });
});

describe("S-010 huỷ đăng ký bằng token", () => {
  const now = new Date("2026-10-16T02:00:00Z");

  it("mở liên kết (không đăng nhập) → opted_out đúng loại đó + audit; dùng lại → như cũ", async () => {
    const token = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: anPerson, type: "invoice_overdue" },
      now,
    );
    const r1 = await unsubscribeByToken(t.runtime, SECRET, token, now, "corr-unsub-1");
    expect(r1).toMatchObject({
      type: "invoice_overdue",
      typeLabel: "nhắc quá hạn",
      organizationName: "Nhà trọ Hoa Sen",
      changed: true,
    });
    const prefs = await getPreferences(t.runtime, an);
    expect(prefs.find((p) => p.type === "invoice_overdue")?.state).toBe("opted_out");
    expect(prefs.find((p) => p.type === "invoice_issued")?.state).toBe("opted_in");
    const src = await sql<{
      source: string;
    }>`select source from notification_preferences where person_id = ${anPerson} and type = 'invoice_overdue'`.execute(
      t.admin,
    );
    expect(src.rows[0]?.source).toBe("email_link");
    const audit = await sql<{
      n: string;
    }>`select count(*) as n from audit_events where action = 'notification.preference_changed' and actor_person_id = ${anPerson} and correlation_id = 'corr-unsub-1'`.execute(
      t.admin,
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);

    const r2 = await unsubscribeByToken(t.runtime, SECRET, token, now, "corr-unsub-2");
    expect(r2).toMatchObject({ type: "invoice_overdue", changed: false });
    const audit2 = await sql<{
      n: string;
    }>`select count(*) as n from audit_events where correlation_id = 'corr-unsub-2'`.execute(t.admin);
    expect(Number(audit2.rows[0]?.n)).toBe(0);
  });

  it("token hết hạn → 410 LINK_EXPIRED; token giả/bị sửa → 404 NOT_FOUND, không đổi gì", async () => {
    const old = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: binhPerson, type: "invoice_issued" },
      new Date("2026-08-01T00:00:00Z"),
      30,
    );
    await expect(unsubscribeByToken(t.runtime, SECRET, old, now, "c")).rejects.toMatchObject({
      code: "LINK_EXPIRED",
      status: 410,
    });
    const good = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: binhPerson, type: "invoice_issued" },
      now,
    );
    const [body, sig] = good.split(".") as [string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, o: A.orgId, p: anPerson, t: "invoice_issued", exp: 9_999_999_999 }),
    ).toString("base64url");
    for (const bad of [
      `${forgedBody}.${sig}`,
      `${body}.AAAA`,
      "rác",
      "",
      `${body}`,
      signUnsubscribeToken(
        "k".repeat(48),
        { orgId: A.orgId, personId: binhPerson, type: "invoice_issued" },
        now,
      ),
    ]) {
      await expect(unsubscribeByToken(t.runtime, SECRET, bad, now, "c")).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    }
    const prefs = await sql<{
      n: string;
    }>`select count(*) as n from notification_preferences where person_id in (${binhPerson}, ${anPerson}) and state = 'opted_out' and type = 'invoice_issued'`.execute(
      t.admin,
    );
    expect(Number(prefs.rows[0]?.n)).toBe(0);
  });

  it("người nhận không tồn tại (token hợp lệ) → cùng kết quả, không tạo hàng, không lộ tồn tại tài khoản", async () => {
    const ghost = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: randomUUID(), type: "invoice_overdue" },
      now,
    );
    const before = await count("notification_preferences");
    const r = await unsubscribeByToken(t.runtime, SECRET, ghost, now, "c");
    expect(r).toMatchObject({ type: "invoice_overdue", organizationName: "Nhà trọ Hoa Sen", changed: false });
    expect(await count("notification_preferences")).toBe(before);
  });

  it("token loại bắt buộc → PREFERENCE_REQUIRED; token chéo tổ chức không đổi người của tổ chức khác", async () => {
    const sec = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: anPerson, type: "account_security" },
      now,
    );
    await expect(unsubscribeByToken(t.runtime, SECRET, sec, now, "c")).rejects.toMatchObject({
      code: "PREFERENCE_REQUIRED",
      status: 422,
    });
    // Người của A nhưng token khai tổ chức B → không tìm thấy người trong B → không đổi gì.
    const cross = signUnsubscribeToken(
      SECRET,
      { orgId: B.orgId, personId: binhPerson, type: "invoice_issued" },
      now,
    );
    const r = await unsubscribeByToken(t.runtime, SECRET, cross, now, "c");
    expect(r.changed).toBe(false);
    const n = await sql<{
      n: string;
    }>`select count(*) as n from notification_preferences where person_id = ${binhPerson}`.execute(t.admin);
    expect(Number(n.rows[0]?.n)).toBe(0);
  });

  it("route HTTP: 200 kèm thông điệp xác nhận; 410/404 theo mã; tắt khi thiếu khoá", async () => {
    const token = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: binhPerson, type: "invoice_overdue" },
      new Date(),
    );
    const req = (tok: string) =>
      new Request(
        `https://app.hoasen.example/api/v1/notifications/unsubscribe?token=${encodeURIComponent(tok)}`,
      );
    const okRes = await handleUnsubscribe(req(token), { db: t.runtime, secret: SECRET });
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as { data: { message: string } }).data.message).toBe(
      "Bạn sẽ không nhận email nhắc quá hạn từ Nhà trọ Hoa Sen nữa.",
    );
    const expired = signUnsubscribeToken(
      SECRET,
      { orgId: A.orgId, personId: binhPerson, type: "invoice_overdue" },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect((await handleUnsubscribe(req(expired), { db: t.runtime, secret: SECRET })).status).toBe(410);
    expect((await handleUnsubscribe(req("giả"), { db: t.runtime, secret: SECRET })).status).toBe(404);
    expect((await handleUnsubscribe(req(token), { db: t.runtime, secret: undefined })).status).toBe(404);
  });
});

describe("S-011 loại bắt buộc", () => {
  it("tắt account_security → 422 PREFERENCE_REQUIRED, không đổi gì (kể cả loại khác cùng yêu cầu); DB cũng chặn", async () => {
    const f = await failure(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [
          { type: "invoice_overdue", state: "opted_out" },
          { type: "account_security", state: "opted_out" },
        ]),
      })),
    );
    expect(f).toEqual({ code: "PREFERENCE_REQUIRED", status: 422 });
    const prefs = await getPreferences(t.runtime, an);
    expect(prefs.every((p) => p.state === "opted_in")).toBe(true);
    expect(prefs.find((p) => p.type === "account_security")?.required).toBe(true);
    await expect(
      sql`insert into notification_preferences (id, organization_id, person_id, type, channel, state, source)
          values (${randomUUID()}, ${A.orgId}, ${anPerson}, 'account_security', 'email', 'opted_out', 'user')`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_preferences_required/);
  });

  it("preferences chỉ của chính mình; opt-in lại; chỉ audit khi có đổi", async () => {
    const r1 = await ok(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [{ type: "lease_expiring", state: "opted_out" }]),
      })),
    );
    expect(r1.changed).toBe(1);
    const r2 = await ok(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [{ type: "lease_expiring", state: "opted_out" }]),
      })),
    );
    expect(r2.changed).toBe(0);
    expect((await getPreferences(t.runtime, binh)).find((p) => p.type === "lease_expiring")?.state).toBe(
      "opted_in",
    );
    const r3 = await ok(
      run(an, async (ctx) => ({
        data: await updatePreferences(ctx, [{ type: "lease_expiring", state: "opted_in" }]),
      })),
    );
    expect(r3.changed).toBe(1);
  });
});

describe("S-012 không PII nhạy cảm", () => {
  it("quét nội dung email/trong app với dữ liệu giả có CCCD, SĐT, số tài khoản; log che email", async () => {
    const victim = await addPerson(A.orgId, "Nguyễn Văn Kín", "kin@example.test", "0912345678");
    await sql`update persons set address = 'Số 1 đường X, CCCD 012345678901, STK 1234567890123' where id = ${victim}`.execute(
      t.admin,
    );
    const inv = await invoiceFor(victim);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.overdue", { invoice_id: inv.invoiceId, business_date: "2026-10-11" }),
      clock(),
    );
    const lease = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: victim,
    });
    await dispatchNotificationEvent(
      t.worker,
      await emit("lease.expiring", {
        lease_id: lease.leaseId,
        version_no: 1,
        days_left: 30,
        effective_to: "2026-11-30",
      }),
      clock(),
    );
    // Các loại còn lại: dựng thông báo với tham số điển hình.
    await t.worker.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      for (const type of ["account_security", "maintenance_status", "export_ready"] as const) {
        await createNotification(
          trx,
          A.orgId,
          {
            propertyId: A.propertyId,
            recipientPersonId: victim,
            type,
            title: `Thông báo ${type}`,
            body: "Nội dung ngắn",
            link: "/tai-khoan",
            dedupeKey: `pii:${type}:${randomUUID()}`,
            params: { property_name: "Nhà trọ Hoa Sen" },
          },
          clock(),
        );
      }
    });
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: { write: (l) => void lines.push(l) } });
    const s = await sendDueEmails(t.worker, fake, CFG, { now: clock, log, limit: 100 });
    expect(s.sent).toBeGreaterThanOrEqual(6);
    const mailsToVictim = fake.mailbox.filter((m) => m.to === "kin@example.test");
    expect(new Set(mailsToVictim.map((m) => m.template))).toEqual(
      new Set([
        "invoice_issued",
        "invoice_overdue",
        "account_security",
        "maintenance_status",
        "export_ready",
      ]),
    );
    // lease_expiring đi tới owner/manager (không tới người thuê) — quét cả thư đó.
    expect(fake.mailbox.some((m) => m.template === "lease_expiring")).toBe(true);
    const blob = JSON.stringify(fake.mailbox.map((m) => m.rendered));
    for (const secret of ["012345678901", "0912345678", "1234567890123", "Nguyễn Văn Kín", "Số 1 đường X"])
      expect(blob).not.toContain(secret);
    expect(blob).not.toMatch(/\d[\d.]{3,}\s?đ(?!\p{L})/u);
    // Thông báo trong app của người nhận cũng không chứa PII.
    const rows = await sql<{
      title: string;
      body: string;
    }>`select title, body from notifications where recipient_person_id = ${victim}`.execute(t.admin);
    for (const r of rows.rows)
      for (const secret of ["012345678901", "0912345678", "1234567890123", "Nguyễn Văn Kín"])
        expect(r.title + r.body).not.toContain(secret);
    // Log worker không chứa địa chỉ email đầy đủ.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("kin@example.test");
    expect(lines.join("\n")).toContain("k***@example.test");
  });
});

describe("S-017/listMine người nhận chỉ xem của mình", () => {
  it("markRead thông báo của người khác → 404 NOT_FOUND, trạng thái không đổi; của mình → ok, lặp lại vô hại", async () => {
    const inv = await invoiceFor(binhPerson);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: inv.invoiceId }),
      clock(),
    );
    const nB = (await listMine(t.runtime, binh, {})).items[0]?.id as string;
    const f = await failure(run(an, async (ctx) => ({ data: await markRead(ctx, nB) })));
    expect(f).toEqual({ code: "NOT_FOUND", status: 404 });
    const raw = await sql<{
      read_at: Date | null;
    }>`select read_at from notifications where id = ${nB}`.execute(t.admin);
    expect(raw.rows[0]?.read_at).toBeNull();
    // An không thấy thông báo của Bình dù truy vấn thẳng bằng role ứng dụng (RLS theo chủ thể).
    const seen = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      await sql`select set_config('app.actor_id', ${an.membershipId}, true)`.execute(trx);
      return sql<{
        id: string;
      }>`select id from notifications where recipient_person_id = ${binhPerson}`.execute(trx);
    });
    expect(seen.rows).toHaveLength(0);
    // UPDATE trực tiếp thông báo người khác không ảnh hưởng hàng nào.
    const upd = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      await sql`select set_config('app.actor_id', ${an.membershipId}, true)`.execute(trx);
      return sql`update notifications set read_at = now() where id = ${nB}`.execute(trx);
    });
    expect(Number(upd.numAffectedRows)).toBe(0);

    await ok(run(binh, async (ctx) => ({ data: await markRead(ctx, nB) })));
    await ok(run(binh, async (ctx) => ({ data: await markRead(ctx, nB) })));
    expect((await listMine(t.runtime, binh, {})).unread_count).toBe(0);
    // Thông báo chỉ đổi được read_at: sửa nội dung bị DB chặn.
    await expect(
      sql`update notifications set title = 'đổi' where id = ${nB}`.execute(t.admin),
    ).rejects.toThrow(/chỉ đổi được read_at/);
  });

  it("listMine phân trang con trỏ, lọc chưa đọc, markAllRead; rỗng → danh sách rỗng (không phải null)", async () => {
    const carol = await member(A.orgId, "tenant", "carol@example.test", [], "Carol");
    const empty = await listMine(t.runtime, carol.actor, {});
    expect(empty).toEqual({ items: [], unread_count: 0, next_cursor: null });
    await t.worker.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      for (let i = 0; i < 5; i++) {
        await createNotification(
          trx,
          A.orgId,
          {
            propertyId: A.propertyId,
            recipientPersonId: carol.personId,
            type: "stay_notice_due",
            title: `TB ${i}`,
            body: "b",
            link: null,
            dedupeKey: `page:${i}`,
            params: {},
          },
          clock(),
        );
      }
    });
    const p1 = await listMine(t.runtime, carol.actor, { limit: 2 });
    const p2 = await listMine(t.runtime, carol.actor, { limit: 2, cursor: p1.next_cursor as string });
    const p3 = await listMine(t.runtime, carol.actor, { limit: 2, cursor: p2.next_cursor as string });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 2, 1]);
    expect(p3.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).size).toBe(5);
    expect(p1.unread_count).toBe(5);
    expect((await ok(run(carol.actor, async (ctx) => ({ data: await markAllRead(ctx) })))).marked).toBe(5);
    expect((await listMine(t.runtime, carol.actor, { unreadOnly: true })).items).toHaveLength(0);
    // stay_notice_due chỉ trong app: không có delivery email.
    expect(
      await deliveries(
        sql`notification_id in (select id from notifications where recipient_person_id = ${carol.personId})`,
      ),
    ).toHaveLength(0);
    await expect(listMine(t.runtime, carol.actor, { cursor: "rác" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("S-018/S-019 lịch sử gửi theo quyền, gửi lại dead", () => {
  let d1: string; // cơ sở 1
  let d2: string; // cơ sở 2

  beforeEach(async () => {
    const i1 = await invoiceFor(anPerson, A.propertyId);
    const i2 = await invoiceFor(anPerson, P2);
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: i1.invoiceId }),
      clock(),
    );
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: i2.invoiceId }),
      clock(),
    );
    d1 = (
      await deliveries(
        sql`property_id = ${A.propertyId} and notification_id in (select id from notifications where dedupe_key = ${`invoice_issued:${i1.invoiceId}`})`,
      )
    )[0]?.id as string;
    d2 = (
      await deliveries(
        sql`property_id = ${P2} and notification_id in (select id from notifications where dedupe_key = ${`invoice_issued:${i2.invoiceId}`})`,
      )
    )[0]?.id as string;
  });

  const setDead = (id: string) =>
    sql`update notification_deliveries set status = 'dead', suppressed_reason = null, sent_at = null, provider_message_id = null, attempts = 6, last_error_code = 'PROVIDER_TEMPORARY',
        next_attempt_at = null where id = ${id}`.execute(t.admin);

  it("housekeeping → 403 FORBIDDEN; tenant → 403; manager chỉ thấy cơ sở trong phạm vi; owner thấy toàn tổ chức; tổ chức khác không thấy", async () => {
    await expect(listDeliveries(t.runtime, housekeeping, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(listDeliveries(t.runtime, an, {})).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const m = (await listDeliveries(t.runtime, manager, {})).items.map((i) => i.id);
    expect(m).toContain(d1);
    expect(m).not.toContain(d2);
    const o = (await listDeliveries(t.runtime, owner, {})).items.map((i) => i.id);
    expect(o).toEqual(expect.arrayContaining([d1, d2]));
    expect((await listDeliveries(t.runtime, ownerB, {})).items).toHaveLength(0);
    // Lịch sử không lộ nội dung thông báo.
    expect(JSON.stringify((await listDeliveries(t.runtime, owner, {})).items)).not.toMatch(
      /Phiếu thu kỳ|1\.580\.000/,
    );
    // Lọc theo trạng thái/người nhận.
    expect(
      (await listDeliveries(t.runtime, owner, { recipientPersonId: binhPerson, status: "queued" })).items,
    ).toHaveLength(0);
  });

  it("S-019: gửi lại dead → queued, attempts=0, audit người thao tác; cùng Idempotency-Key không làm lần hai; sau đó gửi được", async () => {
    await setDead(d1);
    const key = randomUUID();
    const r1 = await run(manager, async (ctx) => ({ data: await retryDelivery(ctx, d1) }), key);
    expect(r1.status).toBe("committed");
    expect((await deliveries(sql`id = ${d1}`))[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error_code: null,
    });
    const audits = () =>
      sql<{
        n: string;
      }>`select count(*) as n from audit_events where action = 'notification.delivery_retried' and entity_id = ${d1} and actor_person_id = ${manager.personId}`.execute(
        t.admin,
      );
    expect(Number((await audits()).rows[0]?.n)).toBe(1);
    // Bấm lại cùng key: replay, không thao tác lần hai (dù delivery đã bị đổi lại trong lúc đó).
    await setDead(d1);
    const r2 = await run(manager, async (ctx) => ({ data: await retryDelivery(ctx, d1) }), key);
    expect(r2.status === "committed" && r2.replayed).toBe(true);
    expect((await deliveries(sql`id = ${d1}`))[0]?.status).toBe("dead");
    expect(Number((await audits()).rows[0]?.n)).toBe(1);
    // Key mới: gửi lại thật, rồi worker gửi được.
    await ok(run(manager, async (ctx) => ({ data: await retryDelivery(ctx, d1) })));
    nowMs += 1000;
    const s = await send();
    expect(s.sent).toBeGreaterThanOrEqual(1);
    expect((await deliveries(sql`id = ${d1}`))[0]?.status).toBe("sent");
  });

  it("DELIVERY_NOT_RETRYABLE khi sent/suppressed; housekeeping 403; manager ngoài phạm vi → 404; không tồn tại → 404", async () => {
    await send();
    expect((await deliveries(sql`id = ${d1}`))[0]?.status).toBe("sent");
    expect(await failure(run(manager, async (ctx) => ({ data: await retryDelivery(ctx, d1) })))).toEqual({
      code: "DELIVERY_NOT_RETRYABLE",
      status: 409,
    });
    await sql`update notification_deliveries set status = 'suppressed', suppressed_reason = 'OPTED_OUT', sent_at = null where id = ${d1}`.execute(
      t.admin,
    );
    expect(await failure(run(owner, async (ctx) => ({ data: await retryDelivery(ctx, d1) })))).toEqual({
      code: "DELIVERY_NOT_RETRYABLE",
      status: 409,
    });
    expect(await failure(run(housekeeping, async (ctx) => ({ data: await retryDelivery(ctx, d1) })))).toEqual(
      { code: "FORBIDDEN", status: 403 },
    );
    await setDead(d2);
    expect(await failure(run(manager, async (ctx) => ({ data: await retryDelivery(ctx, d2) })))).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    expect((await deliveries(sql`id = ${d2}`))[0]?.status).toBe("dead");
    expect(await failure(run(ownerB, async (ctx) => ({ data: await retryDelivery(ctx, d2) })))).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(
      await failure(run(owner, async (ctx) => ({ data: await retryDelivery(ctx, randomUUID()) }))),
    ).toEqual({ code: "NOT_FOUND", status: 404 });
    const ok2 = await run(owner, async (ctx) => ({ data: await retryDelivery(ctx, d2) }));
    expect(ok2.status).toBe("committed");
  });
});

describe("cách ly tổ chức và consumer", () => {
  it("sự kiện của A trỏ phiếu của B → không tạo thông báo; bộ kiểm cách ly dùng chung không thấy rò", async () => {
    const pB = await addPerson(B.orgId, "Khách B", "khachb@example.test");
    const invB = await invoiceFor(pB, B.propertyId, B.orgId);
    const r = await dispatchNotificationEvent(
      t.worker,
      {
        organization_id: A.orgId,
        outbox_id: randomUUID(),
        event_type: "invoice.issued",
        payload: { invoice_id: invB.invoiceId },
      },
      clock(),
    );
    expect(r).toEqual({ created: 0, duplicates: 0 });
    expect(await findIsolationLeaks(t.admin, t.runtime, A.orgId)).toEqual([]);
    expect(await findIsolationLeaks(t.admin, t.runtime, B.orgId)).toEqual([]);
    // Người của A không thấy thông báo/lịch sử của B qua app_runtime.
    await dispatchNotificationEvent(
      t.worker,
      await emit("invoice.issued", { invoice_id: invB.invoiceId }, B.orgId, ownerB),
      clock(),
    );
    expect((await listMine(t.runtime, an, {})).items.every((i) => !i.title.includes("Khách B"))).toBe(true);
    expect(
      (await listDeliveries(t.runtime, owner, {})).items.every((i) => i.recipient_person_id !== pB),
    ).toBe(true);
    expect(
      (await listDeliveries(t.runtime, ownerB, {})).items.some((i) => i.recipient_person_id === pB),
    ).toBe(true);
  });

  it("lease.expiring → owner/manager trong phạm vi nhận đúng 1 thông báo, chạy lại không nhân đôi", async () => {
    const lease = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: P2,
      representativePersonId: anPerson,
    });
    const ev = await emit("lease.expiring", {
      lease_id: lease.leaseId,
      version_no: 1,
      days_left: 7,
      effective_to: "2026-11-30",
    });
    const r1 = await dispatchNotificationEvent(t.worker, ev, clock());
    const r2 = await dispatchNotificationEvent(t.worker, ev, clock());
    // P2: chỉ owner (all_properties) — manager chỉ có phạm vi cơ sở 1.
    expect(r1.created).toBe(1);
    expect(r2).toEqual({ created: 0, duplicates: 1 });
    const forLease = (i: { link: string | null }) => i.link?.endsWith(lease.leaseId);
    expect((await listMine(t.runtime, manager, { limit: 100 })).items.some(forLease)).toBe(false);
    const ownerList = await listMine(t.runtime, owner, { limit: 100 });
    const n = ownerList.items.find((i) => forLease(i));
    expect(n).toMatchObject({ severity: "urgent", title: "Hợp đồng sắp hết hạn" });
    expect(n?.body).toContain("30/11/2026");
  });

  it("sự kiện lạ hoặc thiếu payload: lạ → bỏ qua; thiếu invoice_id → ném lỗi để pg-boss retry", async () => {
    expect(
      await dispatchNotificationEvent(
        t.worker,
        { organization_id: A.orgId, outbox_id: randomUUID(), event_type: "x.y", payload: {} },
        clock(),
      ),
    ).toEqual({ created: 0, duplicates: 0 });
    await expect(
      dispatchNotificationEvent(
        t.worker,
        { organization_id: A.orgId, outbox_id: randomUUID(), event_type: "invoice.issued", payload: {} },
        clock(),
      ),
    ).rejects.toThrow(/invoice_id/);
  });

  it("danh mục loại thông báo khớp CHECK DB", async () => {
    await expect(
      sql`insert into notifications (id, organization_id, recipient_person_id, type, title, body, dedupe_key)
          values (${randomUUID()}, ${A.orgId}, ${anPerson}, 'loai_la', 't', 'b', 'k')`.execute(t.admin),
    ).rejects.toThrow(/notifications_type_check/);
    expect(NOTIFICATION_TYPES).toHaveLength(7);
  });
});

describe("notification_settings", () => {
  it("manager trong phạm vi cấu hình được; mặc định chưa cấu hình hạn lưu trú; sai khung giờ → 422; housekeeping/ngoài phạm vi bị chặn", async () => {
    const d0 = await getSettings(t.runtime, manager, A.propertyId);
    expect(d0).toMatchObject({
      configured: false,
      stay_notice_deadline: null,
      overdue_reminder_offsets_days: [1],
      lease_expiry_offsets_days: [30, 7, 0],
    });
    await ok(
      run(manager, async (ctx) => ({
        data: await updateSettings(ctx, {
          propertyId: A.propertyId,
          overdueReminderOffsetsDays: [1, 3, 7],
          stayNoticeDeadline: { before_time: "23:00" },
        }),
      })),
    );
    const d1 = await getSettings(t.runtime, manager, A.propertyId);
    expect(d1).toMatchObject({
      configured: true,
      overdue_reminder_offsets_days: [1, 3, 7],
      stay_notice_deadline: { before_time: "23:00" },
      send_window_start: "08:00",
    });
    // Cập nhật một phần giữ nguyên phần còn lại.
    await ok(
      run(manager, async (ctx) => ({
        data: await updateSettings(ctx, { propertyId: A.propertyId, sendWindowEnd: "21:00" }),
      })),
    );
    expect(await getSettings(t.runtime, manager, A.propertyId)).toMatchObject({
      overdue_reminder_offsets_days: [1, 3, 7],
      send_window_end: "21:00",
      stay_notice_deadline: { before_time: "23:00" },
    });
    expect(
      await failure(
        run(manager, async (ctx) => ({
          data: await updateSettings(ctx, {
            propertyId: A.propertyId,
            sendWindowStart: "21:00",
            sendWindowEnd: "08:00",
          }),
        })),
      ),
    ).toEqual({ code: "VALIDATION_FAILED", status: 422 });
    expect(
      (
        await failure(
          run(housekeeping, async (ctx) => ({
            data: await updateSettings(ctx, { propertyId: A.propertyId }),
          })),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (await failure(run(manager, async (ctx) => ({ data: await updateSettings(ctx, { propertyId: P2 }) }))))
        .code,
    ).toBe("NOT_FOUND");
    const audit = await sql<{
      n: string;
    }>`select count(*) as n from audit_events where action = 'notification.settings_updated'`.execute(
      t.admin,
    );
    expect(Number(audit.rows[0]?.n)).toBe(2);
  });
});
