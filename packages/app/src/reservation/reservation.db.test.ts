// PLAN đợt 3 T-204 — booking trên Postgres thật (SPEC-reservation-stay S-003…S-011, S-014, S-025; SPEC-inventory S-018;
// ERD `reservations`, `reservation_items`, `stays`; INV-F3, INV-F5, INV-G3, INV-I1, INV-I3).
// Mốc giờ: cơ sở `hotel` nhận 14:00 / trả 12:00, giờ chốt ngày 04:00, múi giờ Asia/Ho_Chi_Minh (UTC+7) — fixture SPEC.
import { randomUUID } from "node:crypto";
import { bookingMachine, stayMachine } from "@hm/domain";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireHolds } from "../../../../apps/worker/src/jobs.ts";
import { type Actor, resolveActor } from "../access/actor.ts";
import { decideApproval } from "../approvals/approvals.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { resizeAllocation } from "../inventory/inventory.ts";
import { balance } from "../ledger/ledger.ts";
import { executeCommand } from "../pipeline/command.ts";
import { openShift } from "../shifts/shifts.ts";
import { setRatePlan } from "./rates.ts";
import {
  type BookingPaymentInput,
  cancelReservation,
  changeReservationDates,
  confirmReservation,
  createReservation,
  getReservation,
  holdReservation,
  listReservations,
  markNoShow,
} from "./reservation.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let F2: Actor;
let K: Actor;
let H: Actor;
let OB: Actor;
let RA: string; // tài khoản nhận
let deps: HttpDeps;
const users: Record<string, string> = {};

type Problem = {
  code: string;
  status: number;
  errors?: { field: string; code: string }[];
  alternatives?: Record<string, string | number | null>[];
  approval_request_id?: string;
  from?: string;
  to?: string;
};

// 16/10/2026 10:00 giờ VN; hold TTL mặc định 15 phút → hết hạn 03:15:00Z.
const NOW = new Date("2026-10-16T03:00:00Z");
const iso = (d: Date | string) => new Date(d).toISOString();

async function member(role: string, org: SeededOrg = A): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  users[role] = user;
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"})`.execute(
    t.admin,
  );
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    {
      command: "reservation.test",
      idempotencyKey: key,
      payload: { key },
      correlationId: "c-reservation-test",
    },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<Awaited<ReturnType<typeof run<unknown>>>>): Promise<Problem> {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as Problem;
}

async function pgError(
  p: PromiseLike<unknown>,
): Promise<{ code?: string; constraint?: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string; hint?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

async function newUnit(code: string, typeId: string = A.roomTypeId): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${typeId}, ${`${code}-${id.slice(0, 4)}`})`.execute(
    t.admin,
  );
  return id;
}

async function newRoomType(withPlan = true, capacity = 2): Promise<string> {
  const id = randomUUID();
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${`T${id.slice(0, 6)}`}, 'Loại thử', ${capacity})`.execute(
    t.admin,
  );
  if (withPlan) await setPlan(id);
  return id;
}

const setPlan = (roomTypeId: string) =>
  ok(
    run(O, async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    })),
  );

const book = (
  actor: Actor,
  unitId: string,
  arrival = "2026-10-20",
  departure = "2026-10-22",
  guests = 2,
  key?: string,
) =>
  ok(
    run(
      actor,
      async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "Nguyễn Văn A", phone: "0901234567" },
          rooms: [{ unitId, guests }],
          arrivalDate: arrival,
          departureDate: departure,
        }),
      }),
      key,
    ),
  );

const hold = (actor: Actor, reservationId: string, now = NOW) =>
  run(actor, async (ctx) => ({ data: await holdReservation(ctx, { reservationId, now }) }));

const heldBooking = async (unitId?: string, arrival = "2026-10-20", departure = "2026-10-22") => {
  const unit = unitId ?? (await newUnit("H"));
  const r = await book(F, unit, arrival, departure);
  await ok(hold(F, r.id));
  return { reservationId: r.id, unitId: unit };
};

const transfer = (
  amount: number,
  ref: string,
  kind: BookingPaymentInput["kind"] = "advance",
): BookingPaymentInput => ({
  kind,
  method: "bank_transfer",
  amount,
  receivingAccountId: RA,
  bankTxn: { ref, occurredAt: "2026-10-16T02:30:00Z", description: "Ứng trước đặt phòng" },
});

const confirm = (
  actor: Actor,
  reservationId: string,
  payment?: BookingPaymentInput,
  now = NOW,
  key?: string,
) =>
  run(
    actor,
    async (ctx) => ({
      data: await confirmReservation(ctx, { reservationId, ...(payment ? { payment } : {}), now }),
    }),
    key,
  );

/** Booking đã xác nhận với ứng trước chuyển khoản do quản lý xác nhận. */
async function confirmedBooking(amount = 500_000, arrival = "2026-10-20", departure = "2026-10-22") {
  const h = await heldBooking(undefined, arrival, departure);
  const c = await ok(confirm(M, h.reservationId, transfer(amount, `FT${randomUUID().slice(0, 10)}`)));
  return { ...h, ...c };
}

async function setNoPaymentPolicy(on: boolean) {
  await sql`update properties set settings = ${JSON.stringify(on ? { reservation: { confirm_without_payment: true } } : {})}::jsonb
            where id = ${A.propertyId}`.execute(t.admin);
}

async function allocs(unitId: string) {
  const r = await sql<{
    id: string;
    kind: string;
    source_type: string | null;
    source_id: string | null;
    active: boolean;
    expires_at: Date | null;
    lo: Date;
    hi: Date;
    deactivated_reason: string | null;
  }>`select id, kind, source_type, source_id, active, expires_at, lower(during) as lo, upper(during) as hi, deactivated_reason
     from allocations where unit_id = ${unitId} order by created_at, id`.execute(t.admin);
  return r.rows;
}

async function row<T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>): Promise<T> {
  const r = await q.execute(t.admin);
  return r.rows[0] as T;
}

const statusOf = async (id: string) =>
  (await row(sql<{ s: string }>`select status as s from reservations where id = ${id}`)).s;
const stayStatuses = async (reservationId: string) =>
  (
    await sql<{
      status: string;
    }>`select s.status from stays s join reservation_items i on i.id = s.reservation_item_id
                                  where i.reservation_id = ${reservationId}`.execute(t.admin)
  ).rows.map((x) => x.status);
const credit = (personId: string) =>
  t.admin
    .transaction()
    .execute((trx) => balance(trx, { orgId: A.orgId, account: "CUSTOMER_CREDIT", personId }));
const bookerOf = async (id: string) =>
  (await row(sql<{ p: string }>`select booker_person_id as p from reservations where id = ${id}`)).p;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS đặt phòng", "hotel");
  B = await seedOrg(t.admin, "KS khác", "hotel");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00'
            where id = ${A.propertyId}`.execute(t.admin);
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  users.owner = A.ownerAuthUserId;
  OB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
  F2 = await member("front_desk");
  K = await member("accountant");
  H = await member("housekeeping");
  RA = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${RA}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'KHACH SAN A')`.execute(
    t.admin,
  );
  await setPlan(A.roomTypeId);
  await ok(
    run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
  );
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

