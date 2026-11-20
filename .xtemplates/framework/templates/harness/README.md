---
title: Adapter hook cho công cụ agent khác
kind: index
updated: 2026-11-20
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

**Mức hỗ trợ** (thang stored METHOD.md §2; ADR-0068 lát D — "hỗ trợ" chỉ khi `checks-run` với payload thật kèm bản + ngày
ở `tests/fixtures/harness/<tool>/`): Claude Code — hỗ trợ (hook gốc của khung) · Codex, Gemini, Cursor, Copilot, Grok,
OpenCode — **thử nghiệm**: adapter chạy với payload dựng theo tài liệu host (`tests/test_adapters.py`), chưa có payload
thật (2026-11-05: Codex CLI 0.147.0 có trên máy dev nhưng chạy nó tốn hạn mức tài khoản của chủ dự án — chờ chủ dự án).

| File | Chép tới | Ghi chú |
|---|---|---|
| [`codex-hooks.json`](codex-hooks.json) | `.codex/hooks.json` | `PreToolUse`; matcher gồm cả `shell`/`exec_command` mà adapter nhận (tên tool thật của bản đang dùng: chưa xác minh 2026-11-03 — research §9 chỉ có `Bash`/`apply_patch`); `apply_patch` xét từng file trong thân patch; hết giờ hoặc lỗi không phải exit 2 thì Codex cho tool chạy (fail-open), nhưng exit 2 là chặn — chạy Codex ngoài repo git thì `$(git rev-parse --show-toplevel)` rỗng, lệnh thành `python3 -I -B "/.xtemplates/scripts/xt_adapter.py"` (không có tệp → exit 2) và Codex **chặn mọi tool khớp matcher**. Cùng `--harness codex`: skill và agent sinh từ `.claude/` (mục dưới) |
| [`gemini-settings.json`](gemini-settings.json) | `.gemini/settings.json` (gộp `hooks`) | `BeforeTool`; tên MCP `mcp_<server>_<tool>` tách ở `_` đầu |
| [`cursor-hooks.json`](cursor-hooks.json) | `.cursor/hooks.json` | `preToolUse` với `failClosed: true`; Cursor cũng nạp `.claude/settings.json` (Third-Party Imports) — hook Claude chạy thêm, không hại |
| [`copilot-xt.json`](copilot-xt.json) | `.github/hooks/xt.json` | `preToolUse` (lỗi = chặn, hết giờ = cho qua); Copilot cũng đọc `.claude/settings.json` — chạy hai lần, quyết định vẫn đúng |
| [`grok-xt.json`](grok-xt.json) | `.grok/hooks/xt.json` | `PreToolUse` (chỉ deny tường minh chặn); matcher gồm tên thật `run_terminal_command`/`search_replace` (research §9) ngoài bí danh tên Claude — `write_file` vẫn chưa xác minh (2026-11-03); hook `.claude` cũng được nạp khi đã tin cậy |
| [`opencode-xt.ts`](opencode-xt.ts) | `.opencode/plugins/xt.ts` | plugin `tool.execute.before`, `throw` khi deny; hook có thể không chạy ở `opencode run` (chưa xác minh bản 1.19.5) |

Tệp ở cột "Chép tới" (khi đã cài — tệp có thật; `.codex/hooks.json` luôn) là hàng rào như `.claude/settings.json`
(AUD-SEC-987/989): Bash ghi/xoá/dời hay git lấy từ rev khác chỉ mục/HEAD → guard chặn (HOOK_BYPASS); sửa bằng
Edit/Write hoặc chạy lại `install.py --harness`.

## Codex: skill và agent sinh từ `.claude/` (ADR-0082)

`--harness codex` ngoài `.codex/hooks.json` còn sinh, từ `.claude/` của dự án sau bước harness (nguồn duy nhất):
`.agents/skills/<tên>/SKILL.md` — bản sao byte của skill khung; `.codex/agents/<tên>.toml` — `name`, `description`,
`model_reasoning_effort` (từ `effort`), `developer_instructions` (thân tệp, giữ đường `.claude/…`), không `model` (agent
thừa hưởng model của phiên). Chỉ skill/agent khung cài (trừ skill bị `.claude/commands/` che); ghi như file harness:
chưa có → chép, còn đúng hash lần trước → cập nhật, dự án đã sửa → `kept-own`/`.xtemplates-new`; không ghi/đọc xuyên
symlink; hash ở `codex_files` của `.xtemplates/manifest.json`; `--plan` liệt kê ở `codex_harness` (kèm `reason` khi bỏ
qua). Tệp Codex là sản phẩm sinh từ `.claude/`: tệp trùng đầu ra sinh được ghi nhận vào `codex_files` (như tệp harness
trùng bản khung) và **đi theo** `.claude/` ở các lần cài sau — kể cả khi `--force-harness` thay nguồn; chỉ tệp KHÁC bản
đã ghi nhận mới được giữ, bản sinh ra `.xtemplates-new`. Lần cài Codex đầu (chưa ghi nhận): gương dự án tự có KHÁC đầu ra sinh được giữ
kèm `.xtemplates-new` (cả với `--force-harness`), trừ khi CHẮC CHẮN là bản khung đã cài theo manifest harness (skill:
trùng hash nguồn khung đã ghi; agent: nguồn `.md` chưa sửa và gương trùng bản sinh từ nó) thì cập nhật tại chỗ. Agent chỉ nhận frontmatter YAML phẳng (`khoá: giá trị` một dòng, giá trị
trơn hoặc nháy không thoát; `name`/`description`/`effort` trơn có kiểu YAML như `null`, `true`, số, ngày phải đặt trong
nháy); khối `|`/`>`, khoá lồng, nháy có thoát, chú thích cuối dòng, ngắt dòng lạ… → bỏ qua kèm cảnh báo nêu dòng, giữ
bản cũ. Sửa skill/agent ở `.claude/` thì chạy lại `install.py --harness codex`. Repo khung: `python3 scripts/install.py .
--sync-codex` (tệp ĐÃ track dưới `.agents/`, `.codex/` phải do bộ sinh tạo — thừa thì exit 1; tệp chưa track như
`.DS_Store`, `.codex/config.toml` cục bộ chỉ cảnh báo; không xoá gì).

**Tin cậy:** hook dự án chỉ chạy sau khi người tin cậy bằng `/hooks` (theo hash — đổi `hooks.json` phải tin cậy lại);
chưa tin cậy thì Codex bỏ qua cả lớp `.codex/`. **Giới hạn:** chỉ `PreToolUse` (không Stop hook — vòng "chạy đến khi
xong" của `/autopilot` không có ở Codex, dùng `loop run --agent codex`); `ask` không hỗ trợ; agent thừa hưởng model của phiên nên luật
"reviewer cao hơn người viết" (`LOOP-ORCH-005`) chỉ còn effort để phân biệt — `executor` và `reviewer` đều không khai
effort nên cặp mặc định **không** phân biệt được, chỉ `executor-deep` (high) so với `reviewer-alt` (max); tool đọc tệp không qua adapter; mức hỗ trợ vẫn **thử nghiệm**.
