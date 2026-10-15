#!/usr/bin/env bash
# Commit chỉ khi cổng xanh — exit code thật của dev-task.sh gate (không qua pipe), rồi push nhánh hiện tại.
# Dùng: scripts/commit-gated.sh "<conventional commit message>"
set -euo pipefail
msg="${1:?thiếu commit message}"
root="$(cd "$(dirname "$0")/.." && pwd)"
log="$(mktemp)"
if ! NEXT_TELEMETRY_DISABLED=1 "$root/.xtemplates/scripts/dev-task.sh" gate >"$log" 2>&1; then
  tail -40 "$log" >&2
  echo "✗ Cổng đỏ — không commit." >&2
  exit 1
fi
tail -1 "$log"
git -C "$root" add -A
git -C "$root" commit -q -m "$msg"
git -C "$root" push -q origin "$(git -C "$root" branch --show-current)"
git -C "$root" log --oneline -1
