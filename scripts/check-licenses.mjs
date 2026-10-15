// Kiểm giấy phép phụ thuộc (BASE-DEP-005, ADR-0002 "không AGPL"): allowlist SPDX; ngoài danh sách → thoát 1.
// Chạy: node scripts/check-licenses.mjs   (đọc `pnpm licenses list --json`, gồm cả devDependencies).
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

/** Biểu thức SPDX đơn giản: "A OR B" đạt nếu một vế đạt; "A AND B" đạt nếu mọi vế đạt. */
export function isAllowed(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  if (clean.includes(" OR ")) return clean.split(" OR ").some((p) => isAllowed(p));
  if (clean.includes(" AND ")) return clean.split(" AND ").every((p) => isAllowed(p));
  return ALLOWED.has(clean);
}

function main() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" });
  const byLicense = JSON.parse(raw);
  const bad = [];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    if (!isAllowed(license)) {
      for (const p of pkgs) bad.push(`${p.name}@${p.versions.join(",")} — ${license}`);
    }
  }
  if (bad.length > 0) {
    console.error(`✗ ${bad.length} gói có giấy phép ngoài allowlist:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`✓ Giấy phép: ${Object.keys(byLicense).sort().join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
