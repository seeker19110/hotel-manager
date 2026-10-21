#!/usr/bin/env bash
# dev-task.sh — điểm vào ỔN ĐỊNH, KHÔNG phụ thuộc stack, cho các tác vụ dev.
#
# Vì sao tồn tại: template hỗ trợ MỌI loại dự án (web/mobile/backend/CLI/data/…),
# nên KHÔNG được hardcode lệnh (npm/ruff/go…) vào hook hay settings. Thay vào đó
# hook chỉ gọi `dev-task.sh <task>`; script này tự phân giải lệnh đúng cho dự án.
#
# Thứ tự phân giải (đầu tiên thắng):
#   1) KHAI BÁO: nếu có xt.yaml (YAML phẳng `task: lệnh`, agent đọc được) hoặc
#      .claude/project-commands.sh (biến bash <task>=lệnh) → chạy lệnh khai báo.
#   2) TỰ DÒ: nhận diện hệ sinh thái (node/python/go/rust/make) → chạy lệnh quy ước.
#   3) NO-OP: không có gì khớp → in thông báo skip, exit 0 (KHÔNG làm gãy dự án nào).
#      Ngoại lệ (ADR-0011): autopilot đang chạy (.autopilot/state.json "active": true) mà `lint`/`test`
#      rỗng hoặc là lệnh không kiểm gì (true, :, exit 0, echo …) → ĐỎ. Cổng rỗng không phải bằng chứng.
#
# Task hỗ trợ: format | lint | typecheck | test | build | gate | gate-par | gate-fast | test-shard | test-combine |
#   test-weights | test-mode | e2e-mode | e2e | require | setup
#   gate = chạy tuần tự build→typecheck→lint→test (cái nào phân giải được), đỏ 1 cái → fail. Cổng đầy đủ: CI, bước
#          mở PR, `xt.py loop record` dùng đúng lệnh này. Khai `test_floor` (lệnh, chỉ khai báo) → chạy thêm sau `test`.
#   gate-par = cùng các lệnh của `gate` nhưng chia nhóm độc lập chạy nền CÙNG LÚC (D-128, job `gate` của CI mẫu):
#          typecheck ∥ lint ∥ build → test (→ test_floor). Guard hỏi một lần cho mọi lệnh trước khi chạy nhóm nào; mỗi
#          nhóm log riêng, in lại nguyên khối kèm nhãn nhóm khi xong (theo thứ tự nhóm); đỏ khi nhóm nào đỏ — exit code
#          của nhóm đỏ đầu tiên theo thứ tự đó. Các nhóm không được ghi chung file (vd typecheck sinh mã build đọc) —
#          khi đó dùng `gate`.
#   gate-fast = cổng commit nhanh (`commit_gate: fast` trong xt.yaml): format_check→lint→typecheck→test_fast. test_fast
#          nhận danh sách file đã đổi so với HEAD (staged + chưa staged + file mới chưa ignore) qua biến
#          XT_CHANGED_FILES (mỗi dòng một file); test_fast trống/no-op hoặc không biết file đổi (không phải repo git,
#          chưa có commit) → chạy `test` (không bao giờ yếu hơn test thường). Không chạy build, không ngưỡng coverage
#          riêng — cổng đầy đủ ở CI giữ chúng.
#   test-shard I N [DIR] = chạy phần thứ I (1..N) của bộ test cho CI song song (fan-out): lệnh khai báo `test_list` in
#          mỗi dòng một id test (sắp xếp, bỏ trùng). Có khoá `test_weights` (file JSON {"id": giây}) → chia tham lam
#          LPT theo trọng số (`xt.py test-shard-plan`: nặng trước, vào shard nhẹ nhất; id lạ lấy trung vị; file hỏng →
#          đỏ exit 2, file vắng → mọi id cùng trọng số); không khai → id thứ k (đếm từ 0) thuộc shard (k mod N) + 1.
#          Mỗi id chạy `test_unit` (id ở "$1") song song theo số CPU. DIR → export XT_COV_DIR=DIR để `test_unit` ghi
#          dữ liệu coverage vào đó. Đỏ khi `test_list` đỏ, ít hơn XT_MIN_TESTS id (mặc định 1) hoặc shard rỗng.
#   test-weights = đo lại file `test_weights`: chạy `test_unit` lần lượt từng id (coverage vào thư mục tạm), ghi giây
#          (JSON khoá sắp xếp). Chạy tay khi bộ test đổi đáng kể rồi commit file; CI KHÔNG chạy (số đo phụ thuộc máy).
#   test-combine DIR = gộp dữ liệu coverage các shard (fan-in): export XT_COV_DIR=DIR rồi chạy `test_combine` (ngưỡng
#          nằm trong lệnh đó). Không khai `test_list`/`test_unit`/`test_combine` → đỏ (không có no-op cho chia test).
#   require T… = đỏ (exit 1) khi task T phân giải ra rỗng hoặc lệnh không kiểm gì (như `is_noop`), ở mọi pha — bước đầu
#          job `gate` của CI mẫu gọi `require lint test` để `skip` không thành "CI xanh rỗng" (D-096). Trong GitHub
#          Actions in `::error::` nêu khoá cần điền và ví dụ theo stack. typecheck/build rỗng vẫn được (không bắt buộc).
#   setup = cài toolchain/phụ thuộc cho job CI (mẫu `framework/templates/ci.yml`): chạy khoá `setup` (vd `npm ci`). Chỉ
#          lệnh khai báo, không tự dò; vắng/rỗng → log "không khai setup", exit 0; guard cấm lệnh → exit 126.
#   CI mẫu (ADR-0039 — 3 job `gate` · `e2e` · `quality`; mọi lệnh vẫn là khoá của xt.yaml, qua guard):
#   test-mode = in `shard` khi khai đủ lệnh thật `test_list` · `test_unit` · `test_combine`, không thì `whole` (cho CI tự
#          tách test thành job shard + job gộp coverage; mẫu không dùng — ngưỡng coverage nằm trong `test` của `gate`).
#   e2e-mode = in `off` (`e2e` rỗng/no-op), `shard` (lệnh `e2e` dùng $XT_SHARD) hoặc `whole` (chỉ shard 1 chạy cả suite).
#   e2e [I N] = suite E2E: `e2e_setup` (cài trình duyệt…) rồi `e2e` với XT_SHARD="I/N" (mặc định 1/1 — agent chạy tay
#          được); `off` → bỏ qua exit 0; `whole` mà I > 1 → bỏ qua (không chạy trùng cả suite N lần).
#
# Dùng: scripts/dev-task.sh <task>
set -uo pipefail

