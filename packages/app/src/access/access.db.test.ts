// T-007 — authorize() trên actor thật từ CSDL + bộ kiểm cách ly tenant dùng chung (TM-01).
import { randomUUID } from "node:crypto";
import { authorize } from "@hm/domain";
import {
  createTestDb,
  findIsolationLeaks,
  type SeededOrg,
  seedAuthUser,
  seedOrg,
  type TestDb,
  tenantTables,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "./actor.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let property2: string;
let managerUser: string;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Chuỗi A", "hotel");
  B = await seedOrg(t.admin, "Chuỗi B", "rental");
  // A có cơ sở thứ hai; quản lý chỉ được giao cơ sở 1.
  property2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${property2}, ${A.orgId}, 'Chuỗi A — CS2', 'hotel')`.execute(
    t.admin,
  );
  managerUser = await seedAuthUser(t.admin, `ql+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Quản lý CS1')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, limits)
            values (${membership}, ${A.orgId}, ${managerUser}, ${person}, 'manager', '{"refund": 3000000}')`.execute(
    t.admin,
  );
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
});

afterAll(async () => {
  await t.drop();
});

describe("authorize với actor từ CSDL", () => {
  it("quản lý: cơ sở được giao → được; cơ sở khác cùng tổ chức → NOT_FOUND", async () => {
    const actor = await resolveActor(t.runtime, {
      authUserId: managerUser,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(actor.propertyIds).toEqual([A.propertyId]);
    expect(authorize(actor, "unit.manage", { propertyId: A.propertyId }).grant).toBe("yes");
    expect(() => authorize(actor, "unit.manage", { propertyId: property2 })).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("hạn mức trong memberships.limits (3.000.000) ghi đè mặc định quản lý (5.000.000)", async () => {
    const actor = await resolveActor(t.runtime, {
      authUserId: managerUser,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(authorize(actor, "deposit.refund", { amount: 3_000_000 }).limit).toBe(3_000_000);
    expect(() => authorize(actor, "deposit.refund", { amount: 3_000_001 })).toThrowError(
      expect.objectContaining({ code: "APPROVAL_LIMIT_EXCEEDED" }),
    );
  });

  it("quản lý không đổi vai trò/hạn mức (chỉ owner) và không mở khoá kỳ", async () => {
    const actor = await resolveActor(t.runtime, {
      authUserId: managerUser,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    for (const action of ["member.change_role", "period.unlock", "import.commit", "data.export"] as const) {
      expect(() => authorize(actor, action)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });
});

describe("bộ kiểm cách ly tenant dùng chung", () => {
  it("phủ mọi bảng có organization_id hiện có", async () => {
    expect((await tenantTables(t.admin)).length).toBeGreaterThanOrEqual(8);
  });

  it("ngữ cảnh A và B đều không thấy hàng của tổ chức khác ở bất kỳ bảng nào", async () => {
    expect(await findIsolationLeaks(t.admin, t.runtime, A.orgId)).toEqual([]);
    expect(await findIsolationLeaks(t.admin, t.runtime, B.orgId)).toEqual([]);
  });
});
