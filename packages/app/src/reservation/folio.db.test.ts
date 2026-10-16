// PLAN đợt 3 T-206 — folio và trả phòng trên Postgres thật (SPEC-reservation-stay S-017…S-020, S-022…S-024, S-026, S-027;
// ERD §5.5; INV-F1, INV-F2, INV-F3b, INV-F5, INV-G4). Cơ sở `hotel`: nhận 14:00 / trả 12:00, giờ chốt ngày 04:00, UTC+7 (fixture SPEC).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { decideApproval, requestApproval } from "../approvals/approvals.ts";
import { receiveDeposit, requestDeduction } from "../deposits/deposits.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { allocatePayment, confirmPayment, recordPayment } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { closeShift, openShift } from "../shifts/shifts.ts";
import { checkOut, getFolio, postCharge, voidCharge } from "./folio.ts";
import { setRatePlan } from "./rates.ts";
import { confirmReservation, createReservation, holdReservation } from "./reservation.ts";
import { checkIn } from "./stay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let L: Actor;
let L2: Actor;
let F3: Actor;
let K: Actor;
let H: Actor;
let OB: Actor;
let RA: string;
let deps: HttpDeps;
const users: Record<string, string> = {};

type Problem = {
  code: string;
  status: number;
  errors?: { field: string; code: string }[];
  items?: { balance?: number }[];
  approval_request_id?: string;
};

const NOW = new Date("2026-10-16T03:00:00Z");
const IN = new Date("2026-10-20T08:00:00Z"); // 20/10 15:00 giờ VN
const MINIBAR_AT = new Date("2026-10-21T10:00:00Z"); // 21/10 17:00 giờ VN
const LATE_AT = new Date("2026-10-22T03:15:00Z"); // 22/10 10:15 giờ VN
const OUT = new Date("2026-10-22T03:30:00Z"); // 22/10 10:30 giờ VN
const NIGHT_OUT = new Date("2026-10-22T17:40:00Z"); // 23/10 00:40 giờ VN (trước giờ chốt 04:00 ⇒ ngày kinh doanh 22/10)
const DUE = "2026-10-30";

async function member(role: string, label: string, org: SeededOrg = A): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${label}+${randomUUID().slice(0, 6)}@example.test`);
  users[label] = user;
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${label})`.execute(
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
    { command: "folio.test", idempotencyKey: key, payload: { key }, correlationId: "c-folio-test" },
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
  return r.problem as unknown as Problem;
}

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

async function pgError(p: PromiseLike<unknown>): Promise<{ code?: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; hint?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

async function rows<T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await q.execute(t.admin)).rows;
}
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>) =>
  (await rows(q))[0] as T;

async function newUnit(code: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, ${`${code}-${id.slice(0, 4)}`})`.execute(
    t.admin,
  );
  return id;
}

const GUEST = {
  fullName: "Nguyễn Văn A",
  phone: "0901234567",
  document: { type: "cccd" as const, number: "079123456789" },
};

interface Scenario {
  reservationId: string;
  stayId: string;
  unitId: string;
  bookerId: string;
  advancePaymentId: string | null;
  /** Σ tiền phòng của lượt ở (đồng). */
  roomTotal: number;
}

/**
 * Booking 2 đêm × 600.000 đã nhận phòng (20/10→22/10). `advance`: ứng trước chuyển khoản do quản lý xác nhận (S-005);
 * `extras`: minibar 80.000 (21/10) + phụ thu trả muộn 150.000 (22/10) ⇒ folio 1.430.000 (S-017).
 */
async function scenario(
  opts: { advance?: number; extras?: boolean; arrival?: string; departure?: string } = {},
): Promise<Scenario> {
  const unitId = await newUnit("F");
  const r = await ok(
    run(F, async (ctx) => ({
      data: await createReservation(ctx, {
        booker: { fullName: "Khách folio", phone: "0912345678" },
        rooms: [{ unitId, guests: 2 }],
        arrivalDate: opts.arrival ?? "2026-10-20",
        departureDate: opts.departure ?? "2026-10-22",
      }),
    })),
  );
  await ok(run(F, async (ctx) => ({ data: await holdReservation(ctx, { reservationId: r.id, now: NOW }) })));
  const advance = opts.advance ?? 0;
  const c = await ok(
    run(M, async (ctx) => ({
      data: await confirmReservation(ctx, {
        reservationId: r.id,
        now: NOW,
        ...(advance > 0
          ? {
              payment: {
                kind: "advance" as const,
                method: "bank_transfer" as const,
                amount: advance,
                receivingAccountId: RA,
                bankTxn: {
                  ref: `FT${randomUUID().slice(0, 10)}`,
                  occurredAt: "2026-10-16T02:30:00Z",
                  description: "Ứng trước đặt phòng",
                },
              },
            }
          : {}),
      }),
    })),
  );
  await ok(
    run(F, async (ctx) => ({
      data: await checkIn(ctx, { reservationId: r.id, guests: [GUEST], now: IN }),
    })),
  );
  const booker = await one(
    sql<{ b: string }>`select booker_person_id as b from reservations where id = ${r.id}`,
  );
  const adv =
    advance > 0
      ? await one(sql<{ id: string }>`select id from payments where reservation_id = ${r.id}`)
      : null;
  const s: Scenario = {
    reservationId: r.id,
    stayId: c.stay_id,
    unitId,
    bookerId: booker.b,
    advancePaymentId: adv?.id ?? null,
    roomTotal: 1_200_000,
  };
  if (opts.extras) {
    await ok(post(F, s.stayId, "service", "Minibar", 80_000, MINIBAR_AT));
    await ok(post(F, s.stayId, "fee", "Phụ thu trả muộn", 150_000, LATE_AT));
  }
  return s;
}

/**
 * Lượt ở theo GIỜ THẬT (đêm nay): dành cho test đi qua HTTP, nơi không truyền được `now` giả. Đến hôm nay (ngày kinh doanh theo CSDL),
 * đi hôm sau, nhận phòng ngay.
 */
async function realScenario(): Promise<Scenario> {
  const now = new Date();
  const today = (
    await one(sql<{ d: string }>`select app.business_date(${A.orgId}, ${A.propertyId})::text as d`)
  ).d;
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const unitId = await newUnit("R");
  const r = await ok(
    run(F, async (ctx) => ({
      data: await createReservation(ctx, {
        booker: { fullName: "Khách giờ thật", phone: "0912345670" },
        rooms: [{ unitId, guests: 2 }],
        arrivalDate: today,
        departureDate: next.toISOString().slice(0, 10),
      }),
    })),
  );
  await ok(run(F, async (ctx) => ({ data: await holdReservation(ctx, { reservationId: r.id }) })));
  const c = await ok(
    run(M, async (ctx) => ({ data: await confirmReservation(ctx, { reservationId: r.id }) })),
  );
  await ok(
    run(F, async (ctx) => ({
      data: await checkIn(ctx, { reservationId: r.id, guests: [GUEST], now }),
    })),
  );
  const booker = await one(
    sql<{ b: string }>`select booker_person_id as b from reservations where id = ${r.id}`,
  );
  const room = await one(
    sql<{
      n: string;
    }>`select sum(amount)::text as n from charges where stay_id = ${c.stay_id} and kind = 'room'`,
  );
  return {
    reservationId: r.id,
    stayId: c.stay_id,
    unitId,
    bookerId: booker.b,
    advancePaymentId: null,
    roomTotal: Number(room.n),
  };
}

const post = (
  actor: Actor,
  stayId: string,
  kind: "service" | "fee",
  description: string,
  unitPrice: number,
  now: Date,
  extra: { quantity?: number; businessDate?: string } = {},
  key?: string,
) =>
  run(
    actor,
    async (ctx) => ({ data: await postCharge(ctx, { stayId, kind, description, unitPrice, now, ...extra }) }),
    key,
  );

const out = (
  actor: Actor,
  stayId: string,
  extra: Partial<Omit<Parameters<typeof checkOut>[1], "stayId" | "now">> = {},
  now: Date = OUT,
  key?: string,
) => run(actor, async (ctx) => ({ data: await checkOut(ctx, { stayId, now, ...extra }) }), key);

/** Cọc bảo đảm nhận bằng tiền mặt (xác nhận bởi người nhận trong ca của mình). */
async function addDeposit(actor: Actor, s: Scenario, amount: number): Promise<string> {
  const d = await ok(
    run(actor, async (ctx) => {
      const r = await receiveDeposit(ctx, {
        propertyId: A.propertyId,
        payerPersonId: s.bookerId,
        amount,
        method: "cash",
        reservationId: s.reservationId,
      });
      await confirmPayment(ctx, { paymentId: r.paymentId });
      return { data: r };
    }),
  );
  return d.depositId;
}

const stayRow = (id: string) =>
  one(
    sql<{
      status: string;
      checked_out_at: Date | null;
      debtor_person_id: string | null;
      debt_due_date: string | null;
    }>`select status, checked_out_at, debtor_person_id, debt_due_date::text from stays where id = ${id}`,
  );
const resStatus = async (id: string) =>
  (await one(sql<{ s: string }>`select status as s from reservations where id = ${id}`)).s;
const folioOf = (stayId: string) =>
  rows(
    sql<{
      id: string;
      kind: string;
      total: string;
      allocated_total: string;
      open_amount: string;
      business_date: string;
      payer_person_id: string;
      due_on: string | null;
    }>`select id, kind, total::text, allocated_total::text, open_amount::text, business_date::text, payer_person_id, due_on::text
       from invoices where stay_id = ${stayId}`,
  );
const count = async (table: string, where = sql`true`) =>
  (
    await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${A.orgId} and ${where}`,
    )
  ).n;
