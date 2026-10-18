// Kiểm HẠN các ngoại lệ trong `.grype.yaml` (T-802, D-067, docs/ops/VULN-SLA.md): chạy ở job `image-scan` của supply-chain.yml
// (mỗi PR + hằng tuần) — KHÔNG ở unit test, vì cổng unit không được phụ thuộc ngày chạy.
// Mỗi luật phải: có "hạn rà lại: YYYY-MM-DD" hợp lệ · chưa quá hạn · không xa quá 30 ngày kể từ hôm nay (mã Critical ở bảng
// "Theo dõi" của VULN-SLA.md: ≤ 7 ngày) · mã nằm ở bảng "Theo dõi".
// Không phụ thuộc gói ngoài (job image-scan không cài pnpm): `.grype.yaml` có cấu trúc cố định nên đọc bằng bộ phân tích tối giản,
// gặp dòng lạ thì báo lỗi thay vì đoán.
//   node scripts/grype-ignore-check.mjs [--today YYYY-MM-DD] [--config .grype.yaml] [--sla docs/ops/VULN-SLA.md]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAX_DAYS = 30;
export const MAX_DAYS_CRITICAL = 7;
const MS_PER_DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^(GO-\d{4}-\d+|CVE-\d{4}-\d+|GHSA(-[a-z0-9]{4}){3})$/;

/** Ngày UTC hiện tại dạng YYYY-MM-DD. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** YYYY-MM-DD hợp lệ thật (loại 2026-02-30) → số ngày kể từ epoch; không hợp lệ → null. */
export function dayNumber(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t / MS_PER_DAY;
}

function scalar(raw) {
  const v = raw.trim();
  return v.startsWith('"') ? JSON.parse(v) : v;
}

/**
 * Đọc phần `ignore:` của .grype.yaml (cấu trúc: `- vulnerability`, `reason`, `package: {name, version, type, location}`).
 * @returns {{vulnerability: string, reason: string, package: Record<string,string>}[]}
 */
export function parseGrypeIgnore(text) {
  const rules = [];
  let cur = null;
  let inPkg = false;
  let seenIgnore = false;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.trimStart().startsWith("#")) return;
    const bad = () => new Error(`.grype.yaml dòng ${i + 1}: cấu trúc không nhận ra: ${line}`);
    if (line === "ignore:") {
      seenIgnore = true;
      return;
    }
    if (!seenIgnore) throw bad();
    let m = /^ {2}- (\w+): (.+)$/.exec(line);
    if (m) {
      if (m[1] !== "vulnerability") throw bad();
      cur = { vulnerability: scalar(m[2]), package: {} };
      rules.push(cur);
      inPkg = false;
      return;
    }
    if (!cur) throw bad();
    if (line === "    package:") {
      inPkg = true;
      return;
    }
    m = /^ {4}(\w+): (.+)$/.exec(line);
    if (m) {
      cur[m[1]] = scalar(m[2]);
      inPkg = false;
      return;
    }
    m = /^ {6}(\w+): (.+)$/.exec(line);
    if (m && inPkg) {
      cur.package[m[1]] = scalar(m[2]);
      return;
    }
    throw bad();
  });
  return rules;
}

/**
 * Bảng "Theo dõi" của VULN-SLA.md → Map mã → "critical" | "high" | "unknown" (đã theo dõi nhưng bảng không ghi mức).
 * Bảng viết gọn: `GO-2026-6612 (Critical), GO-2026-6604 (Critical)` hoặc `GO-2026-6603, 6605, 6607 (High)` (số trần thừa
 * tiền tố GO-năm của mã đầy đủ đứng trước trong cùng ô). Một mã xuất hiện nhiều dòng → lấy mức cao nhất.
 */
