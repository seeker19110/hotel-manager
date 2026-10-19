// T-603 — `unit.create` / `unit.archive` qua HTTP thật (handleCommand) trên Postgres thật: SPEC-access-and-property S-004,
// S-005, S-006, S-014; quyền `unit.manage` (chỉ chủ/quản lý). Nghiệp vụ gốc: inventory/units.ts (test riêng ở units.db.test.ts).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { type HttpDeps, handleCommand } from "./command-route.ts";
import { COMMANDS } from "./registry.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let deps: HttpDeps;
const users: Record<string, string> = {};
let outsider: string;

const CREATE = COMMANDS["unit.create"] as NonNullable<(typeof COMMANDS)[string]>;
const ARCHIVE = COMMANDS["unit.archive"] as NonNullable<(typeof COMMANDS)[string]>;

interface Res {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
  body: any;
  headers: Headers;
}

async function run(
  def: typeof CREATE,
  body: unknown,
  who: { user?: string; org?: string; key?: string } = { user: A.ownerAuthUserId, org: A.orgId },
): Promise<Res> {
  const res = await handleCommand(
    def as never,
    new Request("http://local.test/api/v1/unit/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": who.key ?? randomUUID(),
        ...(who.user ? { "x-test-user": who.user, "x-test-2fa": "1" } : {}),
        ...(who.org ? { "x-org-id": who.org } : {}),
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const create = (extra: Record<string, unknown> = {}, who?: Parameters<typeof run>[2]) =>
  run(CREATE, { property_id: A.propertyId, floor: "Tầng 3", code: "301", capacity: 2, ...extra }, who);

const unitRows = async (code: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from units where organization_id = ${A.orgId} and lower(code) = lower(${code})`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? -1;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ HTTP phòng");
  B = await seedOrg(t.admin, "Trọ khác HTTP");
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
    secureCookies: false,
    services: testServices(),
    commandQuotaPerMinute: 100_000,
    commandMemberQuotaPerMinute: 100_000,
  };
  for (const role of ["manager", "front_desk", "accountant", "housekeeping", "maintenance", "tenant"]) {
    const actor = await seedMember(t, A, role);
    users[role] = actor.authUserId;
  }
  outsider = await seedAuthUser(t.admin, `ngoai+${randomUUID().slice(0, 6)}@example.test`);
});

afterAll(async () => {
  await t?.drop();
});

describe("unit.create qua HTTP (SPEC-access S-004, S-005, S-014)", () => {
  it("chủ và quản lý tạo phòng → 201 {unitId}; bỏ trống kind/parent_unit_id hoặc gửi kind=whole đều được", async () => {
    const r = await create({ code: "C1" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "committed", data: { unitId: expect.any(String) } });
    expect((await create({ code: "C2", kind: "whole", parent_unit_id: null })).status).toBe(201);
    expect((await create({ code: "C3" }, { user: users.manager as string, org: A.orgId })).status).toBe(201);
    expect(await unitRows("C1")).toBe(1);
  });

  it("SPEC-access S-005: kind='bed' hoặc parent_unit_id khác null → 422 VALIDATION_FAILED theo trường, không tạo gì", async () => {
    const bed = await create({ code: "BED1", kind: "bed" });
    expect(bed.status).toBe(422);
    expect(bed.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(bed.body.errors.map((e: { field: string }) => e.field)).toContain("kind");
    const child = await create({ code: "BED2", parent_unit_id: randomUUID() });
    expect(child.status).toBe(422);
    expect(child.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(child.body.errors.map((e: { field: string }) => e.field)).toContain("parent_unit_id");
    expect(await unitRows("BED1")).toBe(0);
    expect(await unitRows("BED2")).toBe(0);
  });

  it("SPEC-access S-004: mã trùng ở cùng cơ sở (không phân biệt hoa thường, bỏ khoảng trắng) → 409 UNIT_CODE_TAKEN", async () => {
    expect((await create({ code: "D1" })).status).toBe(201);
    for (const dup of ["D1", "d1", "  D1  "]) {
      const r = await create({ code: dup });
      expect(r.status, dup).toBe(409);
      expect(r.body.code).toBe("UNIT_CODE_TAKEN");
    }
    expect(await unitRows("D1")).toBe(1);
  });

  it("ca biên: mã rỗng/chỉ khoảng trắng/21 ký tự, sức chứa 0/51/số lẻ, tầng rỗng → 422; mã đúng 20 ký tự và Unicode có dấu → 201", async () => {
    for (const bad of [
      { code: "" },
      { code: "   " },
      { code: "x".repeat(21) },
      { capacity: 0 },
      { capacity: 51 },
      { capacity: 1.5 },
      { floor: "  " },
    ]) {
      const r = await create({ code: "BIEN", ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    }
    expect((await create({ code: "P".repeat(20) })).status).toBe(201);
    expect((await create({ code: "Phòng Đặc Biệt" })).status).toBe(201);
  });

  it("SPEC-access S-014: organization_id trong thân → 422 (schema chặt), không ghi gì; cùng Idempotency-Key gửi lại → một phòng, cùng kết quả", async () => {
    const forged = await create({ code: "FORGE", organization_id: B.orgId });
    expect(forged.status).toBe(422);
    expect(await unitRows("FORGE")).toBe(0);
    const key = randomUUID();
    const r1 = await create({ code: "IDEM" }, { user: A.ownerAuthUserId, org: A.orgId, key });
    const r2 = await create({ code: "IDEM" }, { user: A.ownerAuthUserId, org: A.orgId, key });
    expect(r1.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(await unitRows("IDEM")).toBe(1);
  });

  it("quyền: lễ tân/kế toán/buồng phòng/kỹ thuật/người thuê → 403; không phiên → 401; người ngoài hoặc tổ chức khác → 404; không tạo gì", async () => {
    for (const role of ["front_desk", "accountant", "housekeeping", "maintenance", "tenant"]) {
      const r = await create({ code: "QUYEN" }, { user: users[role] as string, org: A.orgId });
      expect(r.status, role).toBe(403);
      expect(r.body.code).toBe("FORBIDDEN");
    }
    expect((await create({ code: "QUYEN" }, { org: A.orgId })).status).toBe(401);
    expect((await create({ code: "QUYEN" }, { user: outsider, org: A.orgId })).status).toBe(404);
    expect((await create({ code: "QUYEN" }, { user: B.ownerAuthUserId, org: A.orgId })).status).toBe(404);
    expect(await unitRows("QUYEN")).toBe(0);
  });

  it("property_id của tổ chức khác → 404 (không phân biệt với không tồn tại), không ghi vào tổ chức đó", async () => {
    const before = await sql<{
      n: number;
    }>`select count(*)::int as n from units where organization_id = ${B.orgId}`.execute(t.admin);
    const r = await create({ code: "CHEO", property_id: B.propertyId });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
    const after = await sql<{
      n: number;
    }>`select count(*)::int as n from units where organization_id = ${B.orgId}`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe("unit.archive qua HTTP (SPEC-access S-006, INV-G7)", () => {
  const room = async (code: string) => (await create({ code })).body.data.unitId as string;
  const archivedAt = async (unit: string) =>
    (await sql<{ a: Date | null }>`select archived_at as a from units where id = ${unit}`.execute(t.admin))
      .rows[0]?.a;
  const futureAllocation = (unit: string) =>
    sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
        values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unit}, 'stay',
                tstzrange(now() + interval '1 day', now() + interval '3 days', '[)'))`.execute(t.admin);

  it("SPEC-access S-006: phòng còn allocation hiệu lực → 409 UNIT_IN_USE, archived_at vẫn null", async () => {
    const u = await room("AR-BUSY");
    await futureAllocation(u);
    const r = await run(ARCHIVE, { unit_id: u });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "UNIT_IN_USE", status: 409 });
    expect(await archivedAt(u)).toBeNull();
  });

  it("SPEC-access S-006: phòng trống → 200 kèm archivedAt, archived_at được đặt, hàng còn nguyên; lưu trữ lại → 404; quản lý cũng được", async () => {
    const u = await room("AR-FREE");
    const r = await run(ARCHIVE, { unit_id: u });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "committed", data: { unitId: u } });
    expect(await archivedAt(u)).not.toBeNull();
    expect((await run(ARCHIVE, { unit_id: u })).status).toBe(404);
    const u2 = await room("AR-MGR");
    expect(
      (await run(ARCHIVE, { unit_id: u2 }, { user: users.manager as string, org: A.orgId })).status,
    ).toBe(200);
  });

  it("quyền: vai trò không có `unit.manage` → 403 và phòng không đổi; id lạ/không phải UUID → 404/422; phòng của tổ chức khác → 404", async () => {
    const u = await room("AR-PERM");
    for (const role of ["front_desk", "accountant", "housekeeping", "maintenance", "tenant"]) {
      const r = await run(ARCHIVE, { unit_id: u }, { user: users[role] as string, org: A.orgId });
      // Người thuê chưa có hợp đồng ở cơ sở này: RLS giấu phòng (0064) ⇒ 404, không lộ sự tồn tại.
      expect(r.status, role).toBe(role === "tenant" ? 404 : 403);
    }
    expect((await run(ARCHIVE, { unit_id: u }, { org: A.orgId })).status).toBe(401);
    expect(await archivedAt(u)).toBeNull();
    expect((await run(ARCHIVE, { unit_id: randomUUID() })).status).toBe(404);
    expect((await run(ARCHIVE, { unit_id: "khong-phai-uuid" })).status).toBe(422);
    expect((await run(ARCHIVE, { unit_id: B.unitId })).status).toBe(404);
    expect(await archivedAt(B.unitId)).toBeNull();
    expect((await run(ARCHIVE, { unit_id: u }, { user: B.ownerAuthUserId, org: A.orgId })).status).toBe(404);
  });
});
