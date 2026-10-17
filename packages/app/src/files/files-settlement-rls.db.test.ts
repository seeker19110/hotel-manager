// T-503 — RLS đọc `files` cho owner_type `lease_settlement` (migration 0052): ảnh chứng cứ phí thanh lý (lease/settlement.ts) phải đọc
// được bởi đúng người đọc được quyết toán (lease_settlements_read: owner/manager/accountant trong phạm vi cơ sở), người khác 0 dòng.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let property2: string;
const file = {
  settlementP1: randomUUID(),
  settlementP2: randomUUID(),
  handoverP1: randomUUID(),
  settlementB: randomUUID(),
};

async function insertFile(org: SeededOrg, id: string, ownerType: string, propertyId: string | null) {
  await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key, exif_stripped)
            values (${id}, ${org.orgId}, ${propertyId}, ${ownerType}, 'image/jpeg', 10, ${"a".repeat(64)}, 'ready',
                    ${`${org.orgId}/${ownerType}/${id}`}, true)`.execute(t.admin);
}

/** Thành viên có vai trò `role`; `props` = các cơ sở được cấp phạm vi ([] = không cơ sở nào, không all_properties). */
async function member(org: SeededOrg, role: string, props: string[]): Promise<string> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const id = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${id}, ${org.orgId}, ${user}, ${person}, ${role}, false)`.execute(t.admin);
  for (const p of props)
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${id}, ${p})`.execute(t.admin);
  return id;
}

/** Id các file `lease_settlement` mà `actorId` thấy qua RLS (vai trò app_runtime). */
async function visible(org: SeededOrg, actorId: string, ownerType = "lease_settlement"): Promise<string[]> {
  return withTenant(t.runtime, { orgId: org.orgId, actorId }, async (trx) => {
    const r = await sql<{
      id: string;
    }>`select id from files where owner_type = ${ownerType} order by id`.execute(trx);
    return r.rows.map((x) => x.id);
  });
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS thanh lý");
  B = await seedOrg(t.admin, "KS khác");
  property2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${property2}, ${A.orgId}, 'CS2', 'hotel')`.execute(
    t.admin,
  );
  await insertFile(A, file.settlementP1, "lease_settlement", A.propertyId);
  await insertFile(A, file.settlementP2, "lease_settlement", property2);
  await insertFile(A, file.handoverP1, "handover", A.propertyId);
  await insertFile(B, file.settlementB, "lease_settlement", B.propertyId);
});
afterAll(async () => {
  await t?.drop();
});

describe("files RLS — lease_settlement (0052)", () => {
  it("chủ (mọi cơ sở) thấy cả hai file quyết toán của tổ chức mình, không thấy của tổ chức khác", async () => {
    expect((await visible(A, A.ownerMembershipId)).sort()).toEqual(
      [file.settlementP1, file.settlementP2].sort(),
    );
    expect(await visible(B, B.ownerMembershipId)).toEqual([file.settlementB]);
  });

  it("quản lý/kế toán có phạm vi cơ sở 1 chỉ thấy file của cơ sở 1", async () => {
    for (const role of ["manager", "accountant"]) {
      const m = await member(A, role, [A.propertyId]);
      expect(await visible(A, m), role).toEqual([file.settlementP1]);
    }
  });

  it("ca biên: quản lý/kế toán không có phạm vi cơ sở nào → 0 dòng; phạm vi cơ sở khác → 0 dòng của cơ sở 1", async () => {
    for (const role of ["manager", "accountant"]) {
      expect(await visible(A, await member(A, role, [])), `${role} không phạm vi`).toEqual([]);
      expect(await visible(A, await member(A, role, [property2])), `${role} cơ sở 2`).toEqual([
        file.settlementP2,
      ]);
    }
  });

  it("người không có quyền đọc quyết toán (lễ tân, buồng phòng, bảo trì) vẫn 0 dòng dù có phạm vi cơ sở", async () => {
    for (const role of ["front_desk", "housekeeping", "maintenance"]) {
      const m = await member(A, role, [A.propertyId, property2]);
      expect(await visible(A, m), role).toEqual([]);
    }
  });

  it("không có người thao tác (ngữ cảnh worker/thiếu actor) → 0 dòng; người của tổ chức khác không đọc được qua ngữ cảnh tổ chức A", async () => {
    expect(
      await withTenant(t.runtime, { orgId: A.orgId }, async (trx) => {
        const r = await sql`select id from files where owner_type = 'lease_settlement'`.execute(trx);
        return r.rows.length;
      }),
    ).toBe(0);
    expect(await visible(A, B.ownerMembershipId)).toEqual([]);
  });

  it("không đổi loại khác: file bàn giao vẫn đọc được theo nhánh cũ, và nhánh mới không áp cho owner_type khác", async () => {
    const fd = await member(A, "front_desk", [A.propertyId]);
    expect(await visible(A, fd, "handover")).toEqual([file.handoverP1]);
  });
});
