// PLAN đợt 3 T-224 — lưu cơ sở đang chọn của `session.switchOrganization` (SPEC-access-and-property S-020; D-020).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationContext, switchOrganization } from "./org-context.ts";

let t: TestDb;
let A: SeededOrg;
let hs2: string;
let hs3: string;
let user: string;
let membership: string;

const sw = (propertyId: string | null) =>
  switchOrganization(t.runtime, user, {
    key: randomUUID(),
    organizationId: A.orgId,
    propertyId,
    correlationId: "c-org",
  });

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Chuỗi Hoa Sen");
  hs2 = randomUUID();
  hs3 = randomUUID();
  for (const [id, name] of [
    [hs2, "HS2"],
    [hs3, "HS3"],
  ])
    await sql`insert into properties (id, organization_id, name, template) values (${id}, ${A.orgId}, ${name}, 'hotel')`.execute(
      t.admin,
    );
  // Quản lý có phạm vi CS1 + HS2 (không HS3).
  user = await seedAuthUser(t.admin, `ql+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Quản lý')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, 'manager')`.execute(t.admin);
  for (const p of [A.propertyId, hs2])
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membership}, ${p})`.execute(t.admin);
});

afterAll(async () => {
  await t?.drop();
});

describe("cơ sở đang chọn được lưu", () => {
  it("chưa chọn (nhiều cơ sở) → property null; chọn HS2 → lần chuyển sau không nêu cơ sở vẫn về HS2; cơ sở ngoài phạm vi → not_found, không đổi", async () => {
    expect((await organizationContext(t.runtime, user, A.orgId))?.property).toBeNull();
    const r = await sw(hs2);
    expect(r).toMatchObject({ kind: "committed", context: { property: { id: hs2 } } });
    expect((await sw(null)) as { context: { property: { id: string } } }).toMatchObject({
      kind: "committed",
      context: { property: { id: hs2 } },
    });
    expect(await sw(hs3)).toEqual({ kind: "not_found" });
    const m = await sql<{ selected_property_id: string }>`
      select selected_property_id from memberships where id = ${membership}`.execute(t.admin);
    expect(m.rows[0]?.selected_property_id).toBe(hs2);
  });

  it("bị rút HS2 khỏi phạm vi → lựa chọn cũ bị bỏ qua (không phải quyền); app.select_property ngoài phạm vi → false, không ghi", async () => {
    await sql`delete from property_scopes where membership_id = ${membership} and property_id = ${hs2}`.execute(
      t.admin,
    );
    const c = await organizationContext(t.runtime, user, A.orgId);
    // Còn đúng một cơ sở trong phạm vi ⇒ chọn cơ sở đó, không phải HS2 đã lưu.
    expect(c?.property?.id).toBe(A.propertyId);
    const { withTenant } = await import("@hm/db");
    const ok = await withTenant(t.runtime, { orgId: A.orgId, actorId: membership }, (trx) =>
      sql<{ ok: boolean }>`select app.select_property(${hs3}::uuid) as ok`.execute(trx),
    );
    expect(ok.rows[0]?.ok).toBe(false);
    const m = await sql<{ selected_property_id: string }>`
      select selected_property_id from memberships where id = ${membership}`.execute(t.admin);
    expect(m.rows[0]?.selected_property_id).toBe(hs2);
  });
});
