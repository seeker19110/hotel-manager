// PLAN đợt 2 T-111 — báo trả + thanh lý trên Postgres thật (SPEC-lease S-016…S-019, S-021, S-025; INV-F5, INV-F1).
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
import { receiveDeposit } from "../deposits/deposits.ts";
import { allocatePayment, confirmPayment, recordPayment } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { activateLease, recordHandover } from "./handover.ts";
import { createDraft, getLease, signLease, submitForSignature } from "./lease.ts";
import {
  approveSettlement,
  closeLease,
  defaultDeductions,
  giveNotice,
  prepareSettlement,
} from "./settlement.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let M2: Actor;
let K: Actor;
let F: Actor;
let B1: string;

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${person}, ${A.orgId}, ${role}, '0100000000')`.execute(
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

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "lease_settlement.test", idempotencyKey: key, payload: { key }, correlationId: "c-settle" },
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
  return r.problem as { code: string; status: number; errors?: { field: string }[] };
}

/** Hợp đồng `active` có cọc `deposit` (nhận + xác nhận) và AR mở `ar` (phiếu liên kết). */
async function rentedLease(deposit: number, ar: number) {
  const unitId = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${unitId}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, ${`S${unitId.slice(0, 6)}`})`.execute(
    t.admin,
  );
  await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'electric', '2026-01-01', 1000)`.execute(
    t.admin,
  );
  const rep = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${rep}, ${A.orgId}, 'Người thuê L1', '0100001111')`.execute(
    t.admin,
  );
  const terms = {
    effectiveFrom: "2026-11-01",
    effectiveTo: "2027-10-31",
    rentAmount: 3_000_000,
    depositAmount: deposit,
    services: [],
  };
  const { leaseId } = await ok(
    run(M, async (ctx) => ({
      data: await createDraft(ctx, {
        unitId,
        representativePersonId: rep,
        billingStartOn: "2026-11-01",
        terms,
      }),
    })),
  );
  await ok(run(M, async (ctx) => ({ data: await submitForSignature(ctx, { leaseId }) })));
  await ok(
    run(M, async (ctx) => ({
      data: await signLease(ctx, { leaseId, signerPersonId: rep, now: new Date("2026-10-20T03:00:00Z") }),
    })),
  );
  const handover = (kind: "move_in" | "move_out", on: string, value: number) =>
    run(F, async (ctx) => ({
      data: await recordHandover(ctx, {
        leaseId,
        kind,
        handedOverOn: on,
        readings: { electric: value },
        assets: [{ name: "Giường", quantity: 1, condition: "Tốt" }],
        keysCount: 2,
        photoFileIds: [],
        tenantConfirmation: { method: "in_person" },
      }),
    }));
  await ok(handover("move_in", "2026-11-01", 1250));
  await ok(run(M, async (ctx) => ({ data: await activateLease(ctx, { leaseId }) })));
  let depositId: string | null = null;
  if (deposit > 0) {
    const d = await ok(
      run(K, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          leaseId,
          propertyId: A.propertyId,
          payerPersonId: rep,
          amount: deposit,
          method: "bank_transfer",
          receivingAccountId: B1,
          bankTxn: { ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: new Date().toISOString() },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: d.paymentId }) })));
    depositId = d.depositId;
  }
  let invoiceId: string | null = null;
  if (ar > 0) {
    invoiceId = (
      await seedIssuedInvoice(t.admin, {
        orgId: A.orgId,
        propertyId: A.propertyId,
        payerPersonId: rep,
        leaseId,
        lines: [{ amount: ar }],
      })
    ).invoiceId;
  }
  return {
    leaseId,
    rep,
    depositId,
    invoiceId,
    moveOut: (on = "2027-03-15") => handover("move_out", on, 1400),
  };
}

const ledgerOf = async (sourceIds: string[]) =>
  (
    await sql<{ entry_type: string; account: string; debit: string; credit: string }>`
      select e.entry_type, l.account, l.debit, l.credit from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.source_doc_id = any(${sourceIds}::uuid[])
      order by array_position(array['invoice_issued','deposit_deducted','deposit_refunded'], e.entry_type), e.id, l.line_no`.execute(
      t.admin,
    )
  ).rows.map((r) => [r.entry_type, r.account, Number(r.debit), Number(r.credit)]);

const depositBalance = async (leaseId: string) =>
  Number(
    (
      await sql<{
        b: string;
      }>`select coalesce(sum(balance), 0)::text as b from deposits where lease_id = ${leaseId}`.execute(
        t.admin,
      )
    ).rows[0]?.b,
  );

