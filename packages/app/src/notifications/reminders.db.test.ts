// PLAN đợt 3 T-212 — nhắc hạn trên Postgres thật (SPEC-notifications S-007, S-008, S-013, S-020; INV-G1, INV-G2, INV-G6).
// Phần S-014…S-016, S-021 (hạn/quá hạn thông báo lưu trú) đọc `residence_notices` nên thuộc T-207 — xem it.todo cuối file.
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { remindExpiring } from "../lease/jobs.ts";
import { type CommandContext, executeCommand } from "../pipeline/command.ts";
import {
  dispatchNotificationEvent,
  type NotificationEvent,
  type SendConfig,
  sendDueEmails,
} from "./dispatch.ts";
import { FakeEmailSender } from "./email.ts";
import { listMine, updateSettings } from "./notifications.ts";
import { scanOverdue, scanStayNoticeConfig } from "./reminders.ts";

const CFG: SendConfig = { baseUrl: "https://app.hoasen.example", tokenSecret: "s".repeat(48) };

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let manager: Actor;
let an: Actor;
let anPerson: string;
let binhB: string;
let P3: string; // cơ sở có giờ chốt ngày 03:00
const fake = new FakeEmailSender();

/** Giờ VN (UTC+7, không DST): 2026-10-11 08:00 VN = 2026-10-11T01:00:00Z. */
const vn = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+07:00`);

async function addPerson(orgId: string, name: string, email: string | null): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email) values (${id}, ${orgId}, ${name}, ${email})`.execute(
    t.admin,
  );
  return id;
}

async function member(
  orgId: string,
  role: string,
  email: string | null,
  props: string[],
): Promise<{ actor: Actor; personId: string; membershipId: string }> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const personId = await addPerson(orgId, role, email);
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
    membershipId: membership,
  };
}

function run<T>(actor: Actor, fn: (ctx: CommandContext) => Promise<{ data: T }>) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "reminders.test", idempotencyKey: key, payload: { key }, correlationId: "corr-reminders-1" },
    fn,
  );
}

/** Đặt `due_on` (cột bất biến sau phát hành) bằng cách tắt trigger trong một transaction của quản trị. */
async function setDue(invoiceId: string, dueOn: string | null): Promise<void> {
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update invoices set due_on = ${dueOn}::date where id = ${invoiceId}`.execute(trx);
  });
}

async function invoice(
  due: string | null,
  opts: { orgId?: string; propertyId?: string; payer?: string; amount?: number; businessDate?: string } = {},
): Promise<string> {
  const inv = await seedIssuedInvoice(t.admin, {
    orgId: opts.orgId ?? A.orgId,
    propertyId: opts.propertyId ?? A.propertyId,
    payerPersonId: opts.payer ?? anPerson,
    lines: [{ amount: opts.amount ?? 1_580_000 }],
    ...(opts.businessDate ? { businessDate: opts.businessDate } : {}),
  });
  if (due) await setDue(inv.invoiceId, due);
  return inv.invoiceId;
}

async function setSettings(
  orgId: string,
  propertyId: string,
  membershipId: string,
  s: { overdue?: number[]; lease?: number[]; deadline?: object | null; start?: string; end?: string },
): Promise<void> {
  await sql`
    insert into notification_settings (id, organization_id, property_id, overdue_reminder_offsets_days, lease_expiry_offsets_days,
                                       stay_notice_deadline, send_window_start, send_window_end, updated_by)
    values (${randomUUID()}, ${orgId}, ${propertyId}, ${s.overdue ?? [1]}::int[], ${s.lease ?? [30, 7, 0]}::int[],
            ${s.deadline ? JSON.stringify(s.deadline) : null}::jsonb, ${s.start ?? "08:00"}::time, ${s.end ?? "20:00"}::time,
            ${membershipId})
    on conflict (organization_id, property_id) do update set
      overdue_reminder_offsets_days = excluded.overdue_reminder_offsets_days,
      lease_expiry_offsets_days = excluded.lease_expiry_offsets_days,
      stay_notice_deadline = excluded.stay_notice_deadline,
      send_window_start = excluded.send_window_start, send_window_end = excluded.send_window_end`.execute(
    t.admin,
  );
}

interface Outbox {
  id: string;
  organization_id: string;
  event_type: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  property_id: string | null;
}

async function outboxFor(eventType: string, aggregateId: string): Promise<Outbox[]> {
  return (
    await sql<Outbox>`select id, organization_id, event_type, dedupe_key, payload, property_id from outbox
                      where event_type = ${eventType} and aggregate_id = ${aggregateId} order by created_at, id`.execute(
      t.admin,
    )
  ).rows;
}

const asEvent = (o: Outbox): NotificationEvent => ({
  organization_id: o.organization_id,
  outbox_id: o.id,
  event_type: o.event_type,
  payload: o.payload,
});

async function dispatchAll(eventType: string, aggregateId: string, now: Date) {
  let created = 0;
  let duplicates = 0;
  for (const o of await outboxFor(eventType, aggregateId)) {
    const r = await dispatchNotificationEvent(t.worker, asEvent(o), now);
    created += r.created;
    duplicates += r.duplicates;
  }
  return { created, duplicates };
}

const notificationsLike = async (key: string) =>
  (
    await sql<{ recipient_person_id: string; severity: string; type: string; organization_id: string }>`
      select recipient_person_id, severity, type, organization_id from notifications where dedupe_key like ${key}`.execute(
      t.admin,
    )
  ).rows;

async function newUnit(
  orgId: string,
  propertyId: string,
  floorId: string,
  roomTypeId: string,
): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${orgId}, ${propertyId}, ${floorId}, ${roomTypeId}, ${`R${id.slice(0, 6)}`})`.execute(
    t.admin,
  );
  return id;
}

