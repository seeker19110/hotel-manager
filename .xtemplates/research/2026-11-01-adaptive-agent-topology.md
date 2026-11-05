---
title: Kiến trúc "Adaptive Agent" cho vòng lặp phát triển — đối chiếu đề xuất của chủ dự án với khung (2026-11-01)
kind: research
updated: 2026-11-03
---

# Adaptive Agent: một agent chính, subagent theo loại việc, KPI đo thật — nghiên cứu 2026-11-01

> Đầu vào: nhận định của chủ dự án (2026-11-01, phiên `seeker/wizardly-tesla-amsxmp`) đề xuất X-Templates dùng kiến trúc
> *Adaptive Agent*: Software Factory tự chọn cấu hình theo độ độc lập của việc; mặc định **một** agent sở hữu code và tích
> hợp; subagent chỉ khi việc độc lập về file và có hợp đồng đầu ra; ưu tiên test tự động liên tục hơn nhiều reviewer trao đổi;
> một lượt audit sau pha lớn rồi sửa theo batch; chỉ tăng số agent khi số đo chứng minh; 1 agent chính + tối đa 2–4 subagent;
> giữ ba giai đoạn MVP → Hoàn thiện → Tối ưu; 6 KPI (thời gian tới PR đạt CI · token/tính năng nghiệm thu · số lần sửa lại ·
> lỗi sau merge · tỉ lệ xong lần đầu · xung đột tích hợp). Bổ sung cho [`2026-10-24-single-agent-loop.md`](2026-10-24-single-agent-loop.md)
> (ADR-0045) và [`2026-11-01-stored-delta-upgrade.md`](2026-11-01-stored-delta-upgrade.md); không sửa hai file đó.

## 1. Kết luận

- Đề xuất **khớp** tinh thần ADR-0045 (tách agent chỉ vì context; đo trước khi đổi) và phần lớn đã có nhà trong khung (§3).
  Hai điểm **khác** với khung hiện hành: (a) mặc định giao việc của harness vẫn là `executor` (`loop status` trả tầng,
  `LOOP-ORCH-020` giữ tới khi có ≥ 10 task/nhóm × 2 vòng) trong khi đề xuất lấy **tự làm** làm mặc định; (b) khung chọn worker
  theo "độ phức tạp × độ khép kín" + 3 lý do context, chưa có bảng **loại việc → cấu hình** (topology) máy đọc được.
- Số đo của `LOOP-ORCH-020` **chưa bao giờ có** (PROGRESS 2026-10-25 → 2026-11-01: "chờ ≥ 10 task/nhóm"; `runs.jsonl` của
  clone = 0 dòng) — điều kiện đổi mặc định đặt ra 8 ngày trước không tích luỹ được vì không dự án nào chạy autopilot đủ dài.
  Trong khi đó phiên 2026-10-31/11-01 (9 PR merge, 2 PR đóng — cửa sổ đếm và danh sách #N ở §Nguồn) **thực tế** đã vận hành đúng mô hình đề xuất: phiên chính tự
  viết mọi diff (guard, title 100, CI), chỉ giao `reviewer`/`researcher`/audit read-only, song song ≤ 3 — không giao `executor`
  lần nào. Chủ dự án có quyền cuối (AGENTS.md §1): đổi mặc định theo quyết định có ghi (D-NNN, ADR) là hợp lệ; điều kiện đo
  của `LOOP-ORCH-020` chuyển thành điều kiện cho **lần đổi kế tiếp** (tăng số agent) — đúng câu 5 của đề xuất.
- Việc làm (ADR-0061): (1) bảng **loại việc → topology** có 4 hàng (tự làm · tự làm + reviewer chuyên biệt · song song theo
  module độc lập · audit một lượt + sửa batch), mặc định `self`; PLAN ghi `(topo: …)` như `(exec: deep)`; `loop status` trả
  `topology`, `executor: null` khi `self`; (2) trần đợt song song mặc định 4 (`plan waves --max 4`; `LOOP-ORCH-008` giữ ≤ 5
  là trần cứng); (3) KPI: ghép 6 KPI của đề xuất vào số đo harness (§4) — 4 đo được ngay, 2 ghi "chưa đo" có cách đo;
  (4) trần `pr rethink` 1 lần/PR, trừ PR cắt bản (ADR-0059 §6) — bài học #372 (7 lượt review đăng dấu, đóng không merge,
  D-284…D-286, D-288…D-291 trên nhánh PR, không trong sổ `main`); (5) không bỏ `executor`/
  `executor-deep`: giữ cho hàng "song song" và chuyển cấp (ADR-0029).
