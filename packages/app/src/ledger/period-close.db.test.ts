// PLAN đợt 2 T-108 — chốt kỳ, điều chỉnh, báo cáo trên Postgres thật (SPEC-ledger S-022…S-024, S-032; INV-F6, INV-G4).
// Ngày trong test tính tương đối theo ngày kinh doanh của cơ sở (không phụ thuộc đồng hồ máy chạy CI).
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
import { receiveDeposit } from "../deposits/deposits.ts";
import { allocatePayment, confirmPayment, recordPayment, reversePayment } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import { financialSummary, issueAdjustment, lockPeriod, unlockPeriod } from "./period-close.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let K: Actor;
let F: Actor;
let HK: Actor;
const memberships: { id: string; scoped: boolean; user: string }[] = [];
const resolve = (user: string) =>
  resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });

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
  memberships.push({ id: membership, scoped: role !== "accountant", user });
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

/** Cơ sở mới (khoá kỳ theo cơ sở — mỗi test một cơ sở để không dính nhau), mọi nhân viên có phạm vi. */
async function newProperty(): Promise<string> {
  const id = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${id}, ${A.orgId}, ${`CS ${id.slice(0, 6)}`}, 'rental')`.execute(
    t.admin,
  );
  for (const m of memberships.filter((x) => x.scoped)) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${m.id}, ${id})`.execute(t.admin);
  }
  // Phạm vi nằm trong actor lúc resolve (như mỗi request) → resolve lại sau khi thêm cơ sở.
  const again = (a: Actor) => resolve(memberships.find((m) => m.id === a.membershipId)?.user as string);
  M = await again(M);
  F = await again(F);
  HK = await again(HK);
  return id;
}

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${id}, ${A.orgId}, ${name})`.execute(
    t.admin,
  );
  return id;
}

async function account(propertyId: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${id}, ${A.orgId}, ${propertyId}, 'VCB', '****0001', ${`10${id.replaceAll(/\D/g, "").slice(0, 8)}`}, 'CHU TRO')`.execute(
    t.admin,
  );
  return id;
}

/** Ngày kinh doanh hôm nay của cơ sở − n ngày. */
async function day(propertyId: string, minus = 0): Promise<string> {
  const r = await sql<{ d: string }>`
    select (app.business_date(${A.orgId}, ${propertyId}) - ${minus}::int)::text as d`.execute(t.admin);
  return r.rows[0]?.d as string;
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "period.test", idempotencyKey: key, payload: { key }, correlationId: "c-period" },
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

const lock = (a: Actor, propertyId: string, lockedThrough: string, reason = "Chốt sổ tháng") =>
  run(a, async (ctx) => ({ data: await lockPeriod(ctx, { propertyId, lockedThrough, reason }) }));
const unlock = (a: Actor, propertyId: string, from: string, reason: string) =>
  run(a, async (ctx) => ({ data: await unlockPeriod(ctx, { propertyId, from, reason }) }));

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ chốt kỳ", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
  HK = await member("housekeeping");
});

afterAll(async () => {
  await t.drop();
});

