// XC-GREEN-002 — mọi tài nguyên có ngân sách, vượt = đỏ: kích thước image container (job image-scan), số job và thời gian CI mỗi
// PR (khoá ở đây trên chính các workflow). Trang/bundle đã có: perf/budgets.json (perf-budget.test.mjs), .size-limit.json,
// lighthouserc.json. Nguồn số đo + cách nới: perf/resource-budgets.json, docs/PERF-BUDGET.md.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkImageSize } from "./check-image-size.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const budgets = JSON.parse(read("perf/resource-budgets.json"));
const supply = parse(read(".github/workflows/supply-chain.yml"));
const matrix = supply.jobs["image-scan"].strategy.matrix.include;

describe("ngân sách kích thước image", () => {
  it("mọi image của image-scan có ngân sách > số đo, biên ≤ 30%", () => {
    expect(Object.keys(budgets.images).sort()).toEqual(matrix.map((m) => m.name).sort());
    for (const [name, b] of Object.entries(budgets.images)) {
      expect(b.max_mb, name).toBeGreaterThan(b.measured_mb);
      expect(b.max_mb / b.measured_mb, name).toBeLessThanOrEqual(1.3);
    }
  });

  it("kiểm: trong ngân sách → ok; vượt 1 byte → đỏ; image lạ hoặc kích thước rác → đỏ", () => {
    expect(checkImageSize("caddy", 80e6).ok).toBe(true);
    expect(checkImageSize("caddy", 80e6 + 1)).toMatchObject({
      ok: false,
      message: expect.stringContaining("VƯỢT"),
    });
    expect(checkImageSize("redis", 1).ok).toBe(false);
    for (const bad of [Number.NaN, 0, -1]) expect(checkImageSize("caddy", bad).ok).toBe(false);
  });

  it("CLI: exit 0 trong ngân sách, exit 1 khi vượt", () => {
    const run = (...a) =>
      spawnSync("node", [join(ROOT, "scripts/check-image-size.mjs"), ...a], { encoding: "utf8" }).status;
    expect(run("postgres", String(450e6))).toBe(0);
    expect(run("postgres", String(551e6))).toBe(1);
  });

  it("job image-scan đo bằng docker image inspect rồi kiểm ngân sách TRƯỚC khi quét", () => {
    const steps = supply.jobs["image-scan"].steps;
    const i = steps.findIndex((s) => String(s.run ?? "").includes("scripts/check-image-size.mjs"));
    expect(i).toBeGreaterThan(-1);
    expect(steps[i].run).toContain(`docker image inspect --format '{{.Size}}' "$IMAGE_REF"`);
    const expr = (name) => ["$", `{{ matrix.${name} }}`].join("");
    expect(steps[i].env).toMatchObject({ IMAGE_NAME: expr("name"), IMAGE_REF: expr("ref") });
    const scan = steps.findIndex((s) => String(s.uses ?? "").startsWith("anchore/scan-action"));
    expect(i).toBeLessThan(scan);
  });
});

describe("ngân sách CI mỗi PR", () => {
  const prJobs = readdirSync(join(ROOT, ".github/workflows"))
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => {
      const wf = parse(read(`.github/workflows/${f}`));
      const on = wf.on ?? wf[true] ?? {};
      if (!("pull_request" in on) && !("pull_request_target" in on)) return [];
      // Job hoãn tới harden (D-085: `if` chỉ workflow_dispatch) không chạy trên PR — không tính vào ngân sách PR.
      return Object.entries(wf.jobs)
        .filter(([, j]) => String(j.if ?? "").trim() !== "github.event_name == 'workflow_dispatch'")
        .map(([id, j]) => ({
          id: `${f}:${id}`,
          runs: j.strategy?.matrix?.include?.length ?? 1,
          timeout: j["timeout-minutes"],
        }));
    });
  const ci = budgets.ci_per_pr;

  it("mọi job chạy trên PR có timeout-minutes ≤ trần một job", () => {
    for (const j of prJobs) {
      expect(j.timeout, j.id).toBeGreaterThan(0);
      expect(j.timeout, j.id).toBeLessThanOrEqual(ci.max_job_timeout_min);
    }
  });

  it("số job (tính cả matrix) và tổng timeout mỗi PR trong ngân sách", () => {
    const jobs = prJobs.reduce((n, j) => n + j.runs, 0);
    const total = prJobs.reduce((n, j) => n + j.runs * j.timeout, 0);
    expect(jobs).toBeLessThanOrEqual(ci.max_jobs);
    expect(total).toBeLessThanOrEqual(ci.max_total_timeout_min);
    expect(jobs).toBeGreaterThanOrEqual(ci.measured_jobs); // số đo ghi trong file phải còn đúng (không âm thầm cũ)
  });

  it("tài liệu ngân sách nêu cả image và CI, trỏ tới file số", () => {
    const doc = read("docs/PERF-BUDGET.md");
    expect(doc).toMatch(/## Ngân sách tài nguyên/);
    expect(doc).toContain("perf/resource-budgets.json");
  });
});
