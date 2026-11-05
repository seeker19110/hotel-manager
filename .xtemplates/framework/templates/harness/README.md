---
title: Adapter hook cho công cụ agent khác
kind: index
updated: 2026-11-03
---

# Adapter hook cho công cụ agent khác Claude Code (ADR-0064 lát B)

> Mỗi file là cấu hình hook của một công cụ, gọi cùng một adapter `.xtemplates/scripts/xt_adapter.py <host>`: adapter đổi
> payload của host sang schema trung lập của `guard.py core` rồi trả quyết định theo giao thức chặn của host. Luật chỉ
> nằm ở guard của khung (`.claude/hooks/guard.py`) — dự án cần harness `.claude/` đã cài. `install.py --harness
> codex,gemini,…` chép vào đúng chỗ (copy-if-absent; Gemini gộp khoá `hooks` vào `.gemini/settings.json`). Payload, cách
> chặn, cách xử lý lỗi/hết giờ từng host: `research/2026-11-02-multi-provider-harness.md` §9.
> **Tin cậy:** Codex (`/hooks` theo hash), Gemini (fingerprint), Grok (`/hooks-trust`) bỏ qua hook dự án tới khi người
> tin cậy — cài xong phải làm bước này một lần.
> **Khác Claude Code — tool ĐỌC file không qua adapter:** matcher các host chỉ gồm shell/ghi/MCP, nên `deny Read(**/.env)` chỉ
> có ở lớp quyền Claude (`.claude/settings.json`). Host khác dùng ignore/permission riêng của host (vd `.cursorignore`,
> `.geminiignore` — <https://cursor.com/docs/context/ignore-files>, <https://geminicli.com/docs/cli/gemini-ignore/>, đọc
> 2026-11-03) để chặn đọc bí mật (AUD-DOC-214). Sàn chung cho mọi công cụ vẫn là git hook ([`../git-hooks/`](../git-hooks/README.md)).

| File | Chép tới | Ghi chú |
|---|---|---|
| [`codex-hooks.json`](codex-hooks.json) | `.codex/hooks.json` | `PreToolUse`; matcher gồm cả `shell`/`exec_command` mà adapter nhận (tên tool thật của bản đang dùng: chưa xác minh 2026-11-03 — research §9 chỉ có `Bash`/`apply_patch`); `apply_patch` xét từng file trong thân patch; lỗi/hết giờ của hook thì Codex cho tool chạy (fail-open) |
| [`gemini-settings.json`](gemini-settings.json) | `.gemini/settings.json` (gộp `hooks`) | `BeforeTool`; tên MCP `mcp_<server>_<tool>` tách ở `_` đầu |
| [`cursor-hooks.json`](cursor-hooks.json) | `.cursor/hooks.json` | `preToolUse` với `failClosed: true`; Cursor cũng nạp `.claude/settings.json` (Third-Party Imports) — hook Claude chạy thêm, không hại |
| [`copilot-xt.json`](copilot-xt.json) | `.github/hooks/xt.json` | `preToolUse` (lỗi = chặn, hết giờ = cho qua); Copilot cũng đọc `.claude/settings.json` — chạy hai lần, quyết định vẫn đúng |
| [`grok-xt.json`](grok-xt.json) | `.grok/hooks/xt.json` | `PreToolUse` (chỉ deny tường minh chặn); matcher gồm tên thật `run_terminal_command`/`search_replace` (research §9) ngoài bí danh tên Claude — `write_file` vẫn chưa xác minh (2026-11-03); hook `.claude` cũng được nạp khi đã tin cậy |
| [`opencode-xt.ts`](opencode-xt.ts) | `.opencode/plugins/xt.ts` | plugin `tool.execute.before`, `throw` khi deny; hook có thể không chạy ở `opencode run` (chưa xác minh bản 1.19.5) |
