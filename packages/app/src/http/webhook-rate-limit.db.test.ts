// T-504 (BE-REL-006) — giới hạn tần suất bằng bộ đếm trong Postgres (migration 0053): hai kết nối/pool KHÁC NHAU chia sẻ cùng
// bộ đếm (khoá advisory) ⇒ lượt vượt bị 429 + Retry-After; áp cho webhook (đã xác thực + chữ ký sai) và hàm đếm dùng chung.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signSim } from "../ledger/bank-inbox.ts";
import { rateLimitHit } from "./rate-limit.ts";
import { handleWebhook } from "./webhook-route.ts";

const SECRET = "khoa-chi-dung-trong-test-rate-limit-0123456789";
let t: TestDb;
let A: SeededOrg;
let account: string;
/** Pool thứ hai tới CÙNG Postgres (vai trò app_runtime) — mô phỏng instance/kết nối khác. */
let second: Kysely<unknown>;

function request(body: Record<string, unknown>, secret = SECRET): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  return new Request(`http://localhost/api/v1/webhooks/sim/${account}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hm-timestamp": ts,
      "x-hm-signature": signSim(secret, ts, raw, account),
    },
    body: raw,
  });
}

const event = () => ({
  event_id: `E-rl-${randomUUID()}`,
  bank_txn_ref: `RL${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
  amount: 500_000,
  occurred_at: "2026-10-15T03:00:00Z",
});

const hits = async (scope: string, subject: string): Promise<number> =>
  (
    await sql<{ n: number }>`select coalesce(sum(hits), 0)::int as n from rate_limit_counters
      where scope = ${scope} and subject = ${subject}`.execute(t.admin)
  ).rows[0]?.n ?? 0;

/**
 * Cửa sổ cố định 60 s theo đồng hồ thật: test gọi `now()` mà chạy vắt qua ranh giới phút thì bộ đếm về 0 giữa chừng
 * (CI đỏ "lượt 2: used 1"). Còn < 5 s tới ranh giới thì chờ sang cửa sổ mới — mỗi test ở đây chạy dưới 5 s.
 */