const openAr = async (leaseId: string) =>
  Number(
    (
      await sql<{
        s: string;
      }>`select coalesce(sum(open_amount), 0)::text as s from invoices where lease_id = ${leaseId}`.execute(
        t.admin,
      )
    ).rows[0]?.s,
  );

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ thanh lý", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  M2 = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
  B1 = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${B1}, ${A.orgId}, ${A.propertyId}, 'VCB', '****0001', '1010000001', 'CHU TRO')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("S-016…S-019 báo trả và thanh lý", () => {
  it("S-016: báo trả → notice_given, allocation chưa đổi", async () => {
    const { leaseId } = await rentedLease(0, 0);
    const before = await sql<{
      during: string;
    }>`select during::text from allocations where source_id = ${leaseId} and active`.execute(t.admin);
    await ok(
      run(M, async (ctx) => ({ data: await giveNotice(ctx, { leaseId, plannedMoveOutOn: "2027-03-15" }) })),
    );
    const l = await getLease(t.runtime, M, leaseId);
    expect(l).toMatchObject({ status: "notice_given", planned_move_out_on: "2027-03-15" });
    const after = await sql<{
      during: string;
    }>`select during::text from allocations where source_id = ${leaseId} and active`.execute(t.admin);
    expect(after.rows).toEqual(before.rows);
  });

  it("S-017/S-018/S-019: phí thành phiếu trước, khấu trừ ≤ AR, hoàn phần còn lại; chưa duyệt thì không bút toán, không đóng; người lập không tự duyệt", async () => {
    const L = await rentedLease(3_000_000, 1_580_000);
    await ok(
      run(M, async (ctx) => ({
        data: await giveNotice(ctx, { leaseId: L.leaseId, plannedMoveOutOn: "2027-03-15" }),
      })),
    );
    // Chưa bàn giao trả → chưa lập quyết toán được.
    expect(
      await fails(
        run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
      ),
    ).toMatchObject({ code: "HANDOVER_REQUIRED" });
    await ok(L.moveOut());
    expect(await getLease(t.runtime, M, L.leaseId)).toMatchObject({
      status: "settling",
      moved_out_on: "2027-03-15",
    });
    const sum = await ok(
      run(M, async (ctx) => ({
        data: await prepareSettlement(ctx, {
          leaseId: L.leaseId,
          fees: [{ amount: 200_000, reason: "Vỡ gương nhà tắm" }],
        }),
      })),
    );
    expect(sum).toMatchObject({
      outstandingAr: 1_580_000,
      depositBalance: 3_000_000,
      feesTotal: 200_000,
      deductionsTotal: 1_780_000,
      refundAmount: 1_220_000,
      debtAfter: 0,
    });
    // S-018: chưa duyệt → không bút toán DEPOSIT_LIAB phía Nợ, không đóng được.
    const liab = await sql<{ n: number }>`
      select count(*)::int as n from journal_lines where deposit_id = ${L.depositId} and debit > 0`.execute(
      t.admin,
    );
    expect(liab.rows[0]?.n).toBe(0);
    expect(
      await fails(run(M, async (ctx) => ({ data: await closeLease(ctx, { leaseId: L.leaseId }) }))),
    ).toMatchObject({
      code: "SETTLEMENT_REQUIRED",
      status: 409,
    });
    const direct = await sql`update leases set status = 'closed' where id = ${L.leaseId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect((direct as { hint?: string }).hint).toBe("SETTLEMENT_REQUIRED");
    // S-019 + kế toán không duyệt.
    expect(
      await fails(
        run(M, async (ctx) => ({ data: await approveSettlement(ctx, { settlementId: sum.settlementId }) })),
      ),
    ).toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN", status: 403 });
    expect(
      (
        await fails(
          run(K, async (ctx) => ({ data: await approveSettlement(ctx, { settlementId: sum.settlementId }) })),
        )
      ).status,
    ).toBe(403);
    // Hoàn > 0 cần chọn cách hoàn.
    expect(
      (
        await fails(
          run(O, async (ctx) => ({ data: await approveSettlement(ctx, { settlementId: sum.settlementId }) })),
        )
      ).errors?.[0]?.field,
    ).toBe("refund.method");
    const r = await ok(
      run(O, async (ctx) => ({
        data: await approveSettlement(ctx, {
          settlementId: sum.settlementId,
          refund: { method: "bank_transfer", receivingAccountId: B1 },
        }),
      })),
    );
    expect(await ledgerOf([r.feeInvoiceId as string, sum.settlementId])).toEqual([
      ["invoice_issued", "AR", 200_000, 0],
      ["invoice_issued", "REV_FEE", 0, 200_000],
      ["deposit_deducted", "DEPOSIT_LIAB", 1_780_000, 0],
      ["deposit_deducted", "AR", 0, 1_580_000],
      ["deposit_deducted", "AR", 0, 200_000],
      ["deposit_refunded", "DEPOSIT_LIAB", 1_220_000, 0],
      ["deposit_refunded", "BANK", 0, 1_220_000],
    ]);
    expect(await depositBalance(L.leaseId)).toBe(0);
    expect(await openAr(L.leaseId)).toBe(0);
    const fee = await sql<{
      lease_id: string;
      kind: string;
    }>`select lease_id, kind from invoices where id = ${r.feeInvoiceId}`.execute(t.admin);
    expect(fee.rows[0]).toEqual({ lease_id: L.leaseId, kind: "fee" });
    // Quyết toán đã duyệt bất biến; duyệt lại → 409.
    expect(
      await fails(
        run(O, async (ctx) => ({ data: await approveSettlement(ctx, { settlementId: sum.settlementId }) })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    await ok(run(O, async (ctx) => ({ data: await closeLease(ctx, { leaseId: L.leaseId }) })));
    expect((await getLease(t.runtime, M, L.leaseId)).status).toBe("closed");
    const al = await sql<{
      upper: Date;
    }>`select upper(during) as upper from allocations where source_id = ${L.leaseId} and active`.execute(
      t.admin,
    );
    expect(al.rows[0]?.upper.toISOString()).toBe("2027-03-15T17:00:00.000Z");
  });
});

describe("S-021 quyết toán cọc (Scenario Outline)", () => {
  const rows: [number, number, number, number, number, number][] = [
    [3_000_000, 1_580_000, 200_000, 1_780_000, 1_220_000, 0],
    [3_000_000, 0, 0, 0, 3_000_000, 0],
    [0, 1, 0, 0, 0, 1],
    [3_000_000, 3_580_000, 0, 3_000_000, 0, 580_000],
    [1, 1, 0, 1, 0, 0],
    [100_000, 0, 200_000, 100_000, 0, 100_000],
    [3_000_000, 0, 200_000, 200_000, 2_800_000, 0],
  ];
  it.each(rows)(
    "cọc %d, nợ %d, phí %d → khấu trừ %d, hoàn %d, nợ sau %d",
    async (coc, no, phi, khauTru, hoan, noSau) => {
      expect(
        defaultDeductions(coc, no > 0 ? [{ id: "i", open: no }] : [], phi).reduce((s, d) => s + d.amount, 0),
      ).toBe(khauTru);
      const L = await rentedLease(coc, no);
      await ok(L.moveOut());
      const sum = await ok(
        run(M, async (ctx) => ({
          data: await prepareSettlement(ctx, {
            leaseId: L.leaseId,
            fees: phi > 0 ? [{ amount: phi, reason: "Hư hỏng" }] : [],
          }),
        })),
      );
      expect([sum.deductionsTotal, sum.refundAmount, sum.debtAfter]).toEqual([khauTru, hoan, noSau]);
      await ok(
        run(O, async (ctx) => ({
          data: await approveSettlement(ctx, {
            settlementId: sum.settlementId,
            refund: { method: "bank_transfer", receivingAccountId: B1 },
          }),
        })),
      );
      expect(await depositBalance(L.leaseId)).toBe(0);
      expect(await openAr(L.leaseId)).toBe(noSau);
    },
  );
});

describe("S-025 và ca biên", () => {
  it("S-025: khai khấu trừ vượt AR còn mở → 422 deductions[0].amount; sửa đúng → hoàn phần còn lại", async () => {
    const L = await rentedLease(3_000_000, 1_000_000);
    await ok(L.moveOut());
    const over = await fails(
      run(M, async (ctx) => ({
        data: await prepareSettlement(ctx, {
          leaseId: L.leaseId,
          fees: [],
          deductions: [{ invoiceId: L.invoiceId, amount: 1_500_000, reason: "Trừ nợ" }],
        }),
      })),
    );
    expect(over).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(over.errors?.[0]?.field).toBe("deductions[0].amount");
    const okSum = await ok(
      run(M, async (ctx) => ({
        data: await prepareSettlement(ctx, {
          leaseId: L.leaseId,
          fees: [],
          deductions: [{ invoiceId: L.invoiceId, amount: 1_000_000, reason: "Trừ nợ" }],
        }),
      })),
    );
    expect(okSum).toMatchObject({ deductionsTotal: 1_000_000, refundAmount: 2_000_000 });
  });

  it("số liệu đổi sau khi lập (khách trả nợ) → duyệt bị từ chối, lập lại", async () => {
    const L = await rentedLease(1_000_000, 500_000);
    await ok(L.moveOut());
    const sum = await ok(
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
    );
    const { paymentId } = await ok(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: A.propertyId,
          method: "bank_transfer",
          amount: 500_000,
          payerPersonId: L.rep,
          receivingAccountId: B1,
          bankTxn: { ref: `FT${randomUUID().slice(0, 10)}`, occurredAt: new Date().toISOString() },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    await ok(
      run(K, async (ctx) => ({
        data: await allocatePayment(ctx, {
          paymentId,
          allocations: [{ invoiceId: L.invoiceId as string, amount: 500_000 }],
        }),
      })),
    );
    expect(
      await fails(
        run(O, async (ctx) => ({
          data: await approveSettlement(ctx, {
            settlementId: sum.settlementId,
            refund: { method: "bank_transfer", receivingAccountId: B1 },
          }),
        })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    const again = await ok(
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
    );
    expect(again).toMatchObject({
      settlementId: sum.settlementId,
      deductionsTotal: 0,
      refundAmount: 1_000_000,
    });
  });

  it("quản lý duyệt hoàn vượt hạn mức 5.000.000 → 403 APPROVAL_LIMIT_EXCEEDED; chủ duyệt được", async () => {
    const L = await rentedLease(6_000_000, 0);
    await ok(L.moveOut());
    const sum = await ok(
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
    );
    const refund = { method: "bank_transfer" as const, receivingAccountId: B1 };
    expect(
      await fails(
        run(M2, async (ctx) => ({
          data: await approveSettlement(ctx, { settlementId: sum.settlementId, refund }),
        })),
      ),
    ).toMatchObject({ code: "APPROVAL_LIMIT_EXCEEDED", status: 403 });
    await ok(
      run(O, async (ctx) => ({
        data: await approveSettlement(ctx, { settlementId: sum.settlementId, refund }),
      })),
    );
  });
});

describe("review lát hợp đồng — hồi quy", () => {
  it("🔴1: nợ mới phát sinh sau khi lập quyết toán → duyệt bị từ chối; lập lại khấu trừ đủ", async () => {
    const L = await rentedLease(3_000_000, 1_000_000);
    await ok(L.moveOut());
    const first = await ok(
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
    );
    expect(first).toMatchObject({ deductionsTotal: 1_000_000, refundAmount: 2_000_000 });
    await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: L.rep,
      leaseId: L.leaseId,
      lines: [{ amount: 1_500_000 }],
    });
    const refund = { method: "bank_transfer" as const, receivingAccountId: B1 };
    expect(
      await fails(
        run(O, async (ctx) => ({
          data: await approveSettlement(ctx, { settlementId: first.settlementId, refund }),
        })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await depositBalance(L.leaseId)).toBe(3_000_000);
    const again = await ok(
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: L.leaseId, fees: [] }) })),
    );
    expect(again).toMatchObject({ deductionsTotal: 2_500_000, refundAmount: 500_000, debtAfter: 0 });
    await ok(
      run(O, async (ctx) => ({
        data: await approveSettlement(ctx, { settlementId: again.settlementId, refund }),
      })),
    );
    expect(await openAr(L.leaseId)).toBe(0);
  });

  it("🟠2/🟠3: ngày trả phòng trước ngày nhận phòng → 422; chỉ số bàn giao đã xác nhận bất biến", async () => {
    const L = await rentedLease(0, 0);
    const p = await fails(L.moveOut("2026-10-25"));
    expect(p.errors?.[0]?.field).toBe("handed_over_on");
    const r = await sql<{ id: string }>`
      select r.id from meter_readings r join handovers h on h.id = r.handover_id where h.lease_id = ${L.leaseId}`.execute(
      t.admin,
    );
    await expect(
      sql`update meter_readings set value = 0 where id = ${r.rows[0]?.id}`.execute(t.admin),
    ).rejects.toMatchObject({
      hint: "DOCUMENT_IMMUTABLE",
    });
  });

  it("🟠7: người thuê xem hợp đồng kèm biên bản bàn giao; 🟢9: lễ tân không sửa hợp đồng ngoài việc trả phòng", async () => {
    const L = await rentedLease(0, 0);
    const user = await seedAuthUser(t.admin, `tenant+${randomUUID().slice(0, 6)}@example.test`);
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${randomUUID()}, ${A.orgId}, ${user}, ${L.rep}, 'tenant')`.execute(t.admin);
    const T = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
    const view = await getLease(t.runtime, T, L.leaseId);
    expect(view.handovers.map((h) => h.kind)).toEqual(["move_in"]);
    const asF = await t.runtime
      .transaction()
      .execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${F.membershipId}, true)`.execute(
          trx,
        );
        await sql`update leases set planned_move_out_on = '2027-01-01' where id = ${L.leaseId}`.execute(trx);
      })
      .catch((e: unknown) => e);
    expect((asF as { hint?: string }).hint).toBe("FORBIDDEN");
  });
});
