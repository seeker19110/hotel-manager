#!/usr/bin/env bash
# task-completed.sh — hook TaskCompleted (AUTO-02, D-068). Khi task trong danh sách việc của phiên (`TaskUpdate`) sắp được
# đánh dấu xong mà subject nhắc `T-NNN` của PLAN chưa có bằng chứng xanh → exit 2 (task không được đánh dấu xong, stderr
# là lý do gửi lại model). Chỉ khi autopilot đang bật (`.autopilot/state.json` `active`). Bằng chứng đọc bằng CÙNG hàm của
# `xt.py` mà Stop hook dùng (`_verdict_task`: có evidence, exit 0, đúng Gate trong PLAN, thời điểm hợp lệ); ID không có
# trong PLAN thì chỉ đòi evidence exit 0. Lỗi bất kỳ (thiếu python3/xt.py, payload rác, xt.py đổi API) → exit 0 (fail-open
# về luồng; Stop hook vẫn là cổng cuối).
set -uo pipefail
. "$(dirname "$0")/_lib.sh"

payload="$(cat)"
command -v python3 >/dev/null 2>&1 || exit 0
XT="$(xt_py)" || exit 0
why="$(printf '%s' "$payload" | python3 -I -B -c '
import json, re, sys
from pathlib import Path

d = json.load(sys.stdin)
subject = str(d.get("task_subject") or d.get("subject") or "") if isinstance(d, dict) else ""
ids = list(dict.fromkeys(re.findall(r"\bT-\d{3,}\b", subject)))
if not ids:
    sys.exit(0)
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import xt
base = Path(sys.argv[2])
st = xt.read_state(base) or {}
if not st.get("active"):
    sys.exit(0)
tasks = {t["id"]: t for t in xt.parse_plan(base / st.get("plan", "docs/autopilot/PLAN.md"))}
bad = []
for i in ids:
    if i in tasks:
        v = xt._verdict_task(dict(tasks[i], state="x"), base, {}, str(st.get("started") or ""))
        bad += [v["reason"]] if v else []
    elif (xt.read_evidence(i, base) or {}).get("exit_code") != 0:
        bad.append(f"{i} chưa có bằng chứng xanh trong .autopilot/evidence/")
if bad:
    print("TaskCompleted bị chặn (AUTO-02): " + "; ".join(bad))
    print("Chạy `xt.py loop record --task <ID> -- <Gate trong PLAN>` tới khi exit 0 rồi mới đánh dấu xong.")
' "$XT" "$XT_ROOT" 2>/dev/null)" || exit 0
[ -n "$why" ] || exit 0
printf '%s\n' "$why" >&2
exit 2
