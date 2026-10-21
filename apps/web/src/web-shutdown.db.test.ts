// T-402 (ARC-RES-009, BE-REL-004) — dừng êm của web THẬT: `next start` (bản build production) trên Postgres thật, cổng 3180.
// Cách làm: dùng `.next` đã build (cổng trước commit build trước khi test); thiếu thì test tự `next build`. Kho S3 là máy chủ
// giả cục bộ có độ trễ điều khiển được cho HEAD bucket ⇒ `/api/ready` chính là "request chậm đang chạy". Kiểm: SIGTERM khi
// request chậm đang chạy ⇒ (1) `/api/ready` mới trả 503 ngay, (2) request chậm vẫn nhận 200, (3) tiến trình thoát mã 0 trong hạn,
// (4) sau đó cổng đóng. Chạy ≈ 10 giây (thời gian báo 5 giây của lib/shutdown.ts).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "@hm/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeClamd } from "../e2e/fakes.ts";
import { DRAIN_NOTICE_MS, SHUTDOWN_DEADLINE_MS } from "../lib/shutdown.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3180;
const BASE = `http://127.0.0.1:${PORT}`;

let t: TestDb;
let s3: Server;
let s3Port = 0;
let s3DelayMs = 0;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let child: ChildProcess | undefined;
let stderr = "";
const exited: { code: number | null; signal: NodeJS.Signals | null; at: number }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`quá thời gian chờ: ${what}\n${stderr.slice(-2000)}`);
}

const get = (path: string) => fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15_000) });

beforeAll(async () => {
  t = await createTestDb();
  // Kho S3 giả: HEAD bucket trả 200 sau `s3DelayMs` (chính là độ chậm của /api/ready).
  s3 = createServer((req, res) => {
    req.resume();
    setTimeout(() => res.writeHead(200).end(), req.method === "HEAD" ? s3DelayMs : 0);
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
  s3Port = (s3.address() as { port: number }).port;
  clamd = await startFakeClamd();

  // Build thiếu hoặc cũ hơn mã dừng êm (instrumentation/lib/shutdown/route ready) ⇒ dựng lại, không kiểm nhầm bản cũ.
  const buildId = join(WEB_DIR, ".next", "BUILD_ID");
  const sources = ["instrumentation.ts", "lib/shutdown.ts", "app/api/ready/route.ts"].map((f) =>
    join(WEB_DIR, f),
  );
  const stale = !existsSync(buildId) || sources.some((f) => statSync(f).mtimeMs > statSync(buildId).mtimeMs);
  if (stale) {
    const b = spawnSync("pnpm", ["exec", "next", "build"], {
      cwd: WEB_DIR,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    if (b.status !== 0) throw new Error(`next build lỗi:\n${b.stdout}\n${b.stderr}`);
  }
  const nextBin = createRequire(join(WEB_DIR, "package.json")).resolve("next/dist/bin/next");
  child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SMTP_URL: "fake://local",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_BASE_URL: BASE,
      DATABASE_URL: t.runtimeUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_BUCKET: "hm-shutdown",
      S3_ACCESS_KEY_ID: "test",
      S3_SECRET_ACCESS_KEY: "khong-dung-that",
      HM_PII_KEYS: `1:${randomBytes(32).toString("base64")}`,
      HM_PII_KEY_ID: "1",
      HM_PII_INDEX_KEY: randomBytes(32).toString("base64"),
      CLAMD_HOST: "127.0.0.1",
      CLAMD_PORT: String(clamd.port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  child.on("exit", (code, signal) => void exited.push({ code, signal, at: Date.now() }));
  await waitUntil(
    async () => (await get("/api/health").catch(() => null))?.status === 200,
    60_000,
    "web khởi động",
  );
}, 400_000);

afterAll(async () => {
  if (child && exited.length === 0) child.kill("SIGKILL");
  s3?.close();
  clamd?.server.close();
  await t?.drop();
});

describe("web-shutdown — SIGTERM khi có request chậm đang chạy", () => {
  it("ready 200 trước SIGTERM; SIGTERM ⇒ ready mới 503 ngay, request chậm vẫn 200, thoát mã 0 trong hạn, cổng đóng", async () => {
    const ok = await get("/api/ready");
    expect(ok.status).toBe(200);

    s3DelayMs = 2_000; // request chậm: /api/ready mất ~2 giây vì kho object trả lời chậm
    const slowStartedAt = Date.now();
    const slow = get("/api/ready").then(async (r) => ({
      status: r.status,
      body: await r.json(),
      at: Date.now(),
    }));
    await sleep(400); // chắc chắn request đã vào server và đang chờ kho
    const sentAt = Date.now();
    child?.kill("SIGTERM");

    // (1) request MỚI sau SIGTERM: 503 `draining` ngay (không chờ kho chậm), server vẫn nhận kết nối.
    await sleep(200);
    const t1 = Date.now();
    const during = await get("/api/ready");
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ status: "draining" });
    expect(Date.now() - t1).toBeLessThan(1_000);
    // health (sống) vẫn 200 trong thời gian báo — chỉ readiness báo "đừng gửi thêm".
    expect((await get("/api/health")).status).toBe(200);

    // (2) request chậm đã vào trước SIGTERM nhận 200 đầy đủ.
    const done = await slow;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "ready" });
    expect(done.at - slowStartedAt).toBeGreaterThan(1_500); // thật sự chậm

    // (3) thoát mã 0 trong hạn chót.
    await waitUntil(() => exited.length > 0, SHUTDOWN_DEADLINE_MS + 5_000, "tiến trình thoát");
    expect(exited[0]).toMatchObject({ code: 0, signal: null });
    expect(exited[0]?.at ? exited[0].at - sentAt : Number.POSITIVE_INFINITY).toBeLessThan(
      SHUTDOWN_DEADLINE_MS,
    );
    expect(exited[0]?.at ? exited[0].at - sentAt : 0).toBeGreaterThanOrEqual(DRAIN_NOTICE_MS - 500);
    expect(stderr).toContain("web.shutdown_started");

    // (4) cổng đã đóng.
    await expect(get("/api/health")).rejects.toThrow();
  }, 90_000);
});
