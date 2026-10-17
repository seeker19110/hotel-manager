// T-410 — Argon2id cho mật khẩu (BE-AUTH-001, D-031) trên Better Auth + Postgres thật: băm mới theo PHC/OWASP, băm
// scrypt cũ vẫn đăng nhập rồi được băm lại, băm lạ/tham số quá lớn bị từ chối nhanh, telemetry tắt.
import { argon2Sync } from "node:crypto";
import { createTestDb, type TestDb } from "@hm/testkit";
import { hashPassword as hashLegacyScrypt } from "better-auth/crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "./auth.ts";
import { ARGON2_PARAMS, argon2idPhc, hashPassword, needsRehash, verifyPassword } from "./password.ts";

const BASE = "http://localhost:3000";
// Mật khẩu giả cho DB test tạm; ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
const PASSWORD = ["mat", "khau", "thu", "nghiem", "12"].join("-");
const PHC_PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";
const SALT = Buffer.from("0123456789abcdef");
const VECTOR_PASSWORD = ["mat", "khau", "vector", "ổn", "định"].join("-");
// Sinh một lần bằng argon2idPhc(VECTOR_PASSWORD, SALT) rồi khoá lại: đổi tham số/mã hoá/chuẩn hoá là test đỏ.
const VECTOR =
  "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$3VaWmEWYujjWh6ykOuHYuLMBcpZYyLucKTnqKRk0XEk";

let t: TestDb;
let auth: Auth;
let closeAuth: () => Promise<void>;

async function storedHash(email: string): Promise<string> {
  const r = await sql<{
    password: string;
  }>`select a.password from auth.account a join auth."user" u on u.id = a."userId"
    where u.email = ${email} and a."providerId" = 'credential'`.execute(t.admin);
  return r.rows[0]?.password ?? "";
}

async function signIn(email: string, password: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    }),
  );
}

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
});

afterAll(async () => {
  await closeAuth();
  await t.drop();
});

describe("password-hash: hàm băm", () => {
  it("nguyên thủy Argon2id của Node khớp vector RFC 9106 §5.3", () => {
    const tag = argon2Sync("argon2id", {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString("hex")).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("vector cố định: salt + mật khẩu cố định ⇒ đúng chuỗi PHC đã khoá", async () => {
    expect(await argon2idPhc(VECTOR_PASSWORD, SALT)).toBe(VECTOR);
    expect(await verifyPassword({ hash: VECTOR, password: VECTOR_PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: VECTOR, password: `${VECTOR_PASSWORD}x` })).toBe(false);
    expect(needsRehash(VECTOR)).toBe(false);
  });

  it("chuẩn hoá NFKC: dạng ghép và dạng tổ hợp của cùng một mật khẩu khớp nhau", async () => {
    const composed = "Mật-khẩu-ổn-định-1";
    const hash = await hashPassword(composed.normalize("NFC"));
    expect(await verifyPassword({ hash, password: composed.normalize("NFD") })).toBe(true);
  });

  it("hashPassword: PHC chuẩn, salt ngẫu nhiên mỗi lần", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a.startsWith(PHC_PREFIX)).toBe(true);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword({ hash: a, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: a, password: "" })).toBe(false);
  });

  it("băm lạ/hỏng ⇒ false, không ném", async () => {
    for (const hash of [
      "",
      "x",
      "$argon2id$",
      "$argon2id$v=19$m=19456,t=2,p=1$$",
      "a:b",
      "$argon2i$v=19$m=1,t=1,p=1$YQ$YQ",
    ]) {
      expect(await verifyPassword({ hash, password: PASSWORD })).toBe(false);
    }
    expect(await verifyPassword({ hash: VECTOR, password: "" })).toBe(false);
  });

  it("PHC tham số quá lớn/nhỏ bị từ chối nhanh (chống DoS), không tính Argon2", async () => {
    const tail = "$MDEyMzQ1Njc4OWFiY2RlZg$3VaWmEWYujjWh6ykOuHYuLMBcpZYyLucKTnqKRk0XEk";
    const phc = (m: number, t: number, p: number): string => `$argon2id$v=19$m=${m},t=${t},p=${p}${tail}`;
    const bad = [
      phc(4194304, 2, 1), // 4 GiB
      phc(65537, 2, 1),
      phc(19456, 11, 1),
      phc(19456, 2, 5),
      phc(19456, 0, 1),
      phc(19456, 2, 0),
      phc(4, 2, 1), // m < 8p
    ];
    // So với một lần tính Argon2 thật trên cùng máy (không ngưỡng tuyệt đối — máy CI/đang tải chậm đều như nhau):
    // từ chối cả 7 PHC xấu phải rẻ hơn hẳn một lần tính, tức không lần nào chạm tới Argon2.
    const r0 = performance.now();
    expect(await verifyPassword({ hash: VECTOR, password: PASSWORD })).toBe(false);
    const oneArgon2 = performance.now() - r0;
    const t0 = performance.now();
    for (const hash of bad) expect(await verifyPassword({ hash, password: PASSWORD })).toBe(false);
    expect(performance.now() - t0).toBeLessThan(oneArgon2 / 2);
    // Ở biên trên vẫn được chấp nhận về cú pháp (kết quả sai mật khẩu vẫn là false nhưng đã tính).
    expect(needsRehash(phc(65536, 10, 4))).toBe(true);
  });

  it("needsRehash: scrypt cũ và tham số lỗi thời ⇒ true", async () => {
    expect(needsRehash(await hashLegacyScrypt(PASSWORD))).toBe(true);
    expect(needsRehash("")).toBe(true);
    expect(needsRehash(await argon2idPhc(PASSWORD, SALT, { ...ARGON2_PARAMS, t: 1 }))).toBe(true);
  });
});