const linesOfInvoiceEntry = (invoiceId: string) =>
  rows(
    sql<{ account: string; debit: string; credit: string; business_date: string }>`
      select l.account, l.debit::text, l.credit::text, e.business_date::text
      from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.source_doc_type = 'invoice' and e.source_doc_id = ${invoiceId} and e.entry_type = 'invoice_issued'
      order by l.line_no`,
  );

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS folio", "hotel");
  B = await seedOrg(t.admin, "KS khác", "hotel");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00',
            settings = ${JSON.stringify({ reservation: { confirm_without_payment: true } })}::jsonb
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
  M = await member("manager", "manager");
  F = await member("front_desk", "front_desk");
  L = await member("front_desk", "lễ tân L");
  L2 = await member("front_desk", "lễ tân L2");
  F3 = await member("front_desk", "lễ tân chưa mở ca");
  K = await member("accountant", "accountant");
  H = await member("housekeeping", "housekeeping");
  RA = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${RA}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'KHACH SAN A')`.execute(
    t.admin,
  );
  await ok(
    run(O, async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    })),
  );
  // Lễ tân F mở ca (tiền đầu ca 0); L mở ca với tiền đầu ca 2.000.000 như fixture S-026; L2 sẽ mở ca ở test cần.
  await ok(
    run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
  );
  await ok(
    run(L, async (ctx) => ({
      data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 2_000_000 }),
    })),
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

describe("S-017 folio ví dụ bắt buộc: 1.430.000 đ, ứng trước 500.000 đ, còn 930.000 đ", () => {
  it("phát hành phiếu folio + bút toán đúng từng đồng; phân bổ ứng trước; cọc/ứng trước không lẫn", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const before = await folioOf(s.stayId);
    expect(before).toHaveLength(0); // chưa trả phòng ⇒ chưa có phiếu
    const preview = await getFolio(t.runtime, F, s.stayId);
    expect(preview).toMatchObject({
      charges_total: 1_430_000,
      advance_available: 500_000,
      balance: 930_000,
      invoice: null,
    });

    const r = await ok(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    expect(r).toMatchObject({
      status: "checked_out",
      folio_total: 1_430_000,
      advance_applied: 500_000,
      paid: 0,
      balance: 930_000,
      debtor_person_id: s.bookerId,
      due_date: DUE,
      business_date: "2026-10-22",
      deposit_refund_status: null,
    });
    // Phiếu: kind folio, stay_id, bất biến, tổng 1.430.000, đã phân bổ 500.000 ⇒ còn 930.000; người nợ + hạn trả.
    const inv = await folioOf(s.stayId);
    expect(inv).toEqual([
      expect.objectContaining({
        id: r.invoice_id,
        kind: "folio",
        total: "1430000",
        allocated_total: "500000",
        open_amount: "930000",
        payer_person_id: s.bookerId,
        due_on: DUE,
        business_date: "2026-10-22",
      }),
    ]);
    // Bút toán phát hành: Nợ AR 1.430.000 / Có REV_ROOM 1.200.000 (2 đêm), REV_SERVICE 80.000, REV_FEE 150.000.
    const lines = await linesOfInvoiceEntry(r.invoice_id as string);
    expect(lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["AR", "1430000", "0"],
      ["REV_ROOM", "0", "600000"],
      ["REV_ROOM", "0", "600000"],
      ["REV_SERVICE", "0", "80000"],
      ["REV_FEE", "0", "150000"],
    ]);
    const sum = (acc: string, side: "debit" | "credit") =>
      lines.filter((l) => l.account === acc).reduce((n, l) => n + Number(l[side]), 0);
    expect(sum("REV_ROOM", "credit")).toBe(1_200_000);
    expect(sum("AR", "debit")).toBe(1_430_000);
    // Phân bổ ứng trước: Nợ CUSTOMER_CREDIT 500.000 (người đặt) / Có AR 500.000 (phiếu).
    const alloc = await rows(
      sql<{
        account: string;
        debit: string;
        credit: string;
        person_id: string | null;
        invoice_id: string | null;
      }>`
        select l.account, l.debit::text, l.credit::text, l.person_id, l.invoice_id
        from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.entry_type = 'payment_allocated' and e.source_doc_id = ${s.advancePaymentId} order by l.line_no`,
    );
    expect(alloc).toEqual([
      { account: "CUSTOMER_CREDIT", debit: "500000", credit: "0", person_id: s.bookerId, invoice_id: null },
      { account: "AR", debit: "0", credit: "500000", person_id: s.bookerId, invoice_id: r.invoice_id },
    ]);
    // Cân đối toàn sổ của phiếu + ứng trước chỉ còn 930.000 trên AR; CUSTOMER_CREDIT của người đặt = 0; không REV_* ngoài 3 loại.
    const ar = await one(
      sql<{
        b: string;
      }>`select coalesce(sum(debit - credit), 0)::text as b from journal_lines where invoice_id = ${r.invoice_id} and account = 'AR'`,
    );
    expect(ar.b).toBe("930000");
    const cc = await one(
      sql<{ b: string }>`select coalesce(sum(credit - debit), 0)::text as b from journal_lines
                         where account = 'CUSTOMER_CREDIT' and person_id = ${s.bookerId}`,
    );
    expect(cc.b).toBe("0");
    // Mỗi charge đúng một dòng phiếu (không ghi hai lần): 4 charge còn hiệu lực = 4 dòng + 1 dòng minibar... = 4.
    expect(await count("invoice_lines", sql`invoice_id = ${r.invoice_id}`)).toBe(4);
    expect(await count("charges", sql`stay_id = ${s.stayId} and voided_at is null`)).toBe(4);
    // Folio sau check-out: còn 930.000 (S-017), ứng trước đã dùng, người dùng thấy cọc riêng (không có).
    expect(await getFolio(t.runtime, M, s.stayId)).toMatchObject({
      balance: 930_000,
      advance_available: 0,
      invoice: { total: 1_430_000, allocated_total: 500_000, open_amount: 930_000 },
      deposits: [],
    });
  });

  it("S-020: stay checked_out (UTC), booking checked_out, allocation kết thúc đúng giờ trả, phòng dirty, sự kiện stay.checked_out", async () => {
    const s = await scenario({ advance: 1_200_000 });
    const r = await ok(out(F, s.stayId));
    expect(r.balance).toBe(0);
    const st = await stayRow(s.stayId);
    expect(st.status).toBe("checked_out");
    expect(new Date(st.checked_out_at as Date).toISOString()).toBe(OUT.toISOString());
    expect(st.debtor_person_id).toBeNull();
    expect(await resStatus(s.reservationId)).toBe("checked_out");
    const al = await one(
      sql<{ hi: Date; active: boolean }>`select upper(during) as hi, active from allocations
                                         where source_type = 'stay' and source_id = ${s.stayId}`,
    );
    expect(new Date(al.hi).toISOString()).toBe(OUT.toISOString());
    expect(
      (await one(sql<{ h: string }>`select housekeeping_status as h from units where id = ${s.unitId}`)).h,
    ).toBe("dirty");
    const ev = await rows(
      sql<{
        payload: Record<string, unknown>;
      }>`select payload from outbox where event_type = 'stay.checked_out' and aggregate_id = ${s.stayId}`,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({
      stay_id: s.stayId,
      unit_id: s.unitId,
      invoice_id: r.invoice_id,
      balance: 0,
    });
    // Module này chỉ phát sự kiện; bảng việc dọn thuộc T-209.
  });

  it("trả muộn hơn dự kiến: KHÔNG kéo dài allocation hồi tố; giờ thực lưu ở lượt ở", async () => {
    const s = await scenario({ advance: 1_200_000 });
    await ok(out(F, s.stayId, {}, new Date("2026-10-22T07:00:00Z"))); // 14:00 giờ VN, quá 12:00
    const al = await one(
      sql<{
        hi: Date;
      }>`select upper(during) as hi from allocations where source_type = 'stay' and source_id = ${s.stayId}`,
    );
    expect(new Date(al.hi).toISOString()).toBe("2026-10-22T05:00:00.000Z");
    expect(new Date((await stayRow(s.stayId)).checked_out_at as Date).toISOString()).toBe(
      "2026-10-22T07:00:00.000Z",
    );
  });
});

describe("S-018 không ghi dịch vụ hai lần", () => {
  it("cùng Idempotency-Key → một charge; cùng key khác số tiền → IDEMPOTENCY_CONFLICT; key khác = khoản hợp lệ thứ hai; huỷ có lý do", async () => {
    const s = await realScenario();
    const key = randomUUID();
    const body = { stay_id: s.stayId, kind: "service", description: "Minibar", unit_price: 80_000 };
    const a = await http("stay.postCharge", body, "front_desk", key);
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ kind: "service", revenue_account: "REV_SERVICE", amount: 80_000 });
    const b = await http("stay.postCharge", body, "front_desk", key);
    expect(b.body.data.charge_id).toBe(a.body.data.charge_id);
    expect(await count("charges", sql`stay_id = ${s.stayId} and kind = 'service'`)).toBe(1);
    const c = await http("stay.postCharge", { ...body, unit_price: 90_000 }, "front_desk", key);
    expect(c).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(await count("charges", sql`stay_id = ${s.stayId} and kind = 'service'`)).toBe(1);
    // Hai lần bấm với key khác nhau = hai khoản hợp lệ; số lượng nhân đơn giá.
    const d = await http("stay.postCharge", { ...body, quantity: 2 }, "front_desk", randomUUID());
    expect(d.body.data).toMatchObject({ quantity: 2, unit_price: 80_000, amount: 160_000 });
    expect(await count("charges", sql`stay_id = ${s.stayId} and kind = 'service'`)).toBe(2);
    // Huỷ khoản thứ hai (trước phát hành) có lý do; tổng folio chỉ còn khoản đầu.
    const v = await http(
      "stay.voidCharge",
      { charge_id: d.body.data.charge_id, reason: "Bấm nhầm" },
      "front_desk",
      randomUUID(),
    );
    expect(v).toMatchObject({ status: 200, body: { data: { voided: true } } });
    const fol = await getFolio(t.runtime, F, s.stayId);
    expect(fol.charges_total).toBe(s.roomTotal + 80_000);
    // Huỷ lần hai → INVALID_TRANSITION; không lý do → 422; tiền phòng không huỷ ở đây.
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await voidCharge(ctx, { chargeId: d.body.data.charge_id, reason: "x" }),
        })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await voidCharge(ctx, { chargeId: a.body.data.charge_id, reason: "  " }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    const room = await one(
      sql<{ id: string }>`select id from charges where stay_id = ${s.stayId} and kind = 'room' limit 1`,
    );
    expect(
      await fails(
        run(F, async (ctx) => ({ data: await voidCharge(ctx, { chargeId: room.id, reason: "x" }) })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    // Dữ liệu sai: giá 0/âm/thập phân, loại giảm giá, mô tả rỗng → 422.
    for (const bad of [
      { unitPrice: 0 },
      { unitPrice: -5 },
      { unitPrice: 10.5 },
      { unitPrice: 80_000, quantity: 0 },
      { unitPrice: 80_000, quantity: 1001 },
    ]) {
      expect(
        await fails(
          run(F, async (ctx) => ({
            data: await postCharge(ctx, {
              stayId: s.stayId,
              kind: "service",
              description: "x",
              now: MINIBAR_AT,
              ...bad,
            }),
          })),
        ),
      ).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(await fails(post(F, s.stayId, "service", "  ", 1000, MINIBAR_AT))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await postCharge(ctx, {
            stayId: s.stayId,
            kind: "discount" as never,
            description: "Giảm",
            unitPrice: 1000,
            now: MINIBAR_AT,
          }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("quyền: kế toán 403, buồng phòng 404, tổ chức khác 404; ngày tương lai/trước ngày đến → 422; stay chưa nhận phòng → INVALID_TRANSITION", async () => {
    const s = await scenario();
    expect(await fails(post(K, s.stayId, "service", "Minibar", 1000, MINIBAR_AT))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fails(post(H, s.stayId, "service", "Minibar", 1000, MINIBAR_AT))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await fails(post(OB, s.stayId, "service", "Minibar", 1000, MINIBAR_AT))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await fails(post(F, s.stayId, "service", "Minibar", 1000, MINIBAR_AT, { businessDate: "2026-10-23" })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await fails(post(F, s.stayId, "service", "Minibar", 1000, MINIBAR_AT, { businessDate: "2026-10-19" })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await fails(post(F, randomUUID(), "service", "Minibar", 1000, MINIBAR_AT))).toMatchObject({
      code: "NOT_FOUND",
    });
    const unit = await newUnit("E");
    const r = await ok(
      run(F, async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "Chưa đến", phone: "0912345679" },
          rooms: [{ unitId: unit, guests: 1 }],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-21",
        }),
      })),
    );
    await ok(
      run(F, async (ctx) => ({ data: await holdReservation(ctx, { reservationId: r.id, now: NOW }) })),
    );
    const c = await ok(
      run(M, async (ctx) => ({ data: await confirmReservation(ctx, { reservationId: r.id, now: NOW }) })),
    );
    expect(await fails(post(F, c.stay_id, "service", "Minibar", 1000, MINIBAR_AT))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(await fails(out(F, c.stay_id))).toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("S-019 check-out còn nợ cần quản lý cho phép", () => {
  it("lễ tân không thu đủ → 409 OUTSTANDING_BALANCE (không phiếu/không check-out); có duyệt của quản lý + người nợ + hạn → check-out, AR còn 930.000", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const p1 = await fails(out(F, s.stayId));
    expect(p1).toMatchObject({ code: "OUTSTANDING_BALANCE", status: 409, items: [{ balance: 930_000 }] });
    expect((await stayRow(s.stayId)).status).toBe("in_house");
    expect(await folioOf(s.stayId)).toHaveLength(0);
    expect(await count("payment_allocations", sql`payment_id = ${s.advancePaymentId}`)).toBe(0);
    expect(await resStatus(s.reservationId)).toBe("in_house");

    // Thiếu người nợ hoặc hạn → 422; allow_balance không approval_id (lễ tân không có quyền cho nợ) → vẫn OUTSTANDING_BALANCE.
    expect(
      await fails(out(F, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: "" } })),
    ).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ field: "allow_balance.due_date" }] });
    expect(
      await fails(out(F, s.stayId, { allowBalance: { debtorPersonId: "x", dueDate: DUE } })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await fails(out(F, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: "2026-10-21" } })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await fails(out(F, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } })),
    ).toMatchObject({ code: "OUTSTANDING_BALANCE" });

    // Lễ tân lập yêu cầu; chưa duyệt thì chưa dùng được; yêu cầu cho lượt ở khác/số tiền thấp hơn cũng không dùng được.
    const req = await ok(
      run(F, async (ctx) => ({
        data: await requestApproval(ctx, {
          kind: "allow_balance",
          amount: 930_000,
          reason: "Khách hẹn chuyển khoản",
          propertyId: A.propertyId,
          subjectType: "stay",
          subjectId: s.stayId,
        }),
      })),
    );
    const useApproval = (approvalId: string) =>
      out(F, s.stayId, { allowBalance: { approvalId, debtorPersonId: s.bookerId, dueDate: DUE } });
    expect(await fails(useApproval(req.approvalRequestId))).toMatchObject({ code: "OUTSTANDING_BALANCE" });
    // Lễ tân tự duyệt: không có quyền cho nợ → 403.
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
        })),
      ),
    ).toMatchObject({ status: 403 });
    const other = await scenario({ extras: true });
    const reqOther = await ok(
      run(F, async (ctx) => ({
        data: await requestApproval(ctx, {
          kind: "allow_balance",
          amount: 1_430_000,
          reason: "Khách khác",
          propertyId: A.propertyId,
          subjectType: "stay",
          subjectId: other.stayId,
        }),
      })),
    );
    await ok(
      run(M, async (ctx) => ({
        data: await decideApproval(ctx, {
          approvalRequestId: reqOther.approvalRequestId,
          decision: "approve",
        }),
      })),
    );
    expect(await fails(useApproval(reqOther.approvalRequestId))).toMatchObject({
      code: "OUTSTANDING_BALANCE",
    });
    const reqLow = await ok(
      run(F, async (ctx) => ({
        data: await requestApproval(ctx, {
          kind: "allow_balance",
          amount: 100_000,
          reason: "Số tiền thấp",
          propertyId: A.propertyId,
          subjectType: "stay",
          subjectId: s.stayId,
        }),
      })),
    );
    await ok(
      run(M, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId: reqLow.approvalRequestId, decision: "approve" }),
      })),
    );
    expect(await fails(useApproval(reqLow.approvalRequestId))).toMatchObject({ code: "OUTSTANDING_BALANCE" });

    // Quản lý duyệt yêu cầu đúng ⇒ lễ tân gửi lại kèm approval → check-out; AR còn 930.000 gắn người nợ + hạn trả.
    await ok(
      run(M, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
      })),
    );
    const r = await ok(useApproval(req.approvalRequestId));
    expect(r).toMatchObject({
      status: "checked_out",
      balance: 930_000,
      debtor_person_id: s.bookerId,
      due_date: DUE,
    });
    const st = await stayRow(s.stayId);
    expect(st).toMatchObject({ status: "checked_out", debtor_person_id: s.bookerId, debt_due_date: DUE });
    const ar = await one(
      sql<{
        b: string;
      }>`select coalesce(sum(debit - credit), 0)::text as b from journal_lines where invoice_id = ${r.invoice_id} and account = 'AR'`,
    );
    expect(ar.b).toBe("930000");
    expect(await folioOf(s.stayId)).toEqual([
      expect.objectContaining({ due_on: DUE, open_amount: "930000" }),
    ]);
  });

  it("qua HTTP (giờ thật): lễ tân không thu đủ → 409 problem+json OUTSTANDING_BALANCE; thu đủ tiền mặt trong ca → 200, biên nhận; thiếu hạn trả → 422", async () => {
    const s = await realScenario();
    const bad = await http("stay.checkOut", { stay_id: s.stayId }, "front_desk");
    expect(bad).toMatchObject({
      status: 409,
      body: { code: "OUTSTANDING_BALANCE", items: [{ balance: s.roomTotal }] },
    });
    const noDue = await http(
      "stay.checkOut",
      { stay_id: s.stayId, allow_balance: { debtor_person_id: s.bookerId } },
      "front_desk",
    );
    expect(noDue.status).toBe(422);
    const key = randomUUID();
    const body = { stay_id: s.stayId, payments: [{ method: "cash", amount: s.roomTotal }] };
    const ok1 = await http("stay.checkOut", body, "lễ tân L", key);
    expect(ok1.status).toBe(200);
    expect(ok1.body.data).toMatchObject({ status: "checked_out", balance: 0, paid: s.roomTotal });
    expect(ok1.body.data.payments[0].receipt_no).toMatch(/^PT-\d{6}$/);
    // Cùng key, cùng nội dung → cùng kết quả (không thu lần hai); khác nội dung → IDEMPOTENCY_CONFLICT.
    const ok2 = await http("stay.checkOut", body, "lễ tân L", key);
    expect(ok2.body.data).toEqual(ok1.body.data);
    expect(
      await http("stay.checkOut", { ...body, payments: [{ method: "cash", amount: 1 }] }, "lễ tân L", key),
    ).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(
      await count(
        "payments",
        sql`reservation_id is null and receipt_no = ${ok1.body.data.payments[0].receipt_no}`,
      ),
    ).toBe(1);
    // Sai schema: thiếu stay_id, thừa trường lạ → 422.
    expect((await http("stay.checkOut", {}, "front_desk")).status).toBe(422);
    expect((await http("stay.checkOut", { stay_id: s.stayId, x: 1 }, "front_desk")).status).toBe(422);
  });

  it("owner/manager (có quyền cho nợ) tự cho nợ, không cần yêu cầu duyệt; người nợ phải tồn tại", async () => {
    const s = await scenario({ extras: true });
    expect(
      await fails(out(M, s.stayId, { allowBalance: { debtorPersonId: randomUUID(), dueDate: DUE } })),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    const r = await ok(out(M, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    expect(r).toMatchObject({ balance: 1_430_000, advance_applied: 0 });
  });
});

describe("S-026 check-out ca đêm, khách trả tiền mặt: lễ tân tự xác nhận", () => {
  it("930.000 tiền mặt lúc 23/10 00:40: payment confirmed bởi chính L, biên nhận, folio 0, business_date 22/10, vào tiền mặt dự kiến của ca; gửi lại cùng key → cùng kết quả, một payment", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const shift = await one(
      sql<{ id: string }>`select id from shifts where opened_by = ${L.membershipId} and status = 'open'`,
    );
    const approvalsBefore = await count("approval_requests");
    const key = randomUUID();
    const r = await ok(out(L, s.stayId, { payments: [{ method: "cash", amount: 930_000 }] }, NIGHT_OUT, key));
    expect(r).toMatchObject({
      balance: 0,
      paid: 930_000,
      advance_applied: 500_000,
      business_date: "2026-10-22",
      status: "checked_out",
    });
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]?.receipt_no).toMatch(/^PT-\d{6}$/);
    const pay = await one(
      sql<{
        status: string;
        confirmed_by: string;
        recorded_by: string;
        shift_id: string;
        evidence_kind: string;
        business_date: string;
        allocated_total: string;
        receipt_no: string;
        payer_person_id: string;
      }>`select status, confirmed_by, recorded_by, shift_id, evidence_kind, business_date::text, allocated_total::text, receipt_no, payer_person_id
         from payments where id = ${r.payments[0]?.payment_id}`,
    );
    expect(pay).toMatchObject({
      status: "confirmed",
      confirmed_by: L.membershipId,
      recorded_by: L.membershipId,
      shift_id: shift.id,
      evidence_kind: "cash_receipt",
      business_date: "2026-10-22", // 00:40 < giờ chốt 04:00 ⇒ ngày kinh doanh hôm trước
      allocated_total: "930000",
      payer_person_id: s.bookerId,
    });
    // Nợ CASH 930.000 / Có CUSTOMER_CREDIT 930.000 rồi Nợ CUSTOMER_CREDIT / Có AR 930.000 — cùng ngày kinh doanh 22/10.
    const entries = await rows(
      sql<{
        entry_type: string;
        account: string;
        debit: string;
        credit: string;
        business_date: string;
        shift_id: string | null;
      }>`
        select e.entry_type, l.account, l.debit::text, l.credit::text, e.business_date::text, l.shift_id
        from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.source_doc_id = ${r.payments[0]?.payment_id}
        order by case e.entry_type when 'payment_confirmed' then 0 else 1 end, l.line_no`,
    );
    expect(entries.map((e) => [e.entry_type, e.account, e.debit, e.credit, e.business_date])).toEqual([
      ["payment_confirmed", "CASH", "930000", "0", "2026-10-22"],
      ["payment_confirmed", "CUSTOMER_CREDIT", "0", "930000", "2026-10-22"],
      ["payment_allocated", "CUSTOMER_CREDIT", "930000", "0", "2026-10-22"],
      ["payment_allocated", "AR", "0", "930000", "2026-10-22"],
    ]);
    expect(entries[0]?.shift_id).toBe(shift.id);
    const inv = await folioOf(s.stayId);
    expect(inv[0]).toMatchObject({
      total: "1430000",
      allocated_total: "1430000",
      open_amount: "0",
      business_date: "2026-10-22",
    });
    // Khoản 930.000 nằm trong tiền mặt dự kiến của ca L (đầu ca 2.000.000 + thu) — theo sổ phụ (S-034).
    const exp = await one(
      sql<{
        n: string;
      }>`select coalesce(sum(debit - credit), 0)::text as n from journal_lines where shift_id = ${shift.id} and account = 'CASH'`,
    );
    expect(Number(exp.n)).toBeGreaterThanOrEqual(930_000);
    // Không cần approval của quản lý.
    expect(await count("approval_requests")).toBe(approvalsBefore);
    // Allocation: trả muộn (qua 12:00) không kéo dài hồi tố.
    const al = await one(
      sql<{
        hi: Date;
      }>`select upper(during) as hi from allocations where source_type = 'stay' and source_id = ${s.stayId}`,
    );
    expect(new Date(al.hi).toISOString()).toBe("2026-10-22T05:00:00.000Z");

    // (d) gửi lại cùng Idempotency-Key → cùng kết quả (replay), vẫn một payment và một biên nhận.
    const again = await run(
      L,
      async (ctx) => ({
        data: await checkOut(ctx, {
          stayId: s.stayId,
          now: NIGHT_OUT,
          payments: [{ method: "cash", amount: 930_000 }],
        }),
      }),
      key,
    );
    expect(again).toMatchObject({ status: "committed", replayed: true, data: r });
    expect(
      await count(
        "payments",
        sql`reservation_id is null and recorded_by = ${L.membershipId} and amount = 930000`,
      ),
    ).toBe(1);
    expect(await count("payments", sql`receipt_no = ${r.payments[0]?.receipt_no}`)).toBe(1);
    expect(await folioOf(s.stayId)).toHaveLength(1);
  });

  it("(a) lễ tân không có ca đang mở → 403 FORBIDDEN, không có payment/bút toán/check-out nào", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const before = {
      payments: await count("payments"),
      entries: await count("journal_entries"),
      invoices: await count("invoices"),
    };
    expect(
      await fails(out(F3, s.stayId, { payments: [{ method: "cash", amount: 930_000 }] }, NIGHT_OUT)),
    ).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect({
      payments: await count("payments"),
      entries: await count("journal_entries"),
      invoices: await count("invoices"),
    }).toEqual(before);
    expect((await stayRow(s.stayId)).status).toBe("in_house");
    // Ca đã đóng cũng không được: mở rồi đóng ca của L2.
    const shift2 = await ok(
      run(L2, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    await ok(
      run(L2, async (ctx) => ({ data: await closeShift(ctx, { shiftId: shift2.shiftId, countedCash: 0 }) })),
    );
    expect(
      await fails(out(L2, s.stayId, { payments: [{ method: "cash", amount: 930_000 }] }, NIGHT_OUT)),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await count("payments")).toBe(before.payments);
  });

  it("(b) khách đưa 900.000 → còn 30.000 → 409 OUTSTANDING_BALANCE, không ghi gì; đi tiếp S-019: quản lý duyệt cho nợ 30.000 → check-out, payment 900.000 vẫn xác nhận bởi L", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const before = { payments: await count("payments"), entries: await count("journal_entries") };
    const p = await fails(out(L, s.stayId, { payments: [{ method: "cash", amount: 900_000 }] }, NIGHT_OUT));
    expect(p).toMatchObject({ code: "OUTSTANDING_BALANCE", items: [{ balance: 30_000 }] });
    expect({ payments: await count("payments"), entries: await count("journal_entries") }).toEqual(before);
    expect((await stayRow(s.stayId)).status).toBe("in_house");
    const req = await ok(
      run(L, async (ctx) => ({
        data: await requestApproval(ctx, {
          kind: "allow_balance",
          amount: 30_000,
          reason: "Khách thiếu 30.000, hẹn trả",
          propertyId: A.propertyId,
          subjectType: "stay",
          subjectId: s.stayId,
        }),
      })),
    );
    await ok(
      run(M, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId: req.approvalRequestId, decision: "approve" }),
      })),
    );
    const r = await ok(
      out(
        L,
        s.stayId,
        {
          payments: [{ method: "cash", amount: 900_000 }],
          allowBalance: { approvalId: req.approvalRequestId, debtorPersonId: s.bookerId, dueDate: DUE },
        },
        NIGHT_OUT,
      ),
    );
    expect(r).toMatchObject({
      balance: 30_000,
      paid: 900_000,
      status: "checked_out",
      debtor_person_id: s.bookerId,
    });
    expect((await folioOf(s.stayId))[0]).toMatchObject({
      total: "1430000",
      allocated_total: "1400000",
      open_amount: "30000",
      due_on: DUE,
    });
  });

  it("(c) khoản tiền mặt do lễ tân khác ghi: L không xác nhận được → 403 FORBIDDEN; khoản pending của người khác không làm giảm folio", async () => {
    const s = await scenario({ extras: true });
    const other = await ok(
      run(F, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "cash",
          amount: 1_430_000,
          payerPersonId: s.bookerId,
        }),
      })),
    );
    expect(
      await fails(
        run(L, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: other.paymentId }) })),
      ),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(out(L, s.stayId))).toMatchObject({ code: "OUTSTANDING_BALANCE" });
  });

  it("thu thừa → 422 (không ghi thu thừa lúc trả phòng); tiền mặt kèm tài khoản ngân hàng → 422; chuyển khoản: lễ tân không xác nhận được (403)", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    expect(
      await fails(out(L, s.stayId, { payments: [{ method: "cash", amount: 930_001 }] }, NIGHT_OUT)),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ code: "OVERPAYMENT" }],
    });
    expect(
      await fails(
        out(L, s.stayId, { payments: [{ method: "cash", amount: 1000, receivingAccountId: RA }] }, NIGHT_OUT),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await fails(
        out(
          L,
          s.stayId,
          {
            payments: [
              {
                method: "bank_transfer",
                amount: 930_000,
                receivingAccountId: RA,
                bankTxn: { ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: "2026-10-22T10:00:00Z" },
              },
            ],
          },
          NIGHT_OUT,
        ),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect((await stayRow(s.stayId)).status).toBe("in_house");
    // Quản lý xác nhận chuyển khoản có chứng cứ ngay trong lệnh: Nợ BANK / Có CUSTOMER_CREDIT rồi phân bổ.
    const r = await ok(
      out(
        M,
        s.stayId,
        {
          payments: [
            {
              method: "bank_transfer",
              amount: 930_000,
              receivingAccountId: RA,
              bankTxn: { ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: "2026-10-22T10:00:00Z" },
            },
          ],
        },
        NIGHT_OUT,
      ),
    );
    expect(r).toMatchObject({ balance: 0, paid: 930_000 });
  });
});

describe("hai người check-out cùng lúc, ranh giới và quyền", () => {
  it("hai check-out song song (key khác nhau): đúng một thắng, bên kia INVALID_TRANSITION; một phiếu, một bộ bút toán", async () => {
    const s = await scenario({ extras: true });
    const allow = { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } };
    const [a, b] = await Promise.all([out(O, s.stayId, allow), out(M, s.stayId, allow)]);
    const results = [a, b];
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    const lose = results.find((r) => r.status === "failed");
    expect(lose?.status === "failed" && lose.problem.code).toBe("INVALID_TRANSITION");
    expect(await folioOf(s.stayId)).toHaveLength(1);
    expect(
      await count(
        "journal_entries",
        sql`entry_type = 'invoice_issued' and source_doc_id = ${(await folioOf(s.stayId))[0]?.id}`,
      ),
    ).toBe(1);
    expect(await count("outbox", sql`event_type = 'stay.checked_out' and aggregate_id = ${s.stayId}`)).toBe(
      1,
    );
  });

  it("check-out lần hai (key khác) → INVALID_TRANSITION; stay không tồn tại → 404; buồng phòng → 404; kế toán → 403", async () => {
    const s = await scenario({ advance: 1_200_000 });
    await ok(out(F, s.stayId));
    expect(await fails(out(F, s.stayId))).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await fails(out(F, randomUUID()))).toMatchObject({ code: "NOT_FOUND" });
    expect(await fails(out(F, "khong-phai-uuid"))).toMatchObject({ code: "NOT_FOUND" });
    const s2 = await scenario({ advance: 1_200_000 });
    expect(await fails(out(H, s2.stayId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await fails(out(K, s2.stayId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await fails(out(OB, s2.stayId))).toMatchObject({ code: "NOT_FOUND" });
    expect((await stayRow(s2.stayId)).status).toBe("in_house");
  });

  it("giờ trả phòng trước giờ nhận phòng → 422, lượt ở không đổi", async () => {
    const s = await scenario({ advance: 1_200_000 });
    expect(await fails(out(F, s.stayId, {}, new Date("2026-10-20T01:00:00Z")))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect((await stayRow(s.stayId)).status).toBe("in_house");
  });

  it("ứng trước của booking khác không bị ăn vào folio này", async () => {
    const other = await scenario({ advance: 400_000 }); // booking khác: ứng trước của nó không được trừ vào folio này
    const s = await scenario({ advance: 500_000, extras: true });
    const r = await ok(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    expect(r.advance_applied).toBe(500_000);
    const untouched = await one(
      sql<{
        a: string;
      }>`select allocated_total::text as a from payments where id = ${other.advancePaymentId}`,
    );
    expect(untouched.a).toBe("0");
  });
});

describe("S-022 kỳ đã khoá", () => {
  async function lockThrough(date: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into period_locks (id, organization_id, property_id, locked_through, locked_by, reason)
              values (${id}, ${A.orgId}, ${A.propertyId}, ${date}::date, ${M.membershipId}, 'Chốt kỳ thử')`.execute(
      t.admin,
    );
    return id;
  }
  const unlock = (id: string) =>
    sql`update period_locks set released_at = now(), released_by = ${O.membershipId}, release_reason = 'mở lại' where id = ${id}`.execute(
      t.admin,
    );

  it("postCharge/voidCharge với business_date 21/10 trong kỳ khoá → 409 PERIOD_LOCKED; check-out ngày đã khoá → PERIOD_LOCKED, không ghi gì", async () => {
    const s = await scenario({ advance: 500_000 });
    const charge = await ok(post(F, s.stayId, "service", "Minibar", 80_000, MINIBAR_AT));
    const lock = await lockThrough("2026-10-21");
    try {
      expect(
        await fails(post(F, s.stayId, "service", "Minibar", 80_000, LATE_AT, { businessDate: "2026-10-21" })),
      ).toMatchObject({ code: "PERIOD_LOCKED", status: 409 });
      expect(
        await fails(
          run(F, async (ctx) => ({
            data: await voidCharge(ctx, { chargeId: charge.charge_id, reason: "Nhầm" }),
          })),
        ),
      ).toMatchObject({ code: "PERIOD_LOCKED" });
      expect(
        await count("charges", sql`stay_id = ${s.stayId} and kind = 'service' and voided_at is null`),
      ).toBe(1);
      // Ngày chưa khoá (22/10) vẫn ghi được.
      await ok(post(F, s.stayId, "fee", "Phụ thu", 150_000, LATE_AT));
      // Check-out ghi sổ ngày 22/10: còn mở ⇒ qua; khoá tới 22/10 ⇒ PERIOD_LOCKED và không còn gì sót lại.
      const lock2 = await lockThrough("2026-10-22");
      try {
        const beforeEntries = await count("journal_entries");
        expect(
          await fails(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } })),
        ).toMatchObject({
          code: "PERIOD_LOCKED",
        });
        expect(await count("journal_entries")).toBe(beforeEntries);
        expect(await folioOf(s.stayId)).toHaveLength(0);
        expect((await stayRow(s.stayId)).status).toBe("in_house");
      } finally {
        await unlock(lock2);
      }
    } finally {
      await unlock(lock);
    }
    // Hàng rào CSDL: chèn thẳng `charges` vào kỳ khoá cũng bị chặn (trigger, không phụ thuộc code app).
    const lock3 = await lockThrough("2026-10-21");
    try {
      const e = await pgError(
        sql`insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date, quantity, unit_price, amount)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'stay', ${s.stayId}, 'service', 'REV_SERVICE', 'x', '2026-10-21', 1, 1, 1)`.execute(
          t.admin,
        ),
      );
      expect(e.hint).toBe("PERIOD_LOCKED");
    } finally {
      await unlock(lock3);
    }
  });
});

