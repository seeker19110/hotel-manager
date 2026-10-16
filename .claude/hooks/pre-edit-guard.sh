#!/usr/bin/env bash
# pre-edit-guard.sh — PreToolUse hook (matcher: Edit|Write|MultiEdit).
# Chống "làm cổng xanh bằng cách nới cấu hình" (stored 12 §3, 23 §4.3):
#  - ASK khi sửa file cấu hình cổng/CI/quyền (workflow, lint/type/coverage config, settings của harness, ruleset) —
#    ở gốc HOẶC thư mục con (monorepo), đường dẫn chuẩn hoá (./, //, .., symlink) — audit AUD-SEC-006.
#  - ASK khi sửa migration ĐÃ TỒN TẠI (migration đã áp thì không được sửa — tạo migration mới).
#  - ASK khi sửa file test ĐÃ CÓ theo hướng làm yếu bài kiểm: thêm skip/only/xfail/@flaky hoặc bớt assertion (LOOP-CI-001).
#  - DENY ghi file bí mật (.env*, *.pem, *.key, secrets/, .npmrc, .pypirc, .netrc, .envrc).
# Danh sách đường dẫn dùng chung với pre-bash-guard ở guard.py. Lỗi → cho qua (fail-open).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
res="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$XT_ROOT" python3 "$(dirname "$0")/guard.py" edit 2>/dev/null)" || exit 0
decision="$(json_field "$res" decision)"
if [ "$decision" = "deny" ] || [ "$decision" = "ask" ]; then
  pretool_decision "$decision" "$(json_field "$res" reason)"
fi
exit 0
