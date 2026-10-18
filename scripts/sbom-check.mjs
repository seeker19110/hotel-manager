// Kiểm SBOM CycloneDX (CMP-LIC-003, CMP-LIC-004; PLAN đợt 9 T-802): áp cho SBOM npm (scripts/sbom.mjs) và SBOM image (syft).
// Luật:
//  1. Giấy phép không rỗng ≥ `minCoverage`% số thành phần được tính (bỏ `file`, `operating-system`, `data`, `device`).
//  2. Không thành phần nào ghi NOASSERTION/UNKNOWN/NONE ngoài `sbom_exceptions` còn hạn trong license-policy.json.
//  3. Giấy phép "source-available" (BUSL, SSPL, Elastic, Commons Clause…) chỉ được dùng khi có ngoại lệ ghi rõ ADR
//     (`reason` chứa `ADR-NNNN`) — CMP-LIC-004.
//  4. Với `--policy <license-policy.json>` (SBOM npm toàn workspace, gồm cả gói gián tiếp): thành phần có giấy phép KHÔNG
//     thuộc `allow` (deny/review/không xác định, vd AGPL-3.0-only, LGPL-3.0-or-later) đỏ trừ khi có ngoại lệ còn hạn
//     (`exceptions` hoặc `sbom_exceptions`); giấy phép `deny` thật sự (AGPL, GPL, SSPL…) không bao giờ được ngoại lệ;
//     UNLICENSED, "SEE LICENSE IN …", NOASSERTION/UNKNOWN = "chưa rõ" → đỏ trừ khi có ngoại lệ — CMP-LIC-002/004.
// Ngoại lệ: {package, license, reason, approved_by, expires (YYYY-MM-DD, ≤ 12 tháng)} — cùng khuôn `exceptions` của chính sách
// giấy phép; `license` là giấy phép của thành phần (NOASSERTION/UNKNOWN/NONE hoặc id source-available), `package` = tên
// (`group/name` với gói có group). Ngoại lệ thiếu trường/hết hạn → đỏ.
// Chạy: node scripts/sbom-check.mjs [--min-coverage 99] [--policy license-policy.json] <sbom.cdx.json …>
import { readFileSync } from "node:fs";
import {
  EXCEPTION_FIELDS,
  loadPolicy,
  maxExpires,
  todayUtc,
  validatePolicy,
  verdict,
} from "./check-licenses.mjs";
import { isMain } from "./is-main.mjs";

export const MIN_COVERAGE = 99;
const SKIP_TYPES = new Set(["file", "operating-system", "data", "device"]);
const UNASSERTED = new Set(["NOASSERTION", "UNKNOWN", "NONE"]);
/** Giấy phép source-available/không phải OSI: chỉ dùng kèm quyết định (ADR) — CMP-LIC-004. */
export const SOURCE_AVAILABLE = [
  /^BUSL-/i,
  // Business Source License (MariaDB) hay ghi "BSL-1.1". KHÔNG khớp `BSL-1.0`: đó là Boost Software License (SPDX, permissive,
  // có trong debian/copyright của glibc/sed) — khớp nhầm làm `image-scan (postgres|node-base)` đỏ ở T-802.
  /^BSL-1\.1/i,
  /^SSPL-/i,
  /^Elastic-/i,
  /^ELv2$/i,
  /^Commons[- ]Clause/i,
  /^Business Source/i,
  /^Server Side Public/i,
  /^Elastic License/i,
  /^PolyForm-/i,
  /^FSL-/i,
];

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const validDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Tên đầy đủ của thành phần: `group/name` (npm scope) hoặc `name`. */
export const componentName = (c) => (nonEmpty(c.group) ? `${c.group}/${c.name}` : String(c.name ?? ""));

/** Các chuỗi giấy phép (id/name/expression) của một thành phần; [] nếu không khai. */
export function licenseStrings(c) {
  const out = [];
  for (const l of Array.isArray(c.licenses) ? c.licenses : []) {
    if (nonEmpty(l?.expression)) out.push(l.expression.trim());
    else if (nonEmpty(l?.license?.id)) out.push(l.license.id.trim());
    else if (nonEmpty(l?.license?.name)) out.push(l.license.name.trim());
  }
  return out;
}

/** Tách biểu thức SPDX thành các id (bỏ AND/OR/WITH, ngoặc). */
const tokens = (s) => s.split(/[\s()]+/).filter((t) => t && !/^(AND|OR|WITH)$/i.test(t));