TASK="${1:-}"
# Gốc dự án: CLAUDE_PROJECT_DIR (hook) > thư mục cha của scripts/ — nhưng khi script nằm ở dự án đích
# (.xtemplates/scripts/dev-task.sh) thì gốc là cha của .xtemplates/, không phải .xtemplates/ (AUD-HAR-001: từng "xanh giả").
_parent="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(basename "$_parent")" = ".xtemplates" ]; then _parent="$(dirname "$_parent")"; fi
ROOT="${CLAUDE_PROJECT_DIR:-$_parent}"
DECL="$ROOT/.claude/project-commands.sh"
YAML="$ROOT/xt.yaml"

log() { printf '[dev-task] %s\n' "$*" >&2; }

if [ -z "$TASK" ]; then
  log "thiếu tên task. Dùng: dev-task.sh format|lint|typecheck|test|build|gate|gate-fast|gate-par|test-shard|test-combine|test-weights|test-mode|e2e-mode|e2e|require|setup"
  exit 2
fi

# --- 1) Lệnh KHAI BÁO (escape hatch cho mọi dự án đặc thù) --------------------
yaml_has() { [ -f "$YAML" ] && grep -Eq "^$1:" "$YAML"; }
strip_comment() { # bỏ comment YAML: `#` ở đầu giá trị hoặc sau khoảng trắng, ngoài nháy (AUD-HAR-025)
  local s="$1" out="" q="" c prev=" " i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    if [ -z "$q" ] && [ "$c" = "#" ] && { [ "$prev" = " " ] || [ "$prev" = $'\t' ]; }; then break; fi
    if [ "$c" = "'" ] || [ "$c" = '"' ]; then
      if [ -z "$q" ]; then q="$c"; elif [ "$q" = "$c" ]; then q=""; fi
    fi
    out+="$c"
    prev="$c"
  done
  printf '%s' "$out"
}
yaml_get() { # giá trị khoá $1 trong xt.yaml; bỏ comment, rồi bỏ nháy chỉ khi bọc cả hai đầu ("..." hoặc '...')
  local v
  v="$(grep -E "^$1:" "$YAML" | head -1 | sed -E "s/^$1:[[:space:]]*//")"
  strip_comment "$v" | sed -E "s/[[:space:]]+\$//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"
}
declared_cmd() {
  # In ra lệnh khai báo cho $1 nếu có, ngược lại rỗng. xt.yaml (phẳng) ưu tiên hơn file bash.
  if yaml_has "$1"; then yaml_get "$1"; return 0; fi
  [ -f "$DECL" ] || return 0
  # Nạp trong subshell để không rò biến; lấy giá trị biến trùng tên task.
  # shellcheck source=/dev/null
  ( set +u; . "$DECL" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" )
}

# --- 2) TỰ DÒ theo hệ sinh thái ---------------------------------------------
node_pm() {
  if   [ -f "$ROOT/pnpm-lock.yaml" ]; then echo "pnpm"
  elif [ -f "$ROOT/yarn.lock" ];      then echo "yarn"
  elif [ -f "$ROOT/bun.lockb" ];      then echo "bun"
  else echo "npm"; fi
}
node_has_script() {
  # $1 = tên script; true nếu package.json khai báo nó.
  [ -f "$ROOT/package.json" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg s "$1" '.scripts[$s] // empty' "$ROOT/package.json" >/dev/null 2>&1
  else
    grep -Eq "\"$1\"[[:space:]]*:" "$ROOT/package.json"
  fi
}

detected_cmd() {
  # In ra lệnh tự-dò cho task $1, hoặc rỗng nếu không dò được.
  local t="$1" pm
  # Node/JS: ưu tiên script cùng tên trong package.json
  if [ -f "$ROOT/package.json" ] && node_has_script "$t"; then
    pm="$(node_pm)"; echo "$pm run $t"; return 0
  fi
  # Python (pyproject.toml)
  if [ -f "$ROOT/pyproject.toml" ]; then
    case "$t" in
      format)    command -v ruff >/dev/null 2>&1 && { echo "ruff format ."; return 0; }
                 command -v black >/dev/null 2>&1 && { echo "black ."; return 0; } ;;
      lint)      command -v ruff >/dev/null 2>&1 && { echo "ruff check ."; return 0; } ;;
      typecheck) command -v pyright >/dev/null 2>&1 && { echo "pyright"; return 0; }
                 command -v mypy >/dev/null 2>&1 && { echo "mypy ."; return 0; } ;;
      test)      command -v pytest >/dev/null 2>&1 && { echo "pytest -q"; return 0; }
                 [ -d "$ROOT/tests" ] && { echo "python3 -m unittest discover -s tests"; return 0; } ;;
    esac
  fi
  # Go
  if [ -f "$ROOT/go.mod" ]; then
    case "$t" in
      format)    echo "gofmt -l -w ."; return 0 ;;
      lint)      echo "go vet ./..."; return 0 ;;
      test)      echo "go test ./..."; return 0 ;;
      build)     echo "go build ./..."; return 0 ;;
    esac
  fi
  # Rust
  if [ -f "$ROOT/Cargo.toml" ]; then
    case "$t" in
      format)    echo "cargo fmt"; return 0 ;;
      lint)      echo "cargo clippy -- -D warnings"; return 0 ;;
      test)      echo "cargo test"; return 0 ;;
      build)     echo "cargo build"; return 0 ;;
    esac
  fi
  # Makefile target trùng tên
  if [ -f "$ROOT/Makefile" ] && grep -Eq "^$t:" "$ROOT/Makefile"; then
    echo "make $t"; return 0
  fi
  return 0
}

