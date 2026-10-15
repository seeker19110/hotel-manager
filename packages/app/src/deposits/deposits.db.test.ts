// PLAN đợt 2 T-106 — cọc và hoàn số dư trên Postgres thật (SPEC-ledger S-011…S-013, S-031, S-033; INV-F5, INV-F3b).
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
import { decideApproval } from "../approvals/approvals.ts";
import { balance } from "../ledger/ledger.ts";
import { confirmPayment, customerCredit, recordPayment, reversePayment } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { expectedCash, openShift } from "../shifts/shifts.ts";
import { receiveDeposit, requestCreditRefund, requestDeduction, requestDepositRefund } from "./deposits.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let K: Actor;
let F: Actor;
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

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  return executeCommand<T>(
    t.runtime,
    actor,
    {
      command: "deposit.test",
      idempotencyKey: randomUUID(),
      payload: { n: randomUUID() },
      correlationId: "c",
    },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

const approve = (a: Actor, id: string) =>
  run(a, async (ctx) => ({
    data: await decideApproval(ctx, { approvalRequestId: id, decision: "approve" }),
  }));

async function depositRow(id: string) {
  const r = await sql<{ amount: string; deducted_total: string; refunded_total: string; balance: string }>`
    select amount, deducted_total, refunded_total, balance from deposits where id = ${id}`.execute(t.admin);
  return Object.fromEntries(Object.entries(r.rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
}

const ledger = (account: "DEPOSIT_LIAB" | "REV_ROOM" | "REV_FEE", q: { depositId?: string } = {}) =>
  t.admin.transaction().execute((trx) => balance(trx, { orgId: A.orgId, account, ...q }));

/** Cọc tiền mặt đã xác nhận của một hợp đồng (F nhận trong ca). */
async function cashDeposit(leaseId: string, payer: string, amount: number) {
  const r = await ok(
    run(F, async (ctx) => ({
      data: await receiveDeposit(ctx, {
        propertyId: A.propertyId,
        leaseId,
        payerPersonId: payer,
        amount,
        method: "cash",
      }),
    })),
  );
  await ok(run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: r.paymentId }) })));
  return r;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ cọc", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
  B1 = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${B1}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
  await ok(
    run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
  );
  await ok(
    run(O, async (ctx) => ({
      data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 10_000_000 }),
    })),
  );
});

afterAll(async () => {
  await t.drop();
});

describe("S-011 nhận cọc tách doanh thu", () => {
  it("cọc tiền mặt 3.000.000: pending không bút toán; xác nhận → Nợ CASH / Có DEPOSIT_LIAB, không qua doanh thu", async () => {
    const L1 = randomUUID();
    const payer = await person("Người thuê L1");
    const revBefore = await ledger("REV_ROOM");
    const r = await ok(
      run(F, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          propertyId: A.propertyId,
          leaseId: L1,
          payerPersonId: payer,
          amount: 3_000_000,
          method: "cash",
        }),
      })),
    );
    expect(await depositRow(r.depositId)).toMatchObject({ amount: 0, balance: 0 });
    const none = await sql<{
      n: number;
    }>`select count(*)::int as n from journal_entries where source_doc_id = ${r.paymentId}`.execute(t.admin);
    expect(none.rows[0]?.n).toBe(0);
    const c = await ok(
      run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: r.paymentId }) })),
    );
    expect(c.receiptNo).toMatch(/^PT-/);
    expect(await depositRow(r.depositId)).toMatchObject({ amount: 3_000_000, balance: 3_000_000 });
    expect(await ledger("DEPOSIT_LIAB", { depositId: r.depositId })).toBe(-3_000_000);
    expect(await ledger("REV_ROOM")).toBe(revBefore);
    const lines = await sql<{ account: string }>`
      select l.account from journal_lines l join journal_entries e on e.id = l.entry_id where e.source_doc_id = ${r.paymentId}
      order by l.line_no`.execute(t.admin);
    expect(lines.rows.map((x) => x.account)).toEqual(["CASH", "DEPOSIT_LIAB"]);
    // Nhận thêm lần 2 vào cùng cọc hợp đồng.
    await cashDeposit(L1, payer, 500_000);
    expect(await depositRow(r.depositId)).toMatchObject({ amount: 3_500_000 });
  });
});

