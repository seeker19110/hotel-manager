#!/usr/bin/env bash
# subagent-stop.sh — hook SubagentStop (AUTO-02, D-068). Subagent `executor`/`executor-deep` dừng mà báo cáo cuối không có
# "lệnh + exit code" (vd `exit 0`, `exit code: 1`, `rc=0`) → `{"decision": "block"}`: subagent làm tiếp và bổ sung bằng
# chứng (P1 — "xanh" phải kèm exit code). Báo cáo lấy từ `last_assistant_message`, thiếu thì từ lượt assistant cuối của
# `agent_transcript_path`. Chặn MỘT lần: lượt do chính hook này kích (`stop_hook_active`) thì cho dừng — phiên chính vẫn
# kiểm bằng `loop record`, không để subagent kẹt vòng. Subagent khác, payload rác, không đọc được báo cáo, thiếu python3
# → không in gì (fail-open). Luôn exit 0.
set -uo pipefail

payload="$(cat)"
command -v python3 >/dev/null 2>&1 || exit 0
printf '%s' "$payload" | python3 -I -B -c '
import json, re, sys

EXIT_RE = re.compile(r"\b(?:exit(?:[ _-]?(?:code|status))?|rc|mã thoát)\b\W{0,3}-?\d+", re.IGNORECASE)
EXECUTORS = {"executor", "executor-deep"}


def transcript_text(path):
    text = ""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") if isinstance(e, dict) and e.get("type") == "assistant" else None
            parts = m.get("content") if isinstance(m, dict) else None
            got = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text"] if isinstance(parts, list) else []
            text = "\n".join(got) or text
    return text


d = json.load(sys.stdin)
if not isinstance(d, dict) or str(d.get("agent_type") or "").split(":")[-1] not in EXECUTORS or d.get("stop_hook_active"):
    sys.exit(0)
msg = d.get("last_assistant_message")
if not isinstance(msg, str) or not msg.strip():
    msg = transcript_text(str(d.get("agent_transcript_path") or ""))
if msg.strip() and not EXIT_RE.search(msg):
    print(json.dumps({"decision": "block", "reason": (
        "Báo cáo executor thiếu lệnh + exit code (AUTO-02, P1): ghi từng lệnh đã chạy kèm exit code thật "
        "(vd `python3 -m unittest … → exit 0`); chưa chạy được thì ghi rõ lý do và exit code của lần thử.")},
        ensure_ascii=False))
' 2>/dev/null
exit 0
