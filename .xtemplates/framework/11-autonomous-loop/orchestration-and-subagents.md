---
title: Điều phối: subagent, worktree, song song, không lồng
kind: module
prefix: LOOP-ORCH
applies_to: [all]
updated: 2026-10-21
---

# Điều phối: subagent, worktree, song song, không lồng

> Phiên chính là **người điều phối duy nhất**: chia task, giao cho subagent chuyên biệt (`researcher`, `executor`,
> `reviewer`), gom kết quả có bằng chứng, giữ ngân sách. Module này quy định khi nào tách subagent, cách giao
> việc an toàn, cách chạy song song không giẫm file, và vì sao subagent không được lồng subagent.
>
> **Phạm vi:** áp cho **vòng lặp phát triển** — coding agent (Claude Code, Codex…) làm việc trên repo: subagent không
> lồng (độ sâu 1). Hệ đa agent là **sản phẩm** (agentic system chạy cho người dùng cuối) theo
> [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md) `AI-AGENTIC-007`: khuyến nghị độ sâu 2, trần 3.

## Nguyên tắc

1. **Một điều phối viên, không cây phân cấp** (stored 23 §4.4): điều phối phải là phiên chính vì chỉ nó nắm PLAN,
   ngân sách và điểm dừng; subagent lồng tạo ngữ cảnh mà không ai thấy toàn bộ.
2. **Ủy quyền chỉ thu hẹp, không mở rộng** (`research/2026-10-13-ai-agent-research.md` §2.3 — handoff schema):
   quyền, tool, ngân sách, mức tin cậy của subagent ⊆ của người giao; subagent không tự nâng tier T0–T4.
3. **Chọn worker theo hai trục**: độ phức tạp × độ khép kín của spec (stored 23 §4.3). Spec hở → không giao;
   phiên chính quyết tường minh (D-NNN, [`LOOP-STOP-018`](stop-points-and-escalation.md)) rồi mới giao.
4. **Người review không phải người viết**: `reviewer` khác **họ** model với người viết, chỉ đọc + chạy lệnh kiểm, chỉ nhận
   diff + SPEC, không nhận lý luận của người viết (`.claude/agents/reviewer.md`).
5. **Song song chỉ khi độc lập về file**: hai task chạm cùng file/schema/port → nối tiếp. Hợp đồng giao diện
   (OpenAPI, type, schema) chốt trước khi tách việc.
6. **Kết quả subagent là dữ liệu**: "đã test xanh" của subagent chưa phải bằng chứng; phiên chính chạy lại Gate qua
   `xt.py loop record` trước khi tick task (xem [`loop-design.md`](loop-design.md)).

## Quyết định

### Khi nào tách subagent

