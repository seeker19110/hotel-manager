// PLAN đợt 2 T-105 — thanh toán và phân bổ trên Postgres thật (SPEC-ledger S-001…S-010, S-025…S-029; INV-F2/F3/F3b/F4b/G4).
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { balance } from "../ledger/ledger.ts";
import { executeCommand } from "../pipeline/command.ts";
import { closeShift, expectedCash, openShift } from "../shifts/shifts.ts";
import {
  allocatePayment,
  confirmPayment,
  customerCredit,
  type RecordPaymentInput,
  recordPayment,
  reversePayment,
} from "./payments.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let manager: Actor;
let K: Actor;
let F: Actor;
let F2: Actor;
let B1: string;

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"})`.execute(
    t.admin,
  );
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, ${name})`.execute(
    t.admin,
  );
  return id;
}

function run<T>(
  actor: Actor,
  fn: Parameters<typeof executeCommand<T>>[3],
  key = randomUUID(),
  payload: unknown = { n: key },
) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "payment.test", idempotencyKey: key, payload, correlationId: "c" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

const invoice = (payer: string, ...amounts: number[]) =>
  seedIssuedInvoice(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    payerPersonId: payer,
    lines: amounts.map((amount) => ({ amount })),
  });

const record = (
  a: Actor,
  i: Partial<RecordPaymentInput> & Pick<RecordPaymentInput, "method" | "amount" | "payerPersonId">,
) =>
  run(a, async (ctx) => ({
    data: await recordPayment(ctx, {
      propertyId: A.propertyId,
      ...(i.method === "bank_transfer" ? { receivingAccountId: B1 } : {}),
      ...i,
    }),
  }));

/** Thu chuyển khoản đã xác nhận (kèm dòng sao kê nhập tay). */
async function bankPaid(a: Actor, payer: string, amount: number, ref = `FT${randomUUID().slice(0, 8)}`) {
  const { paymentId } = await ok(
    record(a, {
      method: "bank_transfer",
      amount,
      payerPersonId: payer,
      bankTxn: { ref, occurredAt: "2026-10-15T03:00:00Z" },
    }),
  );
  await ok(run(a, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
  return paymentId;
}

const allocate = (a: Actor, paymentId: string, allocations: { invoiceId: string; amount: number }[]) =>
  run(a, async (ctx) => ({ data: await allocatePayment(ctx, { paymentId, allocations }) }));

const remaining = async (invoiceId: string) => {
  const r = await sql<{
    r: string;
  }>`select (total - allocated_total)::text as r from invoices where id = ${invoiceId}`.execute(t.admin);
  return Number(r.rows[0]?.r);
};
const credit = (p: string) => t.admin.transaction().execute((trx) => customerCredit(trx, A.orgId, p));

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ thu tiền", "rental");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  manager = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
  F2 = await member("front_desk");
  B1 = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${B1}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("ví dụ bắt buộc", () => {
  it("S-001: I1 3.580.000, thu 2.000.000 chuyển khoản FT26288001, phân bổ → I1 còn 1.580.000; bút toán đúng", async () => {
    const payer = await person("Người thuê A");
    const I1 = await invoice(payer, 3_000_000, 480_000, 100_000);
    expect(I1.total).toBe(3_580_000);
    const pid = await bankPaid(K, payer, 2_000_000, "FT26288001");
    const bt = await sql<{ n: number }>`
      select count(*)::int as n from bank_transactions where receiving_account_id = ${B1} and bank_txn_ref = 'FT26288001'`.execute(
      t.admin,
    );
    expect(bt.rows[0]?.n).toBe(1);
    const p = await sql<{ status: string; bank_transaction_id: string | null; evidence_kind: string }>`
      select status, bank_transaction_id, evidence_kind from payments where id = ${pid}`.execute(t.admin);
    expect(p.rows[0]).toMatchObject({ status: "confirmed", evidence_kind: "bank_transaction" });
    expect(p.rows[0]?.bank_transaction_id).toBeTruthy();
    await ok(allocate(K, pid, [{ invoiceId: I1.invoiceId, amount: 2_000_000 }]));
    expect(await remaining(I1.invoiceId)).toBe(1_580_000);
    expect(
      await t.admin
        .transaction()
        .execute((trx) => balance(trx, { orgId: A.orgId, account: "AR", invoiceId: I1.invoiceId })),
    ).toBe(1_580_000);
    expect(await credit(payer)).toBe(0);
    const entries = await sql<{ entry_type: string; account: string; debit: string; credit: string }>`
      select e.entry_type, l.account, l.debit, l.credit from journal_entries e join journal_lines l on l.entry_id = e.id
      where (e.source_doc_id = ${pid}) order by e.created_at, l.line_no`.execute(t.admin);
    expect(entries.rows.map((r) => [r.entry_type, r.account, Number(r.debit), Number(r.credit)])).toEqual([
      ["payment_confirmed", "BANK", 2_000_000, 0],
      ["payment_confirmed", "CUSTOMER_CREDIT", 0, 2_000_000],
      ["payment_allocated", "CUSTOMER_CREDIT", 2_000_000, 0],
      ["payment_allocated", "AR", 0, 2_000_000],
    ]);
  });

  it("S-002: ứng trước 500.000 phân bổ vào I2 1.430.000 → I2 còn 930.000; số dư khách = 0", async () => {
    const guest = await person("Khách S1");
    const pid = await bankPaid(K, guest, 500_000);
    expect(await credit(guest)).toBe(500_000);
    const I2 = await invoice(guest, 1_200_000, 80_000, 150_000);
    await ok(allocate(K, pid, [{ invoiceId: I2.invoiceId, amount: 500_000 }]));
    expect(await remaining(I2.invoiceId)).toBe(930_000);
    expect(await credit(guest)).toBe(0);
  });
});

describe("INV-F2 — phân bổ", () => {
  it("S-004: P2 2.500.000 phân bổ 1.580.000 + 930.000 → OVER_ALLOCATION, không ghi; 1.580.000 + 920.000 → I2 còn 10.000", async () => {
    const payer = await person("P");
    const I1 = await invoice(payer, 1_580_000);
    const I2 = await invoice(payer, 930_000);
    const P2 = await bankPaid(K, payer, 2_500_000);
    const before = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(t.admin);
    expect(
      await allocate(K, P2, [
        { invoiceId: I1.invoiceId, amount: 1_580_000 },
        { invoiceId: I2.invoiceId, amount: 930_000 },
      ]),
    ).toMatchObject({ status: "failed", problem: { code: "OVER_ALLOCATION", status: 409 } });
    const after = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    await ok(
      allocate(K, P2, [
        { invoiceId: I1.invoiceId, amount: 1_580_000 },
        { invoiceId: I2.invoiceId, amount: 920_000 },
      ]),
    );
    expect(await remaining(I2.invoiceId)).toBe(10_000);
  });

  it("S-005: phân bổ 1.580.001 vào phiếu còn 1.580.000 → OVER_ALLOCATION", async () => {
    const payer = await person("P5");
    const I1 = await invoice(payer, 1_580_000);
    const pid = await bankPaid(K, payer, 2_000_000);
    expect(await allocate(K, pid, [{ invoiceId: I1.invoiceId, amount: 1_580_001 }])).toMatchObject({
      problem: { code: "OVER_ALLOCATION" },
    });
  });

  it("S-006: hai người cùng phân bổ một khoản 2.000.000 vào hai phiếu 1.500.000 → đúng một thành công (lặp 30 lần, không deadlock)", async () => {
    const payer = await person("P6");
    for (let i = 0; i < 30; i++) {
      const I3 = await invoice(payer, 1_500_000);
      const I4 = await invoice(payer, 1_500_000);
      const P3 = await bankPaid(K, payer, 2_000_000);
      const rs = await Promise.all([
        allocate(K, P3, [{ invoiceId: I3.invoiceId, amount: 1_500_000 }]),
        allocate(manager, P3, [{ invoiceId: I4.invoiceId, amount: 1_500_000 }]),
      ]);
      expect(rs.filter((r) => r.status === "committed")).toHaveLength(1);
      expect(rs.filter((r) => r.status === "failed" && r.problem.code === "OVER_ALLOCATION")).toHaveLength(1);
      const p = await sql<{
        a: string;
      }>`select allocated_total::text as a from payments where id = ${P3}`.execute(t.admin);
      expect(Number(p.rows[0]?.a)).toBe(1_500_000);
    }
  });

  it("S-007: trả thừa 420.000 nằm ở CUSTOMER_CREDIT của người trả", async () => {
    const payer = await person("P7");
    const I1 = await invoice(payer, 1_580_000);
    const pid = await bankPaid(K, payer, 2_000_000);
    expect(await ok(allocate(K, pid, [{ invoiceId: I1.invoiceId, amount: 1_580_000 }]))).toMatchObject({
      unallocated: 420_000,
    });
    expect(await remaining(I1.invoiceId)).toBe(0);
    expect(await credit(payer)).toBe(420_000);
  });

  it.each([
    [3_580_000, 0, 2_000_000, 2_000_000, "ok", 1_580_000, 0],
    [1_430_000, 0, 500_000, 500_000, "ok", 930_000, 0],
    [3_580_000, 2_000_000, 2_000_000, 1_580_000, "ok", 0, 420_000],
    [1, 0, 1, 1, "ok", 0, 0],
    [0, 0, 1, 1, "OVER_ALLOCATION", 0, 1],
    [1_580_000, 0, 1_580_000, 0, "VALIDATION_FAILED", 1_580_000, 1_580_000],
    [967_742, 0, 1_000_000, 967_742, "ok", 0, 32_258],
  ])(
    "S-025: tổng %i, đã %i, thu %i, phân bổ %i → %s, còn %i, dư %i",
    async (tong, da, tt, pb, kq, con, du) => {
      const payer = await person("P25");
      const inv = await invoice(payer, tong);
      if (da > 0) {
        const prior = await bankPaid(K, payer, da);
        await ok(allocate(K, prior, [{ invoiceId: inv.invoiceId, amount: da }]));
      }
      const pid = await bankPaid(K, payer, tt);
      const r = await allocate(K, pid, [{ invoiceId: inv.invoiceId, amount: pb }]);
      if (kq === "ok") expect(r.status).toBe("committed");
      else expect(r).toMatchObject({ status: "failed", problem: { code: kq } });
      expect(await remaining(inv.invoiceId)).toBe(con);
      expect(await credit(payer)).toBe(du);
    },
  );

  it("quản lý phân bổ trong hạn mức mặc định 5.000.000; vượt → APPROVAL_LIMIT_EXCEEDED; lễ tân không phân bổ", async () => {
    const payer = await person("PM");
    const big = await invoice(payer, 6_000_000);
    const pid = await bankPaid(K, payer, 6_000_000);
    expect(await allocate(manager, pid, [{ invoiceId: big.invoiceId, amount: 6_000_000 }])).toMatchObject({
      problem: { code: "APPROVAL_LIMIT_EXCEEDED" },
    });
    expect(await allocate(F, pid, [{ invoiceId: big.invoiceId, amount: 1 }])).toMatchObject({
      problem: { code: "FORBIDDEN" },
    });
    await ok(allocate(manager, pid, [{ invoiceId: big.invoiceId, amount: 5_000_000 }]));
  });
});

describe("xác nhận, đảo (INV-F3, S-008…S-010)", () => {
  it("S-008: chuyển khoản không chứng cứ → EVIDENCE_REQUIRED, vẫn pending, không bút toán", async () => {
    const payer = await person("P8");
    const { paymentId } = await ok(
      record(K, { method: "bank_transfer", amount: 2_000_000, payerPersonId: payer }),
    );
    expect(await run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) }))).toMatchObject({
      problem: { code: "EVIDENCE_REQUIRED", status: 422 },
    });
    const p = await sql<{ status: string }>`select status from payments where id = ${paymentId}`.execute(
      t.admin,
    );
    expect(p.rows[0]?.status).toBe("pending");
    const e = await sql<{
      n: number;
    }>`select count(*)::int as n from journal_entries where source_doc_id = ${paymentId}`.execute(t.admin);
    expect(e.rows[0]?.n).toBe(0);
  });

  it("S-009: xác nhận lần 2 và đảo khi pending → INVALID_TRANSITION, không thêm bút toán", async () => {
    const payer = await person("P9");
    const pid = await bankPaid(K, payer, 100_000);
    expect(
      await run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: pid }) })),
    ).toMatchObject({
      problem: { code: "INVALID_TRANSITION" },
    });
    const { paymentId } = await ok(record(K, { method: "bank_transfer", amount: 1, payerPersonId: payer }));
    expect(
      await run(owner, async (ctx) => ({ data: await reversePayment(ctx, { paymentId, reason: "nhầm" }) })),
    ).toMatchObject({
      problem: { code: "INVALID_TRANSITION" },
    });
  });

  it("S-010: đảo thanh toán đã phân bổ → I1 về 3.580.000, bút toán đảo có reverses_entry_id, gốc giữ nguyên; đảo lần 2 → 409", async () => {
    const payer = await person("P10");
    const I1 = await invoice(payer, 3_580_000);
    const pid = await bankPaid(K, payer, 2_000_000);
    await ok(allocate(K, pid, [{ invoiceId: I1.invoiceId, amount: 2_000_000 }]));
    const r = await ok(
      run(owner, async (ctx) => ({
        data: await reversePayment(ctx, { paymentId: pid, reason: "khách chuyển nhầm" }),
      })),
    );
    expect(r.reversalEntryIds).toHaveLength(2);
    expect(await remaining(I1.invoiceId)).toBe(3_580_000);
    expect(await credit(payer)).toBe(0);
    const rev = await sql<{ n: number }>`
      select count(*)::int as n from journal_entries where id = any(${r.reversalEntryIds}::uuid[]) and reverses_entry_id is not null`.execute(
      t.admin,
    );
    expect(rev.rows[0]?.n).toBe(2);
    const st = await sql<{
      status: string;
      allocated_total: string;
    }>`select status, allocated_total from payments where id = ${pid}`.execute(t.admin);
    expect(st.rows[0]).toEqual({ status: "reversed", allocated_total: "0" });
    expect(
      await run(owner, async (ctx) => ({
        data: await reversePayment(ctx, { paymentId: pid, reason: "lần 2" }),
      })),
    ).toMatchObject({ problem: { code: "INVALID_TRANSITION" } });
  });
});

describe("tiền mặt và ca (INV-F3b, S-027, S-028)", () => {
  it("S-027: lễ tân nhận và tự xác nhận tiền mặt trong ca → biên nhận hệ thống; tính vào tiền dự kiến của ca", async () => {
    const guest = await person("Khách tiền mặt");
    const { shiftId } = await ok(
      run(F, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 2_000_000 }),
      })),
    );
    const { paymentId } = await ok(record(F, { method: "cash", amount: 930_000, payerPersonId: guest }));
    const c = await ok(run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    expect(c.receiptNo).toMatch(/^PT-\d{6}$/);
    expect(await t.admin.transaction().execute((trx) => expectedCash(trx, A.orgId, shiftId))).toBe(2_930_000);
    // Còn tiền mặt pending trong ca → không đóng được.
    await ok(record(F, { method: "cash", amount: 1_000, payerPersonId: guest }));
    expect(
      await run(F, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 2_930_000 }) })),
    ).toMatchObject({ problem: { code: "SHIFT_HAS_PENDING_PAYMENTS" } });
  });

  it("S-028: xác nhận khoản người khác nhận → 403; chưa mở ca → SHIFT_NOT_OPEN; lễ tân xác nhận chuyển khoản → 403; quản lý xác nhận được", async () => {
    const guest = await person("Khách F2");
    await ok(
      run(F2, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    const { paymentId } = await ok(record(F2, { method: "cash", amount: 500_000, payerPersonId: guest }));
    const before = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(t.admin);
    expect(await run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) }))).toMatchObject({
      problem: { code: "FORBIDDEN", status: 403 },
    });
    const noShift = await member("front_desk");
    expect(await record(noShift, { method: "cash", amount: 1, payerPersonId: guest })).toMatchObject({
      problem: { code: "SHIFT_NOT_OPEN" },
    });
    const tr = await ok(record(K, { method: "bank_transfer", amount: 7, payerPersonId: guest }));
    expect(
      await run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: tr.paymentId }) })),
    ).toMatchObject({
      problem: { code: "FORBIDDEN" },
    });
    const after = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    await ok(run(manager, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
  });

  it("đảo tiền mặt khi ca gốc đã đóng → dòng CASH đảo vào ca đang mở của người đảo; không có ca → SHIFT_NOT_OPEN", async () => {
    const guest = await person("Khách đảo");
    const giver = await member("front_desk");
    const { shiftId } = await ok(
      run(giver, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }),
      })),
    );
    const { paymentId } = await ok(record(giver, { method: "cash", amount: 300_000, payerPersonId: guest }));
    await ok(run(giver, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    await ok(run(giver, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 300_000 }) })));
    expect(
      await run(owner, async (ctx) => ({
        data: await reversePayment(ctx, { paymentId, reason: "ghi nhầm" }),
      })),
    ).toMatchObject({ problem: { code: "SHIFT_NOT_OPEN" } });
    const { shiftId: ownerShift } = await ok(
      run(owner, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 1_000_000 }),
      })),
    );
    await ok(
      run(owner, async (ctx) => ({ data: await reversePayment(ctx, { paymentId, reason: "ghi nhầm" }) })),
    );
    expect(await t.admin.transaction().execute((trx) => expectedCash(trx, A.orgId, ownerShift))).toBe(
      700_000,
    );
    const closed = await sql<{
      expected_cash: string;
    }>`select expected_cash from shifts where id = ${shiftId}`.execute(t.admin);
    expect(closed.rows[0]?.expected_cash).toBe("300000"); // ca đã chốt không đổi
  });
});

describe("INV-F4b, INV-G5, INV-G4", () => {
  it("S-029: ghi lại cùng mã giao dịch ngân hàng → BANK_TRANSACTION_ALREADY_USED kèm payment_id hiện có", async () => {
    const payer = await person("P29");
    const first = await bankPaid(K, payer, 2_000_000, "FT29000001");
    expect(
      await record(K, {
        method: "bank_transfer",
        amount: 2_000_000,
        payerPersonId: payer,
        bankTxn: { ref: "FT29000001", occurredAt: "2026-10-15T03:00:00Z" },
      }),
    ).toMatchObject({
      status: "failed",
      problem: { code: "BANK_TRANSACTION_ALREADY_USED", payment_id: first },
    });
  });

  it("S-026: gửi lại cùng key cùng payload → 1 thanh toán; khác payload → IDEMPOTENCY_CONFLICT", async () => {
    const payer = await person("P26");
    const key = randomUUID();
    const body = { amount: 1_000, payer };
    const fn = async (ctx: Parameters<Parameters<typeof run>[1]>[0]) => ({
      data: await recordPayment(ctx, {
        propertyId: A.propertyId,
        method: "bank_transfer",
        receivingAccountId: B1,
        amount: 1_000,
        payerPersonId: payer,
      }),
    });
    const a = await run(K, fn, key, body);
    const b = await run(K, fn, key, body);
    expect(
      a.status === "committed" && b.status === "committed" && a.data.paymentId === b.data.paymentId,
    ).toBe(true);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from payments where payer_person_id = ${payer}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
    // Pipeline ném IDEMPOTENCY_CONFLICT (không lưu thành kết quả); lớp HTTP trả 422 problem.
    await expect(run(K, fn, key, { ...body, amount: 2 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 422,
    });
  });

  it("CSDL: nội dung tiền bất biến sau xác nhận; phiếu chỉ đổi bộ đếm; bộ đếm vượt tổng bị CHECK chặn", async () => {
    const payer = await person("PG4");
    const inv = await invoice(payer, 100_000);
    const pid = await bankPaid(K, payer, 100_000);
    await expect(sql`update payments set amount = 1 where id = ${pid}`.execute(t.admin)).rejects.toThrow(
      /INV-G4/,
    );
    await expect(
      sql`update invoices set total = 1 where id = ${inv.invoiceId}`.execute(t.admin),
    ).rejects.toThrow(/INV-G4/);
    await expect(
      sql`update invoices set allocated_total = 100001 where id = ${inv.invoiceId}`.execute(t.admin),
    ).rejects.toThrow(/ck_invoices_allocated/);
    await expect(
      sql`update payments set allocated_total = 100001 where id = ${pid}`.execute(t.admin),
    ).rejects.toThrow(/ck_payments_allocated/);
  });
});