async function inHouseStay(org: SeededOrg, guest: string, status = "in_house"): Promise<string> {
  const unitId = await newUnit(org.orgId, org.propertyId, org.floorId, org.roomTypeId);
  const r = await seedReservation(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    bookerPersonId: guest,
    unitId,
    roomTypeId: org.roomTypeId,
  });
  const stayId = randomUUID();
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                                 checked_in_at, checked_out_at)
              values (${stayId}, ${org.orgId}, ${org.propertyId}, ${r.itemId}, ${unitId}, ${status}, ${guest}, now(),
                      ${status === "checked_out" ? sql`now()` : null})`.execute(trx);
  });
  return stayId;
}

/** Hợp đồng đã ký, đang hiệu lực, phiên bản cuối kết thúc `endsOn`. */
async function activeLease(
  org: SeededOrg,
  person: string,
  endsOn: string,
  propertyId = org.propertyId,
): Promise<string> {
  const { leaseId } = await seedLease(t.admin, {
    orgId: org.orgId,
    propertyId,
    representativePersonId: person,
  });
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`update leases set status = 'active', signed_on = '2026-10-01' where id = ${leaseId}`.execute(
      trx,
    );
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"a".repeat(64)}, terms_snapshot = '{}'::jsonb,
              effective_to = ${endsOn}::date where lease_id = ${leaseId} and version_no = 1`.execute(trx);
  });
  return leaseId;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ B");
  P3 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template, business_day_cutoff)
            values (${P3}, ${A.orgId}, 'Cơ sở chốt 03:00', 'hotel', '03:00')`.execute(t.admin);
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  manager = (await member(A.orgId, "manager", "quanly@example.test", [A.propertyId])).actor;
  const a = await member(A.orgId, "tenant", "an@example.test", []);
  an = a.actor;
  anPerson = a.personId;
  binhB = await addPerson(B.orgId, "Bình (tổ chức B)", "binh@example.test");
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  fake.clear();
  await sql`update notification_deliveries set status = 'suppressed', suppressed_reason = 'OPTED_OUT', next_attempt_at = null,
            locked_until = null where status in ('queued','retrying','sending')`.execute(t.admin);
});

describe("S-007 nhắc quá hạn (reminder.scanOverdue)", () => {
  it("hạn 10/10, chạy 11/10 08:00 giờ cơ sở → 1 sự kiện, thông báo `invoice_overdue:{id}:2026-10-11`; chạy lại không nhân đôi", async () => {
    const id = await invoice("2026-10-10");
    const cfg = await sql`select 1 from notification_settings where property_id = ${A.propertyId}`.execute(
      t.admin,
    );
    expect(cfg.rows).toHaveLength(0); // chưa cấu hình ⇒ lịch mặc định +1 ngày, khung 08:00–20:00

    const at = vn("2026-10-11", "08:00");
    expect((await scanOverdue(t.worker, at)).created).toBeGreaterThanOrEqual(1);
    const ev = await outboxFor("invoice.overdue", id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      dedupe_key: `invoice.overdue:${id}:1`,
      payload: { invoice_id: id, business_date: "2026-10-11", milestone: 1, days_overdue: 1 },
    });

    // Chạy lại (sự cố/trùng lịch), cùng ngày muộn hơn, và ngày hôm sau: vẫn một sự kiện.
    await scanOverdue(t.worker, at);
    await scanOverdue(t.worker, vn("2026-10-11", "15:00"));
    await scanOverdue(t.worker, vn("2026-10-12", "09:00"));
    expect(await outboxFor("invoice.overdue", id)).toHaveLength(1);

    const r = await dispatchAll("invoice.overdue", id, at);
    expect(r).toEqual({ created: 1, duplicates: 0 });
    expect(await notificationsLike(`invoice_overdue:${id}:%`)).toEqual([
      expect.objectContaining({
        recipient_person_id: anPerson,
        severity: "overdue",
        type: "invoice_overdue",
      }),
    ]);
    const key = await sql<{ dedupe_key: string; body: string }>`select dedupe_key, body from notifications
      where dedupe_key like ${`invoice_overdue:${id}:%`}`.execute(t.admin);
    expect(key.rows[0]?.dedupe_key).toBe(`invoice_overdue:${id}:2026-10-11`);
    expect(key.rows[0]?.body).toContain("1.580.000 đ");
    // Giao lại cùng sự kiện (pg-boss giao 2 lần) → vẫn một thông báo.
    expect(await dispatchAll("invoice.overdue", id, at)).toEqual({ created: 0, duplicates: 1 });
    const mine = await listMine(t.runtime, an, { limit: 100 });
    expect(mine.items.filter((i) => i.link?.endsWith(id))).toHaveLength(1);
  });

  it("chưa tới hạn, đúng ngày hạn, không có hạn → không nhắc", async () => {
    const future = await invoice("2026-10-20");
    const today = await invoice("2026-10-11");
    const noDue = await invoice(null);
    await scanOverdue(t.worker, vn("2026-10-11", "09:00"));
    for (const id of [future, today, noDue]) expect(await outboxFor("invoice.overdue", id)).toHaveLength(0);
  });

  it("lịch +1, +3, +7: mỗi mốc đúng một nhắc; job lỡ nhiều ngày chỉ bù mốc mới nhất", async () => {
    await setSettings(A.orgId, A.propertyId, A.ownerMembershipId, { overdue: [1, 3, 7] });
    try {
      const id = await invoice("2026-10-01");
      const days: [string, number][] = [
        ["2026-10-02", 1],
        ["2026-10-03", 1], // mốc 1 đã phát
        ["2026-10-04", 2], // mốc 3
        ["2026-10-07", 2], // vẫn mốc 3
        ["2026-10-08", 3], // mốc 7
        ["2026-10-30", 3],
      ];
      for (const [d] of days) await scanOverdue(t.worker, vn(d, "09:00"));
      const ev = await outboxFor("invoice.overdue", id);
      expect(ev.map((e) => e.dedupe_key)).toEqual([
        `invoice.overdue:${id}:1`,
        `invoice.overdue:${id}:3`,
        `invoice.overdue:${id}:7`,
      ]);
      expect(ev.map((e) => e.payload.business_date)).toEqual(["2026-10-02", "2026-10-04", "2026-10-08"]);

      // Phiếu quá hạn 19 ngày, job mới bật lần đầu: chỉ một nhắc (mốc 7), không dồn ba nhắc.
      const old = await invoice("2026-09-10");
      await scanOverdue(t.worker, vn("2026-09-29", "09:00"));
      const oldEv = await outboxFor("invoice.overdue", old);
      expect(oldEv.map((e) => e.dedupe_key)).toEqual([`invoice.overdue:${old}:7`]);
    } finally {
      await sql`delete from notification_settings where property_id = ${A.propertyId}`.execute(t.admin);
    }
  });

  it("cấu hình qua notifications.updateSettings được job dùng (+2 ngày thay mặc định +1)", async () => {
    const r = await run(manager, async (ctx) => ({
      data: await updateSettings(ctx, { propertyId: A.propertyId, overdueReminderOffsetsDays: [2] }),
    }));
    expect(r.status).toBe("committed");
    try {
      const id = await invoice("2026-11-10");
      await scanOverdue(t.worker, vn("2026-11-11", "09:00"));
      expect(await outboxFor("invoice.overdue", id)).toHaveLength(0);
      await scanOverdue(t.worker, vn("2026-11-12", "09:00"));
      expect((await outboxFor("invoice.overdue", id)).map((e) => e.dedupe_key)).toEqual([
        `invoice.overdue:${id}:2`,
      ]);
    } finally {
      await sql`delete from notification_settings where property_id = ${A.propertyId}`.execute(t.admin);
    }
  });

  it("ranh giới khung giờ gửi: 07:59 không, 08:00 có; 19:59 có, 20:00 không (giờ cơ sở)", async () => {
    const early = await invoice("2026-12-01");
    await scanOverdue(t.worker, vn("2026-12-02", "07:59"));
    expect(await outboxFor("invoice.overdue", early)).toHaveLength(0);
    await scanOverdue(t.worker, vn("2026-12-02", "08:00"));
    expect(await outboxFor("invoice.overdue", early)).toHaveLength(1);

    const late = await invoice("2026-12-03");
    await scanOverdue(t.worker, vn("2026-12-04", "20:00"));
    expect(await outboxFor("invoice.overdue", late)).toHaveLength(0);
    await scanOverdue(t.worker, vn("2026-12-04", "19:59"));
    expect(await outboxFor("invoice.overdue", late)).toHaveLength(1);
  });

  it("ranh giới ngày theo giờ chốt (03:00): trước 03:00 vẫn là ngày hôm trước, từ 03:00 mới tính quá hạn", async () => {
    await setSettings(A.orgId, P3, A.ownerMembershipId, { start: "00:00", end: "23:59:59" });
    const id = await invoice("2026-10-10", { propertyId: P3, businessDate: "2026-10-01" });
    // 11/10 02:59 giờ cơ sở = ngày kinh doanh 10/10 → chưa quá hạn.
    await scanOverdue(t.worker, vn("2026-10-11", "02:59"));
    expect(await outboxFor("invoice.overdue", id)).toHaveLength(0);
    // 11/10 03:00 → ngày kinh doanh 11/10 → quá hạn 1 ngày.
    await scanOverdue(t.worker, vn("2026-10-11", "03:00"));
    const ev = await outboxFor("invoice.overdue", id);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ business_date: "2026-10-11", days_overdue: 1 });
    expect(ev[0]?.property_id).toBe(P3);
  });

  it("S-008: phiếu đã tất toán không được chọn; còn nợ một phần vẫn nhắc (kèm số còn nợ)", async () => {
    const settled = await invoice("2026-10-10");
    await sql`update invoices set allocated_total = total where id = ${settled}`.execute(t.admin);
    const partial = await invoice("2026-10-10", { amount: 2_000_000 });
    await sql`update invoices set allocated_total = 500000 where id = ${partial}`.execute(t.admin);
    const at = vn("2026-10-11", "10:00");
    await scanOverdue(t.worker, at);
    expect(await outboxFor("invoice.overdue", settled)).toHaveLength(0);
    expect(await outboxFor("invoice.overdue", partial)).toHaveLength(1);
    await dispatchAll("invoice.overdue", partial, at);
    const n = await sql<{
      body: string;
    }>`select body from notifications where dedupe_key = ${`invoice_overdue:${partial}:2026-10-11`}`.execute(
      t.admin,
    );
    expect(n.rows[0]?.body).toContain("1.500.000 đ");
  });

  it("S-008: tất toán SAU khi quét (trước dispatch) → không tạo thông báo; SAU dispatch (trước gửi) → suppressed SETTLED, không email", async () => {
    // (a) tất toán giữa quét và dispatch
    const a = await invoice("2026-10-10");
    const at = vn("2026-10-11", "10:00");
    await scanOverdue(t.worker, at);
    expect(await outboxFor("invoice.overdue", a)).toHaveLength(1);
    await sql`update invoices set allocated_total = total where id = ${a}`.execute(t.admin);
    expect(await dispatchAll("invoice.overdue", a, at)).toEqual({ created: 0, duplicates: 0 });
    expect(await notificationsLike(`invoice_overdue:${a}:%`)).toHaveLength(0);

    // (b) tất toán sau khi đã xếp hàng nhưng trước khi gửi
    const b = await invoice("2026-10-10");
    await scanOverdue(t.worker, at);
    await dispatchAll("invoice.overdue", b, at);
    const filter = sql`notification_id in (select id from notifications where dedupe_key = ${`invoice_overdue:${b}:2026-10-11`})`;
    const queued = await sql<{
      status: string;
    }>`select status from notification_deliveries where ${filter}`.execute(t.admin);
    expect(queued.rows[0]?.status).toBe("queued");
    await sql`update invoices set allocated_total = total where id = ${b}`.execute(t.admin);
    await sendDueEmails(t.worker, fake, CFG, { now: () => at });
    const after = await sql<{ status: string; suppressed_reason: string | null }>`
      select status, suppressed_reason from notification_deliveries where ${filter}`.execute(t.admin);
    expect(after.rows[0]).toEqual({ status: "suppressed", suppressed_reason: "SETTLED" });
    expect(fake.mailbox.filter((m) => m.template === "invoice_overdue")).toHaveLength(0);
    // Ngày sau job quét không tạo nhắc mới cho phiếu đã tất toán.
    await scanOverdue(t.worker, vn("2026-10-12", "10:00"));
    expect(await outboxFor("invoice.overdue", b)).toHaveLength(1);
  });

  it("chạy song song 5 lần cùng lúc → đúng một sự kiện (không phát trùng)", async () => {
    const id = await invoice("2026-10-10");
    const at = vn("2026-10-11", "09:00");
    const results = await Promise.all(Array.from({ length: 5 }, () => scanOverdue(t.worker, at)));
    expect(await outboxFor("invoice.overdue", id)).toHaveLength(1);
    expect(results.length).toBe(5);
    await Promise.all(Array.from({ length: 5 }, () => dispatchAll("invoice.overdue", id, at)));
    expect(await notificationsLike(`invoice_overdue:${id}:%`)).toHaveLength(1);
  });

  it("chéo tenant: phiếu tổ chức B nhắc người của B theo cấu hình của B; A không thấy và cấu hình A không áp cho B", async () => {
    await setSettings(B.orgId, B.propertyId, B.ownerMembershipId, { overdue: [2] });
    const ofB = await invoice("2026-10-10", { orgId: B.orgId, propertyId: B.propertyId, payer: binhB });
    const ofA = await invoice("2026-10-10");
    const day1 = vn("2026-10-11", "09:00");
    await scanOverdue(t.worker, day1);
    expect(await outboxFor("invoice.overdue", ofB)).toHaveLength(0); // B chọn +2
    expect(await outboxFor("invoice.overdue", ofA)).toHaveLength(1);
    await scanOverdue(t.worker, vn("2026-10-12", "09:00"));
    const evB = await outboxFor("invoice.overdue", ofB);
    expect(evB).toHaveLength(1);
    expect(evB[0]?.organization_id).toBe(B.orgId);

    await dispatchAll("invoice.overdue", ofB, vn("2026-10-12", "09:00"));
    await dispatchAll("invoice.overdue", ofA, day1);
    const nb = await notificationsLike(`invoice_overdue:${ofB}:%`);
    expect(nb).toEqual([expect.objectContaining({ organization_id: B.orgId, recipient_person_id: binhB })]);
    const mine = await listMine(t.runtime, an, { limit: 100 });
    expect(mine.items.some((i) => i.link?.endsWith(ofB))).toBe(false);
    expect(mine.items.some((i) => i.link?.endsWith(ofA))).toBe(true);
  });

  it("email quá hạn đi tới người nhận khi còn nợ (kênh trọn vẹn: quét → dispatch → gửi)", async () => {
    const id = await invoice("2026-10-10");
    const at = vn("2026-10-11", "09:00");
    await scanOverdue(t.worker, at);
    await dispatchAll("invoice.overdue", id, at);
    await sendDueEmails(t.worker, fake, CFG, { now: () => at });
    const mails = fake.mailbox.filter((m) => m.template === "invoice_overdue");
    expect(mails.map((m) => m.to)).toContain("an@example.test");
    // Q-03: email không ghi số tiền.
    expect(JSON.stringify(mails)).not.toContain("1.580.000");
  });
});

describe("S-013 nhắc hợp đồng sắp hết hạn, không lặp (reminder.scanLeaseExpiry = remindExpiring)", () => {
  it("kết thúc 30/11, mốc 30 ngày: chạy 31/10 hai lần → đúng 1 thông báo cho quản lý cơ sở", async () => {
    const lease = await activeLease(A, anPerson, "2026-11-30");
    const at = vn("2026-10-31", "08:00");
    const first = await remindExpiring(t.worker, at);
    const second = await remindExpiring(t.worker, at); // chạy lại sau sự cố
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    const ev = await outboxFor("lease.expiring", lease);
    expect(ev.map((e) => e.dedupe_key)).toEqual([`lease.expiring:${lease}:1:30`]);

    expect(await dispatchAll("lease.expiring", lease, at)).toMatchObject({ created: expect.any(Number) });
    await remindExpiring(t.worker, at);
    await dispatchAll("lease.expiring", lease, at);
    const mgr = await listMine(t.runtime, manager, { limit: 100 });
    expect(mgr.items.filter((i) => i.link?.endsWith(lease))).toHaveLength(1);
    expect(mgr.items.find((i) => i.link?.endsWith(lease))).toMatchObject({
      type: "lease_expiring",
      title: "Hợp đồng sắp hết hạn",
    });
    // Người thuê không nhận bản dành cho quản lý.
    expect((await listMine(t.runtime, an, { limit: 100 })).items.some((i) => i.link?.endsWith(lease))).toBe(
      false,
    );
  });

  it("đã gia hạn (phiên bản mới ngày kết thúc mới) → không nhắc theo ngày cũ", async () => {
    const lease = await activeLease(A, anPerson, "2026-11-30");
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, effective_to,
                                          rent_amount, deposit_amount, signed_at, terms_hash, terms_snapshot)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${lease}, 2, 'appendix', '2026-12-01', '2027-05-31',
                      3000000, 3000000, now(), ${"b".repeat(64)}, '{}'::jsonb)`.execute(t.admin);
    await remindExpiring(t.worker, vn("2026-10-31", "08:00"));
    expect(await outboxFor("lease.expiring", lease)).toHaveLength(0);
    // Nhắc theo ngày mới: 30 ngày trước 31/05/2027 là 01/05/2027, phiên bản 2.
    await remindExpiring(t.worker, vn("2027-05-01", "08:00"));
    expect((await outboxFor("lease.expiring", lease)).map((e) => e.dedupe_key)).toEqual([
      `lease.expiring:${lease}:2:30`,
    ]);
  });

  it("mốc cấu hình của cơ sở (notification_settings.lease_expiry_offsets_days) được job dùng; cơ sở khác giữ mặc định", async () => {
    await setSettings(A.orgId, P3, A.ownerMembershipId, { lease: [45] });
    const custom = await activeLease(A, anPerson, "2026-12-15", P3);
    const plain = await activeLease(A, anPerson, "2026-12-15");
    await remindExpiring(t.worker, vn("2026-10-31", "08:00")); // còn 45 ngày
    expect((await outboxFor("lease.expiring", custom)).map((e) => e.dedupe_key)).toEqual([
      `lease.expiring:${custom}:1:45`,
    ]);
    expect(await outboxFor("lease.expiring", plain)).toHaveLength(0); // mặc định 30/7/0 không có 45
  });

  it("hợp đồng không còn hiệu lực (huỷ/đã đóng) không được nhắc; chéo tenant: B có hàng riêng", async () => {
    const closed = await activeLease(A, anPerson, "2026-11-30");
    await t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx); // bỏ qua máy trạng thái hợp đồng khi dựng dữ liệu
      await sql`update leases set status = 'closed', moved_out_on = '2026-10-01' where id = ${closed}`.execute(
        trx,
      );
    });
    const ofB = await activeLease(B, binhB, "2026-11-30");
    await remindExpiring(t.worker, vn("2026-10-31", "08:00"));
    expect(await outboxFor("lease.expiring", closed)).toHaveLength(0);
    const evB = await outboxFor("lease.expiring", ofB);
    expect(evB).toHaveLength(1);
    expect(evB[0]?.organization_id).toBe(B.orgId);
    await dispatchAll("lease.expiring", ofB, vn("2026-10-31", "08:00"));
    // Quản lý A không có thông báo của hợp đồng tổ chức B.
    expect(
      (await listMine(t.runtime, manager, { limit: 200 })).items.some((i) => i.link?.endsWith(ofB)),
    ).toBe(false);
  });
});

