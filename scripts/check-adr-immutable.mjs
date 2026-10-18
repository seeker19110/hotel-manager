// ARC-ADR-004: ADR đã `accepted` ở nhánh gốc không được sửa nội dung — chỉ đổi được dòng trạng thái và dòng "superseded by".
// Dùng (CI job `pr-policy`, `fetch-depth: 0`): `node scripts/check-adr-immutable.mjs --base origin/main`. Test: scripts/history-guards.test.mjs.
import { argValue, changedEntries, git, isMain, refExists, showAt } from "./git-history.mjs";

export const ADR_DIR = "docs/adr";
/**
 * Dòng được phép đổi ở ADR accepted — khớp CẢ DÒNG, không khớp chuỗi con:
 * - khoá frontmatter `status:` / `implementation-status:` / `superseded-by:` (chỉ trong khối `---` đầu file nếu ADR có frontmatter);
 * - dòng liên kết bắt đầu bằng "Bị thay bởi ADR-…" / "Superseded by ADR-…" (cho phép tiền tố trích dẫn `> `).
 */
const ALLOWED_KEY = /^\s*(?:status|implementation-status|superseded-by)\s*:/i;
const ALLOWED_LINK = /^\s*(?:>\s*)?(?:Bị thay bởi|Superseded by) ADR-/i;
/** Trạng thái hợp lệ sau khi đã accepted (không lùi về proposed/draft). */
const AFTER_ACCEPTED = /^(?:accepted|superseded|deprecated|rejected)\b/i;

/** Giá trị `status` trong frontmatter (hoặc dòng `Status:`), chữ thường; không có → null. */
export function statusOf(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const scope = fm ? fm[1] : text;
  const m = /^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(.+)$/im.exec(scope);
  return m ? m[1].trim().toLowerCase() : null;
}

export const isAccepted = (status) => status !== null && /^accepted\b/.test(status);

/** Dải dòng (1-based, gồm hai đầu, kể cả hai dòng `---`) của frontmatter trong `text`; không có frontmatter → null. */
export function frontmatterRange(text) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end === -1 ? null : { lo: 1, hi: end + 1 };
}

/**
 * Các dòng thêm/bớt trong diff `-U0`: [{ sign: "+"|"-", text, line }] (`line` = số dòng 1-based ở bên cũ/mới).
 * Header (`diff --git`, `---`, `+++`, `index`…) nhận biết theo VỊ TRÍ — mọi thứ trước hunk `@@` đầu tiên —
 * nên dòng nội dung bắt đầu bằng `--`/`++` (vd. xoá dòng `-- ghi chú`, diff hiện `--- ghi chú`) vẫn được tính.
 */
export function changedLines(diff) {
  const out = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
    } else if (inHunk && l.startsWith("-")) out.push({ sign: "-", text: l.slice(1), line: oldNo++ });
    else if (inHunk && l.startsWith("+")) out.push({ sign: "+", text: l.slice(1), line: newNo++ });
  }
  return out;
}

/** Dòng đổi có thuộc nhóm được phép (xem ALLOWED_KEY/ALLOWED_LINK) không. `ranges` = dải frontmatter của bản cũ/mới. */
function isAllowedChange(c, ranges) {
  if (c.text.trim() === "") return true;
  if (ALLOWED_LINK.test(c.text)) return true;
  if (!ALLOWED_KEY.test(c.text)) return false;
  const range = c.sign === "-" ? ranges.base : ranges.head;
  return range === null || (c.line >= range.lo && c.line <= range.hi);
}

/**
 * @param {{ path: string, baseText: string, headText: string | null, diff: string }} input
 * @returns {string[]} vi phạm của một ADR (rỗng = đạt hoặc ADR chưa accepted)
 */
export function findAdrViolations({ path, baseText, headText, diff }) {
  if (!isAccepted(statusOf(baseText))) return [];
  if (headText === null) return [`${path}: ADR đã accepted không được xoá — đánh dấu superseded/deprecated`];
  const violations = [];
  const next = statusOf(headText);
  if (next === null || !AFTER_ACCEPTED.test(next)) {
    violations.push(
      `${path}: ADR đã accepted chỉ được chuyển sang accepted/superseded/deprecated/rejected (nay: ${next ?? "thiếu status"})`,
    );
  }
  const ranges = { base: frontmatterRange(baseText), head: frontmatterRange(headText) };
  const bad = changedLines(diff)
    .filter((c) => !isAllowedChange(c, ranges))
    .map((c) => c.text);
  if (bad.length) {
    violations.push(
      `${path}: ADR đã accepted bị sửa nội dung (${bad.length} dòng, vd ${JSON.stringify(bad[0].slice(0, 60))}) — chỉ được đổi dòng status/superseded; quyết định mới = ADR mới`,
    );
  }
  return violations;
}

export function checkAgainst(base, cwd) {
  const violations = [];
  for (const { status, path } of changedEntries(base, [ADR_DIR], cwd)) {
    if (status === "A" || !path.endsWith(".md")) continue;
    const baseText = showAt(base, path, cwd);
    if (baseText === null) continue;
    const headText = status === "D" ? null : (showAt("HEAD", path, cwd) ?? null);
    const diff =
      headText === null ? "" : git(["diff", "-U0", "--no-color", `${base}...HEAD`, "--", path], cwd);
    violations.push(...findAdrViolations({ path, baseText, headText, diff }));
  }
  return violations;
}

function main() {
  const base = argValue(process.argv, "--base", "origin/main");
  if (!refExists(base)) {
    process.stderr.write(`không thấy nhánh gốc '${base}' — checkout cần fetch-depth: 0\n`);
    return 2;
  }
  const violations = checkAgainst(base);
  for (const v of violations) process.stderr.write(`✗ ${v}\n`);
  process.stdout.write(
    violations.length
      ? `${violations.length} vi phạm bất biến ADR.\n`
      : `✓ ADR accepted ở ${base} không bị sửa nội dung.\n`,
  );
  return violations.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
