#!/usr/bin/env bash
# pre-compact.sh — PreCompact hook (manual|auto). Trước khi Claude Code nén context, ghi vị trí làm việc
# (task đang làm, lệnh kiểm cuối + exit code, file chưa commit, lỗi lặp) vào .autopilot/state.json để
# SessionStart(compact) nạp lại qua `xt.py loop status` — chế độ một phiên (ADR-0009, LOOP-CTX-017).
# LUÔN exit 0 và không in quyết định: PreCompact exit 2 / "decision":"block" sẽ CHẶN compaction — phiên kẹt
# vì context đầy. Toàn bộ logic ở `xt.py loop checkpoint` (có test). Chưa `loop init` → không làm gì.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
XT="$(xt_py)" || exit 0
printf '%s' "$payload" | python3 "$XT" loop checkpoint >/dev/null 2>&1 || true
exit 0
