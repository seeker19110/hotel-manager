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
# Task hỗ trợ: format | lint | typecheck | test | build | gate
#   gate = chạy tuần tự build→typecheck→lint→test (cái nào phân giải được), đỏ 1 cái → fail.
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
  log "thiếu tên task. Dùng: dev-task.sh format|lint|typecheck|test|build|gate"
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
is_noop() { # $1=lệnh -> true nếu rỗng hoặc không kiểm gì
  local c; c="$(printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -z "$c" ] || printf '%s' "$c" | grep -Eqx "true|:|exit( 0)?|(echo|printf)([[:space:]].*)?"
}
loop_noop() { # $1=task $2=lệnh -> true (kèm log) nếu autopilot đang chạy mà task bắt buộc là no-op
  case "$LOOP_REQUIRED" in *" $1 "*) ;; *) return 1 ;; esac
  is_noop "$2" && autopilot_active || return 1
  local why="chưa có lệnh"; [ -n "$2" ] && why="là lệnh không kiểm gì ($2)"
  log "ĐỎ: autopilot đang chạy mà '$1' $why — khai lệnh thật trong xt.yaml (LOOP-HARNESS-008, ADR-0011); cổng rỗng không phải bằng chứng xanh"
}

RAN=0
run_task() { # $1=task -> chạy; 0 nếu ok hoặc no-op, khác 0 nếu lệnh fail hoặc no-op trong autopilot
  local cmd; cmd="$(resolve "$1")"
  if loop_noop "$1" "$cmd"; then return 3; fi
  if [ -z "$cmd" ]; then log "skip: chưa cấu hình/dò được '$1'"; return 0; fi
  RAN=$((RAN + 1))
  log "run [$1]: $cmd"
  # pipefail cho chính lệnh khai báo: `set -o pipefail` ở trên không truyền vào `bash -c` mới, nên
  # `test | tee log` từng xanh giả khi test đỏ.
  ( cd "$ROOT" && bash -o pipefail -c "$cmd" )
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
    ( cd "$ROOT" && bash -c "$C" _ "$P" ) || true
    if [ -n "$keep" ]; then
      json_ok "$F" || { cp -p -- "$keep" "$F"; log "format-file: formatter làm hỏng JSON '$P' → khôi phục bản trước"; }
      rm -f -- "$keep"
    fi
    exit 0 ;;
  gate)
    rc=0
    for t in build typecheck lint test; do
      run_task "$t" || { rc=1; log "GATE ĐỎ ở '$t' → dừng"; break; }
    done
    if [ "$rc" -eq 0 ] && [ "$RAN" -eq 0 ]; then
      log "GATE KHÔNG CHẠY LỆNH NÀO (no-op) — không thấy xt.yaml/lệnh ở $ROOT; đây KHÔNG phải bằng chứng xanh"
    elif [ "$rc" -eq 0 ]; then
      log "GATE XANH ($RAN lệnh)"
    fi
    exit "$rc" ;;
  *)
    log "task không hợp lệ: '$TASK' (format|lint|typecheck|test|build|gate)"; exit 2 ;;
esac