resolve() { # $1=task -> in lệnh (khai báo ưu tiên), rỗng nếu không có; khoá "" trong xt.yaml = cố ý bỏ qua
  local c; c="$(declared_cmd "$1")"; { [ -n "$c" ] || yaml_has "$1"; } && { echo "$c"; return 0; }
  detected_cmd "$1"
}

# --- ADR-0011: trong vòng autopilot, lint/test không được là no-op ------------
LOOP_REQUIRED=" lint test "
autopilot_active() { [ -f "$ROOT/.autopilot/state.json" ] && grep -Eq '"active"[[:space:]]*:[[:space:]]*true' "$ROOT/.autopilot/state.json"; }
# Một đoạn no-op (sau khi tách theo `&&` `||` `;`): `true` · `:` · `exit [0]` · `echo|printf` mà đối số không chứa `|`,
# `&`, `;`, backtick, `$(` — `echo go && pytest`, `echo x | sh` là lệnh thật. ĐÚNG chuỗi này ở `xt.py` `GATE_NOOP_SEG`
# (test so hai bên trên cùng bảng ca). Đưa vào awk qua -v (awk tự đổi `\t` thành tab; mawk cũ không có [[:space:]]).
NOOP_RE='true|:|exit( 0)?|(echo|printf)([ \t]([^|&;`$]|[$][^(|&;`$])*)?'
is_noop() { # $1=lệnh -> true nếu rỗng hoặc mọi đoạn nối bằng && ; || đều no-op (`true && :`, `echo a; exit 0`)
  local c; c="$(printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -z "$c" ] && return 0
  printf '%s\n' "$c" | awk -v re="^($NOOP_RE)\$" '{
    n = split($0, seg, /&&|\|\||;/)
    for (i = 1; i <= n; i++) {
      s = seg[i]; gsub(/^[ \t]+|[ \t]+$/, "", s)
      if (s != "" && s !~ re) exit 1
    }
  }'
}
loop_noop() { # $1=task $2=lệnh -> true (kèm log) nếu autopilot đang chạy mà task bắt buộc là no-op
  case "$LOOP_REQUIRED" in *" $1 "*) ;; *) return 1 ;; esac
  is_noop "$2" && autopilot_active || return 1
  local why="chưa có lệnh"; [ -n "$2" ] && why="là lệnh không kiểm gì ($2)"
  log "ĐỎ: autopilot đang chạy mà '$1' $why — khai lệnh thật trong xt.yaml (LOOP-HARNESS-008, ADR-0011); cổng rỗng không phải bằng chứng xanh"
}