export const isUnasserted = (s) => tokens(s).some((t) => UNASSERTED.has(t.toUpperCase()));
/** Giấy phép "chưa rõ" ngoài NOASSERTION/UNKNOWN/NONE: `UNLICENSED` (npm) và `SEE LICENSE IN <file>`. */
export const isUnclearLicense = (s) =>
  isUnasserted(s) || /^\s*UNLICENSED\s*$/i.test(s) || /^\s*SEE LICENSE IN\b/i.test(s);
export const isSourceAvailable = (s) =>
  SOURCE_AVAILABLE.some((re) => re.test(s.trim())) ||
  tokens(s).some((t) => SOURCE_AVAILABLE.some((re) => re.test(t)));

/** Lỗi cấu trúc/hạn của `sbom_exceptions` ([] = hợp lệ). */
export function validateExceptions(list, today = todayUtc()) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["sbom_exceptions phải là mảng (có thể rỗng)"];
  const errors = [];
  list.forEach((e, i) => {
    const at = `sbom_exceptions[${i}]${nonEmpty(e?.package) ? ` (${e.package})` : ""}`;
    if (typeof e !== "object" || e === null) {
      errors.push(`${at}: phải là object`);
      return;
    }
    for (const f of EXCEPTION_FIELDS) if (!nonEmpty(e[f])) errors.push(`${at}: thiếu trường ${f}`);
    if (nonEmpty(e.expires)) {
      if (!validDate(e.expires))
        errors.push(`${at}: expires phải là ngày YYYY-MM-DD hợp lệ (đang "${e.expires}")`);
      else if (e.expires < today) errors.push(`${at}: đã hết hạn ${e.expires} (hôm nay ${today})`);
      else if (e.expires > maxExpires(today))
        errors.push(`${at}: expires ${e.expires} quá 12 tháng (tối đa ${maxExpires(today)})`);
    }
  });
  return errors;
}

function activeException(exceptions, name, license, today) {
  return exceptions.find(
    (e) =>
      e?.package === name &&
      nonEmpty(e.reason) &&
      nonEmpty(e.approved_by) &&
      validDate(e.expires ?? "") &&
      e.expires >= today &&
      e.expires <= maxExpires(today) &&
      (e.license === license || tokens(license).includes(e.license)),
  );
}

/**
 * Vi phạm chính sách giấy phép của một chuỗi giấy phép ("" = đạt). `exceptionLists` = các danh sách ngoại lệ được chấp nhận.
 * deny thật (không thuộc nhóm "chưa rõ") không bao giờ được ngoại lệ — cùng luật `checkLicenses` của check-licenses.mjs.
 */
function policyViolation(license, name, policy, exceptionLists, today) {
  const unclear = isUnclearLicense(license);
  const v = unclear ? "unclear" : verdict(license, policy);
  if (v === "allow") return "";
  const excepted = exceptionLists.some((list) => activeException(list, name, license, today));
  if (v !== "deny" && excepted) return "";
  const why = {
    deny: "giấy phép bị cấm (deny), không có ngoại lệ",
    review: "giấy phép cần quyết định ghi lại (review) — thêm ngoại lệ có hạn",
    unknown: "giấy phép chưa có trong allow của chính sách",
    unclear: "giấy phép chưa rõ (UNLICENSED/SEE LICENSE IN/NOASSERTION) — thêm ngoại lệ có hạn",
  }[v];
  return `${license}: ${why}`;
}

/**
 * Phân tích một BOM. Trả {total, licensed, coverage (%), unasserted, sourceAvailable, policyViolations, missing, errors}.
 * `errors` = lý do đỏ (rỗng = đạt). `exceptions` = `sbom_exceptions` của chính sách; `policy` (tuỳ chọn) = nội dung
 * license-policy.json — bật luật 4 (giấy phép ngoài `allow`).
 */
