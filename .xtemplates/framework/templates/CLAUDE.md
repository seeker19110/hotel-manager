---
title: Mẫu CLAUDE.md cho dự án
kind: template
updated: 2026-10-15
---

# CLAUDE.md

@AGENTS.md

<!-- Claude Code chỉ đọc CLAUDE.md khi có cả hai file; dòng import trên nạp AGENTS.md (nguồn sự thật duy nhất cho mọi harness).
     Chỉ ghi ở đây những gì RIÊNG cho Claude Code. File do install.py của khung X-Templates tạo (copy-if-absent). -->

## Riêng cho Claude Code
- Hook (`.claude/settings.json`): SessionStart nạp PROGRESS + trạng thái autopilot (cả sau compaction); PreCompact ghi checkpoint (`xt.py loop checkpoint`, luôn exit 0); PreToolUse chặn lệnh phá huỷ/`curl|sh`, hỏi khi deploy/publish/push nhánh chính hoặc sửa cấu hình cổng/CI/migration đã có; PostToolUse format file vừa sửa; Stop đọc bằng chứng autopilot (`xt.py loop hook-stop`).
- `permissions.defaultMode` ở settings dự án bị bỏ qua với `auto`/`bypassPermissions`; muốn chạy không hỏi quyền: bật ở settings người dùng hoặc `--permission-mode` — autopilot một phiên: `claude --permission-mode auto`. Hook `deny` vẫn chặn kể cả ở bypass.
- Headless: không dùng `--bare` (mất hook/skill/CLAUDE.md).
- Model/effort: [ĐIỀN nếu dự án quy định — vd phiên chính opus/sonnet, subagent sonnet/haiku].
