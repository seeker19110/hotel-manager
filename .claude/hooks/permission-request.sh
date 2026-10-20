#!/usr/bin/env bash
# permission-request.sh — hook PermissionRequest (command). Chạy khi Claude Code sắp hỏi quyền, cả phiên headless
# (`claude -p`): trả `hookSpecificOutput.decision` từ CÙNG quyết định có kiểu của guard.py (REC-04) — deny/allow; ask
# hoặc không phản đối → không in gì (phiên tương tác hiện hộp thoại, headless thì Claude Code deny — chiều chặt).
# Thiếu python3/guard.py hoặc guard lỗi → không in gì (fail-open về luồng; headless vẫn deny). Luôn exit 0.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
command -v python3 >/dev/null 2>&1 || exit 0
[ -f "$(dirname "$0")/guard.py" ] || exit 0
CLAUDE_PROJECT_DIR="$XT_ROOT" py_run "$(dirname "$0")/guard.py" permission <<<"$payload" 2>/dev/null
exit 0
