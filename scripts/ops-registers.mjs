// Rào sổ vận hành (PLAN đợt 23, T-2306):
//  · WF-DOC-008 — docs/ops/RUNBOOK.md trỏ runbook có thật, mỗi runbook có `last_drilled`; chưa diễn tập / quá 6 tháng ⇒ cảnh báo.
//  · CMP-AUDIT-010 — docs/ops/incidents/: mỗi bản ghi đủ mục và có dòng ở sổ; mỗi dòng trỏ tệp có thật.
//  · CMP-INTL-006 — data-breach.md có bảng thời hạn theo vùng (VN, EU/EEA, UK, Thái Lan, Singapore).
//  · IND-SAAS-010 — docs/legal/DPA.md + subprocessors.md có phiên bản, cam kết ≥ 30 ngày và thời hạn thông báo vi phạm.
//  · PM-HANDOVER-009 — docs/handover/renewals.md: quá hạn ⇒ đỏ, ≤ 30 ngày ⇒ cảnh báo; khớp security.txt và license-policy.json.
// Dùng: node scripts/ops-registers.mjs [--today YYYY-MM-DD]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAY = 86_400_000;
const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN);
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return Object.fromEntries(
    (m?.[1] ?? "")
      .split("\n")
      .map((l) => /^([a-z_]+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]),
  );
};
const tableRows = (text, heading) => {
  const at = heading ? text.indexOf(heading) : 0;
  if (at < 0) return [];
  const rows = [];
  for (const l of text
    .slice(at)
    .split("\n")
    .slice(heading ? 1 : 0)) {
    if (heading && /^## /.test(l)) break;
    if (/^\|/.test(l) && !/^\|[-| ]+\|$/.test(l))
      rows.push(
        l
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim()),
      );
  }
  return rows.slice(1); // bỏ dòng tiêu đề
};