describe("S-023 phiếu đã phát hành bất biến; S-024 phân bổ không vượt", () => {
  it("sau check-out: sửa charge/dòng phiếu/phiếu → DOCUMENT_IMMUTABLE ở CSDL; huỷ charge đã lên phiếu → 409; thêm charge mới vào lượt ở đã có phiếu bị chặn", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const minibar = await one(
      sql<{ id: string }>`select id from charges where stay_id = ${s.stayId} and kind = 'service'`,
    );
    const r = await ok(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    expect(
      (
        await pgError(
          sql`update charges set amount = 90000, unit_price = 90000 where id = ${minibar.id}`.execute(
            t.admin,
          ),
        )
      ).hint,
    ).toBe("DOCUMENT_IMMUTABLE");
    expect(
      (
        await pgError(
          sql`update invoice_lines set amount = 90000 where charge_id = ${minibar.id}`.execute(t.admin),
        )
      ).code,
    ).toBeDefined();
    expect(
      (await pgError(sql`update invoices set total = 1 where id = ${r.invoice_id}`.execute(t.admin))).hint,
    ).toBe("DOCUMENT_IMMUTABLE");
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await voidCharge(ctx, { chargeId: minibar.id, reason: "Sửa sau phát hành" }),
        })),
      ),
    ).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    expect(await fails(post(F, s.stayId, "service", "Trễ", 1000, OUT))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    const e = await pgError(
      sql`insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date, quantity, unit_price, amount)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'stay', ${s.stayId}, 'service', 'REV_SERVICE', 'x', '2026-10-22', 1, 1, 1)`.execute(
        t.admin,
      ),
    );
    expect(e.hint).toBe("DOCUMENT_IMMUTABLE");
    // Một lượt ở một phiếu folio (chỉ mục duy nhất).
    const dup = await pgError(
      sql`insert into invoices (id, organization_id, property_id, kind, stay_id, number, memo_ref, payer_person_id, business_date, total)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'folio', ${s.stayId}, 'FO-DUP', 'DUPMEMO001', ${s.bookerId}, '2026-10-22', 0)`.execute(
        t.admin,
      ),
    );
    expect(dup.code).toBeDefined();
  });

  it("S-024: thanh toán 500.000 đã phân bổ hết, phân bổ thêm 100.000 → 409 OVER_ALLOCATION, Σ phân bổ vẫn 500.000; phiếu: vượt số còn của phiếu cũng bị chặn", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const r = await ok(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    const p = await fails(
      run(O, async (ctx) => ({
        data: await allocatePayment(ctx, {
          paymentId: s.advancePaymentId as string,
          allocations: [{ invoiceId: r.invoice_id as string, amount: 100_000 }],
        }),
      })),
    );
    expect(p).toMatchObject({ code: "OVER_ALLOCATION", status: 409 });
    const sum = await one(
      sql<{
        n: string;
      }>`select sum(amount)::text as n from payment_allocations where payment_id = ${s.advancePaymentId}`,
    );
    expect(sum.n).toBe("500000");
    expect((await folioOf(s.stayId))[0]?.allocated_total).toBe("500000");
    // Phiếu còn 930.000: một khoản thu mới 1.000.000 phân bổ 930.001 → OVER_ALLOCATION (vượt số còn của phiếu).
    const pay = await ok(
      run(L, async (ctx) => {
        const rec = await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "cash",
          amount: 1_000_000,
          payerPersonId: s.bookerId,
        });
        await confirmPayment(ctx, { paymentId: rec.paymentId });
        return { data: rec };
      }),
    );
    expect(
      await fails(
        run(O, async (ctx) => ({
          data: await allocatePayment(ctx, {
            paymentId: pay.paymentId,
            allocations: [{ invoiceId: r.invoice_id as string, amount: 930_001 }],
          }),
        })),
      ),
    ).toMatchObject({ code: "OVER_ALLOCATION" });
  });
});

