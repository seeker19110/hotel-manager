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
let coTenant: string; // người ở co_tenant của hợp đồng ở A (không phải đại diện)
let occupantOnly: string; // chỉ là người ở (occupant) — không có quyền xem
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
  const leaseRow = (
    await sql<{ unit_id: string }>`select unit_id from leases where id = ${leaseId}`.execute(t.admin)
  ).rows[0];
  expect(leaseRow).toBeDefined();
  for (const [role, label] of [
    ["co_tenant", "co"],
    ["occupant", "occ"],
  ] as const) {
    const m = await member("tenant");
    await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on)
              values (${randomUUID()}, ${orgId}, ${propA}, ${leaseId}, ${m.personId}, ${role}, false, '2026-09-01')`.execute(
      t.admin,
    );
    if (label === "co") coTenant = m.id;
    else occupantOnly = m.id;
  }
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

describe("người thuê không ghi được vào danh mục", () => {
  it("INSERT/UPDATE/DELETE của tenant bị chặn trên cả 4 bảng (kể cả cơ sở mình thuê)", async () => {
    const stmts: Record<
      string,
      [ins: ReturnType<typeof sql>, upd: ReturnType<typeof sql>, del: ReturnType<typeof sql>]
    > = {
      properties: [
        sql`insert into properties (id, organization_id, name, template) values (${randomUUID()}, ${orgId}, 'X', 'hotel')`,
        sql`update properties set name = 'HACK' where id = ${propA}`,
        sql`delete from properties where id = ${propA}`,
      ],
      floors: [
        sql`insert into floors (id, organization_id, property_id, name) values (${randomUUID()}, ${orgId}, ${propA}, 'X')`,
        sql`update floors set name = 'HACK' where property_id = ${propA}`,
        sql`delete from floors where property_id = ${propA}`,
      ],
      room_types: [
        sql`insert into room_types (id, organization_id, property_id, code, name, capacity) values (${randomUUID()}, ${orgId}, ${propA}, 'Z', 'Z', 1)`,
        sql`update room_types set name = 'HACK' where property_id = ${propA}`,
        sql`delete from room_types where property_id = ${propA}`,
      ],
      units: [
        sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            select ${randomUUID()}, ${orgId}, ${propA}, floor_id, room_type_id, 'Z-9' from units where id = ${unitA}`,
        sql`update units set code = 'HACK' where property_id = ${propA}`,
        sql`delete from units where property_id = ${propA}`,
      ],
    };
    for (const [tbl, [ins, upd, del]] of Object.entries(stmts)) {
      await expect(
        as(tenantA, (trx) => ins.execute(trx)),
        `insert ${tbl}`,
      ).rejects.toThrow();
      expect(
        await as(tenantA, async (trx) => (await upd.execute(trx)).numAffectedRows),
        `update ${tbl}`,
      ).toBe(0n);
      expect(
        await as(tenantA, async (trx) => (await del.execute(trx)).numAffectedRows),
        `delete ${tbl}`,
      ).toBe(0n);
    }
  });
});

describe("người ở trong hợp đồng", () => {
  it("co_tenant thấy cơ sở của hợp đồng (báo sự cố được); occupant thuần không thấy", async () => {
    expect(await rows(coTenant, "units", propA)).toBeGreaterThan(0);
    expect(await rows(coTenant, "units", propB)).toBe(0);
    expect(await rows(occupantOnly, "units", propA)).toBe(0);
  });
});

describe("hiệu năng: kiểm theo tập, không theo từng dòng (review #101)", () => {
  it("đọc ~1500 phòng bằng owner/front_desk/tenant: trung vị < 200 ms (kiểm từng dòng bằng hàm SECURITY DEFINER ≈ 0,35 ms/dòng ≈ 500 ms)", async () => {
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              select gen_random_uuid(), ${orgId}, ${propA}, u.floor_id, u.room_type_id, 'P-' || g
              from units u, generate_series(1, 1500) g where u.id = ${unitA}`.execute(t.admin);
    for (const [who, actor] of [
      ["owner", owner],
      ["front_desk", fdA],
      ["tenant", tenantA],
    ] as const) {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const n = await rows(actor, "units", propA);
        times.push(performance.now() - t0);
        expect(n, who).toBeGreaterThan(1500);
      }
      times.sort((a, b) => a - b);
      expect(times[2] as number, `${who} trung vị ms`).toBeLessThan(200);
    }
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
