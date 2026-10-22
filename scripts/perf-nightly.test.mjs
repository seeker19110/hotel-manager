// QA-PERF-002 (load test tự động nightly, thresholds p95 + tỷ lệ lỗi, đỏ khi vượt) và QA-PERF-007 (không tải vào production;
// CI cấm đích production) — khoá .github/workflows/perf-nightly.yml, scripts/perf-load.sh (các bước của job, cũng là khoá `perf`
// của xt.yaml), scripts/k6-target-guard.mjs, bản k6 ghim trong dev-env-setup.sh.
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
const sh = read("scripts/perf-load.sh");
const lib = read("scripts/lib-e2e-app.sh");
// Thứ tự bước so trên phần mã (bỏ dòng chú thích — đầu file có mô tả các bước).
const shCode = sh
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const shAt = (needle) => {
  const i = shCode.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("perf-nightly.yml — load test tự động", () => {
  it("chạy hằng đêm và chạy tay; không chạy trên pull_request/push", () => {
    expect(wf.on.schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.on).not.toHaveProperty("pull_request");
    expect(wf.on).not.toHaveProperty("push");
  });

  it("job gọi scripts/perf-load.sh (tóm tắt vào perf-out/ để lưu artifact)", () => {
    const step = job.steps.find((st) => st.run === "bash scripts/perf-load.sh");
    expect(step?.env).toEqual({ PERF_OUT: "perf-out" });
    const upload = job.steps.find((st) => String(st.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(upload.with.path).toBe("perf-out/k6-summary.json");
  });

  it("k6 chạy kịch bản có thresholds p95/p99 và tỷ lệ lỗi; k6 thoát ≠ 0 khi vượt (script giữ mã lỗi, không nuốt)", () => {
    expect(sh).toMatch(/^set -euo pipefail$/m);
    expect(sh).toMatch(
      /hm_run_wait k6 run -e LOAD_VUS="\$LOAD_VUS" -e LOAD_DURATION="\$LOAD_DURATION" \\\n\s+--summary-export "\$OUT\/k6-summary\.json" "\$HM_ROOT\/perf\/k6\/room-list\.js" \|\| k6_rc=\$\?\n/,
    );
    expect(sh).toMatch(/^\[ "\$k6_rc" -eq 0 \] \|\| hm_die "\$k6_rc" /m);
    expect(sh).not.toMatch(/--no-thresholds|k6 run[^\n]*(\|\| *true|; *true)/);
    const script = read("perf/k6/room-list.js");
    expect(script).toMatch(/thresholds\("rooms-page"\)/);
    const lib6 = read("perf/k6/lib.js");
    expect(lib6).toMatch(/http_req_failed: \[\{ threshold: `rate<\$\{LIMITS\.failRate\}`/);
    expect(lib6).toMatch(/`p\(95\)<\$\{p95\}`/);
    expect(job.env).toMatchObject({ K6_PROFILE: "load" });
    expect(sh).toMatch(/^export K6_PROFILE=load$/m);
    expect(sh).toMatch(/^LOAD_VUS="\$\{LOAD_VUS:-20\}"$/m);
    expect(sh).toMatch(/^LOAD_DURATION="\$\{LOAD_DURATION:-3m\}"$/m);
  });

  it("không đặt tuỳ chọn gốc của k6 qua biến môi trường (K6_VUS/K6_DURATION/K6_ITERATIONS/K6_STAGES đè `scenarios`)", () => {
    const all = { ...wf.env, ...job.env, ...Object.assign({}, ...job.steps.map((s) => s.env ?? {})) };
    for (const k of ["K6_VUS", "K6_DURATION", "K6_ITERATIONS", "K6_STAGES"])
      expect(all, k).not.toHaveProperty(k);
    // script bỏ các biến đó nếu môi trường người chạy có sẵn
    expect(sh).toMatch(/^unset K6_VUS K6_DURATION K6_ITERATIONS K6_STAGES$/m);
  });

  it("đích chỉ là app tạm trong runner: BASE_URL loopback, danh sách cho phép chỉ loopback, chặn TRƯỚC khi cài/chạy", () => {
    expect(job.env.BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(job.env.K6_ALLOWED_HOSTS).toBe("127.0.0.1");
    const guard = at("scripts/k6-target-guard.mjs");
    expect(guard).toBeGreaterThan(-1);
    expect(runs[guard]).toContain('"$BASE_URL" "$K6_ALLOWED_HOSTS"');
    expect(guard).toBeLessThan(at("pnpm install"));
    expect(guard).toBeLessThan(at("bash scripts/perf-load.sh"));
    // script: đích dựng từ cổng loopback, chặn lần nữa trước khi cài k6/build/khởi động
    expect(lib).toMatch(/HM_BASE_URL="http:\/\/127\.0\.0\.1:\$\{HM_PORT\}"/);
    expect(sh).toMatch(/^export BASE_URL="\$HM_BASE_URL"$/m);
    const g = shAt('k6-target-guard.mjs" "$BASE_URL" "$K6_ALLOWED_HOSTS"');
    expect(g).toBeLessThan(shAt("--only k6"));
    expect(g).toBeLessThan(shAt("hm_build "));
    expect(g).toBeLessThan(shAt("hm_start_app "));
    // Không có domain thật nào trong workflow/script (QA-PERF-007: grep).
    for (const text of [read(".github/workflows/perf-nightly.yml"), sh, lib])
      expect(
        text.match(/https?:\/\/[^\s"']+/g)?.filter((u) => !/^http:\/\/127\.0\.0\.1/.test(u)) ?? [],
      ).toEqual([]);
  });

  it("app dựng như job e2e (Postgres service ghim digest, build production, seed giả); log server được quét PII; job có timeout", () => {
    expect(job.services.postgres.image).toMatch(/^postgres:17[.\d]*@sha256:[0-9a-f]{64}$/);
    expect(lib).toMatch(/pnpm --filter web build/);
    expect(lib).toMatch(/setsid node e2e\/server\.ts/);
    expect(lib).toMatch(/api\/health/);
    expect(shAt("node e2e/perf-session-env.ts")).toBeLessThan(shAt("k6 run"));
    // quét PII chạy cả khi k6 đỏ (k6_rc được giữ, kiểm sau quét)
    expect(shAt("pii-log-scan.mjs")).toBeGreaterThan(shAt("k6 run"));
    expect(shAt("pii-log-scan.mjs")).toBeLessThan(shAt('[ "$k6_rc" -eq 0 ]'));
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("k6 cài bản ghim + SHA-256 (dev-env-setup.sh --only k6), không tải 'latest'", () => {
    const setup = read("scripts/dev-env-setup.sh");
    expect(setup).toMatch(/^K6_VERSION="\d+\.\d+\.\d+"$/m);
    expect(setup).toMatch(/^K6_SHA256="[0-9a-f]{64}"$/m);
    expect(setup).toMatch(/sha256sum -c --quiet -\n[^\n]*\n[^\n]*k6/);
    expect(runs[at("--only k6")]).toBeTruthy();
    // script tự cài vào thư mục tạm khi chưa có k6 trên PATH
    expect(sh).toMatch(
      /DEV_ENV_OPT_DIR="\$k6_tmp\/opt" DEV_ENV_BIN_DIR="\$k6_tmp\/bin" bash "\$HM_ROOT\/scripts\/dev-env-setup\.sh" --only k6/,
    );
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
    // userinfo/?/# làm "host" trông như staging trong khi host thật là domain production.
    ["https://staging-x@example.com/", "staging-x@example.com", /không hợp lệ/],
    ["https://example.com?.staging.", "example.com?.staging.", /không hợp lệ/],
    ["https://example.com#.staging.", "example.com#.staging.", /không hợp lệ/],
    ["http://staging-x@127.0.0.1:18080", "staging-x@127.0.0.1", /không hợp lệ/],
  ])("chặn %s (cho phép %s)", (url, allowed, why) => expect(targetProblem(url, allowed)).toMatch(why));

  it("CLI: exit 0 với loopback, exit 1 với domain thật", () => {
    const run = (...a) =>
      spawnSync("node", [join(ROOT, "scripts/k6-target-guard.mjs"), ...a], { encoding: "utf8" }).status;
    expect(run("http://127.0.0.1:3100", "127.0.0.1")).toBe(0);
    expect(run("https://hotel.example.vn", "hotel.example.vn")).toBe(1);
  });
});
