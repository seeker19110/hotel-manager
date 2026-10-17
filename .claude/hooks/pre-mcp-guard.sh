#!/usr/bin/env bash
# pre-mcp-guard.sh — PreToolUse hook (matcher: tool MCP merge PR). Hỏi người (AUD-SEC-020), trừ merge ghim
# `expectedHeadSha` mà `xt.py merge-check` = merge (ADR-0014) và bật auto-merge ở `merge_autonomy` L3 (ADR-0015).
# Quyết định ở guard.py (`mcp`); thiếu python3, thiếu guard.py hoặc guard.py lỗi → vẫn hỏi (fail-closed cho merge,
# AUD-HAR-040): matcher chỉ bắt tool merge, nên hỏi không làm kẹt luồng khác.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "Khung cần xác nhận: không có python3 nên guard không kiểm được merge qua MCP"}}'
  exit 0
fi
[ -f "$(dirname "$0")/guard.py" ] || pretool_decision ask "Khung cần xác nhận: thiếu .claude/hooks/guard.py — không kiểm được merge qua MCP"
res="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$XT_ROOT" python3 "$(dirname "$0")/guard.py" mcp 2>/dev/null)" || res=""
[ -n "$res" ] || pretool_decision ask "Khung cần xác nhận: guard.py lỗi nên không kiểm được merge qua MCP"
decision="$(json_field "$res" decision)"
[ "$decision" = "ask" ] && pretool_decision ask "Khung cần xác nhận: $(json_field "$res" reason)"
# allow chỉ khi merge ghim `expectedHeadSha` và `xt.py merge-check` = merge cho đúng PR/repo (ADR-0014).
[ "$decision" = "allow" ] && pretool_decision allow "Khung cho tự merge (ADR-0014) — $(json_field "$res" reason)"
exit 0
