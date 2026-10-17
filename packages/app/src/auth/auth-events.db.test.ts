// T-405 — sự kiện xác thực qua hook Better Auth trên Postgres thật (SEC-LOG-001, CMP-AUDIT-002, IND-SAAS-009):
// đăng nhập thành công/thất bại, đăng xuất, bật/tắt MFA, khoá tài khoản, đổi mật khẩu ⇒ log bảo mật chuẩn
// (event/actor/target/outcome/source_ip/user_agent) + audit ở tổ chức của người dùng + thông báo account_security.
// Không bao giờ có mật khẩu/OTP/email trong log.
import { randomUUID } from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { createTestDb, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMemberMfa } from "../access/mfa-recovery.ts";
import { createLogger } from "../logging/logger.ts";
import { setAppLogger } from "../logging/runtime.ts";
import { securityRecordSchema } from "../logging/security-events.ts";
import { dispatchNotification } from "../notifications/dispatch.ts";
import { okAs, ownerOf, seedMember } from "../testing/helpers.ts";
import { type Auth, createAuth } from "./auth.ts";

const BASE = "http://localhost:3000";
// Mật khẩu giả cho DB test tạm; ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
const PASSWORD = ["mat", "khau", "thu", "nghiem", "12"].join("-");
const NEW_PASSWORD = ["mat", "khau", "moi", "nghiem", "34"].join("-");
const UA = "Mozilla/5.0 (X11; Linux x86_64) HotelTest/1.0";

let t: TestDb;
let auth: Auth;
let closeAuth: () => Promise<void>;
let clock = new Date("2026-10-15T08:00:00Z");
let lines: string[] = [];
const otps = new Map<string, string>();

async function post(path: string, body: unknown, cookie?: string, ip = "203.0.113.77"): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-forwarded-for": ip,
        "user-agent": UA,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Sự kiện bảo mật đã phát, đã kiểm đúng schema. */
const events = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.category === "security")
    .map((r) => securityRecordSchema.parse(r));
const eventsOf = (name: string) => events().filter((e) => e.event === name);

async function newUser(prefix: string): Promise<{ email: string; userId: string }> {
  const email = `${prefix}+${randomUUID().slice(0, 8)}@example.test`;
  const r = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  return { email, userId: r.user.id };
}

/** Audit của một người dùng (qua membership của họ), mới nhất trước. */
async function auditOf(orgId: string, action: string) {
  const r = await sql<{
    action: string;
    outcome: string;
    source_ip: string | null;
    user_agent: string | null;
    entity_type: string;
    actor_type: string;
  }>`select action, outcome, source_ip, user_agent, entity_type, actor_type from audit_events
     where organization_id = ${orgId} and action = ${action} order by occurred_at desc, id desc`.execute(
    t.admin,
  );
  return r.rows;
}

beforeAll(async () => {
  t = await createTestDb();
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: BASE,
    ipRateLimit: false,
    now: () => clock,
    sendSignInOtp: async (email, otp) => {
      otps.set(email, otp);
    },
  });
  auth = created.auth;
  closeAuth = created.close;
});
afterAll(async () => {
  setAppLogger(undefined);
  await closeAuth?.();
  await t?.drop();
});
beforeEach(() => {
  lines = [];
  setAppLogger(
    createLogger({
      sink: { write: (l) => lines.push(l) },
      service: "hm-test",
      version: "0.0.0",
      env: "test",
    }),
  );
});
afterEach(() => setAppLogger(undefined));