describe("S-003 tạo booking và giữ phòng có hạn", () => {
  it("create → draft (chưa giữ phòng, snapshot 2 × 600.000 = 1.200.000); hold → held, allocation [20/10 07:00Z, 22/10 05:00Z) có hạn", async () => {
    const unit = await newUnit("201");
    const r = await book(F, unit);
    expect(r).toMatchObject({
      status: "draft",
      source: "direct",
      room_total: 1_200_000,
      number: expect.stringMatching(/^R-\d+$/),
    });
    expect(r.items[0]).toMatchObject({ unit_id: unit, nights: 2, guests: 2, room_total: 1_200_000 });
    expect(r.items[0]?.nightly_prices.map((n) => [n.business_date, n.amount])).toEqual([
      ["2026-10-20", 600_000],
      ["2026-10-21", 600_000],
    ]);
    expect(await allocs(unit)).toHaveLength(0);

    const h = await ok(hold(F, r.id));
    expect(h).toMatchObject({ status: "held", reservation_id: r.id });
    expect(iso(h.expires_at)).toBe("2026-10-16T03:15:00.000Z");
    expect(await statusOf(r.id)).toBe("held");
    const [a, ...rest] = await allocs(unit);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({
      kind: "hold",
      source_type: "reservation_item",
      source_id: r.items[0]?.id,
      active: true,
    });
    expect(iso(a?.lo as Date)).toBe("2026-10-20T07:00:00.000Z");
    expect(iso(a?.hi as Date)).toBe("2026-10-22T05:00:00.000Z");
    expect(iso(a?.expires_at as Date)).toBe("2026-10-16T03:15:00.000Z");
  });

  it("TTL theo properties.hold_ttl_minutes của cơ sở", async () => {
    await sql`update properties set hold_ttl_minutes = 30 where id = ${A.propertyId}`.execute(t.admin);
    try {
      const unit = await newUnit("TTL");
      const r = await book(F, unit);
      expect(iso((await ok(hold(F, r.id))).expires_at)).toBe("2026-10-16T03:30:00.000Z");
    } finally {
      await sql`update properties set hold_ttl_minutes = 15 where id = ${A.propertyId}`.execute(t.admin);
    }
  });

  it("hold hai lần / hold booking đã huỷ → INVALID_TRANSITION; phòng ngừng khai thác → UNIT_OUT_OF_SERVICE", async () => {
    const unit = await newUnit("202");
    const r = await book(F, unit);
    await ok(hold(F, r.id));
    expect(await fails(hold(F, r.id))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    expect(await allocs(unit)).toHaveLength(1);

    const off = await newUnit("OFF");
    const r2 = await book(F, off);
    await sql`update units set availability = 'out_of_service', availability_reason = 'sự cố' where id = ${off}`.execute(
      t.admin,
    );
    expect(await fails(hold(F, r2.id))).toMatchObject({ code: "UNIT_OUT_OF_SERVICE", status: 409 });
    expect(await statusOf(r2.id)).toBe("draft");
  });

  it("nhiều phòng: mỗi phòng một dòng, hold đủ; một phòng bận → không giữ phòng nào", async () => {
    const [u1, u2, u3] = [await newUnit("M1"), await newUnit("M2"), await newUnit("M3")];
    const multi = await ok(
      run(F, async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "Đoàn nhỏ", phone: "0900000001" },
          rooms: [
            { unitId: u1, guests: 2 },
            { unitId: u2, guests: 1 },
          ],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-21",
        }),
      })),
    );
    expect(multi.items).toHaveLength(2);
    expect(multi.room_total).toBe(1_200_000);
    const h = await ok(hold(F, multi.id));
    expect(h.holds).toHaveLength(2);
    expect((await allocs(u1)).length + (await allocs(u2)).length).toBe(2);

    // u1 đã bị giữ: booking mới [u3, u1] thất bại và KHÔNG để lại hold ở u3.
    const clash = await ok(
      run(F, async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "Khách tranh", phone: "0900000002" },
          rooms: [
            { unitId: u1, guests: 1 },
            { unitId: u3, guests: 1 },
          ],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-21",
        }),
      })),
    );
    expect(await fails(hold(F, clash.id))).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(await allocs(u3)).toHaveLength(0);
    expect(await statusOf(clash.id)).toBe("draft");
  });
});

describe("S-004 hai lễ tân giữ cùng phòng cuối", () => {
  it("chạy song song: đúng một thắng, người còn lại 409 ROOM_UNAVAILABLE kèm gợi ý; chỉ một allocation", async () => {
    const last = await newUnit("LAST");
    const spare = await newUnit("SPARE"); // phòng cùng loại còn trống → gợi ý
    const [r1, r2] = [await book(F, last), await book(F2, last)];
    const results = await Promise.all([hold(F, r1.id), hold(F2, r2.id)]);
    const won = results.filter((r) => r.status === "committed");
    const lost = results.filter((r) => r.status === "failed");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const problem = (lost[0] as { problem: Problem }).problem;
    expect(problem).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(problem.alternatives?.map((a) => a.unit_id)).toContain(spare);
    expect((await allocs(last)).filter((a) => a.active)).toHaveLength(1);
    expect(new Set([await statusOf(r1.id), await statusOf(r2.id)])).toEqual(new Set(["held", "draft"]));
  });
});

