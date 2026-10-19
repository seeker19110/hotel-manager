// AUD-DATA-001/002 (T-1302): bảng danh mục cơ sở (properties, floors, room_types, units) chịu RLS theo CƠ SỞ — nhân viên chỉ thấy/ghi
// cơ sở trong phạm vi, người thuê chỉ thấy cơ sở có hợp đồng; ngữ cảnh hệ thống (không actor) không đổi. Chạy trên Postgres thật bằng
// role `app_runtime` (chịu RLS) với `app.org_id`/`app.actor_id` đặt như ứng dụng.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import { activateLease, type SeededOrg, seedAuthUser, seedLease, seedOrg } from "./factory.ts";

let t: TestDb;
let orgId: string;
let propA: string;
let propB: string;
let unitA: string;
let unitB: string;
let floorB: string;
let roomTypeB: string;
let fdA: string; // front_desk gán cơ sở A
let owner: string;
let tenantA: string; // người thuê có hợp đồng ở A
let tenantNone: string; // người thuê chưa có hợp đồng
let seeded: SeededOrg;

const TABLES = ["properties", "floors", "room_types", "units"] as const;

beforeAll(async () => {
  t = await createTestDb();
  const s = await seedOrg(t.admin, "Org RLS");
  seeded = s;
  orgId = s.orgId;
  propA = s.propertyId;
  unitA = s.unitId;
  owner = s.ownerMembershipId;
  propB = randomUUID();
  const fB = randomUUID();
  const rtB = randomUUID();
  floorB = fB;
  roomTypeB = rtB;
  unitB = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${propB}, ${orgId}, 'CS B', 'hotel')`.execute(
    t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name) values (${fB}, ${orgId}, ${propB}, 'T1')`.execute(
    t.admin,
  );
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity) values (${rtB}, ${orgId}, ${propB}, 'STD', 'TC', 2)`.execute(
    t.admin,
  );
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code) values (${unitB}, ${orgId}, ${propB}, ${fB}, ${rtB}, 'B-201')`.execute(
    t.admin,
  );

  const member = async (role: string): Promise<{ id: string; personId: string }> => {
    const au = randomUUID();
    const personId = randomUUID();
    const id = randomUUID();
    await seedAuthUser(t.admin, `${role}-${id.slice(0, 6)}@example.test`, au);
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${orgId}, ${role})`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
              values (${id}, ${orgId}, ${au}, ${personId}, ${role}, false)`.execute(t.admin);
    return { id, personId };
  };
  const fd = await member("front_desk");
  fdA = fd.id;
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id) values (${randomUUID()}, ${orgId}, ${fdA}, ${propA})`.execute(
    t.admin,
  );
  const tn = await member("tenant");
  tenantA = tn.id;
  tenantNone = (await member("tenant")).id;
  // Hợp đồng đang hiệu lực ở cơ sở A cho người thuê tenantA (đại diện = person của membership).
  const { leaseId } = await seedLease(t.admin, {
    orgId,
    propertyId: propA,
    representativePersonId: tn.personId,
    effectiveFrom: "2026-09-01",
  });
  await activateLease(t.admin, { org: seeded, leaseId, effectiveFrom: "2026-09-01" });
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

/** Chạy `q` bằng role app_runtime trong một giao dịch với ngữ cảnh tổ chức (+ actor nếu có). */
async function as<T>(
  actor: string | null,
  q: (trx: import("kysely").Transaction<unknown>) => Promise<T>,
): Promise<T> {
  return t.runtime.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${orgId}, true)`.execute(trx);
    if (actor) await sql`select set_config('app.actor_id', ${actor}, true)`.execute(trx);
    return q(trx);
  });
}
/** Số dòng của cơ sở `prop` trong bảng danh mục (`properties` khoá theo `id`, còn lại theo `property_id`). */
const rows = (actor: string | null, table: string, prop: string) =>
  as(
    actor,
    async (trx) =>
      (
        await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}
          where ${sql.ref(table === "properties" ? "id" : "property_id")} = ${prop}`.execute(trx)
      ).rows[0]?.n ?? 0,
  );

describe("AUD-DATA-002 — nhân viên theo phạm vi cơ sở", () => {
  it("front_desk gán A: thấy đúng 1 dòng mỗi bảng danh mục (của A); owner (mọi cơ sở) thấy cả 2", async () => {
    for (const tbl of TABLES) {
      expect(await rows(fdA, tbl, propA), `fd A ${tbl}`).toBeGreaterThan(0);
      expect(await rows(fdA, tbl, propB), `fd B ${tbl}`).toBe(0);
      expect(await rows(owner, tbl, propA), `owner A ${tbl}`).toBeGreaterThan(0);
      expect(await rows(owner, tbl, propB), `owner B ${tbl}`).toBeGreaterThan(0);
    }
  });

  it("front_desk gán A không sửa/xoá/thêm vào cơ sở B", async () => {
    const upd = await as(
      fdA,
      async (trx) =>
        (await sql`update units set code = 'X' where property_id = ${propB}`.execute(trx)).numAffectedRows,
    );
    expect(upd).toBe(0n);
    const del = await as(
      fdA,
      async (trx) => (await sql`delete from units where id = ${unitB}`.execute(trx)).numAffectedRows,
    );
    expect(del).toBe(0n);
    await expect(
      as(fdA, (trx) =>
        sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${randomUUID()}, ${orgId}, ${propB}, ${floorB}, ${roomTypeB}, 'Z-1')`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);
    // Cơ sở của chính mình vẫn sửa được.
    const ok = await as(
      fdA,
      async (trx) =>
        (await sql`update units set code = '101' where id = ${unitA}`.execute(trx)).numAffectedRows,
    );
    expect(ok).toBe(1n);
  });
});

describe("AUD-DATA-001 — người thuê chỉ thấy cơ sở có hợp đồng", () => {
  it("tenant có hợp đồng ở A thấy A, không thấy B; tenant chưa có hợp đồng không thấy gì; không ghi được", async () => {
    for (const tbl of TABLES) {
      expect(await rows(tenantA, tbl, propA), `tenantA A ${tbl}`).toBeGreaterThan(0);
      expect(await rows(tenantA, tbl, propB), `tenantA B ${tbl}`).toBe(0);
      expect(await rows(tenantNone, tbl, propA), `tenantNone A ${tbl}`).toBe(0);
      expect(await rows(tenantNone, tbl, propB), `tenantNone B ${tbl}`).toBe(0);
    }
    const upd = await as(
      tenantA,
      async (trx) =>
        (await sql`update units set code = 'HACK' where id = ${unitA}`.execute(trx)).numAffectedRows,
    );
    expect(upd).toBe(0n);
  });
});

describe("không đổi ở ngữ cảnh hệ thống", () => {
  it("không có actor (worker/đăng nhập): thấy cả 2 cơ sở như trước", async () => {
    for (const tbl of TABLES) {
      expect(await rows(null, tbl, propA), `sys A ${tbl}`).toBeGreaterThan(0);
      expect(await rows(null, tbl, propB), `sys B ${tbl}`).toBeGreaterThan(0);
    }
  });
});
