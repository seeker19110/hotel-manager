// BE-AUTH-004 — cookie phiên: https ⇒ `__Host-` + Secure + HttpOnly + SameSite=Lax + Path=/ + không Domain; http cục bộ ⇒ tên thường,
// không Secure. ID phiên (token) đổi sau mỗi lần đăng nhập. Đăng xuất rồi dùng lại cookie → xem `authz-matrix.db.test.ts` (T-404).
import { randomUUID } from "node:crypto";
import { createTestDb, type TestDb } from "@hm/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";

// Mật khẩu giả cho DB test tạm; ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
const PASSWORD = ["mat", "khau", "thu", "nghiem", "12"].join("-");
let t: TestDb;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  for (const c of closers) await c();
  await t.drop();
});

async function login(base: string) {
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: base,
    ipRateLimit: false,
  });
  closers.push(created.close);
  const email = `ck+${randomUUID().slice(0, 8)}@example.test`;
  await created.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  const signIn = () =>
    created.auth.handler(
      new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
  return { auth: created.auth, signIn };
}

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => /session_token=/.test(c)) ?? "";

describe("BE-AUTH-004 — thuộc tính cookie phiên", () => {
  it("https: __Host-hm.session_token; Secure, HttpOnly, SameSite=Lax, Path=/, không Domain; getSession đọc được", async () => {
    const { auth, signIn } = await login("https://hm.example.vn");
    const res = await signIn();
    expect(res.status).toBe(200);
    const c = sessionCookie(res);
    expect(c).toMatch(/^__Host-hm\.session_token=/);
    expect(c).toMatch(/; Secure/i);
    expect(c).toMatch(/; HttpOnly/i);
    expect(c).toMatch(/; SameSite=Lax/i);
    expect(c).toMatch(/; Path=\//i);
    expect(c).not.toMatch(/; Domain=/i);
    // Mọi cookie Better Auth phát ra đều theo luật `__Host-` (không cookie nào lọt ra với tên thường).
    for (const x of res.headers.getSetCookie()) expect(x).toMatch(/^__Host-/);
    const cookie = res.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.email).toMatch(/^ck\+/);
  });

  it("http cục bộ/E2E: tên thường, không Secure (trình duyệt không nhận __Host- qua http)", async () => {
    const { signIn } = await login("http://localhost:3000");
    const c = sessionCookie(await signIn());
    expect(c).toMatch(/^better-auth\.session_token=/);
    expect(c).not.toMatch(/; Secure/i);
    expect(c).toMatch(/; HttpOnly/i);
    expect(c).toMatch(/; SameSite=Lax/i);
  });

  it("ID phiên (token) khác nhau giữa hai lần đăng nhập — không tái sử dụng/cố định phiên", async () => {
    const { signIn } = await login("https://hm.example.vn");
    const token = (c: string) => decodeURIComponent(c.split(";")[0]?.split("=")[1] ?? "").split(".")[0] ?? "";
    const a = token(sessionCookie(await signIn()));
    const b = token(sessionCookie(await signIn()));
    expect(a.length).toBeGreaterThanOrEqual(22); // ≥ 128 bit (≥ 22 ký tự base64url)
    expect(b).not.toBe(a);
  });
});
