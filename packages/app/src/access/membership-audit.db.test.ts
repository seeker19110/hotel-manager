// Audit + outbox cùng transaction với thay đổi quyền (SPEC-access S-022, INV-G6): đổi vai trò thành viên.
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandError } from "../pipeline/index.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import type { Actor } from "./actor.ts";

let t: TestDb;
let org: SeededOrg;
let owner: Actor;
let target: Actor;

const roleOf = async () =>
  (
    await sql<{ role: string }>`select role from memberships where id = ${target.membershipId}`.execute(
      t.admin,
    )
  ).rows[0]?.role;

/** Đổi vai trò front_desk → manager; `failAfter` tiêm lỗi sau khi đã ghi memberships. */
const changeRole = (failAfter: boolean) =>
  runAs(
    t,
    owner,
    async (ctx) => {
      await sql`update memberships set role = 'manager' where organization_id = ${ctx.actor.orgId} and id = ${target.membershipId}`.execute(
        ctx.trx,
      );
      await ctx.audit({
        action: "member.role_changed",
        entityType: "membership",
        entityId: target.membershipId,
        before: { role: "front_desk" },
        after: { role: "manager" },
        reason: "Thăng chức",
      });
      await ctx.emit({
        eventType: "member.role_changed",
        aggregateType: "membership",
        aggregateId: target.membershipId,
        payload: { membership_id: target.membershipId },
      });
      if (failAfter) throw new CommandError("VALIDATION_FAILED", 422, "Lỗi tiêm sau khi ghi");
      return null;
    },
    { command: "member.updateRole" },
  );

const traces = async (commandId: string) => {
  const audit = await sql<{
    outcome: string;
    action: string;
    before: unknown;
    after: unknown;
    reason: string;
    correlation_id: string;
  }>`
    select outcome, action, before, after, reason, correlation_id from audit_events where command_id = ${commandId}`.execute(
    t.admin,
  );
  const outbox = await sql<{
    n: number;
  }>`select count(*)::int as n from outbox where command_id = ${commandId}`.execute(t.admin);
  return { audit: audit.rows, outbox: outbox.rows[0]?.n ?? 0 };
};

beforeAll(async () => {
  t = await createTestDb();
  org = await seedOrg(t.admin, "Trọ audit quyền");
  owner = await ownerOf(t, org);
  target = await seedMember(t, org, "front_desk", { name: "Lễ tân L" });
});

afterAll(async () => {
  await t.drop();
});

describe("SPEC-access S-022: audit và outbox cùng transaction", () => {
  it("lỗi sau khi ghi memberships → vai trò không đổi, không audit thành công, không outbox", async () => {
    const r = await changeRole(true);
    expect(r).toMatchObject({ status: "failed", httpStatus: 422 });
    expect(await roleOf()).toBe("front_desk");
    const tr = await traces(r.commandId);
    expect(tr.audit.filter((a) => a.outcome === "success")).toEqual([]);
    expect(tr.outbox).toBe(0);
  });

  it("commit → đúng 1 audit (trước/sau, lý do, correlation_id) và 1 outbox", async () => {
    const r = await changeRole(false);
    expect(r).toMatchObject({ status: "committed" });
    expect(await roleOf()).toBe("manager");
    const tr = await traces(r.commandId);
    expect(tr.audit).toHaveLength(1);
    expect(tr.audit[0]).toMatchObject({
      outcome: "success",
      action: "member.role_changed",
      before: { role: "front_desk" },
      after: { role: "manager" },
      reason: "Thăng chức",
      correlation_id: "test-corr",
    });
    expect(tr.outbox).toBe(1);
  });
});
