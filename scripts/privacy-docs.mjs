// Rào hồ sơ quyền riêng tư (PLAN đợt 23, T-2305): CMP-INTL-002 (data map có cơ sở pháp lý mã hoá, cột nhạy cảm có điều kiện Art. 9),
// CMP-AUDIT-007 (sổ nhà cung cấp máy đọc khớp processors.md, rà ≤ 12 tháng, SDK dịch vụ ngoài phải có dòng), CMP-AUDIT-003
// (docs/privacy/CHANGELOG.md có mục ngày; `updated:` không mới hơn mục mới nhất; quá 6 tháng → cảnh báo). Chạy ở job new-deps.
// Dùng: node scripts/privacy-docs.mjs [--today YYYY-MM-DD]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAY = 86_400_000;
export const LEGAL_BASIS_CODES = new Set([
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
]);
/** GDPR Art. 9(2)(a)–(j) + `khong_thuoc_art9` (nhạy cảm theo luật VN nhưng không phải nhóm đặc biệt GDPR — phải có art9_note). */
export const ART9_CONDITIONS = new Set([
  "explicit_consent",
  "employment_social_protection",
  "vital_interests",
  "not_for_profit_body",
  "made_public",
  "legal_claims",
  "substantial_public_interest",
  "health_care",
  "public_health",
  "archiving_research",
  "khong_thuoc_art9",
]);
export const VENDOR_STATUS = new Set(["dang_dung", "chua_chon", "chua_tich_hop", "khong_phai_ben_xu_ly"]);
/** Gói SDK của dịch vụ bên ngoài (gửi dữ liệu ra khỏi tiến trình) — có trong phụ thuộc runtime thì phải có ở vendors.yaml. */
export const SDK_PATTERNS = [
  /^aws4fetch$/,
  /^@aws-sdk\//,
  /^@azure\//,
  /^@google-cloud\//,
  /^firebase/,
  /^@sentry\//,
  /^posthog/,
  /^@?segment/,
  /^mixpanel/,
  /^stripe$/,
  /^twilio$/,
  /^nodemailer$/,
  /^resend$/,
  /^@sendgrid\//,
  /^mailgun/,
  /^openai$/,
  /^@anthropic-ai\//,
  /^@supabase\//,
  /^cloudinary$/,
  /^algoliasearch$/,
  /^@opentelemetry\/exporter-/,
];

const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN);

/** CMP-INTL-002: lỗi của data map (đối tượng đã parse). */
export function dataMapErrors(map) {
  const errors = [];
  for (const e of map?.entries ?? []) {
    const id = `${e.table}.${e.column}`;
    if (!e.legal_basis) errors.push(`${id}: thiếu legal_basis`);
    if (!LEGAL_BASIS_CODES.has(e.legal_basis_code))
      errors.push(
        `${id}: legal_basis_code "${e.legal_basis_code ?? ""}" không thuộc ${[...LEGAL_BASIS_CODES].join("|")}`,
      );
    if (e.classification === "nhay_cam") {
      if (!ART9_CONDITIONS.has(e.art9_condition))
        errors.push(`${id}: dữ liệu nhạy cảm phải có art9_condition hợp lệ (GDPR Art. 9(2))`);
      if (e.art9_condition === "khong_thuoc_art9" && !e.art9_note)
        errors.push(`${id}: art9_condition khong_thuoc_art9 phải có art9_note giải thích`);
    }
  }
  if (!(map?.entries ?? []).length) errors.push("data map không có mục nào");
  return errors;
}

