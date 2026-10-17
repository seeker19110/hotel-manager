#!/usr/bin/env bash
# pre-bash-guard.sh — PreToolUse hook (matcher: Bash). Ba việc, theo thứ tự:
#  1) DENY lệnh phá huỷ / không đảo ngược (deny chặn cả ở bypassPermissions).
#  2) ASK lệnh "hành động đối ngoại" (riêng `gh pr merge` qua `xt.py merge-check` → có thể ALLOW, ADR-0013), nới hàng rào, ghi file cổng/bí mật qua Bash (điểm dừng bắt buộc — 11-autonomous-loop).
#  3) Khi là `git commit`: chạy cổng chất lượng qua dev-task.sh gate; đỏ → chặn (exit 2).
# Phân tích lệnh nằm ở guard.py (tách theo token shell, chuẩn hoá wrapper/tuỳ chọn git — audit AUD-SEC-001…010).
# Payload đi qua stdin, không qua argv. guard.py lỗi/thiếu python3 → cho qua (fail-open về luồng), trừ merge/`gh api`.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
# Lệnh merge/ghi GitHub trong payload (regex của bash, không cần grep/python3): `gh  pr merge`, `gh\tpr`, `gh pr -R o/r
# merge` (AUD-SEC-031). JSON mã hoá tab thành `\t`.
merge_re='gh([[:space:]]|\\t)+(pr([[:space:]]|\\t).*merge|api)'
merge_like() { [[ $payload =~ $merge_re ]]; }
# Không có python3 thì guard không chạy (fail-open về luồng) — riêng merge/ghi GitHub vẫn hỏi người, vì settings không còn
# luật ask cho `gh pr merge` (ADR-0013; AUD-SEC-021). In JSON bằng printf: _lib.sh cũng cần python3.
if ! command -v python3 >/dev/null 2>&1; then
  if merge_like; then
    printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "Khung cần xác nhận: không có python3 nên guard không kiểm được merge/ghi GitHub"}}'
  fi
  exit 0
fi
# guard.py bị dời/xoá (vd `mv .claude/hooks/guard.py …`) không phải lỗi chạy: hàng rào đã bị gỡ → hỏi mọi lệnh tới khi
# khôi phục (AUD-SEC-019). guard.py có mà lỗi giữa chừng → vẫn fail-open về luồng (ADR-0002).
[ -f "$(dirname "$0")/guard.py" ] || pretool_decision ask "Khung cần xác nhận: thiếu .claude/hooks/guard.py — hàng rào không chạy; khôi phục (git checkout hoặc install.py) rồi làm tiếp"
res="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$XT_ROOT" python3 "$(dirname "$0")/guard.py" bash 2>/dev/null)" || res=""
if [ -z "$res" ]; then # guard.py chết (lỗi cú pháp, bị kill): luồng đi tiếp, riêng merge/`gh api` hỏi (AUD-HAR-040)
  merge_like && pretool_decision ask "Khung cần xác nhận: guard.py lỗi nên không kiểm được merge/ghi GitHub"
  exit 0
fi
decision="$(json_field "$res" decision)"
[ "$decision" = "deny" ] && pretool_decision deny "$(json_field "$res" reason)"

# ---- 3) Cổng trước commit (chạy TRƯỚC khi hỏi người — ask không được bỏ cổng, AUD-HAR-013) ----
# `--no-verify` là chính câu hỏi "bỏ cổng?" → không chạy cổng, để người quyết.
if [ "$(json_field "$res" commit)" = "true" ] && [ "$(json_field "$res" no_verify)" != "true" ]; then
  # Gốc cổng = repo NHẬN commit (`cd ../repo-khac && git commit`, `git -C …`), không mặc định gốc phiên: từng chạy
  # cổng của dự án phiên cho commit ở repo khác (đỏ/xanh không liên quan). Repo git lồng trong dự án mà không có
  # xt.yaml/.xtemplates riêng (submodule, apps/web) → vẫn dùng cổng của dự án. Repo NGOÀI dự án → hỏi người, không
  # chạy cổng của nó: cổng là mã của repo đó (repo vừa clone) và hook chạy TRƯỚC bước hỏi quyền (AUD-SEC-015).
  groot="$XT_ROOT"
  cdir="$(json_field "$res" commit_dir)"
  top=""
  [ -n "$cdir" ] && top="$(git -C "$cdir" rev-parse --show-toplevel 2>/dev/null)"
  # git trả đường dẫn vật lý; gốc dự án có thể đi qua symlink (macOS: /var → /private/var) → so theo `pwd -P`.
  xroot="$(cd "$XT_ROOT" 2>/dev/null && pwd -P)" || xroot="$XT_ROOT"
  if [ -n "$top" ] && [ "$top" != "$xroot" ]; then
    case "$top/" in
    "$xroot"/*) { [ -e "$top/xt.yaml" ] || [ -d "$top/.xtemplates" ]; } && groot="$top" ;;
    *)
      # Dự án nằm TRONG repo cha (monorepo `apps/web`, phiên mở ở thư mục con): commit của chính dự án → cổng dự án.
      case "$xroot/" in
      "$top"/*) ;;
      *) pretool_decision ask "Khung cần xác nhận: commit vào repo ngoài dự án ($top) — cổng của repo đó không chạy tự động (là mã của repo đó); chạy cổng của nó trước rồi xác nhận" ;;
      esac
      ;;
    esac
  fi
  gate=""
  for g in "$groot/scripts/dev-task.sh" "$groot/.xtemplates/scripts/dev-task.sh" \
    "$XT_ROOT/scripts/dev-task.sh" "$XT_ROOT/.xtemplates/scripts/dev-task.sh"; do
    [ -x "$g" ] && { gate="$g"; break; }
  done
  if [ -n "$gate" ]; then
    # stdout của cổng sang stderr: stdout của hook chỉ được chứa JSON quyết định.
    if ! CLAUDE_PROJECT_DIR="$groot" "$gate" gate >&2; then
      echo "❌ Cổng trước commit ĐỎ (build/typecheck/lint/test) ở $groot. Sửa rồi commit lại." >&2
      exit 2
    fi
  fi
  # Nhắc (không chặn) khi diff lớn: cổng máy chỉ bắt lỗi cú pháp, không bắt lỗi logic.
  lines="$(git -C "$groot" diff --cached --numstat 2>/dev/null | awk '{a+=$1; d+=$2} END{print a+d+0}')"
  files="$(git -C "$groot" diff --cached --name-only 2>/dev/null | grep -c . || true)"
  if [ "${lines:-0}" -ge 300 ] || [ "${files:-0}" -ge 10 ]; then
    echo "💡 Diff staged lớn (${files} file, ~${lines} dòng). Cân nhắc chia nhỏ commit hoặc chạy /review trước." >&2
  fi
fi
[ "$decision" = "ask" ] && pretool_decision ask "$(json_field "$res" reason)"
# allow chỉ do guard.py trả cho `gh pr merge` đứng một mình đã qua `xt.py merge-check` (ADR-0013).
[ "$decision" = "allow" ] && pretool_decision allow "$(json_field "$res" reason)"
exit 0
