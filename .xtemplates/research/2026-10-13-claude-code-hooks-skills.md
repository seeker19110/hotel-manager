---
title: Xác minh cơ chế Claude Code (hooks, skills, subagents, settings, loop)
kind: research
updated: 2026-10-13
---

# Xác minh cơ chế Claude Code — 2026-10-13

> Đọc từ tài liệu chính thức `code.claude.com/docs` ngày 2026-10-13 (chỉ mục: <https://code.claude.com/docs/en/claude_code_docs_map.md>).
> Mục nào chưa đọc được ghi **(chưa xác minh)**. Đây là dữ kiện nền cho harness `.claude/` của khung.

## Ba phát hiện quan trọng nhất cho chế độ tự chạy

1. `/goal <điều kiện>` là vòng lặp có sẵn: sau mỗi lượt một model nhỏ **chỉ đọc hội thoại** (không chạy tool, không đọc
   file) để phán "đạt/chưa/không thể". Tức là **lời khai** — khung dùng thêm Stop hook đọc **bằng chứng trên đĩa**.
   Nguồn: <https://code.claude.com/docs/en/goal.md>
2. `permissions.defaultMode` = `auto`/`bypassPermissions` **bị bỏ qua** trong `.claude/settings.json` của dự án. Muốn chạy
   không hỏi quyền phải bật ở settings người dùng/managed hoặc cờ `--permission-mode auto`.
   Nguồn: <https://code.claude.com/docs/en/permission-modes.md>
3. `claude -p --bare` bỏ qua hooks, CLAUDE.md, skills, subagents → CI chạy `--bare` sẽ **mất mọi cổng của khung**.
   Nguồn: <https://code.claude.com/docs/en/headless.md>

## Stop hook (<https://code.claude.com/docs/en/hooks.md>)

- stdin chung: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, …; riêng Stop:
  `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
- Chặn dừng: exit 0 + stdout `{"decision":"block","reason":"..."}` (`reason` bắt buộc, được đưa cho Claude); hoặc exit 2
  + stderr. Không có `decision` = cho dừng.
- Bảo vệ vòng lặp có sẵn: sau **8 lần** liên tiếp hook chặn mà không có tool call xen giữa, Claude Code bỏ qua lần chặn
  kế tiếp (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Có tool call thì đếm lại.
- Stop không chạy khi người dùng ngắt; lỗi API chạy `StopFailure`. `matcher` trên Stop bị bỏ qua.

## PreToolUse

- stdin: `tool_name`, `tool_input` (Bash: `tool_input.command`), `tool_use_id`.
- Cách chặn khuyến nghị: exit 0 + `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
  Exit 2 + stderr cũng chặn. `decision` cấp đầu đã lỗi thời cho PreToolUse.
- `deny` chặn cả ở `bypassPermissions`. Hook hết thời gian **không** chặn trừ khi đặt `"onFailure": "block"`.

## SessionStart / PreCompact / UserPromptSubmit

- SessionStart matcher: `startup`, `resume`, `clear`, `compact`, `fork`. Tiêm ngữ cảnh bằng
  `hookSpecificOutput.additionalContext` hoặc stdout thường. Exit 2 không chặn được.
- PreCompact matcher `manual`/`auto`; chặn bằng exit 2 hoặc `"decision":"block"`.
- UserPromptSubmit: exit 2 chặn prompt; `additionalContext` để thêm ngữ cảnh. (Tên trường chứa prompt: chưa xác minh.)

## Skills (<https://code.claude.com/docs/en/skills.md>)

- Vị trí dự án: `.claude/skills/<tên>/SKILL.md`; gọi bằng `/<tên>`. `.claude/commands/*.md` vẫn chạy (đã gộp vào skills).
- Frontmatter (đều tùy chọn): `name`, `description`, `when_to_use`, `argument-hint`, `disable-model-invocation`,
  `user-invocable`, `allowed-tools`, `model`, `effort`, `context: fork`, `agent`, … `description`+`when_to_use` bị cắt ở
  1.536 ký tự trong danh sách skill.

## Subagents (<https://code.claude.com/docs/en/sub-agents.md>)

- `.claude/agents/<tên>.md`, bắt buộc `name` + `description`; `model`: `sonnet` · `opus` · `haiku` · `fable` · ID đầy đủ ·
  `inherit`; `tools`, `disallowedTools`, `maxTurns`, `isolation: worktree`, …
- Subagent **có thể** lồng tối đa 3 tầng (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` = tắt lồng). Muốn cấm một subagent
  sinh thêm: bỏ `Agent` khỏi `tools`.

## settings.json (<https://code.claude.com/docs/en/settings.md>)

- `$schema`: `https://json.schemastore.org/claude-code-settings.json`. JSON nghiêm ngặt (không comment).
- Thứ tự ưu tiên: managed › `--settings` › `.claude/settings.local.json` › `.claude/settings.json` › `~/.claude/settings.json`.
- `permissions.allow/ask/deny` theo cú pháp `Bash(npm run test *)`, `Read(./.env)`.
- `hooks.<Sự kiện>[] = {matcher, hooks:[{type:"command", command, timeout}]}`; `timeout` tính bằng giây;
  `${CLAUDE_PROJECT_DIR}` = gốc dự án.

## AGENTS.md (<https://code.claude.com/docs/en/memory.md>)

- Claude Code đọc `AGENTS.md` trực tiếp **chỉ khi không có** `CLAUDE.md`. Có cả hai → chỉ đọc `CLAUDE.md`.
- Vì vậy `CLAUDE.md` của khung phải có dòng `@AGENTS.md` (import, tối đa 4 tầng, không nằm trong code block).

## Headless và vòng lặp

- `claude -p "..." --max-turns N --max-budget-usd X --permission-mode auto --output-format json`.
- `/loop` (lịch trong phiên, hết hạn 7 ngày, tối đa 50 tác vụ), Routines (đám mây, lịch ≥ 1 giờ, đẩy lên nhánh `claude/`).

## Chưa xác minh

- Bảng đầy đủ hành vi exit 2 theo từng sự kiện; schema của hook `type: "prompt"`; `/goal` trong Routine.