- Không áp: đội 5–10 agent thường trực (đề xuất cũng không chọn); Agent Teams (`LOOP-ORCH-021`); so sánh cặp "cùng bộ tác vụ
  hai cách thực thi" cho vòng phát triển — task phát triển không lặp lại được (ghi ở `LOOP-ORCH-020`), chỉ đo quan sát hai nhóm +
  khoảng tin cậy; eval cặp chỉ cho sản phẩm agentic (`AI-AGENTIC-001`).

## 2. Đề xuất của chủ dự án → trạng thái trong khung

| # | Đề xuất | Nhà hiện có | Trạng thái | Việc làm |
|---|---|---|---|---|
| 1 | Mặc định 1 agent sở hữu code + tích hợp | Nguyên tắc 1 (một điều phối viên), hàng "Làm trực tiếp" `LOOP-ORCH-020` | **Khác**: mặc định harness = giao `executor` | Đổi mặc định `loop status` → `self`; `executor` chỉ ở `topo: parallel`/`exec: deep` |
| 2 | Subagent chỉ khi độc lập file, ít sửa cùng file, hợp đồng đầu ra rõ | Nguyên tắc 5, `LOOP-ORCH-002/006/007`, `plan waves` (so `files:`) | Đã có | Ghi vào bảng topology (hàng "song song") |
| 3 | Test tự động liên tục thay cho nhiều reviewer trao đổi | ADR-0056 (CI = cổng đầy đủ), ADR-0037 (pha build không reviewer), ADR-0059 (review 2, sửa 1) | Đã có; **hở**: `pr rethink` không trần → #372 7 lượt | Trần rethink 1/PR (xt.yaml `max_rethink`) |
| 4 | Một lượt audit sau pha lớn, sửa theo batch | ADR-0031/0033 (audit theo mốc), `/complete`, `audit delta` | Đã có | Hàng "audit" trong bảng topology: reviewer read-only song song theo cụm + xác minh đối kháng, sửa = PLAN batch |
| 5 | Tăng số agent chỉ khi số đo chứng minh thời gian giảm, lỗi không tăng | `LOOP-ORCH-017/020`, `AI-AGENTIC-001` | Đã có (điều kiện 10 task × 2 vòng) | Giữ; thêm 2 KPI thời gian (§4) để "thời gian giảm" đo được |
| 6 | Giữ MVP → Hoàn thiện → Tối ưu | ADR-0031 build/harden, ADR-0048 optimize, ADR-0058 giai đoạn | Đã có | — |
| 7 | 1 agent chính mạnh + tối đa 2–4 subagent khi cần | `LOOP-ORCH-019` (Fable → Opus → Sonnet), `LOOP-ORCH-008` ≤ 5 | Gần: trần 5 | `plan waves --max` mặc định 4; trần cứng 5 giữ (nguồn stored — trích dẫn `23 §4.5` lệch, xem §3 dòng 12) |
| 8 | Bảng loại việc → cấu hình (adaptive) | Bảng "Khi nào tách subagent" theo tình huống | **Thiếu** dạng máy đọc | `LOOP-ORCH-024` + `(topo:)` trong PLAN + `loop status.topology` |
| 9 | 6 KPI | `loop stats` (xanh lần đầu, runs_to_green, escalation, delegation), `pr stats` (lead time, runs/PR, first_push_green, reverts) | 4/6 đo được | §4 |

## 3. Dữ kiện (nguồn sống, ngày đọc)

Tra bởi `researcher` 2026-11-01 (toàn văn HTML/markdown tải bằng `curl`, trừ dòng ghi *WebFetch*); nguồn tạm ở scratchpad phiên, không commit.

