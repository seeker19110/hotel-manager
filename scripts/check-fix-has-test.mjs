// Rào hồi quy (FE-TEST-006): PR `fix` phải chạm ít nhất một file test (tái hiện lỗi đỏ trước, xanh sau). CI job `regression` gọi
//   node scripts/check-fix-has-test.mjs "<tiêu đề PR>" <base-ref>
// Hàm thuần `checkFixHasTest` được unit test (scripts/check-fix-has-test.test.mjs).
import { execFileSync } from "node:child_process";

export const TEST_PATH = /(^|\/)[^/]+\.(test|spec)\.(ts|tsx|mjs|js)$|(^|\/)test_[^/]+\.py$|(^|\/)testkit\//;
const FIX_TITLE = /^fix(\([^)]*\))?!?:/i;

export const isFixTitle = (title) => FIX_TITLE.test(String(title ?? "").trim());

/** {ok, reason}: PR không phải `fix` → ok; PR `fix` mà không file test nào đổi → không ok. */
export function checkFixHasTest(title, changedFiles) {
  if (!isFixTitle(title)) return { ok: true, reason: "không phải PR fix" };
  const tests = changedFiles.filter((f) => TEST_PATH.test(f));
  if (tests.length === 0)
    return {
      ok: false,
      reason: "PR `fix:` phải kèm test tái hiện lỗi (file *.test.* / *.spec.* mới hoặc sửa)",
    };
  return { ok: true, reason: `có ${tests.length} file test: ${tests.join(", ")}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [title, base = "origin/main"] = process.argv.slice(2);
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const r = checkFixHasTest(title, files);
  process.stdout.write(`${r.ok ? "OK" : "ĐỎ"}: ${r.reason}\n`);
  process.exit(r.ok ? 0 : 1);
}
