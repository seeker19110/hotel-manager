// T-2314 (D-130, IND-SAAS-008) — hạn mức theo gói trên Postgres thật: danh mục CSDL khớp mã, `organizations.plan` chỉ owner CSDL
// đổi được, 409 QUOTA_EXCEEDED từng loại (cơ sở, phòng — kể cả nhập liệu hàng loạt —, thành viên/lời mời, dung lượng file), hai lệnh
// song song không vượt trần, tổ chức khác không bị ảnh hưởng, hạn mức tần suất lệnh đọc từ gói.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, createProperty, inviteMember } from "../access/index.ts";
import { eicarOnlyScanner, ObjectStorage } from "../files/index.ts";
import { commitBatch, confirmBatch, uploadBatch, validateBatch } from "../import/index.ts";
import { archiveUnit, createUnit } from "../inventory/index.ts";
import { type CommandResult, toProblem } from "../pipeline/index.ts";
import { testServices } from "../server/services.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { DEFAULT_PLAN, PLAN_IDS, PLANS, PORTAL_ROLES } from "./index.ts";

let t: TestDb;
const pilot = PLANS.pilot;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.drop();
});

const n = async (q: ReturnType<typeof sql<{ n: number | string }>>) =>
  Number((await q.execute(t.admin)).rows[0]?.n ?? 0);
const problemOf = <T>(r: CommandResult<T>) =>
  r.status === "committed" ? { code: "COMMITTED", status: 200 } : r.problem;
const pgErr = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; hint?: string; message: string };
  }
  throw new Error("lẽ ra lỗi");
};

/** Dựng dữ liệu "đã dùng gần hết" bằng superuser, TẮT trigger thường cho riêng câu đó (chỉ để fixture nhanh; đường thật luôn qua trigger). */
async function bulk(q: ReturnType<typeof sql>) {
  await t.admin.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await q.execute(trx);
  });
}

const createProp = (a: Actor, name = `CS ${randomUUID().slice(0, 6)}`) =>
  runAs(t, a, (ctx) => createProperty(ctx, { name, template: "hotel" }));
const createRoom = (a: Actor, org: SeededOrg, code = `R${randomUUID().slice(0, 6)}`) =>
  runAs(t, a, (ctx) =>
    createUnit(ctx, { propertyId: org.propertyId, floorName: "Tầng 1", code, capacity: 2 }),
  );

