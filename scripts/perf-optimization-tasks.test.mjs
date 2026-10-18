// Điều kiện của `[~] LOOP-OPT-001…004 — Không áp dụng` (BLUEPRINT, D-074): PLAN chưa có task tối ưu hiệu năng (ngân sách hiệu
// năng trong CI đang xanh — docs/PERF-BUDGET.md). Rào đỏ khi PLAN có task tối ưu: khi đó bỏ `[~]`, và task phải theo vòng của
// khung (.xtemplates/framework/11-autonomous-loop/optimization-loop.md) — test liệt kê chỗ thiếu: mục tiêu số có đơn vị,
// script Gate lấy từ commit gốc (`git show <base>:…`), `perf guard --base … --locked …`, `perf compare`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Cách gọi VIỆC LÀM NHANH/NHẸ HƠN (động từ cải thiện, tiếng Việt có/không dấu, tiếng Anh) + Gate dùng công cụ chấm của khung.
// Task chỉ DỰNG/ĐO ngân sách (k6, Lighthouse, ngân sách image — T-608, T-704, T-905, T-906) không phải task tối ưu.
const OPT = new RegExp(
  [
    "tối ưu",
    "toi uu",
    "optimi[sz]",
    "tăng tốc",
    "tang toc",
    "nhanh hơn",
    "speed ?up",
    "cải thiện (hiệu năng|tốc độ|thời gian|độ trễ)",
    "giảm (thời gian|kích thước|dung lượng|bundle|bộ nhớ|số truy vấn|độ trễ|latency|p9\\d|TTFB)",
    "truy vấn chậm",
    "\\bN\\+1\\b",
    "(^|\\s)perf[(:]",
    "perf (compare|guard|sample)",
    "perf-gate",
  ].join("|"),
  "i",
);
// ID mục blueprint (`XC-PERF-003`, `QA-PERF-002`…) không phải từ mô tả.
const BLUEPRINT_ID = /\b[A-Z]+-[A-Z]+-\d+\b/g;
// Task chỉ bàn về chính luật LOOP-OPT (không phải task tối ưu) — loại đúng ID, không loại theo nội dung.
const RULE_TASKS = new Set(["T-1001"]);
const TARGET = /\d[\d.,]*\s*(ms|s|giây|KB|MB|GB|%|×|x|req\/s|truy vấn)(?![\p{L}])|→/iu;

function optimizationTasks(plan) {
  return plan
    .normalize("NFC")
    .split("\n")
    .map((line) => /^- \[[ x~]\] `(T-\d+)`(.*)$/.exec(line))
    .filter((m) => m && !RULE_TASKS.has(m[1]) && OPT.test(m[2].replace(BLUEPRINT_ID, "")))
    .map((m) => ({ id: m[1], text: m[2].split("— Gate:")[0], gate: m[2].split("— Gate:")[1] ?? "" }));
}

/** Script Gate lấy từ commit gốc: nội dung bản trong cây hiện tại (đã merge vào gốc) để kiểm có perf guard/compare. */
function gateScript(gate) {
  const m = /git show [^`\s:]+:([^`\s)]+)/.exec(gate);
  if (!m) return null;
  const p = join(ROOT, m[1]);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Chỗ thiếu của một task tối ưu so với LOOP-OPT-001/002/003 (rỗng = đúng vòng). */
function optimizationTaskProblems(task) {
  const out = [];
  if (!TARGET.test(task.text)) out.push(`${task.id}: thiếu mục tiêu số có đơn vị (LOOP-OPT-001)`);
  const script = gateScript(task.gate);
  if (script === null) out.push(`${task.id}: Gate không lấy script từ commit gốc (LOOP-OPT-002)`);
  const body = `${task.gate}\n${script ?? ""}`;
  if (!/perf guard\b[^\n]*--base[^\n]*--locked/.test(body))
    out.push(`${task.id}: thiếu perf guard --base … --locked … (LOOP-OPT-002)`);
  if (!/perf compare\b/.test(body)) out.push(`${task.id}: thiếu perf compare (LOOP-OPT-001/003)`);
  return out;
}

