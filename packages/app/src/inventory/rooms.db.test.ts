// T-014 — danh sách phòng theo phạm vi cơ sở + chọn tổ chức chỉ trong số tổ chức có membership (S-020, TM-01).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "../access/actor.ts";
import {
  organizationContext,
  orgCookieName,
  requestedOrgId,
  selectOrganization,
  switchOrganization,
} from "../access/org-context.ts";
import { getCommandResult } from "../pipeline/command.ts";
import { listRooms } from "./rooms.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let property2: string;
let staffUser: string;

async function addMember(orgId: string, authUserId: string, role: string, propertyIds: string[] | "all") {
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${orgId}, ${`NV ${role}`})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${orgId}, ${authUserId}, ${person}, ${role}, ${propertyIds === "all"})`.execute(
    t.admin,
  );
  if (propertyIds !== "all") {
    for (const p of propertyIds) {
      await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
                values (${randomUUID()}, ${orgId}, ${membership}, ${p})`.execute(t.admin);
    }
  }
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Phạm Vi");
  B = await seedOrg(t.admin, "KS Ngoài");
  property2 = randomUUID();
  const floor2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${property2}, ${A.orgId}, 'KS Phạm Vi — CS2', 'hotel')`.execute(
    t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name) values (${floor2}, ${A.orgId}, ${property2}, 'Tầng 2')`.execute(
    t.admin,
  );
  await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${randomUUID()}, ${A.orgId}, ${property2}, ${floor2}, '201')`.execute(
    t.admin,
  );
  staffUser = await seedAuthUser(t.admin, `bp+${randomUUID().slice(0, 6)}@example.test`);
  await addMember(A.orgId, staffUser, "housekeeping", [A.propertyId]);
  await addMember(B.orgId, staffUser, "tenant", []);
});

afterAll(async () => {
  await t.drop();
});

describe("listRooms", () => {
  it("buồng phòng chỉ thấy phòng của cơ sở được giao", async () => {
    const actor = await resolveActor(t.runtime, {
      authUserId: staffUser,
      orgId: A.orgId,
      twoFactorEnabled: false,
    });
    const r = await listRooms(t.runtime, actor);
    expect(r.map((p) => p.propertyId)).toEqual([A.propertyId]);
    expect(r[0]?.rooms.map((x) => x.code)).toEqual(["101"]);
  });

  it("owner thấy mọi cơ sở của tổ chức mình, không thấy tổ chức khác", async () => {
    const owner = await resolveActor(t.runtime, {
      authUserId: A.ownerAuthUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    const r = await listRooms(t.runtime, owner);
    expect(r.map((p) => p.propertyId).sort()).toEqual([A.propertyId, property2].sort());
    expect(r.flatMap((p) => p.rooms.map((x) => x.code)).sort()).toEqual(["101", "201"]);
  });

  it("phạm vi rỗng (chưa được giao cơ sở nào) → danh sách rỗng, không rơi về 'mọi cơ sở'", async () => {
    const actor = await resolveActor(t.runtime, {
      authUserId: staffUser,
      orgId: A.orgId,
      twoFactorEnabled: false,
    });
    expect(await listRooms(t.runtime, { ...actor, allProperties: false, propertyIds: [] })).toEqual([]);
  });

  it("vai trò không có quyền xem lịch (tenant) → FORBIDDEN", async () => {
    const tenant = await resolveActor(t.runtime, {
      authUserId: staffUser,
      orgId: B.orgId,
      twoFactorEnabled: false,
    });
    await expect(listRooms(t.runtime, tenant)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("chọn tổ chức (S-020)", () => {
  it("chỉ chọn được tổ chức có membership; ID lạ hoặc của người khác → null", async () => {
    expect((await selectOrganization(t.runtime, staffUser, A.orgId))?.role).toBe("housekeeping");
    expect((await selectOrganization(t.runtime, staffUser, B.orgId))?.role).toBe("tenant");
    const stranger = await seedAuthUser(t.admin, `la+${randomUUID().slice(0, 6)}@example.test`);
    expect(await selectOrganization(t.runtime, stranger, A.orgId)).toBeNull();
    expect(await selectOrganization(t.runtime, staffUser, randomUUID())).toBeNull();
  });

  it("ngữ cảnh: chỉ cơ sở trong phạm vi; một cơ sở → tự chọn; cơ sở ngoài phạm vi → null", async () => {
    const ctx = await organizationContext(t.runtime, staffUser, A.orgId);
    expect(ctx).toMatchObject({
      organization: { id: A.orgId },
      role: "housekeeping",
      property: { id: A.propertyId },
      properties: [{ id: A.propertyId }],
    });
    expect(await organizationContext(t.runtime, staffUser, A.orgId, property2)).toBeNull();
    const ownerCtx = await organizationContext(t.runtime, A.ownerAuthUserId, A.orgId);
    expect(ownerCtx?.properties).toHaveLength(2);
    expect(ownerCtx?.property).toBeNull();
    expect((await organizationContext(t.runtime, A.ownerAuthUserId, A.orgId, property2))?.property?.id).toBe(
      property2,
    );
  });

  it("switchOrganization: cùng key cùng payload → kết quả cũ; khác payload (kể cả khác tổ chức) → conflict; tra được qua GET /commands", async () => {
    const key = randomUUID();
    const input = { key, organizationId: A.orgId, propertyId: null, correlationId: "c" };
    const first = await switchOrganization(t.runtime, staffUser, input);
    expect(first).toMatchObject({
      kind: "committed",
      replayed: false,
      context: { organization: { id: A.orgId } },
    });
    expect(await switchOrganization(t.runtime, staffUser, input)).toMatchObject({
      kind: "committed",
      replayed: true,
    });
    expect(await switchOrganization(t.runtime, staffUser, { ...input, organizationId: B.orgId })).toEqual({
      kind: "conflict",
    });
    expect(await switchOrganization(t.runtime, staffUser, { ...input, propertyId: A.propertyId })).toEqual({
      kind: "conflict",
    });
    const actor = await resolveActor(t.runtime, {
      authUserId: staffUser,
      orgId: A.orgId,
      twoFactorEnabled: false,
    });
    expect(await getCommandResult(t.runtime, actor, key)).toMatchObject({
      status: "committed",
      data: { context: { organization: { id: A.orgId } } },
    });
  });

  it("switchOrganization: tổ chức không phải thành viên → not_found, không lưu key (gửi lại sau khi được mời vẫn chạy)", async () => {
    const key = randomUUID();
    const stranger = await seedAuthUser(t.admin, `la2+${randomUUID().slice(0, 6)}@example.test`);
    expect(
      await switchOrganization(t.runtime, stranger, {
        key,
        organizationId: A.orgId,
        propertyId: null,
        correlationId: "c",
      }),
    ).toEqual({ kind: "not_found" });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from idempotency_keys where key = ${key}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
  });

  it("switchOrganization: song song cùng key → đúng một bản ghi, mọi lời gọi cùng kết quả", async () => {
    const key = randomUUID();
    const input = { key, organizationId: A.orgId, propertyId: null, correlationId: "c" };
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => switchOrganization(t.runtime, staffUser, input)),
    );
    expect(rs.every((r) => r.kind === "committed")).toBe(true);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from idempotency_keys where key = ${key}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("cookie chọn tổ chức: HTTPS dùng tiền tố __Host-", () => {
    expect(orgCookieName(true)).toBe("__Host-hm_org");
    expect(orgCookieName(false)).toBe("hm_org");
  });

  it("header X-Org-Id ưu tiên hơn cookie; rỗng → null", () => {
    expect(requestedOrgId("h", "c")).toBe("h");
    expect(requestedOrgId(" ", "c")).toBe("c");
    expect(requestedOrgId(null, undefined)).toBeNull();
  });
});
