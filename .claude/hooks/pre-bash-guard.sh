#!/usr/bin/env bash
# pre-bash-guard.sh — PreToolUse hook (matcher: Bash). Ba việc, theo thứ tự:
#  1) DENY lệnh phá huỷ / không đảo ngược và bật auto-merge của GitHub (`gh pr merge --auto`, ADR-0036) — deny chặn cả ở
#     bypassPermissions.
#  2) ASK (chỉ khi XT_GUARD_POLICY=strict; mặc định guard.py đổi ask nguy hiểm → deny, còn lại cho qua — ADR-0018) lệnh "hành động đối ngoại" (riêng `gh pr merge` qua `xt.py merge-check` → có thể ALLOW, ADR-0013), nới hàng rào, ghi file cổng/bí mật qua Bash (điểm dừng bắt buộc — 11-autonomous-loop).
#  3) Khi là `git commit`: chạy cổng chất lượng qua dev-task.sh gate (gate-fast khi xt.yaml `commit_gate: fast`); đỏ → chặn (exit 2).
# Phân tích lệnh ở guard.py; payload qua stdin. Guard hỏng: xem `broken` bên dưới.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
# Lệnh merge/ghi GitHub trong payload (regex của bash, không cần grep/python3): `gh  pr merge`, `gh\tpr`, `gh pr -R o/r
# merge` (AUD-SEC-031). JSON mã hoá tab thành `\t`.
merge_re='gh([[:space:]]|\\t)+(pr([[:space:]]|\\t).*merge|api)'
# `--disable-auto` (tắt auto-merge): auto-merge chỉ người bật được, máy phải tắt được (`pr next`/steward
# `disable-auto-merge` — ADR-0036, LOOP-STOP-005) — không chặn kể cả khi guard vắng; `--auto` (bật) vẫn rơi vào chặn.
# Chỉ đúng dạng `gh pr merge <số> --disable-auto` cả lệnh (chuỗi `--disable-auto` trong `--body` không tính — review #97).
disable_re='"command"[[:space:]]*:[[:space:]]*"[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+[[:space:]]+--disable-auto[[:space:]]*"'
merge_like() { [[ $payload =~ $merge_re ]] && ! [[ $payload =~ $disable_re ]]; }
# Không có python3 thì guard không chạy (fail-open về luồng) — riêng merge/ghi GitHub: không kiểm được ngoại lệ cứng →
# chặn (strict: hỏi), vì settings không còn luật ask cho `gh pr merge` (ADR-0013, ADR-0019; AUD-SEC-021/045). In JSON
# bằng printf: _lib.sh cũng cần python3.
if ! command -v python3 >/dev/null 2>&1; then
  if merge_like; then
    d=deny
    [ "${XT_GUARD_POLICY:-}" = strict ] && d=ask
    printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "'"$d"'", "permissionDecisionReason": "Khung cần xác nhận: không có python3 nên guard không kiểm được merge/ghi GitHub"}}'
  fi
  exit 0
