#!/usr/bin/env node
// PR `fix:` phải kèm test tái hiện (QA-STRAT-005; PLAN đợt 9 T-805): tiêu đề `fix(...)` mà diff có mã nhưng KHÔNG đổi file test
// nào → đỏ (`fix(deps)` chỉ đổi manifest/lockfile → miễn). Miễn trừ có lý do thật: dòng `Không cần test — lý do: <≥ 12 ký tự>` trong mô tả PR. Diff chỉ gồm tài liệu → không đòi.
// Dùng: node scripts/fix-requires-test.mjs --title "fix(x): …" [--body-file pr.md] (danh sách file đổi: stdin, mỗi dòng một đường dẫn)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIX_TITLE = /^fix(?:\([^)]*\))?!?: \S/;
// Cùng định nghĩa "file test" với TEST_PATH_RE của xt.py (merge-check 'đổi mã mà không đổi test'): thư mục tests?/__tests__/spec/e2e,
// hậu tố _test/.test/.spec/_spec, tên test_*.
export const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|(?:_test|\.test|\.spec|_spec)\.[^/]+$|(?:^|\/)test_[^/]+$/;
// `fix(deps)`: chỉ đổi manifest/lockfile (Dependabot/Renovate) thì không có logic để viết test tái hiện.
const DEPS_SCOPE = /^fix\((?:deps|deps-dev)\)!?: /;
const DEPS_PATH =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|go\.(?:mod|sum)|Cargo\.(?:toml|lock))$/;
const DOC_PATH = /^(?:docs\/|.*\.md$|LICENSE|\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE))/;

/** → { ok, reason } */
export function checkFixHasTest(title, files, body = "") {
  if (!FIX_TITLE.test(title.trim())) return { ok: true, reason: "không phải PR fix:" };
  const changed = files.map((f) => f.trim()).filter(Boolean);
  if (changed.some((f) => TEST_PATH.test(f))) return { ok: true, reason: "có file test thay đổi" };
  if (changed.every((f) => DOC_PATH.test(f))) return { ok: true, reason: "diff chỉ có tài liệu" };
  if (DEPS_SCOPE.test(title.trim()) && changed.every((f) => DEPS_PATH.test(f) || DOC_PATH.test(f)))
    return { ok: true, reason: "fix(deps) chỉ đổi manifest/lockfile" };
  if (/^Không cần test — lý do:\s*\S.{11,}$/m.test(body))
    return { ok: true, reason: "có miễn trừ ghi lý do" };
  return {
    ok: false,
    reason:
      'PR fix: phải đổi ít nhất một file test (test tái hiện lỗi, đỏ trước khi sửa) hoặc ghi "Không cần test — lý do: …" ở mô tả PR',
  };
}

function main(argv) {
  const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const title = arg("--title") ?? "";
  const bodyFile = arg("--body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : "";
  const files = readFileSync(0, "utf8").split("\n");
  const r = checkFixHasTest(title, files, body);
  process.stdout.write(`${r.ok ? "OK" : "ĐỎ"}: ${r.reason}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
