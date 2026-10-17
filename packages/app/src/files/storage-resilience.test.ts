// T-302 (ARC-RES-001, BE-REL-001/003): kho object có timeout mỗi lần gọi, retry ≤ 3 lần chỉ với thao tác idempotent.
// Server HTTP giả cục bộ (loopback) điều khiển từng phản hồi; không cần S3 thật.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.ts";
import { ObjectStorage, parseRetryAfter, StorageError, type StorageResilience } from "./storage.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

let server: Server | undefined;
let hits: { method: string; url: string }[] = [];

async function start(handler: Handler): Promise<string> {
  hits = [];
  server = createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    req.resume();
    handler(req, res, hits.length);
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function storage(endpoint: string, resilience: Partial<StorageResilience> = {}): ObjectStorage {
  return new ObjectStorage({
    endpoint,
    region: "test",
    bucket: "bucket-test",
    accessKeyId: "AKIATEST",
    secretAccessKey: "khoa-bi-mat-test",
    resilience: { timeoutMs: 3_000, baseDelayMs: 1, maxDelayMs: 20, ...resilience },
  });
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const BODY = new Uint8Array([1, 2, 3]);

describe("timeout", () => {
  it("server treo → lỗi StorageError 'quá thời gian' trong thời hạn, không treo vô hạn", async () => {
    const endpoint = await start(() => {
      /* không bao giờ trả lời */
    });
    const t0 = Date.now();
    const err = await storage(endpoint, { timeoutMs: 100, maxRetries: 0 })
      .put("a/b.txt", BODY, "text/plain")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toContain("quá thời gian");
    expect((err as StorageError).retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Tải máy cao có thể làm 100 ms hết trước khi yêu cầu tới server: chỉ khẳng định KHÔNG gửi lại (≤ 1 lần tới nơi).
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("treo ở mọi lần → thử đúng 1 + 3 lần rồi báo lỗi", async () => {
    const endpoint = await start(() => {});
    const waits: number[] = [];
    await expect(
      storage(endpoint, { timeoutMs: 80, sleep: async (ms) => void waits.push(ms) }).delete("k"),
    ).rejects.toThrow(/quá thời gian/);
    expect(waits).toHaveLength(3); // 1 + 3 lần thử, đếm qua số lần chờ (không phụ thuộc yêu cầu kịp tới server)
  });

  it("ping không thử lại (readiness phản ánh trạng thái hiện tại)", async () => {
    const endpoint = await start((_q, res) => {
      res.statusCode = 503;
      res.end();
    });
    await expect(storage(endpoint).ping()).rejects.toThrow(/HTTP 503/);
    expect(hits).toHaveLength(1);
  });
});

describe("retry", () => {
  it("503 hai lần rồi 200 → thành công ở lần thứ 3, cùng một key/đường dẫn", async () => {
    const endpoint = await start((_q, res, n) => {
      res.statusCode = n <= 2 ? 503 : 200;
      res.end();
    });
    await storage(endpoint).put("nhà/tệp 1.txt", BODY, "text/plain");
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.url)).size).toBe(1);
    expect(hits.every((h) => h.method === "PUT")).toBe(true);
  });

  it("503 mãi → dừng sau 3 lần thử lại (4 lần gọi), lỗi mang status", async () => {
    const endpoint = await start((_q, res) => {
      res.statusCode = 503;
      res.end();
    });
    const err = await storage(endpoint)
      .put("k", BODY, "text/plain")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).status).toBe(503);
    expect(hits).toHaveLength(4);
  });

  it.each([400, 403, 404])("%i → KHÔNG thử lại", async (status) => {
    const endpoint = await start((_q, res) => {
      res.statusCode = status;
      res.end();
    });
    const err = await storage(endpoint)
      .put("k", BODY, "text/plain")
      .catch((e: unknown) => e);
    expect((err as StorageError).status).toBe(status);
    expect((err as StorageError).retryable).toBe(false);
    expect(hits).toHaveLength(1);
  });

  it("DELETE: 404 coi là đã xoá (không lỗi, không thử lại); 429 rồi 204 → thành công", async () => {
    const e1 = await start((_q, res) => {
      res.statusCode = 404;
      res.end();
    });
    await storage(e1).delete("k");
    expect(hits).toHaveLength(1);
    await new Promise<void>((r) => server?.close(() => r()));
    const e2 = await start((_q, res, n) => {
      res.statusCode = n === 1 ? 429 : 204;
      res.end();
    });
    await storage(e2).delete("k");
    expect(hits).toHaveLength(2);
  });

  it("mất kết nối (reset) rồi phục hồi → thử lại", async () => {
    const endpoint = await start((req, res, n) => {
      if (n === 1) {
        req.socket.destroy();
        return;
      }
      res.statusCode = 200;
      res.end();
    });
    await storage(endpoint).ensureBucket();
    expect(hits).toHaveLength(2);
  });

  it("cổng đóng (từ chối kết nối) → StorageError lỗi kết nối sau khi hết lượt", async () => {
    const endpoint = await start(() => {});
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    await expect(storage(endpoint).put("k", BODY, "text/plain")).rejects.toThrow(/lỗi kết nối/);
  });

  it("tôn trọng Retry-After (có trần maxDelayMs) và lùi mũ có jitter", async () => {
    const endpoint = await start((_q, res, n) => {
      if (n <= 3) {
        res.statusCode = 503;
        if (n === 1) res.setHeader("retry-after", "2");
      } else res.statusCode = 200;
      res.end();
    });
    const waits: number[] = [];
    await storage(endpoint, {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      random: () => 0, // jitter thấp nhất = 0,5 × mũ
      sleep: async (ms) => void waits.push(ms),
    }).put("k", BODY, "text/plain");
    // lần 1: Retry-After 2 s bị cắt ở trần 1000; lần 2: 100·2¹·0,5 = 100; lần 3: 100·2²·0,5 = 200
    expect(waits).toEqual([1_000, 100, 200]);
  });
});

describe("parseRetryAfter", () => {
  it("số giây, ngày HTTP, rỗng, rác, âm", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("0")).toBe(0);
    const now = Date.parse("2026-10-16T00:00:00Z");
    expect(parseRetryAfter("Fri, 16 Oct 2026 00:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Thu, 15 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("sớm thôi")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });
});

describe("pool Postgres (DB-PERF-004)", () => {
  it("createPool đặt connectionTimeout/idleTimeout và có handler lỗi (không sập tiến trình)", async () => {
    const seen: Error[] = [];
    const pool = createPool("postgres://u:p@127.0.0.1:1/db", { max: 3, onError: (e) => seen.push(e) });
    const opts = pool.options as {
      connectionTimeoutMillis?: number;
      idleTimeoutMillis?: number;
      max?: number;
    };
    expect(opts.connectionTimeoutMillis).toBe(5_000);
    expect(opts.idleTimeoutMillis).toBe(30_000);
    expect(opts.max).toBe(3);
    expect(() => pool.emit("error", new Error("rơi kết nối"))).not.toThrow();
    expect(seen.map((e) => e.message)).toEqual(["rơi kết nối"]);
    await pool.end();
  });
});
