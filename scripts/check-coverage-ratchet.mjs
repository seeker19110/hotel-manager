#!/usr/bin/env node
// Ratchet coverage (QA-COV-002, QA-COV-008; PLAN đợt 9 T-805). So `coverage.thresholds`/`coverage.exclude` của vitest.config.ts
// ở nhánh PR với bản ở nhánh gốc:
//   - ngưỡng (lines/branches/functions/statements) bị HẠ hoặc bị XOÁ → luôn đỏ (không có miễn trừ — baseline chỉ tăng);
//   - `include` bị bớt mục (thu hẹp phạm vi đo) → luôn đỏ; ngưỡng không phải số literal (`94.8 - 90`) hoặc include/exclude
//     không phải chuỗi literal thuần → đỏ (không so được thì không tin được);
//   - workflow/script có cờ `--coverage.thresholds|exclude|include` ở dòng lệnh (ghi đè cấu hình ngoài vitest.config) → đỏ;
//   - `exclude` có mục MỚI (thu hẹp phạm vi đo để "cho xanh") → đỏ, trừ khi mô tả PR có dòng
//     `Coverage-config: <lý do ≥ 12 ký tự>` (đọc từ --body-file).
// Dùng: node scripts/check-coverage-ratchet.mjs --base origin/main [--body-file pr.md]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const METRICS = ["lines", "branches", "functions", "statements"];

/** Bỏ chú thích dòng và chú thích khối nhưng giữ nguyên chuỗi (", ', `) — mã bị comment-out không được tính là cấu hình. */
export function stripComments(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Lấy khối cân ngoặc bắt đầu sau `key:` đầu tiên trong `text` (bỏ qua ngoặc nằm trong chuỗi); không có → null. */
function block(text, key, open, close) {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\${open}`).exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      while (++i < text.length && text[i] !== c) if (text[i] === "\\") i++;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(m.index + m[0].length, i);
  }
  return null;
}

/** Tách thân khối thành các phần tử cấp 0 (cắt ở dấu phẩy ngoài chuỗi/ngoặc). */
function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === "\\" ? 2 : 1;
      cur += body.slice(i, j + 1);
      i = j;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}

const NUMBER = /^\d+(?:\.\d+)?$/;
const STRING = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)$/;

/** Mảng chuỗi literal; phần tử không phải chuỗi literal thuần (nối chuỗi, biến, spread, `${}`) vào `invalid`. */
function stringList(body, label, invalid) {
  const out = [];
  for (const item of splitTop(body ?? "")) {
    const m = STRING.exec(item);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
    else invalid.push(`${label}: ${item}`);
  }
  return out;
}

/**
 * → { thresholds: {metric: number}, exclude: string[], include: string[], invalid: string[] } từ nguồn vitest.config.ts
 * (chỉ phần `coverage`). `invalid` = giá trị ngưỡng không phải số literal / phần tử include|exclude không phải chuỗi literal.
 */
export function parseCoverageConfig(source) {
  const cov = block(stripComments(source), "coverage", "{", "}") ?? "";
  const th = block(cov, "thresholds", "{", "}") ?? "";
  const thresholds = {};
  const invalid = [];
  for (const item of splitTop(th)) {
    const m = /^(\w+)\s*:\s*([\s\S]*)$/.exec(item);
    if (!m || !METRICS.includes(m[1])) continue;
    if (NUMBER.test(m[2].trim())) thresholds[m[1]] = Number(m[2].trim());
    else invalid.push(`ngưỡng ${m[1]}: ${m[2].trim()}`);
  }
  const exclude = stringList(block(cov, "exclude", "[", "]"), "exclude", invalid);
  const include = stringList(block(cov, "include", "[", "]"), "include", invalid);
  return { thresholds, exclude, include, invalid };
}

/** Cờ dòng lệnh ghi đè cấu hình coverage (`--coverage.thresholds…`, `--coverage.exclude`, `--coverage.include`). */
export const COVERAGE_CLI_OVERRIDE = /--coverage\.(?:thresholds|exclude|include)\b/;

/** Danh sách dòng (1-based) của `text` có cờ ghi đè coverage ở dòng lệnh. */
export function coverageCliOverrides(text) {
  return text.split("\n").flatMap((line, i) => (COVERAGE_CLI_OVERRIDE.test(line) ? [i + 1] : []));
}

/** Danh sách vi phạm (chuỗi tiếng Việt); rỗng = đạt. */
export function compareCoverageConfig(base, head, body = "") {
  const problems = [];
  for (const bad of head.invalid ?? [])
    problems.push(`không phải giá trị literal (số/chuỗi thuần) nên không so được: ${bad}`);
  for (const metric of METRICS) {
    const b = base.thresholds[metric];
    const h = head.thresholds[metric];
    if (b === undefined) continue;
    if (h === undefined) {
      if (!(head.invalid ?? []).some((x) => x.startsWith(`ngưỡng ${metric}:`)))
        problems.push(`ngưỡng ${metric} bị xoá (nền ${b})`);
    } else if (h < b) problems.push(`ngưỡng ${metric} bị hạ ${b} → ${h} (baseline chỉ được tăng)`);
  }
  for (const metric of METRICS) {
    if (
      head.thresholds[metric] === undefined &&
      !(head.invalid ?? []).some((x) => x.startsWith(`ngưỡng ${metric}:`))
    )
      problems.push(`thiếu ngưỡng ${metric} (cần số, vd ${metric}: 80)`);
  }
  // Thu hẹp phạm vi đo: bớt `include` luôn đỏ (không miễn trừ); thêm `exclude` đỏ trừ khi PR có lý do.
  const dropped = (base.include ?? []).filter((e) => !(head.include ?? []).includes(e));
  if (dropped.length > 0)
    problems.push(`include bị thu hẹp (bỏ ${dropped.join(", ")}) — phạm vi đo chỉ được mở rộng`);
  const added = head.exclude.filter((e) => !base.exclude.includes(e));
  if (added.length > 0) {
    const waiver = /^Coverage-config:\s*(\S.{11,})$/m.exec(body);
    if (!waiver)
      problems.push(
        `exclude có mục mới (${added.join(", ")}) mà mô tả PR không có "Coverage-config: <lý do>"`,
      );
  }
  return problems;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseRef = arg("--base");
  if (!baseRef) {
    process.stderr.write("thiếu --base <ref>\n");
    return 2;
  }
  const bodyFile = arg("--body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : "";
  const head = parseCoverageConfig(readFileSync("vitest.config.ts", "utf8"));
  let base;
  try {
    base = parseCoverageConfig(
      execFileSync("git", ["show", `${baseRef}:vitest.config.ts`], { encoding: "utf8" }),
    );
  } catch {
    process.stdout.write(`nền ${baseRef} chưa có vitest.config.ts — bỏ qua so sánh\n`);
    return 0;
  }
  const problems = compareCoverageConfig(base, head, body);
  for (const dir of [".github/workflows"]) {
    for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      for (const line of coverageCliOverrides(readFileSync(`${dir}/${name}`, "utf8")))
        problems.push(
          `${dir}/${name}:${line} ghi đè coverage bằng cờ dòng lệnh (--coverage.thresholds|exclude|include)`,
        );
    }
  }
  for (const p of problems) process.stderr.write(`::error::coverage ratchet: ${p}\n`);
  if (problems.length === 0)
    process.stdout.write(`coverage ratchet OK (${JSON.stringify(head.thresholds)})\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