describe("S-032 ai được chốt kỳ", () => {
  it("kế toán và quản lý chốt được (có người khoá, lý do, audit); lễ tân 403; khoá chỉ tiến, chỉ ngày đã qua", async () => {
    const P = await newProperty();
    const [d40, d10, d20, today] = [await day(P, 40), await day(P, 10), await day(P, 20), await day(P)];
    expect(await fails(lock(F, P, d10))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    const k = await ok(lock(K, P, d40, "Chốt kỳ 09"));
    const m = await ok(lock(M, P, d10, "Chốt kỳ 10"));
    const rows = await sql<{ id: string; locked_by: string; reason: string; locked_through: string }>`
      select id, locked_by, reason, locked_through::text from period_locks where property_id = ${P} order by locked_through`.execute(
      t.admin,
    );
    expect(rows.rows).toEqual([
      { id: k.periodLockId, locked_by: K.membershipId, reason: "Chốt kỳ 09", locked_through: d40 },
      { id: m.periodLockId, locked_by: M.membershipId, reason: "Chốt kỳ 10", locked_through: d10 },
    ]);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'period.locked' and property_id = ${P}`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(2);
    expect(await fails(lock(K, P, d20))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    expect(await fails(lock(K, P, today))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await fails(lock(K, P, "2026-02-30"))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await fails(lock(K, P, await day(P, 5), "  "))).toMatchObject({ code: "VALIDATION_FAILED" });
    // Buồng phòng không thấy cơ sở trong ma trận chốt kỳ.
    expect((await fails(lock(HK, P, await day(P, 5)))).status).toBe(403);
  });

  it("chốt đồng thời cùng cơ sở được tuần tự hoá: khoá cuối cùng là ngày lớn nhất, không trùng lặp", async () => {
    const P = await newProperty();
    const dates = await Promise.all([30, 25, 20, 15, 10].map((n) => day(P, n)));
    const results = await Promise.all(dates.map((d) => lock(K, P, d)));
    expect(results.some((r) => r.status === "committed")).toBe(true);
    const eff = await sql<{ d: string }>`select app.locked_through(${A.orgId}, ${P})::text as d`.execute(
      t.admin,
    );
    expect(eff.rows[0]?.d).toBe(dates.at(-1));
  });
});

describe("S-022 chốt kỳ và điều chỉnh sau khoá (INV-F6)", () => {
  it("ghi vào kỳ đã khoá → 409 PERIOD_LOCKED (thanh toán và bút toán, mọi vai trò kể cả worker)", async () => {
    const P = await newProperty();
    const B = await account(P);
    const payer = await person("Người thuê khoá");
    const d3 = await day(P, 3);
    await ok(lock(K, P, await day(P, 2)));
    // Thanh toán/bút toán có business_date trong kỳ khoá bị CSDL từ chối, map 409 PERIOD_LOCKED.
    const directPayment = t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${K.membershipId}, true)`.execute(
        trx,
      );
      await sql`insert into payments (id, organization_id, property_id, method, purpose, amount, receiving_account_id,
                                      payer_person_id, business_date, recorded_by)
                values (${randomUUID()}, ${A.orgId}, ${P}, 'bank_transfer', 'receivable', 1000, ${B}, ${payer}, ${d3}::date,
                        ${K.membershipId})`.execute(trx);
    });
    const err = await directPayment.catch((e: unknown) => e);
    expect(toProblem(err)).toMatchObject({ code: "PERIOD_LOCKED", status: 409 });
    for (const db of [t.runtime, t.worker]) {
      const e = await db
        .transaction()
        .execute(async (trx) => {
          await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
          await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                    values (${randomUUID()}, ${A.orgId}, ${P}, 'adjustment', ${d3}::date, 'test', ${randomUUID()})`.execute(
            trx,
          );
        })
        .catch((x: unknown) => x);
      expect((e as { hint?: string }).hint).toBe("PERIOD_LOCKED");
    }
    // Khoá phủ cả hôm nay (biên giờ chốt ngày): lệnh ghi thanh toán qua API → 409 PERIOD_LOCKED.
    await sql`insert into period_locks (id, organization_id, property_id, locked_through, locked_by, reason)
              values (${randomUUID()}, ${A.orgId}, ${P}, ${await day(P)}::date, ${A.ownerMembershipId}, 'biên')`.execute(
      t.admin,
    );
    const viaCommand = await fails(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: P,
          method: "bank_transfer",
          amount: 1000,
          payerPersonId: payer,
          receivingAccountId: B,
        }),
      })),
    );
    expect(viaCommand).toMatchObject({ code: "PERIOD_LOCKED", status: 409 });
  });

  it("biên giờ: 23:30 ngày 30/09 giờ VN (16:30Z) thuộc ngày kinh doanh 30/09", async () => {
    const r = await sql<{ d: string }>`
      select app.business_date(${A.orgId}, ${A.propertyId}, '2026-09-30T16:30:00Z')::text as d`.execute(
      t.admin,
    );
    expect(r.rows[0]?.d).toBe("2026-09-30");
  });

  it("điều chỉnh giảm 100.000 phiếu kỳ đã khoá: cần người khác duyệt, ghi vào kỳ mở, tham chiếu phiếu gốc; Nợ DISCOUNT / Có AR", async () => {
    const P = await newProperty();
    const payer = await person("Người thuê điều chỉnh");
    const d10 = await day(P, 10);
    const I1 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: P,
      payerPersonId: payer,
      lines: [{ amount: 3_000_000, revenueAccount: "REV_ROOM", kind: "room" }, { amount: 580_000 }],
      businessDate: d10,
    });
    await ok(lock(K, P, await day(P, 5), "Chốt kỳ 09"));

    const over = await fails(
      run(K, async (ctx) => ({
        data: await issueAdjustment(ctx, { invoiceId: I1.invoiceId, amount: 3_580_001, reason: "x" }),
      })),
    );
    expect(over).toMatchObject({ code: "OVER_ALLOCATION", status: 409 });
    const noReason = await fails(
      run(K, async (ctx) => ({
        data: await issueAdjustment(ctx, { invoiceId: I1.invoiceId, amount: 100_000, reason: " " }),
      })),
    );
    expect(noReason).toMatchObject({ code: "VALIDATION_FAILED" });
    const { approvalRequestId } = await ok(
      run(K, async (ctx) => ({
        data: await issueAdjustment(ctx, {
          invoiceId: I1.invoiceId,
          amount: 100_000,
          reason: "Giảm do mất nước 3 ngày",
        }),
      })),
    );
    // Chưa duyệt → chưa có bút toán, phiếu gốc không đổi.
    const before = await sql<{ open_amount: string; adjusted_total: string; total: string }>`
      select open_amount, adjusted_total, total from invoices where id = ${I1.invoiceId}`.execute(t.admin);
    expect(before.rows[0]).toEqual({ open_amount: "3580000", adjusted_total: "0", total: "3580000" });
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await decideApproval(ctx, { approvalRequestId, decision: "approve" }),
        })),
      ),
    ).toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN", status: 403 });
    await ok(
      run(O, async (ctx) => ({
        data: await decideApproval(ctx, { approvalRequestId, decision: "approve" }),
      })),
    );

    const after = await sql<{ open_amount: string; adjusted_total: string; total: string }>`
      select open_amount, adjusted_total, total from invoices where id = ${I1.invoiceId}`.execute(t.admin);
    expect(after.rows[0]).toEqual({ open_amount: "3480000", adjusted_total: "-100000", total: "3580000" });
    const adj = await sql<{ id: string; kind: string; total: string; number: string; business_date: string }>`
      select id, kind, total, number, business_date::text from invoices where adjusts_invoice_id = ${I1.invoiceId}`.execute(
      t.admin,
    );
    expect(adj.rows).toHaveLength(1);
    expect(adj.rows[0]).toMatchObject({ kind: "adjustment", total: "-100000", business_date: await day(P) });
    expect(adj.rows[0]?.number).toMatch(/^DC-\d{6}$/);
    const lines = await sql<{
      account: string;
      debit: string;
      credit: string;
      invoice_id: string;
      business_date: string;
    }>`
      select l.account, l.debit, l.credit, l.invoice_id, e.business_date::text from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where e.entry_type = 'adjustment' and e.source_doc_id = ${adj.rows[0]?.id} order by l.line_no`.execute(
      t.admin,
    );
    expect(lines.rows).toEqual([
      {
        account: "DISCOUNT",
        debit: "100000",
        credit: "0",
        invoice_id: adj.rows[0]?.id,
        business_date: await day(P),
      },
      { account: "AR", debit: "0", credit: "100000", invoice_id: I1.invoiceId, business_date: await day(P) },
    ]);
    // Điều chỉnh của điều chỉnh → 422; phân bổ theo số còn sau điều chỉnh (INV-F2).
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await issueAdjustment(ctx, { invoiceId: adj.rows[0]?.id as string, amount: 1, reason: "x" }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    const B = await account(P);
    const { paymentId } = await ok(
      run(K, async (ctx) => ({
        data: await recordPayment(ctx, {
          propertyId: P,
          method: "bank_transfer",
          amount: 3_600_000,
          payerPersonId: payer,
          receivingAccountId: B,
          bankTxn: { ref: `FT${randomUUID().slice(0, 8)}`, occurredAt: new Date().toISOString() },
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
    expect(
      await fails(
        run(K, async (ctx) => ({
          data: await allocatePayment(ctx, {
            paymentId,
            allocations: [{ invoiceId: I1.invoiceId, amount: 3_480_001 }],
          }),
        })),
      ),
    ).toMatchObject({ code: "OVER_ALLOCATION" });
    await ok(
      run(K, async (ctx) => ({
        data: await allocatePayment(ctx, {
          paymentId,
          allocations: [{ invoiceId: I1.invoiceId, amount: 3_480_000 }],
        }),
      })),
    );
    const done = await sql<{
      open_amount: string;
    }>`select open_amount from invoices where id = ${I1.invoiceId}`.execute(t.admin);
    expect(done.rows[0]?.open_amount).toBe("0");
  });
});

describe("S-023 mở khoá kỳ", () => {
  it("chỉ owner, bắt buộc lý do; không xoá dòng; chứng từ đã phát hành vẫn bất biến; không khoá → 409", async () => {
    const P = await newProperty();
    const payer = await person("Người thuê mở khoá");
    const I1 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: P,
      payerPersonId: payer,
      lines: [{ amount: 500_000 }],
      businessDate: await day(P, 35),
    });
    const [d40, d30, d10] = [await day(P, 40), await day(P, 30), await day(P, 10)];
    const first = await ok(lock(K, P, d40));
    const second = await ok(lock(K, P, d10));
    expect(await fails(unlock(M, P, d30, "Sai số liệu"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(unlock(K, P, d30, "Sai số liệu"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(unlock(O, P, d30, ""))).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    const r = await ok(unlock(O, P, d30, "Khách khiếu nại hoá đơn tháng 9"));
    expect(r).toEqual({ releasedIds: [second.periodLockId], lockedThrough: d40 });
    const rows = await sql<{ id: string; released_by: string | null; release_reason: string | null }>`
      select id, released_by, release_reason from period_locks where property_id = ${P} order by locked_through`.execute(
      t.admin,
    );
    expect(rows.rows).toEqual([
      { id: first.periodLockId, released_by: null, release_reason: null },
      {
        id: second.periodLockId,
        released_by: O.membershipId,
        release_reason: "Khách khiếu nại hoá đơn tháng 9",
      },
    ]);
    const audit = await sql<{ reason: string }>`
      select reason from audit_events where action = 'period.unlocked' and entity_id = ${P}`.execute(t.admin);
    expect(audit.rows).toEqual([{ reason: "Khách khiếu nại hoá đơn tháng 9" }]);
    expect(await fails(unlock(O, P, d30, "lại"))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });

    // Mở khoá không cho sửa chứng từ đã phát hành (DOCUMENT_IMMUTABLE), không mở lại/xoá dòng khoá.
    const edit = await t.runtime
      .transaction()
      .execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${K.membershipId}, true)`.execute(
          trx,
        );
        await sql`update invoices set total = 400000 where id = ${I1.invoiceId}`.execute(trx);
      })
      .catch((e: unknown) => e);
    expect(toProblem(edit)).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    await expect(
      sql`update period_locks set released_at = null, released_by = null, release_reason = null where id = ${second.periodLockId}`.execute(
        t.admin,
      ),
    ).rejects.toMatchObject({ hint: "INVALID_TRANSITION" });
    await expect(
      sql`delete from period_locks where id = ${first.periodLockId}`.execute(t.admin),
    ).rejects.toThrow();
    await expect(
      sql`update invoices set adjusted_total = 0, allocated_total = 0 where id = ${I1.invoiceId}`.execute(
        t.admin,
      ),
    ).resolves.toBeDefined(); // không đổi giá trị → hợp lệ
    await expect(
      sql`update invoices set adjusted_total = 5 where id = ${I1.invoiceId}`.execute(t.admin),
    ).rejects.toThrow();
  });
});

