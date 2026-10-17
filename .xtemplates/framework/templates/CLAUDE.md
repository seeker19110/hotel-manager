---
title: Mẫu CLAUDE.md cho dự án
kind: template
updated: 2026-10-16
---

# CLAUDE.md

@AGENTS.md

<!-- Claude Code chỉ đọc CLAUDE.md khi có cả hai file; dòng import trên nạp AGENTS.md (nguồn sự thật duy nhất cho mọi harness).
     Chỉ ghi ở đây những gì RIÊNG cho Claude Code. File do install.py của khung X-Templates tạo (copy-if-absent). -->

## Riêng cho Claude Code
- Hook (`.claude/settings.json`): SessionStart nạp PROGRESS + trạng thái autopilot (cả sau compaction); PreCompact ghi checkpoint (`xt.py loop checkpoint`, luôn exit 0); PreToolUse chặn lệnh phá huỷ/`curl|sh` (cả lồng trong `sh -c`/heredoc), chặn ghi file bí mật, hỏi khi deploy/publish/push nhánh chính/merge PR (kể cả `gh api` ghi và tool MCP merge — chỉ tự merge khi `xt.py merge-check` cho phép), khi sửa cấu hình cổng/CI/hook/migration đã có, khi làm yếu/xoá test đã có, khi ghi tay `.autopilot/` (cả qua `python -c`/heredoc), khi tự thêm MCP/plugin/skill (`claude mcp add`, `.mcp.json`…), khi xoá đệ quy ngoài thư mục dự án, khi cập nhật snapshot, khi ra khỏi máy dev (`ssh`/`scp`/`rsync` tới máy khác, `psql`/`mysql`/`redis-cli` tới máy chủ không cục bộ, `curl`/`wget` gửi dữ liệu ra ngoài), khi thêm phụ thuộc mới (`pnpm add`, `pip install <gói>`…), khi chạy container có quyền máy chủ (`--privileged`, namespace host, mount `/`/home/socket) hoặc trên daemon máy khác; chặn gửi file bí mật/biến môi trường ra mạng; quét cả `eval`, backtick, `{ …; }`, `find -exec/-delete`; chạy cổng chất lượng trước `git commit` (commit vào repo ngoài dự án thì hỏi); PostToolUse format file vừa sửa; Stop đọc bằng chứng autopilot (`xt.py loop hook-stop`).
- `permissions.defaultMode` ở settings dự án bị bỏ qua với `auto`/`bypassPermissions`; muốn chạy không hỏi quyền: bật ở settings người dùng hoặc `--permission-mode` — autopilot một phiên: `claude --permission-mode auto`. Hook `deny` vẫn chặn kể cả ở bypass.
- Headless: không dùng `--bare` (mất hook/skill/CLAUDE.md).
- Model/effort: [ĐIỀN nếu dự án quy định — vd phiên chính opus/sonnet, subagent sonnet/haiku].
