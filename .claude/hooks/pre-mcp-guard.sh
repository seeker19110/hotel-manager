#!/usr/bin/env bash
# pre-mcp-guard.sh — PreToolUse hook (matcher: tool MCP merge PR). Hỏi người (AUD-SEC-020), trừ merge ghim
# `expectedHeadSha` mà `xt.py merge-check` = merge (ADR-0014) và bật auto-merge ở `merge_autonomy` L3 (ADR-0015).
# Quyết định ở guard.py (`mcp`); thiếu python3, thiếu guard.py hoặc guard.py lỗi → không kiểm được ngoại lệ cứng: chặn
# (XT_GUARD_POLICY=strict: hỏi) — ADR-0019, AUD-SEC-045; riêng tool tắt auto-merge cho qua (LOOP-STOP-005 đòi).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
disable_re='"tool_name"[[:space:]]*:[[:space:]]*"[^"]*disable'
[[ $payload =~ $disable_re ]] && exit 0
if ! command -v python3 >/dev/null 2>&1; then
  d=deny
  [ "${XT_GUARD_POLICY:-}" = strict ] && d=ask
  printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "'"$d"'", "permissionDecisionReason": "Khung cần xác nhận: không có python3 nên guard không kiểm được merge qua MCP"}}'
  exit 0
fi
[ -f "$(dirname "$0")/guard.py" ] || fence_closed "Khung cần xác nhận: thiếu .claude/hooks/guard.py — không kiểm được merge qua MCP"
guard_fields mcp <<<"$payload" || fence_closed "Khung cần xác nhận: guard.py lỗi nên không kiểm được merge qua MCP"
# deny: chính sách ADR-0018 đổi ask nguy hiểm (ngoại lệ cứng — ADR-0019) thành chặn.
[ "$XG_DECISION" = "deny" ] && pretool_decision deny "$XG_REASON"
[ "$XG_DECISION" = "ask" ] && pretool_decision ask "Khung cần xác nhận: $XG_REASON"
# allow chỉ khi merge ghim `expectedHeadSha` và `xt.py merge-check` = merge cho đúng PR/repo (ADR-0014).
[ "$XG_DECISION" = "allow" ] && pretool_decision allow "Khung cho tự merge (ADR-0014) — $XG_REASON"
exit 0