describe("S-024 báo cáo tách tiền thu, doanh thu, cọc, nợ", () => {
  it("doanh thu 3.580.000 theo tài khoản; thu 2.000.000; nhận cọc 3.000.000 dòng riêng; nợ 1.580.000 khớp từng phiếu", async () => {
    const P = await newProperty();
    const B = await account(P);
    const payer = await person("Người thuê L1");
    const I1 = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: P,
      payerPersonId: payer,
      lines: [
        { amount: 3_000_000, revenueAccount: "REV_ROOM", kind: "room" },
        { amount: 480_000, revenueAccount: "REV_UTIL", kind: "utility" },
        { amount: 100_000, revenueAccount: "REV_FEE", kind: "fee" },
      ],
    });
    const txn = () => ({ ref: `FT${randomUUID().slice(0, 8)}`, occurredAt: new Date().toISOString() });
    const pay = async (amount: number) => {
      const { paymentId } = await ok(
        run(K, async (ctx) => ({
          data: await recordPayment(ctx, {
            propertyId: P,
            method: "bank_transfer",
            amount,
            payerPersonId: payer,
            receivingAccountId: B,
            bankTxn: txn(),
          }),
        })),
      );
      await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId }) })));
      return paymentId;
    };
    const p1 = await pay(2_000_000);
    await ok(
      run(K, async (ctx) => ({
        data: await allocatePayment(ctx, {
          paymentId: p1,
          allocations: [{ invoiceId: I1.invoiceId, amount: 2_000_000 }],
        }),
      })),
    );
    // Khoản thu bị đảo không tính vào tiền thu.
    const p2 = await pay(50_000);
    await ok(
      run(K, async (ctx) => ({
        data: await reversePayment(ctx, { paymentId: p2, reason: "Nhầm tài khoản" }),
      })),
    );
    const dep = await ok(
      run(K, async (ctx) => ({
        data: await receiveDeposit(ctx, {
          leaseId: randomUUID(),
          propertyId: P,
          payerPersonId: payer,
          amount: 3_000_000,
          method: "bank_transfer",
          receivingAccountId: B,
          bankTxn: txn(),
        }),
      })),
    );
    await ok(run(K, async (ctx) => ({ data: await confirmPayment(ctx, { paymentId: dep.paymentId }) })));

    const today = await day(P);
    const s = await financialSummary(t.runtime, O, { propertyId: P, from: await day(P, 15), to: today });
    expect(s.revenue).toEqual({
      by_account: { REV_ROOM: 3_000_000, REV_UTIL: 480_000, REV_FEE: 100_000 },
      discounts: 0,
      net: 3_580_000,
    });
    expect(s.cash_flow).toEqual({
      payments_received: 2_000_000,
      deposits_received: 3_000_000,
      refunds_paid: 0,
    });
    expect(s.balances).toEqual({ receivables: 1_580_000, deposits_held: 3_000_000, customer_credit: 0 });
    expect(s.receivables).toEqual([
      { invoice_id: I1.invoiceId, number: expect.any(String), payer_person_id: payer, balance: 1_580_000 },
    ]);
    const open = await sql<{
      s: string;
    }>`select sum(open_amount)::text as s from invoices where property_id = ${P}`.execute(t.admin);
    expect(Number(open.rows[0]?.s)).toBe(s.balances.receivables);
    // Kỳ trước: chưa có gì.
    const prev = await financialSummary(t.runtime, O, {
      propertyId: P,
      from: await day(P, 60),
      to: await day(P, 30),
    });
    expect(prev.balances).toEqual({ receivables: 0, deposits_held: 0, customer_credit: 0 });
    // Quyền: lễ tân xem được tiền trong phạm vi; buồng phòng 403; khoảng ngày sai 422.
    await expect(
      financialSummary(t.runtime, F, { propertyId: P, from: today, to: today }),
    ).resolves.toBeDefined();
    await expect(
      financialSummary(t.runtime, HK, { propertyId: P, from: today, to: today }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      financialSummary(t.runtime, O, { propertyId: P, from: today, to: await day(P, 1) }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