fi
# Hàng rào bị gỡ → chặn mọi lệnh (strict: hỏi) trừ lệnh một dòng xem/khôi phục và tắt auto-merge (AUD-SEC-019/046/108):
# guard.py vắng/không đọc được/rỗng, hoặc không nạp được. `main()` của guard tự bắt mọi lỗi lúc chạy (fail-open về luồng,
# ADR-0002), nên không nạp được = file hỏng; không xét trạng thái git — agent tự đổi được (D-199, D-200).
broken() {
  cmd="$(json_field "$payload" tool_input.command)"
  # Khôi phục CHỈ guard.py (`git checkout -- .`/`restore .` xoá thay đổi chưa commit mà guard lành chặn — review #282
  # lượt 6); `scripts/install.py` là đối số đầu của python3 (không `-c …`); không cờ ghi file (`--output`) — review #97.
  restore_re='^[[:space:]]*git[[:space:]]+(checkout([[:space:]]+HEAD)?[[:space:]]+--|restore)[[:space:]]+(\./)?\.claude/hooks/guard\.py[[:space:]]*$'
  view_re='^[[:space:]]*(git[[:space:]]+(status|diff|log|show)|ls|cat|python3[[:space:]]+([^[:space:];&|`$<>-][^[:space:];&|`$<>]*/)?scripts/install\.py|gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+[[:space:]]+--disable-auto)([[:space:]][^;&|`$<>]*)?$'
  [[ $cmd != *$'\n'* && $cmd != *--output* && ($cmd =~ $restore_re || $cmd =~ $view_re) ]] && exit 0
  fence_closed "Khung cần xác nhận: .claude/hooks/guard.py $1 — hàng rào bị gỡ; khôi phục (git checkout -- .claude/hooks/guard.py hoặc install.py) rồi làm tiếp"
}
g="$(dirname "$0")/guard.py"
[ -f "$g" ] && [ -r "$g" ] && [ -s "$g" ] || broken "vắng/không đọc được/rỗng"
if ! guard_fields bash <<<"$payload"; then # guard.py chết: merge/`gh api` chặn (AUD-HAR-040/SEC-045)
  merge_like && fence_closed "Khung cần xác nhận: guard.py lỗi nên không kiểm được merge/ghi GitHub"
  broken "không nạp được (file hỏng hoặc python3 không phải CPython 3.15.x; có thể sửa bằng Edit)"
fi
decision="$XG_DECISION"
[ "$decision" = "deny" ] && pretool_decision deny "$XG_REASON"

gate_config_changed() { # $1=gốc repo → 0 nếu file đổi so với HEAD (đã/chưa stage, file mới) là cấu hình cổng
  local f
  # `.claude/hooks/guard.py` = hàng rào: nhiều test mở nó qua đường dẫn ghép mà test-select theo lớp không thấy (#678)
  while IFS= read -r f; do
    case "$f" in
    xt.yaml | .claude/settings.json | .claude/hooks/pre-bash-guard.sh | .claude/hooks/guard.py | scripts/dev-task.sh | \
      .xtemplates/scripts/dev-task.sh | scripts/xt.py | .xtemplates/scripts/xt.py | ruff.toml | */ruff.toml | .ruff.toml | */.ruff.toml | pyproject.toml | \
      */pyproject.toml | .coveragerc | */.coveragerc | requirements*.txt | */requirements*.txt | \
      pytest.py | conftest.py | */conftest.py | pytest.ini | .pytest.ini | pytest.toml | .pytest.toml | tox.ini | \
      setup.cfg) return 0 ;; # cấu hình pytest ở gốc: dev-task (`no:xdist`) và pytest đọc — review #446
    esac
  done < <(git -C "$1" -c core.quotePath=false diff --no-renames --relative --name-only HEAD -- 2>/dev/null
    git -C "$1" -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null)
  return 1
}

