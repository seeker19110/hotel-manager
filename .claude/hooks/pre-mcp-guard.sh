#!/usr/bin/env bash
# pre-mcp-guard.sh — PreToolUse hook (matcher: tool MCP merge PR, ghi PR/commit). Hỏi người (AUD-SEC-020), trừ merge ghim
# `expectedHeadSha` mà `xt.py merge-check` = merge (ADR-0014) và bật auto-merge ở `merge_autonomy` L3 (ADR-0015).
# Quyết định ở guard.py (`mcp`); thiếu python3, thiếu guard.py hoặc guard.py lỗi → không kiểm được ngoại lệ cứng: chặn
# (XT_GUARD_POLICY=strict: hỏi) — ADR-0019, AUD-SEC-045; riêng tool tắt auto-merge cho qua (LOOP-STOP-005 đòi).
# Tool ghi PR/commit (tạo/sửa PR, commit file): guard chặn ghi công AI (LOOP-HARNESS-027); guard không chạy được thì
# cho qua — không phải hành động nguy hiểm (fail-open về luồng, ADR-0002, D-057).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
disable_re='"tool_name"[[:space:]]*:[[:space:]]*"[^"]*disable'
# Lối tắt chỉ khi payload có ĐÚNG MỘT khoá `"tool_name"` (khoá lồng trong `tool_input` của tool merge từng né guard —
# AUD-SEC-066); có hơn một → guard đọc `tool_name` cấp đầu từ JSON đã parse.
tool_key_re='"tool_name"[[:space:]]*:'
after_first="${payload#*\"tool_name\"}"
[[ $payload =~ $disable_re ]] && ! [[ $after_first =~ $tool_key_re ]] && exit 0
merge_re='"tool_name"[[:space:]]*:[[:space:]]*"[^"]*(merge_pull_request|auto_merge)'
open=""
[[ $payload =~ $merge_re ]] || open=1
if ! command -v python3 >/dev/null 2>&1; then
  [ -n "$open" ] && exit 0
  d=deny
  [ "${XT_GUARD_POLICY:-}" = strict ] && d=ask
  printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "'"$d"'", "permissionDecisionReason": "Khung cần xác nhận: không có python3 nên guard không kiểm được merge qua MCP"}}'
  exit 0
fi
if ! [ -f "$(dirname "$0")/guard.py" ]; then
  [ -n "$open" ] && exit 0
  fence_closed "Khung cần xác nhận: thiếu .claude/hooks/guard.py — không kiểm được merge qua MCP"
fi
if ! guard_fields mcp <<<"$payload"; then
  [ -n "$open" ] && exit 0
  fence_closed "Khung cần xác nhận: guard.py lỗi nên không kiểm được merge qua MCP"
fi
# deny: chính sách ADR-0018 đổi ask nguy hiểm (ngoại lệ cứng — ADR-0019) thành chặn.
[ "$XG_DECISION" = "deny" ] && pretool_decision deny "$XG_REASON"
[ "$XG_DECISION" = "ask" ] && pretool_decision ask "Khung cần xác nhận: $XG_REASON"
# allow chỉ khi merge ghim `expectedHeadSha` và `xt.py merge-check` = merge cho đúng PR/repo (ADR-0014).
[ "$XG_DECISION" = "allow" ] && pretool_decision allow "Khung cho tự merge (ADR-0014) — $XG_REASON"
exit 0
