// Đối chiếu scenario S-NNN trong docs/specs/SPEC-*.md ↔ test (PM-SPEC-004, WF-SDD-003). Báo cáo độ phủ; không phụ thuộc thư viện.
// Dùng: `node scripts/spec-coverage.mjs` (in bảng phủ theo spec). Test ratchet: scripts/process-docs.test.mjs + spec-coverage.baseline.json.
// Quy tắc "test nhắc S-NNN của spec X": trong file test, S-NNN nằm cùng dòng (hoặc dòng kế nếu dòng đó chưa có ID) sau một chuỗi `SPEC-<bí danh X>`,
// hoặc file chỉ nhắc đúng một spec. Khoảng `S-002…S-004` được trải ra. Đây là heuristic trên tên/comment test — không chứng minh test đúng.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Bí danh trong comment test: phần đầu của tên spec (ledger-payments → ledger). */
export const aliasOf = (name) => name.split("-")[0];

/** Scenario `### S-NNN` của một spec. */
export function scenarios(md) {
  return [...new Set([...md.matchAll(/^### (S-\d{3})\b/gm)].map((m) => m[1]))].sort();
}

/** Trải `S-002…S-004` thành S-002, S-003, S-004; còn lại lấy token S-NNN rời. */
export function expandIds(text) {
  const out = new Set();
  const fmt = (n) => `S-${String(n).padStart(3, "0")}`;
  for (const m of text.matchAll(/\bS-(\d{3})\s*(?:…|\.\.\.)\s*S-(\d{3})\b/g)) {
    for (let n = Number(m[1]); n <= Number(m[2]) && n - Number(m[1]) < 60; n++) out.add(fmt(n));
  }
  for (const m of text.matchAll(/\bS-\d{3}\b/g)) out.add(m[0]);
  return out;
}

/** ID của spec `name` được nhắc trong một file test (nội dung `src`), `names` = mọi spec. */
export function mentioned(src, name, names) {
  const alias = aliasOf(name);
  const aliasRe = new RegExp(`SPEC-${alias}\\b`, "g");
  const specsHere = names.filter((n) => new RegExp(`SPEC-${aliasOf(n)}\\b`).test(src));
  const out = new Set();
  if (specsHere.length === 1 && specsHere[0] === name) for (const id of expandIds(src)) out.add(id);
  for (const m of src.matchAll(aliasRe)) {
    const from = m.index ?? 0;
    const lines = src.slice(from).split("\n");
    // Cùng dòng; không có S-NNN ở dòng đó thì lấy thêm dòng kế (comment ngắt dòng). Dừng ở lần nhắc spec khác.
    let window = lines[0] ?? "";
    if (!/\bS-\d{3}\b/.test(window)) window += `\n${lines[1] ?? ""}`;
    const other = window.slice(5).search(/SPEC-[a-z]/);
    if (other !== -1) window = window.slice(0, other + 5);
    for (const id of expandIds(window)) out.add(id);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const SELF = new Set(["scripts/process-docs.test.mjs"]);

/** Các file test của repo (đường dẫn tương đối ROOT). */
export function testFiles(root = ROOT) {
  const out = [];
  for (const top of ["packages", "apps", "scripts"]) {
    for (const f of walk(join(root, top))) {
      const rel = relative(root, f).split("\\").join("/");
      if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(rel) && !SELF.has(rel)) out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Độ phủ: { [spec]: { total, covered: [..], uncovered: [..], status } } — `status` đọc từ frontmatter/bảng của spec.
 * @param {string} root
 */
export function coverage(root = ROOT) {
  const specDir = join(root, "docs/specs");
  const files = readdirSync(specDir).filter((f) => /^SPEC-.*\.md$/.test(f));
  const names = files.map((f) => f.slice(5, -3));
  const sources = testFiles(root).map((f) => readFileSync(join(root, f), "utf8"));
  const report = {};
  for (const name of names) {
    const md = readFileSync(join(specDir, `SPEC-${name}.md`), "utf8");
    const ids = scenarios(md);
    const hit = new Set();
    for (const src of sources) for (const id of mentioned(src, name, names)) hit.add(id);
    const status = /^status:\s*(\S+)/m.exec(md)?.[1] ?? "";
    report[name] = {
      total: ids.length,
      covered: ids.filter((i) => hit.has(i)),
      uncovered: ids.filter((i) => !hit.has(i)),
      status,
    };
  }
  return report;
}

if (process.argv[1] && dirname(process.argv[1]) === dirname(fileURLToPath(import.meta.url))) {
  const rep = coverage();
  let total = 0;
  let covered = 0;
  for (const [name, r] of Object.entries(rep)) {
    total += r.total;
    covered += r.covered.length;
    const pct = r.total ? Math.round((100 * r.covered.length) / r.total) : 100;
    process.stdout.write(
      `${name.padEnd(28)} ${String(r.covered.length).padStart(3)}/${String(r.total).padEnd(3)} ${String(pct).padStart(3)}%  chưa truy được: ${r.uncovered.join(" ") || "—"}\n`,
    );
  }
  process.stdout.write(`${"TỔNG".padEnd(28)} ${covered}/${total} ${Math.round((100 * covered) / total)}%\n`);
}
