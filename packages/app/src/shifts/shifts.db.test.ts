// PLAN đợt 2 T-104 — ca quầy trên Postgres thật (SPEC-ledger S-034, S-035; INV-F3b, INV-F6).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { postEntry } from "../ledger/ledger.ts";
import { executeCommand } from "../pipeline/command.ts";
import { closeShift, handoverShift, openShift, reassignDiscrepancy, receiveHandover } from "./shifts.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let manager: Actor;
let F: Actor;
let F2: Actor;
let F3: Actor;
let K: Actor;
let HK: Actor;
let guestPerson: string;

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

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "shift.test", idempotencyKey: randomUUID(), payload: { n: randomUUID() }, correlationId: "c" },
    fn,
  );
}

async function ok<T>(p: ReturnType<typeof run<T>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

const open = (a: Actor, cash: number) =>
  ok(
    run(a, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: cash }) })),
  );

/** Thu tiền mặt đã xác nhận vào ca (Nợ CASH / Có CUSTOMER_CREDIT) hoặc hoàn tiền mặt (Nợ CUSTOMER_CREDIT / Có CASH). */
async function cash(shiftId: string, amount: number) {
  await t.admin.transaction().execute((trx) =>
    postEntry(trx, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      businessDate: "2026-10-15",
      entryType: amount > 0 ? "payment_confirmed" : "credit_refunded",
      sourceDocType: "payment",
      sourceDocId: randomUUID(),
      lines:
        amount > 0
          ? [
              { account: "CASH", debit: amount, credit: 0, shiftId },
              { account: "CUSTOMER_CREDIT", debit: 0, credit: amount, personId: guestPerson },
            ]
          : [
              { account: "CUSTOMER_CREDIT", debit: -amount, credit: 0, personId: guestPerson },
              { account: "CASH", debit: 0, credit: -amount, shiftId },
            ],
    }),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS ca quầy");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  manager = await member("manager");
  F = await member("front_desk");
  F2 = await member("front_desk");
  F3 = await member("front_desk");
  K = await member("accountant");
  HK = await member("housekeeping");
  guestPerson = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${guestPerson}, ${A.orgId}, 'Khách giả')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("mở/đóng ca (S-034)", () => {
  it("dự kiến = 2.000.000 + (930.000 + 500.000) − 200.000 = 3.230.000; đếm 3.180.000 → chênh −50.000 người chịu trách nhiệm F", async () => {
    const { shiftId } = await open(F, 2_000_000);
    await cash(shiftId, 930_000);
    await cash(shiftId, 500_000);
    await cash(shiftId, -200_000);
    const entriesBefore = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(
      t.admin,
    );
    const r = await ok(
      run(F, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 3_180_000 }) })),
    );
    expect(r).toMatchObject({ expectedCash: 3_230_000, countedCash: 3_180_000, difference: -50_000 });
    const d = await sql<{ amount: string; responsible_membership_id: string; status: string; kind: string }>`
      select amount, responsible_membership_id, status, kind from shift_discrepancies where id = ${r.discrepancyId}`.execute(
      t.admin,
    );
    expect(d.rows[0]).toMatchObject({
      amount: "-50000",
      responsible_membership_id: F.membershipId,
      status: "open",
      kind: "close",
    });
    const entriesAfter = await sql<{ n: number }>`select count(*)::int as n from journal_entries`.execute(
      t.admin,
    );
    expect(entriesAfter.rows[0]?.n).toBe(entriesBefore.rows[0]?.n); // không bút toán tự động
    const s = await sql<{ status: string }>`select status from shifts where id = ${shiftId}`.execute(t.admin);
    expect(s.rows[0]?.status).toBe("closed");
  });

  it("đếm đúng → chênh 0, không tạo shift_discrepancies; đầu ca 0 đ hợp lệ", async () => {
    const { shiftId } = await open(F3, 0);
    await cash(shiftId, 120_000);
    const r = await ok(
      run(F3, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 120_000 }) })),
    );
    expect(r).toMatchObject({ difference: 0, discrepancyId: null });
  });

  it("một ca mở mỗi người → SHIFT_ALREADY_OPEN; tiền âm → 422; kế toán không mở ca", async () => {
    const { shiftId } = await open(F2, 1_000_000);
    expect(
      await run(F2, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }),
      })),
    ).toMatchObject({ status: "failed", problem: { code: "SHIFT_ALREADY_OPEN", status: 409 } });
    expect(
      await run(F3, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: -1 }),
      })),
    ).toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(
      await run(K, async (ctx) => ({
        data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }),
      })),
    ).toMatchObject({ problem: { code: "FORBIDDEN" } });
    // Lễ tân đóng ca người khác → 403; quản lý đóng được.
    expect(
      await run(F, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 1_000_000 }) })),
    ).toMatchObject({ problem: { code: "FORBIDDEN", status: 403 } });
    expect(
      await run(manager, async (ctx) => ({
        data: await closeShift(ctx, { shiftId, countedCash: 1_000_000 }),
      })),
    ).toMatchObject({ status: "committed", data: { difference: 0 } });
    expect(
      await run(manager, async (ctx) => ({
        data: await closeShift(ctx, { shiftId, countedCash: 1_000_000 }),
      })),
    ).toMatchObject({ problem: { code: "INVALID_TRANSITION" } });
  });

  it("kế toán đóng/đối chiếu ca được", async () => {
    const { shiftId } = await open(owner, 50_000);
    expect(
      await run(K, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 50_000 }) })),
    ).toMatchObject({ status: "committed" });
  });
});

