// T-401 (BE-INT-002) — webhook nhận NHIỀU khoá HMAC khi xoay khoá (cùng biến SIM_WEBHOOK_SECRET, phân tách dấu phẩy):
// chữ ký khoá cũ trong thời gian xoay → 200; khoá đã bỏ / sửa 1 byte body → 401; không ghi inbox khi sai.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envSchema } from "../config/schema.ts";
import { parseWebhookSecrets, signSim, verifySimSignature } from "../ledger/bank-inbox.ts";
import { handleWebhook } from "./webhook-route.ts";

const OLD = "khoa-cu-chi-dung-trong-test-0123456789ab";
const NEW = "khoa-moi-chi-dung-trong-test-0123456789ab";
const OTHER = "khoa-la-khong-nam-trong-danh-sach-0123456789";
let t: TestDb;
let A: SeededOrg;
let account: string;

function request(secret: string, body: Record<string, unknown>, sendBody = JSON.stringify(body)): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`http://localhost/api/v1/webhooks/sim/${account}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hm-timestamp": ts,
      "x-hm-signature": signSim(secret, ts, JSON.stringify(body), account),
    },
    body: sendBody,
  });
}

const event = (n: string) => ({
  event_id: `E-rot-${n}-${randomUUID().slice(0, 8)}`,
  bank_txn_ref: `ROT${n}${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
  amount: 1_000_000,
  occurred_at: "2026-10-15T03:00:00Z",
});

const handle = (req: Request, simSecret: string | undefined) =>
  handleWebhook("sim", account, req, { db: t.runtime, simSecret });

async function inboxCount(eventId: string): Promise<number> {
  const r = await sql<{
    n: number;
  }>`select count(*)::int as n from inbox where provider_event_id = ${eventId}`.execute(t.admin);
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Webhook rotation");
  account = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${account}, ${A.orgId}, ${A.propertyId}, 'VCB', '****5600', '1017595600', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("webhook — xoay khoá (BE-INT-002)", () => {
  it("danh sách 'mới,cũ': ký bằng khoá cũ → 200, ký bằng khoá mới → 200 (không gián đoạn)", async () => {
    const list = `${NEW},${OLD}`;
    const a = event("a");
    expect((await handle(request(OLD, a), list)).status).toBe(200);
    const b = event("b");
    expect((await handle(request(NEW, b), list)).status).toBe(200);
    expect(await inboxCount(a.event_id)).toBe(1);
    expect(await inboxCount(b.event_id)).toBe(1);
  });

  it("khoá cũ đã bỏ khỏi danh sách → 401 WEBHOOK_SIGNATURE_INVALID, không ghi inbox", async () => {
    const e = event("c");
    const res = await handle(request(OLD, e), NEW);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    expect(await inboxCount(e.event_id)).toBe(0);
  });

  it("sửa 1 byte body (khoá đúng) → 401; khoá lạ → 401", async () => {
    const e = event("d");
    const raw = JSON.stringify(e);
    const tampered = raw.replace('"amount":1000000', '"amount":1000001');
    expect(tampered).not.toBe(raw);
    expect((await handle(request(NEW, e, tampered), `${NEW},${OLD}`)).status).toBe(401);
    expect((await handle(request(OTHER, e), `${NEW},${OLD}`)).status).toBe(401);
    expect(await inboxCount(e.event_id)).toBe(0);
  });

  it("một khoá (cấu hình cũ) vẫn chạy; không đặt/rỗng → 404; danh sách sai dạng → đóng (404), không nhận gì", async () => {
    const e = event("e");
    expect((await handle(request(NEW, e), NEW)).status).toBe(200);
    const f = event("f");
    expect((await handle(request(NEW, f), undefined)).status).toBe(404);
    expect((await handle(request(NEW, f), "")).status).toBe(404);
    expect((await handle(request("ngan", f), `${NEW},ngan`)).status).toBe(404); // khoá ngắn trong danh sách
    expect(await inboxCount(f.event_id)).toBe(0);
  });
});

describe("parseWebhookSecrets / verifySimSignature", () => {
  it("phân tích: cắt khoảng trắng; rỗng ⇒ []; mục rỗng, ngắn, trùng, quá 3 khoá ⇒ lỗi không lộ giá trị", () => {
    expect(parseWebhookSecrets(` ${NEW} , ${OLD}`)).toEqual([NEW, OLD]);
    expect(parseWebhookSecrets(undefined)).toEqual([]);
    expect(parseWebhookSecrets("")).toEqual([]);
    expect(() => parseWebhookSecrets(`${NEW},`)).toThrow(/32/);
    expect(() => parseWebhookSecrets(`${NEW},,${OLD}`)).toThrow(/32/);
    expect(() => parseWebhookSecrets(`${NEW},ngan`)).toThrow(/32/);
    expect(() => parseWebhookSecrets(`${NEW},${NEW}`)).toThrow(/trùng/);
    expect(() => parseWebhookSecrets([NEW, OLD, OTHER, `${NEW}x`].join(","))).toThrow(/tối đa/);
    try {
      parseWebhookSecrets(`${NEW},ngan-bi-mat`);
    } catch (e) {
      expect((e as Error).message).not.toContain("ngan-bi-mat");
    }
  });

  it("verifySimSignature nhận mảng; mảng rỗng ⇒ từ chối", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSim(OLD, ts, "{}", "acc");
    const base = { account: "acc", body: "{}", timestamp: ts, signature: sig };
    expect(() => verifySimSignature({ ...base, secret: [NEW, OLD] })).not.toThrow();
    expect(() => verifySimSignature({ ...base, secret: OLD })).not.toThrow();
    expect(() => verifySimSignature({ ...base, secret: [NEW] })).toThrow();
    expect(() => verifySimSignature({ ...base, secret: [] })).toThrow();
  });

  it("schema môi trường chấp nhận danh sách hợp lệ và từ chối khoá ngắn/trùng", () => {
    const base = {
      APP_BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost/db",
      BETTER_AUTH_SECRET: "x".repeat(40),
      S3_ENDPOINT: "http://localhost:8333",
      S3_BUCKET: "hotel",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s".repeat(12),
    };
    expect(envSchema.safeParse({ ...base, SIM_WEBHOOK_SECRET: `${NEW},${OLD}` }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, SIM_WEBHOOK_SECRET: NEW }).success).toBe(true);
    expect(envSchema.safeParse(base).success).toBe(true);
    expect(envSchema.safeParse({ ...base, SIM_WEBHOOK_SECRET: `${NEW},ngan` }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SIM_WEBHOOK_SECRET: `${NEW},${NEW}` }).success).toBe(false);
  });
});
