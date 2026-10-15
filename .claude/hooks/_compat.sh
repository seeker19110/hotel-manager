#!/usr/bin/env bash
# _compat.sh — nguồn SAU _lib.sh. Khi nâng cấp từ ≤ 2.x, install giữ `_lib.sh` người dùng đã sửa (chỉ có XS_ROOT/xs_py);
# hook mới cần XT_ROOT/xt_py — thiếu thì `set -u` lỗi, hook thoát 0 không quyết định → guard tắt im lặng (AUD-HAR-021).
# Chỉ lấp chỗ thiếu, không đè định nghĩa của _lib.sh.

XT_ROOT="${XT_ROOT:-${XS_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}}"
if ! declare -F xt_py >/dev/null; then
  xt_py() {
    for p in "$XT_ROOT/.xtemplates/scripts/xt.py" "$XT_ROOT/scripts/xt.py"; do
      [ -f "$p" ] && { printf '%s' "$p"; return 0; }
    done
    return 1
  }
fi