describe("LOOP-OPT — task tối ưu theo vòng do máy quyết", () => {
  const plan = readFileSync(join(ROOT, "docs/autopilot/PLAN.md"), "utf8");

  it("PLAN chưa có task tối ưu hiệu năng (điều kiện của [~] LOOP-OPT-001…004); có thì bỏ [~] và theo vòng", () => {
    const tasks = optimizationTasks(plan);
    expect(
      tasks.map((t) => ({ id: t.id, thieu: optimizationTaskProblems(t) })),
      "PLAN có task tối ưu: bỏ [~] LOOP-OPT-001…004, tick bằng bằng chứng thật, sửa test này",
    ).toEqual([]);
    const bp = readFileSync(join(ROOT, "BLUEPRINT.md"), "utf8");
    for (const id of ["LOOP-OPT-001", "LOOP-OPT-002", "LOOP-OPT-003", "LOOP-OPT-004"])
      expect(bp).toMatch(
        new RegExp(`^- \\[~\\] \`${id}\` .*Không áp dụng: .*perf-optimization-tasks\\.test\\.mjs`, "m"),
      );
  });

  it("nhận ra các cách gọi task tối ưu (kể cả không dấu, NFD); loại đúng ID task bàn về luật, không loại theo chữ", () => {
    for (const s of [
      "Tối ưu trang phòng",
      "Tối ưu".normalize("NFD"),
      "Toi uu truy van",
      "Giảm thời gian tải /phong",
      "Tăng tốc truy vấn",
      "Nhanh hơn 2x",
      "perf: cache",
      "Giảm bundle 50 KB",
      "Giảm p95",
      "Cải thiện hiệu năng trang phòng",
      "Sửa truy vấn chậm",
      "Bỏ N+1 query",
      "Tối ưu XC-PERF-003 cho /phong",
      "Tối ưu trang phòng, xem LOOP-OPT-001",
    ])
      expect(optimizationTasks(`- [ ] \`T-9001\` ${s} — Gate: \`pnpm test\``), s).toHaveLength(1);
    expect(optimizationTasks("- [x] `T-1001` LOOP-OPT-001…004: vòng tối ưu — Gate: `pnpm test`")).toEqual([]);
    for (const s of [
      "Thêm báo cáo công nợ",
      "Ngân sách hiệu năng: unit test thêm 200 KB phải đỏ (XC-PERF-003)",
      "Load test tự động: k6 thresholds p95/tỷ lệ lỗi (QA-PERF-002)",
    ])
      expect(optimizationTasks(`- [x] \`T-9003\` ${s} — Gate: \`pnpm test\``), s).toEqual([]);
  });

  it("task tối ưu: đòi mục tiêu số có đơn vị, script Gate từ commit gốc, perf guard --base --locked và perf compare", () => {
    const [bad] = optimizationTasks("- [ ] `T-9001` Tối ưu v2 trang phòng — Gate: `pnpm test`");
    expect(optimizationTaskProblems(bad)).toEqual([
      "T-9001: thiếu mục tiêu số có đơn vị (LOOP-OPT-001)",
      "T-9001: Gate không lấy script từ commit gốc (LOOP-OPT-002)",
      "T-9001: thiếu perf guard --base … --locked … (LOOP-OPT-002)",
      "T-9001: thiếu perf compare (LOOP-OPT-001/003)",
    ]);
    const [noGuard] = optimizationTasks(
      "- [ ] `T-9002` Tối ưu /phong: p95 800 → 500 ms — Gate: `bash <(git show origin/main:scripts/khong-co.sh)`",
    );
    expect(optimizationTaskProblems(noGuard)).toEqual([
      "T-9002: thiếu perf guard --base … --locked … (LOOP-OPT-002)",
      "T-9002: thiếu perf compare (LOOP-OPT-001/003)",
    ]);
    const [good] = optimizationTasks(
      "- [ ] `T-9004` Tối ưu /phong: p95 800 → 500 ms — Gate: `bash <(git show origin/main:x.sh) && python3 xt.py perf guard --base origin/main --locked 'perf/**' && python3 xt.py perf compare a.json b.json`",
    );
    expect(optimizationTaskProblems(good)).toEqual([]);
  });
});