describe("S-005 xác nhận kèm ứng trước có chứng cứ", () => {
  it("chuyển khoản 500.000 có sao kê → confirmed, stay expected, allocation hold → stay (không khe hở), payment confirmed, bút toán cân", async () => {
    const h = await heldBooking();
    const holdAlloc = (await allocs(h.unitId))[0];
    const c = await ok(confirm(M, h.reservationId, transfer(500_000, "FT-S005-1")));
    expect(c).toMatchObject({ status: "confirmed", confirmed_without_payment: false });
    expect(c.stay_id).toEqual(expect.any(String));
    expect(await statusOf(h.reservationId)).toBe("confirmed");
    expect(await stayStatuses(h.reservationId)).toEqual(["expected"]);

    const allocations = await allocs(h.unitId);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      id: holdAlloc?.id,
      kind: "stay",
      source_type: "stay",
      source_id: c.stay_id,
      active: true,
      expires_at: null,
    });

    const p = await row(sql<{
      status: string;
      amount: string;
      purpose: string;
      bank_transaction_id: string | null;
      payer_person_id: string;
    }>`
      select status, amount::text, purpose, bank_transaction_id, payer_person_id from payments where id = ${c.payment_id}`);
    expect(p).toMatchObject({ status: "confirmed", amount: "500000", purpose: "receivable" });
    expect(p.bank_transaction_id).not.toBeNull();
    expect(p.payer_person_id).toBe(await bookerOf(h.reservationId));
    const lines = await sql<{ account: string; debit: string; credit: string }>`
      select jl.account, jl.debit::text, jl.credit::text from journal_lines jl
      join journal_entries je on je.id = jl.entry_id where je.source_doc_id = ${c.payment_id} order by jl.line_no`.execute(
      t.admin,
    );
    expect(lines.rows).toEqual([
      { account: "BANK", debit: "500000", credit: "0" },
      { account: "CUSTOMER_CREDIT", debit: "0", credit: "500000" },
    ]);
    expect(await credit(await bookerOf(h.reservationId))).toBe(-500_000); // Có CUSTOMER_CREDIT = Nợ − Có âm
    const ev =
      await sql`select 1 from outbox where event_type = 'reservation.confirmed' and aggregate_id = ${h.reservationId}`.execute(
        t.admin,
      );
    expect(ev.rows).toHaveLength(1);
  });

  it("giao dịch đã có từ webhook cùng (tài khoản, mã) → vẫn MỘT bank_transactions, MỘT payment; dùng lại cho booking khác → BANK_TRANSACTION_ALREADY_USED", async () => {
    const ref = `FT-WEB-${randomUUID().slice(0, 6)}`;
    const { bankTxnHash } = await import("../ledger/bank-inbox.ts");
    await sql`insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                             first_source, raw_hash)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${RA}, ${ref}, 500000, '2026-10-16T02:00:00Z', 'webhook',
                      ${bankTxnHash(ref, 500_000)})`.execute(t.admin);
    const h = await heldBooking();
    const c = await ok(confirm(M, h.reservationId, transfer(500_000, ref)));
    const n = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from bank_transactions where receiving_account_id = ${RA} and bank_txn_ref = ${ref}`,
    );
    expect(n.n).toBe(1);
    const pays = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from payments where id = ${c.payment_id} and bank_transaction_id is not null`,
    );
    expect(pays.n).toBe(1);
    const h2 = await heldBooking();
    expect(await fails(confirm(M, h2.reservationId, transfer(500_000, ref)))).toMatchObject({
      code: "BANK_TRANSACTION_ALREADY_USED",
    });
    expect(await statusOf(h2.reservationId)).toBe("held");
  });

  it("tiền mặt: lễ tân tự xác nhận khoản mình nhận trong ca mở; lễ tân KHÔNG xác nhận được chuyển khoản (403)", async () => {
    const h = await heldBooking();
    const c = await ok(confirm(F, h.reservationId, { kind: "advance", method: "cash", amount: 300_000 }));
    expect(c.payment_id).not.toBeNull();
    const p = await row(
      sql<{
        status: string;
        receipt_no: string | null;
      }>`select status, receipt_no from payments where id = ${c.payment_id}`,
    );
    expect(p.status).toBe("confirmed");
    expect(p.receipt_no).toMatch(/^PT-/);

    const h2 = await heldBooking();
    expect(
      await fails(confirm(F, h2.reservationId, transfer(500_000, `FT-F-${randomUUID().slice(0, 6)}`))),
    ).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(await statusOf(h2.reservationId)).toBe("held");
  });

  it("cọc bảo đảm: vào DEPOSIT_LIAB (không phải ứng trước/doanh thu), gắn reservation_id (FK)", async () => {
    const h = await heldBooking();
    const c = await ok(
      confirm(
        M,
        h.reservationId,
        transfer(1_000_000, `FT-DEP-${randomUUID().slice(0, 6)}`, "security_deposit"),
      ),
    );
    expect(c.deposit_id).not.toBeNull();
    const d = await row(
      sql<{
        amount: string;
        reservation_id: string;
      }>`select amount::text, reservation_id from deposits where id = ${c.deposit_id}`,
    );
    expect(d).toEqual({ amount: "1000000", reservation_id: h.reservationId });
    expect(
      await t.admin
        .transaction()
        .execute((trx) =>
          balance(trx, { orgId: A.orgId, account: "DEPOSIT_LIAB", depositId: c.deposit_id as string }),
        ),
    ).toBe(-1_000_000);
    expect(await credit(await bookerOf(h.reservationId))).toBe(0);
    // FK: cọc không trỏ được booking không tồn tại.
    const e = await pgError(
      sql`insert into deposits (id, organization_id, property_id, reservation_id, payer_person_id)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${randomUUID()}, ${A.ownerPersonId})`.execute(
        t.admin,
      ),
    );
    expect(e.code).toBe("23503");
  });

  it("idempotency: gửi lại cùng key → cùng kết quả, MỘT payment; key khác trên booking đã xác nhận → INVALID_TRANSITION, không ghi tiền thêm", async () => {
    const h = await heldBooking();
    const key = randomUUID();
    const pay = transfer(500_000, `FT-IDEM-${randomUUID().slice(0, 6)}`);
    const first = await confirm(M, h.reservationId, pay, NOW, key);
    const again = await confirm(M, h.reservationId, pay, NOW, key);
    expect(first.status).toBe("committed");
    expect(again).toMatchObject({ status: "committed", replayed: true });
    expect((again as { data: { payment_id: string } }).data.payment_id).toBe(
      (first as { data: { payment_id: string } }).data.payment_id,
    );
    const other = await fails(
      confirm(M, h.reservationId, transfer(500_000, `FT-IDEM2-${randomUUID().slice(0, 6)}`)),
    );
    expect(other).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    const n = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from payments where payer_person_id = ${await bookerOf(h.reservationId)}`,
    );
    expect(n.n).toBe(1);
  });
});

describe("S-006 'khách bấm đã chuyển' không đủ để xác nhận tiền", () => {
  it("chuyển khoản không chứng cứ → EVIDENCE_REQUIRED; booking vẫn held, không payment, không bút toán BANK", async () => {
    const h = await heldBooking();
    const booker = await bookerOf(h.reservationId);
    const noEvidence: BookingPaymentInput = {
      kind: "advance",
      method: "bank_transfer",
      amount: 500_000,
      receivingAccountId: RA,
    };
    expect(await fails(confirm(M, h.reservationId, noEvidence))).toMatchObject({
      code: "EVIDENCE_REQUIRED",
      status: 422,
    });
    expect(await statusOf(h.reservationId)).toBe("held");
    expect(
      (await sql`select 1 from payments where payer_person_id = ${booker}`.execute(t.admin)).rows,
    ).toHaveLength(0);
    expect(await credit(booker)).toBe(0);
    expect((await allocs(h.unitId))[0]).toMatchObject({ kind: "hold", active: true });
  });

  it("không kèm tiền: mặc định bị từ chối (EVIDENCE_REQUIRED); cơ sở bật confirm_without_payment (Q-05) thì xác nhận được, đánh dấu rõ", async () => {
    const h = await heldBooking();
    expect(await fails(confirm(M, h.reservationId))).toMatchObject({ code: "EVIDENCE_REQUIRED" });
    expect(await statusOf(h.reservationId)).toBe("held");
    await setNoPaymentPolicy(true);
    try {
      const c = await ok(confirm(M, h.reservationId));
      expect(c).toMatchObject({ status: "confirmed", payment_id: null, confirmed_without_payment: true });
      expect(await stayStatuses(h.reservationId)).toEqual(["expected"]);
    } finally {
      await setNoPaymentPolicy(false);
    }
  });

  it("DB chặn held → confirmed không chứng cứ (không phụ thuộc app); payment pending không đủ", async () => {
    const h = await heldBooking();
    const e = await pgError(
      sql`update reservations set status = 'confirmed', confirmed_at = now() where id = ${h.reservationId}`.execute(
        t.admin,
      ),
    );
    expect(e).toMatchObject({ code: "23514", hint: "EVIDENCE_REQUIRED" });
    // payment.record chuyển khoản không chứng cứ → pending; trỏ vào booking vẫn không đủ.
    const booker = await bookerOf(h.reservationId);
    const pid = randomUUID();
    await sql`insert into payments (id, organization_id, property_id, method, purpose, amount, receiving_account_id, payer_person_id,
                                    business_date, recorded_by)
              values (${pid}, ${A.orgId}, ${A.propertyId}, 'bank_transfer', 'receivable', 500000, ${RA}, ${booker}, '2026-10-16',
                      ${F.membershipId})`.execute(t.admin);
    const e2 = await pgError(
      sql`update reservations set status = 'confirmed', confirmed_at = now(), confirmation_payment_id = ${pid} where id = ${h.reservationId}`.execute(
        t.admin,
      ),
    );
    expect(e2).toMatchObject({ code: "23514", hint: "EVIDENCE_REQUIRED" });
    expect(await statusOf(h.reservationId)).toBe("held");
  });
});

describe("S-007 xác nhận khi hold đã hết hạn", () => {
  it("đúng ranh giới giây: expires_at − 1 s còn xác nhận được; đúng expires_at → HOLD_EXPIRED", async () => {
    await setNoPaymentPolicy(true);
    try {
      const a = await heldBooking();
      const just = new Date(NOW.getTime() + 15 * 60_000 - 1000);
      expect(await ok(confirm(M, a.reservationId, undefined, just))).toMatchObject({ status: "confirmed" });

      const b = await heldBooking();
      const exact = new Date(NOW.getTime() + 15 * 60_000);
      expect(await fails(confirm(M, b.reservationId, undefined, exact))).toMatchObject({
        code: "HOLD_EXPIRED",
        status: 409,
      });
    } finally {
      await setNoPaymentPolicy(false);
    }
  });

  it("held → expired đúng MỘT lần, phòng được nhả, không tự tạo lại; confirm lần sau vẫn HOLD_EXPIRED", async () => {
    const h = await heldBooking();
    const late = new Date(NOW.getTime() + 20 * 60_000);
    expect(
      await fails(confirm(M, h.reservationId, transfer(500_000, `FT-EXP-${randomUUID().slice(0, 6)}`), late)),
    ).toMatchObject({
      code: "HOLD_EXPIRED",
    });
    expect(await statusOf(h.reservationId)).toBe("expired");
    expect((await allocs(h.unitId))[0]).toMatchObject({ active: false, deactivated_reason: "expired" });
    expect(await allocs(h.unitId)).toHaveLength(1); // không tự tạo hold mới
    expect(await fails(confirm(M, h.reservationId, undefined, late))).toMatchObject({ code: "HOLD_EXPIRED" });
    const audits = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from audit_events where entity_id = ${h.reservationId} and action = 'reservation.expired'`,
    );
    expect(audits.n).toBe(1);
    // Phòng đã nhả: booking khác giữ được ngay.
    const other = await book(F, h.unitId);
    await ok(hold(F, other.id, late));
    // Booking hết hạn không đi tiếp (bảng chuyển).
    expect(await fails(hold(F, h.reservationId, late))).toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("job nhả hold của worker cũng đưa booking về expired (một cơ chế ở CSDL)", async () => {
    const h = await heldBooking();
    await expireHolds(t.worker, new Date(NOW.getTime() + 60 * 60_000));
    expect(await statusOf(h.reservationId)).toBe("expired");
    expect(
      await fails(confirm(M, h.reservationId, transfer(500_000, `FT-W-${randomUUID().slice(0, 6)}`))),
    ).toMatchObject({
      code: "HOLD_EXPIRED",
    });
    expect(
      (
        await sql`select 1 from payments where payer_person_id = ${await bookerOf(h.reservationId)}`.execute(
          t.admin,
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe("S-008 đổi ngày nguyên tử", () => {
  async function busyFrom23(unitId: string) {
    // `201` bận từ 23/10 14:00 giờ VN.
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay',
                      tstzrange('2026-10-23T07:00:00Z', '2026-10-25T05:00:00Z', '[)'))`.execute(t.admin);
  }
  const change = (id: string, arrival: string, departure: string, previewOnly = false, actor: Actor = F) =>
    run(actor, async (ctx) => ({
      data: await changeReservationDates(ctx, {
        reservationId: id,
        arrivalDate: arrival,
        departureDate: departure,
        previewOnly,
        now: NOW,
      }),
    }));

  it("preview +600.000 không đổi gì; đi 23/10 → 200 (allocation cùng transaction, đêm cũ giữ giá); đi 24/10 → 409 và KHÔNG đổi gì", async () => {
    const c = await confirmedBooking();
    await busyFrom23(c.unitId);
    const before = await allocs(c.unitId);

    const p = await ok(change(c.reservationId, "2026-10-20", "2026-10-23", true));
    expect(p).toMatchObject({
      preview_only: true,
      price_diff: 600_000,
      old_total: 1_200_000,
      new_total: 1_800_000,
      available: true,
    });
    expect(await allocs(c.unitId)).toEqual(before);
    expect((await ok(change(c.reservationId, "2026-10-20", "2026-10-24", true))).available).toBe(false);

    const done = await ok(change(c.reservationId, "2026-10-20", "2026-10-23"));
    expect(done).toMatchObject({ price_diff: 600_000, new_total: 1_800_000 });
    expect(done.reservation.items[0]?.nightly_prices.map((n) => n.amount)).toEqual([
      600_000, 600_000, 600_000,
    ]);
    const mine = (await allocs(c.unitId)).find((a) => a.kind === "stay" && a.source_type === "stay");
    expect(iso(mine?.hi as Date)).toBe("2026-10-23T05:00:00.000Z");

    const snapshot = await row(sql<{ d: string; total: string; hi: Date }>`
      select i.departure_date::text as d, i.room_total::text as total,
             (select upper(during) from allocations where id = ${mine?.id as string}) as hi
      from reservation_items i where i.reservation_id = ${c.reservationId}`);
    const bad = await change(c.reservationId, "2026-10-20", "2026-10-24");
    expect(bad.status).toBe("failed");
    expect((bad as { problem: Problem }).problem).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    const after = await row(sql<{ d: string; total: string; hi: Date }>`
      select i.departure_date::text as d, i.room_total::text as total,
             (select upper(during) from allocations where id = ${mine?.id as string}) as hi
      from reservation_items i where i.reservation_id = ${c.reservationId}`);
    expect(after).toEqual(snapshot);
  });

  it("Q-06: đêm cũ giữ giá snapshot khi đổi bảng giá, đêm mới lấy giá hiện hành; rút ngắn trả lại chênh âm", async () => {
    const rt = await newRoomType();
    const unit = await newUnit("Q6", rt);
    await setNoPaymentPolicy(true);
    let id: string;
    try {
      const h = await heldBooking(unit);
      id = h.reservationId;
      await ok(confirm(M, id));
    } finally {
      await setNoPaymentPolicy(false);
    }
    // Owner tăng giá ngày thường lên 650.000 từ 17/10 (sau booking).
    await ok(
      run(O, async (ctx) => ({
        data: await setRatePlan(ctx, {
          roomTypeId: rt,
          weekdayPrice: 650_000,
          weekendPrice: 800_000,
          effectiveFrom: "2026-10-17",
          now: NOW,
        }),
      })),
    );
    const r = await ok(change(id, "2026-10-20", "2026-10-23"));
    expect(r.reservation.items[0]?.nightly_prices.map((n) => n.amount)).toEqual([600_000, 600_000, 650_000]);
    expect(r.price_diff).toBe(650_000);
    const shorter = await ok(change(id, "2026-10-20", "2026-10-21"));
    expect(shorter.price_diff).toBe(-1_250_000);
    expect(shorter.new_total).toBe(600_000);
    // DB giữ hàng rào: không đổi giá đêm đã chốt trực tiếp (INV-G3).
    const e = await pgError(
      sql`update reservation_items set nightly_prices = ${JSON.stringify([{ business_date: "2026-10-20", amount: 1 }])}::jsonb, room_total = 1
          where reservation_id = ${id}`.execute(t.admin),
    );
    expect(e).toMatchObject({ code: "55000", hint: "DOCUMENT_IMMUTABLE" });
  });

  it("ca biên: ngày không đổi / đi ≤ đến / quá 30 đêm / booking đã huỷ", async () => {
    const c = await confirmedBooking();
    expect(await fails(change(c.reservationId, "2026-10-20", "2026-10-22"))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const back = await fails(change(c.reservationId, "2026-10-22", "2026-10-22"));
    expect(back).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(back.errors?.[0]?.field).toBe("departure_date");
    const long = await fails(change(c.reservationId, "2026-10-20", "2026-11-20")); // 31 đêm
    expect(long).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(long.errors?.[0]).toMatchObject({ field: "departure_date", code: "STAY_TOO_LONG" });
    await ok(
      run(F, async (ctx) => ({
        data: await cancelReservation(ctx, {
          reservationId: c.reservationId,
          reason: "Khách đổi ý",
          now: NOW,
        }),
      })),
    );
    expect(await fails(change(c.reservationId, "2026-10-20", "2026-10-21"))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });
});

describe("S-009 huỷ booking: nhả phòng, không tự coi tiền là doanh thu", () => {
  const cancel = (actor: Actor, id: string, reason: string, fee?: number, key?: string) =>
    run(
      actor,
      async (ctx) => ({
        data: await cancelReservation(ctx, {
          reservationId: id,
          reason,
          ...(fee === undefined ? {} : { cancellationFee: fee }),
          now: NOW,
        }),
      }),
      key,
    );

  it("huỷ booking confirmed có ứng trước 500.000: cancelled, stay cancelled, allocation active=false; 500.000 vẫn ở CUSTOMER_CREDIT; không có REV_*", async () => {
    const c = await confirmedBooking(500_000);
    const booker = await bookerOf(c.reservationId);
    const r = await ok(cancel(F, c.reservationId, "Khách báo huỷ", 0));
    expect(r).toMatchObject({ status: "cancelled", cancellation_fee: 0, charge_id: null });
    expect(await statusOf(c.reservationId)).toBe("cancelled");
    expect(await stayStatuses(c.reservationId)).toEqual(["cancelled"]);
    expect((await allocs(c.unitId))[0]).toMatchObject({ active: false, deactivated_reason: "cancelled" });
    expect(await credit(booker)).toBe(-500_000);
    const rev = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from journal_lines where organization_id = ${A.orgId} and account like 'REV\\_%'`,
    );
    expect(rev.n).toBe(0);
    const cr = await row(
      sql<{
        reason: string;
        at: Date;
      }>`select cancel_reason as reason, cancelled_at as at from reservations where id = ${c.reservationId}`,
    );
    expect(cr.reason).toBe("Khách báo huỷ");
    // Phòng trống lại ngay.
    const again = await book(F, c.unitId);
    await ok(hold(F, again.id));
  });

  it("huỷ draft/held không cần lý do tiền; thiếu lý do → 422; huỷ held nhả hold", async () => {
    const h = await heldBooking();
    expect(await fails(cancel(F, h.reservationId, "   "))).toMatchObject({ code: "VALIDATION_FAILED" });
    await ok(cancel(F, h.reservationId, "Nhập nhầm"));
    expect((await allocs(h.unitId))[0]).toMatchObject({ active: false });
    const d = await book(F, await newUnit("D"));
    await ok(cancel(F, d.id, "Không còn nhu cầu"));
    expect(await statusOf(d.id)).toBe("cancelled");
  });

  it("phí huỷ > 0: owner trong hạn mức → charges REV_FEE; quản lý vượt hạn mức → 403 APPROVAL_LIMIT_EXCEEDED + yêu cầu duyệt, duyệt xong thì huỷ chạy", async () => {
    const c1 = await confirmedBooking();
    await ok(cancel(O, c1.reservationId, "Huỷ muộn", 100_000));
    const ch = await row(sql<{ kind: string; revenue_account: string; amount: string; stay_id: string }>`
      select kind, revenue_account, amount::text, stay_id from charges where stay_id = ${c1.stay_id}`);
    expect(ch).toMatchObject({ kind: "fee", revenue_account: "REV_FEE", amount: "100000" });

    const c2 = await confirmedBooking();
    const denied = await fails(cancel(M, c2.reservationId, "Huỷ muộn", 100_000));
    expect(denied).toMatchObject({ code: "APPROVAL_LIMIT_EXCEEDED", status: 403 });
    expect(denied.approval_request_id).toEqual(expect.any(String));
    expect(await statusOf(c2.reservationId)).toBe("confirmed");
    await ok(
      run(O, async (ctx) => ({
        data: await decideApproval(ctx, {
          approvalRequestId: denied.approval_request_id as string,
          decision: "approve",
        }),
      })),
    );
    expect(await statusOf(c2.reservationId)).toBe("cancelled");
    const n = await row(
      sql<{ n: number }>`select count(*)::int as n from charges where stay_id = ${c2.stay_id}`,
    );
    expect(n.n).toBe(1);

    const held = await heldBooking();
    expect(await fails(cancel(O, held.reservationId, "x", 50_000))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("S-010 chuyển trạng thái không hợp lệ", () => {
  it("huỷ booking checked_out → 409 INVALID_TRANSITION và audit ghi lần từ chối; xác nhận booking draft → 409", async () => {
    const c = await confirmedBooking();
    await sql`update reservations set status = 'in_house' where id = ${c.reservationId}`.execute(t.admin);
    await sql`update reservations set status = 'checked_out' where id = ${c.reservationId}`.execute(t.admin);
    const key = randomUUID();
    const r = await run(
      F,
      async (ctx) => ({
        data: await cancelReservation(ctx, { reservationId: c.reservationId, reason: "x" }),
      }),
      key,
    );
    expect(r.status).toBe("failed");
    expect((r as { problem: Problem }).problem).toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
      from: "checked_out",
      to: "cancelled",
    });
    const a = await row(
      sql<{
        n: number;
      }>`select count(*)::int as n from audit_events where command_id = ${key} and outcome = 'denied'`,
    );
    expect(a.n).toBe(1);

    const d = await book(F, await newUnit("DR"));
    expect(await fails(confirm(M, d.id, transfer(1, "x")))).toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("CSDL chặn nhảy trạng thái và đổi trạng thái cuối, kể cả ngoài app", async () => {
    const d = await book(F, await newUnit("DB"));
    const e = await pgError(
      sql`update reservations set status = 'in_house' where id = ${d.id}`.execute(t.admin),
    );
    expect(e).toMatchObject({ code: "23514", hint: "INVALID_TRANSITION" });
    await sql`update reservations set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where id = ${d.id}`.execute(
      t.admin,
    );
    expect(
      await pgError(sql`update reservations set status = 'held' where id = ${d.id}`.execute(t.admin)),
    ).toMatchObject({ hint: "INVALID_TRANSITION" });
    expect(
      await pgError(sql`update reservations set cancel_reason = 'đổi' where id = ${d.id}`.execute(t.admin)),
    ).toMatchObject({ hint: "INVALID_TRANSITION" });
    // Khởi tạo: chỉ draft (direct) hoặc in_house (walk_in).
    const bad = await pgError(
      sql`insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${`R-X${randomUUID().slice(0, 6)}`}, 'confirmed', 'direct', ${A.ownerPersonId})`.execute(
        t.admin,
      ),
    );
    expect(bad).toMatchObject({ hint: "INVALID_TRANSITION" });
  });

  it("bảng chuyển ở CSDL khớp bookingMachine/stayMachine ở @hm/domain (mọi cặp trạng thái)", async () => {
    const mismatches: string[] = [];
    for (const from of bookingMachine.states) {
      for (const to of bookingMachine.states) {
        if (from === to) continue;
        const id = randomUUID();
        const outcome = await t.admin
          .transaction()
          .execute(async (trx) => {
            await sql`set local session_replication_role = replica`.execute(trx);
            await sql`insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, cancel_reason,
                                                cancelled_at, confirmed_at, confirmed_without_payment)
                      values (${id}, ${A.orgId}, ${A.propertyId}, ${`R-M${id.slice(0, 8)}`}, ${from}, 'direct', ${A.ownerPersonId}, 'x',
                              now(), now(), true)`.execute(trx);
            await sql`set local session_replication_role = origin`.execute(trx);
            try {
              await sql`update reservations set status = ${to} where id = ${id}`.execute(trx);
              return "allowed";
            } catch (e) {
              return (e as { hint?: string }).hint === "INVALID_TRANSITION"
                ? "blocked"
                : `other:${(e as Error).message}`;
            }
          })
          .catch((e: Error) => `error:${e.message}`);
        if (
          (outcome === "allowed") !== bookingMachine.canTransition(from, to) ||
          outcome.startsWith("other") ||
          outcome.startsWith("error")
        )
          mismatches.push(`booking ${from}→${to}: ${outcome}`);
      }
    }
    for (const from of stayMachine.states) {
      for (const to of stayMachine.states) {
        if (from === to) continue;
        const id = randomUUID();
        // Mỗi hàng một phòng riêng: chỉ mục `uq_stays_unit_in_house` (0026, T-205) chỉ cho một lượt in_house mỗi phòng.
        const unitId = await newUnit("SM");
        // Dựng hàng ở trạng thái `from` (tắt trigger khi chèn), cam kết, rồi thử chuyển ở transaction khác (RI không kiểm lại khoá không đổi).
        await t.admin.transaction().execute(async (trx) => {
          await sql`set local session_replication_role = replica`.execute(trx);
          await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                                       checked_in_at, checked_out_at)
                    values (${id}, ${A.orgId}, ${A.propertyId}, ${randomUUID()}, ${unitId}, ${from}, ${A.ownerPersonId}, now(), now())`.execute(
            trx,
          );
        });
        const outcome = await t.admin
          .transaction()
          .execute(async (trx) => {
            try {
              await sql`update stays set status = ${to} where id = ${id}`.execute(trx);
              return "allowed";
            } catch (e) {
              return (e as { hint?: string }).hint === "INVALID_TRANSITION"
                ? "blocked"
                : `other:${(e as Error).message}`;
            }
          })
          .catch((e: Error) => `error:${e.message}`);
        if (
          (outcome === "allowed") !== stayMachine.canTransition(from, to) ||
          outcome.startsWith("other") ||
          outcome.startsWith("error")
        )
          mismatches.push(`stay ${from}→${to}: ${outcome}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("S-011 no-show", () => {
  const noShow = (id: string, at: string, reason = "Khách không đến", actor: Actor = F) =>
    run(actor, async (ctx) => ({
      data: await markNoShow(ctx, { reservationId: id, reason, now: new Date(at) }),
    }));
  const expectedArrivals = async (unitId: string) =>
    (
      await row(sql<{
        n: number;
      }>`select count(*)::int as n from stays s join reservation_items i on i.id = s.reservation_item_id
                                   where s.status = 'expected' and i.arrival_date = '2026-10-20' and i.unit_id = ${unitId}`)
    ).n;

  it("20/10 18:00 và 21/10 03:59 (trước giờ chốt) → INVALID_TRANSITION; 21/10 04:00 → no_show cả booking và stay, allocation nhả, ứng trước giữ nguyên; lần 3 → 409", async () => {
    const c = await confirmedBooking(500_000);
    const booker = await bookerOf(c.reservationId);
    expect(await expectedArrivals(c.unitId)).toBe(1);

    const t1 = await fails(noShow(c.reservationId, "2026-10-20T11:00:00Z"));
    expect(t1).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    expect(await fails(noShow(c.reservationId, "2026-10-20T20:59:00Z"))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(await statusOf(c.reservationId)).toBe("confirmed");
    expect(await expectedArrivals(c.unitId)).toBe(1);

    const r = await ok(noShow(c.reservationId, "2026-10-20T21:00:00Z"));
    expect(r).toMatchObject({ status: "no_show", stay_ids: [c.stay_id] });
    expect(await statusOf(c.reservationId)).toBe("no_show");
    expect(await stayStatuses(c.reservationId)).toEqual(["no_show"]);
    expect((await allocs(c.unitId))[0]).toMatchObject({ active: false });
    expect(await expectedArrivals(c.unitId)).toBe(0);
    expect(await credit(booker)).toBe(-500_000);
    expect(
      (
        await sql`select 1 from journal_lines where organization_id = ${A.orgId} and account like 'REV\\_%'`.execute(
          t.admin,
        )
      ).rows,
    ).toHaveLength(0);

    expect(await fails(noShow(c.reservationId, "2026-10-21T21:00:00Z"))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    // Lượt ở no_show không quay lại in_house (S-011 lần 3: không check-in từ no_show) — hàng rào ở CSDL.
    expect(
      await pgError(
        sql`update stays set status = 'in_house', checked_in_at = now() where id = ${c.stay_id}`.execute(
          t.admin,
        ),
      ),
    ).toMatchObject({
      hint: "INVALID_TRANSITION",
    });
  });

  it("thiếu lý do → 422; booking held (chưa xác nhận) → INVALID_TRANSITION", async () => {
    const c = await confirmedBooking();
    expect(await fails(noShow(c.reservationId, "2026-10-21T21:00:00Z", " "))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const h = await heldBooking();
    expect(await fails(noShow(h.reservationId, "2026-10-21T21:00:00Z"))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });
});

describe("S-014, Q-10, validate đầu vào", () => {
  const create = (actor: Actor, over: Partial<Parameters<typeof createReservation>[1]> = {}, unit?: string) =>
    run(actor, async (ctx) => ({
      data: await createReservation(ctx, {
        booker: { fullName: "Khách", phone: "0901112223" },
        rooms: [{ unitId: unit as string, guests: 2 }],
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-22",
        ...over,
      }),
    }));

  it("S-014: 3 khách phòng sức chứa 2 → 422 CAPACITY_EXCEEDED, không tạo gì", async () => {
    const u = await newUnit("CAP");
    const before = await row(sql<{ n: number }>`select count(*)::int as n from reservations`);
    expect(await fails(create(F, { rooms: [{ unitId: u, guests: 3 }] }))).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      status: 422,
    });
    expect((await row(sql<{ n: number }>`select count(*)::int as n from reservations`)).n).toBe(before.n);
  });

  it("ngày đi ≤ ngày đến → 422 (departure_date); ngày sai → 422; đêm chưa có giá → RATE_NOT_CONFIGURED", async () => {
    const u = await newUnit("DT");
    for (const [a, d] of [
      ["2026-10-22", "2026-10-22"],
      ["2026-10-23", "2026-10-22"],
    ] as const) {
      const p = await fails(create(F, { arrivalDate: a, departureDate: d }, u));
      expect(p).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(p.errors?.[0]?.field).toBe("departure_date");
    }
    expect(
      await fails(create(F, { arrivalDate: "2026-02-30", departureDate: "2026-03-02" }, u)),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    const noRate = await newUnit("NR", await newRoomType(false));
    expect(await fails(create(F, {}, noRate))).toMatchObject({ code: "RATE_NOT_CONFIGURED", status: 422 });
  });

  it("Q-10: 30 đêm được, 31 đêm → VALIDATION_FAILED STAY_TOO_LONG; SĐT/họ tên người đặt sai → 422", async () => {
    const u = await newUnit("L30");
    const ok30 = await ok(create(F, { arrivalDate: "2026-11-01", departureDate: "2026-12-01" }, u));
    expect(ok30.items[0]?.nights).toBe(30);
    const p = await fails(create(F, { arrivalDate: "2026-11-01", departureDate: "2026-12-02" }, u));
    expect(p.errors?.[0]).toMatchObject({ field: "departure_date", code: "STAY_TOO_LONG" });
    expect(await fails(create(F, { booker: { fullName: "  ", phone: "0901112223" } }, u))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await fails(create(F, { booker: { fullName: "Khách", phone: "abc" } }, u))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("giờ nhận/trả chưa cấu hình → 422 (không giữ phòng được)", async () => {
    await sql`update properties set check_in_time = null, check_out_time = null where id = ${A.propertyId}`.execute(
      t.admin,
    );
    try {
      expect(await fails(create(F, {}, await newUnit("NT")))).toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await sql`update properties set check_in_time = '14:00', check_out_time = '12:00' where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
  });

  it("idempotency: cùng Idempotency-Key tạo đúng một booking; cùng key khác nội dung → IDEMPOTENCY_CONFLICT", async () => {
    const u = await newUnit("IDEM");
    const key = randomUUID();
    const payload = { unit: u };
    const mk = (p: unknown) =>
      executeCommand(
        t.runtime,
        F,
        { command: "reservation.create", idempotencyKey: key, payload: p, correlationId: "c-idem" },
        async (ctx) => ({
          data: await createReservation(ctx, {
            booker: { fullName: "Khách idem", phone: "0901112223" },
            rooms: [{ unitId: u, guests: 1 }],
            arrivalDate: "2026-10-20",
            departureDate: "2026-10-21",
          }),
        }),
      );
    const a = await mk(payload);
    const b = await mk(payload);
    expect(b).toMatchObject({ status: "committed", replayed: true });
    expect((b as { data: { id: string } }).data.id).toBe((a as { data: { id: string } }).data.id);
    expect(
      (await row(sql<{ n: number }>`select count(*)::int as n from reservation_items where unit_id = ${u}`))
        .n,
    ).toBe(1);
    await expect(mk({ unit: "khác" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("ràng buộc CSDL: ngày đi ≤ ngày đến, snapshot sai cấu trúc/tổng, đêm thiếu → từ chối", async () => {
    const d = await book(F, await newUnit("CK"));
    const item = d.items[0];
    const upd = (set: ReturnType<typeof sql>) =>
      pgError(sql`update reservation_items set ${set} where id = ${item?.id as string}`.execute(t.admin));
    expect((await upd(sql`departure_date = arrival_date`)).constraint).toBe("ck_reservation_items_dates");
    expect((await upd(sql`room_total = 1`)).constraint).toBe("ck_reservation_items_nightly"); // tổng ≠ Σ đêm
    // Snapshot sai cấu trúc: chèn dòng mới (không dính trigger giữ giá đêm đã chốt).
    const bad = (j: unknown, total = 1_200_000) =>
      pgError(
        sql`insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date,
                                           departure_date, guests, nightly_prices, room_total)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${d.id}, ${A.unitId}, ${A.roomTypeId}, '2026-10-20', '2026-10-22', 1,
                    ${JSON.stringify(j)}::jsonb, ${total})`.execute(t.admin),
      );
    const cases: [string, unknown, number?][] = [
      ["thiếu đêm", [{ business_date: "2026-10-20", amount: 1_200_000 }]],
      [
        "sai ngày",
        [
          { business_date: "2026-10-21", amount: 600_000 },
          { business_date: "2026-10-22", amount: 600_000 },
        ],
      ],
      [
        "amount là chuỗi",
        [
          { business_date: "2026-10-20", amount: "600000" },
          { business_date: "2026-10-21", amount: 600_000 },
        ],
      ],
      [
        "amount âm",
        [
          { business_date: "2026-10-20", amount: -1 },
          { business_date: "2026-10-21", amount: 1_200_001 },
        ],
      ],
      [
        "amount thập phân",
        [
          { business_date: "2026-10-20", amount: 600000.5 },
          { business_date: "2026-10-21", amount: 599999.5 },
        ],
      ],
      ["không phải mảng", {}],
      [
        "tổng lệch",
        [
          { business_date: "2026-10-20", amount: 600_000 },
          { business_date: "2026-10-21", amount: 600_000 },
        ],
        1_200_001,
      ],
    ];
    for (const [name, j, total] of cases) {
      expect((await bad(j, total)).constraint, name).toBe("ck_reservation_items_nightly");
    }
  });
});

describe("S-025 quyền và tenant (INV-G1)", () => {
  it("người tổ chức khác: get/hold/confirm/cancel/create → 404; buồng phòng get → 404; kế toán/buồng phòng không tạo booking (403)", async () => {
    const h = await heldBooking();
    await expect(getReservation(t.runtime, OB, h.reservationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(getReservation(t.runtime, H, h.reservationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect((await getReservation(t.runtime, K, h.reservationId)).id).toBe(h.reservationId);
    expect((await getReservation(t.runtime, F, h.reservationId)).booker?.full_name).toBe("Nguyễn Văn A");
    expect(await fails(hold(OB, h.reservationId))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await fails(confirm(OB, h.reservationId))).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await fails(
        run(OB, async (ctx) => ({
          data: await cancelReservation(ctx, { reservationId: h.reservationId, reason: "x" }),
        })),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    const create = (actor: Actor, unit: string) =>
      run(actor, async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "K", phone: "0901112223" },
          rooms: [{ unitId: unit, guests: 1 }],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-21",
        }),
      }));
    expect(await fails(create(OB, h.unitId))).toMatchObject({ code: "NOT_FOUND" });
    for (const actor of [K, H])
      expect(await fails(create(actor, h.unitId))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(hold(K, h.reservationId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await fails(hold(H, h.reservationId))).toMatchObject({ code: "NOT_FOUND" });
    await expect(listReservations(t.runtime, H, { propertyId: A.propertyId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("reservation.get / reservation.list và HTTP", () => {
  async function http(name: string, body: unknown, as: string, key: string = randomUUID()) {
    const def = COMMANDS[name];
    if (!def) throw new Error(`thiếu lệnh ${name}`);
    const res = await handleCommand(
      def,
      new Request(`http://local.test/api/v1/${name.replace(".", "/")}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-test-user": users[as] as string,
          "x-org-id": A.orgId,
        },
        body: JSON.stringify(body),
      }),
      deps,
    );
    // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
    return { status: res.status, body: (await res.json()) as any };
  }
  async function httpGet(name: string, params: Record<string, string>, as: string) {
    const def = QUERIES[name];
    if (!def) throw new Error(`thiếu query ${name}`);
    const res = await handleQuery(
      def,
      new Request(`http://local.test/api/v1/${name.replace(".", "/")}?${new URLSearchParams(params)}`, {
        headers: { "x-test-user": users[as] as string, "x-org-id": A.orgId },
      }),
      deps,
    );
    // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
    return { status: res.status, body: (await res.json()) as any };
  }

  it("create → hold → confirm (không tiền bị từ chối 422) → get qua HTTP; lỗi nghiệp vụ trả problem+json đúng mã", async () => {
    const unit = await newUnit("HTTP");
    const c = await http(
      "reservation.create",
      {
        booker: { full_name: "Khách HTTP", phone: "0908887776" },
        unit_id: unit,
        guests: 2,
        arrival_date: "2026-10-20",
        departure_date: "2026-10-22",
      },
      "front_desk",
    );
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: "draft", room_total: 1_200_000 });
    const id = c.body.data.id as string;
    expect((await http("reservation.hold", { reservation_id: id }, "front_desk")).status).toBe(201);
    const bad = await http("reservation.confirm", { reservation_id: id }, "front_desk");
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("EVIDENCE_REQUIRED");
    const strict = await http(
      "reservation.create",
      {
        booker: { full_name: "X", phone: "0908887776" },
        arrival_date: "2026-10-20",
        departure_date: "2026-10-22",
      },
      "front_desk",
    );
    expect(strict.status).toBe(422); // thiếu unit_id/rooms
    const g = await httpGet("reservation.get", { reservation_id: id }, "front_desk");
    expect(g.status).toBe(200);
    expect(g.body.data).toMatchObject({ id, status: "held", booker: { full_name: "Khách HTTP" } });
    expect((await httpGet("reservation.get", { reservation_id: id }, "housekeeping")).status).toBe(404);
  });

  it("list: lọc theo cơ sở/khoảng ngày/trạng thái, phân trang keyset ổn định", async () => {
    const org = await seedOrg(t.admin, "KS list", "hotel");
    const unit = randomUUID();
    await sql`update properties set check_in_time = '14:00', check_out_time = '12:00' where id = ${org.propertyId}`.execute(
      t.admin,
    );
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code) values (${unit}, ${org.orgId}, ${org.propertyId}, ${org.floorId}, ${org.roomTypeId}, 'L1')`.execute(
      t.admin,
    );
    const owner = await resolveActor(t.runtime, {
      authUserId: org.ownerAuthUserId,
      orgId: org.orgId,
      twoFactorEnabled: true,
    });
    await ok(
      run(owner, async (ctx) => ({
        data: await setRatePlan(ctx, {
          roomTypeId: org.roomTypeId,
          weekdayPrice: 500_000,
          weekendPrice: 500_000,
          effectiveFrom: "2026-01-01",
        }),
      })),
    );
    const ids: string[] = [];
    for (const [a, d] of [
      ["2026-11-01", "2026-11-03"],
      ["2026-11-05", "2026-11-06"],
      ["2026-11-10", "2026-11-12"],
    ]) {
      const r = await ok(
        run(owner, async (ctx) => ({
          data: await createReservation(ctx, {
            booker: { fullName: "K", phone: "0901112223" },
            rooms: [{ unitId: unit, guests: 1 }],
            arrivalDate: a as string,
            departureDate: d as string,
          }),
        })),
      );
      ids.push(r.id);
    }
    await ok(
      run(owner, async (ctx) => ({
        data: await holdReservation(ctx, { reservationId: ids[1] as string, now: NOW }),
      })),
    );
    const all = await listReservations(t.runtime, owner, { propertyId: org.propertyId });
    expect(all.items.map((i) => i.id)).toEqual(ids);
    expect(all.items[0]).toMatchObject({
      arrival_date: "2026-11-01",
      departure_date: "2026-11-03",
      room_total: 1_000_000,
      unit_ids: [unit],
    });
    expect(
      (
        await listReservations(t.runtime, owner, { propertyId: org.propertyId, statuses: ["held"] })
      ).items.map((i) => i.id),
    ).toEqual([ids[1]]);
    expect(
      (
        await listReservations(t.runtime, owner, {
          propertyId: org.propertyId,
          from: "2026-11-03",
          to: "2026-11-10",
        })
      ).items.map((i) => i.id),
    ).toEqual([ids[1]]);
    const p1 = await listReservations(t.runtime, owner, { propertyId: org.propertyId, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await listReservations(t.runtime, owner, {
      propertyId: org.propertyId,
      limit: 2,
      cursor: p1.next_cursor as string,
    });
    expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual(ids);
    expect(p2.next_cursor).toBeNull();
    await expect(
      listReservations(t.runtime, owner, { propertyId: org.propertyId, statuses: ["bogus"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Cơ sở khác tổ chức → 404.
    await expect(listReservations(t.runtime, O, { propertyId: org.propertyId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("SPEC-inventory S-018 gia hạn đụng booking đã xác nhận (INV-I4)", () => {
  it("resizeAllocation kéo dài đụng booking confirmed → 409 ROOM_UNAVAILABLE + exception_id (EXTENSION_CONFLICT); cả hai bên giữ nguyên; gọi lại không nhân đôi", async () => {
    const c = await confirmedBooking(500_000, "2026-10-20", "2026-10-22"); // booking: [20/10 07:00Z, 22/10 05:00Z)
    // s1 đang ở đến 20/10 05:00Z (12:00 VN) — kéo dài sang 21/10 đụng booking.
    const s1 = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, during)
              values (${s1}, ${A.orgId}, ${A.propertyId}, ${c.unitId}, 'stay', 'stay',
                      tstzrange('2026-10-18T07:00:00Z', '2026-10-20T05:00:00Z', '[)'))`.execute(t.admin);
    const extend = (key?: string) =>
      run(
        O,
        async (ctx) => ({
          data: await resizeAllocation(ctx, {
            allocationId: s1,
            end: new Date("2026-10-21T05:00:00Z"),
            conflict: "extension",
            now: NOW,
          }),
        }),
        key,
      );
    const p = (await fails(extend())) as Problem & { exception_id?: string };
    expect(p).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(p.exception_id).toEqual(expect.any(String));
    const ex = await sql<{
      id: string;
      type: string;
      allocation_id: string;
      related_allocation_id: string;
      status: string;
    }>`
      select id, type, allocation_id, related_allocation_id, status from exceptions where allocation_id = ${s1}`.execute(
      t.admin,
    );
    expect(ex.rows).toHaveLength(1);
    expect(ex.rows[0]).toMatchObject({
      id: p.exception_id,
      type: "EXTENSION_CONFLICT",
      status: "open",
      related_allocation_id: (await allocs(c.unitId)).find((a) => a.source_id === c.stay_id)?.id,
    });
    const mine = (await allocs(c.unitId)).find((a) => a.id === s1);
    expect(iso(mine?.hi as Date)).toBe("2026-10-20T05:00:00.000Z"); // s1 giữ nguyên
    const booking = (await allocs(c.unitId)).find((a) => a.source_id === c.stay_id);
    expect(booking).toMatchObject({ active: true, kind: "stay" });
    expect(iso(booking?.lo as Date)).toBe("2026-10-20T07:00:00.000Z");
    expect(await statusOf(c.reservationId)).toBe("confirmed");
    const again = (await fails(extend())) as Problem & { exception_id?: string };
    expect(again.exception_id).toBe(p.exception_id);
    expect(
      (await sql`select 1 from exceptions where allocation_id = ${s1}`.execute(t.admin)).rows,
    ).toHaveLength(1);
    // Kéo dài không đụng ai thì được và không tạo ngoại lệ.
    const ok1 = await ok(
      run(O, async (ctx) => ({
        data: await resizeAllocation(ctx, {
          allocationId: s1,
          end: new Date("2026-10-20T06:00:00Z"),
          conflict: "extension",
          now: NOW,
        }),
      })),
    );
    expect(iso(ok1.to.end as Date)).toBe("2026-10-20T06:00:00.000Z");
  });

  it("giữ chỗ nguồn booking không nhả/xác nhận trơn qua inventory (đồng bộ booking)", async () => {
    const h = await heldBooking();
    const a = (await allocs(h.unitId))[0];
    const { releaseHold, confirmHold } = await import("../inventory/inventory.ts");
    expect(
      await fails(run(O, async (ctx) => ({ data: await releaseHold(ctx, a?.id as string, NOW, "x") }))),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(
      await fails(run(O, async (ctx) => ({ data: await confirmHold(ctx, a?.id as string, "stay", NOW) }))),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await allocs(h.unitId))[0]).toMatchObject({ kind: "hold", active: true });
  });
});