| # | Dữ kiện | Nguồn · ngày công bố | Ý nghĩa cho đề xuất |
|---|---|---|---|
| 1 | Bài *When to fold subagents into your main agent loop* không có bản cập nhật/erratum; 7 câu trích ở note 2026-10-24 còn nguyên ("frequently outperformed", "roughly 2x faster", "keep it as a subagent only if…") | claude.com/blog, 2026-10-22 | Dữ kiện nền của ADR-0045 còn hiệu lực |
| 2 | *Harness design for long-running application development*: kiến trúc planner · generator · evaluator; bảng "Solo 20 min $9 · Full harness 6 hr $200" (n = 1 mỗi cấu hình, tuyên bố); evaluator "worth the cost when the task sits beyond what the current model does reliably solo"; "find the simplest solution possible, and only increase complexity when needed"; model mới → "stripping away pieces that are no longer load-bearing" | anthropic.com/engineering, 2026-03-24 (modified 2026-10-18) | Trực tiếp ủng hộ "mặc định một agent, reviewer khi việc vượt khả năng solo, chỉ tăng khi cần" |
| 3 | *Effective harnesses for long-running agents*: initializer + coding agent; "still unclear whether a single, general-purpose coding agent performs best … or … multi-agent architecture" | anthropic.com/engineering, 2025-11-26 | Chính chủ không khẳng định số agent tối ưu → quyết định phải có số đo |
| 4 | *Multi-agent research system*: "agents ≈ 4× token chat, multi-agent ≈ 15× token **chat**" (mốc so là chat, không phải single-agent); "+90.2% so với single-agent Opus 4 trên eval nghiên cứu nội bộ" | anthropic.com/engineering, 2025-06-13 | Song song đáng giá cho việc rộng/đọc nhiều; chi phí phải đo |
| 5 | Bài ROI Claude Code: "The most important metric is the cost per task"; bộ chỉ số gợi ý — Time: "PR cycle time from open → merge, code review turnaround"; Effort: "review iterations per PR, review comments and rework per PR"; Volume: PRs/engineer, deployment frequency; OTel đếm token/cost theo agent/skill | claude.com/resources, 2026-10-27 | Khớp 4/6 KPI của đề xuất (thời gian tới merge, rework, token/task); nhà cho `pr stats` |
| 6 | Claude Code docs sub-agents/env-vars: `maxTurns` (không có mặc định ghi); `isolation: worktree` tách từ nhánh mặc định; **đồng thời mặc định 20** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, v2.1.217+); **lồng mặc định 3 tầng** từ v2.1.219 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` tắt lồng) | code.claude.com/docs, đọc 2026-11-01 | Trần 4/5 của khung là **tự đặt**, chặt hơn mặc định công cụ; câu "subagent không có tool Agent" của stored đã cũ — Kiểm `LOOP-ORCH-001` (bỏ `Agent` khỏi `tools:` hoặc env = 1) vẫn đúng |
| 7 | Docs agent-teams: experimental, tắt mặc định; "no hard limit on the number of teammates"; "Start with 3-5 teammates"; "Three focused teammates often outperform five scattered ones"; teammate kế thừa permission mode của lead | code.claude.com/docs, đọc 2026-11-01 | Số gần nhất có nguồn là 3–5; không trang nào nêu "2–4" |
| 8 | OpenAI Codex docs: "subagent workflows consume more tokens than comparable single-agent runs"; "use parallel agents for read-heavy tasks such as exploration, tests, triage, and summarization. Be more careful with parallel write-heavy workflows" | learn.chatgpt.com/docs, đọc 2026-11-01 | Khớp hàng `audit` (song song read-only) và `self` cho việc ghi |
| 9 | DORA: Change lead time (commit → production), Change fail rate (deploy cần can thiệp ngay), Deployment rework rate (deploy ngoài kế hoạch do sự cố); DORA 2025: AI tăng throughput nhưng "negative relationship with … stability" (khảo sát ~5 000 người, tự khai) | dora.dev/guides (cập nhật 2026-01-05); DORA 2025 (2025-09-23, *WebFetch*) | Định nghĩa chuẩn cho KPI "lỗi sau merge"/"sửa lại" (`reverts`, `do #N`) |
| 10 | METR uplift update: dev cũ −18 % (CI −38…+9 %), dev mới −4 %; "measurements of time-spent … are unreliable for the fraction of developers who use multiple AI agents concurrently" | metr.org, 2026-02-24 (*WebFetch*) | KPI thời gian phải đo trên máy (`runs.jsonl`, CI), không tự khai |
| 11 | arXiv 2608.16801 *When Agents Coordinate*: tin nhắn tăng gần bậc hai theo số agent; coordinator chỉ định "provides no reliable improvement"; **không có** baseline single-agent (preprint) | arxiv.org, 2026-08-17 (*WebFetch*) | Lý do giữ đợt nhỏ; không dùng làm bằng chứng cho mặc định |
| 12 | `seeker19110/stored` 23 §4.3–§4.5, §8b: không có "2–4" hay "trần 5"; "trần 5" nằm ở 23 §2 (dòng 72, trích ADR-0011 của projects-template, "toàn cây") và 03 §5 ("đồng thời"; "4–5 agent → RAM; 10+ → ngân sách context") — hai chỗ ghi khác nhau; HEAD `7b63146` không có LICENSE | git show, 2026-11-01 | Nguồn của `LOOP-ORCH-008` ghi "stored 23 §4.5" là **lệch** (số nằm ở 23 §2/03 §5) — ghi sổ, không đổi ID |