# Thư mục git của toplevel $1 (`--git-dir`|`--git-common-dir`), đường dẫn vật lý. Chạy được ở mọi git có worktree
# (2.5+): không dùng `--path-format` (2.31) hay `--absolute-git-dir` (2.13) — git cũ in nguyên cờ lạ ra stdout thành
# "đường dẫn" rác; đường tương đối git in ra tính theo thư mục chạy ($1). Không đọc được → 1, không in gì.
git_dir_of() { # $1=toplevel (vật lý) $2=--git-dir|--git-common-dir
  local d
  d="$(cd -P -- "$1" 2>/dev/null && git rev-parse "$2" 2>/dev/null)" && [ -n "$d" ] || return 1
  case "$d" in /*) ;; *) d="$1/$d" ;; esac
  (cd -P -- "$d" 2>/dev/null && pwd -P)
}

# Worktree của CHÍNH repo dự án (AUD-HAR-442): in gốc cổng trên worktree = `$1/<tiền tố của gốc dự án trong repo>`
# (monorepo `apps/web` → `<worktree>/apps/web`). 1 = repo khác (hoặc dự án không có trên worktree) → luật cũ; 2 = git
# không trả lời được (không xác định). Cùng `--git-common-dir` chưa đủ: thư mục lạ có `.git` trỏ vào gitdir của repo này
# (hoặc gitdir tự dựng có `commondir` trỏ về) giả được → kiểm thêm LIÊN KẾT NGƯỢC: checkout chính = `$1/.git` là THƯ MỤC
# THẬT (không symlink), chính là common-dir và cha của common-dir là `$1`; worktree liên kết = `$1/.git` là TỆP thật
# (không symlink), gitdir nằm ngay dưới `<common>/worktrees/` và tệp `gitdir` trong đó trỏ đúng `$1/.git`. `-d`/`-f`/`cd`
# đi theo symlink ở thành phần cuối: `.git` symlink tới common-dir/admin (giải nén được từ tar) từng qua (review #680
# R2-1) → mọi phép thử trên `.git` kèm `! -L`. Không đọc `git worktree list --porcelain`: không `-z` thì đường dẫn có
# xuống dòng chèn được dòng `worktree <thư mục lạ>` giả, còn `-z` cần git 2.36. Checkout chính có `.git` là symlink
# (hiếm) → luật cũ.
same_repo_root() { # $1=gốc repo nhận commit (vật lý) $2=gốc dự án (vật lý)
  local xtop c1 c2 gd p="" pre r
  xtop="$(git -C "$2" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$xtop" ] || return 2
  c1="$(git_dir_of "$1" --git-common-dir)" && c2="$(git_dir_of "$xtop" --git-common-dir)" || return 2
  gd="$(git_dir_of "$1" --git-dir)" || return 2
  [ "$c1" = "$c2" ] && [ ! -L "$1/.git" ] || return 1
  if [ "$gd" = "$c1" ]; then
    [ -d "$1/.git" ] && [ "$(cd -P -- "$1/.git" 2>/dev/null && pwd -P)" = "$c1" ] &&
      [ "$(cd -P -- "$c1/.." 2>/dev/null && pwd -P)" = "$1" ] || return 1
  else
    # `read` trả 1 khi tệp thiếu xuống dòng cuối dù đã đọc được dòng (review #680 R2-2)
    [ -f "$1/.git" ] && [ "${gd%/*}" = "$c1/worktrees" ] && [ -f "$gd/gitdir" ] &&
      { IFS= read -r p || [ -n "$p" ]; } <"$gd/gitdir" || return 1
    case "$p" in /*) ;; *) p="$gd/$p" ;; esac # `worktree.useRelativePaths` (git 2.48): tương đối theo gitdir
    # thư mục cha chuẩn hoá vật lý (macOS /var → /private/var); thành phần cuối so theo TÊN, tệp thật đã kiểm ở trên
    [ "${p##*/}" = .git ] && [ "$(cd -P -- "${p%/*}" 2>/dev/null && pwd -P)" = "$1" ] || return 1
  fi
  pre="$(git -C "$2" rev-parse --show-prefix 2>/dev/null)" || return 2
  # tiền tố dự án trên worktree không được đi qua symlink (`apps/web` → thư mục lạ): đường vật lý phải đúng `$1/<tiền tố>`
  r="$(cd -P -- "$1/$pre" 2>/dev/null && pwd -P)" && [ "$r" = "$1${pre:+/${pre%/}}" ] || return 1
  printf '%s\n' "$r"
}