describe("S-012/S-013 khấu trừ và hoàn cọc (INV-F5)", () => {
  it("khấu trừ 1.580.000 cần người khác duyệt; hoàn 1.420.001 vượt → 409; hoàn 1.420.000 tiền mặt → cọc còn 0", async () => {
    const L1 = randomUUID();
    const payer = await person("Người thuê S-012");
    const { depositId } = await cashDeposit(L1, payer, 3_000_000);
    const I1 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      leaseId: L1,
      lines: [{ amount: 1_580_000 }],
    });
    const req = await ok(
      run(M, async (ctx) => ({
        data: await requestDeduction(ctx, {
          depositId,
          invoiceId: I1.invoiceId,
          amount: 1_580_000,
          reason: "trừ tiền tháng",
        }),
      })),
    );
    expect(await depositRow(depositId)).toMatchObject({ deducted_total: 0, balance: 3_000_000 });
    expect(await approve(M, req.approvalRequestId)).toMatchObject({
      problem: { code: "SELF_APPROVAL_FORBIDDEN" },
    });
    expect(await approve(F, req.approvalRequestId)).toMatchObject({ problem: { code: "FORBIDDEN" } });
    await ok(approve(O, req.approvalRequestId));
    expect(await depositRow(depositId)).toMatchObject({ deducted_total: 1_580_000, balance: 1_420_000 });
    const inv = await sql<{
      open: string;
    }>`select (total - allocated_total)::text as open from invoices where id = ${I1.invoiceId}`.execute(
      t.admin,
    );
    expect(Number(inv.rows[0]?.open)).toBe(0);
    const alloc = await sql<{ deposit_id: string; payment_id: string | null }>`
      select deposit_id, payment_id from payment_allocations where invoice_id = ${I1.invoiceId}`.execute(
      t.admin,
    );
    expect(alloc.rows).toEqual([{ deposit_id: depositId, payment_id: null }]);

    expect(
      await run(M, async (ctx) => ({
        data: await requestDepositRefund(ctx, {
          depositId,
          amount: 1_420_001,
          reason: "trả phòng",
          refund: { method: "cash" },
        }),
      })),
    ).toMatchObject({ problem: { code: "REFUND_EXCEEDS_BALANCE", status: 409 } });
    const refund = await ok(
      run(M, async (ctx) => ({
        data: await requestDepositRefund(ctx, {
          depositId,
          amount: 1_420_000,
          reason: "trả phòng",
          refund: { method: "cash" },
        }),
      })),
    );
    const cashBefore = await t.admin.transaction().execute(async (trx) => {
      const s = await sql<{
        id: string;
      }>`select id from shifts where opened_by = ${O.membershipId} and status = 'open'`.execute(trx);
      return { id: s.rows[0]?.id as string, cash: await expectedCash(trx, A.orgId, s.rows[0]?.id as string) };
    });
    await ok(approve(O, refund.approvalRequestId));
    expect(await depositRow(depositId)).toMatchObject({ balance: 0, refunded_total: 1_420_000 });
    expect(await ledger("DEPOSIT_LIAB", { depositId })).toBe(0);
    expect(await t.admin.transaction().execute((trx) => expectedCash(trx, A.orgId, cashBefore.id))).toBe(
      cashBefore.cash - 1_420_000,
    );
  });

  it("khấu trừ vào phiếu hợp đồng khác → 422; vượt AR còn mở → OVER_ALLOCATION; vượt cọc → REFUND_EXCEEDS_BALANCE", async () => {
    const L = randomUUID();
    const payer = await person("Người thuê kiểm");
    const { depositId } = await cashDeposit(L, payer, 1_000_000);
    const other = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      leaseId: randomUUID(),
      lines: [{ amount: 100 }],
    });
    const mine = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      leaseId: L,
      lines: [{ amount: 2_000_000 }],
    });
    const ask = (invoiceId: string, amount: number) =>
      run(M, async (ctx) => ({
        data: await requestDeduction(ctx, { depositId, invoiceId, amount, reason: "x" }),
      }));
    expect(await ask(other.invoiceId, 100)).toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(await ask(mine.invoiceId, 1_000_001)).toMatchObject({
      problem: { code: "REFUND_EXCEEDS_BALANCE" },
    });
    const small = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      leaseId: L,
      lines: [{ amount: 300 }],
    });
    expect(await ask(small.invoiceId, 301)).toMatchObject({ problem: { code: "OVER_ALLOCATION" } });
  });

  it("hai yêu cầu hoàn cộng lại vượt số còn, duyệt đồng thời → đúng một hiệu lực", async () => {
    const L = randomUUID();
    const payer = await person("Người thuê đồng thời");
    const { depositId } = await cashDeposit(L, payer, 1_420_000);
    const ask = () =>
      ok(
        run(M, async (ctx) => ({
          data: await requestDepositRefund(ctx, {
            depositId,
            amount: 1_000_000,
            reason: "trả",
            refund: { method: "bank_transfer", receivingAccountId: B1 },
          }),
        })),
      );
    const [r1, r2] = [await ask(), await ask()];
    const M2 = await member("manager");
    const rs = await Promise.all([approve(O, r1.approvalRequestId), approve(M2, r2.approvalRequestId)]);
    expect(rs.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(
      rs.filter((r) => r.status === "failed" && r.problem.code === "REFUND_EXCEEDS_BALANCE"),
    ).toHaveLength(1);
    expect(await depositRow(depositId)).toMatchObject({ balance: 420_000 });
  });

  it("đảo khoản cọc đã khấu trừ một phần → bị chặn (số cọc không âm)", async () => {
    const L = randomUUID();
    const payer = await person("Người thuê đảo");
    const { depositId, paymentId } = await cashDeposit(L, payer, 500_000);
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      leaseId: L,
      lines: [{ amount: 200_000 }],
    });
    const req = await ok(
      run(M, async (ctx) => ({
        data: await requestDeduction(ctx, {
          depositId,
          invoiceId: inv.invoiceId,
          amount: 200_000,
          reason: "x",
        }),
      })),
    );
    await ok(approve(O, req.approvalRequestId));
    expect(
      await run(O, async (ctx) => ({ data: await reversePayment(ctx, { paymentId, reason: "nhầm" }) })),
    ).toMatchObject({ status: "failed" });
    expect(await depositRow(depositId)).toMatchObject({ amount: 500_000, balance: 300_000 });
  });
});