# Lệnh xt.yaml do model viết được: qua guard của dự án trước khi chạy (LOOP-STOP-027). Không có python3/xt.py cạnh
# script này → chạy như cũ (fail-open về luồng; dự án chưa cài harness).
guard_ok() { # $1=lệnh -> 0 nếu được chạy
  local xt; xt="$(dirname "$0")/xt.py"
  [ -f "$xt" ] && command -v python3 >/dev/null 2>&1 || return 0
  # Chỉ exit 126 (guard cấm) là chặn; xt.py sập (python cũ…) → chạy như cũ (fail-open về luồng, ADR-0002).
  CLAUDE_PROJECT_DIR="$ROOT" python3 "$xt" guard-check -- "$1"
  [ "$?" -ne 126 ]
}
# gate/gate-fast: hỏi guard MỘT lần cho mọi lệnh của lượt (stdin, các lệnh cách nhau bằng NUL — lệnh nhiều dòng của
# project-commands.sh vẫn nguyên vẹn, review #191; T-1715) thay vì một tiến trình python mỗi lệnh; một lệnh bị cấm → 126,
# không chạy lệnh nào. xt.py in `guard-check: N lệnh` khi đã kiểm → GUARDED_CMDS ghi đúng các lệnh đã hỏi; run_task/
# test_shard chỉ bỏ hỏi lại khi lệnh còn y nguyên (lệnh đổi giữa lượt vẫn qua guard); xt.py cũ (không biết --stdin,
# không in gì) hay sập → hỏi từng lệnh như cũ.
GUARDED_CMDS=""
GSEP=$'\x1f'
guard_cached() { # $1=lệnh -> 0 nếu đúng lệnh này đã qua guard trong lượt
  case "$GUARDED_CMDS" in *"$GSEP$1$GSEP"*) return 0 ;; esac
  return 1
}
guard_ok_all() { # $@=lệnh -> 126 nếu guard cấm lệnh nào, 0 nếu được chạy (ghi GUARDED_CMDS khi xt.py xác nhận)
  local xt n c joined=""; xt="$(dirname "$0")/xt.py"
  [ -f "$xt" ] && command -v python3 >/dev/null 2>&1 || return 0
  n="$(printf '%s\0' "$@" | CLAUDE_PROJECT_DIR="$ROOT" python3 "$xt" guard-check --stdin)"
  case "$?" in
    126) return 126 ;;
    0) [ -n "$n" ] && { for c in "$@"; do joined="$joined$GSEP$c$GSEP"; done; GUARDED_CMDS="$joined"; } ;;
  esac
  return 0
}
guard_turn() { # $@=task -> 0 nếu mọi lệnh phân giải được của lượt được chạy; 126 (kèm log) nếu guard cấm lệnh nào
  local t c; local -a cmds=()
  for t in "$@"; do c="$(resolve "$t")"; [ -n "$c" ] && cmds+=("$c"); done
  [ "${#cmds[@]}" -gt 0 ] || return 0
  guard_ok_all "${cmds[@]}" && return 0 # gọi thẳng, không ống: GUARDED_CMDS phải đặt ở shell này, không phải subshell
  log "$TASK: guard cấm một lệnh của xt.yaml → không chạy lệnh nào (LOOP-STOP-027)"
  return 126
}

# unittest trên Python ≤ 3.11 exit 0 khi KHÔNG test nào chạy (`-k` sai tên, discover sai thư mục) — 3.12+ exit 5. Lệnh
# test exit 0 mà output (stdout hoặc stderr) có dòng tổng kết `Ran 0 tests` → exit 5, cùng chữ ký và cùng mã với
# `zero_tests_red` của xt.py (`loop record`/`verify`), để cổng commit, `gate`, `gate-par`, shard và CI không xanh giả
# khi loop đỏ (AUD-XFEAT-013). pytest tự exit 5, jest exit 1; `go test` "[no tests to run]" exit 0 không bắt (dòng đó
# hợp lệ ở gói không khớp `-run` khi gói khác chạy test).
ZERO_TESTS_RE='^Ran 0 tests\b'
run_counted() { # $@=lệnh như sau `bash -o pipefail -c` → exit của lệnh; 0 mà có `Ran 0 tests` → 5
  local d rc
  d="$(mktemp -d)" || return 2
  { { "$@" | tee -- "$d/out"; } 2>&1 1>&3 3>&- | tee -- "$d/err" >&2; } 3>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -Eq "$ZERO_TESTS_RE" -- "$d/out" "$d/err"; then
    log "zero_tests_red: lệnh test exit 0 nhưng in \`Ran 0 tests\` — không test nào chạy, coi là đỏ (exit 5)"
    rc=5
  fi
  rm -rf -- "$d"
  return "$rc"
}

