#!/usr/bin/env bash
# Thư viện dùng chung (chỉ `source`, không chạy trực tiếp) cho scripts/dast.sh và scripts/perf-load.sh: dựng app production
# tạm như job `e2e` của CI (apps/web/e2e/server.ts — Postgres 17 qua TEST_DATABASE_URL hoặc cluster tạm của testkit, seed giả,
# `next start`), chờ /api/health, và dừng chắc chắn khi thoát (nhóm tiến trình riêng: SIGTERM cho server.ts dọn DB tạm trước,
# rồi mới TERM/KILL phần còn sót của nhóm).
# Bền khi bash bị SIGKILL (vd release-check hết `XT_RECORD_TIMEOUT` chỉ giết bash, trap EXIT không chạy):
#   - tiến trình con dài chạy qua `hm_run`/`hm_start_app`: KHÔNG thừa hưởng fd 9 (khoá cổng) và mang dấu
#     HM_E2E_RUN_ID=<id lượt chạy>;
#   - id lượt chạy ghi vào `${TMPDIR:-/tmp}/hm-e2e-<cổng>.run`; lượt sau giành được khoá thì dọn mọi tiến trình (và container
#     ZAP có nhãn) còn mang id cũ TRƯỚC khi kiểm cổng;
#   - lệnh dài (ZAP, k6) chạy nền + `wait` để trap INT/TERM chạy ngay.
# Biến nhận: E2E_PORT (mặc định 3100), E2E_NO_REPLICA, TEST_DATABASE_URL. Đặt sau khi source: HM_ROOT, HM_PORT, HM_BASE_URL,
# HM_RUN_ID.

HM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HM_PORT="${E2E_PORT:-3100}"
HM_BASE_URL=""
HM_RUN_ID=""
hm_tag="app"
hm_server_pid=""
hm_fg_pid=""

hm_log() { printf '[%s] %s\n' "$hm_tag" "$*"; }
hm_die() {
  local code="$1"
  shift
  printf '[%s] ✗ %s\n' "$hm_tag" "$*" >&2
  exit "$code"
}

# Kiểm đầu vào chung; gọi trước mọi việc tốn thời gian. $1 = nhãn log.
hm_init() {
  hm_tag="$1"
  [[ "$HM_PORT" =~ ^[0-9]{2,5}$ ]] && [ "$HM_PORT" -ge 1024 ] && [ "$HM_PORT" -le 65534 ] ||
    hm_die 2 "E2E_PORT phải là số cổng 1024–65534, nhận: '$HM_PORT'"
  HM_BASE_URL="http://127.0.0.1:${HM_PORT}"
  HM_RUN_ID="$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
  export E2E_PORT="$HM_PORT"
  export NEXT_TELEMETRY_DISABLED=1
}

# Chạy lệnh con: đóng fd 9 (con sống sót sau bash không giữ khoá cổng) và gắn dấu lượt chạy để lượt sau dọn được.
hm_run() { HM_E2E_RUN_ID="$HM_RUN_ID" "$@" 9>&-; }

# Chạy lệnh dài ở nền rồi `wait` — trap INT/TERM chạy ngay thay vì chờ lệnh xong. Trả exit code của lệnh.
hm_run_wait() {
  local rc=0
  # Đóng fd 9 cho cả subshell nền (nó chờ lệnh con — bị giết ngang thì không được giữ khoá).
  hm_run "$@" 9>&- &
  hm_fg_pid=$!
  wait "$hm_fg_pid" || rc=$?
  hm_fg_pid=""
  return "$rc"
}

# Thư mục kết quả: $1 (đường dẫn người gọi đặt, tương đối theo thư mục hiện tại) hoặc `mktemp -d` — cây git giữ sạch.
# In đường dẫn tuyệt đối.
hm_out_dir() {
  local want="$1" dir
  if [ -n "$want" ]; then
    mkdir -p "$want"
    dir="$(cd "$want" && pwd)"
  else
    dir="$(mktemp -d "${TMPDIR:-/tmp}/hm-${hm_tag}-XXXXXX")"
  fi
  printf '%s\n' "$dir"
}

# Có tiến trình nghe ở 127.0.0.1:$1?
hm_port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# PID các tiến trình mang đúng dấu HM_E2E_RUN_ID=$1 (đọc /proc/<pid>/environ; khớp nguyên mục, không khớp chuỗi con).
hm_run_pids() {
  local id="$1" f
  [ -n "$id" ] || return 0
  for f in /proc/[0-9]*/environ; do
    if grep -qzx -F "HM_E2E_RUN_ID=$id" "$f" 2>/dev/null; then
      f="${f#/proc/}"
      printf '%s\n' "${f%/environ}"
    fi
  done
}

# Container ZAP có nhãn của lượt $1 (rỗng khi không có docker).
hm_run_containers() {
  command -v docker >/dev/null || return 0
  docker ps -q --filter "label=hm-e2e-run=$1" 2>/dev/null || true
}

