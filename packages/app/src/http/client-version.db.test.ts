// SPEC-pwa S-009: client quá cũ gửi command ⇒ 426 CLIENT_OUTDATED, không ghi dữ liệu (không audit, không idempotency_keys),
// trên Postgres thật qua handleCommand.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testServices } from "../server/services.ts";
import { type CommandDef, type HttpDeps, handleCommand, handleUserCommand } from "./command-route.ts";
import { handleFileUpload } from "./file-upload.ts";
import { handleImportUpload } from "./import-upload.ts";
import { USER_COMMANDS } from "./registry.ts";

let t: TestDb;
let A: SeededOrg;
let deps: HttpDeps;

const ECHO: CommandDef<{ n: number }, { doubled: number }> = {
  command: "test.echo",
  input: z.strictObject({ n: z.number().int().min(0) }),
  run: async (ctx, i) => {
    await ctx.audit({ action: "test.echo", entityType: "test" });
    return { data: { doubled: i.n * 2 } };
  },
};

const post = (headers: Record<string, string>) =>
  new Request("http://local.test/api/v1/test/echo", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID(), ...headers },
    body: JSON.stringify({ n: 2 }),
  });

const signedIn = () => ({ "x-test-user": A.ownerAuthUserId, "x-test-2fa": "1", "x-org-id": A.orgId });

async function counts(): Promise<{ keys: number; audits: number }> {
  const k = await sql<{ n: string }>`select count(*)::text as n from idempotency_keys`.execute(t.admin);
  const a = await sql<{
    n: string;
  }>`select count(*)::text as n from audit_events where action = 'test.echo'`.execute(t.admin);
  return { keys: Number(k.rows[0]?.n), audits: Number(a.rows[0]?.n) };
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS phiên bản client");
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
    secureCookies: false,
    services: testServices(),
    minClientVersion: "1.2.0",
  };
});

afterAll(async () => {
  await t.drop();
});

describe("S-009 client quá cũ", () => {
  it("X-App-Version thấp hơn mức tối thiểu ⇒ 426 CLIENT_OUTDATED, không ghi gì (no-store, problem+json)", async () => {
    const before = await counts();
    const res = await handleCommand(ECHO, post({ ...signedIn(), "x-app-version": "1.1.9" }), deps);
    expect(res.status).toBe(426);
    expect(res.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      code: "CLIENT_OUTDATED",
      status: 426,
      title: "Ứng dụng cần cập nhật để tiếp tục.",
    });
    expect(await counts()).toEqual(before);
  });

  it("kiểm TRƯỚC phiên: chưa đăng nhập vẫn nhận 426 (client cũ cần cập nhật trước khi đăng nhập lại)", async () => {
    const res = await handleCommand(ECHO, post({ "x-app-version": "0.0.1" }), deps);
    expect(res.status).toBe(426);
  });

  it("header sai định dạng ⇒ 426; bằng mức tối thiểu hoặc cao hơn ⇒ chạy bình thường", async () => {
    expect((await handleCommand(ECHO, post({ ...signedIn(), "x-app-version": "abc" }), deps)).status).toBe(
      426,
    );
    for (const v of ["1.2.0", "1.10.0", "2.0.0-rc.1"]) {
      const res = await handleCommand(ECHO, post({ ...signedIn(), "x-app-version": v }), deps);
      expect(res.status, v).toBe(200);
    }
  });

  it("không gửi header (script/API client) ⇒ không kiểm; không đặt mức tối thiểu ⇒ không ai bị chặn", async () => {
    expect((await handleCommand(ECHO, post(signedIn()), deps)).status).toBe(200);
    const open = { ...deps };
    delete open.minClientVersion;
    const res = await handleCommand(ECHO, post({ ...signedIn(), "x-app-version": "0.0.1" }), open);
    expect(res.status).toBe(200);
  });
});

// Lệnh cấp người dùng (org.create…) cũng là đường ghi từ trình duyệt: client cũ bị chặn như command thường.
describe("S-009 client quá cũ — lệnh cấp người dùng", () => {
  it("org.create với X-App-Version thấp ⇒ 426 CLIENT_OUTDATED trước phiên, không tạo tổ chức", async () => {
    const def = USER_COMMANDS["org.create"];
    if (!def) throw new Error("thiếu org.create trong USER_COMMANDS");
    const name = `Tổ chức cũ ${randomUUID().slice(0, 8)}`;
    const req = (h: Record<string, string>) =>
      new Request("http://local.test/api/v1/org/create", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID(), ...h },
        body: JSON.stringify({ name }),
      });
    for (const h of [
      { "x-app-version": "1.1.9" },
      { "x-app-version": "0.0.1", "x-test-user": randomUUID() },
    ]) {
      const res = await handleUserCommand(def as never, req(h), deps);
      expect(res.status).toBe(426);
      expect(((await res.json()) as { code: string }).code).toBe("CLIENT_OUTDATED");
    }
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from organizations where name = ${name}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    // Không gửi header ⇒ không kiểm phiên bản (đi tiếp tới kiểm phiên: chưa đăng nhập ⇒ 401).
    expect((await handleUserCommand(def as never, req({}), deps)).status).toBe(401);
  });
});

// Hai route tải file kiểm phiên bản như lệnh: client cũ không được ghi file/lô nhập qua đường khác lệnh.
describe("S-009 client quá cũ — route tải ảnh và nhập liệu", () => {
  const uploadReq = (url: string, headers: Record<string, string>) =>
    new Request(`http://local.test${url}`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID(), ...headers },
      body: Buffer.from("x"),
    });
  const fileUrl = () => `/api/v1/files/upload?owner_type=work_order&property_id=${A.propertyId}`;
  const routes: [string, (h: Record<string, string>) => Promise<Response>][] = [
    [
      "files/upload",
      (h) => handleFileUpload(uploadReq(fileUrl(), { "content-type": "image/jpeg", ...h }), deps),
    ],
    [
      "import/upload",
      (h) =>
        handleImportUpload(
          uploadReq("/api/v1/import/upload", { "content-type": "multipart/form-data; boundary=x", ...h }),
          deps,
        ),
    ],
  ];

  for (const [name, call] of routes) {
    it(`${name}: X-App-Version thấp ⇒ 426 CLIENT_OUTDATED, không ghi gì, kiểm TRƯỚC phiên`, async () => {
      const before = await counts();
      const files = await sql<{ n: string }>`select count(*)::text as n from files`.execute(t.admin);
      for (const h of [{ "x-app-version": "1.1.9" }, { ...signedIn(), "x-app-version": "abc" }]) {
        const res = await call(h);
        expect(res.status, name).toBe(426);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toMatchObject({ code: "CLIENT_OUTDATED", status: 426 });
      }
      expect(await counts()).toEqual(before);
      expect(
        (await sql<{ n: string }>`select count(*)::text as n from files`.execute(t.admin)).rows[0]?.n,
      ).toBe(files.rows[0]?.n);
    });

    it(`${name}: đủ phiên bản hoặc không gửi header ⇒ không bị 426 (đi tiếp tới kiểm phiên)`, async () => {
      expect((await call({ "x-app-version": "1.2.0" })).status).toBe(401);
      expect((await call({})).status).toBe(401);
    });
  }
});