describe("S-027 hoàn cọc khách sạn lúc check-out theo hạn mức lễ tân", () => {
  it("(a) cọc 1.000.000: L hoàn nguyên số tiền mặt → Nợ DEPOSIT_LIAB / Có CASH ca của L, cọc còn 0, không REV_* từ cọc; hoàn một phần → 403", async () => {
    const s = await scenario({ advance: 1_200_000 });
    const depositId = await addDeposit(L, s, 1_000_000);
    const shift = await one(
      sql<{ id: string }>`select id from shifts where opened_by = ${L.membershipId} and status = 'open'`,
    );
    // Hoàn một phần (lễ tân phải hoàn nguyên số cọc còn giữ) → 403, không ghi gì.
    expect(
      await fails(out(L, s.stayId, { depositRefund: { amount: 400_000, method: "cash" } })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect((await stayRow(s.stayId)).status).toBe("in_house");
    expect(
      await fails(out(L, s.stayId, { depositRefund: { amount: 1_000_001, method: "cash" } })),
    ).toMatchObject({ code: "REFUND_EXCEEDS_BALANCE" });
    const r = await ok(out(L, s.stayId, { depositRefund: { amount: 1_000_000, method: "cash" } }));
    expect(r).toMatchObject({
      status: "checked_out",
      balance: 0,
      deposit_refund_status: "done",
      deposit_refund_approval_id: null,
    });
    const dep = await one(
      sql<{
        balance: string;
        refunded_total: string;
        deducted_total: string;
      }>`select balance::text, refunded_total::text, deducted_total::text from deposits where id = ${depositId}`,
    );
    expect(dep).toEqual({ balance: "0", refunded_total: "1000000", deducted_total: "0" });
    const lines = await rows(
      sql<{
        account: string;
        debit: string;
        credit: string;
        shift_id: string | null;
        deposit_id: string | null;
      }>`
        select l.account, l.debit::text, l.credit::text, l.shift_id, l.deposit_id from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.entry_type = 'deposit_refunded' and e.source_doc_id = ${depositId} order by l.line_no`,
    );
    expect(lines).toEqual([
      { account: "DEPOSIT_LIAB", debit: "1000000", credit: "0", shift_id: null, deposit_id: depositId },
      { account: "CASH", debit: "0", credit: "1000000", shift_id: shift.id, deposit_id: null },
    ]);
    // Doanh thu của lượt ở chỉ là tiền phòng 1.200.000: cọc không tạo REV_*.
    const rev = await one(
      sql<{
        n: string;
      }>`select coalesce(sum(credit), 0)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id
                         where l.account like 'REV_%' and e.source_doc_id = ${r.invoice_id}`,
    );
    expect(rev.n).toBe("1200000");
    expect(await count("journal_lines", sql`account like 'REV_%' and deposit_id = ${depositId}`)).toBe(0);
    const fol = await getFolio(t.runtime, M, s.stayId);
    expect(fol.deposits).toEqual([
      { id: depositId, amount: 1_000_000, deducted_total: 0, refunded_total: 1_000_000, balance: 0 },
    ]);
  });

  it("(b) cọc 3.000.000 vượt hạn mức lễ tân: stay vẫn checked_out, yêu cầu duyệt pending, cọc còn 3.000.000; L tự duyệt → SELF_APPROVAL_FORBIDDEN; lễ tân khác → APPROVAL_LIMIT_EXCEEDED; quản lý duyệt → hoàn", async () => {
    const s = await scenario({ advance: 1_200_000 });
    const depositId = await addDeposit(L, s, 3_000_000);
    const r = await ok(
      out(L, s.stayId, { depositRefund: { amount: 3_000_000, method: "cash", reason: "Khách trả phòng" } }),
    );
    expect(r).toMatchObject({ status: "checked_out", deposit_refund_status: "pending_approval" });
    expect(r.deposit_refund_approval_id).toEqual(expect.any(String));
    const req = await one(
      sql<{
        status: string;
        kind: string;
        amount: string;
        subject_id: string;
        requested_by: string;
        reason: string;
      }>`
        select status, kind, amount::text, subject_id, requested_by, reason from approval_requests where id = ${r.deposit_refund_approval_id}`,
    );
    expect(req).toMatchObject({
      status: "pending",
      kind: "deposit_refund",
      amount: "3000000",
      subject_id: depositId,
      requested_by: L.membershipId,
      reason: "Khách trả phòng",
    });
    expect(
      (await one(sql<{ b: string }>`select balance::text as b from deposits where id = ${depositId}`)).b,
    ).toBe("3000000");
    expect(
      await count("journal_entries", sql`entry_type = 'deposit_refunded' and source_doc_id = ${depositId}`),
    ).toBe(0);
    const approve = (a: Actor) =>
      run(a, async (ctx) => ({
        data: await decideApproval(ctx, {
          approvalRequestId: r.deposit_refund_approval_id as string,
          decision: "approve",
        }),
      }));
    expect(await fails(approve(L))).toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN", status: 403 });
    expect(await fails(approve(L2))).toMatchObject({ code: "APPROVAL_LIMIT_EXCEEDED", status: 403 });
    // Quản lý chi tiền mặt trong ca của chính mình.
    await ok(
      run(M, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    await ok(approve(M));
    expect(
      (await one(sql<{ b: string }>`select balance::text as b from deposits where id = ${depositId}`)).b,
    ).toBe("0");
    expect(
      await count(
        "journal_entries",
        sql`entry_type = 'deposit_refunded' and source_doc_id = ${r.deposit_refund_approval_id}`,
      ),
    ).toBe(1);
  });

  it("(c) cọc 1.000.000, còn nợ 200.000 phí hư hỏng: không hoàn cọc khi còn nợ; khấu trừ cần người duyệt khác người lập (lễ tân tự duyệt → SELF_APPROVAL_FORBIDDEN), không REV_* từ cọc, chỉ khấu trừ vào folio của chính booking", async () => {
    const s = await scenario({ advance: 1_200_000 });
    const depositId = await addDeposit(L, s, 1_000_000);
    await ok(post(L, s.stayId, "fee", "Phí hư hỏng", 200_000, LATE_AT));
    expect(
      await fails(
        out(O, s.stayId, {
          depositRefund: { amount: 1_000_000, method: "cash" },
          allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE },
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await fails(out(L, s.stayId))).toMatchObject({
      code: "OUTSTANDING_BALANCE",
      items: [{ balance: 200_000 }],
    });
    const r = await ok(out(O, s.stayId, { allowBalance: { debtorPersonId: s.bookerId, dueDate: DUE } }));
    expect(r).toMatchObject({ balance: 200_000, folio_total: 1_400_000, advance_applied: 1_200_000 });
    const requestDeduct = (invoiceId: string) =>
      run(L, async (ctx) => ({
        data: await requestDeduction(ctx, { depositId, invoiceId, amount: 200_000, reason: "Phí hư hỏng" }),
      }));
    // Không khấu trừ vào phiếu của booking khác.
    const alien = await scenario({ advance: 1_200_000 });
    const alienOut = await ok(out(O, alien.stayId));
    expect(await fails(requestDeduct(alienOut.invoice_id as string))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const q = await ok(requestDeduct(r.invoice_id as string));
    const approve = (a: Actor) =>
      run(a, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId: q.approvalRequestId, decision: "approve" }),
      }));
    expect(await fails(approve(L))).toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN", status: 403 });
    expect(
      (await one(sql<{ b: string }>`select balance::text as b from deposits where id = ${depositId}`)).b,
    ).toBe("1000000");
    await ok(approve(M));
    const dep = await one(
      sql<{
        balance: string;
        deducted_total: string;
      }>`select balance::text, deducted_total::text from deposits where id = ${depositId}`,
    );
    expect(dep).toEqual({ balance: "800000", deducted_total: "200000" });
    expect((await folioOf(s.stayId))[0]).toMatchObject({ allocated_total: "1400000", open_amount: "0" });
    const lines = await rows(
      sql<{ account: string; debit: string; credit: string }>`
        select l.account, l.debit::text, l.credit::text from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.entry_type = 'deposit_deducted' and e.source_doc_id = ${q.approvalRequestId} order by l.line_no`,
    );
    expect(lines).toEqual([
      { account: "DEPOSIT_LIAB", debit: "200000", credit: "0" },
      { account: "AR", debit: "0", credit: "200000" },
    ]);
  });
});

describe("stay.getFolio và quyền đọc (S-025)", () => {
  it("folio liệt kê charges, ứng trước, cọc tách riêng; buồng phòng/tổ chức khác → 404; kế toán đọc được; HTTP", async () => {
    const s = await scenario({ advance: 500_000, extras: true });
    const depositId = await addDeposit(L, s, 1_000_000);
    const f = await getFolio(t.runtime, F, s.stayId);
    expect(f.charges.map((c) => [c.kind, c.amount])).toEqual([
      ["room", 600_000],
      ["room", 600_000],
      ["service", 80_000],
      ["fee", 150_000],
    ]);
    // Cọc tách riêng, không trừ vào số còn phải thu (INV-F5).
    expect(f).toMatchObject({ charges_total: 1_430_000, advance_available: 500_000, balance: 930_000 });
    expect(f.deposits).toEqual([
      { id: depositId, amount: 1_000_000, deducted_total: 0, refunded_total: 0, balance: 1_000_000 },
    ]);
    await expect(getFolio(t.runtime, H, s.stayId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFolio(t.runtime, OB, s.stayId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFolio(t.runtime, F, "khong-phai-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getFolio(t.runtime, K, s.stayId)).charges_total).toBe(1_430_000);
    const def = QUERIES["stay.getFolio"];
    const res = await handleQuery(
      def as never,
      new Request(`http://local.test/api/v1/stay/getFolio?${new URLSearchParams({ stay_id: s.stayId })}`, {
        headers: { "x-test-user": users.front_desk as string, "x-org-id": A.orgId },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { charges_total: number } }).data.charges_total).toBe(1_430_000);
    // Khách chưa trả phòng, hoá đơn chưa có: thêm charge huỷ không tính vào tổng.
    const c = await ok(post(F, s.stayId, "service", "Nước", 20_000, MINIBAR_AT));
    await ok(
      run(F, async (ctx) => ({ data: await voidCharge(ctx, { chargeId: c.charge_id, reason: "Nhầm" }) })),
    );
    const g = await getFolio(t.runtime, F, s.stayId);
    expect(g.charges_total).toBe(1_430_000);
    expect(g.charges.find((x) => x.id === c.charge_id)?.voided).toBe(true);
  });
});
