#!/usr/bin/env bash
# auto-format.sh — PostToolUse hook (matcher: Edit|Write|MultiEdit).
# Format ĐÚNG file vừa sửa qua dev-task.sh format-file của khung (tự dò formatter theo stack).
# No-op an toàn khi không có formatter. Luôn exit 0.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
path="$(json_field "$payload" tool_input.file_path)"
[ -n "$path" ] || exit 0
# Bản của khung trước (như `xt_py`): dự án đích có `scripts/dev-task.sh` riêng trùng tên thì không bị gọi (AUD-HAR-049).
for g in "$XT_ROOT/.xtemplates/scripts/dev-task.sh" "$XT_ROOT/scripts/dev-task.sh"; do
  if [ -x "$g" ]; then "$g" format-file "$path" >/dev/null 2>&1 || true; break; fi
done
exit 0
