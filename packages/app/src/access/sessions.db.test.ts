// SPEC-access-and-property S-010 (session.revokeAll + 401 SESSION_REVOKED) với Better Auth THẬT trên Postgres thật:
// hai thiết bị đăng nhập → owner thu hồi → cả hai cookie nhận 401 SESSION_REVOKED; đăng nhập lại hoạt động; audit session.revoked.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Auth, createAuth } from "../auth/auth.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { isSessionRevoked, sessionTokenFromCookie } from "./sessions.ts";

const BASE = "http://localhost:3000";
const PASSWORD = ["mat", "khau", "thu", "nghiem", "34"].join("-");

let t: TestDb;
let auth: Auth;
let closeAuth: () => Promise<void>;
let deps: HttpDeps;
let A: SeededOrg;
let cookieName = "";

beforeAll(async () => {
  t = await createTestDb();
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: BASE,
    ipRateLimit: false,
  });
  auth = created.auth;
  closeAuth = created.close;
  cookieName = (await auth.$context).authCookies.sessionToken.name;
  deps = {
    db: t.runtime,
    // Có x-test-user: phiên giả (owner/manager đã MFA); còn lại: Better Auth thật theo cookie.
    getSession: async (h) => {
      const fake = h.get("x-test-user");
      if (fake) return { user: { id: fake, twoFactorEnabled: true } };
      const s = await auth.api.getSession({ headers: h });
      return s ? { user: { id: s.user.id, twoFactorEnabled: s.user.twoFactorEnabled } } : null;
    },
    isSessionRevoked: (h) => isSessionRevoked(t.runtime, cookieName, h),
    secureCookies: false,
    services: testServices(),
  };
  A = await seedOrg(t.admin, "Nhà nghỉ thu hồi phiên");
});
afterAll(async () => {
  await closeAuth();
  await t?.drop();
});

/** Người dùng thật (đăng nhập được) + membership `housekeeping` (không bắt MFA) ở tổ chức A. */
async function staff(orgOf: SeededOrg = A, role = "housekeeping") {
  const email = `nv+${randomUUID().slice(0, 8)}@example.test`;
  const r = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Nhân viên" } });
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${orgOf.orgId}, 'Nhân viên')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${orgOf.orgId}, ${r.user.id}, ${person}, ${role}, false)`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${orgOf.orgId}, ${membership}, ${orgOf.propertyId})`.execute(t.admin);
  return { email, userId: r.user.id, membership, person };
}

async function signIn(email: string): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function listMine(headers: Record<string, string>, org = A.orgId) {
  const res = await handleQuery(
    QUERIES["notifications.listMine"] as never,
    new Request("http://local.test/api/v1/notifications/listMine", {
      headers: { ...headers, "x-org-id": org },
    }),
    deps,
  );
  return { status: res.status, code: ((await res.json()) as { code?: string }).code ?? "ok" };
}

