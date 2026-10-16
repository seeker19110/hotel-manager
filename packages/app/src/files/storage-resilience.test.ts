// T-302 (ARC-RES-001, BE-REL-001/003): kho object có timeout mỗi lần gọi, retry ≤ 3 lần chỉ với thao tác idempotent.
// Server HTTP giả cục bộ (loopback) điều khiển từng phản hồi; không cần S3 thật.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.ts";
import {
  DEFAULT_RESILIENCE,
  ObjectStorage,
  parseRetryAfter,
  resilientSend,
  StorageError,
  type StorageResilience,
} from "./storage.ts";

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

describe("trần tổng thời gian (BE-REL-003, T-401)", () => {
  it("mặc định có trần tổng ≥ trần một lần và ≤ 30 giây", () => {
    expect(DEFAULT_RESILIENCE.totalTimeoutMs).toBeGreaterThanOrEqual(DEFAULT_RESILIENCE.timeoutMs);
    expect(DEFAULT_RESILIENCE.totalTimeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("lỗi 503 mãi với lùi chờ dài: dừng khi hết trần tổng (không chờ đủ 1 + 3 lần), lỗi nêu 'quá tổng thời gian' kèm lỗi gốc", async () => {
    const endpoint = await start((_q, res) => {
      res.statusCode = 503;
      res.end();
    });
    const t0 = Date.now();
    const err = await storage(endpoint, {
      baseDelayMs: 150,
      maxDelayMs: 150,
      random: () => 1, // chờ đúng 150 ms mỗi lần ⇒ 1 + 3 lần thử cần ≥ 450 ms
      totalTimeoutMs: 300,
    })
      .put("k", BODY, "text/plain")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toContain("quá tổng thời gian 300 ms");
    expect((err as StorageError).status).toBe(503);
    expect(((err as StorageError).cause as StorageError).message).toContain("HTTP 503");
    expect((err as StorageError).retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(450);
    expect(hits.length).toBeLessThan(4); // chưa đủ 1 + 3 lần
  });

  it("server treo: mỗi lần gọi bị cắt còn phần thời gian còn lại ⇒ tổng ≤ trần tổng, không phải 4 × timeoutMs", async () => {
    const endpoint = await start(() => {});
    const t0 = Date.now();
    await expect(
      storage(endpoint, { timeoutMs: 2_000, totalTimeoutMs: 300, baseDelayMs: 1, maxDelayMs: 5 }).put(
        "k",
        BODY,
        "text/plain",
      ),
    ).rejects.toThrow(StorageError);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("phương thức không idempotent không thử lại (BE-REL-003)", () => {
  const cfg = (over: Partial<StorageResilience> = {}): StorageResilience => ({
    ...DEFAULT_RESILIENCE,
    baseDelayMs: 1,
    maxDelayMs: 5,
    sleep: async () => {},
    ...over,
  });
  const plain = async (url: string, init: RequestInit) => new Request(url, init);

  it("POST gặp 503/timeout ⇒ đúng một lần gọi, lỗi trả ngay", async () => {
    const endpoint = await start((_q, res) => {
      res.statusCode = 503;
      res.end();
    });
    await expect(
      resilientSend(plain, "gửi", `${endpoint}/x`, { method: "POST" }, (st) => st === 200, cfg()),
    ).rejects.toThrow(/HTTP 503/);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe("POST");
  });

  it("POST treo ⇒ một lần, báo quá thời gian (không gửi lại có thể tạo bản ghi trùng)", async () => {
    const endpoint = await start(() => {});
    await expect(
      resilientSend(
        plain,
        "gửi",
        `${endpoint}/x`,
        { method: "POST" },
        (st) => st === 200,
        cfg({ timeoutMs: 100 }),
      ),
    ).rejects.toThrow(/quá thời gian/);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("PUT (idempotent) cùng tình huống thì thử lại — đối chứng", async () => {
    const endpoint = await start((_q, res, n) => {
      res.statusCode = n < 3 ? 503 : 200;
      res.end();
    });
    await resilientSend(plain, "ghi", `${endpoint}/x`, { method: "PUT" }, (st) => st === 200, cfg());
    expect(hits).toHaveLength(3);
  });

  it("409 và 400 không thử lại với mọi phương thức", async () => {
    for (const status of [400, 409]) {
      const endpoint = await start((_q, res) => {
        res.statusCode = status;
        res.end();
      });
      await expect(
        resilientSend(plain, "ghi", `${endpoint}/x`, { method: "PUT" }, (st) => st === 200, cfg()),
      ).rejects.toMatchObject({ status, retryable: false });
      expect(hits).toHaveLength(1);
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = undefined;
    }
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