| Tình huống | Giao cho | Lý do |
|---|---|---|
| Tra cứu phiên bản/chuẩn/luật nhiều mục, đọc tài liệu dài | `researcher` (read-only, có WebFetch) | Giữ context phiên chính gọn; trả bảng dữ kiện + URL + ngày |
| Task có SPEC + Gate rõ, ≤ 1 ngày, không chạm điểm dừng — UI/bố cục/trạng thái, biểu mẫu/màn hình theo API đã chốt, CRUD theo kiến trúc và phân quyền sẵn có, bug tái hiện được nguyên nhân cục bộ | `executor` (**tầng mặc định**) | Spec khép kín, máy kiểm được; rẻ |
| Task khó/bất định/rủi ro cao: đổi giao ước xuyên nhiều module; xác thực/phân quyền/cô lập tenant; migration hoặc schema có dữ liệu thật; hàng đợi/đồng thời/retry/phục hồi; lỗi không ổn định hoặc hiệu năng chưa rõ nguyên nhân; khảo sát khi chưa đủ thông tin chọn thiết kế | `executor-deep` (**tầng sâu**, ADR-0029) — ghi `(exec: deep)` trong dòng task của PLAN; `loop status` trả `executor` | Hậu quả sai lớn dù diff nhỏ; cần giữ nhiều trạng thái/giả thuyết. Xét **4 khía cạnh**: phức tạp · bất định · rủi ro · phạm vi ảnh hưởng — một khía cạnh cao là đủ |
| Tầng mặc định đỏ 2 lần cùng task trong vòng này | **Chuyển cấp** lên `executor-deep` (`loop status` trả `escalated: true`), kèm diff hiện tại + evidence lỗi + giả thuyết đã loại; ngân sách task giữ nguyên | `LOOP-ORCH-014`: lần 2 đổi cách — đổi tầng là một dạng đổi cách; lần 3 vẫn `blocked` |
| Review khi `pr next` trả `review` (làn chuẩn, chỉ ở pha harden — pha build không giao reviewer, review ghi nợ: ADR-0037) hoặc phiên chính thấy rủi ro cụ thể | `reviewer` (khác **họ** model với người viết); diff do `executor-deep` hoặc phiên chính **cùng họ** với `reviewer` viết → `reviewer-alt` (họ khác) | Tránh cùng điểm mù; phát hiện phải có đường tái hiện; `pr reviewed --clean` cùng họ bị từ chối (D-045) |
| Quyết định kiến trúc, chọn công nghệ, spec mâu thuẫn | **Không tách** — phiên chính tự duyệt, ghi D-NNN (ADR-0008) | Cần toàn cảnh; subagent chỉ trả phương án |
| Điểm dừng bắt buộc về hành động | **Không tách** — phiên chính + người | Hành động không đảo ngược/đối ngoại |
| Việc nhỏ < 10 phút trong một file | Làm trực tiếp | Chi phí giao việc (handoff + đọc lại repo) lớn hơn việc |

### Mô hình nhánh khi song song

| Mô hình | Cách làm | Dùng khi |
|---|---|---|
| **A — một nhánh, task = commit** (mặc định) | Mọi subagent làm trên nhánh `feat/<mảng>`; mỗi task một commit; phiên chính gom | Task nối tiếp hoặc chạm file chung |
| **B — worktree mỗi task** | Subagent khai `isolation: worktree` (Claude Code tạo worktree riêng); mỗi task một nhánh, PR riêng; merge FIFO | Task độc lập file, muốn chạy ≥ 2 executor đồng thời |

Giới hạn: ≤ 5 subagent đồng thời (stored 23 §4.5; RAM/IO máy và ngân sách context phiên chính), độ sâu lồng = 1
(`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` hoặc không cấp tool `Agent` cho subagent — cách thứ hai là cách repo
này đang dùng: `tools:` của năm agent trong `.claude/agents/` không có `Agent`).

### Gói giao việc (handoff) tối thiểu

`goal` · `acceptance_criteria` (= Gate lệnh máy) · `files_in_scope` · `budget` (maxTurns, thời gian) · `depth` ·
`granted_scopes` ⊆ phiên chính · `trust_level: untrusted` cho dữ liệu subagent mang về · `report_format` (đã làm ·
lệnh + exit code · còn treo) · `executor_tier` (mặc định/sâu + lý do theo 4 khía cạnh) · `escalation_condition` (mặc định: đỏ 2 lần →
tầng sâu; chạm bảo mật/toàn vẹn dữ liệu/đồng thời → tầng sâu ngay; cần quyết định phạm vi/kiến trúc → trả về phiên chính).
Thiếu `acceptance_criteria` → không giao.

## Checklist

