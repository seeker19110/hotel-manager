// PLAN đợt 2 T-114 — vòng đời kỳ thu trên Postgres thật (SPEC-metering-billing S-001…S-004, S-011…S-015; INV-F1, INV-G3,
// INV-G4, INV-G5, INV-F6). Fixture `billing-basic`: phòng U101, hợp đồng L1 3.000.000 đ/tháng, điện 3.000 đ/kWh, nước
// 15.000 đ/m³, phí khác 100.000 đ.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { prepareSettlement } from "../lease/settlement.ts";
import { recordReading, setServicePrice } from "../metering/meters.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import {
  createPeriod,
  generatePeriods,
  issuePeriod,
  lockBillingPeriod,
  previewPeriod,
  reopenPeriod,
  returnToDraft,
  submitForReview,
} from "./billing.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let K: Actor;
let F: Actor;

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

const reresolve = (a: Actor) =>
  resolveActor(t.runtime, { authUserId: a.authUserId, orgId: A.orgId, twoFactorEnabled: true });

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "billing.test", idempotencyKey: key, payload: { key }, correlationId: "c-billing" },
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
  return r.problem as { code: string; status: number; items?: Record<string, unknown>[] };
}

/** Cơ sở riêng cho mỗi test (kỳ thu theo cơ sở) với fixture `billing-basic`; trả hàm tiện ích theo kỳ. */
async function billingBasic() {
  const propertyId = randomUUID();
  await sql`insert into properties (id, organization_id, name, template)
            values (${propertyId}, ${A.orgId}, ${`P1 ${propertyId.slice(0, 4)}`}, 'rental')`.execute(t.admin);
  for (const a of [M, K, F]) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${a.membershipId}, ${propertyId})`.execute(t.admin);
  }
  [M, K, F] = await Promise.all([reresolve(M), reresolve(K), reresolve(F)]);
  const floor = randomUUID();
  const roomType = randomUUID();
  const unitId = randomUUID();
  await sql`insert into floors (id, organization_id, property_id, name, sort_order) values (${floor}, ${A.orgId}, ${propertyId}, 'Tầng 1', 1)`.execute(
    t.admin,
  );
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${roomType}, ${A.orgId}, ${propertyId}, 'P', 'Phòng trọ', 2)`.execute(t.admin);
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${unitId}, ${A.orgId}, ${propertyId}, ${floor}, ${roomType}, 'U101')`.execute(t.admin);
  const service = async (
    code: string,
    name: string,
    kind: string,
    account: string,
    meterKind: string | null,
    price: number,
  ) => {
    const id = randomUUID();
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
              values (${id}, ${A.orgId}, ${propertyId}, ${code}, ${name}, ${kind}, ${account}, ${meterKind})`.execute(
      t.admin,
    );
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, { serviceId: id, unitPrice: price, effectiveFrom: "2026-01-01" }),
      })),
    );
    return id;
  };
  const electric = await service("DIEN", "Điện", "metered", "REV_UTIL", "electric", 3000);
  const water = await service("NUOC", "Nước", "metered", "REV_UTIL", "water", 15_000);
  const other = await service("PHI", "Phí khác", "fixed_per_unit", "REV_FEE", null, 100_000);
  const meter = async (kind: string, initial: number) => {
    const id = randomUUID();
    await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
              values (${id}, ${A.orgId}, ${propertyId}, ${unitId}, ${kind}, '2026-01-01', ${initial})`.execute(
      t.admin,
    );
    return id;
  };
  const em = await meter("electric", 1250);
  const wm = await meter("water", 30);
  const rep = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${rep}, ${A.orgId}, 'Người thuê L1')`.execute(
    t.admin,
  );
  const { leaseId } = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId,
    representativePersonId: rep,
    unitId,
    effectiveFrom: "2026-09-01",
  });
  const services = JSON.stringify([electric, water, other].map((s) => ({ service_id: s, quantity: 1 })));
  await t.admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}',
                     services = ${services}::jsonb where lease_id = ${leaseId}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${leaseId}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${leaseId}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${A.orgId}, ${propertyId}, ${leaseId}, 'move_in', '2026-09-01', ${A.ownerMembershipId},
                      now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${leaseId}`.execute(trx);
  });
  const period = async (month: string) =>
    (await ok(run(M, async (ctx) => ({ data: await createPeriod(ctx, { propertyId, month }) }))))
      .billingPeriodId;
  const read = (a: Actor, meterId: string, billingPeriodId: string, value: number) =>
    run(a, async (ctx) => ({ data: await recordReading(ctx, { meterId, billingPeriodId, value }) }));
  /** Kỳ có đủ chỉ số (điện 1.250 → `e`, nước 30 → `w`) và đã gửi duyệt; trả `preview_hash`. */
  const reviewed = async (month: string, e = 1350, w = 42) => {
    const id = await period(month);
    await ok(read(F, em, id, e));
    await ok(read(F, wm, id, w));
    const s = await ok(
      run(M, async (ctx) => ({ data: await submitForReview(ctx, { billingPeriodId: id }) })),
    );
    return { id, hash: s.previewHash };
  };
  const issue = (a: Actor, billingPeriodId: string, previewHash: string, key?: string) =>
    run<Awaited<ReturnType<typeof issuePeriod>>>(
      a,
      async (ctx) => ({ data: await issuePeriod(ctx, { billingPeriodId, previewHash }) }),
      key,
    );
  return { propertyId, unitId, leaseId, rep, electric, water, other, em, wm, period, read, reviewed, issue };
}

const status = async (id: string) =>
  (await sql<{ status: string }>`select status from billing_periods where id = ${id}`.execute(t.admin))
    .rows[0]?.status;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ kỳ thu", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  K = await member("accountant");
  F = await member("front_desk");
});

afterAll(async () => {
  await t.drop();
});

describe("S-001 xem trước, S-002 phát hành, S-003 snapshot", () => {
  it("S-001: U101 có 4 dòng, tổng 3.580.000 đ; hash ổn định khi số liệu không đổi", async () => {
    const P = await billingBasic();
    const id = await P.period("2026-10");
    await ok(P.read(F, P.em, id, 1350));
    await ok(P.read(F, P.wm, id, 42));
    const pv = await previewPeriod(t.runtime, M, { billingPeriodId: id });
    expect(pv.items).toHaveLength(1);
    const item = pv.items[0];
    expect(item?.lines.map((l) => [l.revenueAccount, l.quantity, l.unitPrice, l.amount])).toEqual([
      ["REV_ROOM", "31", "3000000", 3_000_000],
      ["REV_UTIL", "100", "3000", 300_000],
      ["REV_UTIL", "12", "15000", 180_000],
      ["REV_FEE", "1", "100000", 100_000],
    ]);
    expect(item?.total).toBe(3_580_000);
    expect(pv.total).toBe(3_580_000);
    expect(pv.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await previewPeriod(t.runtime, K, { billingPeriodId: id })).preview_hash).toBe(pv.preview_hash);
    // Lễ tân không xem trước kỳ thu (ma trận quyền: billing.prepare).
    await expect(previewPeriod(t.runtime, F, { billingPeriodId: id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("S-002: phát hành → 1 phiếu 4 dòng, bút toán Nợ AR / Có REV cân, outbox invoice.issued; chỉ số được duyệt", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-10");
    expect(await status(id)).toBe("reviewing");
    expect(await fails(P.issue(F, id, hash))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    const r = await ok(P.issue(O, id, hash));
    expect(r.invoiceIds).toHaveLength(1);
    expect(r.total).toBe(3_580_000);
    expect(await status(id)).toBe("issued");
    const inv = await sql<{
      kind: string;
      total: string;
      lease_id: string;
      business_date: string;
      payer_person_id: string;
    }>`
      select kind, total::text, lease_id, business_date::text, payer_person_id from invoices where billing_period_id = ${id}`.execute(
      t.admin,
    );
    expect(inv.rows).toEqual([
      {
        kind: "periodic",
        total: "3580000",
        lease_id: P.leaseId,
        business_date: "2026-10-31",
        payer_person_id: P.rep,
      },
    ]);
    const lines = await sql<{ amount: string; charge_amount: string }>`
      select il.amount::text, c.amount::text as charge_amount from invoice_lines il join charges c on c.id = il.charge_id
      where il.invoice_id = ${r.invoiceIds[0]} order by il.line_no`.execute(t.admin);
    expect(lines.rows.map((x) => [Number(x.amount), Number(x.charge_amount)])).toEqual([
      [3_000_000, 3_000_000],
      [300_000, 300_000],
      [180_000, 180_000],
      [100_000, 100_000],
    ]);
    const je = await sql<{ account: string; debit: string; credit: string }>`
      select l.account, sum(l.debit)::text as debit, sum(l.credit)::text as credit from journal_entries e
      join journal_lines l on l.entry_id = e.id where e.id = ${r.journalEntryIds[0]} and e.entry_type = 'invoice_issued'
      group by l.account order by l.account`.execute(t.admin);
    expect(je.rows.map((x) => [x.account, Number(x.debit), Number(x.credit)])).toEqual([
      ["AR", 3_580_000, 0],
      ["REV_FEE", 0, 100_000],
      ["REV_ROOM", 0, 3_000_000],
      ["REV_UTIL", 0, 480_000],
    ]);
    const ob = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'invoice.issued' and aggregate_id = ${r.invoiceIds[0]}`.execute(
      t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);
    const rd = await sql<{
      status: string;
    }>`select distinct status from meter_readings where billing_period_id = ${id}`.execute(t.admin);
    expect(rd.rows).toEqual([{ status: "approved" }]);
    // Phát hành lần hai (key khác) → kỳ đã issued.
    expect(await fails(P.issue(O, id, hash))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("S-003: đổi giá điện từ 01/11 không đổi dòng đã phát hành; UPDATE trực tiếp dòng/charge bị chặn", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-10");
    const r = await ok(P.issue(M, id, hash));
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, {
          serviceId: P.electric,
          unitPrice: 3500,
          effectiveFrom: "2026-11-01",
        }),
      })),
    );
    const line = async () =>
      (
        await sql<{
          quantity: string;
          unit_price: string;
          amount: string;
          rounding_rule: string;
          formula_version: number;
        }>`
          select quantity::text, unit_price::text, amount::text, rounding_rule, formula_version from invoice_lines
          where invoice_id = ${r.invoiceIds[0]} and line_no = 2`.execute(t.admin)
      ).rows[0];
    expect(await line()).toEqual({
      quantity: "100.0000",
      unit_price: "3000.0000",
      amount: "300000",
      rounding_rule: "HALF_UP_1",
      formula_version: 1,
    });
    const upd = await sql`update invoice_lines set amount = 1 where invoice_id = ${r.invoiceIds[0]}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(upd).toBeInstanceOf(Error);
    const ch = await sql`update charges set amount = 1 where billing_period_id = ${id}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(ch)).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    const inv = await sql`update invoices set total = 1 where id = ${r.invoiceIds[0]}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(inv)).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    expect(await line()).toMatchObject({ amount: "300000" });
  });
});

describe("S-004 xem trước cũ, S-011 sửa sau phát hành, S-015 phát hành lặp", () => {
  it("S-004: sửa chỉ số sau khi xem trước → 409 BILLING_PREVIEW_STALE, không có phiếu; hash mới thì phát hành được", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-10");
    expect(
      await fails(
        run(F, async (ctx) => ({ data: await returnToDraft(ctx, { billingPeriodId: id, reason: "x" }) })),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await fails(
        run(M, async (ctx) => ({ data: await returnToDraft(ctx, { billingPeriodId: id, reason: "  " }) })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    await ok(
      run(M, async (ctx) => ({
        data: await returnToDraft(ctx, { billingPeriodId: id, reason: "Sai chỉ số nước" }),
      })),
    );
    expect(await status(id)).toBe("draft");
    await ok(P.read(M, P.wm, id, 45));
    const again = await ok(
      run(M, async (ctx) => ({ data: await submitForReview(ctx, { billingPeriodId: id }) })),
    );
    expect(again.previewHash).not.toBe(hash);
    expect(await fails(P.issue(O, id, hash))).toMatchObject({ code: "BILLING_PREVIEW_STALE", status: 409 });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from invoices where billing_period_id = ${id}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    expect(await status(id)).toBe("reviewing");
    const r = await ok(P.issue(O, id, again.previewHash));
    expect(r.total).toBe(3_000_000 + 300_000 + 15 * 15_000 + 100_000);
  });

  it("gửi duyệt: chưa đủ chỉ số → READINGS_INCOMPLETE; phát hành từ draft → INVALID_TRANSITION", async () => {
    const P = await billingBasic();
    const id = await P.period("2026-10");
    await ok(P.read(F, P.em, id, 1350));
    const miss = await fails(
      run(M, async (ctx) => ({ data: await submitForReview(ctx, { billingPeriodId: id }) })),
    );
    expect(miss).toMatchObject({ code: "READINGS_INCOMPLETE", status: 409 });
    expect(miss.items?.map((x) => [x.unit, x.meter])).toEqual([["U101", "water"]]);
    const pv = await previewPeriod(t.runtime, M, { billingPeriodId: id });
    expect(pv.items[0]?.missing).toEqual(["water"]);
    expect(await fails(P.issue(O, id, pv.preview_hash))).toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
  });

  it("S-011: kỳ đã phát hành → sửa chỉ số 409 PERIOD_ISSUED; trả về nháp bị chặn", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-10");
    // Kế toán phát hành ⇒ chỉ số kỳ được duyệt dù kế toán không có quyền sửa chỉ số (hồi quy: RLS từng lọc mất UPDATE).
    const draft = await P.period("2026-11");
    await ok(P.read(F, P.em, draft, 1400));
    const kEdit = await run(K, async (ctx) => {
      await sql`update meter_readings set value = 1 where billing_period_id = ${draft}`.execute(ctx.trx);
      return { data: null };
    });
    expect(kEdit).toMatchObject({ status: "failed", problem: { code: "FORBIDDEN", status: 403 } });
    await ok(P.issue(K, id, hash));
    const rd = await sql<{ status: string; approved_by: string }>`
      select distinct status, approved_by from meter_readings where billing_period_id = ${id}`.execute(
      t.admin,
    );
    expect(rd.rows).toEqual([{ status: "approved", approved_by: K.membershipId }]);
    expect(await fails(P.read(M, P.em, id, 1400))).toMatchObject({ code: "PERIOD_ISSUED", status: 409 });
    expect(
      await fails(
        run(M, async (ctx) => ({ data: await returnToDraft(ctx, { billingPeriodId: id, reason: "Sửa" }) })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
    const direct = await sql`update billing_periods set status = 'draft' where id = ${id}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("S-015: gửi lại cùng key → kết quả cũ; vẫn 1 phiếu, 1 bút toán", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-10");
    const key = randomUUID();
    const first = await P.issue(O, id, hash, key);
    const second = await P.issue(O, id, hash, key);
    expect(first.status).toBe("committed");
    expect(second).toMatchObject({ status: "committed", replayed: true });
    expect(second.status === "committed" && first.status === "committed" && second.data).toEqual(
      first.status === "committed" && first.data,
    );
    const n = await sql<{ inv: number; je: number }>`
      select (select count(*)::int from invoices where billing_period_id = ${id}) as inv,
             (select count(*)::int from journal_entries e join invoices i on i.id = e.source_doc_id
               where i.billing_period_id = ${id}) as je`.execute(t.admin);
    expect(n.rows[0]).toEqual({ inv: 1, je: 1 });
  });
});

