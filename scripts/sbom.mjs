// SBOM CycloneDX cho phụ thuộc npm của workspace (CMP-LIC-003; PLAN đợt 9 T-802).
// Nguồn: `pnpm -r licenses list --json` (gói ĐÃ CÀI của mọi package trong workspace, kèm giấy phép) + `pnpm-lock.yaml`
// (băm SHA-512 `integrity`). Không thêm phụ thuộc: tự sinh JSON CycloneDX 1.6 (ECMA-424 tương thích ngược), kiểm bằng
// scripts/sbom-check.mjs (giấy phép không rỗng ≥ 99%, không NOASSERTION/UNKNOWN ngoài ngoại lệ có hạn).
// Image container do syft sinh ở .github/workflows/supply-chain.yml (cùng định dạng, cùng bước kiểm).
// Chạy: node scripts/sbom.mjs [--out sbom/npm.cdx.json] [--timestamp 2026-10-17T00:00:00Z]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { loadPolicy } from "./check-licenses.mjs";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SPEC_VERSION = "1.6";

/** purl npm: `pkg:npm/%40scope/name@1.2.3` (dấu @ của scope mã hoá %40, dấu / giữ nguyên). */
export function purlOf(name, version) {
  const [a, b] = name.startsWith("@") ? name.split("/") : [undefined, name];
  const path = a === undefined ? encodeURIComponent(b) : `${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

/**
 * SPDX id thường gặp ở gói npm (danh sách gọn, SPDX License List 3.x) — `license.id` của CycloneDX phải là id hợp lệ;
 * chuỗi khác ("MIT*", "BSD", "Custom: …") đi vào `license.name`. Hợp với mọi id của license-policy.json.
 */
// biome-ignore format: bảng id gọn, nhiều id mỗi dòng
const COMMON_SPDX_IDS = [
  "0BSD", "Apache-1.1", "Apache-2.0", "Artistic-2.0", "BlueOak-1.0.0", "BSD-1-Clause", "BSD-2-Clause", "BSD-3-Clause",
  "BSD-3-Clause-Clear", "BSD-4-Clause", "BSL-1.0", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "CDDL-1.0",
  "EPL-1.0", "EPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1-only",
  "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MIT-0", "MPL-1.1", "MPL-2.0", "OFL-1.1",
  "Python-2.0", "Unlicense", "WTFPL", "Zlib", "AGPL-3.0-only", "AGPL-3.0-or-later", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0",
  "BUSL-1.1", "SSPL-1.0", "Elastic-2.0",
];
const policy = loadPolicy();
/** Mục của `deny` không phải SPDX id (npm/syft dùng để nói "không có giấy phép rõ") → luôn đi vào `license.name`. */
const NOT_SPDX = new Set(["UNLICENSED", "UNKNOWN", "NOASSERTION"]);
const SPDX_IDS = new Set(
  [...COMMON_SPDX_IDS, ...policy.allow, ...policy.deny, ...policy.review].filter((id) => !NOT_SPDX.has(id)),
);
const SPDX_OPERATOR = /\b(?:AND|OR|WITH)\b/;

/**
 * Giấy phép của gói → khai báo license CycloneDX. Biểu thức có AND/OR/WITH → `expression`; một SPDX id hợp lệ (danh sách
 * gọn + id của license-policy.json, bỏ ngoặc bao ngoài) → `license.id`; chuỗi khác ("MIT*", "Mã tự đặt") → `license.name`;
 * rỗng/"Unknown" → [].
 */
export function licenseEntries(expr) {
  const e = typeof expr === "string" ? expr.trim() : "";
  if (e === "" || /^unknown$/i.test(e)) return [];
  if (SPDX_OPERATOR.test(e)) return [{ expression: e }];
  const bare = e.replace(/^\(\s*(.*?)\s*\)$/, "$1");
  return [{ license: SPDX_IDS.has(bare) ? { id: bare } : { name: e } }];
}

/** Bảng `name@version` → hex SHA-512 từ document CHÍNH (cuối cùng có `importers`; document môi trường của pnpm 12 ở đầu file bị bỏ). */
export function lockIntegrity(lockText) {
  const out = new Map();
  let main;
  for (const doc of parseAllDocuments(lockText)) {
    const js = doc.toJS();
    if (js && typeof js === "object" && js.importers) main = js;
  }
  for (const [key, v] of Object.entries(main?.packages ?? {})) {
    const integrity = v?.resolution?.integrity;
    const m = typeof integrity === "string" ? /^sha512-(.+)$/.exec(integrity) : null;
    if (m) out.set(key, Buffer.from(m[1], "base64").toString("hex"));
  }
  return out;
}

/**
 * Dựng BOM từ `byLicense` (đầu ra `pnpm licenses list --json`: {giấy phép: [{name, versions}]}).
 * Mỗi (gói, phiên bản) một component, sắp xếp ổn định để diff giữa hai lần chạy = 0 khi lockfile không đổi.
 */
export function buildSbom(byLicense, { root, integrity = new Map(), timestamp } = {}) {
  const seen = new Map();
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const p of pkgs) {
      for (const version of p.versions ?? []) {
        const key = `${p.name}@${version}`;
        if (!seen.has(key)) seen.set(key, { name: p.name, version, license });
      }
    }
  }
  const components = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, c]) => {
      const slash = c.name.startsWith("@") ? c.name.indexOf("/") : -1;
      const comp = {
        type: "library",
        "bom-ref": purlOf(c.name, c.version),
        ...(slash > 0 ? { group: c.name.slice(0, slash) } : {}),
        name: slash > 0 ? c.name.slice(slash + 1) : c.name,
        version: c.version,
        purl: purlOf(c.name, c.version),
      };
      const lic = licenseEntries(c.license);
      if (lic.length > 0) comp.licenses = lic;
      const hash = integrity.get(key);
      if (hash) comp.hashes = [{ alg: "SHA-512", content: hash }];
      return comp;
    });
  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    version: 1,
    metadata: {
      ...(timestamp ? { timestamp } : {}),
      tools: { components: [{ type: "application", name: "scripts/sbom.mjs" }] },
      component: {
        type: "application",
        name: root?.name ?? "unknown",
        version: root?.version ?? "0.0.0",
        "bom-ref": "root",
      },
    },
    components,
  };
}

function arg(name, argv = process.argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const out = arg("--out") ?? "sbom/npm.cdx.json";
  const raw = execFileSync("pnpm", ["-r", "licenses", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"));
  const bom = buildSbom(JSON.parse(raw), {
    root: pkg,
    integrity: lockIntegrity(readFileSync(`${ROOT}pnpm-lock.yaml`, "utf8")),
    timestamp: arg("--timestamp"),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
  process.stdout.write(`SBOM CycloneDX ${SPEC_VERSION}: ${bom.components.length} thành phần → ${out}\n`);
}

if (isMain(import.meta.url)) main();