const WINDOW_MS = 60_000;
const EDGE_MARGIN_MS = 5_000;
function msUntilSafeWindow(nowMs: number): number {
  const left = WINDOW_MS - (nowMs % WINDOW_MS);
  return left < EDGE_MARGIN_MS ? left + 50 : 0;
}
beforeEach(async () => {
  const wait = msUntilSafeWindow(Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
});

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Webhook rate limit");
  account = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${account}, ${A.orgId}, ${A.propertyId}, 'VCB', '****5601', '1017595601', 'NGUYEN VAN A')`.execute(
    t.admin,
  );
  second = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: t.runtimeUrl, max: 10 }) }),
  });
});

afterAll(async () => {
  await second.destroy();
  await t.drop();
});

describe("app.rate_limit_hit — bộ đếm dùng chung", () => {
  it("hai pool xen kẽ cùng một bộ đếm: lượt thứ limit+1 bị từ chối kèm retry_after trong cửa sổ", async () => {
    const subject = randomUUID();
    const pools = [t.runtime, second];
    for (let i = 0; i < 4; i++) {
      const r = await rateLimitHit(pools[i % 2] as Kysely<unknown>, { scope: "test", subject, limit: 4 });
      expect(r, `lượt ${i + 1}`).toEqual({ allowed: true, used: i + 1 });
    }
    for (const db of pools) {
      const over = await rateLimitHit(db, { scope: "test", subject, limit: 4 });
      expect(over.allowed).toBe(false);
      if (!over.allowed) {
        expect(over.retryAfter).toBeGreaterThanOrEqual(1);
        expect(over.retryAfter).toBeLessThanOrEqual(60);
        expect(over.used).toBe(4);
      }
    }
    // Lượt bị từ chối KHÔNG tăng bộ đếm (bảng không phình theo kẻ spam).
    expect(await hits("test", subject)).toBe(4);
  });

  it("đua thật: 40 lượt đồng thời trên hai pool với limit 10 → đúng 10 lượt được qua (khoá advisory, không lọt lượt cuối)", async () => {
    const subject = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        rateLimitHit(i % 2 ? second : t.runtime, { scope: "race", subject, limit: 10 }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await hits("race", subject)).toBe(10);
  });

  it("cửa sổ mới ⇒ đếm lại từ 0; Retry-After = giây tới hết cửa sổ cố định; subject/scope khác độc lập", async () => {
    const subject = randomUUID();
    const t0 = new Date("2026-10-17T03:00:10.000Z"); // 10 s sau đầu phút
    expect(await rateLimitHit(t.runtime, { scope: "win", subject, limit: 1, now: t0 })).toMatchObject({
      allowed: true,
    });
    const over = await rateLimitHit(second, { scope: "win", subject, limit: 1, now: t0 });
    expect(over).toMatchObject({ allowed: false, retryAfter: 50 });
    // Sát hết cửa sổ: còn 1 s (làm tròn lên, không bao giờ 0).
    const edge = await rateLimitHit(t.runtime, {
      scope: "win",
      subject,
      limit: 1,
      now: new Date("2026-10-17T03:00:59.400Z"),
    });
    expect(edge).toMatchObject({ allowed: false, retryAfter: 1 });
    // Phút kế tiếp: lượt mới được qua.
    expect(
      await rateLimitHit(second, {
        scope: "win",
        subject,
        limit: 1,
        now: new Date("2026-10-17T03:01:00.000Z"),
      }),
    ).toMatchObject({ allowed: true, used: 1 });
    expect(await rateLimitHit(t.runtime, { scope: "win2", subject, limit: 1, now: t0 })).toMatchObject({
      allowed: true,
    });
    expect(
      await rateLimitHit(t.runtime, { scope: "win", subject: randomUUID(), limit: 1, now: t0 }),
    ).toMatchObject({ allowed: true });
  });

  it("ca biên: limit < 1 → lỗi (không âm thầm chặn/bỏ qua); runtime không đọc/ghi thẳng bảng; hàng cũ > 1 ngày bị dọn", async () => {
    await expect(rateLimitHit(t.runtime, { scope: "bad", subject: "x", limit: 0 })).rejects.toThrow(
      /p_limit/,
    );
    await expect(sql`select * from rate_limit_counters`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`insert into rate_limit_counters (scope, subject, window_start, hits) values ('x', 'y', now(), 1)`.execute(
        t.runtime,
      ),
    ).rejects.toThrow(/permission denied/);
    await sql`insert into rate_limit_counters (scope, subject, window_start, hits)
              values ('old', 'o1', now() - interval '3 days', 5)`.execute(t.admin);
    await rateLimitHit(t.runtime, { scope: "clean", subject: randomUUID(), limit: 5 });
    expect(await hits("old", "o1")).toBe(0);
  });

  it("Unicode trong subject không làm hỏng khoá/đếm", async () => {
    const subject = `Phòng 203 — Nguyễn Văn Ạ ${randomUUID()}`;
    await rateLimitHit(t.runtime, { scope: "uni", subject, limit: 1 });
    expect(await rateLimitHit(second, { scope: "uni", subject, limit: 1 })).toMatchObject({ allowed: false });
  });
});

describe("webhook — giới hạn tần suất (BE-REL-006)", () => {
  it("đã xác thực: hai pool dùng chung bộ đếm theo tài khoản → vượt ⇒ 429 + Retry-After, không ghi inbox; tài khoản khác không bị ảnh hưởng", async () => {
    const mk = (db: Kysely<unknown>) => ({ db, simSecret: SECRET, rateLimit: { perAccount: 3 } });
    const sent: ReturnType<typeof event>[] = [];
    for (let i = 0; i < 3; i++) {
      const e = event();
      sent.push(e);
      expect((await handleWebhook("sim", account, request(e), mk(i % 2 ? second : t.runtime))).status).toBe(
        200,
      );
    }
    const blocked = event();
    for (const db of [t.runtime, second]) {
      const res = await handleWebhook("sim", account, request(blocked), mk(db));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
    }
    const n = await sql<{ n: number }>`select count(*)::int as n from inbox
      where provider_event_id = ${blocked.event_id}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    expect(await hits("webhook", `sim:${account}`)).toBe(3);
  });

  it("chữ ký SAI: đếm theo nhà cung cấp; vượt ⇒ 429 thay 401; webhook hợp lệ (tài khoản còn hạn mức) vẫn qua", async () => {
    const mk = (db: Kysely<unknown>) => ({
      db,
      simSecret: SECRET,
      rateLimit: { badSignature: 2, perAccount: 1000 },
    });
    const bad = (db: Kysely<unknown>) =>
      handleWebhook(
        "sim",
        account,
        request(event(), "khoa-sai-khong-nam-trong-danh-sach-0123456789"),
        mk(db),
      );
    expect((await bad(t.runtime)).status).toBe(401);
    expect((await bad(second)).status).toBe(401);
    const res = await bad(t.runtime);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Kẻ gọi sai chữ ký không chặn được webhook hợp lệ.
    expect((await handleWebhook("sim", account, request(event()), mk(second))).status).toBe(200);
    // Subject là tên nhà cung cấp (không phải `account` do kẻ gọi chọn) ⇒ không có hàng theo account bậy bạ.
    const rows = await sql<{ subject: string }>`select subject from rate_limit_counters
      where scope = 'webhook_bad_signature'`.execute(t.admin);
    expect(rows.rows.map((r) => r.subject)).toEqual(["sim"]);
  });

  it("nhà cung cấp lạ/adapter tắt vẫn 404 trước khi đụng bộ đếm", async () => {
    const before = await sql<{ n: number }>`select count(*)::int as n from rate_limit_counters`.execute(
      t.admin,
    );
    expect(
      (await handleWebhook("khac", account, request(event()), { db: t.runtime, simSecret: SECRET })).status,
    ).toBe(404);
    expect(
      (await handleWebhook("sim", account, request(event()), { db: t.runtime, simSecret: undefined })).status,
    ).toBe(404);
    const after = await sql<{ n: number }>`select count(*)::int as n from rate_limit_counters`.execute(
      t.admin,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe("msUntilSafeWindow — tránh ranh giới cửa sổ", () => {
  it("giữa cửa sổ ⇒ 0; sát ranh giới ⇒ chờ qua ranh giới; đúng ranh giới ⇒ 0", () => {
    const base = Date.UTC(2026, 9, 19, 1, 46, 0);
    expect(msUntilSafeWindow(base + 30_000)).toBe(0);
    expect(msUntilSafeWindow(base + 54_999)).toBe(0);
    expect(msUntilSafeWindow(base + 55_001)).toBe(4_999 + 50);
    expect(msUntilSafeWindow(base + 59_999)).toBe(1 + 50);
    expect(msUntilSafeWindow(base)).toBe(0);
    expect((base + 59_999 + msUntilSafeWindow(base + 59_999)) % WINDOW_MS).toBe(50);
  });
});
