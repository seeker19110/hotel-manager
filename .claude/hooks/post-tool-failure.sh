#!/usr/bin/env bash
# post-tool-failure.sh — hook PostToolUseFailure (TD-5, T-1822). Lệnh Bash là cổng/Gate (`dev-task.sh`, `xt.py loop
# record`, `unittest`, `pytest`, `npm test`, …) vừa đỏ → `xt.py loop triage-local` phân loại output bằng bộ của
# `ci-triage` và trả ≤ 20 dòng lỗi đã che bí mật làm `additionalContext` — agent khỏi đọc lại log dài (LOOP-CTX-004).
# Chỉ gợi ý, không quyết. Toàn bộ logic ở xt.py (có test); hook chỉ chuyển stdin. Lệnh khác, payload rác, thiếu
# python3/xt.py, xt.py lỗi → không in gì (fail-open). Luôn exit 0.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
command -v python3 >/dev/null 2>&1 || exit 0
XT="$(xt_py)" || exit 0
printf '%s' "$payload" | py_run "$XT" loop triage-local 2>/dev/null || exit 0
exit 0
