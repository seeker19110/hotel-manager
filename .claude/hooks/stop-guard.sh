#!/usr/bin/env bash
# stop-guard.sh — Stop hook. Khi autopilot đang bật, quyết định cho dừng hay bắt làm tiếp
# CHỈ từ bằng chứng trên đĩa (.autopilot/state.json + evidence/ + PLAN.md), không tin lời model.
# Toàn bộ logic ở `xt.py loop hook-stop` (có test). Hook này chỉ chuyển stdin và fail-open.
# Claude Code tự ngắt sau 8 lần chặn liên tiếp không có tool call (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
# Đang trong lượt do chính Stop hook kích (stop_hook_active=true) vẫn phải kiểm lại bằng chứng —
# xt.py tự đếm vòng và có trần, nên không cần thoát sớm ở đây.
XT="$(xt_py)" || exit 0
printf '%s' "$payload" | python3 "$XT" loop hook-stop 2>/dev/null || exit 0
exit 0