describe("auth-events — đăng nhập", () => {
  it("thành công: log chuẩn (IP cắt /24, UA), audit ở tổ chức của người dùng với cột source_ip/user_agent", async () => {
    const u = await newUser("dn");
    const org = await seedOrg(t.admin, "KS Auth", "hotel", u.userId);
    const res = await post("/sign-in/email", { email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);

    const ev = eventsOf("auth.login");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      outcome: "success",
      reason: "password",
      source_ip: "203.0.113.0",
      user_agent: UA,
      actor: { user_id: u.userId, org_id: null, membership_id: null, role: null },
      target: { type: "account", id: u.userId },
    });
    const rows = await auditOf(org.orgId, "auth.login");
    expect(rows).toEqual([
      {
        action: "auth.login",
        outcome: "success",
        source_ip: "203.0.113.0",
        user_agent: UA,
        entity_type: "membership",
        actor_type: "user",
      },
    ]);
  });

  it("người dùng chưa thuộc tổ chức nào: có log nhưng không có audit (không có tổ chức ngữ cảnh)", async () => {
    const u = await newUser("khongorg");
    expect((await post("/sign-in/email", { email: u.email, password: PASSWORD })).status).toBe(200);
    expect(eventsOf("auth.login")).toHaveLength(1);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action like 'auth.%' and actor_person_id is null`.execute(
      t.admin,
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("thất bại: log failure, không audit từng lần sai (không làm đầy bảng append-only), không email/mật khẩu trong log", async () => {
    const u = await newUser("sai");
    const org = await seedOrg(t.admin, "KS Sai", "hotel", u.userId);
    const wrong = ["sai", "mat", "khau", "xyz"].join("-");
    const res = await post(
      "/sign-in/email",
      { email: u.email, password: wrong },
      undefined,
      "2001:db8:1:2::9",
    );
    expect(res.status).toBe(401);
    const ev = eventsOf("auth.login");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      outcome: "failure",
      reason: "invalid_credentials",
      source_ip: "2001:db8:1::",
      target: { type: "account", id: u.userId },
    });
    expect(await auditOf(org.orgId, "auth.login")).toEqual([]);
    const all = lines.join("\n");
    expect(all).not.toContain(u.email);
    expect(all).not.toContain(wrong);
    expect(all).not.toContain(PASSWORD);
  });

  it("email không tồn tại: failure với target.id null (không lộ tài khoản có hay không qua phản hồi)", async () => {
    const res = await post("/sign-in/email", { email: "khong-co@example.test", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(eventsOf("auth.login")[0]).toMatchObject({
      outcome: "failure",
      actor: null,
      target: { type: "account", id: null },
    });
  });

  it("khoá tài khoản: lần sai thứ 5 phát auth.account_locked (+ audit một lần); đăng nhập khi đang khoá → denied account_locked", async () => {
    const u = await newUser("khoa");
    const org = await seedOrg(t.admin, "KS Khoá", "hotel", u.userId);
    for (let i = 0; i < 5; i++)
      await post("/sign-in/email", { email: u.email, password: `sai-${i}-xxxxxxxx` });
    expect(eventsOf("auth.account_locked")).toHaveLength(1);
    expect(eventsOf("auth.account_locked")[0]).toMatchObject({ outcome: "denied", target: { id: u.userId } });
    expect(eventsOf("auth.login").filter((e) => e.outcome === "failure")).toHaveLength(5);
    expect(await auditOf(org.orgId, "auth.account_locked")).toHaveLength(1);

    const locked = await post("/sign-in/email", { email: u.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    const denied = eventsOf("auth.login").filter((e) => e.outcome === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ reason: "account_locked", target: { id: u.userId } });
    expect(eventsOf("auth.account_locked")).toHaveLength(1);
    clock = new Date(clock.getTime() + 16 * 60_000);
  });

  it("đăng nhập OTP của tài khoản không đủ điều kiện (nhân viên): failure otp_not_allowed, vẫn trả lỗi chung", async () => {
    const u = await newUser("nv");
    await seedOrg(t.admin, "KS OTP", "hotel", u.userId);
    const res = await post("/sign-in/email-otp", { email: u.email, otp: "123456" });
    expect(res.status).toBe(400);
    expect(eventsOf("auth.login")[0]).toMatchObject({ outcome: "failure", reason: "otp_not_allowed" });
    expect(lines.join("\n")).not.toContain("123456");
  });
});

describe("auth-events — đăng xuất", () => {
  it("log + audit auth.logout cho đúng người đang đăng xuất; đăng xuất không có phiên không phát gì", async () => {
    const u = await newUser("out");
    const org = await seedOrg(t.admin, "KS Out", "hotel", u.userId);
    const cookie = cookiesOf(await post("/sign-in/email", { email: u.email, password: PASSWORD }));
    lines = [];
    expect((await post("/sign-out", {}, cookie)).status).toBe(200);
    expect(eventsOf("auth.logout")).toHaveLength(1);
    expect(eventsOf("auth.logout")[0]).toMatchObject({
      outcome: "success",
      actor: { user_id: u.userId },
      source_ip: "203.0.113.0",
    });
    expect(await auditOf(org.orgId, "auth.logout")).toHaveLength(1);

    lines = [];
    await post("/sign-out", {}, cookie); // cookie cũ: phiên đã xoá
    expect(eventsOf("auth.logout")).toHaveLength(0);
  });
});

describe("auth-events — đổi mật khẩu + thông báo account_security", () => {
  it("đổi thành công: log + audit + outbox member.password_changed; sai mật khẩu hiện tại: failure, không outbox", async () => {
    const u = await newUser("pw");
    const org = await seedOrg(t.admin, "KS Pw", "hotel", u.userId);
    const cookie = cookiesOf(await post("/sign-in/email", { email: u.email, password: PASSWORD }));
    lines = [];

    const bad = await post(
      "/change-password",
      { currentPassword: "khong-dung-mat-khau", newPassword: NEW_PASSWORD },
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(eventsOf("auth.password_changed")[0]).toMatchObject({
      outcome: "failure",
      reason: "invalid_password",
      actor: { user_id: u.userId },
    });
    expect(await auditOf(org.orgId, "auth.password_changed")).toEqual([]);

    lines = [];
    const ok = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(eventsOf("auth.password_changed")).toHaveLength(1);
    expect(eventsOf("auth.password_changed")[0]).toMatchObject({
      outcome: "success",
      actor: { user_id: u.userId },
    });
    expect(await auditOf(org.orgId, "auth.password_changed")).toHaveLength(1);
    const ob = await sql<{ event_type: string; payload: unknown }>`
      select event_type, payload from outbox where organization_id = ${org.orgId} and event_type = 'member.password_changed'`.execute(
      t.admin,
    );
    expect(ob.rows).toEqual([
      { event_type: "member.password_changed", payload: { membership_id: org.ownerMembershipId } },
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(NEW_PASSWORD);
  });

  it("worker xử lý sự kiện → thông báo account_security (bắt buộc) cho chính người đó, giao lại không tạo bản thứ hai, không lộ IP/UA", async () => {
    const u = await newUser("tb");
    const org = await seedOrg(t.admin, "KS Tb", "hotel", u.userId);
    const cookie = cookiesOf(await post("/sign-in/email", { email: u.email, password: PASSWORD }));
    await post("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, cookie);
    const ob = await sql<{ id: string; payload: Record<string, unknown> }>`
      select id, payload from outbox where organization_id = ${org.orgId} and event_type = 'member.password_changed'`.execute(
      t.admin,
    );
    const row = ob.rows[0] as (typeof ob.rows)[number];
    const job = {
      organization_id: org.orgId,
      outbox_id: row.id,
      event_type: "member.password_changed",
      aggregate_id: org.ownerMembershipId,
      payload: row.payload,
    };
    expect(await dispatchNotification(t.worker, job)).toBe(1);
    expect(await dispatchNotification(t.worker, job)).toBe(0);
    const n = await sql<{ type: string; recipient_person_id: string; title: string; body: string }>`
      select type, recipient_person_id, title, body from notifications where organization_id = ${org.orgId}`.execute(
      t.admin,
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({ type: "account_security", recipient_person_id: org.ownerPersonId });
    expect(n.rows[0]?.title).toContain("mật khẩu");
    expect(`${n.rows[0]?.title} ${n.rows[0]?.body}`).not.toMatch(/203\.0\.113|HotelTest/);
  });
});

describe("auth-events — owner đặt lại MFA (member.mfa_reset) → account_security", () => {
  it("worker xử lý member.mfa_reset: thông báo bắt buộc cho thành viên bị đặt lại", async () => {
    const org = await seedOrg(t.admin, "KS Reset");
    const owner = await ownerOf(t, org);
    const mgr = await seedMember(t, org, "manager");
    await okAs(t, owner, (ctx) =>
      resetMemberMfa(ctx, { membershipId: mgr.membershipId, reason: "Mất thiết bị" }),
    );
    const ob = await sql<{ id: string; payload: Record<string, unknown> }>`
      select id, payload from outbox where organization_id = ${org.orgId} and event_type = 'member.mfa_reset'`.execute(
      t.admin,
    );
    const row = ob.rows[0] as (typeof ob.rows)[number];
    expect(
      await dispatchNotification(t.worker, {
        organization_id: org.orgId,
        outbox_id: row.id,
        event_type: "member.mfa_reset",
        aggregate_id: mgr.membershipId,
        payload: row.payload,
      }),
    ).toBe(1);
    const n = await sql<{ type: string; recipient_person_id: string; title: string }>`
      select type, recipient_person_id, title from notifications where organization_id = ${org.orgId}`.execute(
      t.admin,
    );
    expect(n.rows).toEqual([
      {
        type: "account_security",
        recipient_person_id: mgr.personId,
        title: "KS Reset: xác thực hai lớp đã được đặt lại",
      },
    ]);
  });
});

describe("auth-events — MFA (TOTP)", () => {
  it("bật MFA (xác minh lần đầu) → mfa_enabled; đăng nhập bước một chưa phải login; bước hai đúng → login(mfa); sai → failure; tắt → mfa_disabled + outbox", async () => {
    const u = await newUser("mfa");
    const org = await seedOrg(t.admin, "KS Mfa", "hotel", u.userId);
    let cookie = cookiesOf(await post("/sign-in/email", { email: u.email, password: PASSWORD }));
    const enable = await post("/two-factor/enable", { password: PASSWORD }, cookie);
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    // URI chứa secret dạng base32; createOTP nhận secret gốc như Better Auth lưu.
    const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret") ?? ""));
    const codeNow = () => createOTP(secret).totp();

    lines = [];
    const verify = await post("/two-factor/verify-totp", { code: await codeNow() }, cookie);
    expect(verify.status).toBe(200);
    cookie = cookiesOf(verify) || cookie;
    expect(eventsOf("auth.mfa_enabled")).toHaveLength(1);
    expect(eventsOf("auth.mfa_enabled")[0]).toMatchObject({
      outcome: "success",
      actor: { user_id: u.userId },
    });
    expect(eventsOf("auth.login")).toHaveLength(0); // đăng ký MFA không phải đăng nhập
    expect(await auditOf(org.orgId, "auth.mfa_enabled")).toHaveLength(1);

    // Đăng nhập lại: bước một đúng nhưng CHƯA có phiên ⇒ chưa có auth.login thành công.
    await post("/sign-out", {}, cookie);
    lines = [];
    const step1 = await post("/sign-in/email", { email: u.email, password: PASSWORD });
    expect(step1.status).toBe(200);
    expect(await step1.json()).toMatchObject({ twoFactorRedirect: true });
    expect(eventsOf("auth.login")).toHaveLength(0);
    const challenge = cookiesOf(step1);

    const wrong = await post("/two-factor/verify-totp", { code: "000000" }, challenge);
    expect(wrong.status).toBe(401);
    expect(eventsOf("auth.login")).toHaveLength(1);
    expect(eventsOf("auth.login")[0]).toMatchObject({ outcome: "failure", reason: "mfa_invalid" });
    expect(lines.join("\n")).not.toContain("000000");

    lines = [];
    const good = await post("/two-factor/verify-totp", { code: await codeNow() }, challenge);
    expect(good.status).toBe(200);
    expect(eventsOf("auth.login")).toHaveLength(1);
    expect(eventsOf("auth.login")[0]).toMatchObject({
      outcome: "success",
      reason: "mfa",
      actor: { user_id: u.userId },
    });
    // 2 dòng: lần đăng nhập đầu (chưa bật MFA) + lần này (bước hai); bước một của lần này KHÔNG ghi.
    expect(await auditOf(org.orgId, "auth.login")).toHaveLength(2);
    cookie = cookiesOf(good);

    lines = [];
    const disable = await post("/two-factor/disable", { password: PASSWORD }, cookie);
    expect(disable.status).toBe(200);
    expect(eventsOf("auth.mfa_disabled")).toHaveLength(1);
    expect(eventsOf("auth.mfa_disabled")[0]).toMatchObject({
      outcome: "success",
      actor: { user_id: u.userId },
    });
    expect(await auditOf(org.orgId, "auth.mfa_disabled")).toHaveLength(1);
    const ob = await sql<{ n: number }>`
      select count(*)::int as n from outbox where organization_id = ${org.orgId} and event_type = 'member.mfa_disabled'`.execute(
      t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);
  });
});

describe("auth-events — nhiều tổ chức", () => {
  it("người dùng thuộc hai tổ chức: audit ở CẢ hai; tổ chức khác không thấy dòng của người lạ", async () => {
    const u = await newUser("hai");
    const a = await seedOrg(t.admin, "KS A", "hotel", u.userId);
    const b = await seedOrg(t.admin, "KS B", "hotel", u.userId);
    const other = await newUser("la");
    const c = await seedOrg(t.admin, "KS C", "hotel", other.userId);
    await post("/sign-in/email", { email: u.email, password: PASSWORD });
    expect(await auditOf(a.orgId, "auth.login")).toHaveLength(1);
    expect(await auditOf(b.orgId, "auth.login")).toHaveLength(1);
    expect(await auditOf(c.orgId, "auth.login")).toHaveLength(0);
  });
});
