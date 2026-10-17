// T-402 (BASE-ERR-004, ARC-RES-009): mọi `fetch` phía trình duyệt có AbortSignal.timeout qua helper dùng chung.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FETCH_TIMEOUT_MS, timedFetch, UPLOAD_TIMEOUT_MS } from "../lib/fetch-timeout.ts";

const WEB = new URL("..", import.meta.url).pathname;

let server: Server | undefined;
async function start(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("timedFetch", () => {
  it("hằng số hợp lý: API thường ngắn hơn tải lên; cả hai hữu hạn", () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(FETCH_TIMEOUT_MS).toBeLessThan(UPLOAD_TIMEOUT_MS);
    expect(UPLOAD_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("server treo ⇒ TimeoutError trong hạn, không treo vô hạn", async () => {
    const url = await start(() => {
      /* không bao giờ trả lời */
    });
    const t0 = Date.now();
    const err = await timedFetch(url, {}, 150).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("phản hồi bình thường qua; tuỳ chọn khác (method, body) được giữ", async () => {
    const url = await start((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => res.end(`${req.method}:${Buffer.concat(chunks).toString()}`));
    });
    const r = await timedFetch(url, { method: "POST", body: "xin chào" });
    expect(await r.text()).toBe("POST:xin chào");
  });

  it("nơi gọi tự huỷ bằng signal riêng ⇒ huỷ ngay, trước hạn", async () => {
    const url = await start(() => {});
    const ctl = new AbortController();
    const p = timedFetch(url, { signal: ctl.signal }, 10_000).catch((e: unknown) => e);
    setTimeout(() => ctl.abort(), 50);
    const t0 = Date.now();
    const err = await p;
    expect((err as DOMException).name).toBe("AbortError");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("signal đã huỷ sẵn ⇒ từ chối ngay", async () => {
    const url = await start((_q, res) => res.end("x"));
    await expect(timedFetch(url, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe("rào: không còn `fetch(` trần ở components/, app/, lib/", () => {
  function walk(d: string): string[] {
    return readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (n === "node_modules" || n === ".next") return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  }
  it("mọi lời gọi mạng đi qua timedFetch (lib/fetch-timeout.ts là nơi duy nhất gọi fetch)", () => {
    const bad: string[] = [];
    let wrapped = 0;
    for (const dir of ["components", "app", "lib"]) {
      for (const f of walk(join(WEB, dir))) {
        if (f.endsWith("lib/fetch-timeout.ts")) continue;
        const src = readFileSync(f, "utf8");
        const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/(?<![\w.])fetch\s*\(/.test(code)) bad.push(f.replace(WEB, ""));
        wrapped += (code.match(/\btimedFetch\s*\(/g) ?? []).length;
      }
    }
    expect(bad).toEqual([]);
    expect(wrapped).toBeGreaterThanOrEqual(8);
  });

  it("helper dùng AbortSignal.timeout", () => {
    expect(readFileSync(join(WEB, "lib/fetch-timeout.ts"), "utf8")).toContain("AbortSignal.timeout(");
  });
});
