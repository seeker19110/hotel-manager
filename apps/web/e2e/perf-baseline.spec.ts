// Đo tài nguyên web + backend trên bản production (`next start`) của E2E (XC-GREEN-001, XC-PERF-004, QA-PERF-006; PLAN đợt 7 T-608).
// Hai chế độ:
//  - mặc định (CI): chỉ kiểm NGÂN SÁCH trọng lượng trang/số request ở `perf/budgets.json` (cổng chặn hồi quy, không ghi file);
//  - `PERF_BASELINE_OUT=docs/perf/baseline-web-<ngày>.json`: đo đủ (3 lần/trang lấy trung vị, 1.000 yêu cầu API tuần tự lấy p50/p95/p99,
//    CPU/RSS của tiến trình web theo 1.000 yêu cầu qua /proc) rồi ghi baseline kèm ngày, commit, môi trường, thiết bị, số mẫu.
// Điều kiện đo: Chromium giả lập Pixel 7, KHÔNG throttle mạng/CPU, localhost, Postgres cluster tạm cùng máy — số tuyệt đối chỉ để so
// sánh tương đối giữa các lần chạy cùng môi trường (không thay Lighthouse CI/k6 trên staging).
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { expect, test } from "@playwright/test";
import { type Budgets, checkPageBudget, type PageStat, parseBudgets } from "./perf-budget.ts";
import { loginStaff } from "./sessions.ts";

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "block" });

// Hàm kiểm ngân sách ở `./perf-budget.ts` (thuần, có unit test thêm 200 KB phải đỏ); spec chỉ đo và gọi hàm đó.
const budgets: Budgets = parseBudgets(
  JSON.parse(readFileSync(new URL("../../../perf/budgets.json", import.meta.url), "utf8")),
);
const OUT = process.env.PERF_BASELINE_OUT;
const PUBLIC_PAGES = ["/dang-nhap", "/dang-nhap/nguoi-thue", "/offline"];
const STAFF_PAGES = ["/chon-to-chuc", "/phong", "/buong-phong", "/su-co", "/thong-bao"];
const RUNS = OUT ? 3 : 1;
const API_SAMPLES = 1000;
const API_PATH = "/api/v1/today/getSummary";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

let cookies: Awaited<ReturnType<typeof loginStaff>> = [];

test.beforeAll(async ({ browser }, info) => {
  cookies = await loginStaff(browser, info.project.use.baseURL as string, "main");
});

async function measurePage(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  route: string,
  authed: boolean,
): Promise<PageStat> {
  const ctx = await browser.newContext({ baseURL });
  if (authed) await ctx.addCookies(cookies);
  try {
    const page = await ctx.newPage();
    const sizes: { url: string; bytes: number; type: string }[] = [];
    const pending: Promise<void>[] = [];
    page.on("requestfinished", (req) => {
      pending.push(
        (async () => {
          const s = await req.sizes();
          const res = await req.response();
          sizes.push({
            url: req.url(),
            bytes: s.responseBodySize + s.responseHeadersSize,
            type: res?.headers()["content-type"] ?? "",
          });
        })(),
      );
    });
    await page.goto(route, { waitUntil: "networkidle" });
    await Promise.all(pending);
    const sum = (xs: { bytes: number }[]) => xs.reduce((a, b) => a + b.bytes, 0);
    return {
      route,
      requests: sizes.length,
      transfer_kb: round(sum(sizes) / 1024),
      js_kb: round(sum(sizes.filter((x) => /javascript/.test(x.type))) / 1024),
    };
  } finally {
    await ctx.close();
  }
}

const results: PageStat[] = [];

for (const [authed, routes] of [
  [false, PUBLIC_PAGES],
  [true, STAFF_PAGES],
] as const) {
  for (const route of routes) {
    test(`ngân sách trang ${route}: trọng lượng truyền tải và số request không vượt perf/budgets.json`, async ({
      browser,
    }, info) => {
      const baseURL = info.project.use.baseURL as string;
      const runs: PageStat[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await measurePage(browser, baseURL, route, authed));
      const stat: PageStat = {
        route,
        requests: median(runs.map((r) => r.requests)),
        transfer_kb: median(runs.map((r) => r.transfer_kb)),
        js_kb: median(runs.map((r) => r.js_kb)),
      };
      results.push(stat);
      expect(
        checkPageBudget(stat, budgets).map((v) => v.message),
        "vượt perf/budgets.json",
      ).toEqual([]);
    });
  }
}

