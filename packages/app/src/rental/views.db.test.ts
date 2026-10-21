// PLAN đợt 2 T-117 — truy vấn màn hình nhà trọ và lệnh gộp `payment.collectCash` trên Postgres thật.
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
import { collectCash } from "../payments/payments.ts";
import { executeCommand } from "../pipeline/command.ts";
import { openShift } from "../shifts/shifts.ts";
import { listOpenInvoices, listPendingPayments, rentalProperties } from "./views.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let H: Actor;

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "rental.test", idempotencyKey: key, payload: { key }, correlationId: "c-rental" },
    fn,
  );
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ màn hình", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  const user = await seedAuthUser(t.admin, `hk+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const m = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Buồng phòng')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${m}, ${A.orgId}, ${user}, ${person}, 'housekeeping')`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${m}, ${A.propertyId})`.execute(t.admin);
  H = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: false });
});

afterAll(async () => {
  await t.drop();
});

describe("payment.collectCash", () => {
  it("ca mở: ghi + xác nhận (phiếu thu) + phân bổ trong một lệnh; phiếu hết nợ; thu vượt → lỗi, không để lại khoản treo", async () => {
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: A.ownerPersonId,
      lines: [{ amount: 3_580_000 }],
    });
    const noShift = await run(O, async (ctx) => ({
      data: await collectCash(ctx, { invoiceId: inv.invoiceId, amount: 1000 }),
    }));
    expect(noShift).toMatchObject({ status: "failed", problem: { code: "SHIFT_NOT_OPEN" } });
    await run(O, async (ctx) => ({
      data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }),
    }));
    expect((await rentalProperties(t.runtime, O))[0]).toMatchObject({ id: A.propertyId, open_shift: true });
    // AUD-XFEAT-002: tháng mặc định của ô "Tháng" theo múi giờ cơ sở (không +7h cố định ở trang).
    const tz = (
      await sql<{
        m: string;
      }>`select to_char(now() at time zone p.timezone, 'YYYY-MM') as m from properties p where id = ${A.propertyId}`.execute(
        t.admin,
      )
    ).rows[0]?.m;
    expect((await rentalProperties(t.runtime, O))[0]?.local_month).toBe(tz);
    const over = await run(O, async (ctx) => ({
      data: await collectCash(ctx, { invoiceId: inv.invoiceId, amount: 3_580_001 }),
    }));
    expect(over.status).toBe("failed");
    expect(await listPendingPayments(t.runtime, O)).toEqual([]);
    const ok = await run(O, async (ctx) => ({
      data: await collectCash(ctx, { invoiceId: inv.invoiceId, amount: 3_580_000 }),
    }));
    expect(ok).toMatchObject({ status: "committed", data: { unallocated: 0 } });
    if (ok.status === "committed") expect(ok.data.receiptNo).toMatch(/^PT-\d{6}$/);
    expect((await listOpenInvoices(t.runtime, O)).map((i) => i.id)).not.toContain(inv.invoiceId);
    const p = await sql<{ status: string; method: string }>`
      select status, method from payments where payer_person_id = ${A.ownerPersonId}`.execute(t.admin);
    expect(p.rows).toEqual([{ status: "confirmed", method: "cash" }]);
  });

  it("quản lý chỉ được giao cơ sở A không thấy phiếu của cơ sở B (review lát 4 🟢5)", async () => {
    const pB = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${pB}, ${A.orgId}, 'CS B', 'rental')`.execute(
      t.admin,
    );
    const invB = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: pB,
      payerPersonId: A.ownerPersonId,
      lines: [{ amount: 50_000 }],
    });
    const user = await seedAuthUser(t.admin, `mgr+${randomUUID().slice(0, 6)}@example.test`);
    const person = randomUUID();
    const m = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Quản lý A')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${m}, ${A.orgId}, ${user}, ${person}, 'manager')`.execute(t.admin);
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${m}, ${A.propertyId})`.execute(t.admin);
    const MA = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
    expect((await listOpenInvoices(t.runtime, O)).map((i) => i.id)).toContain(invB.invoiceId);
    const seen = await listOpenInvoices(t.runtime, MA);
    expect(seen.map((i) => i.id)).not.toContain(invB.invoiceId);
    expect(seen.every((i) => i.property_id === A.propertyId)).toBe(true);
    expect((await rentalProperties(t.runtime, MA)).map((p) => p.id)).toEqual([A.propertyId]);
  });

  it("truy vấn tiền theo RLS: buồng phòng không thấy phiếu/khoản thu", async () => {
    await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: A.ownerPersonId,
      lines: [{ amount: 100_000 }],
    });
    expect((await listOpenInvoices(t.runtime, O)).length).toBeGreaterThan(0);
    expect(await listOpenInvoices(t.runtime, H)).toEqual([]);
    expect(await listPendingPayments(t.runtime, H)).toEqual([]);
  });
});
