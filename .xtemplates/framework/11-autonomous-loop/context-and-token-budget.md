---
title: Ngân sách context/token, compaction, bàn giao phiên
kind: module
prefix: LOOP-CTX
applies_to: [all]
updated: 2026-10-16
---

# Ngân sách context/token, compaction, bàn giao phiên

> Context là tài nguyên hữu hạn và **chất lượng giảm trước khi đầy**. Module này quy định cách giữ context gọn
> (think-in-code, không đổ file lớn), ranh giới phiên, compaction có kiểm soát, cache prompt, và bàn giao qua
> `PROGRESS.md` để phiên sau nối tiếp bằng một câu "tiếp tục".

## Nguyên tắc

1. **Trạng thái sống trên đĩa, không trong context** (stored 03 §6): `PROGRESS.md` (luật định dạng ở [`LOOP-HARNESS-004`](harness-files.md)); mọi quyết định,
   SHA, bước kế tiếp ghi file; context chỉ là bộ nhớ làm việc.
2. **Think-in-code**: thay vì đọc log/JSON dài vào context, viết script lọc (grep/jq/python) rồi đọc 20–40 dòng
   kết quả; `xt.py loop record` chỉ giữ `output_tail` 40 dòng vì lý do này.
3. **Lập kế hoạch một lần, chạy theo file**: không lập lại plan mỗi lượt; PLAN.md là nguồn, agent chỉ đọc task
   kế tiếp (old framework `models-and-automation.md` §5).
4. **Một phiên đến khi xong** (ADR-0009): autopilot chạy trong một phiên tới `done`/`done-pending-human`; xong mảng →
   gate → commit → cập nhật PROGRESS rồi **làm tiếp**, không mở phiên mới. Context đầy → compaction tự nén, PreCompact
   ghi checkpoint, SessionStart(compact) nạp lại; chống drift bằng PLAN + bằng chứng trên đĩa, không bằng cắt phiên.
   Trạng thái vẫn đủ trên đĩa để phiên chết bất ngờ thì "tiếp tục" nối được.
5. **Ngân sách là cổng máy**: trần vòng/giờ (`loop init`), `--max-turns`, `--max-budget-usd`; đến 80% **trần máy** →
   chế độ bàn giao, không "cố thêm một task". Context đầy không phải trần máy.
6. **Cache được thì cache**: phần ổn định (system, luật, tool schema) đứng trước, phần biến đổi đứng sau, chỉ append;
   kiểm hiệu quả bằng số đo (`cache_read_input_tokens`), không bằng cảm giác.

## Quyết định

### Chế độ context theo mức dùng ngân sách

| Mức (vòng, giờ, tiền) | Chế độ | Hành vi |
|---|---|---|
| < 50% | Làm việc | Task kế tiếp; đọc chọn lọc |
| 50–80% | Tiết kiệm | Không mở file > 300 dòng nguyên văn; giao đọc dài cho `researcher` |
| ≥ 80% | Bàn giao | Hoàn tất task đang dở **hoặc** ghi rõ chỗ dở; cập nhật PROGRESS; commit + push; để Stop hook kết thúc |
| 100% | Dừng | Verdict `budget`; không tick task; phiên sau đọc PROGRESS |

**Context** đi đường riêng: đầy → compaction tự nén (PreCompact → `xt.py loop checkpoint` ghi task đang làm, lệnh kiểm
cuối + exit code, file chưa commit, lỗi lặp vào `.autopilot/state.json`; SessionStart(compact) in lại qua `loop status`)
rồi chạy tiếp. Áp dụng khi `loop init --single-session` (trần vòng tự tính `max(20, 4 × task chưa làm)`).

Ngưỡng 80/100 tương ứng circuit breaker 80/90/100 của stored 21 §10; 90% là mốc cảnh báo nếu harness có đo chi phí thật.

### Cái gì vào context, cái gì ở ngoài

| Vào context | Ở ngoài (đọc khi cần, qua script/subagent) |
|---|---|
| `AGENTS.md` (≤ 200 dòng), 4 mục PROGRESS (≤ 8 KB), task hiện tại + Gate, SPEC của task | README dài, tài liệu khung (`.xtemplates/framework/**`, đọc đúng module), log CI, lockfile, dữ liệu mẫu |
| Diff đang sửa, 20–40 dòng output lệnh | Output lệnh > 40 dòng → ghi file, grep; file > 1 MB không `cat` |
| Kết quả tóm tắt của subagent (≤ 25 dòng) | Transcript subagent, nội dung web nguyên văn |

### Biến điều khiển compaction và suy nghĩ (Claude Code)