describe("S-031 hoàn CUSTOMER_CREDIT", () => {
  it("vượt số dư → 409; tự duyệt → 403; quản lý duyệt → Nợ CUSTOMER_CREDIT / Có BANK, số dư 0, không doanh thu", async () => {
    const G = await person("Khách G");
    const { paymentId } = await ok(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "bank_transfer",
          receivingAccountId: B1,
          amount: 500_000,
          payerPersonId: G,
          bankTxn: { ref: `FT${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-15T03:00:00Z" },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    const revBefore = await ledger("REV_FEE");
    const ask = (amount: number) =>
      run(F, async (ctx) => ({
        data: await requestCreditRefund(ctx, {
          personId: G,
          propertyId: A.propertyId,
          amount,
          reason: "huỷ booking",
          refund: { method: "bank_transfer", receivingAccountId: B1 },
        }),
      }));
    expect(await ask(500_001)).toMatchObject({ problem: { code: "REFUND_EXCEEDS_BALANCE" } });
    const r = await ok(ask(500_000));
    expect(await approve(F, r.approvalRequestId)).toMatchObject({
      problem: { code: "SELF_APPROVAL_FORBIDDEN" },
    });
    await ok(approve(M, r.approvalRequestId));
    expect(await t.admin.transaction().execute((trx) => customerCredit(trx, A.orgId, G))).toBe(0);
    expect(await ledger("REV_FEE")).toBe(revBefore);
  });

  it("hai yêu cầu hoàn 300.000 trên số dư 500.000, duyệt đồng thời → đúng một hiệu lực, số dư không âm", async () => {
    const G = await person("Khách G2");
    const { paymentId } = await ok(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "bank_transfer",
          receivingAccountId: B1,
          amount: 500_000,
          payerPersonId: G,
          bankTxn: { ref: `FT${randomUUID().slice(0, 8)}`, occurredAt: "2026-10-15T03:00:00Z" },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    const ask = () =>
      ok(
        run(K, async (ctx) => ({
          data: await requestCreditRefund(ctx, {
            personId: G,
            propertyId: A.propertyId,
            amount: 300_000,
            reason: "trả lại",
            refund: { method: "bank_transfer", receivingAccountId: B1 },
          }),
        })),
      );
    const [a, b] = [await ask(), await ask()];
    const rs = await Promise.all([approve(O, a.approvalRequestId), approve(M, b.approvalRequestId)]);
    expect(rs.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(await t.admin.transaction().execute((trx) => customerCredit(trx, A.orgId, G))).toBe(200_000);
  });
});