export function parseTracked(sla) {
  const at = sla.indexOf("## Theo dõi");
  const tracked = new Map();
  if (at < 0) return tracked;
  const rank = { unknown: 0, high: 1, critical: 2 };
  const put = (id, level) => {
    if (!tracked.has(id) || rank[level] > rank[tracked.get(id)]) tracked.set(id, level);
  };
  for (const row of sla.slice(at).split("\n")) {
    if (!row.startsWith("|")) continue;
    const cell = row.split("|")[2] ?? "";
    // Mỗi đoạn kết thúc bằng "(Mức)"; phần đuôi không có "(Mức)" là mức không rõ.
    for (const seg of cell.match(/[^()]*?(?:\((?:Critical|High|Medium|Low)\)|$)/gi) ?? []) {
      const level = /\((Critical|High|Medium|Low)\)/i.exec(seg)?.[1].toLowerCase() ?? "unknown";
      let prefix = "";
      for (const tok of seg.match(/GO-\d{4}-\d+|CVE-\d{4}-\d+|GHSA(?:-[a-z0-9]{4}){3}|\b\d{3,}\b/g) ?? []) {
        if (/^\d+$/.test(tok)) {
          if (prefix) put(`${prefix}${tok}`, level);
        } else {
          prefix = /^GO-\d{4}-/.exec(tok)?.[0] ?? "";
          put(tok, level);
        }
      }
    }
  }
  return tracked;
}

/**
 * @param {{rules: ReturnType<typeof parseGrypeIgnore>, sla: string, today: string}} p
 * @returns {string[]} danh sách lỗi (rỗng = ổn)
 */
export function checkGrypeIgnore({ rules, sla, today }) {
  const errors = [];
  const t = dayNumber(today);
  if (t === null) return [`--today không hợp lệ: ${today} (cần YYYY-MM-DD)`];
  if (rules.length === 0)
    return ["`.grype.yaml` không có luật ignore nào (gỡ cả tệp nếu không còn ngoại lệ)"];
  const tracked = parseTracked(sla);
  for (const r of rules) {
    const id = r.vulnerability;
    const where = `${id} (${r.package?.name ?? "?"} ${r.package?.version ?? "?"})`;
    if (!ID_RE.test(id ?? "")) errors.push(`${where}: mã lỗ hổng không hợp lệ`);
    for (const f of ["name", "version", "type"])
      if (!r.package?.[f]) errors.push(`${where}: thiếu package.${f} (cấm bỏ qua cả gói)`);
    const dueStr = /hạn rà lại: (\d{4}-\d{2}-\d{2})/.exec(r.reason ?? "")?.[1];
    const level = tracked.get(id);
    if (!tracked.has(id)) errors.push(`${where}: chưa có trong bảng "Theo dõi" của docs/ops/VULN-SLA.md`);
    if (dueStr === undefined) {
      errors.push(`${where}: reason thiếu "hạn rà lại: YYYY-MM-DD"`);
      continue;
    }
    const due = dayNumber(dueStr);
    if (due === null) {
      errors.push(`${where}: ngày hạn rà lại không hợp lệ: ${dueStr}`);
      continue;
    }
    const max = level === "critical" ? MAX_DAYS_CRITICAL : MAX_DAYS;
    if (due < t)
      errors.push(
        `${where}: đã quá hạn rà lại ${dueStr} (hôm nay ${today}) — nâng image/gói rồi gỡ luật, hoặc quyết định lại (D-NNN)`,
      );
    else if (due - t > max)
      errors.push(
        `${where}: hạn rà lại ${dueStr} xa quá ${max} ngày kể từ ${today}${level === "critical" ? " (mức Critical)" : ""}`,
      );
  }
  return errors;
}

function main(argv) {
  const arg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const today = arg("--today", todayUtc());
  const cfgPath = join(ROOT, arg("--config", ".grype.yaml"));
  const slaPath = join(ROOT, arg("--sla", "docs/ops/VULN-SLA.md"));
  let errors;
  let count = 0;
  try {
    const rules = parseGrypeIgnore(readFileSync(cfgPath, "utf8"));
    count = rules.length;
    errors = checkGrypeIgnore({ rules, sla: readFileSync(slaPath, "utf8"), today });
  } catch (e) {
    errors = [e.message];
  }
  const inActions = process.env.GITHUB_ACTIONS === "true";
  for (const e of errors) process.stderr.write(`${inActions ? "::error::" : "LỖI: "}${e}\n`);
  if (errors.length === 0)
    process.stdout.write(`grype-ignore-check: ${count} luật ignore còn hạn (hôm nay ${today})\n`);
  return errors.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