| Biến | Tác dụng | Ghi chú |
|---|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Cửa sổ tính compaction tự động (100 000–1 000 000 token) | Đặt thấp để compaction sớm hơn trên phiên dài |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | % context kích compaction (1–100), chỉ hạ, không nâng | Kết hợp PreCompact hook ghi checkpoint |
| `MAX_THINKING_TOKENS` | Trần token suy nghĩ mỗi lượt | Hạ cho task cơ học; giữ cho thiết kế/debug |
| PreCompact hook (`manual`/`auto`) | Chạy script trước khi nén; có thể chặn bằng exit 2 | Dùng để ghi PROGRESS trước khi mất chi tiết |

## Checklist

- [ ] `LOOP-CTX-001` **MUST** SessionStart chỉ nạp 4 mục của `PROGRESS.md` (Đang làm · Tiếp theo · Quyết định · Bàn giao phiên) để phiên sau tiếp tục; định dạng và độ tươi theo [`LOOP-HARNESS-004`](harness-files.md)/[`LOOP-HARNESS-005`](harness-files.md). → Kiểm: chạy `session-start.sh` với PROGRESS mẫu chỉ in 4 mục đó (cắt ở 8 KB). · Nguồn: stored 03 §6; `.claude/hooks/session-start.sh`
- [ ] `LOOP-CTX-002` **MUST** Mỗi lần chạy headless hoặc `loop init` khai trần: `--max-iterations`/`--hours` và (headless) `--max-turns` + `--max-budget-usd`. → Kiểm: `.autopilot/state.json` có `max_iterations`, `deadline`; JSON headless có `total_cost_usd`. · Nguồn: [`loop-design.md`](loop-design.md)
- [ ] `LOOP-CTX-003` **MAY** Ngừng dùng 2026-10-15 — thay bằng `LOOP-CTX-017` (ADR-0009: context lớn không còn là lý do bàn giao; compaction có checkpoint thay thế).
- [ ] `LOOP-CTX-004` **MUST@L** Không `cat` file > 1 MB hoặc đổ output lệnh > 40 dòng vào context; lọc bằng script rồi đọc phần cần. → Kiểm: `.claude/settings.json`/hook chặn `cat` file lớn hoặc quy ước trong `AGENTS.md`; `xt.py loop record` giữ `output_tail` 40 dòng. · Nguồn: stored 03 §8b
- [ ] `LOOP-CTX-005` **MUST@L** Kế hoạch lập một lần và ghi `PLAN.md`; mỗi vòng chỉ đọc task kế tiếp, không lập lại kế hoạch. → Kiểm: `git log` của `PLAN.md` chỉ đổi dấu tick/ghi chú sau cổng duyệt; thay đổi danh sách task phải có lý do trong PROGRESS. · Nguồn: old framework `models-and-automation.md` §5
- [ ] `LOOP-CTX-006` **MUST** Mọi thứ cần cho phiên sau nằm trong repo (PLAN, PROGRESS, SPEC, ADR, evidence hoặc link CI), không phụ thuộc trí nhớ phiên trước. → Kiểm: phiên mới với chỉ `AGENTS.md` + PROGRESS tiếp tục được đúng task (test bằng phiên thật). · Nguồn: stored 03 §6
- [ ] `LOOP-CTX-007` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-006`](../18-cross-cutting/docs-for-ai-agents.md): `AGENTS.md`/`CLAUDE.md` của dự án ≤ 200 dòng, chi tiết để trong module và link tới.
- [ ] `LOOP-CTX-008` **MAY** Ngừng dùng 2026-10-15 — thay bằng `LOOP-CTX-018` (ADR-0009: một phiên đến khi xong).
- [ ] `LOOP-CTX-009` **SHOULD** Đặt PreCompact hook ghi checkpoint (task hiện tại, lệnh vừa chạy, lỗi đang xử lý) trước khi nén, SessionStart(compact) nạp lại; hook luôn exit 0 (exit 2 chặn nén). → Kiểm: `.claude/settings.json` có `PreCompact` → `pre-compact.sh` → `xt.py loop checkpoint`; sau nén `loop status` có dòng "checkpoint trước nén"; test `test_pre_compact_*`. · Nguồn: Claude Code hooks docs (PreCompact/SessionStart `source: compact`, xác minh 2026-10-15)
- [ ] `LOOP-CTX-010` **SHOULD** Việc đọc dài (tài liệu, repo lạ, log CI) giao subagent `researcher`; phiên chính nhận tóm tắt có đường dẫn/URL. · Nguồn: [`orchestration-and-subagents.md`](orchestration-and-subagents.md)
- [ ] `LOOP-CTX-011` **SHOULD** Prompt hệ thống/luật/tool schema đứng trước và ổn định; nội dung biến đổi append phía sau để tận dụng prompt cache; đo `cache_read_input_tokens` > 0 trước khi tin cache có tác dụng. · Nguồn: [`../13-ai-engineering/llm-app-foundations.md`](../13-ai-engineering/llm-app-foundations.md)
- [ ] `LOOP-CTX-012` **MAY** Ngừng dùng 2026-10-15 — thay bằng `LOOP-CTX-019` (ADR-0009: vượt ngân sách thì thu hẹp phạm vi, không chia phiên).
- [ ] `LOOP-CTX-013` **SHOULD** Skill/tài liệu khung nạp theo tầng (progressive disclosure): chỉ `description` thường trực, nội dung khi gọi; SKILL.md < 500 dòng. · Nguồn: Agent Skills spec
- [ ] `LOOP-CTX-014` **SHOULD** Mức suy nghĩ (`MAX_THINKING_TOKENS`/effort) đặt theo loại task: thấp cho cơ học (format, rename, boilerplate), cao cho thiết kế/debug khó; ghi trong PLAN khi khác mặc định.
- [ ] `LOOP-CTX-015` **MAY** Đo chất lượng theo phiên (tỉ lệ Gate xanh lần đầu, số lần `verify`) so với độ dài phiên; nếu giảm sau N vòng → hạ ngưỡng bàn giao từ 80% xuống thấp hơn.
- [ ] `LOOP-CTX-016` **MAY** Dùng `CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` để nén sớm trên phiên autopilot dài, kèm PreCompact checkpoint. · Nguồn: Claude Code env-vars docs
- [ ] `LOOP-CTX-017` **MUST** Bàn giao chỉ khi chạm ≥ 80% **trần máy** (vòng/giờ/tiền), không vì context: context đầy → compaction có checkpoint rồi làm tiếp; khi bàn giao: chỗ dở + bước kế tiếp + SHA vào PROGRESS, commit + push, không mở task mới. → Kiểm: `.claude/settings.json` có hook `PreCompact`; PROGRESS "Bàn giao phiên" chỉ cập nhật khi `loop status --json` `iterations/max_iterations` ≥ 0.8 hoặc verdict `budget`. · Nguồn: ADR-0009, stored 21 §10
- [ ] `LOOP-CTX-018` **SHOULD** Autopilot chạy một phiên tới `done`/`done-pending-human` (`loop init --single-session`): xong một mảng → gate → commit → cập nhật PROGRESS rồi làm tiếp trong cùng phiên; trạng thái trên đĩa đủ để phiên chết bất ngờ vẫn "tiếp tục" được. → Kiểm: `state.json` `single_session: true`; số phiên của một PLAN = 1 trừ khi `budget`/phiên chết. · Nguồn: ADR-0009
- [ ] `LOOP-CTX-019` **SHOULD** Ước lượng token mỗi task khi lập PLAN, nhân 1.5 dự phòng, để đặt `--max-budget-usd`/`--hours`; tổng vượt ngân sách → thu hẹp phạm vi PLAN theo tiêu chí chất lượng cuối (ghi `D-NNN`), không chia phiên; nâng ngân sách tiền là việc của người. → Kiểm: PLAN có dòng ước lượng; D-NNN cho phần cắt. · Nguồn: stored 21 §10, ADR-0008, ADR-0009
- [ ] `LOOP-CTX-020` **SHOULD** Autopilot chạy ở chế độ quyền không hỏi (`claude --permission-mode auto`; `bypassPermissions` chỉ trong container dùng một lần; `dontAsk` cho headless) — bật bằng cờ hoặc settings người dùng vì settings dự án bị bỏ qua; hook `deny` vẫn chặn. → Kiểm: `.autopilot/state.json` `permission_mode` (Stop hook ghi) ∉ {`default`, `plan`, `acceptEdits`}; Stop hook nhắc khi vi phạm. · Nguồn: Claude Code permission modes + hooks docs (`permission_mode` trong input Stop, xác minh 2026-10-15), ADR-0009

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| `cat` lockfile/log CI 5 000 dòng "để xem" | Context đầy, compaction mất chi tiết task | Script lọc; đọc tail/grep |
| PROGRESS phình thành nhật ký 40 KB | SessionStart cắt mất phần quan trọng | 4 mục, ≤ 8 KB; lịch sử để `git log` |
| "Cố thêm một task" ở 95% ngân sách | Task dở không bàn giao; phiên sau mò lại | Ngưỡng 80% trần máy → bàn giao |
| Bàn giao vì context đầy giữa autopilot | Phiên dừng, người phải mở phiên mới — vòng lặp đứng hàng giờ | `--single-session`: compaction + PreCompact checkpoint, làm tiếp |
| Chạy autopilot ở chế độ hỏi quyền | Lệnh đầu tiên ngoài allowlist làm phiên đứng chờ người bấm | `claude --permission-mode auto`; Stop hook cảnh báo |
| Lập lại kế hoạch mỗi lượt | Drift khỏi PLAN đã duyệt, tốn token | PLAN là nguồn; đổi task phải ghi lý do |
| Tin rằng compaction giữ đủ | Mất lệnh đã chạy, lỗi đang sửa | PreCompact checkpoint + PROGRESS |
| Đặt `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` cao hơn mặc định để "ít nén" | Biến chỉ hạ, không nâng → không tác dụng | Đọc docs; đo thực tế |
| Nhét toàn bộ khung vào `CLAUDE.md` | Mỗi lượt tốn hàng nghìn token cố định | ≤ 200 dòng (`XC-DOCAI-006`); link module |
| Đo cache bằng "thấy nhanh hơn" | Cache không hit vì prefix đổi | Đo `cache_read_input_tokens` |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Định dạng PROGRESS | `xt.py progress-check` (luật ở [`LOOP-HARNESS-004`](harness-files.md)) | Cổng commit / CI | exit 0 |
| Kích thước AGENTS.md | `wc -l AGENTS.md` | Cổng commit | ≤ 200 dòng |
| Trần vòng/giờ | `xt.py loop status --json` | Stop hook | `budget` khi `iterations ≥ max_iterations` hoặc quá `deadline` |
| Checkpoint trước nén | `.claude/hooks/pre-compact.sh` → `xt.py loop checkpoint` | PreCompact hook | luôn exit 0; `state.json.checkpoint` cập nhật |
| Chế độ quyền | `xt.py loop hook-stop` đọc `permission_mode` | Stop hook | cảnh báo khi `default`/`plan`/`acceptEdits` |
| Trần chi phí headless | `claude -p … --max-turns N --max-budget-usd X --output-format json` | Workflow CI | `total_cost_usd` ≤ X |
| Output lệnh trong bằng chứng | `xt.py loop record` (giữ 40 dòng cuối) | Mọi Gate | `output_tail` ≤ 40 dòng |
| Checkpoint trước nén | PreCompact hook ghi PROGRESS | `.claude/settings.json` | Hook exit 0 |

## Nguồn

- ADR-0009 (`docs/adr/0009-single-session-autopilot.md` của repo khung): một phiên đến khi xong — chủ repo yêu cầu 2026-10-15.
- Claude Code hooks reference — PreCompact (`trigger`, exit 2 chặn nén), SessionStart (`source: compact`), `permission_mode` trong input Stop: <https://code.claude.com/docs/en/hooks.md> — xác minh 2026-10-15.
- Harness thật: `.claude/hooks/pre-compact.sh`, `.claude/hooks/session-start.sh` (nạp 4 mục PROGRESS, cắt 8 KB), `.claude/skills/handover/SKILL.md`, `scripts/xt.py` (`output_tail` 40 dòng, `max_iterations`, `deadline`) — đọc 2026-10-13.
- Claude Code docs — env vars `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100 000–1 000 000), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100, chỉ hạ), `MAX_THINKING_TOKENS`: <https://code.claude.com/docs/en/env-vars> · hooks PreCompact: <https://code.claude.com/docs/en/hooks> · headless `--max-turns`/`--max-budget-usd`/`total_cost_usd`: <https://code.claude.com/docs/en/headless> — xác minh 2026-10-13 (`research/2026-10-13-claude-code-hooks-skills.md`).
- Anthropic, *Effective context engineering for AI agents* (2025-09-29): <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> — theo `research/2026-10-13-ai-agent-research.md` §1 [F].
- Agent Skills spec (progressive disclosure, SKILL.md < 500 dòng): <https://agentskills.io/specification> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §4).
- `seeker19110/stored` mục 03 §6 (trạng thái trên đĩa, PROGRESS ≤ 8 KB), §8b (think-in-code, chế độ context), mục 21 §10 (circuit breaker 80/90/100, ước lượng token ×1.5) — đọc 2026-10-13.
- Khung cũ `docs/framework/models-and-automation.md` §5 (plan một lần, ngữ cảnh gọn, phiên mới sau mỗi mảng) — `git show 1b80fe4`, đọc 2026-10-13 (`research/2026-10-13-old-framework-analysis.md`).
