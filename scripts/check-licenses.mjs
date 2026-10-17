// Kiểm giấy phép phụ thuộc theo `license-policy.json` (CMP-LIC-002, BASE-DEP-005, ADR-0002 "không AGPL"; PLAN đợt 8 T-705, D-057).
// Chính sách (allow/deny/review theo SPDX id + ngoại lệ có hạn) sống ở file JSON ở gốc repo — không còn danh sách cứng trong mã.
// Phán quyết cho một giấy phép: allow → đạt; deny/review/không có trong danh sách nào → đỏ; ngoại lệ còn hạn cho đúng
// (gói, giấy phép) → đạt. Ngoại lệ thiếu trường hoặc hết hạn → đỏ (kể cả khi gói không còn dùng — phải dọn).
// Chạy: node scripts/check-licenses.mjs   (đọc `pnpm licenses list --json`, gồm cả devDependencies).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const POLICY_FILE = fileURLToPath(new URL("../license-policy.json", import.meta.url));
/** Ngoại lệ tối đa 12 tháng kể từ hôm nay (UTC): không có ngoại lệ "vĩnh viễn". */
export const MAX_EXCEPTION_MONTHS = 12;
export const EXCEPTION_FIELDS = ["package", "license", "reason", "approved_by", "expires"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Đọc chính sách từ file (không kiểm — dùng `validatePolicy`). */
export function loadPolicy(file = POLICY_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const validDate = (s) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Ngày UTC hôm nay dạng YYYY-MM-DD. */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** Ngày muộn nhất được phép đặt `expires` (hôm nay + 12 tháng, kẹp cuối tháng), YYYY-MM-DD. */
export function maxExpires(today) {
  const [y, m, d] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y + MAX_EXCEPTION_MONTHS / 12, m, 0)).getUTCDate();
  return new Date(Date.UTC(y + MAX_EXCEPTION_MONTHS / 12, m - 1, Math.min(d, last)))
    .toISOString()
    .slice(0, 10);
}

/**
 * Lỗi cấu trúc/hạn của chính sách: [] = hợp lệ. `today` = YYYY-MM-DD (UTC); ngoại lệ có `expires` < today là hết hạn.
 */
export function validatePolicy(policy, today = todayUtc()) {
  const errors = [];
  if (typeof policy !== "object" || policy === null || Array.isArray(policy))
    return ["chính sách phải là object JSON"];
  if (policy.schema !== 1) errors.push(`schema phải là 1 (đang ${JSON.stringify(policy.schema)})`);
  const lists = {};
  for (const key of ["allow", "deny", "review"]) {
    const v = policy[key];
    if (!Array.isArray(v) || !v.every(nonEmptyString)) {
      errors.push(`${key} phải là mảng chuỗi SPDX id không rỗng`);
      lists[key] = [];
    } else lists[key] = v;
  }
  if (lists.allow.length === 0) errors.push("allow rỗng — mọi gói sẽ đỏ");
  for (const [a, b] of [
    ["allow", "deny"],
    ["allow", "review"],
    ["deny", "review"],
  ])
    for (const id of lists[a]) if (lists[b].includes(id)) errors.push(`${id} có ở cả ${a} và ${b}`);
  if (!Array.isArray(policy.exceptions)) errors.push("exceptions phải là mảng (có thể rỗng)");
  else {
    const seen = new Set();
    policy.exceptions.forEach((e, i) => {
      const at = `exceptions[${i}]${nonEmptyString(e?.package) ? ` (${e.package})` : ""}`;
      if (typeof e !== "object" || e === null) {
        errors.push(`${at}: phải là object`);
        return;
      }
      for (const f of EXCEPTION_FIELDS) if (!nonEmptyString(e[f])) errors.push(`${at}: thiếu trường ${f}`);
      if (nonEmptyString(e.expires)) {
        if (!validDate(e.expires))
          errors.push(`${at}: expires phải là ngày YYYY-MM-DD hợp lệ (đang "${e.expires}")`);
        else if (e.expires < today) errors.push(`${at}: đã hết hạn ${e.expires} (hôm nay ${today})`);
        else if (e.expires > maxExpires(today))
          errors.push(
            `${at}: expires ${e.expires} quá ${MAX_EXCEPTION_MONTHS} tháng (tối đa ${maxExpires(today)})`,
          );
      }
      if (nonEmptyString(e.license) && verdict(e.license, policy) === "deny")
        errors.push(`${at}: giấy phép ${e.license} thuộc deny — không được ngoại lệ`);
      const key = `${e.package}\u0000${e.license}`;
      if (seen.has(key)) errors.push(`${at}: trùng ngoại lệ cho cùng gói và giấy phép`);
      seen.add(key);
    });
  }
  return errors;
}

const RANK = { allow: 0, review: 1, unknown: 2, deny: 3 };
const better = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Phán quyết "allow" | "review" | "unknown" | "deny" cho một id SPDX đơn. */
export function classify(id, policy) {
  const clean = id.trim();
  if (policy.deny.includes(clean)) return "deny";
  if (policy.allow.includes(clean)) return "allow";
  if (policy.review.includes(clean)) return "review";
  return "unknown";
}

