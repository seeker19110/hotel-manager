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

# Chạy file Python của khung bằng `import` thay vì như script: script chính không được cache bytecode nên Python biên
# dịch lại mỗi lần (guard.py ~25 ms, xt.py ~50 ms — trả ở MỌI lệnh Bash/Edit). sys.path[0] = thư mục của file như khi
# chạy script (không lấy cwd). Cache đặt ngoài repo (PYTHONPYCACHEPREFIX) để không đẻ `__pycache__` trong dự án đích
# chưa ignore nó; thư mục cache không ghi được thì Python bỏ qua (chỉ chậm như cũ).
py_run() { # $1=đường dẫn .py (có main()) $2…=đối số
  PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-${XDG_CACHE_HOME:-${HOME:-}/.cache}/xtemplates/pycache}" python3 -c '
import sys
d, _, f = sys.argv[1].rpartition("/")
sys.path[0] = d or "."
sys.argv = sys.argv[1:]
sys.exit(__import__(f[:-3]).main())
' "$@"
}

# Chạy guard.py một lần, đặt XG_DECISION XG_REASON XG_COMMIT XG_NO_VERIFY XG_COMMIT_DIR (định dạng `nul` của guard.py) — không
# sinh thêm tiến trình python để tách trường. Trả 1 khi guard.py không trả kết quả (lỗi cú pháp, bị kill, thiếu file).
# Gọi bằng `guard_fields <mode> <<<"$payload"` (không qua ống: ống chạy hàm trong subshell, mất biến).
# shellcheck disable=SC2034 # XG_* là kết quả cho hook đã source file này
guard_fields() { # $1=bash|edit|mcp
  local ok=""
  XG_DECISION="" XG_REASON="" XG_COMMIT="" XG_NO_VERIFY="" XG_COMMIT_DIR=""
  {
    IFS= read -r -d '' ok
    IFS= read -r -d '' XG_DECISION
    IFS= read -r -d '' XG_REASON
    IFS= read -r -d '' XG_COMMIT
    IFS= read -r -d '' XG_NO_VERIFY
    IFS= read -r -d '' XG_COMMIT_DIR
  } < <(CLAUDE_PROJECT_DIR="$XT_ROOT" py_run "$(dirname "$0")/guard.py" "$1" nul 2>/dev/null)
  [ "$ok" = ok ]
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

# Không kiểm được thứ phải kiểm (merge khi guard vắng/lỗi — ADR-0019, AUD-SEC-045): strict hỏi, mặc định CHẶN. Luôn exit 0.
fence_closed() { # $1=lý do
  [ "${XT_GUARD_POLICY:-}" = strict ] && pretool_decision ask "$1"
  pretool_decision deny "${1#Khung cần xác nhận: }"
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
