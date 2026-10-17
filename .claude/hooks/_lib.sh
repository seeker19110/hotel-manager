#!/usr/bin/env bash
# _lib.sh — hàm dùng chung cho hook của khung X-Templates. Nguồn (source) từ hook khác.
# Mọi hook: fail-open (lỗi của hook không được kẹt phiên), chỉ dùng bash + python3 (jq tùy chọn).

XT_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Đường dẫn xt.py: dự án đích cài khung vào .xtemplates/, còn repo khung thì ở scripts/.
xt_py() {
  for p in "$XT_ROOT/.xtemplates/scripts/xt.py" "$XT_ROOT/scripts/xt.py"; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

# Đọc một trường trong payload JSON (stdin của hook) bằng python3; rỗng nếu thiếu.
json_field() { # $1=payload $2=đường dẫn dạng a.b.c
  printf '%s' "$1" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None:
        sys.exit(0)
sys.stdout.write(d if isinstance(d, str) else json.dumps(d, ensure_ascii=False))
' "$2" 2>/dev/null
}

# In JSON quyết định PreToolUse (deny|ask|allow) kèm lý do, rồi exit 0.
pretool_decision() { # $1=deny|ask $2=lý do
  python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
      "permissionDecision": sys.argv[1], "permissionDecisionReason": sys.argv[2]}}, ensure_ascii=False))
' "$1" "$2"
  exit 0
}

# Hỏi người CHỈ khi `XT_GUARD_POLICY=strict` (hành vi cũ); mặc định cho qua để phiên không dừng chờ (ADR-0018). Luôn exit 0.
ask_strict() { # $1=lý do
  [ "${XT_GUARD_POLICY:-}" = strict ] && pretool_decision ask "$1"
  exit 0
}

# Cắt stdin tối đa $1 byte KHÔNG cắt giữa ký tự UTF-8 (head -c từng làm hỏng tiếng Việt — AUD-HAR-011).
utf8_head() {
  python3 -c 'import sys; sys.stdout.write(sys.stdin.buffer.read()[: int(sys.argv[1])].decode("utf-8", "ignore"))' "$1" 2>/dev/null
}

# In JSON additionalContext cho SessionStart/UserPromptSubmit.
context_output() { # $1=hookEventName $2=nội dung
  python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": sys.argv[1],
      "additionalContext": sys.argv[2]}}, ensure_ascii=False))
' "$1" "$2"
}