/** CMP-AUDIT-007: lỗi của sổ nhà cung cấp + đối chiếu processors.md và phụ thuộc runtime. */
export function vendorErrors(vendors, processorsMd, runtimeDeps, today) {
  const errors = [];
  const list = vendors?.vendors ?? [];
  const names = new Set();
  for (const v of list) {
    const id = v.name ?? "(không tên)";
    for (const f of ["name", "role", "data", "location", "dpa", "status", "reviewed"])
      if (!v[f]) errors.push(`${id}: thiếu ${f}`);
    if (!Array.isArray(v.sdk_packages)) errors.push(`${id}: sdk_packages phải là mảng`);
    if (v.status && !VENDOR_STATUS.has(v.status)) errors.push(`${id}: status "${v.status}" không hợp lệ`);
    const r = isoDay(v.reviewed);
    if (Number.isNaN(r)) errors.push(`${id}: reviewed phải là YYYY-MM-DD`);
    else if (v.status === "dang_dung" && today - r > 366 * DAY)
      errors.push(`${id}: quá 12 tháng chưa rà (${v.reviewed})`);
    if (names.has(id)) errors.push(`${id}: trùng tên`);
    names.add(id);
    if (!processorsMd.includes(id)) errors.push(`${id}: không có trong docs/privacy/processors.md`);
  }
  for (const [, bold] of processorsMd.matchAll(/^\| \*\*([^*]+)\*\* \|/gm))
    if (!names.has(bold))
      errors.push(`processors.md "${bold}": thiếu dòng trong docs/compliance/vendors.yaml`);
  const covered = new Set(list.flatMap((v) => v.sdk_packages ?? []));
  for (const dep of runtimeDeps)
    if (SDK_PATTERNS.some((re) => re.test(dep)) && !covered.has(dep))
      errors.push(
        `phụ thuộc runtime "${dep}" là SDK dịch vụ ngoài nhưng chưa có trong sdk_packages của vendors.yaml`,
      );
  return errors;
}

/** CMP-AUDIT-003: {errors, warnings} cho CHANGELOG + ngày `updated:` của tệp trong docs/privacy. */
export function changelogFindings(changelog, updatedDates, today) {
  const errors = [];
  const warnings = [];
  const days = [...changelog.matchAll(/^## (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1]);
  if (!days.length) return { errors: ["docs/privacy/CHANGELOG.md chưa có mục `## YYYY-MM-DD`"], warnings };
  const sorted = [...days].sort().reverse();
  if (days.join() !== sorted.join()) errors.push("CHANGELOG: mục phải xếp mới nhất ở trên");
  const latest = sorted[0];
  for (const [file, d] of updatedDates)
    if (String(d) > latest)
      errors.push(`${file}: updated ${d} mới hơn mục CHANGELOG mới nhất (${latest}) — ghi mục mới`);
  if (today - isoDay(latest) > 183 * DAY)
    warnings.push(`docs/privacy: quá 6 tháng chưa cập nhật (mục mới nhất ${latest}) — rà lại ROPA/data map`);
  return { errors, warnings };
}

/** Tên phụ thuộc runtime của các workspace phân phối (apps/*, packages/* trừ testkit). */
export function runtimeDependencies(root = ROOT) {
  const deps = new Set();
  for (const dir of ["apps", "packages"])
    for (const ws of readdirSync(join(root, dir))) {
      const manifest = join(root, dir, ws, "package.json");
      if (ws === "testkit" || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      for (const d of Object.keys(pkg.dependencies ?? {})) if (!d.startsWith("@hm/")) deps.add(d);
    }
  return [...deps].sort();
}

export function run(today = Date.now(), root = ROOT) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const updated = readdirSync(join(root, "docs/privacy"))
    .filter((f) => f !== "CHANGELOG.md")
    .map((f) => [f, /^updated: (\S+)$/m.exec(read(`docs/privacy/${f}`))?.[1]])
    .filter(([, d]) => d);
  const cl = changelogFindings(read("docs/privacy/CHANGELOG.md"), updated, today);
  return {
    errors: [
      ...dataMapErrors(parse(read("docs/privacy/data-map.yaml"))),
      ...vendorErrors(
        parse(read("docs/compliance/vendors.yaml")),
        read("docs/privacy/processors.md"),
        runtimeDependencies(root),
        today,
      ),
      ...cl.errors,
    ],
    warnings: cl.warnings,
  };
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf("--today");
  const today = i > 0 ? isoDay(process.argv[i + 1]) : Date.now();
  const { errors, warnings } = run(today);
  for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
  for (const e of errors) process.stderr.write(`✗ ${e}\n`);
  if (errors.length) process.exit(1);
  process.stdout.write("✓ privacy-docs: data map, sổ nhà cung cấp, CHANGELOG hợp lệ\n");
}