describe("danh mục gói ở CSDL khớp mã (một nguồn: plans/catalog.ts)", () => {
  it("CHECK ck_organizations_plan liệt kê đúng PLAN_IDS; app.plan_limits(NULL) = PLANS", async () => {
    const def = (
      await sql<{ d: string }>`select pg_get_constraintdef(oid) as d from pg_constraint
                                where conname = 'ck_organizations_plan'`.execute(t.admin)
    ).rows[0]?.d as string;
    const ids = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    expect(ids).toEqual([...PLAN_IDS].sort());
    const rows = await sql<{
      plan: string;
      max_properties: number;
      max_units: number;
      max_active_members: number;
      max_storage_bytes: string;
      max_portal_storage_bytes: string;
      max_portal_storage_bytes_per_member: string;
    }>`select * from app.plan_limits(null)`.execute(t.admin);
    expect(
      rows.rows.map((r) => [
        r.plan,
        r.max_properties,
        r.max_units,
        r.max_active_members,
        Number(r.max_storage_bytes),
        Number(r.max_portal_storage_bytes),
        Number(r.max_portal_storage_bytes_per_member),
      ]),
    ).toEqual(
      [...PLAN_IDS]
        .sort()
        .map((id) => [
          id,
          PLANS[id].maxProperties,
          PLANS[id].maxUnits,
          PLANS[id].maxActiveMembers,
          PLANS[id].maxStorageBytes,
          PLANS[id].maxPortalStorageBytes,
          PLANS[id].maxPortalStorageBytesPerMember,
        ]),
    );
  });

  it("DEFAULT organizations.plan = DEFAULT_PLAN = gói trigger INSERT cho phép; vai cổng của trigger = PORTAL_ROLES", async () => {
    const col = await sql<{ d: string }>`select pg_get_expr(d.adbin, d.adrelid) as d from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.organizations'::regclass and a.attname = 'plan'`.execute(t.admin);
    expect(col.rows[0]?.d).toBe(`'${DEFAULT_PLAN}'::text`);
    const guard = await sql<{
      d: string;
    }>`select pg_get_functiondef('app.organizations_plan_insert_guard()'::regprocedure) as d`.execute(
      t.admin,
    );
    expect(guard.rows[0]?.d).toContain(`IS DISTINCT FROM '${DEFAULT_PLAN}'`);
    const quota = await sql<{
      d: string;
    }>`select pg_get_functiondef('app.enforce_plan_quota()'::regprocedure) as d`.execute(t.admin);
    const roles = PORTAL_ROLES.map((r) => `'${r}'`).join(", ");
    expect(quota.rows[0]?.d).toContain(`v_uploader_role IN (${roles})`);
    expect(quota.rows[0]?.d).toContain(`m.role IN (${roles})`);
  });

  it("tổ chức mới mặc định 'pilot'; giá trị ngoài danh mục bị CHECK chặn", async () => {
    const o = await seedOrg(t.admin, "Mặc định");
    expect(
      await n(sql`select count(*) as n from organizations where id = ${o.orgId} and plan = 'pilot'`),
    ).toBe(1);
    const e = await pgErr(
      sql`insert into organizations (id, name, created_by, plan) values (${randomUUID()}, 'X', ${o.ownerAuthUserId}, 'gold')`.execute(
        t.admin,
      ),
    );
    expect(e.code).toBe("23514");
  });
});