/** Chạy `fn`; lỗi (không phải Linux, tiến trình khác chủ/đã thoát) → `fallback` thay vì làm hỏng phép đo. */
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** pid của tiến trình đang nghe cổng TCP (IPv4) qua /proc — null nếu không tìm được (không phải Linux/không đủ quyền). */
function pidListeningOn(port: number): number | null {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inode = safe(
    () =>
      readFileSync("/proc/net/tcp", "utf8")
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .find((c) => c[3] === "0A" && c[1]?.endsWith(`:${hex}`))?.[9],
    undefined,
  );
  if (!inode) return null;
  const owns = (pid: string) =>
    safe(
      () =>
        readdirSync(`/proc/${pid}/fd`).some(
          (fd) => readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`,
        ),
      false,
    );
  const pid = safe(() => readdirSync("/proc"), [] as string[]).find((n) => /^\d+$/.test(n) && owns(n));
  return pid ? Number(pid) : null;
}

const cpuTicks = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8")
    .replace(/^.*\) /, "")
    .split(" ");
  return Number(f[11]) + Number(f[12]); // utime + stime (sau khi bỏ "pid (comm) ")
};
const rssMb = (pid: number) =>
  Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;

test("độ trễ API (p50/p95/p99, số mẫu) và CPU/RSS backend theo 1.000 yêu cầu — chỉ ghi khi PERF_BASELINE_OUT", async ({
  browser,
}, info) => {
  // biome-ignore lint/suspicious/noSkippedTests: bỏ qua có điều kiện — lý do nằm ngay trong lời gọi (đo đầy đủ chỉ khi đặt PERF_BASELINE_OUT)
  test.skip(!OUT, "chế độ đo đầy đủ chỉ chạy khi đặt PERF_BASELINE_OUT");
  test.setTimeout(180_000);
  const baseURL = info.project.use.baseURL as string;
  const port = Number(new URL(baseURL).port);
  const ctx = await browser.newContext({ baseURL });
  await ctx.addCookies(cookies);
  try {
    for (let i = 0; i < 50; i++) await ctx.request.get(API_PATH); // khởi động nóng, không tính
    const pid = pidListeningOn(port);
    const ticksPerSec = Number(execSync("getconf CLK_TCK").toString().trim()) || 100;
    const cpu0 = pid ? cpuTicks(pid) : 0;
    const lat: number[] = [];
    const t0 = Date.now();
    let failed = 0;
    for (let i = 0; i < API_SAMPLES; i++) {
      const s = performance.now();
      const res = await ctx.request.get(API_PATH);
      lat.push(performance.now() - s);
      if (res.status() >= 400) failed++;
    }
    const seconds = (Date.now() - t0) / 1000;
    const cpuMs = pid ? ((cpuTicks(pid) - cpu0) / ticksPerSec) * 1000 : null;
    expect(failed).toBe(0);
    const sorted = [...lat].sort((a, b) => a - b);
    const commit = execSync("git rev-parse --short HEAD").toString().trim();
    const dirty = execSync("git status --porcelain").toString().trim() ? " (+ thay đổi chưa commit)" : "";
    const baseline = {
      schema: 1,
      kind: "web-resource-baseline",
      measured: true,
      date: new Date().toISOString().slice(0, 10),
      commit: `${commit}${dirty}`,
      environment: {
        description:
          "next start (bản build production) + Postgres 17 cluster tạm cùng máy (apps/web/e2e/server.ts); không CDN, không nén phía proxy; cùng máy với trình duyệt đo",
        os: `${platform()} ${release()}`,
        node: process.version,
        cpu: `${cpus().length} lõi ${cpus()[0]?.model ?? ""}`.trim(),
        memory_gb: round(totalmem() / 1024 ** 3),
      },
      device: {
        browser: "Chromium (Playwright), giả lập Pixel 7",
        network: "localhost, không throttle mạng, không throttle CPU",
        cache: "trình duyệt mới cho mỗi lần đo (không cache), service worker bị chặn",
        runs_per_page: RUNS,
        aggregation: "median",
      },
      pages: results.sort((a, b) => a.route.localeCompare(b.route)),
      api: {
        route: `GET ${API_PATH}`,
        vus: 1,
        duration_s: round(seconds, 1),
        samples: API_SAMPLES,
        failed,
        p50_ms: round(pct(sorted, 50), 2),
        p95_ms: round(pct(sorted, 95), 2),
        p99_ms: round(pct(sorted, 99), 2),
        note: "một VU tuần tự qua loopback — không phải tải đồng thời; k6 (perf/k6) mới đo tải",
      },
      backend: {
        process: pid ? "tiến trình nghe cổng của next start (đọc /proc)" : "không xác định được tiến trình",
        requests: API_SAMPLES,
        cpu_ms_per_1000_requests: cpuMs === null ? null : round(cpuMs, 0),
        rss_mb_after: pid ? round(rssMb(pid), 0) : null,
        kwh_per_1000_requests: null,
        kwh_note: "chưa đo — cần đồng hồ năng lượng/cgroup của VPS thật; CPU-giây là chỉ báo thay thế",
      },
    };
    writeFileSync(OUT as string, `${JSON.stringify(baseline, null, 2)}\n`);
  } finally {
    await ctx.close();
  }
});