RAN=0
run_task() { # $1=task -> chạy; 0 nếu ok hoặc no-op, khác 0 nếu lệnh fail hoặc no-op trong autopilot
  local cmd; cmd="$(resolve "$1")"
  if loop_noop "$1" "$cmd"; then return 3; fi
  if [ -z "$cmd" ]; then log "skip: chưa cấu hình/dò được '$1'"; return 0; fi
  RAN=$((RAN + 1))
  log "run [$1]: $cmd"
  guard_cached "$cmd" || guard_ok "$cmd" || return 126
  # pipefail cho chính lệnh khai báo: `set -o pipefail` ở trên không truyền vào `bash -c` mới, nên
  # `test | tee log` từng xanh giả khi test đỏ.
  case "$1" in
    test | test_fast | test_floor) ( cd "$ROOT" && run_counted bash -o pipefail -c "$cmd" ) ;;
    *) ( cd "$ROOT" && bash -o pipefail -c "$cmd" ) ;;
  esac
}

# --- gate-fast: test liên quan file đã đổi ----------------------------------------
changed_files() { # file đổi so với HEAD (theo gốc dự án) + file mới chưa ignore; không phải repo git/chưa có HEAD → 1
  git -C "$ROOT" rev-parse -q --verify HEAD >/dev/null 2>&1 || return 1
  # core.quotePath=false: tên file Unicode (tiếng Việt) ra nguyên văn, không thành "\303\241…" có nháy.
  { git -C "$ROOT" -c core.quotePath=false diff --relative --name-only HEAD -- &&
    git -C "$ROOT" -c core.quotePath=false ls-files --others --exclude-standard; } | sort -u
}
fast_test_task() { # in task test cho gate-fast: test_fast nếu có lệnh thật và biết file đổi, ngược lại test
  # XT_GATE_ALL_TESTS=1 (hook commit: diff đụng cấu hình cổng — T-1713): mọi lớp test qua test_list/test_unit, không
  # coverage (`test-all`); dự án chưa khai hai khoá đó → `test` đầy đủ như trước.
  if [ "${XT_GATE_ALL_TESTS:-}" = 1 ]; then
    if yaml_has test_list && yaml_has test_unit; then echo test-all; else echo test; fi
    return 0
  fi
  is_noop "$(resolve test_fast)" && { echo test; return 0; }
  [ -n "${XT_CHANGED_FILES+x}" ] && { echo test_fast; return 0; }
  log "gate-fast: không biết file nào đổi (không phải repo git/chưa có commit) → chạy 'test' đầy đủ"
  echo test
}
gate_report() { # $1=rc $2=tên cổng → log kết quả, exit rc
  if [ "$1" -eq 0 ] && [ "$RAN" -eq 0 ]; then
    log "$2 KHÔNG CHẠY LỆNH NÀO (no-op) — không thấy xt.yaml/lệnh ở $ROOT; đây KHÔNG phải bằng chứng xanh"
  elif [ "$1" -eq 0 ]; then
    log "$2 XANH ($RAN lệnh)"
  fi
  exit "$1"
}

# --- gate-par: nhóm độc lập của `gate` chạy nền cùng lúc (D-128) ------------------------------------------------------
gate_par() { # → exit qua gate_report (rc = exit code nhóm đỏ đầu tiên theo thứ tự nhóm); 126 nếu guard cấm lệnh nào
  local floor="" d i grc rc=0 ran=0 n; local -a groups=() pids=()
  [ -n "$(declared_cmd test_floor)" ] && floor=" test_floor"
  # shellcheck disable=SC2086 # $floor rỗng hoặc một tên task
  guard_turn build typecheck lint test $floor || exit 126
  groups=("typecheck" "lint" "build test$floor")
  d="$(mktemp -d)" || exit 2
  trap 'kill "${pids[@]}" 2>/dev/null; rm -rf -- "$d"' INT TERM
  for i in "${!groups[@]}"; do
    (
      RAN=0; grc=0
      for t in ${groups[$i]}; do run_task "$t" || { grc=$?; log "nhóm ĐỎ ở '$t' (exit $grc) → dừng nhóm"; break; }; done
      echo "$RAN" > "$d/$i.ran"
      exit "$grc"
    ) > "$d/$i.log" 2>&1 &
    pids+=("$!")
  done
  for i in "${!groups[@]}"; do
    wait "${pids[$i]}"; grc=$?
    log "── nhóm [${groups[$i]// / → }] exit $grc ──"
    cat -- "$d/$i.log" >&2
    n="$(cat -- "$d/$i.ran" 2>/dev/null)"; ran=$((ran + ${n:-0}))
    [ "$grc" -ne 0 ] && [ "$rc" -eq 0 ] && rc=$grc
  done
  trap - INT TERM
  rm -rf -- "$d"
  RAN=$ran
  [ "$rc" -eq 0 ] || log "GATE-PAR ĐỎ (exit $rc của nhóm đỏ đầu tiên)"
  gate_report "$rc" GATE-PAR
}

