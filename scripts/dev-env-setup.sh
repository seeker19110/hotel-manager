#!/usr/bin/env bash
# Cài môi trường phát triển KHÔNG cần Docker (PLAN T-001, ADR-0002):
#   PostgreSQL 17 + pgBackRest (kho PGDG, chữ ký apt), SeaweedFS 4.48 (binary, kiểm SHA-256),
#   Node 24 (kiểm SHA-256 theo SHASUMS256 của nodejs.org) + pnpm 12.
# Idempotent: thành phần đã đúng phiên bản thì bỏ qua. Cần root (hoặc sudo) cho apt.
# Dùng cho container phát triển/agent (Ubuntu 24.04 x86_64). CI dùng setup-node + service container.
set -euo pipefail

NODE_VERSION="24.22.0"
NODE_SHA256="cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008"
PNPM_VERSION="12.11.2"
WEED_VERSION="4.48"
WEED_SHA256="4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124"
# gitleaks (quét log CI tìm bí mật — SEC-SECRET-007): binary linux_x64 từ GitHub release, kiểm SHA-256 (checksums.txt của release v8.30.1).
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
# k6 (load test nightly — QA-PERF-002, .github/workflows/perf-nightly.yml): tarball linux-amd64 từ GitHub release, kiểm SHA-256
# (k6-v2.3.0-checksums.txt, phát hành 2026-09-21, đối chiếu băm tự tính 2026-10-18). Giấy phép AGPL-3.0: chỉ chạy để đo, không phân phối.
K6_VERSION="2.3.0"
K6_SHA256="39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1"
PG_MAJOR="17"
PGDG_KEY_FPR="B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"

BIN_DIR="${DEV_ENV_BIN_DIR:-$HOME/.local/bin}"
OPT_DIR="${DEV_ENV_OPT_DIR:-/opt}"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log() { printf '[dev-env] %s\n' "$*"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

install_postgres() {
  if [ -x "/usr/lib/postgresql/${PG_MAJOR}/bin/postgres" ] && command -v pgbackrest >/dev/null 2>&1; then
    log "PostgreSQL ${PG_MAJOR} + pgBackRest đã có"
    return
  fi
  . /etc/os-release
  local keyring=/usr/share/keyrings/pgdg.asc
  if [ ! -s "$keyring" ]; then
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$tmp/pgdg.asc"
    local fpr
    fpr="$(gpg --show-keys --with-colons "$tmp/pgdg.asc" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')"
    if [ "$fpr" != "$PGDG_KEY_FPR" ]; then
      echo "Khoá PGDG sai fingerprint: '$fpr'" >&2
      exit 1
    fi
    $SUDO install -m 0644 "$tmp/pgdg.asc" "$keyring"
  fi
  echo "deb [signed-by=${keyring}] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    | $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  # Cập nhật toàn bộ chỉ mục: gói PGDG phụ thuộc thư viện của kho Ubuntu (libllvm19, libssh2…).
  $SUDO apt-get update -qq
  # Không tạo cluster mặc định: test tự initdb vào thư mục tạm.
  echo "create_main_cluster = false" | $SUDO tee /etc/postgresql-common/createcluster.d/no-main.conf >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends \
    "postgresql-${PG_MAJOR}" "postgresql-contrib" pgbackrest >/dev/null
  log "đã cài PostgreSQL ${PG_MAJOR} + pgBackRest"
}

install_weed() {
  local dest="${OPT_DIR}/seaweedfs-${WEED_VERSION}"
  if [ ! -x "$dest/weed" ]; then
    curl -fsSL "https://github.com/seaweedfs/seaweedfs/releases/download/${WEED_VERSION}/linux_amd64.tar.gz" -o "$tmp/weed.tgz"
    echo "${WEED_SHA256}  $tmp/weed.tgz" | sha256sum -c --quiet -
    $SUDO mkdir -p "$dest"
    $SUDO tar -xzf "$tmp/weed.tgz" -C "$dest" weed
    log "đã cài SeaweedFS ${WEED_VERSION}"
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "$dest/weed" "$BIN_DIR/weed"
}

install_gitleaks() {
  local dest="${OPT_DIR}/gitleaks-${GITLEAKS_VERSION}"
  if [ ! -x "$dest/gitleaks" ]; then
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o "$tmp/gitleaks.tgz"
    echo "${GITLEAKS_SHA256}  $tmp/gitleaks.tgz" | sha256sum -c --quiet -
    $SUDO mkdir -p "$dest"
    $SUDO tar -xzf "$tmp/gitleaks.tgz" -C "$dest" gitleaks
    log "đã cài gitleaks ${GITLEAKS_VERSION}"
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "$dest/gitleaks" "$BIN_DIR/gitleaks"
}

install_k6() {
  local dest="${OPT_DIR}/k6-${K6_VERSION}"
  if [ ! -x "$dest/k6" ]; then
    curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz" -o "$tmp/k6.tgz"
    echo "${K6_SHA256}  $tmp/k6.tgz" | sha256sum -c --quiet -
    $SUDO mkdir -p "$dest"
    $SUDO tar -xzf "$tmp/k6.tgz" -C "$dest" --strip-components=1 "k6-v${K6_VERSION}-linux-amd64/k6"
    log "đã cài k6 ${K6_VERSION}"
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "$dest/k6" "$BIN_DIR/k6"
}

install_node() {
  local dest="${OPT_DIR}/node-v${NODE_VERSION}"
  if [ ! -x "$dest/bin/node" ]; then
    local f="node-v${NODE_VERSION}-linux-x64.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${f}" -o "$tmp/$f"
    echo "${NODE_SHA256}  $tmp/$f" | sha256sum -c --quiet -
    $SUDO mkdir -p "$dest"
    $SUDO tar -xJf "$tmp/$f" -C "$dest" --strip-components=1
    log "đã cài Node ${NODE_VERSION}"
  fi
  mkdir -p "$BIN_DIR"
  for b in node npm npx corepack; do ln -sf "$dest/bin/$b" "$BIN_DIR/$b"; done
  if ! "$dest/bin/npm" ls -g --depth=0 "pnpm@${PNPM_VERSION}" >/dev/null 2>&1; then
    "$dest/bin/npm" install -g --silent "pnpm@${PNPM_VERSION}"
    log "đã cài pnpm ${PNPM_VERSION}"
  fi
  ln -sf "$dest/bin/pnpm" "$BIN_DIR/pnpm"
}

# --only <thành phần,...>: cài một phần (vd CI chỉ cần `--only weed`). Mặc định: postgres, weed, node (gitleaks, k6 chỉ khi gọi tên).
only="all"
if [ "${1:-}" = "--only" ]; then only="${2:?thiếu danh sách sau --only}"; fi
want() { [ "$only" = "all" ] || [[ ",$only," == *",$1,"* ]]; }
want_named() { [[ ",$only," == *",$1,"* ]]; }

want postgres && install_postgres
want weed && install_weed
want node && install_node
want_named gitleaks && install_gitleaks
want_named k6 && install_k6
log "xong — chạy scripts/dev-env-check.sh để kiểm. Cần ${BIN_DIR} đứng trước các node khác trong PATH."
