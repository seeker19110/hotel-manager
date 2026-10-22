#!/usr/bin/env bash
# Kiểm tải cục bộ có ngưỡng (QA-PERF-002, QA-PERF-007, CMP-PRIV-008; D-072): khoá `perf` của xt.yaml (`release-check` chạy
# trước phát hành) và job `k6` của .github/workflows/perf-nightly.yml cùng gọi script này.
#   chặn đích (chỉ loopback — scripts/k6-target-guard.mjs) → k6 bản ghim → build production → app tạm (apps/web/e2e/server.ts,
#   dữ liệu giả, không bản sao) → phiên đăng nhập giả (e2e/perf-session-env.ts) → `k6 run` perf/k6/room-list.js profile `load`
#   (thresholds p95/p99 + tỷ lệ lỗi ở perf/k6/lib.js: vượt → k6 thoát ≠ 0) → quét PII trong log server (chạy cả khi k6 đỏ).
# KHÔNG BAO GIỜ tải vào production: đích luôn là app tạm do chính script dựng ở 127.0.0.1.
# Biến: PERF_OUT (thư mục kết quả: k6-summary.json + server.log; mặc định `mktemp -d` — cây git giữ sạch) ·
#   PERF_SKIP_BUILD=1 · E2E_PORT (mặc định 3100) · TEST_DATABASE_URL (không đặt = cluster Postgres tạm của testkit) ·
#   LOAD_VUS/LOAD_DURATION (mặc định 20 phiên × 3m như CI) · PW_CHROMIUM_PATH (trình duyệt cho bước đăng nhập).
# Exit ≠ 0 = NO-GO (k6 vượt ngưỡng, PII trong log, app không lên, đích không an toàn).
# Thời gian: build + ~5,5 phút k6 (ramp 1m + giữ 3m + giảm 1m + 30s) — dưới trần 30 phút của release-check; bị giết ngang thì
# lượt sau tự dọn app còn sót (scripts/lib-e2e-app.sh).
set -euo pipefail

# shellcheck source=scripts/lib-e2e-app.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-e2e-app.sh"
hm_init perf
export E2E_NO_REPLICA=1

# Đích cố định là app tạm của script; BASE_URL khác từ môi trường là nhầm lẫn nguy hiểm → dừng, không lặng lẽ bỏ qua.
if [ -n "${BASE_URL:-}" ] && [ "${BASE_URL%/}" != "$HM_BASE_URL" ]; then
  hm_die 2 "BASE_URL=$BASE_URL khác đích của script ($HM_BASE_URL) — script chỉ tải vào app tạm nó tự dựng"
fi
export BASE_URL="$HM_BASE_URL"
export K6_ALLOWED_HOSTS="${K6_ALLOWED_HOSTS:-127.0.0.1}"
node "$HM_ROOT/scripts/k6-target-guard.mjs" "$BASE_URL" "$K6_ALLOWED_HOSTS"
export K6_PROFILE=load
# Mặc định 20 phiên đồng thời, giữ 3 phút (runner CI 4 vCPU — số đo so sánh giữa các lần chạy, không thay số đo staging).
# Tên LOAD_* chứ không K6_VUS/K6_DURATION (xem dòng `unset` dưới).
LOAD_VUS="${LOAD_VUS:-20}"
LOAD_DURATION="${LOAD_DURATION:-3m}"
[[ "$LOAD_VUS" =~ ^[1-9][0-9]*$ ]] || hm_die 2 "LOAD_VUS phải là số nguyên dương, nhận: '$LOAD_VUS'"
[[ "$LOAD_DURATION" =~ ^[1-9][0-9]*[smh]$ ]] || hm_die 2 "LOAD_DURATION dạng <số><s|m|h>, nhận: '$LOAD_DURATION'"
# k6 coi biến K6_<tuỳ chọn> là tuỳ chọn gốc và ĐÈ `scenarios` của lib.js (perf/k6/lib.js) — bỏ để ngưỡng/profile không bị lách.
unset K6_VUS K6_DURATION K6_ITERATIONS K6_STAGES