describe("password-hash: Better Auth + Postgres", () => {
  it("đăng ký ⇒ cột password là Argon2id PHC; đăng nhập đúng 200, sai 401 và băm không đổi", async () => {
    const email = "dk@example.test";
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const stored = await storedHash(email);
    expect(stored.startsWith(PHC_PREFIX)).toBe(true);

    expect((await signIn(email, PASSWORD)).status).toBe(200);
    expect((await signIn(email, `${PASSWORD}-sai`)).status).toBe(401);
    expect(await storedHash(email)).toBe(stored);
  });

  it("user băm scrypt mặc định cũ vẫn đăng nhập được, sau đó cột đổi sang Argon2id (sai mật khẩu thì không đổi)", async () => {
    const email = "cu@example.test";
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const legacy = await hashLegacyScrypt(PASSWORD); // hàm mặc định thật của Better Auth
    expect(legacy).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await sql`update auth.account set password = ${legacy} where "userId" = (select id from auth."user" where email = ${email})`.execute(
      t.admin,
    );

    expect((await signIn(email, `${PASSWORD}-sai`)).status).toBe(401);
    expect(await storedHash(email)).toBe(legacy);

    expect((await signIn(email, PASSWORD)).status).toBe(200);
    const upgraded = await storedHash(email);
    expect(upgraded.startsWith(PHC_PREFIX)).toBe(true);
    expect(upgraded).not.toBe(legacy);

    // Băm mới dùng tiếp được và không bị băm lại lần nữa.
    expect((await signIn(email, PASSWORD)).status).toBe(200);
    expect(await storedHash(email)).toBe(upgraded);
  });

  it("hai lần đăng nhập song song với băm cũ: cả hai thành công, cột cuối cùng là một băm Argon2id hợp lệ", async () => {
    const email = "song-song@example.test";
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    await sql`update auth.account set password = ${await hashLegacyScrypt(PASSWORD)}
              where "userId" = (select id from auth."user" where email = ${email})`.execute(t.admin);
    const [a, b] = await Promise.all([signIn(email, PASSWORD), signIn(email, PASSWORD)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const stored = await storedHash(email);
    expect(stored.startsWith(PHC_PREFIX)).toBe(true);
    expect(await verifyPassword({ hash: stored, password: PASSWORD })).toBe(true);
  });

  it("băm trong CSDL bị hỏng hoặc tham số quá lớn ⇒ đăng nhập 401 nhanh, không ném 500", async () => {
    const email = "hong@example.test";
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const where = sql`"userId" = (select id from auth."user" where email = ${email})`;
    await sql`update auth.account set password = '$argon2id$v=19$m=4194304,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$3VaWmEWYujjWh6ykOuHYuLMBcpZYyLucKTnqKRk0XEk' where ${where}`.execute(
      t.admin,
    );
    const t0 = performance.now();
    expect((await signIn(email, PASSWORD)).status).toBe(401);
    expect(performance.now() - t0).toBeLessThan(2000);
    await sql`update auth.account set password = 'rác' where ${where}`.execute(t.admin);
    expect((await signIn(email, PASSWORD)).status).toBe(401);
  });

  it("user không tồn tại ⇒ 401 như sai mật khẩu", async () => {
    expect((await signIn("khong-co@example.test", PASSWORD)).status).toBe(401);
  });
});

describe("password-hash: telemetry Better Auth", () => {
  it("tắt tường minh và không gọi mạng khi đăng ký/đăng nhập", async () => {
    const ctx = await auth.$context;
    expect(ctx.options.telemetry?.enabled).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const email = "tele@example.test";
      await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
      expect((await signIn(email, PASSWORD)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("env BETTER_AUTH_TELEMETRY bật ⇒ createAuth từ chối khởi động", () => {
    vi.stubEnv("BETTER_AUTH_TELEMETRY", "1");
    try {
      expect(() => createAuth({ databaseUrl: t.runtimeUrl, secret: "s".repeat(48), baseURL: BASE })).toThrow(
        /BETTER_AUTH_TELEMETRY/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