# ---- 3) Cổng trước commit (chạy TRƯỚC khi hỏi người — ask không được bỏ cổng, AUD-HAR-013) ----
# `--no-verify` (hoặc `-c core.hooksPath=…`) chỉ tắt git hook, KHÔNG tắt cổng của khung: mặc định (không hỏi người, ADR-0018)
# vẫn chạy cổng — trước đây bỏ cổng lặng lẽ (rà stored 2026-10-18). Chỉ `XT_GUARD_POLICY=strict` để người quyết (hỏi).
if [ "$XG_COMMIT" = "true" ] && { [ "$XG_NO_VERIFY" != "true" ] || [ "${XT_GUARD_POLICY:-}" != "strict" ]; }; then
  # Gốc cổng = repo NHẬN commit (`cd ../repo-khac && git commit`, `git -C …`), không mặc định gốc phiên: từng chạy
  # cổng của dự án phiên cho commit ở repo khác (đỏ/xanh không liên quan). Chỉ tự chạy cổng của CHÍNH dự án: repo git
  # lồng trong dự án mà không có xt.yaml/.xtemplates riêng (submodule, apps/web) → cổng của dự án. Repo NGOÀI dự án,
  # hoặc repo lồng CÓ cổng riêng (repo bên thứ ba clone vào dự án) → hỏi người, không chạy cổng của nó: cổng là mã của
  # repo đó và hook chạy TRƯỚC bước hỏi quyền (AUD-SEC-015).
  groot="$XT_ROOT"
  cdir="$XG_COMMIT_DIR"
  top=""
  [ -n "$cdir" ] && top="$(git -C "$cdir" rev-parse --show-toplevel 2>/dev/null)"
  # git trả đường dẫn vật lý; gốc dự án có thể đi qua symlink (macOS: /var → /private/var) → so theo `pwd -P`.
  xroot="$(cd "$XT_ROOT" 2>/dev/null && pwd -P)" || xroot="$XT_ROOT"
  # Worktree của CHÍNH repo (`.claude/worktrees/<tên>` dưới gốc, hay ngoài gốc; cả checkout chính khi phiên mở trong
  # worktree) là mã của dự án, không phải repo khác → cổng chạy trên CHÍNH worktree: tệp đổi, xt.yaml, `commit_gate`,
  # `gate_config_changed` theo cây đó, và dev-task.sh của worktree (vòng `gate` dưới đây tìm ở `$groot` trước). Lý do
  # chọn script của worktree, không của gốc phiên: ở repo khung dev-task.sh/xt.py chính là mã đang phát triển trên nhánh
  # đó (script gốc phiên có thể cũ hơn, thiếu bước mới, lệch xt.yaml của worktree); mức phơi nhiễm bằng checkout chính
  # (worktree checkout nhánh fork/PR lạ chạy mã của nhánh đó — y như `git checkout` nhánh đó ở checkout chính). Không mở
  # đường hạ cổng mới: commit đổi dev-task.sh/xt.py/xt.yaml… của worktree vẫn bị `gate_config_changed` ép cổng đầy đủ
  # như ở checkout chính; đánh đổi y hệt checkout chính — commit sửa chính dev-task.sh chạy bản đã sửa (CI là lưới
  # cuối). Trước đây (AUD-HAR-442) rơi vào nhánh "repo lồng/ngoài" → bỏ cổng.
  wrc=1
  [ -n "$top" ] && [ "$top" != "$xroot" ] && { wroot="$(same_repo_root "$top" "$xroot")"; wrc=$?; }
  if [ "$wrc" = 0 ]; then
    groot="$wroot"
  elif [ -n "$top" ] && [ "$top" != "$xroot" ]; then
    # Không xác định được mà trông như worktree (`.git` là TỆP): luật cũ (không chạy cổng) — nói ra, không lặng lẽ bỏ
    # cổng; không chặn (fail-open về luồng, ADR-0002).
    if [ "$wrc" = 2 ] && [ -f "$top/.git" ]; then
      echo "⚠️ Không xác định được $top có phải worktree của chính dự án không (git không trả lời) — cổng commit KHÔNG chạy cho commit này; chạy cổng (dev-task.sh gate) ở đó trước khi đẩy." >&2
    fi
    case "$top/" in
    "$xroot"/*)
      if [ -e "$top/xt.yaml" ] || [ -d "$top/.xtemplates" ]; then
        ask_strict "Khung cần xác nhận: commit vào repo lồng có cổng riêng ($top) — cổng của repo đó không chạy tự động (là mã của repo đó); chạy cổng của nó trước rồi xác nhận"
      fi
      ;;
    *)
      # Dự án nằm TRONG repo cha (monorepo `apps/web`, phiên mở ở thư mục con): commit của chính dự án → cổng dự án.
      case "$xroot/" in
      "$top"/*) ;;
      *) ask_strict "Khung cần xác nhận: commit vào repo ngoài dự án ($top) — cổng của repo đó không chạy tự động (là mã của repo đó); chạy cổng của nó trước rồi xác nhận" ;;
      esac
      ;;
    esac
  fi
  gate=""
  # Bản của khung trước (như `xt_py`): `scripts/dev-task.sh` riêng của dự án đích không thay cổng khung (AUD-HAR-049).
  for g in "$groot/.xtemplates/scripts/dev-task.sh" "$groot/scripts/dev-task.sh" \
    "$XT_ROOT/.xtemplates/scripts/dev-task.sh" "$XT_ROOT/scripts/dev-task.sh"; do
    [ -x "$g" ] && { gate="$g"; break; }
  done
  if [ -n "$gate" ]; then
    # `commit_gate: fast` (xt.yaml của repo nhận commit) → cổng nhanh: format/lint/typecheck + test liên quan file đổi;
    # cổng đầy đủ (`dev-task.sh gate`, ngưỡng coverage) là CI (cục bộ trước cắt bản). Vắng/giá trị khác → đầy đủ như trước.
    # Đọc `commit_gate` bằng chính xt.py của khung cài cùng hook này (`commit-gate`: cùng cách đọc khoá với `doctor`/
    # `ci-check` — bỏ comment, dòng trùng lấy dòng cuối; AUD-XFEAT-017), không grep riêng. Không chạy được/giá trị lạ → full.
    task="gate"
    hooks="$(cd "$(dirname "$0")" && pwd)"
    for x in "$hooks/../../.xtemplates/scripts/xt.py" "$hooks/../../scripts/xt.py"; do
      [ -f "$x" ] || continue
      [ -f "$groot/xt.yaml" ] && [ "$(CLAUDE_PROJECT_DIR="$groot" py_run "$x" commit-gate 2>/dev/null)" = fast ] && task="gate-fast"
      break
    done
    # `commit_gate` đọc từ cây làm việc: commit đổi chính cấu hình cổng (xt.yaml → fast, ruff/coverage, dev-task.sh, xt.py
    # chọn test của gate-fast — AUD-TEST-013, hook này) không được tự hạ cổng cho nó → file đổi so với HEAD (như
    # XT_CHANGED_FILES; --no-renames giữ cả tên cũ) đụng cấu hình cổng thì chạy cổng đầy đủ.
    # Không hạ cổng nhưng cũng không chạy lại ngưỡng coverage lẫn `build` (131 s so với 4,5 s; 49 % commit đụng danh sách này — PLAN-3.12
    # T-1713): cổng nhanh chạy MỌI lớp test qua `test_list`/`test_unit` song song, không coverage; chưa khai hai khoá đó → `test`.
    if [ "$task" = "gate-fast" ] && gate_config_changed "$groot"; then
      export XT_GATE_ALL_TESTS=1
      echo "🔒 Commit đụng cấu hình cổng nên cổng nhanh chạy MỌI lớp test (test_list/test_unit, không ngưỡng coverage; chưa khai hai khoá đó thì chạy 'test' đầy đủ) — coverage ở CI." >&2
    elif [ "$task" = "gate-fast" ]; then
      echo "⚡ Commit nhanh (commit_gate: fast): format/lint/typecheck + test liên quan file đổi; cổng đầy đủ (scripts/dev-task.sh gate) chạy ở CI." >&2
    fi
    # stdout của cổng sang stderr: stdout của hook chỉ được chứa JSON quyết định.
    if ! CLAUDE_PROJECT_DIR="$groot" "$gate" "$task" >&2; then
      echo "❌ Cổng trước commit ĐỎ ($task: build/typecheck/lint/test) ở $groot. CẢ lệnh chưa chạy (kể cả phần trước \`git commit\`). Sửa rồi commit lại." >&2
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
[ "$decision" = "ask" ] && pretool_decision ask "$XG_REASON"
# allow chỉ do guard.py trả cho `gh pr merge` đứng một mình đã qua `xt.py merge-check` (ADR-0013).
[ "$decision" = "allow" ] && pretool_decision allow "$XG_REASON"
exit 0
