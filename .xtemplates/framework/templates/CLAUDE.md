---
title: Mẫu CLAUDE.md cho dự án
kind: template
updated: 2026-10-18
---

# CLAUDE.md

@AGENTS.md

<!-- Claude Code chỉ đọc CLAUDE.md khi có cả hai file; dòng import trên nạp AGENTS.md (nguồn sự thật duy nhất cho mọi harness).
     Chỉ ghi ở đây những gì RIÊNG cho Claude Code. File do install.py của khung X-Templates tạo (copy-if-absent). -->

## Riêng cho Claude Code
- Hook (`.claude/settings.json`): SessionStart nạp PROGRESS + trạng thái autopilot (cả sau compaction); PreCompact ghi checkpoint (`xt.py loop checkpoint`, luôn exit 0); PreToolUse **không hỏi người** (ADR-0018 của khung) — nguy hiểm/không đảo ngược thì **chặn**: lệnh phá huỷ/`curl|sh` (cả lồng trong `sh -c`/heredoc), ghi file bí mật (cả qua Bash), gửi file bí mật/biến môi trường ra mạng, push thẳng nhánh chính/`push --all/--tags`, xoá đệ quy ngoài thư mục dự án, `stash drop/clear`, huỷ repo/bí mật/hạ tầng (`gh repo delete|archive`, `gh secret`, `kubectl delete`, `terraform|tofu|pulumi destroy`), container có quyền máy chủ (`--privileged`, namespace host, mount `/`/home/socket), tắt/bỏ qua hook, merge/bật auto-merge PR ngoại lệ cứng (`merge-check` trả `hard` — ADR-0019; `merge_hard_exceptions: auto` trong `xt.yaml` thì không còn `hard` — ADR-0020); còn lại **cho chạy** kể cả việc trước đây hỏi — deploy/publish, merge PR và bật auto-merge khác (kể cả `gh api` ghi, tool MCP merge, khi `xt.py merge-check` không cho — lớp đỡ là CI/ruleset nhánh), sửa cấu hình cổng/CI/hook/migration, làm yếu/xoá test, ghi tay `.autopilot/`, thêm MCP/plugin/skill, cập nhật snapshot, ra khỏi máy dev (`ssh`, `psql` tới máy khác, `curl` gửi dữ liệu…), thêm phụ thuộc, container trên daemon máy khác; quét cả `eval`, backtick, `{ …; }`, `find -exec/-delete`; chạy cổng chất lượng trước `git commit` (commit vào repo ngoài dự án: cho qua, không chạy cổng của repo lạ); `XT_GUARD_POLICY=strict` trả lại hành vi hỏi cũ; PostToolUse format file vừa sửa; Stop đọc bằng chứng autopilot (`xt.py loop hook-stop`).
- Quyền: `permissions.allow` gồm `Bash`, `permissions.ask` rỗng — mọi lệnh Bash chạy không hỏi; hàng rào là `deny` của settings và hook guard ở trên (ADR-0017, ADR-0018 của khung). Muốn lớp hỏi: đặt `XT_GUARD_POLICY=strict` và/hoặc thay `Bash` bằng danh sách `Bash(...)` cụ thể.
- Chế độ quyền chọn theo phiên — `permissions.defaultMode` ở settings dự án bị Claude Code bỏ qua với `auto`/`bypassPermissions`. **Phiên cloud** (claude.ai/code, app Claude): chọn chế độ **Auto** ở bộ chọn chế độ quyền khi mở phiên. Phiên CLI cục bộ: `claude --permission-mode auto` hoặc `defaultMode` ở settings người dùng. Autopilot một phiên cần chế độ Auto (Stop hook cảnh báo khi phiên ở `default`/`plan`/`acceptEdits` — phiên sẽ đứng chờ bấm duyệt). Ở Auto, bộ phân loại của Claude Code vẫn có thể chặn thêm (bị chặn là kết luận, AGENTS.md §4); `deny` của settings và guard chặn ở mọi chế độ, kể cả bypass.
- Headless: không dùng `--bare` (mất hook/skill/CLAUDE.md).
- Model/effort: [ĐIỀN nếu dự án quy định — vd phiên chính opus/sonnet, subagent sonnet/haiku].