# Dọn mọi thứ của lượt chạy $1: container có nhãn, rồi TERM (chờ ≤ 10 giây) và KILL tiến trình còn mang dấu.
hm_reap_run() {
  local id="$1" pids c
  [ -n "$id" ] || return 0
  for c in $(hm_run_containers "$id"); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  pids="$(hm_run_pids "$id")"
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086 # danh sách PID tách bằng khoảng trắng
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    pids="$(hm_run_pids "$id")"
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086 # danh sách PID tách bằng khoảng trắng
  kill -KILL $pids 2>/dev/null || true
}

# Khoá theo cổng (hai lượt cùng cổng chạy song song sẽ đo/quét nhầm server của nhau), dọn tàn dư của lượt trước bị giết
# ngang, rồi cổng phải trống — không quét/tải vào một server lạ đang chạy sẵn. Gọi trước build.
hm_claim_port() {
  local lock="${TMPDIR:-/tmp}/hm-e2e-${HM_PORT}.lock" runf="${TMPDIR:-/tmp}/hm-e2e-${HM_PORT}.run" old p
  exec 9>"$lock"
  flock -n 9 || hm_die 1 "cổng ${HM_PORT} đang được một lượt dast/perf khác dùng (khoá $lock) — chờ xong hoặc đặt E2E_PORT khác"
  if [ -s "$runf" ]; then
    old="$(head -c 64 "$runf" | tr -cd '0-9a-f')"
    if [ -n "$old" ] && [ -n "$(hm_run_pids "$old")$(hm_run_containers "$old")" ]; then
      hm_log "dọn tàn dư của lượt trước bị dừng ngang (id $old)"
      hm_reap_run "$old"
    fi
  fi
  printf '%s\n' "$HM_RUN_ID" >"$runf"
  for p in "$HM_PORT" $([ "${E2E_NO_REPLICA:-}" = 1 ] || echo $((HM_PORT + 1))); do
    if hm_port_busy "$p"; then
      hm_die 1 "đã có tiến trình nghe ở 127.0.0.1:${p} — dừng nó hoặc đặt E2E_PORT khác (không quét/tải vào server lạ)"
    fi
  done
}

# Build production của web trừ khi $1 = 1.
hm_build() {
  if [ "${1:-}" = 1 ]; then
    hm_log "bỏ qua build (đã đặt *_SKIP_BUILD=1) — dùng bản build có sẵn ở apps/web/.next"
  else
    hm_log "build production: pnpm --filter web build"
    (cd "$HM_ROOT" && hm_run pnpm --filter web build) 9>&-
  fi
}

# Khởi động app trong nhóm tiến trình riêng, log vào $1; chờ /api/health tối đa 240 giây. Đỏ (exit 1) khi app chết/không lên;
# hm_server_pid giữ nguyên để trap EXIT dọn cả nhóm (con của server.ts có thể còn sống dù nó đã chết).
hm_start_app() {
  local log="$1"
  hm_log "khởi động app tạm (e2e/server.ts) ở ${HM_BASE_URL}, log: $log"
  (cd "$HM_ROOT/apps/web" && HM_E2E_RUN_ID="$HM_RUN_ID" exec setsid node e2e/server.ts 9>&-) >"$log" 2>&1 </dev/null &
  hm_server_pid=$!
  for _ in $(seq 1 120); do
    if ! kill -0 "$hm_server_pid" 2>/dev/null; then
      tail -n 50 "$log" >&2 || true
      hm_die 1 "app thoát trước khi sẵn sàng"
    fi
    if curl -fsS --max-time 2 "${HM_BASE_URL}/api/health" >/dev/null 2>&1 9>&-; then
      hm_log "app sẵn sàng"
      return 0
    fi
    sleep 2 9>&-
  done
  tail -n 50 "$log" >&2 || true
  hm_die 1 "app không lên trong 240 giây"
}

# Dừng: lệnh nền đang chờ (ZAP/k6) → TERM; server.ts → SIGTERM (nó dừng Next, xoá DB/cluster tạm), chờ tối đa 30 giây; còn sót
# trong nhóm (kể cả khi server.ts đã chết) → TERM rồi KILL; cuối cùng dọn mọi tiến trình/container còn mang dấu lượt này.
hm_stop_app() {
  local pid="$hm_server_pid"
  if [ -n "$hm_fg_pid" ]; then
    kill -TERM "$hm_fg_pid" 2>/dev/null || true
    hm_fg_pid=""
  fi
  if [ -n "$pid" ]; then
    hm_server_pid=""
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 60); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5 9>&-
      done
    fi
    if kill -0 -- "-$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 -- "-$pid" 2>/dev/null || break
        sleep 0.5 9>&-
      done
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
    hm_log "đã dừng app"
  fi
  hm_reap_run "$HM_RUN_ID"
}