/**
 * Phán quyết cho biểu thức SPDX: parser đệ quy có ưu tiên (AND chặt hơn OR) và ngoặc. `A OR B` lấy vế TỐT nhất,
 * `A AND B` lấy vế TỆ nhất. `X WITH Y` là một id nguyên (không có trong danh sách → "unknown"). Biểu thức sai cú pháp
 * (ngoặc lệch, toán tử thiếu vế, rỗng, thừa token) → "unknown" — đỏ theo hướng an toàn.
 */
export function verdict(expr, policy) {
  const tokens = expr.match(/[()]|[^\s()]+/g) ?? [];
  let i = 0;
  const parseOr = () => {
    let v = parseAnd();
    while (v !== null && tokens[i] === "OR") {
      i++;
      const r = parseAnd();
      v = r === null ? null : better(v, r);
    }
    return v;
  };
  const parseAnd = () => {
    let v = parseAtom();
    while (v !== null && tokens[i] === "AND") {
      i++;
      const r = parseAtom();
      v = r === null ? null : worse(v, r);
    }
    return v;
  };
  const parseAtom = () => {
    const t = tokens[i];
    if (t === undefined || t === ")" || t === "AND" || t === "OR" || t === "WITH") return null;
    if (t === "(") {
      i++;
      const v = parseOr();
      if (v === null || tokens[i] !== ")") return null;
      i++;
      return v;
    }
    i++;
    if (tokens[i] === "WITH") {
      const ex = tokens[i + 1];
      if (ex === undefined || ex === "(" || ex === ")" || ex === "AND" || ex === "OR" || ex === "WITH")
        return null;
      i += 2;
      return classify(`${t} WITH ${ex}`, policy);
    }
    return classify(t, policy);
  };
  const v = parseOr();
  return v === null || i !== tokens.length ? "unknown" : v;
}

/** Tương thích: giấy phép đạt theo chính sách (không xét ngoại lệ). `policy` mặc định = file ở gốc repo. */
export function isAllowed(expr, policy = loadPolicy()) {
  return verdict(expr, policy) === "allow";
}

const WHY = {
  deny: "giấy phép bị cấm (deny)",
  review: "giấy phép cần quyết định ghi lại (review) — thêm ngoại lệ có approved_by/expires",
  unknown: "giấy phép chưa có trong chính sách (không xác định)",
};

/**
 * Kiểm danh sách gói (`byLicense` = đầu ra `pnpm licenses list --json`: {license: [{name, versions}]}) theo chính sách.
 * Trả {errors: lỗi chính sách (ngoại lệ hết hạn/thiếu trường…), violations: [chuỗi], used: ngoại lệ đã dùng,
 * stale: ngoại lệ không còn gói nào khớp, licenses: các giấy phép đã gặp}.
 */
export function checkLicenses(byLicense, policy, today = todayUtc()) {
  const errors = validatePolicy(policy, today);
  const violations = [];
  const used = new Set();
  const valid = Array.isArray(policy.exceptions) ? policy.exceptions : [];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    const v = verdict(license, policy);
    if (v === "allow") continue;
    for (const p of pkgs) {
      // deny không bao giờ được ngoại lệ; hạn/trần 12 tháng đã kiểm ở validatePolicy (errors → đỏ).
      const ex =
        v === "deny"
          ? undefined
          : valid.find(
              (e) =>
                e &&
                e.package === p.name &&
                e.license === license &&
                validDate(e.expires ?? "") &&
                e.expires >= today &&
                e.expires <= maxExpires(today),
            );
      if (ex && nonEmptyString(ex.reason) && nonEmptyString(ex.approved_by)) {
        used.add(ex);
        continue;
      }
      violations.push(`${p.name}@${(p.versions ?? []).join(",")} — ${license}: ${WHY[v]}`);
    }
  }
  const stale = valid.filter((e) => e && !used.has(e) && !errors.some((m) => m.includes(`(${e.package})`)));
  return {
    errors,
    violations,
    used: [...used],
    stale: stale.filter(
      (e) =>
        !Object.entries(byLicense).some(([l, pk]) => l === e.license && pk.some((p) => p.name === e.package)),
    ),
    licenses: Object.keys(byLicense).sort(),
  };
}

function main() {
  const policy = loadPolicy();
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" });
  const r = checkLicenses(JSON.parse(raw), policy);
  for (const e of r.stale)
    console.warn(`! Ngoại lệ không còn gói nào khớp, nên xoá: ${e.package} (${e.license})`);
  if (r.errors.length > 0 || r.violations.length > 0) {
    if (r.errors.length > 0) console.error(`✗ license-policy.json không hợp lệ:\n  ${r.errors.join("\n  ")}`);
    if (r.violations.length > 0)
      console.error(
        `✗ ${r.violations.length} gói vi phạm chính sách giấy phép:\n  ${r.violations.join("\n  ")}`,
      );
    process.exit(1);
  }
  console.log(
    `✓ Giấy phép: ${r.licenses.join(", ")}${r.used.length > 0 ? ` (${r.used.length} ngoại lệ còn hạn)` : ""}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
