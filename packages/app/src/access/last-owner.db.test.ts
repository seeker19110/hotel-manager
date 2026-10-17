// Owner cuối cùng (SPEC-access S-019, INV-G7): thu hồi/hạ vai trò owner cuối → 409 LAST_OWNER, membership giữ nguyên.
// Kiểm qua pipeline command thật: ràng buộc deferred ở CSDL (migration 0001) dịch sang mã nghiệp vụ.
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import type { Actor } from "./actor.ts";

let t: TestDb;
let org: SeededOrg;
let owner: Actor;

const revoke = (actor: Actor, membershipId: string) =>
  runAs(t, actor, async (ctx) => {
    await sql`update memberships set status = 'revoked', revoked_at = now()
              where organization_id = ${ctx.actor.orgId} and id = ${membershipId}`.execute(ctx.trx);
    return null;
  });

const demote = (actor: Actor, membershipId: string) =>
  runAs(t, actor, async (ctx) => {
    await sql`update memberships set role = 'manager', all_properties = false
              where organization_id = ${ctx.actor.orgId} and id = ${membershipId}`.execute(ctx.trx);
    return null;
  });

const statusOf = async (membershipId: string) =>
  (
    await sql<{
      status: string;
      role: string;
    }>`select status, role from memberships where id = ${membershipId}`.execute(t.admin)
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  org = await seedOrg(t.admin, "Trọ owner cuối");
  owner = await ownerOf(t, org);
});

afterAll(async () => {
  await t.drop();
});

describe("SPEC-access S-019: không thu hồi owner cuối cùng", () => {
  it("owner duy nhất tự thu hồi hoặc tự hạ vai trò → 409 LAST_OWNER, membership giữ nguyên", async () => {
    for (const act of [revoke, demote]) {
      const r = await act(owner, owner.membershipId);
      expect(r).toMatchObject({ status: "failed", httpStatus: 409, problem: { code: "LAST_OWNER" } });
      expect(await statusOf(owner.membershipId)).toEqual({ status: "active", role: "owner" });
    }
  });

  it("có owner thứ hai → thu hồi/hạ một người được; người còn lại không tự bỏ được", async () => {
    const second = await seedMember(t, org, "owner", { properties: "all", name: "Owner hai" });
    expect(await revoke(owner, second.membershipId)).toMatchObject({ status: "committed" });
    expect(await statusOf(second.membershipId)).toMatchObject({ status: "revoked" });
    expect(await revoke(owner, owner.membershipId)).toMatchObject({
      status: "failed",
      problem: { code: "LAST_OWNER" },
    });
  });
});
