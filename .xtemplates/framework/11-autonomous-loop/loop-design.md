---
title: Thiết kế vòng lặp: 4 con số, tiêu chí dừng máy kiểm, bằng chứng
kind: module
prefix: LOOP-DESIGN
applies_to: [all]
updated: 2026-10-16
---

# Thiết kế vòng lặp: 4 con số, tiêu chí dừng máy kiểm, bằng chứng

> Vòng lặp tự động (autopilot) chỉ đáng tin khi **máy quyết định dừng**, không phải model tự khai "xong". Module này
> đặt luật cho mọi vòng lặp agent làm việc trên repo: 4 con số bắt buộc, tín hiệu dừng do code điền, chuỗi lỗi lặp →
> BLOCKED, và cơ chế thật đã cài trong `scripts/xt.py loop`. Áp dụng khi dùng AI agent làm việc nhiều vòng trên dự án.

## Nguyên tắc

1. **Harness sở hữu vòng lặp.** Model đề xuất bước kế tiếp; điều kiện dừng là code xác định (`xt.py loop status`), đọc
   artifact trên đĩa: `PLAN.md`, `.autopilot/state.json`, `.autopilot/evidence/T-xxx.json`, `BLUEPRINT.md`.
2. **Mọi vòng lặp có 4 con số:** trần số vòng · ngân sách (token/tiền) · timeout mỗi lệnh · hạn chót. Thiếu một số là
   demo, không phải workflow tự trị (stored 21 §10).
3. **Bằng chứng, không lời khai** (P1): task chỉ được tick khi `loop record` ghi `exit_code: 0` với **đúng lệnh Gate**.
   `<promise>COMPLETE</promise>`, `/goal`, "tôi đã chạy test" đều là lời khai.
4. **Lỗi lặp là tín hiệu đặc tả sai, không phải code sai:** cùng một chữ ký lỗi 3 lần → `blocked`, người xem.
5. **Harness có hạn sử dụng:** mỗi hàng rào mã hoá một giả định về điểm yếu của model tại thời điểm viết; ghi ngày và
   xét lại khi đổi model (Anthropic harness design 2026-03-24).
6. **Dừng an toàn hơn chạy sai:** Stop hook lỗi → fail-open (cho dừng); cổng bảo mật lỗi → fail-closed (chặn). Hai
   chiều ngược nhau là cố ý.

## Quyết định

### Chọn tầng vòng lặp (stored 21 §1)

