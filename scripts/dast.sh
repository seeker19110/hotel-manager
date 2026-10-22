#!/usr/bin/env bash
# Tấn công thử cục bộ (DAST — BASE-SEC-007, SEC-WEB-001/004/016): khoá `attack` của xt.yaml (`release-check` chạy trước phát
# hành) và job `dast` của .github/workflows/security-scan.yml cùng gọi script này.
#   build production → app tạm loopback (apps/web/e2e/server.ts, dữ liệu giả) → ZAP baseline (thụ động, spider 2 phút) →
#   ZAP quét chủ động (≤ 12 phút) → cổng scripts/zap-gate.mjs (đỏ khi còn cảnh báo Medium trở lên ngoài
#   security/zap/allowlist.json). `-I` chỉ để ZAP không tự quyết; quyết định ở zap-gate.
# Biến: DAST_OUT (thư mục kết quả: baseline/active .json/.html + server.log; mặc định `mktemp -d` — cây git giữ sạch) ·
#   DAST_SKIP_BUILD=1 (dùng bản build có sẵn) · E2E_PORT (mặc định 3100) · TEST_DATABASE_URL (không đặt = cluster Postgres
#   tạm của testkit) · ZAP_IMAGE (phải ghim digest sha256).
# Cần: node/pnpm (scripts/dev-env-setup.sh), PostgreSQL 17 hoặc TEST_DATABASE_URL, docker. Exit ≠ 0 = NO-GO.
set -euo pipefail

# shellcheck source=scripts/lib-e2e-app.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-e2e-app.sh"
hm_init dast

# ZAP 2.17.0 (index đa kiến trúc, tra ghcr.io 2026-10-18). Một nhà cho bản ghim: CI dùng chính giá trị này.
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6}"
[[ "$ZAP_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || hm_die 2 "ZAP_IMAGE phải ghim digest @sha256:<64 hex>, nhận: '$ZAP_IMAGE'"

hm_claim_port
command -v docker >/dev/null || hm_die 1 "thiếu docker (ZAP chạy bằng image $ZAP_IMAGE)"
docker info >/dev/null 2>&1 || hm_die 1 "docker daemon không phản hồi — khởi động dockerd rồi chạy lại"

OUT="$(hm_out_dir "${DAST_OUT:-}")"
# Container ZAP chạy bằng người dùng `zap` (không phải chủ thư mục): cho ghi báo cáo.
chmod 777 "$OUT"
hm_log "kết quả ghi vào $OUT"
trap hm_stop_app EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

hm_build "${DAST_SKIP_BUILD:-}"
hm_start_app "$OUT/server.log"

hm_log "ZAP baseline (quét thụ động, spider 2 phút)"
docker run --rm --network host -v "$OUT:/zap/wrk:rw" "$ZAP_IMAGE" \
  zap-baseline.py -t "$HM_BASE_URL" -m 2 -I -J baseline.json -r baseline.html
hm_log "ZAP quét chủ động (XSS/injection), giới hạn 12 phút"
docker run --rm --network host -v "$OUT:/zap/wrk:rw" "$ZAP_IMAGE" \
  zap-full-scan.py -t "$HM_BASE_URL" -m 2 -T 12 -I -J active.json -r active.html

hm_stop_app
hm_log "cổng DAST — đỏ khi còn cảnh báo Medium trở lên ngoài allowlist"
node "$HM_ROOT/scripts/zap-gate.mjs" "$OUT/baseline.json" "$OUT/active.json"
hm_log "✓ DAST xanh — báo cáo: $OUT"