/** WF-DOC-008: {errors, warnings}. `files` = {đường dẫn tương đối docs/ops/…: nội dung}. */
export function runbookFindings(index, read, today) {
  const errors = [];
  const warnings = [];
  const links = [...index.matchAll(/\]\((runbooks\/[^)#]+\.md)\)/g)].map((m) => m[1]);
  if (!links.length) errors.push("docs/ops/RUNBOOK.md không trỏ runbook nào");
  for (const required of ["Deploy", "Rollback", "Khôi phục backup", "Xoay secret", "Sự cố thường gặp"])
    if (!new RegExp(`^\\| ${required}`, "m").test(index))
      errors.push(`docs/ops/RUNBOOK.md thiếu mục "${required}"`);
  for (const rel of [...new Set(links)]) {
    const text = read(rel);
    if (text === null) {
      errors.push(`docs/ops/${rel}: không tồn tại`);
      continue;
    }
    const drilled = frontmatter(text).last_drilled;
    if (!drilled) {
      errors.push(`docs/ops/${rel}: thiếu last_drilled ở frontmatter`);
      continue;
    }
    const d = isoDay(/^(\d{4}-\d{2}-\d{2})/.exec(drilled)?.[1]);
    if (Number.isNaN(d)) warnings.push(`docs/ops/${rel}: chưa diễn tập (${drilled})`);
    else if (today - d > 183 * DAY) warnings.push(`docs/ops/${rel}: diễn tập quá 6 tháng (${drilled})`);
  }
  return { errors, warnings };
}

export const INCIDENT_SECTIONS = [
  "Phát hiện",
  "Phân loại",
  "Thông báo",
  "Khắc phục",
  "Post-mortem",
  "Hành động",
];
/** CMP-AUDIT-010: lỗi của sổ sự cố. `records` = {tên tệp: nội dung} (trừ README/TEMPLATE). */
export function incidentErrors(readme, template, records) {
  const errors = [];
  for (const s of INCIDENT_SECTIONS)
    if (!new RegExp(`^## ${s}$`, "m").test(template)) errors.push(`incidents/TEMPLATE.md thiếu mục "${s}"`);
  const listed = new Set(
    tableRows(readme, "## Sự cố").map((r) => r[1]?.replace(/^\[?`?|`?\]?(\(.*\))?$/g, "")),
  );
  for (const [name, text] of Object.entries(records)) {
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(name))
      errors.push(`incidents/${name}: tên phải là YYYY-MM-DD-<slug>.md`);
    for (const s of INCIDENT_SECTIONS)
      if (!new RegExp(`^## ${s}$`, "m").test(text)) errors.push(`incidents/${name}: thiếu mục "${s}"`);
    if (!listed.has(name)) errors.push(`incidents/${name}: chưa có dòng ở bảng "Sự cố" của README.md`);
  }
  for (const n of listed)
    if (n && !(n in records)) errors.push(`incidents/README.md trỏ "${n}" không có thật`);
  return errors;
}

export const BREACH_REGIONS = ["VN", "EU/EEA", "UK", "Thái Lan", "Singapore"];
/** CMP-INTL-006 + IND-SAAS-010: lỗi của runbook vi phạm và hồ sơ pháp lý. */
export function legalErrors(breach, dpa, subprocessors) {
  const errors = [];
  const rows = tableRows(breach, "## Thời hạn theo vùng");
  for (const r of BREACH_REGIONS)
    if (!rows.some((row) => row[0] === r))
      errors.push(`data-breach.md: bảng thời hạn theo vùng thiếu "${r}"`);
  for (const row of rows) if (!row[2]) errors.push(`data-breach.md: vùng ${row[0]} thiếu thời hạn`);
  for (const [name, text] of [
    ["DPA.md", dpa],
    ["subprocessors.md", subprocessors],
  ]) {
    const fm = frontmatter(text);
    if (!/^\d+\.\d+\.\d+$/.test(fm.version ?? ""))
      errors.push(`docs/legal/${name}: thiếu version SemVer ở frontmatter`);
    if (Number.isNaN(isoDay(fm.updated))) errors.push(`docs/legal/${name}: thiếu updated`);
    if (!text.includes(`| ${fm.version} |`))
      errors.push(`docs/legal/${name}: lịch sử phiên bản thiếu ${fm.version}`);
  }
  if (!/≥ 30\s*ngày/.test(dpa))
    errors.push("DPA.md: thiếu cam kết thông báo thay đổi sub-processor ≥ 30 ngày");
  if (!/72 giờ/.test(dpa) || !/3 ngày lịch/.test(dpa))
    errors.push("DPA.md: thiếu thời hạn thông báo vi phạm (72 giờ; SG 3 ngày lịch)");
  if (!/Việt Nam/.test(dpa)) errors.push("DPA.md: thiếu vị trí lưu trữ");
  if (!/≥ 30 ngày/.test(subprocessors)) errors.push("subprocessors.md: thiếu cam kết thông báo ≥ 30 ngày");
  return errors;
}

/** PM-HANDOVER-009: {errors, warnings}. `facts` = {securityTxtExpires, licenseExpiries: {gói: ngày}}. */
export function renewalFindings(renewals, facts, today) {
  const errors = [];
  const warnings = [];
  const rows = tableRows(renewals);
  if (!rows.length) errors.push("renewals.md không có dòng nào");
  for (const [item, , exp] of rows) {
    if (exp === "—") continue;
    const d = isoDay(exp);
    if (Number.isNaN(d)) errors.push(`renewals.md "${item}": Hết hạn phải là YYYY-MM-DD hoặc —`);
    else if (d < today) errors.push(`renewals.md "${item}": đã hết hạn ${exp}`);
    else if (d - today <= 30 * DAY)
      warnings.push(`renewals.md "${item}": hết hạn ${exp} (≤ 30 ngày) — gia hạn`);
  }
  const find = (re) => rows.find((r) => re.test(r[0]))?.[2];
  if (facts.securityTxtExpires && find(/security\.txt/) !== facts.securityTxtExpires)
    errors.push(`renewals.md: dòng security.txt phải ghi ${facts.securityTxtExpires} (Expires trong tệp)`);
  for (const [pkg, exp] of Object.entries(facts.licenseExpiries ?? {}))
    if (find(new RegExp(`\`${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\``)) !== exp)
      errors.push(`renewals.md: ngoại lệ giấy phép ${pkg} phải có dòng hết hạn ${exp} (license-policy.json)`);
  return { errors, warnings };
}

export function run(today = Date.now(), root = ROOT) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const maybe = (p) => (existsSync(join(root, p)) ? read(p) : null);
  const rb = runbookFindings(read("docs/ops/RUNBOOK.md"), (rel) => maybe(join("docs/ops", rel)), today);
  const incDir = "docs/ops/incidents";
  const records = Object.fromEntries(
    readdirSync(join(root, incDir))
      .filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "TEMPLATE.md")
      .map((f) => [f, read(join(incDir, f))]),
  );
  const policy = JSON.parse(read("license-policy.json"));
  const licenseExpiries = Object.fromEntries(
    [...(policy.exceptions ?? []), ...(policy.sbom_exceptions ?? [])].map((e) => [e.package, e.expires]),
  );
  const securityTxtExpires = /^Expires: (\d{4}-\d{2}-\d{2})/m.exec(
    read("apps/web/public/.well-known/security.txt"),
  )?.[1];
  const rn = renewalFindings(
    read("docs/handover/renewals.md"),
    { securityTxtExpires, licenseExpiries },
    today,
  );
  return {
    errors: [
      ...rb.errors,
      ...incidentErrors(read(`${incDir}/README.md`), read(`${incDir}/TEMPLATE.md`), records),
      ...legalErrors(
        read("docs/ops/runbooks/data-breach.md"),
        read("docs/legal/DPA.md"),
        read("docs/legal/subprocessors.md"),
      ),
      ...rn.errors,
    ],
    warnings: [...rb.warnings, ...rn.warnings],
  };
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf("--today");
  const { errors, warnings } = run(i > 0 ? isoDay(process.argv[i + 1]) : Date.now());
  for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
  for (const e of errors) process.stderr.write(`✗ ${e}\n`);
  if (errors.length) process.exit(1);
  process.stdout.write(
    `✓ ops-registers: runbook, sổ sự cố, hồ sơ pháp lý, gia hạn hợp lệ (${warnings.length} cảnh báo)\n`,
  );
}
