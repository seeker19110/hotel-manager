#!/usr/bin/env bash
# Kiểm môi trường phát triển (PLAN T-001): in phiên bản, thoát ≠ 0 nếu thiếu hoặc sai major/tối thiểu.
set -uo pipefail

PG_MAJOR="17"
fail=0

ok()  { printf '✓ %-11s %s\n' "$1" "$2"; }
bad() { printf '✗ %-11s %s\n' "$1" "$2"; fail=1; }

# So sánh phiên bản dạng a.b.c: trả 0 khi $1 >= $2
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

check() { # tên · lệnh lấy phiên bản · phiên bản tối thiểu · major bắt buộc (rỗng = không ràng buộc)
  local name="$1" cmd="$2" min="$3" major="$4" v
  if ! v="$(eval "$cmd" 2>/dev/null)" || [ -z "$v" ]; then bad "$name" "không tìm thấy"; return; fi
  if [ -n "$major" ] && [ "${v%%.*}" != "$major" ]; then bad "$name" "$v (cần major $major)"; return; fi
  if ! version_ge "$v" "$min"; then bad "$name" "$v (cần ≥ $min)"; return; fi
  ok "$name" "$v"
}

PG_BIN="/usr/lib/postgresql/${PG_MAJOR}/bin"
check postgres  "\"$PG_BIN/postgres\" --version | grep -oE '[0-9]+\.[0-9]+' | head -n1" "17.0"   "17"
check initdb    "\"$PG_BIN/initdb\" --version | grep -oE '[0-9]+\.[0-9]+' | head -n1"   "17.0"   "17"
check pgbackrest "pgbackrest version | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1"   "2.59.3" ""
check weed      "weed version | grep -oE '[0-9]+\.[0-9]+' | head -n1"                        "4.48"   ""
check node      "node --version | tr -d v"                                                   "24.0.0" "24"
check pnpm      "pnpm --version"                                                             "12.0.0" "12"

if [ "$fail" -ne 0 ]; then
  echo "Thiếu/sai thành phần — chạy scripts/dev-env-setup.sh" >&2
fi
exit "$fail"
