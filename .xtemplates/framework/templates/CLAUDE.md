---
title: Mẫu CLAUDE.md cho dự án
kind: template
updated: 2026-10-24
---

# CLAUDE.md

@AGENTS.md

## Riêng cho Claude Code
- Hook (`.claude/settings.json`): SessionStart nạp PROGRESS + trạng thái autopilot (cả sau compaction); PreCompact ghi checkpoint; PreToolUse là guard **không hỏi người** (ADR-0018 của khung) — chặn hành động không đảo ngược, lộ bí mật, tắt/bỏ qua hook, ghi tay `.autopilot/`, dấu review đăng tay, merge chưa đủ điều kiện, commit ghi tên model/URL phiên (`ai_attribution`); còn lại cho chạy (deploy, sửa cổng kèm lý do, thêm phụ thuộc…). Nhóm và lý do: `.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md` §Điểm dừng; luật đầy đủ nằm trong `.claude/hooks/guard.py`. Lệnh Gate/`xt.yaml` do harness chạy cũng qua guard. Bị chặn là kết luận (AGENTS.md §4).
- Quyền: `permissions.allow` có `Bash`, `ask` rỗng — Bash chạy không hỏi; hàng rào là `deny` của settings + guard. Muốn lớp hỏi: `XT_GUARD_POLICY=strict` và/hoặc thay `Bash` bằng danh sách `Bash(...)` cụ thể.
- Chế độ quyền chọn theo phiên (`defaultMode` ở settings dự án bị bỏ qua với `auto`/`bypassPermissions`): phiên cloud chọn **Auto** ở bộ chọn chế độ quyền; CLI `claude --permission-mode auto`. Autopilot một phiên cần Auto (Stop hook cảnh báo khi phiên ở chế độ hỏi). Ở Auto bộ phân loại vẫn có thể chặn thêm — bị chặn là kết luận.
- Headless: không dùng `--bare` (mất hook/skill/CLAUDE.md).
- Model/effort: phiên chính (điều phối — lập PLAN, viết SPEC) = model cao nhất sẵn có theo thứ tự **Fable → Opus → Sonnet** (`LOOP-ORCH-019`) — chọn lúc mở phiên/`--model`, không ghi vào artefact commit; subagent theo frontmatter `.claude/agents/*.md`. [ĐIỀN nếu dự án đổi]
