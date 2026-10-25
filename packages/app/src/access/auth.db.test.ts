// T-006 — xác thực tự host (ADR-0002), MFA, khoá tạm, thu hồi quyền tức thì (SPEC-access-and-property, TM-02).
import { randomUUID } from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { createTestDb, seedOrg, type TestDb, withSignUpConsent } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Auth, createAuth, ENABLED_PLUGINS } from "../auth/auth.ts";
import { AccessError, listMyOrganizations, resolveActor } from "./actor.ts";

const BASE = "http://localhost:3000";
// Mật khẩu giả cho DB test tạm; ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
const PASSWORD = ["mat", "khau", "thu", "nghiem", "12"].join("-");

let t: TestDb;
let auth: Auth;
let closeAuth: () => Promise<void>;
let clock = new Date("2026-10-15T08:00:00Z");

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function signUp(email: string): Promise<string> {
  const r = await auth.api.signUpEmail({
    body: withSignUpConsent({ email, password: PASSWORD, name: email }),
  });
  return r.user.id;
}

async function session(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

beforeAll(async () => {
  t = await createTestDb();
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: BASE,
    ipRateLimit: false,
    now: () => clock,
  });
  auth = created.auth;
  closeAuth = created.close;
});

afterAll(async () => {
  await closeAuth();
  await t.drop();
});

describe("cấu hình (ADR-0002)", () => {
  it("mặc định bật rate limit theo IP, đăng nhập tối đa 20 lần/phút/IP", () => {
    const def = createAuth({ databaseUrl: t.runtimeUrl, secret: "s".repeat(48), baseURL: BASE });
    expect(def.auth.options.rateLimit).toMatchObject({
      enabled: true,
      customRules: { "/sign-in/email": { window: 60, max: 20 } },
    });
    return def.close();
  });

  it("chỉ bật plugin two-factor; email/mật khẩu bật; phiên rảnh 12 giờ", () => {
    expect((auth.options.plugins ?? []).map((p) => p.id)).toEqual([...ENABLED_PLUGINS]);
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.session?.expiresIn).toBe(12 * 3600);
  });
});

