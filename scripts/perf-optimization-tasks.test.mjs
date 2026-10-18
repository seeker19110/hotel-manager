// Điều kiện của `[~] LOOP-OPT-001…004 — Không áp dụng` (BLUEPRINT, D-074): PLAN chưa có task tối ưu hiệu năng (ngân sách hiệu
// năng trong CI đang xanh — docs/PERF-BUDGET.md). Rào đỏ khi PLAN thêm task tối ưu mà Gate không theo vòng của khung
// (.xtemplates/framework/11-autonomous-loop/optimization-loop.md): script Gate lấy từ commit gốc (`git show <base>:…`),
// `perf guard` khoá bộ đo, `perf compare` quyết giữ/hoàn tác. Khi đó bỏ `[~]` và tick LOOP-OPT-001…004 bằng bằng chứng thật.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPT = /tối ưu|optimi[sz]/i;

/** Task `T-NNN` có mô tả nói tới tối ưu hiệu năng: [{ id, line, gate }]. */
function optimizationTasks(plan) {
  return (
    plan
      .split("\n")
      .map((line) => ({ line, m: /^- \[[ x~]\] `(T-\d+)`(.*)$/.exec(line) }))
      // Dòng chỉ bàn về chính luật LOOP-OPT (như T-1001) không phải task tối ưu.
      .filter(({ m }) => m && OPT.test(m[2].split("— Gate:")[0]) && !/LOOP-OPT-\d/.test(m[2]))
      .map(({ m }) => ({ id: m[1], text: m[2].split("— Gate:")[0], gate: m[2].split("— Gate:")[1] ?? "" }))
  );
}

/** Lỗi của một task tối ưu so với vòng LOOP-OPT (rỗng = đạt). */
function optimizationTaskProblems(task) {
  const out = [];
  if (!/\d/.test(task.text.replace(/\b[A-Z]+-[A-Z]*-?\d+\b/g, "")))
    out.push(`${task.id}: thiếu mục tiêu số (LOOP-OPT-001)`);
  if (!/git show [^`\s]+:/.test(task.gate))
    out.push(`${task.id}: Gate không lấy script từ commit gốc (LOOP-OPT-002)`);
  if (!/perf guard/.test(task.gate) && !/git show/.test(task.gate))
    out.push(`${task.id}: Gate không khoá bộ đo bằng perf guard (LOOP-OPT-002)`);
  return out;
}

describe("LOOP-OPT — task tối ưu theo vòng do máy quyết", () => {
  const plan = readFileSync(join(ROOT, "docs/autopilot/PLAN.md"), "utf8");

  it("PLAN hiện chưa có task tối ưu hiệu năng (điều kiện của [~] LOOP-OPT-001…004)", () => {
    expect(optimizationTasks(plan).map((t) => t.id)).toEqual([]);
    const bp = readFileSync(join(ROOT, "BLUEPRINT.md"), "utf8");
    for (const id of ["LOOP-OPT-001", "LOOP-OPT-002", "LOOP-OPT-003", "LOOP-OPT-004"])
      expect(bp).toMatch(
        new RegExp(`^- \\[~\\] \`${id}\` .*Không áp dụng: .*perf-optimization-tasks\\.test\\.mjs`, "m"),
      );
  });

  it("nhận ra task tối ưu và đòi mục tiêu số + Gate từ commit gốc", () => {
    const bad = optimizationTasks("- [ ] `T-9001` Tối ưu trang phòng — Gate: `pnpm test`");
    expect(bad.map((t) => t.id)).toEqual(["T-9001"]);
    expect(optimizationTaskProblems(bad[0])).toEqual([
      "T-9001: thiếu mục tiêu số (LOOP-OPT-001)",
      "T-9001: Gate không lấy script từ commit gốc (LOOP-OPT-002)",
      "T-9001: Gate không khoá bộ đo bằng perf guard (LOOP-OPT-002)",
    ]);
    const good = optimizationTasks(
      "- [ ] `T-9002` Tối ưu /phong: p95 TTFB 800 → 500 ms — Gate: `bash <(git show origin/main:scripts/perf-gate.sh)`",
    );
    expect(optimizationTaskProblems(good[0])).toEqual([]);
    expect(optimizationTasks("- [x] `T-9003` Thêm báo cáo công nợ — Gate: `pnpm test`")).toEqual([]);
    expect(optimizationTasks("- [x] `T-9004` LOOP-OPT-001: luật task tối ưu — Gate: `pnpm test`")).toEqual(
      [],
    );
  });
});