| Nhu cầu | Tầng | Dùng gì | Không dùng khi |
|---|---|---|---|
| Làm tới khi PLAN xong trong một phiên | Loop trong phiên | Stop hook `xt.py loop hook-stop` (mặc định của khung) | Việc cần chờ người nhiều ngày |
| Việc nhiều giờ, nhiều cửa sổ context | Harness dài hạn | Stop hook + `PROGRESS.md` bàn giao + phiên mới (`context-and-token-budget.md`) | — |
| Quay lại định kỳ (poll CI, chăm PR) | Trigger trong phiên | `/loop <khoảng> <prompt>` (hết hạn 7 ngày, ≤ 50 task/phiên) | Cần chạy khi không mở máy |
| Chạy không người trực | Trigger ngoài phiên | Routine đám mây (≥ 1 giờ), GitHub Actions `schedule` | Hành động đối ngoại — chỉ **đề xuất** |
| Bảo trì khi production lệch chuẩn (G8 → task mới) | Trigger theo ngưỡng | Script tất định so chỉ số với baseline, gọi agent headless theo bậc quyền (`LOOP-DESIGN-019`) | Chưa có SLO/baseline ([`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)) |
| Side effect thật + chờ duyệt lâu + sống qua crash | Durable runtime | Xem [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md) | Việc chỉ sửa code trong repo |

### Verdict máy của `xt.py loop status` (đọc từ đĩa, thứ tự ưu tiên)

| Verdict | Khi nào | Stop hook làm gì |
|---|---|---|
| `inactive` | Chưa `loop init` hoặc đã tắt | Cho dừng |
| `blocked` | `loop block` đã gọi · `same_failure_count ≥ 3` · không thấy PLAN · PLAN không có task | Cho dừng, `active=false`, ghi `final_verdict` |
| `budget` | `iterations ≥ max_iterations` (mặc định 50) · quá `deadline` (`--hours`) | Cho dừng, `active=false` |
| `continue` | Còn task `[ ]`, hoặc blueprint còn MUST mở / miễn trừ không hợp lệ (thiếu lý do, MUST `Miễn` thiếu `Duyệt:`) / dòng mục sai định dạng hoặc bị xoá | **Chặn dừng**, `iterations += 1`, nêu task kế |
| `verify` | Task `[x]` nhưng không có evidence, `exit_code ≠ 0`, `cmd ≠ Gate` khai trong PLAN, hoặc evidence có từ trước lần `loop init` này (vòng/PLAN trước) · task `[~]` không ghi `— Bỏ: <lý do>` · dòng task sai định dạng · (ở Stop hook) đủ bằng chứng nhưng chưa `loop verify` xanh trên cây hiện tại | **Chặn dừng**, yêu cầu `loop record` / `loop verify` lại |
| `done` | Mọi task có bằng chứng xanh đúng Gate và blueprint 0 MUST mở (blueprint khai ở `loop init` phải tồn tại; biến mất giữa chừng thì PLAN là nguồn sự thật và lý do verdict ghi rõ blueprint không được kiểm) | Cho dừng, `active=false` |

Mặc định khuyến nghị: `--max-iterations` 30–50 cho một PLAN ≤ 10 task; `--hours` ≤ 8; headless thêm `--max-turns`
và `--max-budget-usd`. Tăng trần chỉ bằng `loop init` lại có chủ đích, không sửa tay `state.json`.

## Checklist

- [ ] `LOOP-DESIGN-001` **MUST** Nhà của "4 con số": vòng lặp khai đủ trước khi chạy trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót. → Kiểm: `.autopilot/state.json` có `max_iterations` và `deadline` (từ `loop init --max-iterations N --hours H`); lệnh headless có `--max-turns` + `--max-budget-usd`; `XT_RECORD_TIMEOUT` (mặc định 1800 s) ghi trong `PLAN.md`. · Nguồn: stored 21 §10
- [ ] `LOOP-DESIGN-002` **MUST@L** Mỗi task trong `PLAN.md` có tiêu chí dừng máy kiểm dạng `— Gate:` theo sau là lệnh trong backtick (test/lint/build/script), không phải mô tả bằng lời. → Kiểm: `xt.py loop status --json` không trả `blocked` với lý do "PLAN không có task"; grep `Gate:` cho mọi dòng `T-\d{3}`.
- [ ] `LOOP-DESIGN-003` **MUST** Task chỉ được tick `[x]` sau khi `xt.py loop record --task T-xxx -- <đúng lệnh Gate>` trả exit 0. → Kiểm: `.autopilot/evidence/T-xxx.json` có `exit_code: 0` và `cmd` bằng chuỗi Gate; `loop status` không trả `verify`.
- [ ] `LOOP-DESIGN-004` **MUST** Tín hiệu dừng đọc từ file trạng thái/bằng chứng, không từ chuỗi model in ra (promise string) hay phán quyết của model đánh giá transcript. → Kiểm: `.claude/settings.json` có Stop hook gọi `xt.py loop hook-stop`; không có hook nào grep `<promise>`; `/goal` nếu dùng chỉ là lớp phụ. · Nguồn: stored 23 §2.2
- [ ] `LOOP-DESIGN-005` **MUST@L** Cùng một chữ ký lỗi (task + exit code + 20 dòng cuối đã bỏ số) lặp 3 lần → verdict `blocked`, vòng lặp tự dừng để người xem. → Kiểm: `state.json` có `max_same_failure: 3`; test tái hiện: 3 lần `loop record` cùng lỗi → `loop status` = `blocked`.
- [ ] `LOOP-DESIGN-006` **MUST@L** Trạng thái bền nằm trên đĩa/repo (`PLAN.md`, `PROGRESS.md`, `BLUEPRINT.md`, `.autopilot/`), không trong trí nhớ phiên. → Kiểm: mở phiên mới, `xt.py loop status` cho cùng verdict; `session-start.sh` nạp được PROGRESS. · Nguồn: stored 03 §6
- [ ] `LOOP-DESIGN-007` **MUST@L** Chạm bất kỳ trần nào (vòng, hạn, ngân sách) → dừng có kiểm soát: commit phần xong, ghi `PROGRESS.md`, không "cố nốt". → Kiểm: `state.json.final_verdict.verdict ∈ {budget, blocked, done}`; `PROGRESS.md` mục Bàn giao có SHA là tổ tiên HEAD.
- [ ] `LOOP-DESIGN-008` **MUST** Có phát hiện không-tiến-triển ngoài trần vòng: Stop hook không chặn vô hạn khi model không gọi tool. → Kiểm: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` giữ mặc định 8 (không đặt `0`); `hook-stop` tăng `iterations` mỗi lần chặn. · Nguồn: Claude Code docs env-vars
- [ ] `LOOP-DESIGN-009` **MUST@L** Vòng lặp không tự merge vào nhánh chính; kết thúc ở PR có CI xanh, người (hoặc làn nhanh đã định nghĩa bằng máy) merge. → Kiểm: ruleset chặn push thẳng `main`; hook `pre-bash-guard.sh` ask khi push `main`; log autopilot không có `gh pr merge` tự động ngoài làn nhanh. · Nguồn: stored 03 §6 mục 7
- [ ] `LOOP-DESIGN-010` **MUST@L** Stop hook fail-open (lỗi hook → cho dừng), cổng chặn lệnh nguy hiểm fail-closed (lỗi → chặn). → Kiểm: `hook_stop()` bọc `try/except` trả exit 0; PreToolUse deny có `"onFailure": "block"` hoặc exit 2 khi script lỗi.
- [ ] `LOOP-DESIGN-011` **SHOULD** Lỗi lần 2 cùng bước → đổi cách tiếp cận và ghi vào `PROGRESS.md` trước khi thử lại; không sửa máy móc lần 3. → Kiểm: `PROGRESS.md` mục Quyết định có dòng "đổi cách" trước evidence lần 3. · Nguồn: stored 23 §6.1
- [ ] `LOOP-DESIGN-012` **SHOULD** Prefix prompt ổn định để tận dụng cache: chỉ nối thêm, không sửa đầu hội thoại, không chèn timestamp vào system prompt. → Kiểm: `usage.cache_read_input_tokens > 0` ở lượt thứ hai trở đi (headless `--output-format json`).
- [ ] `LOOP-DESIGN-013` **SHOULD** Người sinh và người chấm tách nhau: lệnh Gate do code chạy, reviewer không đọc lời giải thích của agent viết code. → Kiểm: `reviewer` subagent chỉ nhận diff + SPEC; Gate là lệnh trong `xt.yaml`, không phải prompt.
- [ ] `LOOP-DESIGN-014` **SHOULD** Ghi ngày tạo và giả định về model vào harness; xét lại hàng rào khi đổi model hoặc sau 90 ngày. → Kiểm: `.claude/settings.json` hoặc `docs/adr/` có ADR harness kèm ngày; lịch xét lại trong `PROGRESS.md`. · Nguồn: Anthropic harness design 2026-03-24
- [ ] `LOOP-DESIGN-015` **SHOULD** Ngân sách có circuit breaker 3 nấc: cảnh báo 80 %, thu hẹp 90 % (không nhận task mới), dừng 100 %. → Kiểm: `hook-stop` reason hiện `vòng N/M`; `PROGRESS.md` ghi bàn giao khi `N ≥ 0.8·M`. · Nguồn: stored 21 §8
- [ ] `LOOP-DESIGN-016` **SHOULD** Đo DORA baseline (lead time, change failure rate, lỗi lọt) trước khi bật tự trị để có số so sánh. → Kiểm: file baseline trong `docs/ops/` có ngày và 4 chỉ số. · Nguồn: stored 21 §8
- [ ] `LOOP-DESIGN-017` **MAY** Dùng evaluator riêng (test như người dùng thật qua trình duyệt/CLI) khi task vượt mức model làm ổn một mình. → Kiểm: evidence có lệnh E2E thật, không chỉ unit test.
- [ ] `LOOP-DESIGN-018` **MAY** Headless/CI dùng `claude -p --output-format json` và đọc `total_cost_usd`, `num_turns` để tính chi phí mỗi task hoàn thành. → Kiểm: báo cáo cuối có cột chi phí/task.
- [ ] `LOOP-DESIGN-019` **SHOULD** Vòng bảo trì (G8 → task mới) kích hoạt bằng ngưỡng tất định, không bằng model đọc log: script so chỉ số (tỉ lệ fail CI, 5xx sau deploy…) với baseline; quyền agent tăng theo độ lệch — 1σ chỉ ghi log, 2σ chẩn đoán read-only, 3σ chỉ được mở PR/issue hoặc chạy runbook đã duyệt trước; kết quả thành task/SPEC mới và đi qua cổng như mọi task. → Kiểm: file bậc có version (vd `docs/ops/bands.yaml`) ghi baseline + allowlist tool từng bậc, không bậc nào có quyền merge/deploy; log mỗi lần gọi có thời điểm, bậc, kết quả triage. · Nguồn: Anthropic AI-native SDLC playbook (2026-08-21) stage 6
- [ ] `LOOP-DESIGN-020` **SHOULD** Mỗi lát dọc chạy được (một task hoặc nhóm task PLAN có Gate xanh) là một nhánh + một PR nhỏ tách từ nhánh đích mới nhất, mở ngay khi Gate của lát xanh — không dồn "PR cuối"; lát phụ thuộc PR chưa merge thì nhánh chồng lên nhánh đó, merge theo FIFO (`LOOP-ORCH-013`); sau khi PR đáy merge: đổi đích PR chồng về nhánh mặc định (`gh pr edit <N> --base main` hoặc API), `git fetch origin main && git merge origin/main` vào nhánh chồng (squash để lại commit trùng của lát đáy; merge, không rebase/force-push), push, chạy lại `merge-check` — PR còn nhắm nhánh khác nhánh mặc định thì `merge-check` trả `wait`; PR đã mở được `xt.py merge-check` quyết mỗi vòng và tự merge bằng lệnh ghim head khi verdict `merge` (`LOOP-STOP-022`), làn chuẩn để người; ở `merge_autonomy: L3` (mặc định) mở PR xong bật auto-merge ngay (`gh pr merge <N> --auto --squash` hoặc MCP `enable_pr_auto_merge`), trừ PR chồng — bật sau khi nó đổi đích về nhánh mặc định (ADR-0015; `delete_branch_on_merge` bật thì GitHub tự đổi đích) — và PR `merge-check` báo `hard` (ngoại lệ cứng, người merge — ADR-0016). → Kiểm: số PR đã mở ≈ số lát trong `PLAN.md`; mỗi PR ≤ 1 lát (diff chỉ chạm file của task đó); log có `merge-check` trước mỗi merge. · Nguồn: ADR-0014 của repo khung; [`../00-method/lifecycle.md`](../00-method/lifecycle.md) G6
- [ ] `LOOP-DESIGN-021` **SHOULD** Task chạm UI do agent làm: Gate gồm lệnh chụp ảnh các màn đã đổi (≥ 320 px và desktop, hai theme), lưu vào evidence gắn commit SHA; trước khi xem ảnh agent ghi kỳ vọng và falsifier (điều kiện mà nếu thấy thì kết luận sai); báo cáo tách `measured` và `unmeasured`, nhận định của agent khi nhìn ảnh mang nhãn `asserted-not-measured` và không thay được test; đổi baseline visual (`*-snapshots/`, `__snapshots__/`) phải kèm ảnh trước/sau và được người hoặc reviewer khác model duyệt. → Kiểm: Gate trong PLAN chạy lệnh chụp (vd Playwright `toHaveScreenshot`) và ảnh nằm trong evidence theo SHA; báo cáo cuối có hai mục `measured`/`unmeasured`; PR đổi `*-snapshots/` có ảnh trước/sau và review khác model. · Nguồn: stored 06 §7d.3 (hook Stop buộc ghi UNMEASURED), 22 §0/§5.2 (không claim xong khi chưa re-render; contact sheet), 23 §6.1 (thang assert → preview → screenshot sau khi viết kỳ vọng và falsifier)
- [ ] `LOOP-DESIGN-022` **MUST@L** **Kiểm lại cuối** trước khi dừng: khi mọi task đã có bằng chứng xanh, Stop hook chỉ nhận `done`/`done-pending-human` sau `xt.py loop verify` — chạy lại MỌI Gate của task đã tick (một lần mỗi lệnh) trên cây hiện tại, ghi `.autopilot/verified.json` kèm dấu vân tay cây (sha256 của HEAD + diff + file chưa track, trừ `.autopilot/`); cây đổi sau đó hoặc Gate đổi cây → phải chạy lại. Bắt cả bằng chứng sửa tay lẫn task sau làm hỏng Gate của task trước. → Kiểm: `tests/test_xt_core.py` `LoopVerifyTest`; Stop hook trả `block` với lý do `loop verify` khi chưa kiểm. · Nguồn: seeker19110/stored mục 03 §3 (projects-template #287: dừng theo bằng chứng do code điền, fingerprint sha256 cho cùng diff), §6 điều 8 — rà 2026-10-16

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Cho model đọc log/metric liên tục để "tự phát hiện" sự cố | Tốn tiền, báo động giả, agent cầm quyền rộng khi chưa có gì xảy ra | Phát hiện bằng ngưỡng tất định; model chỉ vào cuộc khi vượt ngưỡng, quyền theo bậc (`LOOP-DESIGN-019`) |
| Dùng `<promise>COMPLETE</promise>` hoặc `/goal` làm điều kiện dừng duy nhất | Model tự khai xong; `/goal` là model nhỏ **chỉ đọc hội thoại**, không chạy tool, không đọc file | Stop hook đọc `.autopilot/` (xt.py); `/goal` chỉ là lớp bổ sung |
| Tick `[x]` rồi mới chạy test, hoặc chạy test bằng tay không qua `loop record` | Verdict `verify` kẹt vòng; không có bằng chứng | Luôn `loop record` với đúng chuỗi Gate |
| Sửa lệnh Gate trong PLAN cho khớp lệnh "dễ xanh" | Bằng chứng đúng cú pháp nhưng sai nội dung | Đổi Gate phải ghi lý do ở PROGRESS; `pre-edit-guard.sh` hỏi khi sửa cấu hình cổng |
| `claude -p --bare` trong CI | Mất hook, skill, CLAUDE.md → mọi cổng của khung biến mất | CI dùng `-p` không `--bare`, hoặc truyền `--settings` tường minh |
| Đặt `permissions.defaultMode: auto` trong `.claude/settings.json` của dự án | Bị bỏ qua; vẫn hỏi quyền | Đặt ở settings người dùng/managed hoặc cờ `--permission-mode auto` |
| Runaway: một tool lỗi bị gọi hàng trăm lần | Đốt ngân sách, không tiến triển | Chữ ký lỗi 3 lần → blocked; trần vòng; cap 8 lần chặn liên tiếp |
| "Context anxiety": agent vội kết luận xong khi context đầy | Code dở, tài liệu thiếu | Bàn giao theo `context-and-token-budget.md`; verdict không cho dừng khi còn task |
| Nhiều lần `loop init` để "reset" chuỗi lỗi | Mất lịch sử lỗi lặp, lặp lại sai lầm | Sau BLOCKED dùng `loop resume --reason` (giữ số vòng, đặt lại đếm lỗi) khi người đã xem lý do và ghi vào PROGRESS; `loop init` chỉ khi đổi PLAN/ngân sách |
| Agent nhìn ảnh chụp rồi khai "giao diện đã đúng"; sửa snapshot cho test xanh | Nhận định cảm tính thay phép đo; baseline bị đổi âm thầm | Ghi kỳ vọng + falsifier trước khi xem; tách `measured`/`unmeasured`; nhãn `asserted-not-measured`; đổi snapshot kèm ảnh trước/sau và review khác model (`LOOP-DESIGN-021`) |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `xt.py loop status` | `xt.py loop status --json` | SessionStart hook (cả sau compaction), trước khi chọn task | verdict ∈ {continue, verify, done}; `done-pending-human`/`blocked`/`budget` → người |
| `xt.py loop checkpoint` | qua `.claude/hooks/pre-compact.sh` | PreCompact hook | luôn exit 0; ghi `state.json.checkpoint` |
| `xt.py loop hook-stop` | qua `.claude/hooks/stop-guard.sh` | Stop hook | `decision: block` khi continue/verify; cap 8 lần chặn (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) |
| `xt.py loop record` | `xt.py loop record --task T-001 -- <Gate>` | Mỗi task | exit 0; timeout `XT_RECORD_TIMEOUT=1800` |
| `xt.py loop verify` | `xt.py loop verify` | Khi mọi task đã xanh, trước khi dừng (`LOOP-DESIGN-022`) | mọi Gate exit 0 trên cây hiện tại; `verified.json` khớp dấu vân tay cây |
| `xt.py blueprint-status` | `xt.py blueprint-status BLUEPRINT.md --strict` | Cổng phát hành G7 (dự án tự thêm vào CI khi phát hành) | 0 MUST mở, 0 miễn trừ không hợp lệ (MUST `Miễn` cần `Duyệt:` — `LOOP-STOP-024`) |
| Headless | `claude -p ... --max-turns N --max-budget-usd X --output-format json` | CI/Routine | dừng cứng theo trần |
| Test hook | `python3 -m unittest discover -s tests` | pre-commit, CI | Mọi test loop/hook xanh |

## Nguồn

- Mã nguồn `scripts/xt.py` (lệnh `loop init/status/record/block/resume/stop/hook-stop`, `loop_verdict`, `failure_signature`, `max_same_failure=3`, `max_iterations=50`) — đọc 2026-10-13.
- Claude Code docs — hooks (Stop, `stop_hook_active`, exit 2/`decision: block`): <https://code.claude.com/docs/en/hooks> · hooks guide "Stop hook hits the block cap" (8 lần liên tiếp không có tool call): <https://code.claude.com/docs/en/hooks-guide> · env `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (mặc định 8, `0` = tắt cap): <https://code.claude.com/docs/en/env-vars> — xác minh 2026-10-13.
- Claude Code docs — `/goal` (model nhỏ đánh giá, "doesn't run commands or read files independently"): <https://code.claude.com/docs/en/goal> — xác minh 2026-10-13.
- Claude Code docs — headless (`--bare` bỏ hook/skill/CLAUDE.md; `--max-turns`, `--max-budget-usd`, `total_cost_usd`): <https://code.claude.com/docs/en/headless> — xác minh 2026-10-13.
- Anthropic, *Effective harnesses for long-running agents* (2025-11-26): <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> · *Harness design for long-running application development* (2026-03-24): <https://www.anthropic.com/engineering/harness-design-long-running-apps> — theo `research/2026-10-13-ai-agent-research.md` §3.4 [F].
- `seeker19110/stored` mục 03 §6 (checklist 9 điểm), §8c; mục 21 §1, §8, §10; mục 23 §2.2 (ba cổng máy), §6.1 — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Anthropic, *The AI-native SDLC playbook* (2026-08-21), stage 6 Maintain: script tất định theo dõi production, `bands.yaml` (baseline 30 ngày, luật Western Electric; 1σ log · 2σ chẩn đoán với tool hạn chế · 3σ đề xuất PR/runbook), chẩn đoán ghi thành `intent.md` mới; "the agent may act up to the production gate and cannot pass it". Đây là hướng dẫn, chưa kèm số đo hiệu quả: <https://claude.com/blog/the-ai-native-sdlc-playbook> — xác minh 2026-10-16 (`seeker19110/stored` mục 21 §10c).
- `research/2026-10-13-claude-code-hooks-skills.md` (ba phát hiện: `/goal` là lời khai, `defaultMode auto` bị bỏ qua ở project settings, `--bare` mất hook).
- Catalog `seeker19110/stored` mục 06 §7d.3 (XIAS: hook Stop buộc agent nói "UNMEASURED" khi chưa đo, cổng đo trên bản render thật), mục 22 §0 và §5.2 ("never claim done without re-render"; contact sheet 1 frame/beat để agent tự soi), mục 23 §6.1 (verify ladder rẻ → đắt: assert số → preview → screenshot sau khi viết kỳ vọng và falsifier) — đọc 2026-10-16.