describe("chỉ owner CSDL đổi được organizations.plan", () => {
  it("app_runtime (kể cả owner tổ chức trong ngữ cảnh của mình) đổi plan ⇒ 42501 FORBIDDEN; settings vẫn đổi được", async () => {
    const o = await seedOrg(t.admin, "Đổi gói");
    const ctx = { orgId: o.orgId, actorId: o.ownerMembershipId };
    const e = await pgErr(
      withTenant(t.runtime, ctx, (trx) =>
        sql`update organizations set plan = 'enterprise' where id = ${o.orgId}`.execute(trx),
      ),
    );
    expect([e.code, e.hint]).toEqual(["42501", "FORBIDDEN"]);
    expect(toProblem(e)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await withTenant(t.runtime, ctx, (trx) =>
      sql`update organizations set settings = settings || '{"x":1}'::jsonb where id = ${o.orgId}`.execute(
        trx,
      ),
    );
    // app_worker cũng không đổi được (không có quyền UPDATE hoặc bị guard chặn).
    const w = await pgErr(
      sql`update organizations set plan = 'enterprise' where id = ${o.orgId}`.execute(t.worker),
    );
    expect(["42501"]).toContain(w.code);
    expect(
      await n(sql`select count(*) as n from organizations where id = ${o.orgId} and plan = 'pilot'`),
    ).toBe(1);
  });

  it("owner CSDL qua được guard (gói lạ vẫn bị CHECK chặn; gán gói trong danh mục thành công)", async () => {
    const o = await seedOrg(t.admin, "Owner đổi gói");
    const e = await pgErr(
      sql`update organizations set plan = 'enterprise' where id = ${o.orgId}`.execute(t.admin),
    );
    expect(e.code).toBe("23514");
    await sql`update organizations set plan = 'pilot' where id = ${o.orgId}`.execute(t.admin);
    // Câu lệnh của runbook docs/ops/runbooks/plan-change.md (đổi gói + audit một transaction).
    const r = await sql`
      with old as (select plan from organizations where id = ${o.orgId} for update),
           upd as (update organizations set plan = ${"pilot"} where id = ${o.orgId} returning plan)
      insert into audit_events (id, organization_id, actor_type, action, entity_type, entity_id, before, after, reason, correlation_id)
      select gen_random_uuid(), ${o.orgId}, 'worker', 'organization.plan_changed', 'organization', ${o.orgId},
             jsonb_build_object('plan', old.plan), jsonb_build_object('plan', upd.plan), ${"T-0001"}, 'ops-plan-change'
      from old, upd`.execute(t.admin);
    expect(Number(r.numAffectedRows)).toBe(1);
  });
});

describe("app_runtime không tự chọn organizations.plan khi INSERT (D-132)", () => {
  it("app_runtime INSERT tổ chức với gói khác mặc định ⇒ 42501 FORBIDDEN; không ghi gói ⇒ mặc định; ghi đúng gói mặc định ⇒ được", async () => {
    const o = await seedOrg(t.admin, "Chèn gói");
    const ctx = { orgId: o.orgId, actorId: o.ownerMembershipId };
    const ins = (id: string, plan?: string) =>
      withTenant(t.runtime, { ...ctx, orgId: id }, (trx) =>
        plan === undefined
          ? sql`insert into organizations (id, name, created_by) values (${id}, 'Mới', ${o.ownerAuthUserId})`.execute(
              trx,
            )
          : sql`insert into organizations (id, name, created_by, plan) values (${id}, 'Mới', ${o.ownerAuthUserId}, ${plan})`.execute(
              trx,
            ),
      );
    // Gói lạ bị guard chặn trước CHECK (42501, không phải 23514) — kể cả khi danh mục sau này có thêm gói.
    const bad = randomUUID();
    const e = await pgErr(ins(bad, "enterprise"));
    expect([e.code, e.hint]).toEqual(["42501", "FORBIDDEN"]);
    expect(toProblem(e)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await n(sql`select count(*) as n from organizations where id = ${bad}`)).toBe(0);
    const ok1 = randomUUID();
    await ins(ok1);
    const ok2 = randomUUID();
    await ins(ok2, DEFAULT_PLAN);
    expect(
      await n(
        sql`select count(*) as n from organizations where id in (${ok1}, ${ok2}) and plan = ${DEFAULT_PLAN}`,
      ),
    ).toBe(2);
  });

  it("owner CSDL tạo tổ chức qua được guard (gói ngoài danh mục vẫn bị CHECK chặn)", async () => {
    const o = await seedOrg(t.admin, "Owner chèn gói");
    const e = await pgErr(
      sql`insert into organizations (id, name, created_by, plan) values (${randomUUID()}, 'X', ${o.ownerAuthUserId}, 'gold')`.execute(
        t.admin,
      ),
    );
    expect(e.code).toBe("23514");
  });

  it("app.invitation_by_token trả gói của tổ chức (actor nhận lời mời mang gói thật)", async () => {
    const o = await seedOrg(t.admin, "Lời mời gói");
    const owner = await ownerOf(t, o);
    const key = testServices().invitationKey;
    const r = await runAs(t, owner, (ctx) =>
      inviteMember(ctx, key, { email: "goi@example.test", role: "accountant", propertyIds: [], limits: {} }),
    );
    expect(r.status).toBe("committed");
    const hash = (
      await sql<{
        h: Buffer;
      }>`select token_hash as h from invitations where organization_id = ${o.orgId}`.execute(t.admin)
    ).rows[0]?.h as Buffer;
    // Như accept-invitation: app_runtime, CHƯA có ngữ cảnh tổ chức.
    const row = await sql<{ organization_id: string; plan: string }>`
      select organization_id, plan from app.invitation_by_token(${hash})`.execute(t.runtime);
    expect(row.rows).toEqual([{ organization_id: o.orgId, plan: DEFAULT_PLAN }]);
  });
});

describe("QUOTA_EXCEEDED: cơ sở", () => {
  it("đủ trần ⇒ 409; tổ chức khác không ảnh hưởng; lưu trữ một cơ sở thì tạo được; bỏ lưu trữ khi đầy ⇒ chặn", async () => {
    const A = await seedOrg(t.admin, "Cơ sở A");
    const B = await seedOrg(t.admin, "Cơ sở B");
    const [oa, ob] = await Promise.all([ownerOf(t, A), ownerOf(t, B)]);
    expect(oa.plan).toBe("pilot");
    await bulk(sql`insert into properties (id, organization_id, name, template)
                   select gen_random_uuid(), ${A.orgId}, 'CS ' || g, 'hotel' from generate_series(2, ${pilot.maxProperties}) g`);
    const full = problemOf(await createProp(oa));
    expect(full).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(problemOf(await createProp(ob)).code).toBe("COMMITTED");
    const active = sql<{
      n: number;
    }>`select count(*) as n from properties where organization_id = ${A.orgId} and archived_at is null`;
    expect(await n(active)).toBe(pilot.maxProperties);

    const archived = (
      await sql<{ id: string }>`update properties set archived_at = now()
        where id = (select id from properties where organization_id = ${A.orgId} and id <> ${A.propertyId} limit 1)
        returning id`.execute(t.admin)
    ).rows[0]?.id as string;
    expect(problemOf(await createProp(oa)).code).toBe("COMMITTED");
    const e = await pgErr(
      sql`update properties set archived_at = null where id = ${archived}`.execute(t.admin),
    );
    expect(toProblem(e)).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(await n(active)).toBe(pilot.maxProperties);
  });

  it("song song: còn 1 chỗ, 6 lệnh cùng lúc ⇒ đúng 1 thành công, không vượt trần", async () => {
    const A = await seedOrg(t.admin, "Cơ sở song song");
    const oa = await ownerOf(t, A);
    await bulk(sql`insert into properties (id, organization_id, name, template)
                   select gen_random_uuid(), ${A.orgId}, 'CS ' || g, 'hotel' from generate_series(3, ${pilot.maxProperties}) g`);
    const codes = (
      await Promise.all(Array.from({ length: 6 }, (_, i) => createProp(oa, `Song song ${i}`)))
    ).map((r) => problemOf(r).code);
    expect(codes.filter((c) => c === "COMMITTED")).toHaveLength(1);
    expect(codes.filter((c) => c === "QUOTA_EXCEEDED")).toHaveLength(5);
    expect(
      await n(
        sql`select count(*) as n from properties where organization_id = ${A.orgId} and archived_at is null`,
      ),
    ).toBe(pilot.maxProperties);
  });
});

describe("QUOTA_EXCEEDED: phòng (lệnh tạo phòng + nhập liệu hàng loạt)", () => {
  let U: SeededOrg;
  let owner: Actor;
  let manager: Actor;
  let storage: ObjectStorage;
  const activeUnits = () =>
    n(sql`select count(*) as n from units where organization_id = ${U.orgId} and archived_at is null`);

  beforeAll(async () => {
    storage = new ObjectStorage(testS3Config());
    await storage.ensureBucket();
    U = await seedOrg(t.admin, "Phòng U", "rental");
    owner = await ownerOf(t, U);
    manager = await seedMember(t, U, "manager", { properties: [U.propertyId] });
    // seedOrg đã có 1 phòng ⇒ còn đúng 2 chỗ.
    await bulk(sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
                   select gen_random_uuid(), ${U.orgId}, ${U.propertyId}, ${U.floorId}, ${U.roomTypeId}, 'Q' || g
                   from generate_series(1, ${pilot.maxUnits - 3}) g`);
  });

  const deps = () => ({ storage, scanner: eicarOnlyScanner });
  const csv = (rows: (string | number)[][]) =>
    new TextEncoder().encode(rows.map((r) => r.join(",")).join("\r\n"));
  async function importUnits(codes: string[]) {
    const bytes = csv([
      ["external_id", "unit_code", "floor", "capacity"],
      ...codes.map((c) => [`X-${c}`, c, "Tầng 9", 2]),
    ]);
    const up = await runAs(t, manager, (ctx) =>
      uploadBatch(ctx, deps(), { propertyId: U.propertyId, kind: "units", bytes }),
    );
    if (up.status !== "committed") throw new Error(JSON.stringify(up.problem));
    const { batchId } = up.data;
    const v = await runAs(t, manager, (ctx) => validateBatch(ctx, { batchId }));
    if (v.status !== "committed" || v.data.counts.error > 0) throw new Error(JSON.stringify(v));
    const c = await runAs(t, owner, (ctx) => confirmBatch(ctx, { batchId }));
    if (c.status !== "committed") throw new Error(JSON.stringify(c.problem));
    return runAs(t, owner, (ctx) => commitBatch(ctx, { batchId }));
  }

  it("nhập 3 phòng khi còn 2 chỗ ⇒ commit 409 QUOTA_EXCEEDED, KHÔNG ghi phòng nào (một transaction)", async () => {
    const before = await activeUnits();
    expect(before).toBe(pilot.maxUnits - 2);
    expect(problemOf(await importUnits(["N1", "N2", "N3"]))).toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 409,
    });
    expect(await activeUnits()).toBe(before);
  });

  it("một câu INSERT nhiều hàng vượt trần (app_runtime) ⇒ cả câu bị từ chối", async () => {
    const e = await pgErr(
      withTenant(t.runtime, { orgId: U.orgId, actorId: U.ownerMembershipId }, (trx) =>
        sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            select gen_random_uuid(), ${U.orgId}, ${U.propertyId}, ${U.floorId}, ${U.roomTypeId}, 'M' || g
            from generate_series(1, 3) g`.execute(trx),
      ),
    );
    expect(toProblem(e)).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(await activeUnits()).toBe(pilot.maxUnits - 2);
  });

  it("nhập 2 phòng vừa đủ ⇒ commit; tạo thêm 1 phòng ⇒ 409; lưu trữ 1 phòng ⇒ tạo lại được", async () => {
    expect(problemOf(await importUnits(["V1", "V2"])).code).toBe("COMMITTED");
    expect(await activeUnits()).toBe(pilot.maxUnits);
    expect(problemOf(await createRoom(owner, U))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    const r = await runAs(t, owner, (ctx) => archiveUnit(ctx, { unitId: U.unitId }));
    expect(problemOf(r).code).toBe("COMMITTED");
    expect(problemOf(await createRoom(owner, U)).code).toBe("COMMITTED");
    expect(await activeUnits()).toBe(pilot.maxUnits);
  });

  it("tổ chức khác vẫn tạo phòng bình thường", async () => {
    const B = await seedOrg(t.admin, "Phòng B");
    expect(problemOf(await createRoom(await ownerOf(t, B), B)).code).toBe("COMMITTED");
  });
});

async function addStaff(org: SeededOrg, role = "manager") {
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  const user = await seedAuthUser(t.admin, `${randomUUID().slice(0, 8)}@example.test`);
  return sql`insert into memberships (id, organization_id, person_id, role, auth_user_id)
             values (${randomUUID()}, ${org.orgId}, ${person}, ${role}, ${user})`.execute(t.admin);
}

describe("QUOTA_EXCEEDED: thành viên nhân viên + lời mời chờ", () => {
  it("lời mời chờ tính vào trần; tenant/platform_support không tính; thu hồi giải phóng chỗ; kích hoạt lại khi đầy ⇒ chặn", async () => {
    const M = await seedOrg(t.admin, "Thành viên");
    const owner = await ownerOf(t, M);
    const key = testServices().invitationKey;
    // owner + (max − 2) nhân viên ⇒ còn 1 chỗ.
    await bulk(sql`
      with p as (insert into persons (id, organization_id, full_name)
                 select gen_random_uuid(), ${M.orgId}, 'NV ' || g from generate_series(1, ${pilot.maxActiveMembers - 2}) g
                 returning id)
      insert into memberships (id, organization_id, person_id, role) select gen_random_uuid(), ${M.orgId}, p.id, 'housekeeping' from p`);
    const invite = (email: string) =>
      runAs(t, owner, (ctx) =>
        inviteMember(ctx, key, { email, role: "accountant", propertyIds: [], limits: {} }),
      );
    expect(problemOf(await invite("ke-toan-1@example.test")).code).toBe("COMMITTED");
    expect(problemOf(await invite("ke-toan-2@example.test"))).toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 409,
    });

    // Người thuê (cổng) không tính vào trần nhân viên.
    const tenantPerson = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${tenantPerson}, ${M.orgId}, 'Người thuê')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, person_id, role)
              values (${randomUUID()}, ${M.orgId}, ${tenantPerson}, 'tenant')`.execute(t.admin);

    // Đầy (owner + max−2 + 1 lời mời chờ) — membership nhân viên mới (vd nhận lời mời) vẫn vừa trần thành viên active.
    const staff = await sql<{
      id: string;
    }>`select id from memberships where organization_id = ${M.orgId} and role = 'housekeeping' limit 1`.execute(
      t.admin,
    );
    const revoked = staff.rows[0]?.id as string;
    await sql`update memberships set status = 'revoked', revoked_at = now() where id = ${revoked}`.execute(
      t.admin,
    );
    expect(problemOf(await invite("ke-toan-2@example.test")).code).toBe("COMMITTED");
    // Trần membership active chỉ đếm membership (lời mời chờ đã giữ chỗ lúc mời; nhận lời mời khi đầy bị chặn ở bước này).
    await sql`update memberships set status = 'active', revoked_at = null where id = ${revoked}`.execute(
      t.admin,
    );
    await addStaff(M);
    expect(toProblem(await pgErr(addStaff(M)))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(
      await n(sql`select count(*) as n from memberships where organization_id = ${M.orgId} and status = 'active'
                  and role not in ('tenant', 'platform_support')`),
    ).toBe(pilot.maxActiveMembers);

    // Tổ chức khác không bị ảnh hưởng.
    const B = await seedOrg(t.admin, "Thành viên B");
    const r = await runAs(t, await ownerOf(t, B), (ctx) =>
      inviteMember(ctx, key, {
        email: "ke-toan-b@example.test",
        role: "accountant",
        propertyIds: [],
        limits: {},
      }),
    );
    expect(problemOf(r).code).toBe("COMMITTED");
  });

  it("đủ trần thành viên active ⇒ thêm membership nhân viên bị chặn, tenant vẫn thêm được", async () => {
    const M = await seedOrg(t.admin, "Thành viên đầy");
    await bulk(sql`
      with p as (insert into persons (id, organization_id, full_name)
                 select gen_random_uuid(), ${M.orgId}, 'NV ' || g from generate_series(1, ${pilot.maxActiveMembers - 1}) g
                 returning id)
      insert into memberships (id, organization_id, person_id, role) select gen_random_uuid(), ${M.orgId}, p.id, 'front_desk' from p`);
    expect(toProblem(await pgErr(addStaff(M)))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    await addStaff(M, "tenant");
  });
});

describe("QUOTA_EXCEEDED: dung lượng file", () => {
  it("tổng byte vượt trần ⇒ 409; vừa đủ thì được; bản xuất dữ liệu/ file bị từ chối không tính; gửi lại cùng id không tính lại", async () => {
    const S = await seedOrg(t.admin, "File S");
    const ctx = { orgId: S.orgId, actorId: S.ownerMembershipId };
    const file = (
      db: Kysely<unknown>,
      size: number,
      opts: { id?: string; owner?: string; status?: string } = {},
    ) => {
      const id = opts.id ?? randomUUID();
      const owner = opts.owner ?? "work_order";
      return sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, reject_reason,
                                    uploaded_by)
                 values (${id}, ${S.orgId}, ${owner}, 'application/pdf', ${size}, ${"a".repeat(64)}, ${opts.status ?? "pending_scan"},
                         ${`${S.orgId}/${owner}/${id}`}, ${opts.status === "rejected" ? "malware" : null}, ${S.ownerMembershipId})
                 on conflict do nothing`.execute(db);
    };
    await file(t.admin, pilot.maxStorageBytes - 10);
    const tooBig = await pgErr(withTenant(t.runtime, ctx, (trx) => file(trx, 11)));
    expect(toProblem(tooBig)).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    // Qua pipeline lệnh: problem 409 QUOTA_EXCEEDED, không lưu gì.
    const owner = await ownerOf(t, S);
    const viaCommand = await runAs(t, owner, (c) => file(c.trx, 11));
    expect(problemOf(viaCommand)).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    await file(t.admin, 5000, { owner: "export_job" });
    await file(t.admin, 5000, { status: "rejected" });
    const last = randomUUID();
    await withTenant(t.runtime, ctx, (trx) => file(trx, 10, { id: last }));
    // Đầy đúng trần: gửi lại dòng staging cùng id (ON CONFLICT DO NOTHING) không bị tính lần nữa.
    await withTenant(t.runtime, ctx, (trx) => file(trx, 10, { id: last }));
    expect(
      await n(sql`select coalesce(sum(size_bytes), 0) as n from files where organization_id = ${S.orgId}
                  and status in ('pending_scan','ready') and owner_type <> 'export_job'`),
    ).toBe(pilot.maxStorageBytes);
    // Tổ chức khác không ảnh hưởng.
    const B = await seedOrg(t.admin, "File B");
    await withTenant(t.runtime, { orgId: B.orgId, actorId: B.ownerMembershipId }, (trx) =>
      sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, uploaded_by)
          values (${randomUUID()}, ${B.orgId}, 'work_order', 'application/pdf', 1000, ${"b".repeat(64)}, 'pending_scan',
                  ${`${B.orgId}/work_order/${randomUUID()}`}, ${B.ownerMembershipId})`.execute(trx),
    );
  });
});

describe("QUOTA_EXCEEDED: dung lượng con của người dùng cổng (D-132)", () => {
  const MiB = 1024 ** 2;
  async function portalMember(org: SeededOrg, role: "tenant" | "guest" = "tenant") {
    const person = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
      t.admin,
    );
    const id = randomUUID();
    await sql`insert into memberships (id, organization_id, person_id, role) values (${id}, ${org.orgId}, ${person}, ${role})`.execute(
      t.admin,
    );
    return id;
  }
  /** Ghi file như người tải `by` (RLS người dùng cổng: owner_type payment_claim/work_order, uploaded_by = chính mình). */
  const put = (
    org: SeededOrg,
    by: string,
    size: number,
    opts: { owner?: string; status?: string; db?: "runtime" | "admin" } = {},
  ) => {
    const id = randomUUID();
    const owner = opts.owner ?? "payment_claim";
    const q = sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, reject_reason,
                                     uploaded_by)
                  values (${id}, ${org.orgId}, ${owner}, 'image/jpeg', ${size}, ${"c".repeat(64)}, ${opts.status ?? "pending_scan"},
                          ${`${org.orgId}/${owner}/${id}`}, ${opts.status === "rejected" ? "malware" : null}, ${by})`;
    return opts.db === "admin"
      ? q.execute(t.admin)
      : withTenant(t.runtime, { orgId: org.orgId, actorId: by }, (trx) => q.execute(trx));
  };
  const quota = async (p: Promise<unknown>) => toProblem(await pgErr(p));

  it("mỗi người dùng cổng ≤ 200 MiB: chạm trần ⇒ 409; người khác và NHÂN VIÊN vẫn tải được; file bị từ chối/bản xuất không tính", async () => {
    const P = await seedOrg(t.admin, "Cổng mỗi người");
    const tenantActor = await seedMember(t, P, "tenant");
    const tenant = tenantActor.membershipId;
    const other = await portalMember(P);
    await put(P, tenant, pilot.maxPortalStorageBytesPerMember - 10);
    await put(P, tenant, 5 * MiB, { status: "rejected", db: "admin" });
    await put(P, tenant, 5 * MiB, { owner: "export_job", db: "admin" });
    await put(P, tenant, 10);
    expect(await quota(put(P, tenant, 1))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    // Người thuê khác của cùng tổ chức và nhân viên (owner) không bị ảnh hưởng.
    await put(P, other, MiB);
    await put(P, P.ownerMembershipId, 50 * MiB, { owner: "work_order" });
    // Qua pipeline lệnh (vai tenant): 409 QUOTA_EXCEEDED, không lưu gì.
    const before = await n(sql`select count(*) as n from files where uploaded_by = ${tenant}`);
    const viaCommand = await runAs(t, tenantActor, (c) =>
      sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, uploaded_by)
            values (${randomUUID()}, ${P.orgId}, 'payment_claim', 'image/jpeg', 1, ${"d".repeat(64)}, 'pending_scan',
                    ${`${P.orgId}/payment_claim/${randomUUID()}`}, ${tenant})`.execute(c.trx),
    );
    expect(problemOf(viaCommand)).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(await n(sql`select count(*) as n from files where uploaded_by = ${tenant}`)).toBe(before);
  });

  it("tổng mọi người dùng cổng (tenant + guest) ≤ 2% trần tổ chức: chạm ⇒ 409 cho người dùng cổng MỚI; nhân viên vẫn tải được", async () => {
    const P = await seedOrg(t.admin, "Cổng tổng");
    const per = pilot.maxPortalStorageBytesPerMember;
    const full = Math.floor(pilot.maxPortalStorageBytes / per);
    // Fixture: `full` người thuê mỗi người đủ trần riêng, + 1 khách lưu trú phần dư − 1 byte ⇒ tổng cổng = trần − 1.
    for (let i = 0; i < full; i++) await put(P, await portalMember(P), per, { db: "admin" });
    const guest = await portalMember(P, "guest");
    const rest = pilot.maxPortalStorageBytes - full * per;
    await put(P, guest, rest - 1, { db: "admin" });
    const fresh = await portalMember(P);
    await put(P, fresh, 1);
    expect(await quota(put(P, fresh, 1))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    expect(await quota(put(P, guest, 1))).toMatchObject({ code: "QUOTA_EXCEEDED", status: 409 });
    await put(P, P.ownerMembershipId, 100 * MiB, { owner: "work_order" });
    expect(
      await n(sql`select coalesce(sum(f.size_bytes), 0) as n from files f join memberships m on m.id = f.uploaded_by
                  where f.organization_id = ${P.orgId} and m.role in ('tenant', 'guest') and f.status in ('pending_scan','ready')`),
    ).toBe(pilot.maxPortalStorageBytes);
    // Tổ chức khác không ảnh hưởng.
    const Q = await seedOrg(t.admin, "Cổng tổng Q");
    await put(Q, await portalMember(Q), MiB);
  });

  it("song song: người thuê còn 1 MiB, 5 file 1 MiB cùng lúc ⇒ đúng 1 thành công", async () => {
    const P = await seedOrg(t.admin, "Cổng song song");
    const tenant = await portalMember(P);
    await put(P, tenant, pilot.maxPortalStorageBytesPerMember - MiB, { db: "admin" });
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => put(P, tenant, MiB)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of res)
      if (r.status === "rejected") expect(toProblem(r.reason)).toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(
      await n(sql`select coalesce(sum(size_bytes), 0) as n from files where uploaded_by = ${tenant}`),
    ).toBe(pilot.maxPortalStorageBytesPerMember);
  });
});

describe("hạn mức tần suất lệnh đọc từ gói của tổ chức", () => {
  it("đổi hạn mức thành viên của gói pilot ⇒ pipeline chặn theo giá trị mới (429 RATE_LIMITED)", async () => {
    const R = await seedOrg(t.admin, "Tần suất");
    const owner = await ownerOf(t, R);
    const rate = pilot.commandsPerMinute as { org: number; member: number };
    const saved = rate.member;
    rate.member = 2;
    try {
      const codes: string[] = [];
      for (let i = 0; i < 3; i++) codes.push(problemOf(await runAs(t, owner, async () => i)).code);
      expect(codes).toEqual(["COMMITTED", "COMMITTED", "RATE_LIMITED"]);
    } finally {
      rate.member = saved;
    }
  });
});