describe("đăng nhập và cookie phiên (TM-02)", () => {
  it("đăng nhập đúng → cookie phiên HttpOnly, SameSite=Lax; getSession trả người dùng", async () => {
    const email = `dn+${randomUUID().slice(0, 8)}@example.test`;
    await signUp(email);
    const res = await post("/sign-in/email", { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const sessionCookie = res.headers.getSetCookie().find((c) => c.includes("session_token"));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    const s = await session(cookiesOf(res));
    expect(s?.user.email).toBe(email);
  });

  it("sai mật khẩu → 401, không có cookie phiên", async () => {
    const email = `sai+${randomUUID().slice(0, 8)}@example.test`;
    await signUp(email);
    const res = await post("/sign-in/email", { email, password: "khong-dung-mat-khau" });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
  });
});

describe("khoá tạm theo tài khoản (access Q-07: 5 lần sai → 15 phút)", () => {
  it("SPEC-access S-012: 5 lần sai rồi đúng mật khẩu vẫn bị khoá; sau 15 phút đăng nhập lại được", async () => {
    const email = `khoa+${randomUUID().slice(0, 8)}@example.test`;
    await signUp(email);
    for (let i = 0; i < 5; i++) {
      expect((await post("/sign-in/email", { email, password: `sai-${i}-xxxxxxxx` })).status).toBe(401);
    }
    const locked = await post("/sign-in/email", { email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "ACCOUNT_LOCKED" });
    // BE-REL-006: 429 có Retry-After = số giây còn khoá (đồng hồ test đứng yên ⇒ đúng 15 phút).
    expect(locked.headers.get("retry-after")).toBe("900");

    clock = new Date(clock.getTime() + 16 * 60_000);
    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
  });

  it("SPEC-access S-012: nhập sai mã TOTP vượt ngưỡng → 429 kèm Retry-After; lần trước ngưỡng chỉ là 401 chung", async () => {
    const email = `totp+${randomUUID().slice(0, 8)}@example.test`;
    const userId = await signUp(email);
    await seedOrg(t.admin, "KS TOTP", "hotel", userId);
    const first = await post("/sign-in/email", { email, password: PASSWORD });
    const cookie = cookiesOf(first);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD, method: "totp" },
      headers: new Headers({ cookie }),
    });
    if (enabled.method !== "totp") throw new Error("cần phương thức TOTP");
    const b32 = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    const code = await createOTP(new TextDecoder().decode(base32.decode(b32))).totp();
    expect((await post("/two-factor/verify-totp", { code }, cookie)).status).toBe(200);

    // Không tiết lộ tài khoản có tồn tại: email lạ và sai mật khẩu cho cùng trạng thái + cùng mã lỗi.
    const wrongPw = await post("/sign-in/email", { email, password: "khong-dung-mat-khau-1" });
    const unknown = await post("/sign-in/email", {
      email: `khong-co+${randomUUID().slice(0, 8)}@example.test`,
      password: "khong-dung-mat-khau-1",
    });
    expect(unknown.status).toBe(wrongPw.status);
    expect(((await unknown.json()) as { code?: string }).code).toBe(
      ((await wrongPw.json()) as { code?: string }).code,
    );

    // Bản có giới hạn theo IP bật (mặc định production) dùng chung CSDL/khoá ký với bản test.
    const limited = createAuth({
      databaseUrl: t.runtimeUrl,
      secret: "s".repeat(48),
      baseURL: BASE,
      now: () => clock,
    });
    try {
      const call = (path: string, body: unknown, ck?: string) =>
        limited.auth.handler(
          new Request(`${BASE}/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: BASE,
              "x-forwarded-for": "203.0.113.77",
              ...(ck ? { cookie: ck } : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      const challenge = await call("/sign-in/email", { email, password: PASSWORD });
      expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
      const ck = cookiesOf(challenge);
      const statuses: number[] = [];
      let limitedRes: Response | undefined;
      for (let i = 0; i < 12; i++) {
        const r = await call("/two-factor/verify-totp", { code: "000000" }, ck);
        statuses.push(r.status);
        if (r.status === 429) {
          limitedRes = r;
          break;
        }
      }
      expect(statuses.slice(0, -1).every((s) => s === 401 || s === 400)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      expect(
        Number(limitedRes?.headers.get("retry-after") ?? limitedRes?.headers.get("x-retry-after")),
      ).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it("đăng nhập đúng xoá bộ đếm sai", async () => {
    const email = `dem+${randomUUID().slice(0, 8)}@example.test`;
    await signUp(email);
    for (let i = 0; i < 4; i++) await post("/sign-in/email", { email, password: `sai-${i}-xxxxxxxx` });
    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < 4; i++) await post("/sign-in/email", { email, password: `sai-${i}-xxxxxxxx` });
    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
  });
});

describe("ngữ cảnh tổ chức và quyền (SPEC-access)", () => {
  it("SPEC-access S-011: chủ chưa bật MFA → MFA_REQUIRED; bật TOTP → actor hợp lệ; đăng nhập lần sau đòi mã TOTP", async () => {
    const email = `chu+${randomUUID().slice(0, 8)}@example.test`;
    const userId = await signUp(email);
    const org = await seedOrg(t.admin, "KS MFA", "hotel", userId);

    const first = await post("/sign-in/email", { email, password: PASSWORD });
    const cookie = cookiesOf(first);
    const s1 = await session(cookie);
    await expect(
      resolveActor(t.runtime, {
        authUserId: s1?.user.id,
        orgId: org.orgId,
        twoFactorEnabled: Boolean(s1?.user.twoFactorEnabled),
      }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED", status: 403 });

    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD, method: "totp" },
      headers: new Headers({ cookie }),
    });
    if (enabled.method !== "totp") throw new Error("cần phương thức TOTP");
    // URI chứa secret dạng base32; createOTP nhận secret gốc như Better Auth lưu.
    const b32 = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    const code = await createOTP(new TextDecoder().decode(base32.decode(b32))).totp();
    // Xác minh TOTP lần đầu bật 2FA và CẤP LẠI phiên (cookie mới) — phiên cũ không dùng tiếp.
    const verified = await post("/two-factor/verify-totp", { code }, cookie);
    expect(verified.status).toBe(200);
    const s2 = await session(cookiesOf(verified));
    expect(s2?.user.twoFactorEnabled).toBe(true);
    const actor = await resolveActor(t.runtime, {
      authUserId: userId,
      orgId: org.orgId,
      twoFactorEnabled: true,
    });
    expect(actor).toMatchObject({ role: "owner", orgId: org.orgId, mfaRequired: true, allProperties: true });

    const again = await post("/sign-in/email", { email, password: PASSWORD });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
      again.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c) && !/Max-Age=0/.test(c)),
    ).toBe(false);
  });

  it("chọn tổ chức không phải thành viên → NOT_FOUND (không lộ tồn tại); chưa đăng nhập → UNAUTHENTICATED", async () => {
    const other = await seedOrg(t.admin, "Tổ chức khác");
    const email = `la+${randomUUID().slice(0, 8)}@example.test`;
    const userId = await signUp(email);
    await expect(
      resolveActor(t.runtime, { authUserId: userId, orgId: other.orgId, twoFactorEnabled: true }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(
      resolveActor(t.runtime, { authUserId: null, orgId: other.orgId, twoFactorEnabled: false }),
    ).rejects.toBeInstanceOf(AccessError);
  });

  it("SPEC-access S-009: thu hồi membership → request kế tiếp mất quyền ngay; listMyOrganizations không còn tổ chức đó", async () => {
    const org = await seedOrg(t.admin, "Trọ thu hồi", "rental");
    const email = `bp+${randomUUID().slice(0, 8)}@example.test`;
    const userId = await signUp(email);
    const personId = randomUUID();
    const membershipId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${org.orgId}, 'Buồng phòng 1')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${membershipId}, ${org.orgId}, ${userId}, ${personId}, 'housekeeping')`.execute(
      t.admin,
    );

    const actor = await resolveActor(t.runtime, {
      authUserId: userId,
      orgId: org.orgId,
      twoFactorEnabled: false,
    });
    expect(actor).toMatchObject({ role: "housekeeping", mfaRequired: false });
    expect((await listMyOrganizations(t.runtime, userId)).map((o) => o.organizationId)).toEqual([org.orgId]);

    await sql`update memberships set status = 'revoked', revoked_at = now() where id = ${membershipId}`.execute(
      t.admin,
    );
    await expect(
      resolveActor(t.runtime, { authUserId: userId, orgId: org.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await listMyOrganizations(t.runtime, userId)).toEqual([]);
  });

  it("lễ tân (có quyền xác nhận tiền mặt) cũng bắt buộc MFA (access Q-06)", async () => {
    const org = await seedOrg(t.admin, "KS lễ tân");
    const userId = await signUp(`lt+${randomUUID().slice(0, 8)}@example.test`);
    const personId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${org.orgId}, 'Lễ tân 1')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${randomUUID()}, ${org.orgId}, ${userId}, ${personId}, 'front_desk')`.execute(t.admin);
    await expect(
      resolveActor(t.runtime, { authUserId: userId, orgId: org.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({
      code: "MFA_REQUIRED",
    });
  });
});
