// OPS-DEPLOY-003: chạy bộ test bản N−1 (nhánh nền) trên schema N (migration của PR). Bước chuẩn bị `overlay`:
//   1. kiểm mọi migration đã có ở nhánh nền còn nguyên vẹn ở PR (không sửa/xoá migration đã áp — expand → migrate → contract);
//   2. kiểm sổ `migrations` trong index.ts của PR còn đủ khoá của nền (index.ts bị cắt/sửa tên khoá → migration đã áp bị bỏ khỏi sổ);
//   3. chép thư mục migration của PR (gồm index.ts) đè lên bản nhánh nền ⇒ code cũ chạy trên schema mới;
//   4. chép các file DỮ LIỆU nền của schema (BASELINE_FILES) của PR đè lên nền. Test ratchet của N−1 so schema với nền tuyệt đối
//      (vd số cột NULL theo bảng) — migration expand hợp lệ làm schema N khác nền N−1 nên nếu giữ nền cũ sẽ đỏ oan. Chép nền của PR
//      giữ được mục đích "code N−1 chạy đúng trên schema N": mọi test hành vi/ràng buộc của N−1 vẫn chạy nguyên; chỉ con số tham chiếu
//      của schema chuyển sang N. (Ảnh chụp schema.snapshot.txt do test `schema-drift` dùng — test đó bị loại khỏi job.)
// Dùng: `node scripts/schema-compat.mjs overlay <thư-mục-gốc-nhánh-nền> <thư-mục-gốc-PR>`; CI: job `schema-compat`.
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MIGRATIONS_REL = "packages/db/src/migrations";
const MIGRATION = /^\d{4}_.+\.ts$/;
/** File dữ liệu nền mà test CSDL đọc để so với schema thật (đường dẫn từ gốc repo). Thêm vào đây khi có test ratchet/sổ mới. */
export const BASELINE_FILES = [
  "packages/testkit/src/schema-guards.baseline.json",
  "docs/privacy/data-map.yaml",
];

/** Danh sách vi phạm: migration có ở nền mà PR thiếu (xoá/đổi tên) hoặc khác nội dung (sửa). `base`/`head`: Map tên → nội dung. */
export function appliedMigrationProblems(base, head) {
  const problems = [];
  for (const [name, content] of base) {
    if (!head.has(name)) problems.push(`${name}: migration đã có ở nhánh nền nhưng PR xoá/đổi tên`);
    else if (head.get(name) !== content)
      problems.push(`${name}: migration đã có ở nhánh nền nhưng PR sửa nội dung`);
  }
  return problems;
}

/** Khoá của sổ `migrations` (đối tượng `{ "0001_x": m0001, … }`) trong index.ts; rỗng nếu không tìm thấy sổ. */
export function registryKeys(indexSource) {
  const at = indexSource.search(/\bmigrations\b[^=\n]*=\s*\{/);
  if (at < 0) return [];
  const body = indexSource.slice(indexSource.indexOf("{", at));
  return [...body.matchAll(/^\s*"(\d{4}_[^"]+)"\s*:/gm)].map((m) => m[1]);
}

/** Danh sách vi phạm: khoá sổ migration có ở nền mà index.ts của PR thiếu. */
export function registryProblems(baseIndex, headIndex) {
  const baseKeys = registryKeys(baseIndex);
  if (baseKeys.length === 0)
    return [
      "index.ts của nhánh nền: không tìm thấy sổ `migrations` (đổi định dạng sổ → sửa schema-compat.mjs)",
    ];
  const head = new Set(registryKeys(headIndex));
  return baseKeys
    .filter((k) => !head.has(k))
    .map((k) => `index.ts: sổ migration của PR thiếu khoá ${k} có ở nhánh nền`);
}

const readIndex = (root) => {
  const f = join(root, MIGRATIONS_REL, "index.ts");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

const readMigrations = (root) => {
  const dir = join(root, MIGRATIONS_REL);
  return new Map(
    readdirSync(dir)
      .filter((f) => MIGRATION.test(f))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );
};

export function overlay(baseRoot, headRoot) {
  for (const root of [baseRoot, headRoot]) {
    if (!root || !existsSync(join(root, MIGRATIONS_REL))) {
      process.stderr.write(`không có ${MIGRATIONS_REL} trong ${root}\n`);
      return 1;
    }
  }
  const base = readMigrations(baseRoot);
  const head = readMigrations(headRoot);
  const problems = appliedMigrationProblems(base, head);
  problems.push(...registryProblems(readIndex(baseRoot), readIndex(headRoot)));
  for (const f of BASELINE_FILES)
    if (existsSync(join(baseRoot, f)) && !existsSync(join(headRoot, f)))
      problems.push(`${f}: file nền có ở nhánh nền nhưng PR xoá`);
  for (const p of problems) process.stderr.write(`LỖI: ${p}\n`);
  if (problems.length > 0) return 1;
  cpSync(join(headRoot, MIGRATIONS_REL), join(baseRoot, MIGRATIONS_REL), { recursive: true });
  for (const f of BASELINE_FILES)
    if (existsSync(join(headRoot, f))) cpSync(join(headRoot, f), join(baseRoot, f));
  const added = [...head.keys()].filter((f) => !base.has(f));
  process.stdout.write(
    `[schema-compat] ${head.size} migration (schema N) áp cho code nền (N−1); mới trong PR: ${added.length}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, base, head] = process.argv.slice(2);
  if (cmd === "overlay") process.exit(overlay(base, head));
  process.stderr.write("Dùng: schema-compat.mjs overlay <nền> <PR>\n");
  process.exit(2);
}
