// Cổng DAST (BASE-SEC-007, SEC-WEB-004): đọc báo cáo JSON của ZAP (`-J`) và thất bại khi còn cảnh báo mức Medium (riskcode ≥ 2) trở lên
// chưa nằm trong security/zap/allowlist.json. Báo cáo thiếu/hỏng/không quét site nào = thất bại (không để "không quét gì" thành xanh).
// Dùng: node scripts/zap-gate.mjs <report.json>...
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIN_RISK = 2;
const ALLOWLIST = new URL("../security/zap/allowlist.json", import.meta.url);

/** Đọc allowlist: mỗi mục phải có pluginid + reason (không lý do = không hợp lệ). */
export function parseAllowlist(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.allow)) throw new Error("allowlist.json phải có mảng `allow`");
  for (const e of data.allow) {
    if (
      typeof e?.pluginid !== "string" ||
      e.pluginid === "" ||
      typeof e?.reason !== "string" ||
      e.reason.trim() === ""
    )
      throw new Error(`mục allowlist cần pluginid và reason: ${JSON.stringify(e)}`);
  }
  return new Set(data.allow.map((e) => e.pluginid));
}

/** Cảnh báo vi phạm của một báo cáo ZAP. Ném lỗi khi báo cáo không có site nào. */
export function violations(report, allowed = new Set(), minRisk = MIN_RISK) {
  const sites = report?.site;
  if (!Array.isArray(sites) || sites.length === 0)
    throw new Error("báo cáo ZAP không có site nào — không quét được gì");
  const out = [];
  for (const site of sites) {
    for (const a of site.alerts ?? []) {
      const risk = Number(a.riskcode);
      if (!Number.isFinite(risk)) throw new Error(`riskcode không đọc được: ${JSON.stringify(a.pluginid)}`);
      if (risk >= minRisk && !allowed.has(String(a.pluginid)))
        out.push({
          pluginid: String(a.pluginid),
          name: a.name ?? a.alert ?? "?",
          risk,
          count: Number(a.count ?? 0),
        });
    }
  }
  return out;
}

function main(files) {
  if (files.length === 0) throw new Error("thiếu đường dẫn báo cáo ZAP");
  const allowed = parseAllowlist(readFileSync(ALLOWLIST, "utf8"));
  let bad = 0;
  for (const f of files) {
    const found = violations(JSON.parse(readFileSync(f, "utf8")), allowed);
    for (const v of found)
      console.error(`${f}: [${v.pluginid}] ${v.name} (mức ${v.risk}, ${v.count} vị trí)`);
    bad += found.length;
  }
  if (bad > 0) {
    console.error(`ZAP: ${bad} cảnh báo mức Medium trở lên chưa duyệt`);
    process.exit(1);
  }
  console.log(`ZAP: 0 cảnh báo Medium trở lên trong ${files.length} báo cáo`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`zap-gate: ${e.message}`);
    process.exit(2);
  }
}