# --- test-shard / test-combine: chia bộ test cho job CI song song, gộp coverage ----------
shard_decl() { # $1=khoá → lệnh khai báo (in ra); thiếu → log, 1
  local c; c="$(declared_cmd "$1")"
  [ -n "$c" ] && ! is_noop "$c" && { printf '%s' "$c"; return 0; }
  log "$TASK: chưa khai lệnh '$1' trong xt.yaml (hoặc là lệnh không kiểm gì) — chia test cần lệnh thật"
  return 1
}
cov_dir() { # $1=thư mục → export XT_COV_DIR (đường dẫn tuyệt đối, tạo nếu chưa có)
  mkdir -p -- "$1" && XT_COV_DIR="$(cd -- "$1" && pwd)" && export XT_COV_DIR
}
xt_py() { # chạy xt.py cạnh script này (cần cho chia theo trọng số); thiếu python3/xt.py → log, 2
  local xt; xt="$(dirname "$0")/xt.py"
  [ -f "$xt" ] && command -v python3 >/dev/null 2>&1 || { log "$TASK: cần python3 và $xt (khoá 'test_weights')"; return 2; }
  CLAUDE_PROJECT_DIR="$ROOT" python3 "$xt" "$@"
}
weights_file() { # đường dẫn tuyệt đối của `test_weights` trong xt.yaml; rỗng nếu không khai
  local w; w="$(declared_cmd test_weights)"
  case "$w" in "" | /*) printf '%s' "$w" ;; *) printf '%s' "$ROOT/$w" ;; esac
}
shard_pick() { # stdin=id (sắp xếp, bỏ trùng) $1=I $2=N → id của shard I: theo trọng số nếu khai `test_weights`, không thì k mod N
  local w; w="$(weights_file)"
  if [ -z "$w" ]; then awk -v i="$1" -v n="$2" '(NR - 1) % n == i - 1'; return 0; fi
  xt_py test-shard-plan "$1" "$2" --weights "$w"
}
test_shard() { # $1=I (1..N) $2=N [$3=thư mục dữ liệu coverage]
  local i="$1" n="$2" min="${XT_MIN_TESTS:-1}" list unit ids total pick
  if ! [[ "$i" =~ ^[1-9][0-9]{0,5}$ && "$n" =~ ^[1-9][0-9]{0,5}$ && "$min" =~ ^[0-9]{1,9}$ ]] || [ "$i" -gt "$n" ]; then
    log "test-shard: cần 1 ≤ I ≤ N và XT_MIN_TESTS là số (nhận I='$i' N='$n' XT_MIN_TESTS='$min')"; return 2
  fi
  list="$(shard_decl test_list)" && unit="$(shard_decl test_unit)" || return 2
  unset XT_COV_DIR
  if [ -n "${3:-}" ]; then cov_dir "$3" || return 2; fi
  { guard_cached "$list" && guard_cached "$unit"; } || { guard_ok "$list" && guard_ok "$unit"; } || return 126
  ids="$(cd "$ROOT" && bash -o pipefail -c "$list" | sed -E 's/[[:space:]]+$//' | grep -v '^$' | LC_ALL=C sort -u)" ||
    { log "test-shard: 'test_list' đỏ hoặc không in id nào"; return 1; }
  total="$(printf '%s\n' "$ids" | grep -c .)"
  if [ "$total" -lt "$min" ]; then
    log "test-shard: chỉ có $total id test < XT_MIN_TESTS=$min — liệt kê hỏng thì không được xanh"; return 1
  fi
  pick="$(printf '%s\n' "$ids" | shard_pick "$i" "$n")" || return $?
  [ -n "$pick" ] || { log "test-shard: shard $i/$n rỗng (chỉ $total id) — giảm N"; return 1; }
  log "test-shard $i/$n: $(printf '%s\n' "$pick" | grep -c .)/$total id"
  printf '%s\n' "$pick" | (cd "$ROOT" && run_counted xargs -r -P "$(nproc 2>/dev/null || echo 2)" -n 1 bash -o pipefail -c "$unit" _)
}
test_weights() { # đo lại `test_weights` bằng `test_list` + `test_unit` (coverage vào thư mục tạm, như job `test` của CI)
  local list unit w ids d rc
  w="$(weights_file)"
  [ -n "$w" ] || { log "test-weights: chưa khai 'test_weights' (đường dẫn file trọng số) trong xt.yaml"; return 2; }
  list="$(shard_decl test_list)" && unit="$(shard_decl test_unit)" || return 2
  guard_ok "$list" && guard_ok "$unit" || return 126
  ids="$(cd "$ROOT" && bash -o pipefail -c "$list")" || { log "test-weights: 'test_list' đỏ"; return 1; }
  d="$(mktemp -d)" || return 2
  printf '%s\n' "$ids" | XT_COV_DIR="$d" xt_py test-weights --unit "$unit" --out "$w"
  rc=$?
  rm -rf -- "$d"
  return "$rc"
}
test_combine() { # $1=thư mục chứa dữ liệu coverage của mọi shard
  local c
  [ -n "${1:-}" ] && [ -d "$1" ] || { log "test-combine: cần thư mục dữ liệu có sẵn (nhận '${1:-}')"; return 2; }
  c="$(shard_decl test_combine)" || return 2
  cov_dir "$1" || return 2
  guard_ok "$c" || return 126
  log "test-combine: $c (XT_COV_DIR=$XT_COV_DIR)"
  (cd "$ROOT" && bash -o pipefail -c "$c")
}

# --- require: CI mẫu đỏ khi cổng bắt buộc rỗng (D-096) — `skip` của run_task không được thành "CI xanh rỗng" ----------
require_tasks() { # $@=task → 0 nếu mọi task phân giải ra lệnh thật (khai báo hoặc tự dò), 1 nếu có task rỗng/no-op
  local t c bad=0 msg
  [ "$#" -gt 0 ] || { log "require: cần ít nhất một task (vd: require lint test)"; return 2; }
  for t in "$@"; do
    c="$(resolve "$t")"
    is_noop "$c" || { log "require: '$t' = $c"; continue; }
    bad=1
    msg="xt.yaml chưa khai lệnh thật cho '$t' (đang rỗng hoặc không kiểm gì: '${c}') — CI đỏ tới khi điền khoá '$t:'"
    msg+=" trong xt.yaml (D-096). Ví dụ — Node: lint: npm run lint · test: npm test; Python: lint: ruff check . · test:"
    msg+=" pytest -q; Go: lint: go vet ./... · test: go test ./..."
    if [ "${GITHUB_ACTIONS:-}" = true ]; then printf '::error::%s\n' "$msg"; else log "ĐỎ: $msg"; fi
  done
  return "$bad"
}

# --- CI mẫu (D-115): chế độ test/e2e cho matrix tĩnh — mỗi shard tự quyết, không job lập kế hoạch tuần tự -------------
test_mode() { # in shard|whole — cùng điều kiện với test-shard/test-combine (chỉ lệnh khai báo, không no-op)
  local k c
  for k in test_list test_unit test_combine; do
    c="$(declared_cmd "$k")"
    if [ -z "$c" ] || is_noop "$c"; then echo whole; return 0; fi
  done
  echo shard
}
e2e_mode() { # in off|shard|whole
  local c; c="$(resolve e2e)"
  if is_noop "$c"; then echo off; return 0; fi
  case "$c" in *XT_SHARD*) echo shard ;; *) echo whole ;; esac
}
shard_args_ok() { # $1=I $2=N → 0 nếu 1 ≤ I ≤ N (số)
  [[ "$1" =~ ^[1-9][0-9]{0,5}$ && "$2" =~ ^[1-9][0-9]{0,5}$ ]] && [ "$1" -le "$2" ]
}
e2e_run() { # $1=I $2=N (mặc định 1 1)
  local i="${1:-1}" n="${2:-1}" mode
  shard_args_ok "$i" "$n" || { log "e2e: cần 1 ≤ I ≤ N (nhận I='$i' N='$n')"; return 2; }
  mode="$(e2e_mode)"
  case "$mode" in
    off) log "e2e: chưa khai 'e2e' trong xt.yaml (hoặc là lệnh không kiểm gì) — bỏ qua"; return 0 ;;
    whole)
      if [ "$i" -gt 1 ]; then log "e2e $i/$n: lệnh 'e2e' không dùng \$XT_SHARD — shard 1 chạy cả suite, shard này bỏ qua"; return 0; fi
      n=1 ;;
  esac
  export XT_SHARD="$i/$n"
  guard_turn e2e_setup e2e || return 126
  run_task e2e_setup || return $?
  run_task e2e
}

# --- format-file: format ĐÚNG file vừa sửa (dùng cho auto-format hook) --------
json_ok() { # $1=file → 0 nếu là JSON hợp lệ; không có python3 thì không kiểm được (coi như không hợp lệ: không giữ bản sao)
  command -v python3 >/dev/null 2>&1 && python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$1" >/dev/null 2>&1
}
declared_format_file() {
  if yaml_has format_file; then yaml_get format_file; return 0; fi
  [ -f "$DECL" ] || return 0
  # shellcheck source=/dev/null
  ( set +u; . "$DECL" >/dev/null 2>&1; eval "printf '%s' \"\${format_file:-}\"" )
}
resolve_format_file() { # $1=path -> in lệnh format 1 file (file là "$1" khi chạy), rỗng nếu không có
  local p="$1" tmpl ext
  tmpl="$(declared_format_file)"
  if [ -n "$tmpl" ]; then tmpl="${tmpl//\"\{\}\"/\"\$1\"}"; printf '%s' "${tmpl//\{\}/\"\$1\"}"; return 0; fi
  ext="${p##*.}"
  case "$ext" in
    js|jsx|ts|tsx|mjs|cjs|json|css|scss|md|mdx|html|yaml|yml)
      if command -v npx >/dev/null 2>&1 && [ -f "$ROOT/package.json" ]; then
        echo 'npx --no-install prettier --write "$1"'; return 0; fi ;;
    py)
      command -v ruff  >/dev/null 2>&1 && { echo 'ruff format "$1"'; return 0; }
      command -v black >/dev/null 2>&1 && { echo 'black "$1"';       return 0; } ;;
    go)  command -v gofmt   >/dev/null 2>&1 && { echo 'gofmt -w "$1"'; return 0; } ;;
    rs)  command -v rustfmt >/dev/null 2>&1 && { echo 'rustfmt "$1"';  return 0; } ;;
  esac
  return 0
}

# --- Điều phối ---------------------------------------------------------------
case "$TASK" in
  format|lint|typecheck|test|build)
    run_task "$TASK"; exit $? ;;
  format-file)
    P="${2:-}"; [ -n "$P" ] || { log "format-file: thiếu path"; exit 0; }
    C="$(resolve_format_file "$P")"
    [ -n "$C" ] || { log "skip format-file: không có per-file formatter cho '$P'"; exit 0; }
    log "format-file: $C  (\$1=$P)"
    # Formatter khai báo cho ngôn ngữ khác (vd `ruff format {}` với file .json) có thể làm hỏng JSON — file JSON đang
    # hợp lệ mà sau format không còn hợp lệ thì khôi phục bản trước (AUD-HAR-037).
    F="$P"; case "$F" in /*) ;; *) F="$ROOT/$F" ;; esac
    keep=""
    case "$F" in
      *.json | *.JSON) json_ok "$F" && keep="$(mktemp)" && { cp -p -- "$F" "$keep" || { rm -f -- "$keep"; keep=""; }; } ;;
    esac
    # Lệnh `format_file` khai báo (xt.yaml/project-commands — người hay agent viết được) qua guard như mọi lệnh khai
    # báo (LOOP-STOP-027); mẫu dựng sẵn của khung (prettier/ruff/black/gofmt/rustfmt với "$1") là hằng trong file này
    # nên không khởi động guard (−260–370 ms mỗi lần Edit/Write; PLAN-3.12 T-1712).
    if [ -n "$(declared_format_file)" ]; then
      guard_ok "$C" || exit 0 # format_file bị guard cấm: không format, không chặn lượt sửa (PostToolUse)
    else
      log "format-file: mẫu dựng sẵn của khung — không qua guard"
    fi
    ( cd "$ROOT" && bash -c "$C" _ "$P" ) || true
    if [ -n "$keep" ]; then
      json_ok "$F" || { cp -p -- "$keep" "$F"; log "format-file: formatter làm hỏng JSON '$P' → khôi phục bản trước"; }
      rm -f -- "$keep"
    fi
    exit 0 ;;
  gate)
    rc=0
    # test_floor (T-1812): khoá có lệnh → chạy sau `test` (vd sàn Python như job CI py311); vắng/rỗng → không chạy.
    FLOOR=""; [ -n "$(declared_cmd test_floor)" ] && FLOOR=test_floor
    guard_turn build typecheck lint test $FLOOR || exit 126
    for t in build typecheck lint test $FLOOR; do
      run_task "$t" || { rc=1; log "GATE ĐỎ ở '$t' → dừng"; break; }
    done
    gate_report "$rc" GATE ;;
  gate-par)
    gate_par ;;
  gate-fast)
    rc=0
    if CHANGED="$(changed_files)"; then export XT_CHANGED_FILES="$CHANGED"; else unset XT_CHANGED_FILES; fi
    FT="$(fast_test_task)"
    if [ "$FT" = test-all ]; then guard_turn format_check lint typecheck test_list test_unit
    else guard_turn format_check lint typecheck "$FT"; fi || exit 126
    for t in format_check lint typecheck "$FT"; do
      if [ "$t" = test-all ]; then
        RAN=$((RAN + 1)); log "run [test-all]: mọi lớp test qua test_list/test_unit, không coverage (XT_GATE_ALL_TESTS=1)"
        ( unset XT_GATE_ALL_TESTS; test_shard 1 1 ) # không rò cờ vào test con: test của chính gate-fast đọc cờ này
      else
        run_task "$t"
      fi || { rc=1; log "GATE-FAST ĐỎ ở '$t' → dừng"; break; }
    done
    gate_report "$rc" GATE-FAST ;;
  test-shard)
    test_shard "${2:-}" "${3:-}" "${4:-}"; exit $? ;;
  test-combine)
    test_combine "${2:-}"; exit $? ;;
  test-weights)
    test_weights; exit $? ;;
  test-mode)
    test_mode; exit $? ;;
  e2e-mode)
    e2e_mode; exit $? ;;
  e2e)
    e2e_run "${2:-1}" "${3:-1}"; exit $? ;;
  require)
    shift; require_tasks "$@"; exit $? ;;
  setup)
    C="$(declared_cmd setup)"
    [ -n "$C" ] || { log "setup: không khai setup trong xt.yaml — bỏ qua (dùng toolchain sẵn có của máy)"; exit 0; }
    log "run [setup]: $C"
    guard_ok "$C" || exit 126
    ( cd "$ROOT" && bash -o pipefail -c "$C" ); exit $? ;;
  *)
    log "task không hợp lệ: '$TASK' (format|lint|typecheck|test|build|gate|gate-fast|gate-par|test-shard|test-combine|test-weights|test-mode|e2e-mode|e2e|require|setup)"; exit 2 ;;
esac