describe("S-020 chưa cấu hình hạn thông báo lưu trú (cảnh báo cấu hình)", () => {
  it("cơ sở có khách in_house mà chưa cấu hình hạn → owner/manager nhận đúng 1 cảnh báo mỗi ngày kinh doanh, chỉ trong app", async () => {
    await inHouseStay(A, anPerson);
    const day1 = vn("2026-10-15", "20:30");
    const r1 = await scanStayNoticeConfig(t.worker, day1);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    expect((await scanStayNoticeConfig(t.worker, day1)).created).toBe(0);
    expect((await scanStayNoticeConfig(t.worker, vn("2026-10-15", "23:50"))).created).toBe(0); // vẫn cùng ngày kinh doanh

    const ev = (
      await sql<Outbox>`select id, organization_id, event_type, dedupe_key, payload, property_id from outbox
                        where event_type = 'stay_notice.unconfigured' and aggregate_id = ${A.propertyId}`.execute(
        t.admin,
      )
    ).rows;
    expect(ev.map((e) => e.dedupe_key)).toEqual([`stay_notice.unconfigured:${A.propertyId}:2026-10-15`]);
    for (const e of ev) {
      await dispatchNotificationEvent(t.worker, asEvent(e), day1);
      await dispatchNotificationEvent(t.worker, asEvent(e), day1); // giao lại
    }
    for (const who of [owner, manager]) {
      const items = (await listMine(t.runtime, who, { limit: 100 })).items.filter(
        (i) => i.title === "Chưa cấu hình hạn thông báo lưu trú",
      );
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "stay_notice_due", link: "/cai-dat/thong-bao" });
    }
    // Người thuê không nhận cảnh báo vận hành; không có email (stay_notice_due chỉ trong app — D-010).
    expect(
      (await listMine(t.runtime, an, { limit: 100 })).items.some((i) => i.type === "stay_notice_due"),
    ).toBe(false);
    const d = await sql<{ n: number }>`select count(*)::int as n from notification_deliveries d
      join notifications n on n.id = d.notification_id and n.organization_id = d.organization_id
      where n.type = 'stay_notice_due'`.execute(t.admin);
    expect(d.rows[0]?.n).toBe(0);

    // Ngày kinh doanh kế tiếp → một cảnh báo mới (mỗi ngày tối đa 1).
    expect((await scanStayNoticeConfig(t.worker, vn("2026-10-16", "09:00"))).created).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("đã cấu hình hạn → không cảnh báo; cấu hình rỗng `{}` vẫn là chưa cấu hình; khách đã trả phòng/cơ sở không có khách → không cảnh báo", async () => {
    const evCount = async (propertyId: string) =>
      Number(
        (
          await sql<{ n: string }>`select count(*) as n from outbox
            where event_type = 'stay_notice.unconfigured' and aggregate_id = ${propertyId}`.execute(t.admin)
        ).rows[0]?.n,
      );
    // Cơ sở P3: chỉ có khách đã trả phòng + chưa cấu hình → không có khách đang ở → không cảnh báo.
    const org3 = { ...A, propertyId: P3 } as SeededOrg;
    await sql`insert into floors (id, organization_id, property_id, name) values (${randomUUID()}, ${A.orgId}, ${P3}, 'T')`.execute(
      t.admin,
    );
    const floor3 = (
      await sql<{ id: string }>`select id from floors where property_id = ${P3}`.execute(t.admin)
    ).rows[0]?.id as string;
    const rt3 = randomUUID();
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity) values (${rt3}, ${A.orgId}, ${P3}, 'S3', 'S', 2)`.execute(
      t.admin,
    );
    org3.floorId = floor3;
    org3.roomTypeId = rt3;
    await inHouseStay(org3, anPerson, "checked_out");
    await scanStayNoticeConfig(t.worker, vn("2026-10-20", "09:00"));
    expect(await evCount(P3)).toBe(0);

    // Có khách đang ở: `{}` ⇒ cảnh báo; có hạn thật ⇒ không.
    await inHouseStay(org3, anPerson);
    await setSettings(A.orgId, P3, A.ownerMembershipId, { deadline: null });
    await sql`update notification_settings set stay_notice_deadline = '{}'::jsonb where property_id = ${P3}`.execute(
      t.admin,
    );
    await scanStayNoticeConfig(t.worker, vn("2026-10-20", "09:00"));
    expect(await evCount(P3)).toBe(1);
    await setSettings(A.orgId, P3, A.ownerMembershipId, { deadline: { before_time: "23:00" } });
    await scanStayNoticeConfig(t.worker, vn("2026-10-21", "09:00"));
    expect(await evCount(P3)).toBe(1); // không thêm khi đã cấu hình
  });

  it("ranh giới ngày kinh doanh (giờ chốt 03:00) và chéo tenant: B chỉ nhận cảnh báo của B", async () => {
    // P3 chưa cấu hình (xoá hàng cấu hình từ test trước), 02:30 ngày 22 vẫn là ngày kinh doanh 21.
    await sql`delete from notification_settings where property_id = ${P3}`.execute(t.admin);
    await scanStayNoticeConfig(t.worker, vn("2026-10-22", "02:30"));
    await scanStayNoticeConfig(t.worker, vn("2026-10-22", "03:00"));
    const keys = (
      await sql<{
        dedupe_key: string;
      }>`select dedupe_key from outbox where event_type = 'stay_notice.unconfigured'
                                        and aggregate_id = ${P3} order by dedupe_key`.execute(t.admin)
    ).rows.map((r) => r.dedupe_key);
    expect(keys).toEqual(
      expect.arrayContaining([
        `stay_notice.unconfigured:${P3}:2026-10-21`,
        `stay_notice.unconfigured:${P3}:2026-10-22`,
      ]),
    );

    const ownerB = await resolveActor(t.runtime, {
      authUserId: B.ownerAuthUserId,
      orgId: B.orgId,
      twoFactorEnabled: true,
    });
    await inHouseStay(B, binhB);
    await scanStayNoticeConfig(t.worker, vn("2026-10-22", "09:00"));
    const evB = (
      await sql<Outbox>`select id, organization_id, event_type, dedupe_key, payload, property_id from outbox
                        where event_type = 'stay_notice.unconfigured' and organization_id = ${B.orgId}`.execute(
        t.admin,
      )
    ).rows;
    expect(evB).toHaveLength(1);
    await dispatchNotificationEvent(t.worker, asEvent(evB[0] as Outbox), vn("2026-10-22", "09:00"));
    expect(
      (await listMine(t.runtime, ownerB, { limit: 50 })).items.filter((i) => i.type === "stay_notice_due"),
    ).toHaveLength(1);
    // Owner A không thấy cảnh báo của B (RLS) — số cảnh báo của A không đổi.
    const before = (await listMine(t.runtime, owner, { limit: 100 })).items.filter(
      (i) => i.type === "stay_notice_due",
    ).length;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(
      (await listMine(t.runtime, owner, { limit: 100 })).items.every((i) => !i.body.includes("Nhà trọ B")),
    ).toBe(true);
  });
});
