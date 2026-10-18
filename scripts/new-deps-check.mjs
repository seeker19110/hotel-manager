// Kiểm "Phụ thuộc mới" của PR (BASE-DEP-006; PLAN đợt 9 T-802): so pnpm-lock.yaml của PR với nhánh gốc; PR thêm phụ thuộc
// TRỰC TIẾP mới (importers của workspace; gói gián tiếp được nâng lên trực tiếp cũng tính) mà mục "## Phụ thuộc mới" của mô tả
// PR không khai đủ → đỏ.
// Mỗi gói mới cần một dòng: `tên · giấy phép · lý do · phương án thay thế đã xét` (4 trường không rỗng, dấu `·` ngăn cách) —
// đúng mẫu `.github/pull_request_template.md`. Gói gián tiếp mới (kéo theo) chỉ được báo (`::notice::`): giấy phép kiểm bởi
// `sbom-check --policy` (job `sbom`, SBOM npm toàn workspace; `pnpm licenses:check` chỉ quét package gốc), lỗ hổng bởi
// `dep-audit` và grype trên SBOM. Không đổi lockfile / chỉ nâng bản gói đã có → luôn đạt.
// Chạy: node scripts/new-deps-check.mjs --base-lock <file> [--head-lock pnpm-lock.yaml] [--body-file <file>]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SECTION = "Phụ thuộc mới";
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies"];

/**
 * Document chính của lockfile: pnpm 12 ghép thêm document "môi trường" (packageManager/configDependencies, cũng có
 * `importers`) ở đầu file → lấy document CUỐI có `importers`.
 */
function mainDoc(lockText) {
  let found = { importers: {}, packages: {} };
  for (const doc of parseAllDocuments(lockText)) {
    const js = doc.toJS();
    if (js && typeof js === "object" && js.importers) found = js;
  }
  return found;
}

/** Tên gói khai trực tiếp ở bất kỳ importer nào (kể cả `workspace:` nội bộ — bị loại). */
export function directNames(lockText) {
  const names = new Set();
  for (const imp of Object.values(mainDoc(lockText).importers ?? {})) {
    for (const key of DEP_KEYS)
      for (const [name, v] of Object.entries(imp?.[key] ?? {})) {
        const version = typeof v === "object" && v !== null ? String(v.version ?? "") : String(v ?? "");
        if (!version.startsWith("link:")) names.add(name);
      }
  }
  return names;
}

/** Tên mọi gói trong lockfile (khoá `tên@phiên bản`, bỏ hậu tố peer). */
export function allNames(lockText) {
  const names = new Set();
  for (const key of Object.keys(mainDoc(lockText).packages ?? {})) {
    const bare = key.replace(/\(.*$/, "");
    const at = bare.lastIndexOf("@");
    if (at > 0) names.add(bare.slice(0, at));
  }
  return names;
}

/** Hiệu hai tập (sắp xếp). */
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/** {direct: gói trực tiếp mới, transitive: gói gián tiếp mới} giữa hai lockfile. */
export function newPackages(baseLock, headLock) {
  const baseAll = allNames(baseLock);
  // Trực tiếp mới = tên khai trực tiếp ở head mà base chưa khai trực tiếp: gói gián tiếp được nâng lên trực tiếp cũng
  // tính (PR đang chọn tin nó làm phụ thuộc của mình → phải khai lý do/phương án thay thế).
  const direct = minus(directNames(headLock), directNames(baseLock));
  const transitive = minus(allNames(headLock), new Set([...baseAll, ...direct]));
  return { direct, transitive };
}

/** Nội dung mục `## Phụ thuộc mới` (bỏ chú thích HTML), "" nếu không có mục. */
export function dependencySection(body) {
  const m = new RegExp(`^## ${SECTION}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(body ?? "");
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, "").trim() : "";
}

/** Dòng khai của một gói: có tên gói và đủ 4 trường `·` không rỗng. null nếu thiếu/không đủ. */
export function declaredLine(section, name) {
  for (const raw of section.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)?/, "").trim();
    const fields = line.split("·").map((f) => f.trim());
    if (fields.length < 4 || !fields.slice(0, 4).every(Boolean)) continue;
    const first = fields[0].replace(/[`*]/g, "").trim();
    const at = first.lastIndexOf("@");
    const bare = at > 0 ? first.slice(0, at) : first; // `tên@phiên bản` → `tên`
    if (bare.toLowerCase() === name.toLowerCase()) return line;
  }
  return null;
}

/** Lỗi (đỏ) khi PR thêm phụ thuộc trực tiếp mà mô tả không khai đủ. */
export function checkDeclarations(direct, body) {
  if (direct.length === 0) return [];
  const section = dependencySection(body);
  if (section === "")
    return [
      `PR thêm ${direct.length} phụ thuộc trực tiếp (${direct.join(", ")}) nhưng mục "## ${SECTION}" của mô tả PR trống/không có`,
    ];
  return direct
    .filter((n) => declaredLine(section, n) === null)
    .map(
      (n) =>
        `thiếu dòng khai cho phụ thuộc mới "${n}" — mẫu: "${n} · giấy phép · lý do · phương án thay thế đã xét" (đủ 4 trường)`,
    );
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const baseFile = arg(argv, "--base-lock");
  if (!baseFile) {
    process.stderr.write(
      "Dùng: node scripts/new-deps-check.mjs --base-lock <file> [--head-lock <file>] [--body-file <file>]\n",
    );
    return 2;
  }
  const baseLock = readFileSync(baseFile, "utf8");
  const headLock = readFileSync(arg(argv, "--head-lock") ?? `${ROOT}pnpm-lock.yaml`, "utf8");
  const bodyFile = arg(argv, "--body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : "";
  const { direct, transitive } = newPackages(baseLock, headLock);
  if (transitive.length > 0)
    process.stdout.write(
      `::notice::${transitive.length} gói gián tiếp mới trong pnpm-lock.yaml (giấy phép: sbom-check --policy ở job sbom; lỗ hổng: dep-audit, grype)\n`,
    );
  const errors = checkDeclarations(direct, body);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`::error::${e}\n`);
    return 1;
  }
  process.stdout.write(
    direct.length === 0
      ? "Không có phụ thuộc trực tiếp mới.\n"
      : `Đã khai đủ ${direct.length} phụ thuộc mới: ${direct.join(", ")}\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