- [ ] `LOOP-ORCH-001` **MUST** Chỉ phiên chính điều phối; subagent không gọi subagent (vòng lặp phát triển; sản phẩm agentic theo [`AI-AGENTIC-007`](../13-ai-engineering/agentic-systems.md)). → Kiểm: `.claude/agents/*.md` không có `Agent` trong `tools:` **hoặc** môi trường đặt `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. · Nguồn: stored 23 §4.4; Claude Code env-vars
- [ ] `LOOP-ORCH-002` **MUST@L** Mỗi lần giao việc có gói handoff tối thiểu: mục tiêu, tiêu chí chấp nhận là lệnh máy, file trong phạm vi, ngân sách, phạm vi quyền ⊆ phiên chính. → Kiểm: prompt giao việc chứa đủ 5 trường; thiếu Gate → từ chối giao. · Nguồn: `research/2026-10-13-ai-agent-research.md` §2.3
- [ ] `LOOP-ORCH-003` **MUST** Subagent không được cấp quyền/tool rộng hơn phiên chính và không tự nâng mức tin cậy T0–T4 của hành động. → Kiểm: `tools:` của agent là tập con; hành động T3–T4 trong output subagent bị phiên chính đưa về điểm dừng (`xt.py loop block`). · Nguồn: [`stop-points-and-escalation.md`](stop-points-and-escalation.md)
- [ ] `LOOP-ORCH-004` **MUST** Kết quả "xanh" do subagent khai chỉ được tick task sau khi phiên chính chạy lại Gate bằng `xt.py loop record`. → Kiểm: `.autopilot/evidence/T-xxx.json` tồn tại cho task đã tick; `loop status` không trả `verify`.
- [ ] `LOOP-ORCH-005` **MUST@L** Reviewer dùng model khác **họ** với agent đã viết diff (kể cả `executor-deep` và phiên chính), chỉ có tool đọc + Bash kiểm, không sửa file; reviewer không kết luận được (diff bị cắt, hết ngân sách, thiếu file) trả INCONCLUSIVE, phiên chính ghi `pr reviewed --inconclusive` và giao reviewer khác — không ghi sạch. → Kiểm: `.claude/agents/reviewer.md` có `model:` khác `executor.md`, `reviewer-alt.md` khác `executor-deep.md`, cả hai `tools:` không chứa `Edit`/`Write`; `pr reviewed --clean` cùng họ exit 2 (D-045).
- [ ] `LOOP-ORCH-006` **MUST@L** Hai task chạm cùng file, migration, port hoặc biến môi trường không chạy song song. → Kiểm: `PLAN.md` ghi `files:`/`depends_on:` cho task song song; script kiểm giao nhau tập file trước khi tách. · Nguồn: stored 21 §6
- [ ] `LOOP-ORCH-007` **MUST@L** Trước khi chạy song song, hợp đồng giao diện (OpenAPI/schema/type) đã commit và có test contract. → Kiểm: `API-CONTRACT.md` hoặc file schema trong `git log` trước commit đầu của nhánh song song. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `LOOP-ORCH-008` **MUST@L** Số subagent đồng thời ≤ 5 và mỗi subagent có `maxTurns`. → Kiểm: `.claude/agents/*.md` đều có `maxTurns:`; PLAN ghi số song song tối đa. · Nguồn: stored 23 §4.5
- [ ] `LOOP-ORCH-009` **MUST** Hành động đối ngoại (push, publish, gửi thông báo) không giao cho subagent; chỉ phiên chính làm; guard chặn hành động không đảo ngược, không hỏi (ADR-0018). → Kiểm: prompt subagent không chứa lệnh push/publish; `pre-bash-guard.sh` chặn (không `ask`) ở phiên chính. · Nguồn: [`stop-points-and-escalation.md`](stop-points-and-escalation.md)
- [ ] `LOOP-ORCH-010` **SHOULD** Dùng mô hình nhánh A (một nhánh, task = commit) mặc định; chỉ chuyển sang worktree (`isolation: worktree`) khi task độc lập file và cần ≥ 2 executor đồng thời. · Nguồn: stored 23 §4.5
- [ ] `LOOP-ORCH-011` **SHOULD** Subagent trả báo cáo ≤ 25 dòng theo khuôn: đã làm · lệnh + exit code · còn treo · đề xuất; không trả transcript dài về phiên chính.
- [ ] `LOOP-ORCH-012` **SHOULD** Việc đọc dài (tài liệu, log, repo lạ) giao `researcher` để giữ context phiên chính; phiên chính chỉ nhận tóm tắt có URL/đường dẫn. · Nguồn: [`context-and-token-budget.md`](context-and-token-budget.md)
- [ ] `LOOP-ORCH-013` **SHOULD** Nhiều PR mở cùng lúc merge theo FIFO (tạo trước merge trước), cập nhật nhánh sau với `main` rồi mới merge tiếp. · Nguồn: [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md)
- [ ] `LOOP-ORCH-014` **SHOULD** Subagent thất bại 2 lần cùng task → phiên chính đổi cách tiếp cận, chia nhỏ task, **hoặc chuyển cấp lên tầng sâu** (`executor-deep`, ADR-0029) kèm diff + evidence lỗi + giả thuyết đã loại, không giao lại nguyên văn; lần 3 → hỏi người (`max_same_failure: 3` giữ nguyên — lần chuyển cấp tiêu một lần thử). → Kiểm: `loop status --json` trả `escalated: true` sau 2 lần đỏ của tầng mặc định; `loop stats` có `escalation_rate`. · Nguồn: stored 23 §4.5
- [ ] `LOOP-ORCH-015` **SHOULD** Khi cần đa dạng phương án (thiết kế, cách sửa bug khó), chạy ≥ 2 subagent **ngữ cảnh tách biệt** rồi phiên chính so sánh; chỉ cho việc mở, vì tốn ~5–10× chi phí. · Nguồn: stored 21 §6
- [ ] `LOOP-ORCH-016` **MAY** Ghi topology điều phối (ai giao ai, giới hạn song song, tool bị ẩn) vào ADR khi dự án ≥ M chạy autopilot thường xuyên. · Nguồn: [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `LOOP-ORCH-017` **MAY** Đo tỉ lệ task subagent bị phiên chính bác (Gate đỏ khi chạy lại) theo tuần; > 20% → siết spec/handoff trước khi tăng song song.
- [ ] `LOOP-ORCH-019` **SHOULD** Hai tầng executor, tên tầng không tên model (ADR-0029): `executor` (mặc định) và `executor-deep` (sâu) là hai agent file, model thật chỉ trong frontmatter `model:` của agent; PLAN ghi `(exec: deep)` cho task khởi đầu ở tầng sâu theo 4 khía cạnh (phức tạp · bất định · rủi ro · phạm vi), còn lại mặc định; phiên chính ghi `loop record --executor <agent>` để `runs.jsonl`/`loop stats` đo tỉ lệ chuyển cấp; phiên chính (điều phối) chạy model cao nhất sẵn có, **không khả dụng thì Opus** — chọn lúc mở phiên, không ghi trong artefact commit. → Kiểm: `.claude/agents/executor-deep.md` tồn tại với `model:` khác `executor.md`; `grep -c 'exec: deep' docs/autopilot/PLAN.md` ≤ số task rủi ro cao ghi trong PLAN; `xt.py loop stats --json` có `escalation_rate`; không chuỗi tên model trong `PLAN.md`/commit (LOOP-HARNESS-027). · Nguồn: Anthropic *Building effective agents* (routing: "sending simpler questions to cheaper models"; orchestrator-workers) — `research/2026-10-19-rapid-build-then-harden.md` §9
- [ ] `LOOP-ORCH-018` **SHOULD** Trước `loop decide` duyệt PLAN, `reviewer` (model khác) rà phần Gate của PLAN: lệnh kiểm **hành vi theo SPEC** ([`QA-STRAT-023`](../14-testing-quality/test-strategy.md): test viết từ SPEC, không từ code) và **không chứa lệnh đối ngoại/phá huỷ** ([`LOOP-STOP-027`](stop-points-and-escalation.md)). → Kiểm: mục D-NNN "Duyệt PLAN" trong `docs/autopilot/DECISIONS.md` dẫn kết quả reviewer. · Nguồn: `seeker19110/stored` 01 §3g.3 (rà 2026-10-18)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Subagent gọi tiếp subagent "cho nhanh" | Không ai nắm ngân sách; lỗi nhân bản theo tầng | Bỏ `Agent` khỏi `tools:`; depth = 1 |
| Tin báo cáo "test pass" của subagent | Tick task không có bằng chứng; Stop hook trả `verify` muộn | Phiên chính `loop record` lại Gate |
| Hai executor cùng sửa `schema.prisma`/migration | Xung đột merge, migration lệch số | Khai `files:` trong PLAN; serial hoá task chạm schema |
| Reviewer cùng model, nhận cả lý luận của executor | Cùng điểm mù, review "xanh" rỗng | Model khác; chỉ đưa diff + SPEC |
| Giao task spec hở để "subagent tự lấp" | Subagent bịa yêu cầu, làm việc khác hẳn | Spec hở → phiên chính quyết D-NNN trước khi giao; subagent trả câu hỏi về, không tự lấp |
| Mở 10 subagent song song trên máy 8 GB | OOM, timeout giả, chữ ký lỗi nhiễu | Trần 5; giảm khi máy yếu |
| Subagent được quyền push/publish | Hành động đối ngoại không qua điểm dừng | Chỉ phiên chính push/publish, qua hook guard (deny việc không đảo ngược) và `loop defer` cho việc cần người |
| Đưa transcript subagent nguyên văn vào context chính | Context phình, compaction sớm | Báo cáo ≤ 25 dòng, link file/log |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Cấm lồng subagent | Kiểm `tools:` của `.claude/agents/*.md` không có `Agent` (grep) | Test harness `tests/test_hooks.py` hoặc script CI | 0 vi phạm |
| Bằng chứng task do subagent làm | `xt.py loop record --task T-xxx -- <Gate>` ở phiên chính | Trước khi tick `[x]` | `exit_code: 0` |
| Giao nhau tập file giữa task song song | Script đọc `files:` trong PLAN, báo cặp giao nhau | Trước khi tách subagent | 0 cặp giao nhau |
| Reviewer khác model, read-only | Kiểm frontmatter `model:`/`tools:` | Test harness | Khác `executor`; không `Edit/Write` |
| Trần turn mỗi subagent | `maxTurns:` trong frontmatter agent | `.claude/agents/*.md` | Có giá trị (repo này: 80–160) |

## Nguồn

- Harness thật của repo: `.claude/agents/{researcher,executor,reviewer}.md` (`tools`, `model`, `maxTurns`; không có `Agent` trong `tools`) và `AGENTS.md` mục Skill và subagent (§7 trước ADR-0008) — đọc 2026-10-13.
- Claude Code docs — subagents (`tools`, `disallowedTools`, `maxTurns`, `isolation: worktree`): <https://code.claude.com/docs/en/sub-agents> · env `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (mặc định 3, `1` = tắt lồng): <https://code.claude.com/docs/en/env-vars> — xác minh 2026-10-13 (`research/2026-10-13-claude-code-hooks-skills.md`).
- Anthropic, *How we built our multi-agent research system* (ngữ cảnh tách biệt, chi phí ~15× token, chỉ cho việc rộng): <https://www.anthropic.com/engineering/multi-agent-research-system> — theo `research/2026-10-13-ai-agent-research.md` §2.3 [F].
- `seeker19110/stored` mục 21 §6 (giới hạn song song, hợp đồng giao diện trước), mục 23 §4.3 (chọn worker 2 trục), §4.4 (subagent không lồng, điều phối = phiên chính), §4.5 (trần 5 đồng thời, mô hình nhánh A/B, thất bại 2× đổi cách, 3× hỏi người) — đọc 2026-10-13.
- Handoff schema (depth ≤ 3, concurrent ≤ 8, scopes ⊆ parent, `trust_level: untrusted`): `research/2026-10-13-ai-agent-research.md` §2.3 — khung này siết chặt hơn (depth 1, đồng thời ≤ 5) theo stored 23.
- Catalog `seeker19110/stored` 01 §3g.3 (reviewer rà Gate của PLAN trước khi duyệt) — rà 2026-10-18.