Chưa xác minh: nội dung đổi của ba bài Anthropic có `modified` 2026-10 (không có changelog); giá trị mặc định `maxTurns`; số "rework 8–32 %" của DORA 2025 chỉ ở nguồn thứ cấp.

## 4. KPI của đề xuất ↔ số đo harness

| KPI (đề xuất) | Đo bằng | Có sẵn? | Việc làm |
|---|---|---|---|
| Thời gian đến PR đạt CI | `pr stats`: `lead_time_hours` (mở → merge), `first_push_green`; `loop stats`: thời gian từ lần chạy đầu tới lần xanh đầu (`started`/`finished` trong `runs.jsonl`) | một phần | Thêm `time_to_green_hours` (trung vị/P95 theo task) vào `loop stats` |
| Token mỗi tính năng nghiệm thu | harness không thấy token của phiên (`research/2026-10-24` §11) | **chưa đo** | Ghi tay từ `/usage` hoặc `total_cost_usd` headless vào báo cáo cuối lát; không bịa |
| Số lần phải sửa lại | `loop stats`: `runs_to_green`, `needs_3_plus`; `pr stats`: `pushes` > 1, `runs_per_pr` | có | Báo cáo cuối lát ghi hai số |
| Lỗi phát hiện sau merge | sổ audit: cột Ghi chú `do #N` (phát hiện do PR N gây ra); `pr stats.reverts` | một phần | `audit check --json` đếm phát hiện theo `do #N` → `defects_after_merge` theo PR |
| Tỉ lệ hoàn thành ngay lần đầu | `loop stats`: `first_pass_rate_*`; `pr stats.first_push_green` | có | — |
| Số xung đột khi tích hợp | `pr next` thấy `CONFLICTING`/`update-branch` nhưng không ghi | **chưa đo** | Ghi tay số lần `update` trong báo cáo cuối lát; máy hoá sau (`merge-watch` đếm) |

## 5. Áp vào khung (ADR-0061, PLAN-upgrade-2026-11-01)

- Lát 1 (tài liệu): research note này, ADR-0061, `orchestration-and-subagents.md` (bảng topology, `LOOP-ORCH-024` SHOULD, sửa chữ `LOOP-ORCH-010/020`), `loop-design.md` (`LOOP-DESIGN-024` thêm KPI thời gian), mẫu PLAN (`topo:`), skill `/autopilot` bước 5, README chỉ mục ADR (0060, 0061).
- Lát 2 (harness): `loop status` trả `topology`, mặc định `executor: null`; `(topo: parallel)` → tầng theo `exec:`; `plan waves --max` 4.
- Lát 3 (harness): `loop stats` `time_to_green_hours`; `pr rethink` trần 1/PR (`max_rethink`), `pr next` → `split-or-close`.
- Lát 4+: nâng cấp từ stored (§3 của note stored: XT-H-019/020/021, 024/026, 022, 023…) và sửa batch audit delta 2026-11-01.

## 6. Không áp và vì sao

- Không hạ `LOOP-ORCH-008` xuống 4 (MUST@L có nguồn stored = 5; trích dẫn `23 §4.5` lệch — §3 dòng 12, sửa ở T-3609); chỉ đổi mặc định đợt. Không bỏ hai tầng executor
  (ADR-0029): "song song theo module" cần chúng; chuyển cấp đỏ 2 lần vẫn dùng `executor-deep`.
