// Hồi quy theo review độc lập lát tiền (T-104…T-108): mỗi phát hiện một test tái hiện đường lỗi, chạy trên Postgres thật.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { decideApproval } from "../approvals/approvals.ts";
import { receiveDeposit, requestCreditRefund, requestDeduction } from "../deposits/deposits.ts";
import { ingestBankEvent } from "../ledger/bank-inbox.ts";
import { issueAdjustment, lockPeriod } from "../ledger/period-close.ts";
import { executeCommand } from "../pipeline/command.ts";
import { closeShift, openShift, reassignDiscrepancy } from "../shifts/shifts.ts";
import { allocatePayment, confirmPayment, recordPayment, reversePayment } from "./payments.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let K: Actor;
let F: Actor;
let HK: Actor;
let B1: string;
let P2: string;

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
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "review.test", idempotencyKey: key, payload: { key }, correlationId: "c-review" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as { code: string; status: number };
}

const txn = () => ({ ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: new Date().toISOString() });

async function transferPaid(payer: string, amount: number, propertyId = A.propertyId, account = B1) {
  const { paymentId } = await ok(
    run(K, async (ctx) => ({
      data: await recordPayment(ctx, {
        propertyId,
        method: "bank_transfer",
        amount,
        payerPersonId: payer,
        receivingAccountId: account,
        bankTxn: txn(),
      }),
    })),
  );
  await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
  return paymentId;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ review", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
  HK = await member("housekeeping");
  B1 = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${B1}, ${A.orgId}, ${A.propertyId}, 'VCB', '****0001', '1010000001', 'CHU TRO')`.execute(
    t.admin,
  );
  P2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${P2}, ${A.orgId}, 'CS2', 'rental')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("review lát tiền — hồi quy", () => {
  it("R1 🔴: đã hoàn CUSTOMER_CREDIT thì không phân bổ lại chính khoản thu đó được", async () => {
    const G = await person("Khách G");
    const pid = await transferPaid(G, 500_000);
    const { approvalRequestId } = await ok(
      run(K, async (ctx) => ({
        data: await requestCreditRefund(ctx, {
          personId: G,
          propertyId: A.propertyId,
          amount: 500_000,
          reason: "Huỷ đặt phòng",
          refund: { method: "bank_transfer", receivingAccountId: B1 },
        }),
      })),
    );
    await ok(
      run(M, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId, decision: "approve" }),
      })),
    );
    const I = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: G,
      lines: [{ amount: 500_000 }],
    });
    const p = await fails(
      run(K, async (ctx) => ({
        data: await allocatePayment(ctx, {
          paymentId: pid,
          allocations: [{ invoiceId: I.invoiceId, amount: 500_000 }],
        }),
      })),
    );
    expect(p).toMatchObject({ code: "OVER_ALLOCATION", status: 409 });
    const credit = await sql<{ b: string }>`
      select coalesce(sum(credit - debit), 0)::text as b from journal_lines where account = 'CUSTOMER_CREDIT' and person_id = ${G}`.execute(
      t.admin,
    );
    expect(credit.rows[0]?.b).toBe("0");
  });

  it("R2 🟠: khoản tiền mặt ghi nhận hôm trước, kỳ hôm trước đã khoá → vẫn xác nhận được, bút toán ghi ngày xác nhận", async () => {
    const payer = await person("Khách tiền mặt");
    const { shiftId } = await ok(
      run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    const today = (
      await sql<{ d: string }>`select app.business_date(${A.orgId}, ${A.propertyId})::text as d`.execute(
        t.admin,
      )
    ).rows[0]?.d as string;
    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const pid = randomUUID();
    await sql`insert into payments (id, organization_id, property_id, method, purpose, amount, payer_person_id, shift_id,
                                    business_date, recorded_by)
              values (${pid}, ${A.orgId}, ${A.propertyId}, 'cash', 'receivable', 200000, ${payer}, ${shiftId},
                      ${yesterday}::date, ${F.membershipId})`.execute(t.admin);
    await ok(
      run(K, async (ctx) => ({
        data: await lockPeriod(ctx, { propertyId: A.propertyId, lockedThrough: yesterday, reason: "Chốt" }),
      })),
    );
    await ok(run(F, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: pid }) })));
    const e = await sql<{ business_date: string }>`
      select business_date::text from journal_entries where source_doc_id = ${pid}`.execute(t.admin);
    expect(e.rows).toEqual([{ business_date: today }]);
    await ok(run(F, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 200_000 }) })));
  });

  // Ghi chú: phần "đóng ca chờ" ở đây được bảo đảm cả bởi khoá KEY SHARE của FK journal_lines.shift_id; sửa R3 (FOR SHARE ở
  // bước kiểm ca mở) đóng kẽ hở "kiểm → ca bị đóng → chèn" mà test tuần tự không chen vào được (đã thử đột biến).
  it("R3 🟠: đóng ca chờ lệnh ghi tiền mặt đang chạy trong ca rồi mới tính tiền dự kiến (INV-F6)", async () => {
    const F2 = await member("front_desk");
    const payer = await person("Khách đảo");
    const { shiftId } = await ok(
      run(F2, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
    );
    const { paymentId } = await ok(
      run(F2, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "cash",
          amount: 300_000,
          payerPersonId: payer,
        }),
      })),
    );
    await ok(run(F2, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reversedInside = false;
    const reversing = run(O, async (ctx) => {
      const data = await reversePayment(ctx, { paymentId, reason: "Khách đổi ý" });
      reversedInside = true;
      await gate; // giữ transaction mở, khoá FOR SHARE trên ca vẫn còn
      return { data };
    });
    while (!reversedInside) await new Promise((r) => setTimeout(r, 20));
    let closedAt = 0;
    const closing = run(F2, async (ctx) => ({
      data: await closeShift(ctx, { shiftId, countedCash: 0 }),
    })).then((r) => {
      closedAt = Date.now();
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(closedAt).toBe(0); // đóng ca đang chờ
    release();
    await ok(reversing);
    const closed = await ok(closing);
    expect(closed).toMatchObject({ expectedCash: 0, difference: 0, discrepancyId: null });
  });

  it("R4 🟠: kế toán không duyệt điều chỉnh (SPEC-ledger mục 10: chỉ lập đề nghị)", async () => {
    const payer = await person("Khách điều chỉnh");
    const I = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      lines: [{ amount: 400_000 }],
    });
    const { approvalRequestId } = await ok(
      run(M, async (ctx) => ({
        data: await issueAdjustment(ctx, { invoiceId: I.invoiceId, amount: 100_000, reason: "Giảm" }),
      })),
    );
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await decideApproval(ctx, { approvalRequestId, decision: "approve" }),
        })),
      ),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await ok(
      run(O, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId, decision: "approve" }),
      })),
    );
  });

  it("R5 🟠 + 🟢12: người chịu trách nhiệm không sửa được chênh lệch; số tiền bất biến; gán lại chỉ cho nhân viên của cơ sở", async () => {
    const F3 = await member("front_desk");
    const { shiftId } = await ok(
      run(F3, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 100_000 }),
      })),
    );
    const c = await ok(
      run(F3, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 50_000 }) })),
    );
    const id = c.discrepancyId as string;
    const asF3 = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${F3.membershipId}, true)`.execute(
        trx,
      );
      return (await sql`update shift_discrepancies set amount = -1 where id = ${id}`.execute(trx))
        .numAffectedRows;
    });
    expect(Number(asF3)).toBe(0);
    await expect(
      sql`update shift_discrepancies set amount = -1 where id = ${id}`.execute(t.admin),
    ).rejects.toMatchObject({
      hint: "DOCUMENT_IMMUTABLE",
    });
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await reassignDiscrepancy(ctx, {
            discrepancyId: id,
            responsibleMembershipId: HK.membershipId,
            reason: "x",
          }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    await ok(
      run(M, async (ctx) => ({
        data: await reassignDiscrepancy(ctx, {
          discrepancyId: id,
          responsibleMembershipId: F.membershipId,
          reason: "Ca giao nhầm",
        }),
      })),
    );
  });

  it("R6 🟠: cọc đặt phòng không khấu trừ được vào phiếu của người khác", async () => {
    const X = await person("Khách X");
    const Y = await person("Người thuê Y");
    const { reservationId } = await seedReservation(t.admin, { org: A, bookerPersonId: X });
    const dep = await ok(
      run(K, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          reservationId,
          propertyId: A.propertyId,
          payerPersonId: X,
          amount: 1_000_000,
          method: "bank_transfer",
          receivingAccountId: B1,
          bankTxn: txn(),
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: dep.paymentId }) })));
    const { leaseId } = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: Y,
    });
    const I = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: Y,
      leaseId,
      lines: [{ amount: 500_000 }],
    });
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await requestDeduction(ctx, {
            depositId: dep.depositId,
            invoiceId: I.invoiceId,
            amount: 500_000,
            reason: "x",
          }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it("R7 🟠: không hoàn ở cơ sở này số dư khách gửi ở cơ sở khác", async () => {
    const G = await person("Khách hai cơ sở");
    const B2 = randomUUID();
    await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
              values (${B2}, ${A.orgId}, ${P2}, 'VCB', '****0002', '1010000002', 'CHU TRO')`.execute(t.admin);
    await transferPaid(G, 700_000, P2, B2);
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await requestCreditRefund(ctx, {
            personId: G,
            propertyId: A.propertyId,
            amount: 700_000,
            reason: "Hoàn",
            refund: { method: "bank_transfer", receivingAccountId: B1 },
          }),
        })),
      ),
    ).toMatchObject({ code: "REFUND_EXCEEDS_BALANCE" });
  });

  it("🟢10: giao dịch đang có break HASH_MISMATCH thì không ghi tay thành thanh toán", async () => {
    const ref = `FT${randomUUID().slice(0, 10)}`;
    const ev = (amount: number, source: "webhook" | "statement") => ({
      provider: source === "webhook" ? "sim" : "statement_csv",
      account: B1,
      providerEventId: `${source}-${ref}`,
      raw: { ref, amount },
      signatureVerified: source === "webhook",
      source,
      txn: { ref, amount, occurredAt: new Date() },
    });
    await ingestBankEvent(t.runtime, ev(100_000, "webhook"));
    await expect(ingestBankEvent(t.runtime, ev(120_000, "statement"))).rejects.toMatchObject({
      code: "INBOX_HASH_MISMATCH",
    });
    const payer = await person("Khách lệch");
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await recordPayment(ctx, {
            propertyId: A.propertyId,
            method: "bank_transfer",
            amount: 100_000,
            payerPersonId: payer,
            receivingAccountId: B1,
            bankTxn: { ref, occurredAt: new Date().toISOString() },
          }),
        })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });
});