describe("S-012 khoá/mở khoá kỳ", () => {
  it("chỉ owner mở khoá, có lý do; locked → issued; sau mở khoá phiếu vẫn bất biến, chỉ số vẫn PERIOD_ISSUED", async () => {
    const P = await billingBasic();
    const { id, hash } = await P.reviewed("2026-09", 1300, 36);
    const issued = await ok(P.issue(O, id, hash));
    const lock = (a: Actor, reason = "Chốt kỳ 09") =>
      run(a, async (ctx) => ({ data: await lockBillingPeriod(ctx, { billingPeriodId: id, reason }) }));
    expect(await fails(lock(F))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await ok(lock(K));
    expect(await status(id)).toBe("locked");
    expect(await fails(lock(K))).toMatchObject({ code: "INVALID_TRANSITION" });
    // Kỳ đã khoá: ghi gì vào ngày trong kỳ → PERIOD_LOCKED (INV-F6).
    const locked = await sql`
      insert into charges (id, organization_id, property_id, source_type, billing_period_id, lease_id, kind, revenue_account,
                           description, business_date, unit_price, amount)
      values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, 'billing_period', ${id}, ${P.leaseId}, 'fee', 'REV_FEE', 'Phí thêm',
              '2026-09-20', 1000, 1000)`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(locked)).toMatchObject({ code: "PERIOD_LOCKED", status: 409 });

    const reopen = (a: Actor, reason: string) =>
      run(a, async (ctx) => ({ data: await reopenPeriod(ctx, { billingPeriodId: id, reason }) }));
    expect(await fails(reopen(M, "Sửa"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(reopen(K, "Sửa"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(reopen(O, "   "))).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    await ok(reopen(O, "Khách khiếu nại tiền nước"));
    expect(await status(id)).toBe("issued");
    const pl = await sql<{ released_by: string | null; release_reason: string | null }>`
      select released_by, release_reason from period_locks where property_id = ${P.propertyId}`.execute(
      t.admin,
    );
    expect(pl.rows).toEqual([
      { released_by: A.ownerMembershipId, release_reason: "Khách khiếu nại tiền nước" },
    ]);
    const au = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'period.unlocked' and property_id = ${P.propertyId}`.execute(
      t.admin,
    );
    expect(au.rows[0]?.n).toBe(1);
    const inv = await sql`update invoices set total = 1 where id = ${issued.invoiceIds[0]}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(inv)).toMatchObject({ code: "DOCUMENT_IMMUTABLE", status: 409 });
    expect(await fails(P.read(M, P.em, id, 1310))).toMatchObject({ code: "PERIOD_ISSUED", status: 409 });
    expect(await fails(reopen(O, "Lần hai"))).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("không khoá sổ qua kỳ thu chưa phát hành; trạng thái locked không tự đặt được nếu sổ chưa khoá", async () => {
    const P = await billingBasic();
    const id = await P.period("2026-09");
    expect(
      await fails(
        run(K, async (ctx) => ({ data: await lockBillingPeriod(ctx, { billingPeriodId: id, reason: "x" }) })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    const { id: id10, hash } = await P.reviewed("2026-10");
    await ok(P.issue(O, id10, hash));
    const direct = await t.admin
      .transaction()
      .execute((trx) => sql`update billing_periods set status = 'locked' where id = ${id10}`.execute(trx))
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });
});

describe("S-013, S-014 job tạo kỳ", () => {
  it("S-014: 2026-10-31T17:05Z (00:05 01/11 giờ VN) → kỳ 11/2026", async () => {
    const P = await billingBasic();
    await generatePeriods(t.worker, new Date("2026-10-31T16:55:00Z"));
    await generatePeriods(t.worker, new Date("2026-10-31T17:05:00Z"));
    const r = await sql<{ s: string; e: string }>`
      select period_start::text as s, period_end::text as e from billing_periods where property_id = ${P.propertyId}
      order by period_start`.execute(t.admin);
    expect(r.rows).toEqual([
      { s: "2026-10-01", e: "2026-10-31" },
      { s: "2026-11-01", e: "2026-11-30" },
    ]);
  });

  it("S-013: chạy lại 3 lần và 2 worker song song → đúng 1 kỳ; lệnh tạo kỳ trả kỳ hiện có", async () => {
    const P = await billingBasic();
    const now = new Date("2026-12-10T03:00:00Z");
    await generatePeriods(t.worker, now);
    await generatePeriods(t.worker, now);
    await Promise.all([generatePeriods(t.worker, now), generatePeriods(t.worker, now)]);
    const r = await sql<{ id: string }>`
      select id from billing_periods where property_id = ${P.propertyId} and period_start = '2026-12-01'`.execute(
      t.admin,
    );
    expect(r.rows).toHaveLength(1);
    const again = await ok(
      run(M, async (ctx) => ({
        data: await createPeriod(ctx, { propertyId: P.propertyId, month: "2026-12" }),
      })),
    );
    expect(again).toEqual({ billingPeriodId: r.rows[0]?.id, created: false });
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await createPeriod(ctx, { propertyId: P.propertyId, month: "2026-13" }),
        })),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await createPeriod(ctx, { propertyId: P.propertyId, month: "2026-12" }),
        })),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Thanh lý sau kỳ cuối (PLAN đợt 2 T-114)", () => {
  it("kỳ chứa ngày trả phòng chưa phát hành → 409 FINAL_PERIOD_NOT_ISSUED; phát hành (prorata 20/31 ngày) rồi lập được", async () => {
    const P = await billingBasic();
    await t.admin.transaction().execute(async (trx) => {
      await sql`update leases set status = 'notice_given', planned_move_out_on = '2026-10-20' where id = ${P.leaseId}`.execute(
        trx,
      );
      await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                       confirmed_at, source, readings_pending, confirmation_method)
                values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, ${P.leaseId}, 'move_out', '2026-10-20', ${A.ownerMembershipId},
                        now(), 'import', false, 'import')`.execute(trx);
      await sql`update leases set status = 'settling', moved_out_on = '2026-10-20' where id = ${P.leaseId}`.execute(
        trx,
      );
    });
    const prepare = () =>
      run(M, async (ctx) => ({ data: await prepareSettlement(ctx, { leaseId: P.leaseId, fees: [] }) }));
    // Kỳ 10 chưa có nhưng cơ sở đã dùng kỳ thu (có kỳ 09).
    await P.period("2026-09");
    const none = await fails(prepare());
    expect(none).toMatchObject({ code: "FINAL_PERIOD_NOT_ISSUED", status: 409 });
    const { id, hash } = await P.reviewed("2026-10");
    expect(await fails(prepare())).toMatchObject({
      code: "FINAL_PERIOD_NOT_ISSUED",
      items: [{ billing_period_id: id, status: "reviewing" }],
    });
    const r = await ok(P.issue(O, id, hash));
    // 3.000.000 × 20/31 = 1.935.483,87 → 1.935.484.
    expect(r.total).toBe(1_935_484 + 300_000 + 180_000 + 100_000);
    const s = await ok(prepare());
    expect(s).toMatchObject({ outstandingAr: r.total });
  });
});