hm_claim_port

k6_tmp=""
cleanup() {
  hm_stop_app
  if [ -n "$k6_tmp" ]; then rm -rf "$k6_tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! command -v k6 >/dev/null; then
  k6_tmp="$(mktemp -d "${TMPDIR:-/tmp}/hm-k6-XXXXXX")"
  hm_log "chưa có k6 trên PATH — cài bản ghim (kiểm SHA-256) vào $k6_tmp"
  DEV_ENV_OPT_DIR="$k6_tmp/opt" DEV_ENV_BIN_DIR="$k6_tmp/bin" bash "$HM_ROOT/scripts/dev-env-setup.sh" --only k6
  PATH="$k6_tmp/bin:$PATH"
fi
hm_log "dùng $(k6 version 2>/dev/null | head -n1)"

OUT="$(hm_out_dir "${PERF_OUT:-}")"
hm_log "kết quả ghi vào $OUT"

hm_build "${PERF_SKIP_BUILD:-}"
hm_start_app "$OUT/server.log"

# Phiên đăng nhập + ID seed (KEY=value). Cookie là phiên của DB tạm dữ liệu giả; ngoài Actions bỏ dòng `::add-mask::` để cookie
# không ra log. Chỉ nhận đúng bốn khoá, không eval.
hm_log "đăng nhập chủ khách sạn giả để lấy phiên cho k6"
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  session="$(exec 9>&-; cd "$HM_ROOT/apps/web" && hm_run node e2e/perf-session-env.ts)"
else
  session="$(exec 9>&-; cd "$HM_ROOT/apps/web" && hm_run node e2e/perf-session-env.ts 2> >(grep -v '^::add-mask::' >&2 || true))"
fi
while IFS= read -r line; do
  [ -n "$line" ] || continue
  key="${line%%=*}"
  case "$key" in
    K6_COOKIE | ORG_ID | PROPERTY_ID | UNIT_IDS) export "$key=${line#*=}" ;;
    *) hm_die 1 "perf-session-env.ts in khoá lạ: $key" ;;
  esac
done <<<"$session"
[ -n "${K6_COOKIE:-}" ] && [ -n "${ORG_ID:-}" ] && [ -n "${PROPERTY_ID:-}" ] ||
  hm_die 1 "thiếu K6_COOKIE/ORG_ID/PROPERTY_ID từ perf-session-env.ts"

hm_log "k6 load room-list: ${LOAD_VUS} phiên × ${LOAD_DURATION} (đỏ khi vượt thresholds)"
k6_rc=0
# Chạy nền + wait ngay trong shell này (không bọc subshell — trap INT/TERM dừng ngay); hm_run đóng fd khoá, gắn dấu lượt chạy.
hm_run_wait k6 run -e LOAD_VUS="$LOAD_VUS" -e LOAD_DURATION="$LOAD_DURATION" \
  --summary-export "$OUT/k6-summary.json" "$HM_ROOT/perf/k6/room-list.js" || k6_rc=$?

# Dừng app trước khi quét: server.ts chờ Next đóng stdio nên log đủ dòng cuối.
hm_stop_app
pii_log="$HM_ROOT/apps/web/e2e-logs/server-${HM_PORT}.log"
hm_log "quét PII trong log server (CMP-PRIV-008)"
pii_rc=0
node "$HM_ROOT/scripts/pii-log-scan.mjs" "$pii_log" || pii_rc=$?

[ "$k6_rc" -eq 0 ] || hm_die "$k6_rc" "k6 đỏ (exit $k6_rc — 99 = vượt thresholds); tóm tắt: $OUT/k6-summary.json"
[ "$pii_rc" -eq 0 ] || hm_die "$pii_rc" "quét PII đỏ (exit $pii_rc) trên $pii_log"
hm_log "✓ kiểm tải xanh — tóm tắt: $OUT/k6-summary.json"
