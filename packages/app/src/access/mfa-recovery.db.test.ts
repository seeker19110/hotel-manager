// PLAN đợt 2 T-116 — khôi phục MFA trên Postgres thật (SPEC-access-and-property Q-08).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommand } from "../pipeline/command.ts";
import { type Actor, resolveActor } from "./actor.ts";
import { resetMemberMfa } from "./mfa-recovery.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O1: Actor;
let O2: Actor;
let OB: Actor;
let M: Actor;

async function member(
  org: SeededOrg,
  role: string,
  authUserId?: string,
): Promise<{ actor: Actor; userId: string }> {
  const userId =
    authUserId ?? (await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`));
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${randomUUID()}, ${org.orgId}, ${userId}, ${person}, ${role})`.execute(t.admin);
  await enrolMfa(userId);
  return {
    actor: await resolveActor(t.runtime, { authUserId: userId, orgId: org.orgId, twoFactorEnabled: true }),
    userId,
  };
}

/** Như sau khi đăng ký TOTP và đăng nhập trên hai thiết bị. */
async function enrolMfa(userId: string) {
  await sql`update auth."user" set "twoFactorEnabled" = true where id = ${userId}`.execute(t.admin);
  await sql`insert into auth."twoFactor" (id, secret, "backupCodes", "userId", verified)
            values (${randomUUID()}, 'enc-secret', 'enc-codes', ${userId}, true)`.execute(t.admin);
  for (let i = 0; i < 2; i++) {
    await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId")
              values (${randomUUID()}, now() + interval '1 day', ${randomUUID()}, now(), ${userId})`.execute(
      t.admin,
    );
  }
}

const authState = async (userId: string) =>
  (
    await sql<{ enabled: boolean | null; secrets: number; sessions: number }>`
      select u."twoFactorEnabled" as enabled,
             (select count(*)::int from auth."twoFactor" f where f."userId" = u.id) as secrets,
             (select count(*)::int from auth."session" s where s."userId" = u.id) as sessions
      from auth."user" u where u.id = ${userId}`.execute(t.admin)
  ).rows[0];

function reset(actor: Actor, membershipId: string, reason = "Mất điện thoại") {
  const key = randomUUID();
  return executeCommand(
    t.runtime,
    actor,
    { command: "member.resetMfa", idempotencyKey: key, payload: { key }, correlationId: "c-mfa-recovery" },
    async (ctx) => ({ data: await resetMemberMfa(ctx, { membershipId, reason }) }),
  );
}

async function fails(p: ReturnType<typeof reset>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem;
}

let mUser: string;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ khôi phục");
  B = await seedOrg(t.admin, "Trọ một chủ");
  await enrolMfa(A.ownerAuthUserId);
  await enrolMfa(B.ownerAuthUserId);
  O1 = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  OB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  O2 = (await member(A, "owner")).actor;
  const m = await member(A, "manager");
  M = m.actor;
  mUser = m.userId;
});

afterAll(async () => {
  await t.drop();
});

describe("member.resetMfa (access Q-08)", () => {
  it("owner khác đặt lại MFA của quản lý: xoá TOTP, thu hồi phiên, audit + sự kiện; lần sau phải xác thực lại", async () => {
    expect(await authState(mUser)).toEqual({ enabled: true, secrets: 1, sessions: 2 });
    const r = await reset(O1, M.membershipId);
    expect(r).toMatchObject({
      status: "committed",
      data: { membershipId: M.membershipId, sessionsRevoked: 2 },
    });
    expect(await authState(mUser)).toEqual({ enabled: false, secrets: 0, sessions: 0 });
    const au = await sql<{ reason: string; actor: string }>`
      select reason, actor_person_id as actor from audit_events where action = 'member.mfa_reset' and entity_id = ${M.membershipId}`.execute(
      t.admin,
    );
    expect(au.rows).toEqual([{ reason: "Mất điện thoại", actor: O1.personId }]);
    const ob = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'member.mfa_reset' and aggregate_id = ${M.membershipId}`.execute(
      t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);
    // Đăng nhập lại chưa có MFA ⇒ vai trò bắt buộc MFA bị chặn cho tới khi đăng ký lại.
    await expect(
      resolveActor(t.runtime, { authUserId: mUser, orgId: A.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED", status: 403 });
    // Owner kia vẫn nguyên.
    expect(await authState(A.ownerAuthUserId)).toEqual({ enabled: true, secrets: 1, sessions: 2 });
  });

  it("không tự đặt lại: còn owner khác → nhờ owner khác; owner duy nhất → hỗ trợ nền tảng", async () => {
    expect(await fails(reset(O1, O1.membershipId))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      items: [{ recovery: "another_owner" }],
    });
    expect(await fails(reset(OB, OB.membershipId))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      items: [{ recovery: "platform_support" }],
    });
    expect(await authState(B.ownerAuthUserId)).toEqual({ enabled: true, secrets: 1, sessions: 2 });
  });

  it("chỉ owner; cần lý do; thành viên tổ chức khác → 404; tài khoản dùng ở tổ chức khác → hỗ trợ nền tảng, không đổi gì", async () => {
    const f = await member(A, "front_desk");
    const m2 = await member(A, "manager");
    expect(await fails(reset(m2.actor, f.actor.membershipId))).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(await fails(reset(O2, f.actor.membershipId, "  "))).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(await fails(reset(O2, OB.membershipId))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    // Cùng tài khoản đăng nhập là lễ tân ở A và owner ở B: owner A không được hạ bảo mật của B.
    const shared = await member(B, "manager");
    await member(A, "front_desk", shared.userId);
    const inA = await sql<{ id: string }>`
      select id from memberships where organization_id = ${A.orgId} and auth_user_id = ${shared.userId}`.execute(
      t.admin,
    );
    expect(await fails(reset(O1, inA.rows[0]?.id as string))).toMatchObject({
      code: "FORBIDDEN",
      items: [{ recovery: "platform_support" }],
    });
    expect((await authState(shared.userId))?.secrets).toBeGreaterThan(0);
    // Membership ở B đang tạm khoá (chưa thu hồi) vẫn tính là "dùng ở tổ chức khác" — review lát 4 🟢4.
    const susp = await member(B, "manager");
    await sql`update memberships set status = 'suspended' where organization_id = ${B.orgId} and auth_user_id = ${susp.userId}`.execute(
      t.admin,
    );
    await member(A, "front_desk", susp.userId);
    const inA2 = await sql<{ id: string }>`
      select id from memberships where organization_id = ${A.orgId} and auth_user_id = ${susp.userId}`.execute(
      t.admin,
    );
    expect(await fails(reset(O1, inA2.rows[0]?.id as string))).toMatchObject({
      items: [{ recovery: "platform_support" }],
    });
    // Lễ tân chỉ thuộc A: owner đặt lại được.
    expect(await reset(O2, f.actor.membershipId)).toMatchObject({ status: "committed" });
  });
});
