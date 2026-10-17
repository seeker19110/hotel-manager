// DB-MIG-003: migration đã có ở nhánh gốc không được sửa/xoá/đổi tên — chỉ được THÊM file mới, đánh số sau bản cuối của gốc.
// Dùng (CI job `pr-policy`, `fetch-depth: 0`): `node scripts/check-migrations-immutable.mjs --base origin/main`.
// So nội dung theo git: file nằm trong diff `BASE...HEAD` với trạng thái M/D/T = đã đổi so với bản của gốc. Test: scripts/history-guards.test.mjs.
import { argValue, changedEntries, filesAt, isMain, refExists } from "./git-history.mjs";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.ts$/;
/** Danh sách đăng ký: thêm migration mới = thêm một dòng ở đây nên được phép đổi. */
const REGISTRY = "index.ts";

const nameOf = (path, dir) => path.slice(dir.length + 1);

/**
 * @param {{ entries: {status: string, path: string}[], baseFiles: string[], dir?: string }} input
 *   entries: file đổi trong PR dưới `dir`; baseFiles: file có ở nhánh gốc dưới `dir`.
 * @returns {string[]} vi phạm (rỗng = đạt)
 */
export function findMigrationViolations({ entries, baseFiles, dir = MIGRATIONS_DIR }) {
  const violations = [];
  const baseNumbers = baseFiles
    .map((f) => MIGRATION_FILE.exec(nameOf(f, dir))?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  const maxBase = baseNumbers.length ? Math.max(...baseNumbers) : 0;
  const added = new Set();
  for (const { status, path } of entries) {
    const name = nameOf(path, dir);
    if (status === "A") {
      const m = MIGRATION_FILE.exec(name);
      if (name === REGISTRY) continue;
      if (!m) {
        violations.push(`${path}: tên migration mới phải dạng NNNN_ten_snake.ts`);
        continue;
      }
      const n = Number(m[1]);
      if (n <= maxBase) {
        violations.push(
          `${path}: số ${m[1]} không lớn hơn bản cuối của nhánh gốc (${String(maxBase).padStart(4, "0")}) — Kysely từ chối chèn trước, đánh số lại`,
        );
      }
      if (added.has(n)) violations.push(`${path}: trùng số migration ${m[1]} với một file mới khác`);
      added.add(n);
      continue;
    }
    if (name === REGISTRY && status !== "D") continue;
    violations.push(
      `${path}: migration đã có ở nhánh gốc không được ${status === "D" ? "xoá" : "sửa"} — sửa sai bằng migration mới (DB-MIG-003)`,
    );
  }
  return violations;
}

export function checkAgainst(base, cwd) {
  return findMigrationViolations({
    entries: changedEntries(base, [MIGRATIONS_DIR], cwd),
    baseFiles: filesAt(base, MIGRATIONS_DIR, cwd),
  });
}

function main() {
  const base = argValue(process.argv, "--base", "origin/main");
  if (!refExists(base)) {
    process.stderr.write(`không thấy nhánh gốc '${base}' — checkout cần fetch-depth: 0\n`);
    return 2;
  }
  const violations = checkAgainst(base);
  for (const v of violations) process.stderr.write(`✗ ${v}\n`);
  process.stdout.write(
    violations.length
      ? `${violations.length} vi phạm bất biến migration.\n`
      : `✓ Migration đã có ở ${base} không bị đổi.\n`,
  );
  return violations.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main());
