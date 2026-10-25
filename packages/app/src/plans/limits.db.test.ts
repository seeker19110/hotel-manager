// IND-SAAS-008 (D-123) — hạn mức gói ở command tạo cơ sở/phòng/mời thành viên và hạn mức lệnh/phút theo gói: đúng mốc
// (bằng hạn mức được, vượt một bị 409 PLAN_LIMIT_REACHED), tổ chức khác không bị ảnh hưởng, đọc/sửa dữ liệu sẵn có không bị chặn.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inviteMember } from "../access/invitations.ts";
import { createProperty } from "../access/property.ts";
import { type HttpDeps, handleCommand } from "../http/command-route.ts";
import { COMMANDS } from "../http/registry.ts";
import { createUnit } from "../inventory/units.ts";
import { testServices } from "../server/services.ts";
import { codeOf, ownerOf, runAs } from "../testing/helpers.ts";
import type { PlanLimits } from "./plans.ts";

// Tổ chức A dùng gói thu nhỏ; mọi tổ chức khác giữ nguyên gói mặc định.
const tiny = vi.hoisted(() => ({ plans: new Map<string, unknown>() }));
const TINY = {
  id: "free",
  properties: 3,
  rooms: 3,
  members: 3,
  commandsPerMinute: 4,
  jobConcurrency: 1,
} satisfies PlanLimits;
vi.mock("./plans.ts", async (orig) => {
  const real = await orig<typeof import("./plans.ts")>();
  return {
    ...real,
    planFor: (orgId: string) => (tiny.plans.get(orgId) as PlanLimits | undefined) ?? real.PLANS.standard,
  };
});

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let C: SeededOrg;
const KEY = Buffer.alloc(32, 7);

const newProperty = (org: SeededOrg, n: string) =>
  ownerOf(t, org).then((a) =>
    codeOf(runAs(t, a, (ctx) => createProperty(ctx, { name: `CS ${n}`, template: "rental" }))),
  );
const newUnit = (org: SeededOrg, code: string) =>
  ownerOf(t, org).then((a) =>
    codeOf(
      runAs(t, a, (ctx) =>
        createUnit(ctx, { propertyId: org.propertyId, floorName: "Tầng 1", code, capacity: 2 }),
      ),
    ),
  );
const invite = (org: SeededOrg, email: string) =>
  ownerOf(t, org).then((a) =>
    codeOf(
      runAs(t, a, (ctx) =>
        inviteMember(ctx, KEY, { email, role: "manager", propertyIds: [org.propertyId], limits: {} }),
      ),
    ),
  );

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Plan A");
  B = await seedOrg(t.admin, "Plan B");
  C = await seedOrg(t.admin, "Plan C");
  tiny.plans.set(A.orgId, { ...TINY, commandsPerMinute: 100 });
  tiny.plans.set(C.orgId, { ...TINY, properties: 100 });
});
afterAll(async () => {
  await t?.drop();
});

describe("hạn mức cơ sở", () => {
  it("bằng hạn mức được (đã có 1, tạo thêm tới 3), vượt một bị 409; tổ chức khác vẫn tạo được", async () => {
    expect(await newProperty(A, "2")).toBe("COMMITTED");
    expect(await newProperty(A, "3")).toBe("COMMITTED");
    expect(await newProperty(A, "4")).toBe("PLAN_LIMIT_REACHED");
    expect(await newProperty(B, "2")).toBe("COMMITTED");
  });
  it("thông điệp nêu hạn mức, lỗi 409", async () => {
    const a = await ownerOf(t, A);
    const r = await runAs(t, a, (ctx) => createProperty(ctx, { name: "CS 5", template: "rental" }));
    expect(r.status).not.toBe("committed");
    if (r.status !== "committed") {
      expect(r.problem.status).toBe(409);
      expect(r.problem.title).toContain("3");
    }
  });
});

describe("hạn mức phòng", () => {
  it("bằng hạn mức được, vượt một bị 409; tổ chức khác không bị ảnh hưởng", async () => {
    expect(await newUnit(A, "P1")).toBe("COMMITTED");
    expect(await newUnit(A, "P2")).toBe("COMMITTED");
    expect(await newUnit(A, "P3")).toBe("PLAN_LIMIT_REACHED");
    expect(await newUnit(B, "P1")).toBe("COMMITTED");
  });
});

describe("hạn mức thành viên", () => {
  it("chủ (1) + 2 lời mời = 3 được; lời mời thứ 3 bị 409; tổ chức khác không bị ảnh hưởng", async () => {
    expect(await invite(A, "m1@example.test")).toBe("COMMITTED");
    expect(await invite(A, "m2@example.test")).toBe("COMMITTED");
    expect(await invite(A, "m3@example.test")).toBe("PLAN_LIMIT_REACHED");
    expect(await invite(B, "m1@example.test")).toBe("COMMITTED");
  });
});

describe("hạn mức thành viên — chỉ đếm nhân viên còn hiệu lực", () => {
  it("người thuê + grant hỗ trợ còn hạn + nhân viên đã hết hạn KHÔNG chiếm chỗ; đúng mốc vẫn đúng", async () => {
    const D = await seedOrg(t.admin, "Plan D");
    tiny.plans.set(D.orgId, { ...TINY, commandsPerMinute: 100 });
    const member = async (role: string, validTo: string | null, status = "active") => {
      const personId = randomUUID();
      const au = randomUUID();
      await seedAuthUser(t.admin, `${role}-${au.slice(0, 6)}@example.test`, au);
      await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${D.orgId}, ${role})`.execute(
        t.admin,
      );
      await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, status, valid_from, valid_to)
                values (${randomUUID()}, ${D.orgId}, ${au}, ${personId}, ${role}, ${status},
                        now() - interval '10 days', ${validTo}::timestamptz)`.execute(t.admin);
    };
    await member("tenant", null);
    await member("platform_support", new Date(Date.now() + 3_600_000).toISOString());
    await member("manager", new Date(Date.now() - 3_600_000).toISOString());
    // Chủ (1) + 2 lời mời = 3 (đúng mốc) được; lời mời thứ 3 vượt ⇒ 409.
    expect(await invite(D, "d1@example.test")).toBe("COMMITTED");
    expect(await invite(D, "d2@example.test")).toBe("COMMITTED");
    expect(await invite(D, "d3@example.test")).toBe("PLAN_LIMIT_REACHED");
  });
});

describe("hạn mức lệnh/phút theo gói (route lệnh)", () => {
  it("lấy từ gói của tổ chức: lệnh mới thứ 5 trong phút bị 429 + Retry-After; tổ chức gói mặc định không bị chặn", async () => {
    const deps: HttpDeps = {
      db: t.runtime,
      getSession: async (h) => {
        const id = h.get("x-test-user");
        return id ? { user: { id, twoFactorEnabled: true } } : null;
      },
      secureCookies: false,
      services: testServices(),
    };
    const post = async (org: SeededOrg, name: string) =>
      handleCommand(
        COMMANDS["property.create"] as never,
        new Request("http://local.test/api/v1/x/y", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            "x-test-user": org.ownerAuthUserId,
            "x-org-id": org.orgId,
          },
          body: JSON.stringify({ name, template: "rental" }),
        }),
        deps,
      );
    for (let i = 0; i < TINY.commandsPerMinute; i++) expect((await post(C, `C${i}`)).status).toBe(201);
    const over = await post(C, "C-over");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await post(B, "B-ok")).status).toBe(201);
  });
});