describe("bàn giao ca hai bên (S-035)", () => {
  async function closedShiftOf(a: Actor, counted: number) {
    const { shiftId } = await open(a, counted);
    await ok(run(a, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: counted }) })));
    return shiftId;
  }

  it("khớp: ca giao → handed_over, ca nhận mở với đầu ca = số nhận; xác nhận lần 2 → INVALID_TRANSITION", async () => {
    const giver = await member("front_desk");
    const receiver = await member("front_desk");
    const shiftId = await closedShiftOf(giver, 3_180_000);
    expect(
      await ok(
        run(giver, async (ctx) => ({
          data: await handoverShift(ctx, { shiftId, toMembershipId: receiver.membershipId }),
        })),
      ),
    ).toEqual({ shiftId, declaredCash: 3_180_000 });
    const r = await ok(
      run(receiver, async (ctx) => ({
        data: await receiveHandover(ctx, { shiftId, receivedCash: 3_180_000 }),
      })),
    );
    expect(r).toMatchObject({ difference: 0, discrepancyId: null });
    const rows = await sql<{
      id: string;
      status: string;
      opening_cash: string;
      previous_shift_id: string | null;
    }>`
      select id, status, opening_cash, previous_shift_id from shifts where id in (${shiftId}, ${r.newShiftId})`.execute(
      t.admin,
    );
    expect(rows.rows.find((x) => x.id === shiftId)?.status).toBe("handed_over");
    expect(rows.rows.find((x) => x.id === r.newShiftId)).toMatchObject({
      status: "open",
      opening_cash: "3180000",
      previous_shift_id: shiftId,
    });
    expect(
      await run(receiver, async (ctx) => ({
        data: await receiveHandover(ctx, { shiftId, receivedCash: 3_180_000 }),
      })),
    ).toMatchObject({ problem: { code: "INVALID_TRANSITION" } });
  });

  it("lệch: nhận 3.150.000 → chênh −30.000 loại handover, người chịu trách nhiệm = người giao; tự giao cho mình → 403", async () => {
    const giver = await member("front_desk");
    const receiver = await member("front_desk");
    const outsider = await member("front_desk");
    const shiftId = await closedShiftOf(giver, 3_180_000);
    expect(
      await run(giver, async (ctx) => ({
        data: await handoverShift(ctx, { shiftId, toMembershipId: giver.membershipId }),
      })),
    ).toMatchObject({ problem: { code: "SELF_APPROVAL_FORBIDDEN" } });
    await ok(
      run(giver, async (ctx) => ({
        data: await handoverShift(ctx, { shiftId, toMembershipId: receiver.membershipId }),
      })),
    );
    expect(
      await run(outsider, async (ctx) => ({
        data: await receiveHandover(ctx, { shiftId, receivedCash: 1 }),
      })),
    ).toMatchObject({ problem: { code: "FORBIDDEN" } });
    const r = await ok(
      run(receiver, async (ctx) => ({
        data: await receiveHandover(ctx, { shiftId, receivedCash: 3_150_000 }),
      })),
    );
    expect(r.difference).toBe(-30_000);
    const d = await sql<{ amount: string; kind: string; responsible_membership_id: string }>`
      select amount, kind, responsible_membership_id from shift_discrepancies where id = ${r.discrepancyId}`.execute(
      t.admin,
    );
    expect(d.rows[0]).toEqual({
      amount: "-30000",
      kind: "handover",
      responsible_membership_id: giver.membershipId,
    });

    // Quản lý gán lại người chịu trách nhiệm (có audit); lễ tân không được.
    expect(
      await run(F, async (ctx) => {
        await reassignDiscrepancy(ctx, {
          discrepancyId: r.discrepancyId as string,
          responsibleMembershipId: receiver.membershipId,
          reason: "x",
        });
        return { data: null };
      }),
    ).toMatchObject({ problem: { code: "FORBIDDEN" } });
    await ok(
      run(manager, async (ctx) => {
        await reassignDiscrepancy(ctx, {
          discrepancyId: r.discrepancyId as string,
          responsibleMembershipId: receiver.membershipId,
          reason: "camera cho thấy người nhận đếm thiếu",
        });
        return { data: null };
      }),
    );
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'shift.discrepancy_reassigned' and entity_id = ${r.discrepancyId}`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });
});

describe("CSDL: INV-F6, RLS", () => {
  it("ca đã đóng không sửa số được; dòng CASH phải gắn ca có thật", async () => {
    const { shiftId } = await open(manager, 10_000);
    await ok(
      run(manager, async (ctx) => ({ data: await closeShift(ctx, { shiftId, countedCash: 10_000 }) })),
    );
    await expect(
      sql`update shifts set counted_cash = 1 where id = ${shiftId}`.execute(t.admin),
    ).rejects.toThrow(/INV-F6/);
    await expect(cash(randomUUID(), 1)).rejects.toThrow(/fk_journal_lines_shift/);
  });

  it("buồng phòng không thấy ca; lễ tân thấy ca trong phạm vi nhưng không ghi được ca người khác ở CSDL", async () => {
    const { shiftId } = await open(F3, 5_000);
    const seen = (a: Actor) =>
      withTenant(
        t.runtime,
        { orgId: A.orgId, actorId: a.membershipId },
        async (trx) =>
          (await sql<{ id: string }>`select id from shifts where id = ${shiftId}`.execute(trx)).rows.length,
      );
    expect(await seen(HK)).toBe(0);
    expect(await seen(F)).toBe(1);
    const updated = await withTenant(t.runtime, { orgId: A.orgId, actorId: F.membershipId }, (trx) =>
      sql`update shifts set version = version + 1 where id = ${shiftId}`.execute(trx),
    );
    expect(Number(updated.numAffectedRows ?? 0)).toBe(0);
  });
});
