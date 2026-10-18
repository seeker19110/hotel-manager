#!/usr/bin/env bash
# Cài công cụ kiểm API/vận hành bằng binary GHIM phiên bản + SHA-256 (OPS-SLO-001, OPS-OBS-001).
# Một nguồn sự thật cho CI (`.github/workflows/api-ops.yml`) và máy dev. Không cài gì ngoài thư mục công cụ.
#
#   bash scripts/ops-tools.sh install promtool otelcol-contrib   # tải, kiểm SHA-256, giải nén vào $HM_TOOLS_DIR/bin
#   bash scripts/ops-tools.sh path                                       # in thư mục bin (để thêm vào PATH)
#   bash scripts/ops-tools.sh run promtool check rules deploy/prometheus/alerts.yml
#
# Nâng phiên bản: đổi *_VERSION và *_SHA256 (lấy từ file checksums của bản phát hành; bản phát hành ≥ 2 tuần), ghi vào PR.
# otelcol-contrib: phát hành không kèm file checksums riêng cho gói này ⇒ SHA-256 ghi ở đây là giá trị đo lúc ghim (2026-10-18).
set -euo pipefail

PROMETHEUS_VERSION="3.15.0"
PROMETHEUS_SHA256="2a542df32eac02ee17b9d844fb2aa1de00dafa5476579ba8a3ba862e9d572ea0"
OTELCOL_VERSION="0.161.0"
OTELCOL_SHA256="778c689efa681ff6e4722ce9f66b9b7f57c3ba009ab2e2b43dc2e0315862c731"

TOOLS_DIR="${HM_TOOLS_DIR:-$HOME/.cache/hm-tools}"
BIN_DIR="$TOOLS_DIR/bin"

# Cache hợp lệ = file nhị phân đã cài có SHA-256 ĐÚNG giá trị đã lưu cạnh nó (không chỉ chuỗi version: binary bị thay vẫn in version cũ).
# Dấu lưu = SHA-256 của chính binary lúc cài (sau khi gói tải về đã được kiểm SHA ghim) + ghim hiện hành.
cached_ok() { # tên ghim (phiên_bản-SHA256 của gói đã ghim; đổi ghim ⇒ cache cũ mất hiệu lực)
  local bin="$BIN_DIR/$1" stamp="$BIN_DIR/$1.sha256"
  [ -x "$bin" ] && [ -f "$stamp" ] || return 1
  [ "$(cat "$stamp")" = "$(sha256sum "$bin" | cut -d' ' -f1)-$2" ]
}

record_cache() { # tên ghim
  echo "$(sha256sum "$BIN_DIR/$1" | cut -d' ' -f1)-$2" > "$BIN_DIR/$1.sha256"
}

fetch() { # url sha256 dest
  curl -fsSL --retry 3 --max-time 300 "$1" -o "$3"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "SHA-256 không khớp: $1" >&2; exit 1; }
}

TMP_DIRS=()
cleanup() { [ "${#TMP_DIRS[@]}" -eq 0 ] || rm -rf "${TMP_DIRS[@]}"; }
trap cleanup EXIT # dọn thư mục tạm cả khi `exit 1` giữa chừng (trap RETURN không chạy khi `exit`)

install_one() {
  local tmp
  tmp="$(mktemp -d)"
  TMP_DIRS+=("$tmp")
  mkdir -p "$BIN_DIR"
  case "$1" in
    promtool)
      cached_ok promtool "$PROMETHEUS_VERSION-$PROMETHEUS_SHA256" && return 0
      fetch "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz" "$PROMETHEUS_SHA256" "$tmp/p.tgz"
      tar -xzf "$tmp/p.tgz" -C "$tmp" --strip-components=1 "prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool"
      install -m 0755 "$tmp/promtool" "$BIN_DIR/promtool"
      record_cache promtool "$PROMETHEUS_VERSION-$PROMETHEUS_SHA256" ;;
    otelcol-contrib)
      cached_ok otelcol-contrib "$OTELCOL_VERSION-$OTELCOL_SHA256" && return 0
      fetch "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_amd64.tar.gz" "$OTELCOL_SHA256" "$tmp/c.tgz"
      tar -xzf "$tmp/c.tgz" -C "$tmp" otelcol-contrib
      install -m 0755 "$tmp/otelcol-contrib" "$BIN_DIR/otelcol-contrib"
      record_cache otelcol-contrib "$OTELCOL_VERSION-$OTELCOL_SHA256" ;;
    *) echo "công cụ không biết: $1 (promtool | otelcol-contrib)" >&2; exit 2 ;;
  esac
}

cmd="${1:-}"
[ -n "$cmd" ] && shift
case "$cmd" in
  install)
    [ "$#" -ge 1 ] || { echo "dùng: ops-tools.sh install <công cụ>…" >&2; exit 2; }
    for t in "$@"; do install_one "$t"; done ;;
  path) echo "$BIN_DIR" ;;
  run)
    [ "$#" -ge 1 ] || { echo "dùng: ops-tools.sh run <công cụ> [đối số…]" >&2; exit 2; }
    install_one "$1"
    cleanup # `exec` thay tiến trình ⇒ trap EXIT không chạy
    exec "$BIN_DIR/$1" "${@:2}" ;;
  *) echo "dùng: ops-tools.sh install|path|run …" >&2; exit 2 ;;
esac
