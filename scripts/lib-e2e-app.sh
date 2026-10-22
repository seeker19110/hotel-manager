#!/usr/bin/env bash
# Thư viện dùng chung (chỉ `source`, không chạy trực tiếp) cho scripts/dast.sh và scripts/perf-load.sh: dựng app production
# tạm như job `e2e` của CI (apps/web/e2e/server.ts — Postgres 17 qua TEST_DATABASE_URL hoặc cluster tạm của testkit, seed giả,
# `next start`), chờ /api/health, và dừng chắc chắn khi thoát (nhóm tiến trình riêng: SIGTERM cho server.ts dọn DB tạm trước,
# rồi mới TERM/KILL phần còn sót của nhóm).
# Biến nhận: E2E_PORT (mặc định 3100), E2E_NO_REPLICA, TEST_DATABASE_URL. Đặt sau khi source: HM_ROOT, HM_PORT, HM_BASE_URL.

HM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HM_PORT="${E2E_PORT:-3100}"
HM_BASE_URL=""
hm_tag="app"
hm_server_pid=""

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
  export E2E_PORT="$HM_PORT"
  export NEXT_TELEMETRY_DISABLED=1
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

# Khoá theo cổng (hai lượt cùng cổng chạy song song sẽ đo/quét nhầm server của nhau) + cổng phải trống — không quét/tải vào
# một server lạ đang chạy sẵn. Gọi trước build.
hm_claim_port() {
  local lock="${TMPDIR:-/tmp}/hm-e2e-${HM_PORT}.lock" p
  exec 9>"$lock"
  flock -n 9 || hm_die 1 "cổng ${HM_PORT} đang được một lượt dast/perf khác dùng (khoá $lock) — chờ xong hoặc đặt E2E_PORT khác"
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
    (cd "$HM_ROOT" && pnpm --filter web build)
  fi
}

# Khởi động app trong nhóm tiến trình riêng, log vào $1; chờ /api/health tối đa 240 giây. Đỏ (exit 1) khi app chết/không lên.
hm_start_app() {
  local log="$1"
  hm_log "khởi động app tạm (e2e/server.ts) ở ${HM_BASE_URL}, log: $log"
  (cd "$HM_ROOT/apps/web" && exec setsid node e2e/server.ts) >"$log" 2>&1 </dev/null &
  hm_server_pid=$!
  for _ in $(seq 1 120); do
    if ! kill -0 "$hm_server_pid" 2>/dev/null; then
      tail -n 50 "$log" >&2 || true
      hm_server_pid=""
      hm_die 1 "app thoát trước khi sẵn sàng"
    fi
    if curl -fsS --max-time 2 "${HM_BASE_URL}/api/health" >/dev/null 2>&1; then
      hm_log "app sẵn sàng"
      return 0
    fi
    sleep 2
  done
  tail -n 50 "$log" >&2 || true
  hm_die 1 "app không lên trong 240 giây"
}

# Dừng app: SIGTERM cho server.ts (nó dừng Next, xoá DB/cluster tạm) và chờ tối đa 30 giây; còn sót trong nhóm → TERM rồi KILL.
hm_stop_app() {
  local pid="$hm_server_pid"
  [ -n "$pid" ] || return 0
  hm_server_pid=""
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
  fi
  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  hm_log "đã dừng app"
}
