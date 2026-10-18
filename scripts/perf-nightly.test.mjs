// QA-PERF-002 (load test tự động nightly, thresholds p95 + tỷ lệ lỗi, đỏ khi vượt) và QA-PERF-007 (không tải vào production;
// CI cấm đích production) — khoá .github/workflows/perf-nightly.yml, scripts/k6-target-guard.mjs, bản k6 ghim trong dev-env-setup.sh.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { targetProblem } from "./k6-target-guard.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const wf = parse(read(".github/workflows/perf-nightly.yml"));
const job = wf.jobs.k6;
const runs = job.steps.map((s) => String(s.run ?? ""));
const at = (needle) => runs.findIndex((r) => r.includes(needle));

describe("perf-nightly.yml — load test tự động", () => {
  it("chạy hằng đêm và chạy tay; không chạy trên pull_request/push", () => {
    expect(wf.on.schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.on).not.toHaveProperty("pull_request");
    expect(wf.on).not.toHaveProperty("push");
  });

  it("k6 chạy kịch bản có thresholds p95/p99 và tỷ lệ lỗi; k6 thoát ≠ 0 khi vượt (không nuốt mã lỗi)", () => {
    const k6 = runs[at("k6 run")];
    expect(k6).toMatch(/^k6 run [^\n]*perf\/k6\/room-list\.js$/);
    expect(k6).not.toMatch(/\|\||; *true|--no-thresholds/);
    const script = read("perf/k6/room-list.js");
    expect(script).toMatch(/thresholds\("rooms-page"\)/);
    const lib = read("perf/k6/lib.js");
    expect(lib).toMatch(/http_req_failed: \[\{ threshold: `rate<\$\{LIMITS\.failRate\}`/);
    expect(lib).toMatch(/`p\(95\)<\$\{p95\}`/);
    expect(job.env).toMatchObject({ K6_PROFILE: "load" });
    expect(k6).toMatch(/-e LOAD_VUS=\d+ -e LOAD_DURATION=\d+m/);
  });

  it("không đặt tuỳ chọn gốc của k6 qua biến môi trường (K6_VUS/K6_DURATION/K6_ITERATIONS/K6_STAGES đè `scenarios`)", () => {
    const all = { ...wf.env, ...job.env, ...Object.assign({}, ...job.steps.map((s) => s.env ?? {})) };
    for (const k of ["K6_VUS", "K6_DURATION", "K6_ITERATIONS", "K6_STAGES"])
      expect(all, k).not.toHaveProperty(k);
  });

  it("đích chỉ là app tạm trong runner: BASE_URL loopback, danh sách cho phép chỉ loopback, chặn TRƯỚC khi cài/chạy", () => {
    expect(job.env.BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(job.env.K6_ALLOWED_HOSTS).toBe("127.0.0.1");
    const guard = at("scripts/k6-target-guard.mjs");
    expect(guard).toBeGreaterThan(-1);
    expect(runs[guard]).toContain('"$BASE_URL" "$K6_ALLOWED_HOSTS"');
    expect(guard).toBeLessThan(at("pnpm install"));
    expect(guard).toBeLessThan(at("k6 run"));
    // Không có domain thật nào trong workflow (QA-PERF-007: grep).
    const text = read(".github/workflows/perf-nightly.yml");
    expect(
      text.match(/https?:\/\/[^\s"']+/g)?.filter((u) => !/^http:\/\/127\.0\.0\.1/.test(u)) ?? [],
    ).toEqual([]);
  });

  it("app dựng như job e2e (Postgres service ghim digest, build production, seed giả); log server được quét PII; job có timeout", () => {
    expect(job.services.postgres.image).toMatch(/^postgres:17[.\d]*@sha256:[0-9a-f]{64}$/);
    expect(at("pnpm --filter web build")).toBeGreaterThan(-1);
    expect(runs[at("node e2e/server.ts")]).toContain("api/health");
    expect(at("node e2e/perf-session-env.ts")).toBeLessThan(at("k6 run"));
    expect(at("pii-log-scan.mjs")).toBeGreaterThan(at("k6 run"));
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("k6 cài bản ghim + SHA-256 (dev-env-setup.sh --only k6), không tải 'latest'", () => {
    const setup = read("scripts/dev-env-setup.sh");
    expect(setup).toMatch(/^K6_VERSION="\d+\.\d+\.\d+"$/m);
    expect(setup).toMatch(/^K6_SHA256="[0-9a-f]{64}"$/m);
    expect(setup).toMatch(/sha256sum -c --quiet -\n[^\n]*\n[^\n]*k6/);
    expect(runs[at("--only k6")]).toBeTruthy();
    expect(setup).not.toMatch(/k6[^\n]*latest/);
  });
});

describe("k6-target-guard — chặn đích production", () => {
  it.each([
    ["http://127.0.0.1:3100", "127.0.0.1"],
    ["http://localhost:3000/", "localhost,127.0.0.1"],
    ["https://app.staging.hotel.example", "app.staging.hotel.example"],
  ])("cho phép %s", (url, allowed) => expect(targetProblem(url, allowed)).toBeNull());

  it.each([
    ["https://hotel.example.vn", "hotel.example.vn", /không phải loopback/],
    ["https://hotel.example.vn", "127.0.0.1", /không phải loopback/],
    [
      "http://127.0.0.1:3100",
      "127.0.0.1,hotel.example.vn",
      /không phải loopback\/staging: hotel\.example\.vn/,
    ],
    ["http://127.0.0.1:3100", "localhost", /không nằm trong/],
    ["ftp://127.0.0.1", "127.0.0.1", /không hợp lệ/],
    ["", "127.0.0.1", /không hợp lệ/],
  ])("chặn %s (cho phép %s)", (url, allowed, why) => expect(targetProblem(url, allowed)).toMatch(why));

  it("CLI: exit 0 với loopback, exit 1 với domain thật", () => {
    const run = (...a) =>
      spawnSync("node", [join(ROOT, "scripts/k6-target-guard.mjs"), ...a], { encoding: "utf8" }).status;
    expect(run("http://127.0.0.1:3100", "127.0.0.1")).toBe(0);
    expect(run("https://hotel.example.vn", "hotel.example.vn")).toBe(1);
  });
});