- Không đổi `AGENTS.md` dài hơn: đang 7168/7168 B (trần `tests/test_docs_budget.py`); chỉ đổi chữ cùng độ dài hoặc ngắn hơn.

## 7. Chưa xác minh

- Token của subagent có vào `total_cost_usd` headless không (giữ từ note 2026-10-24 §11).
- Số "2–4 subagent" của đề xuất không có nguồn ngoài (§3 dòng 6–7: docs chỉ có "3–5 teammates", đồng thời mặc định 20); khung lấy 4 làm **mặc định đợt**, ghi "khởi điểm do chủ dự án đặt", trần cứng 5 của `LOOP-ORCH-008` giữ nhưng nguồn trích cần sửa (§3 dòng 12).
- Phần "stored 23 §4.5" được nhiều mục khung trích (`LOOP-ORCH-008/010/014`): §4.5 có mô hình nhánh A/B và "thất bại 2× đổi cách", **không** có số 5 — sửa nguồn ở lát sửa batch audit (T-3609), giữ ID.

## Nguồn

- Nhận định của chủ dự án, phiên 2026-11-01 (nguyên văn trong lịch sử phiên; tóm tắt ở đầu file).
- `research/2026-10-24-single-agent-loop.md`, ADR-0045, `LOOP-ORCH-017/019/020`, `LOOP-DESIGN-024` — đọc 2026-11-01.
- `scripts/xt.py`: `loop_stats`/`_delegation_stats`, `pr_stats`, `plan_waves(max_parallel=5)`, `review_window`/`_rethink_pending` — đọc 2026-11-01.
- Số đo phiên 2026-10-31/11-01: PR #363, #365–#368, #371, #375–#377 merge (9); #372 đóng sau 7 lượt review đăng dấu (REST, 2026-11-01; D-284…D-286, D-288…D-291 trên nhánh `seeker/wizardly-tesla-amsxmp`, không trong sổ `main`).
  **Cửa sổ đếm (đính chính 2026-11-03, AUD-DOC-140):** PR có `merged_at`/`closed_at` trong [2026-10-31T12:00Z, 2026-11-01T03:23Z) — sau #362, trước khi mở #378 của chính note này. REST `gh api 'repos/{owner}/{repo}/pulls?state=all&per_page=60'` (đọc 2026-11-03) trong cửa sổ: **12 merge** (#363–#369, #371, #373, #375–#377) và **2 đóng không merge** (#372, #374 — cả hai ở nhánh `seeker/wizardly-tesla-amsxmp`). Tập "của phiên" (9 merge) là do phiên tự khai, bỏ #364/#373 (phiên khác) và #369 (Dependabot); "1 PR đóng" ở bản đầu sót #374. ADR-0061:23 giữ số cũ (ADR không sửa).
- Nguồn sống §3 (đọc 2026-11-01; URL thêm và kiểm còn sống — HTTP 200, tiêu đề khớp — ngày 2026-11-03, AUD-DOC-147):
  1. <https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop> (2026-10-22)
  2. <https://www.anthropic.com/engineering/harness-design-long-running-apps> (2026-03-24)
  3. <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> (2025-11-26)
  4. <https://www.anthropic.com/engineering/multi-agent-research-system> (2025-06-13)
  5. <https://claude.com/blog/how-to-manage-costs-and-demonstrate-roi-for-claude-code-on-google-cloud> (2026-10-27)
  6. <https://code.claude.com/docs/en/sub-agents>, <https://code.claude.com/docs/en/env-vars>, <https://code.claude.com/docs/en/costs>, <https://code.claude.com/docs/en/advisor>
  7. <https://code.claude.com/docs/en/agent-teams>
  8. <https://learn.chatgpt.com/docs/agent-configuration/subagents>
  9. <https://dora.dev/guides/dora-metrics/> (2026-01-05), DORA 2025 <https://dora.dev/research/2025/dora-report/> (2025-09-23)
  10. <https://metr.org/blog/2026-02-24-uplift-update/>
  11. <https://arxiv.org/abs/2608.16801>
  12. `seeker19110/stored@7b63146` mục 01/03/23 (repo nguồn, ghim SHA).