async function revoke(asUser: string, body: Record<string, unknown> = {}, org = A.orgId) {
  const res = await handleCommand(
    COMMANDS["session.revokeAll"] as never,
    new Request("http://local.test/api/v1/session/revokeAll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-test-user": asUser,
        "x-org-id": org,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & { data?: { revokedCount: number } },
  };
}

const sessionCount = async (userId: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from auth."session" where "userId" = ${userId}`.execute(t.admin)
  ).rows[0]?.n ?? 0;

describe("SPEC-access S-010: thu hồi phiên", () => {
  it("S-010 L có 2 phiên trên 2 thiết bị; owner session.revokeAll cho L → mọi request dùng phiên cũ nhận 401 SESSION_REVOKED; đăng nhập lại hoạt động; audit session.revoked", async () => {
    const l = await staff();
    const phone = await signIn(l.email);
    const laptop = await signIn(l.email);
    expect(await sessionCount(l.userId)).toBe(2);
    expect(await listMine({ cookie: phone })).toEqual({ status: 200, code: "ok" });
    expect(await listMine({ cookie: laptop })).toEqual({ status: 200, code: "ok" });

    const r = await revoke(A.ownerAuthUserId, { membership_id: l.membership });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.revokedCount).toBe(2);
    expect(await sessionCount(l.userId)).toBe(0);

    for (const cookie of [phone, laptop]) {
      const res = await listMine({ cookie });
      expect([res.status, res.code]).toEqual([401, "SESSION_REVOKED"]);
    }
    // Không cookie / cookie rác / cookie của phiên chưa từng có ⇒ vẫn UNAUTHENTICATED (không lộ).
    expect(await listMine({})).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    expect(await listMine({ cookie: `${cookieName}=rac.rac` })).toEqual({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    // Đăng nhập lại: phiên mới hoạt động bình thường; phiên cũ vẫn bị thu hồi.
    const again = await signIn(l.email);
    expect(await listMine({ cookie: again })).toEqual({ status: 200, code: "ok" });
    expect((await listMine({ cookie: phone })).code).toBe("SESSION_REVOKED");

    const a = await sql<{ entity_id: string; after: { revoked_count: number; self: boolean } }>`
      select entity_id, after from audit_events where organization_id = ${A.orgId} and action = 'session.revoked'
        and entity_id = ${l.membership}`.execute(t.admin);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.after).toEqual({ revoked_count: 2, self: false });
    const ob = await sql<{
      n: number;
    }>`select count(*)::int as n from outbox where organization_id = ${A.orgId} and event_type = 'session.revoked' and aggregate_id = ${l.membership}`.execute(
      t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);
  });

  it("S-010 chính L tự thu hồi (không gửi membership_id): phiên đang dùng cũng nhận 401 SESSION_REVOKED", async () => {
    const l = await staff();
    const a = await signIn(l.email);
    const b = await signIn(l.email);
    // Lệnh chạy bằng phiên giả của chính L (cùng tài khoản) — quyền tra từ membership.
    const r = await revoke(l.userId);
    expect(r.status).toBe(200);
    expect(r.body.data?.revokedCount).toBe(2);
    expect((await listMine({ cookie: a })).code).toBe("SESSION_REVOKED");
    expect((await listMine({ cookie: b })).code).toBe("SESSION_REVOKED");
    // Tự thu hồi khi không còn phiên nào: 200, revokedCount 0 (idempotent về hiệu lực), vẫn có audit.
    const none = await revoke(l.userId, { membership_id: l.membership });
    expect(none.status).toBe(200);
    expect(none.body.data?.revokedCount).toBe(0);
  });

  it("dấu vết chỉ chứa BĂM của token, hết hạn cùng phiên (hết hạn ⇒ về UNAUTHENTICATED); dấu vết cũ được dọn khi có lần thu hồi sau", async () => {
    const l = await staff();
    const cookie = await signIn(l.email);
    const token = sessionTokenFromCookie(cookie, cookieName) as string;
    expect(token.length).toBeGreaterThan(10);
    await revoke(A.ownerAuthUserId, { membership_id: l.membership });
    const rows = await sql<{
      token_hash: Buffer;
      text: string;
    }>`select token_hash, r::text as text from auth.revoked_session r where user_id = ${l.userId}`.execute(
      t.admin,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.token_hash.length).toBe(32);
    expect(rows.rows[0]?.text).not.toContain(token);
    await sql`update auth.revoked_session set expires_at = now() - interval '1 second' where user_id = ${l.userId}`.execute(
      t.admin,
    );
    expect((await listMine({ cookie })).code).toBe("UNAUTHENTICATED");
    const l2 = await staff();
    await signIn(l2.email);
    await revoke(A.ownerAuthUserId, { membership_id: l2.membership });
    const left = await sql<{
      n: number;
    }>`select count(*)::int as n from auth.revoked_session where user_id = ${l.userId}`.execute(t.admin);
    expect(left.rows[0]?.n).toBe(0);
  });

  it("đặt lại MFA (member.resetMfa) cũng để lại dấu vết ⇒ phiên cũ nhận SESSION_REVOKED", async () => {
    const l = await staff();
    const cookie = await signIn(l.email);
    const res = await handleCommand(
      COMMANDS["member.resetMfa"] as never,
      new Request("http://local.test/x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          "x-test-user": A.ownerAuthUserId,
          "x-org-id": A.orgId,
        },
        body: JSON.stringify({ membership_id: l.membership, reason: "Mất điện thoại" }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect((await listMine({ cookie })).code).toBe("SESSION_REVOKED");
  });
});

describe("quyền thu hồi phiên (server)", () => {
  it("lễ tân/buồng phòng thu hồi phiên người khác → 403 + audit lần thử; manager chỉ nhân viên cấp thấp cùng cơ sở; ngoài cơ sở → 404; owner khác → 403", async () => {
    const target = await staff();
    const cookie = await signIn(target.email);
    const fd = await seedMember(t, A, "front_desk");
    const hk = await seedMember(t, A, "housekeeping");
    for (const u of [fd, hk]) {
      const r = await revoke(u.authUserId, { membership_id: target.membership });
      expect([r.status, r.body.code]).toEqual([403, "FORBIDDEN"]);
    }
    const p2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${p2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
      t.admin,
    );
    const mgr = await seedMember(t, A, "manager");
    const mgrP2 = await seedMember(t, A, "manager", { properties: [p2] });
    const byOutsideMgr = await revoke(mgrP2.authUserId, { membership_id: target.membership });
    expect(byOutsideMgr.status).toBe(404);
    const toOwner = await revoke(mgr.authUserId, { membership_id: A.ownerMembershipId });
    expect([toOwner.status, toOwner.body.code]).toEqual([403, "FORBIDDEN"]);
    const toManager = await revoke(mgr.authUserId, { membership_id: mgrP2.membershipId });
    expect(toManager.status).toBe(404); // khác cơ sở
    expect(await listMine({ cookie })).toEqual({ status: 200, code: "ok" }); // chưa bị đụng
    const ok = await revoke(mgr.authUserId, { membership_id: target.membership });
    expect(ok.status).toBe(200);
    expect(ok.body.data?.revokedCount).toBe(1);
    const denied = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where organization_id = ${A.orgId} and action = 'session.revoke_denied'`.execute(
      t.admin,
    );
    expect(denied.rows[0]?.n).toBeGreaterThanOrEqual(3);
  });

  it("tài khoản còn dùng ở tổ chức khác → owner A không thu hồi hộ (403, phiên còn nguyên); chính người đó tự thu hồi được; id lạ/tổ chức khác → 404", async () => {
    const B = await seedOrg(t.admin, "Tổ chức B dùng chung tài khoản");
    const shared = await staff();
    const cookie = await signIn(shared.email);
    const person = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${B.orgId}, 'NV chung')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
              values (${randomUUID()}, ${B.orgId}, ${shared.userId}, ${person}, 'housekeeping', false)`.execute(
      t.admin,
    );
    const r = await revoke(A.ownerAuthUserId, { membership_id: shared.membership });
    expect([r.status, r.body.code]).toEqual([403, "FORBIDDEN"]);
    expect(await listMine({ cookie })).toEqual({ status: 200, code: "ok" });
    expect((await revoke(shared.userId)).status).toBe(200);
    expect((await listMine({ cookie })).code).toBe("SESSION_REVOKED");
    expect((await revoke(A.ownerAuthUserId, { membership_id: randomUUID() })).status).toBe(404);
    const ofB = await sql<{
      id: string;
    }>`select id from memberships where organization_id = ${B.orgId} limit 1`.execute(t.admin);
    expect((await revoke(A.ownerAuthUserId, { membership_id: ofB.rows[0]?.id })).status).toBe(404);
  });
});

describe("sessionTokenFromCookie", () => {
  it("lấy token trước chữ ký, giải URL-encode; thiếu/hỏng → null", () => {
    expect(sessionTokenFromCookie("a=1; hm=abc123.c2ln%2Bx%3D; b=2", "hm")).toBe("abc123");
    expect(sessionTokenFromCookie("hm=%E0%A4%A", "hm")).toBeNull();
    expect(sessionTokenFromCookie("hm=khongcodau", "hm")).toBeNull();
    expect(sessionTokenFromCookie("khac=1", "hm")).toBeNull();
    expect(sessionTokenFromCookie(null, "hm")).toBeNull();
    expect(sessionTokenFromCookie("hm=.chuky", "hm")).toBeNull();
  });
});