export function analyzeSbom(
  bom,
  { exceptions = [], policy, minCoverage = MIN_COVERAGE, today = todayUtc() } = {},
) {
  const errors = validateExceptions(exceptions, today);
  if (policy) errors.push(...validatePolicy(policy, today));
  const policyExceptions = Array.isArray(policy?.exceptions) ? policy.exceptions : [];
  const policyViolations = [];
  if (typeof bom !== "object" || bom === null || bom.bomFormat !== "CycloneDX")
    return {
      total: 0,
      licensed: 0,
      coverage: 0,
      unasserted: [],
      sourceAvailable: [],
      policyViolations: [],
      missing: [],
      errors: [...errors, "không phải BOM CycloneDX (thiếu bomFormat)"],
    };
  const comps = (Array.isArray(bom.components) ? bom.components : []).filter((c) => !SKIP_TYPES.has(c?.type));
  const unasserted = [];
  const sourceAvailable = [];
  const missing = [];
  let licensed = 0;
  for (const c of comps) {
    const name = componentName(c);
    const label = `${name}@${c.version ?? "?"}`;
    const lic = licenseStrings(c);
    if (lic.length === 0) {
      missing.push(label);
      continue;
    }
    let ok = true;
    for (const l of lic) {
      if (
        isUnasserted(l) &&
        !activeException(exceptions, name, l, today) &&
        !activeException(exceptions, name, "NOASSERTION", today)
      ) {
        unasserted.push(`${label} — ${l}`);
        ok = false;
      }
      if (isSourceAvailable(l)) {
        const ex = activeException(exceptions, name, l, today);
        if (!ex || !/ADR-\d{4}/.test(ex.reason)) {
          sourceAvailable.push(`${label} — ${l}`);
          ok = false;
        }
      } else if (policy && !isUnasserted(l)) {
        // NOASSERTION/UNKNOWN và source-available đã có đường báo riêng ở trên; phần còn lại đối chiếu `allow`.
        const bad = policyViolation(l, name, policy, [exceptions, policyExceptions], today);
        if (bad) {
          policyViolations.push(`${label} — ${bad}`);
          ok = false;
        }
      }
    }
    if (ok) licensed++;
  }
  // Thành phần thiếu giấy phép nhưng có ngoại lệ NOASSERTION còn hạn → tính là đã giải quyết.
  const resolvedMissing = missing.filter((m) => {
    const name = m.slice(0, m.lastIndexOf("@"));
    return Boolean(activeException(exceptions, name, "NOASSERTION", today));
  });
  const coverage = comps.length === 0 ? 0 : ((licensed + resolvedMissing.length) / comps.length) * 100;
  if (comps.length === 0) errors.push("SBOM không có thành phần nào (rỗng)");
  if (comps.length > 0 && coverage < minCoverage)
    errors.push(`giấy phép không rỗng ${coverage.toFixed(1)}% < ${minCoverage}% (${missing.length} thiếu)`);
  if (unasserted.length > 0)
    errors.push(
      `${unasserted.length} thành phần NOASSERTION/UNKNOWN ngoài ngoại lệ: ${unasserted.slice(0, 5).join("; ")}`,
    );
  if (sourceAvailable.length > 0)
    errors.push(
      `${sourceAvailable.length} thành phần source-available không có ngoại lệ kèm ADR: ${sourceAvailable.slice(0, 5).join("; ")}`,
    );
  if (policyViolations.length > 0)
    errors.push(
      `${policyViolations.length} thành phần có giấy phép ngoài chính sách: ${policyViolations.slice(0, 5).join("; ")}`,
    );
  return {
    total: comps.length,
    licensed,
    coverage,
    unasserted,
    sourceAvailable,
    policyViolations,
    missing,
    errors,
  };
}

function main(argv) {
  const files = [];
  let minCoverage = MIN_COVERAGE;
  let policyFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min-coverage") minCoverage = Number(argv[++i]);
    else if (argv[i] === "--policy") policyFile = argv[++i] ?? "";
    else files.push(argv[i]);
  }
  if (files.length === 0 || !Number.isFinite(minCoverage) || policyFile === "") {
    process.stderr.write(
      "Dùng: node scripts/sbom-check.mjs [--min-coverage 99] [--policy license-policy.json] <sbom.cdx.json …>\n",
    );
    return 2;
  }
  let policy;
  if (policyFile !== undefined) {
    try {
      policy = loadPolicy(policyFile);
    } catch (e) {
      process.stderr.write(`✗ ${policyFile}: không đọc được chính sách giấy phép (${e.message})\n`);
      return 1;
    }
  }
  const exceptions = (policy ?? loadPolicy()).sbom_exceptions ?? [];
  let bad = 0;
  for (const f of files) {
    let bom;
    try {
      bom = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      process.stderr.write(`✗ ${f}: không đọc được SBOM (${e.message})\n`);
      bad++;
      continue;
    }
    const r = analyzeSbom(bom, { exceptions, policy, minCoverage });
    if (r.errors.length > 0) {
      process.stderr.write(`✗ ${f}:\n  ${r.errors.join("\n  ")}\n`);
      bad++;
    } else process.stdout.write(`✓ ${f}: ${r.total} thành phần, giấy phép ${r.coverage.toFixed(1)}%\n`);
  }
  return bad > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
