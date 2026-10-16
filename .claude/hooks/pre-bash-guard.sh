#!/usr/bin/env bash
# pre-bash-guard.sh — PreToolUse hook (matcher: Bash). Ba việc, theo thứ tự:
#  1) DENY lệnh phá huỷ / không đảo ngược (deny chặn cả ở bypassPermissions).
#  2) ASK lệnh "hành động đối ngoại" (riêng `gh pr merge` qua `xt.py merge-check` → có thể ALLOW, ADR-0013), nới hàng rào, ghi file cổng/bí mật qua Bash (điểm dừng bắt buộc — 11-autonomous-loop).
#  3) Khi là `git commit`: chạy cổng chất lượng qua dev-task.sh gate; đỏ → chặn (exit 2).
# Phân tích lệnh nằm ở guard.py (tách theo token shell, chuẩn hoá wrapper/tuỳ chọn git — audit AUD-SEC-001…010).
# Payload đi qua stdin, không qua argv. guard.py lỗi/thiếu python3 → cho qua (fail-open về luồng).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
res="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$XT_ROOT" python3 "$(dirname "$0")/guard.py" bash 2>/dev/null)" || exit 0
[ -n "$res" ] || exit 0
decision="$(json_field "$res" decision)"
[ "$decision" = "deny" ] && pretool_decision deny "$(json_field "$res" reason)"

# ---- 3) Cổng trước commit (chạy TRƯỚC khi hỏi người — ask không được bỏ cổng, AUD-HAR-013) ----
# `--no-verify` là chính câu hỏi "bỏ cổng?" → không chạy cổng, để người quyết.
if [ "$(json_field "$res" commit)" = "true" ] && [ "$(json_field "$res" no_verify)" != "true" ]; then
  # Gốc cổng = repo NHẬN commit (`cd ../repo-khac && git commit`, `git -C …`), không mặc định gốc phiên: từng chạy
  # cổng của dự án phiên cho commit ở repo khác (đỏ/xanh không liên quan). Repo git lồng trong dự án mà không có
  # xt.yaml/.xtemplates riêng (submodule, apps/web) → vẫn dùng cổng của dự án.
  groot="$XT_ROOT"
  cdir="$(json_field "$res" commit_dir)"
  top=""
  [ -n "$cdir" ] && top="$(git -C "$cdir" rev-parse --show-toplevel 2>/dev/null)"
  # git trả đường dẫn vật lý; gốc dự án có thể đi qua symlink (macOS: /var → /private/var) → so theo `pwd -P`.
  xroot="$(cd "$XT_ROOT" 2>/dev/null && pwd -P)" || xroot="$XT_ROOT"
  if [ -n "$top" ] && [ "$top" != "$xroot" ]; then
    if [ -e "$top/xt.yaml" ] || [ -d "$top/.xtemplates" ]; then
      groot="$top"
    else
      case "$top/" in "$xroot"/*) ;; *) groot="$top" ;; esac
    fi
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
