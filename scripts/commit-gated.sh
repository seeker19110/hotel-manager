#!/usr/bin/env bash
# Commit chỉ khi cổng xanh — exit code thật của dev-task.sh gate (không qua pipe), rồi push nhánh hiện tại.
# Dùng: git add <file…> && scripts/commit-gated.sh "<conventional commit message>"
# Chỉ commit phần ĐÃ STAGE (không `git add -A`: từng gom nhầm file nháp/untracked vào commit — audit khung #6);
# từ chối nhánh chính/HEAD rời; cổng chạy trên đúng repo chứa script (CLAUDE_PROJECT_DIR = root).
set -euo pipefail
msg="${1:?thiếu commit message}"
root="$(cd "$(dirname "$0")/.." && pwd)"
export CLAUDE_PROJECT_DIR="$root"
branch="$(git -C "$root" branch --show-current)"
case "$branch" in
  "" ) echo "✗ HEAD rời (detached) — checkout nhánh trước khi commit." >&2; exit 1 ;;
  main|master ) echo "✗ Không commit/push thẳng lên $branch — dùng nhánh + PR." >&2; exit 1 ;;
esac
if git -C "$root" diff --cached --quiet; then
  echo "✗ Chưa stage gì — git add <file…> trước." >&2
  exit 1
fi
log="$(mktemp)"
if ! NEXT_TELEMETRY_DISABLED=1 "$root/.xtemplates/scripts/dev-task.sh" gate >"$log" 2>&1; then
  tail -40 "$log" >&2
  echo "✗ Cổng đỏ — không commit." >&2
  exit 1
fi
tail -1 "$log"
git -C "$root" commit -q -m "$msg"
git -C "$root" push -q origin "$branch"
git -C "$root" log --oneline -1
