---
title: Điều phối: subagent, worktree, song song, không lồng
kind: module
prefix: LOOP-ORCH
applies_to: [all]
updated: 2026-11-04
---

# Điều phối: subagent, worktree, song song, không lồng

> Phiên chính là **người điều phối duy nhất** và là người làm khi không có lý do tách: giao `researcher`/`reviewer` vì
> **context** (ba lý do — nhà: [`AI-AGENTIC-011`](../13-ai-engineering/agentic-systems.md)); `executor` chỉ khi task
> `(topo: parallel)` (ADR-0061, `LOOP-ORCH-024`), tăng số agent chỉ khi có số (`LOOP-ORCH-020`); gom kết quả có bằng chứng,
> giữ ngân sách. Module này quy định khi nào tách
> subagent, cách giao việc an toàn, cách chạy song song không giẫm file, đo gì trước khi đổi mặc định giao việc, và vì sao
> subagent không được lồng subagent.
>
> **Phạm vi:** áp cho **vòng lặp phát triển** — coding agent (Claude Code, Codex…) làm việc trên repo: subagent không
> lồng (độ sâu 1). Hệ đa agent là **sản phẩm** (agentic system chạy cho người dùng cuối) theo
> [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md) `AI-AGENTIC-007`: khuyến nghị độ sâu 2, trần 3.

## Nguyên tắc

1. **Một điều phối viên, không cây phân cấp** (stored 23 §4.4): điều phối phải là phiên chính vì chỉ nó nắm PLAN,
   ngân sách và điểm dừng; subagent lồng tạo ngữ cảnh mà không ai thấy toàn bộ.
2. **Ủy quyền chỉ thu hẹp, không mở rộng** (`research/2026-10-13-ai-agent-research.md` §2.3 — handoff schema):
   quyền, tool, ngân sách, mức tin cậy của subagent ⊆ của người giao; subagent không tự nâng tier T0–T4.
3. **Tách vì context, chọn tầng theo spec**: tách khi có lý do context (`AI-AGENTIC-011` — suy từ nguồn về agent sản phẩm,
   **giả định cho vòng lặp phát triển, đo ở `LOOP-ORCH-020`**: `researcher` ≈ lý do 1 · `reviewer` ≈ lý do 2, kiểm mà không
   thấy cách làm · `executor` = tầng mặc định của hàng `parallel`, ADR-0029/0061), không vì "cho chắc"; đã tách thì chọn tầng theo độ
   phức tạp × độ khép kín của spec (stored 23 §4.3). Spec hở → không giao; phiên chính quyết tường minh (D-NNN,
   [`LOOP-STOP-018`](stop-points-and-escalation.md)) rồi mới giao.
4. **Người review không phải người viết**: `reviewer` năng lực cao hơn người viết, chỉ đọc + chạy lệnh kiểm, chỉ nhận
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
| Task có SPEC + Gate rõ, ≤ 1 ngày, không chạm điểm dừng — UI/bố cục/trạng thái, biểu mẫu/màn hình theo API đã chốt, CRUD theo kiến trúc và phân quyền sẵn có, bug tái hiện được nguyên nhân cục bộ | `executor` (tầng mặc định của hàng `parallel`, ADR-0029) — **chỉ khi** task ghi `(topo: parallel)`; mặc định `self` tự làm (ADR-0061) | Module độc lập file, hợp đồng rõ; chưa phải lý do context đo được — nhóm so sánh với tự làm (`LOOP-ORCH-020`); spec khép kín, máy kiểm được |
| Task khó/bất định/rủi ro cao: đổi giao ước xuyên nhiều module; xác thực/phân quyền/cô lập tenant; migration hoặc schema có dữ liệu thật; hàng đợi/đồng thời/retry/phục hồi; lỗi không ổn định hoặc hiệu năng chưa rõ nguyên nhân; khảo sát khi chưa đủ thông tin chọn thiết kế | `executor-deep` (**tầng sâu**, ADR-0029; chỉ khi `topo: parallel` — ADR-0061; task `self` đỏ 2 lần cũng chuyển cấp lên tầng này) — ghi `(exec: deep)` trong dòng task của PLAN; `loop status` trả `executor` | Hậu quả sai lớn dù diff nhỏ; cần giữ nhiều trạng thái/giả thuyết. Xét **4 khía cạnh**: phức tạp · bất định · rủi ro · phạm vi ảnh hưởng — một khía cạnh cao là đủ |
| Tầng mặc định đỏ 2 lần cùng task trong vòng này | **Chuyển cấp** lên `executor-deep` (`loop status` trả `escalated: true`), kèm diff hiện tại + evidence lỗi + giả thuyết đã loại; ngân sách task giữ nguyên | `LOOP-ORCH-014`: lần 2 đổi cách — đổi tầng là một dạng đổi cách; lần 3 vẫn `blocked` |
| Review khi `pr next` trả `review` (làn chuẩn; pha build chỉ PR rủi ro cao — ngoại lệ cứng kể cả đã miễn, schema/migration (ADR-0062); rủi ro trung bình ghi nợ: ADR-0037) hoặc phiên chính thấy rủi ro cụ thể | `reviewer` (năng lực cao hơn người viết, `LOOP-ORCH-005`); diff do `executor-deep` hoặc phiên chính viết → `reviewer-alt` (cùng họ Opus, effort `max`); phiên chính chạy Fable → giao `reviewer-alt` với `model: fable` (effort `max` vẫn cao hơn phiên chính); không có reviewer nào cao hơn (phiên chính Fable@max) → reviewer khác nhà cung cấp, không có thì `pr reviewed --inconclusive` + `loop defer` | Người chấm mạnh hơn người viết; phát hiện phải có đường tái hiện; `pr reviewed --clean` với reviewer không cao hơn bị từ chối, cùng họ phải khai `--reviewer-effort`/`--author-effort` (D-161) |
| Quyết định kiến trúc, chọn công nghệ, spec mâu thuẫn | **Không tách** — phiên chính tự duyệt, ghi D-NNN (ADR-0008) | Cần toàn cảnh; subagent chỉ trả phương án |
| Điểm dừng bắt buộc về hành động | **Không tách** — phiên chính + người | Hành động không đảo ngược/đối ngoại |
| Việc nhỏ (< 10 phút, vài file phiên chính đã đọc trong phiên — ngưỡng vận hành tự đặt) hoặc task mà SPEC đã là nội dung cuối (PLAN, SPEC, ADR, research note — `LOOP-ORCH-019`; giao chỉ là chép lại) | Làm trực tiếp; `loop record` **không** `--executor` (`"executor": null` trong `runs.jsonl`); báo cáo cuối lát liệt kê task tự làm kèm lý do | Chi phí giao việc (handoff + đọc lại repo) lớn hơn việc; handoff mất thông tin; là nhóm đo của `LOOP-ORCH-020` |

### Cấu hình theo loại việc (topology — ADR-0061)

Software Factory tự chọn cấu hình theo **độ độc lập của việc**, không cố định một agent hay luôn dùng đội subagent. Mặc
định là `self`; PLAN ghi `(topo: …)` trong ngoặc của dòng task như `(exec: deep)`; `loop status --json` trả `topology` và
`executor` (`null` trừ `parallel`; harness cũ không trả `topology` → coi là `self`). Bốn hàng, chỉ
tăng số agent khi số đo chứng minh (`LOOP-ORCH-020`):

| `topo:` | Loại việc | Cấu hình | Gồm |
|---|---|---|---|
| `self` (mặc định) | Sửa lỗi, tính năng nhỏ, task mà SPEC đã là nội dung cuối | **Một** agent (phiên chính) sở hữu code và tích hợp; CI là cổng đầy đủ (ADR-0056); review theo làn của `pr next` | `loop record` không `--executor`; `researcher` chỉ khi đọc dài (`LOOP-ORCH-012`) |
| `review` | Tính năng xuyên nhiều module; chạm bảo mật/kiến trúc/dữ liệu | Phiên chính viết; `reviewer-alt` rà **trước khi mở PR** (góc nhìn độc lập — `LOOP-ORCH-005`); không `executor` | Ghi `pr reviewed --head <SHA đã rà>` theo `/complete` bước 4 |
| `parallel` | Nhiều module độc lập về file, hợp đồng giao diện đã chốt (`LOOP-ORCH-007`) | Phiên chính điều phối; mỗi module một `executor`/`executor-deep` (`exec:`), đợt ≤ 4 (`plan waves --max 4`; trần cứng 5 — `LOOP-ORCH-008`), worktree mỗi task (mô hình B) | `plan waves` xác nhận `files:` đôi một không giao; thiếu `files:` → task đứng riêng |
| `audit` | Audit lớn, kiểm thử độc lập sau một pha | Một lượt: reviewer read-only theo cụm độc lập file (≤ 4 đồng thời) + xác minh đối kháng 🔴/🟠 bằng reviewer **khác** (`/audit` §3–4); sửa theo **batch** = PLAN có Gate, mỗi lát một PR | Không sửa trong lúc audit; kết quả là dữ liệu (`LOOP-ORCH-004`) |

Chọn hàng: hỏi theo thứ tự — việc có tách được thành module **độc lập file** với hợp đồng đầu ra rõ không (`parallel`)? →
có chạm bảo mật/kiến trúc/dữ liệu hay xuyên module (`review`)? → là audit/kiểm thử độc lập (`audit`)? → còn lại `self`.
Tầng mặc định đỏ 2 lần vẫn chuyển cấp `executor-deep` (ADR-0029) ở mọi hàng.

### Mô hình nhánh khi song song

| Mô hình | Cách làm | Dùng khi |
|---|---|---|
| **A — một nhánh, task = commit** (mặc định) | Mọi subagent làm trên nhánh `feat/<mảng>`; mỗi task một commit; phiên chính gom | Task nối tiếp hoặc chạm file chung |
| **B — worktree mỗi task** | Subagent khai `isolation: worktree` (Claude Code tạo worktree riêng); mỗi task một nhánh, PR riêng; merge FIFO | Task độc lập file, muốn chạy ≥ 2 executor đồng thời |

Xếp đợt bằng máy: `xt.py plan waves [--plan P] [--max N] [--json]` chia task mở của PLAN thành đợt — trong một đợt mọi
`sau:` đã thoả, `files:` đôi một không giao (cùng phép so của `loop next`), ≤ N task (mặc định 4, ADR-0061; trần cứng 5 — `LOOP-ORCH-008`), task thiếu `files:`
đứng riêng; task trên chu trình, ghi chú hỏng hoặc đã defer vào mục bị chặn kèm lý do. Không cần vòng đang chạy; đợt
nhiều task chạy theo mô hình B, đợt một task theo mô hình A.

Giới hạn: ≤ 5 subagent đồng thời (stored 23 §2, 03 §5; RAM/IO máy và ngân sách context phiên chính), độ sâu lồng = 1
(`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` hoặc không cấp tool `Agent` cho subagent — cách thứ hai là cách repo
này đang dùng: `tools:` của năm agent trong `.claude/agents/` không có `Agent`).

### Gói giao việc (handoff) tối thiểu

`goal` · `acceptance_criteria` (= Gate lệnh máy) · `files_in_scope` · `budget` (maxTurns, thời gian) · `depth` ·
`granted_scopes` ⊆ phiên chính · `trust_level: untrusted` cho dữ liệu subagent mang về · `report_format` (đã làm ·
lệnh + exit code · còn treo) · `context_reason` (1/2/3 theo [`AI-AGENTIC-011`](../13-ai-engineering/agentic-systems.md), hoặc
`topo: parallel` cho `executor`; không có → tự làm (`topo: self`, `LOOP-ORCH-024`)) · `executor_tier` (mặc định/sâu + lý do theo 4 khía cạnh) · `escalation_condition` (mặc định: đỏ 2 lần →
tầng sâu; chạm bảo mật/toàn vẹn dữ liệu/đồng thời → tầng sâu ngay; cần quyết định phạm vi/kiến trúc → trả về phiên chính).
Thiếu `acceptance_criteria` → không giao.

## Checklist

- [ ] `LOOP-ORCH-001` **MUST** Chỉ phiên chính điều phối; subagent không gọi subagent (vòng lặp phát triển; sản phẩm agentic theo [`AI-AGENTIC-007`](../13-ai-engineering/agentic-systems.md)). → Kiểm: `.claude/agents/*.md` không có `Agent` trong `tools:` **hoặc** môi trường đặt `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. · Nguồn: stored 23 §4.4; Claude Code env-vars
- [ ] `LOOP-ORCH-002` **MUST@L** Mỗi lần giao việc có gói handoff tối thiểu: mục tiêu, tiêu chí chấp nhận là lệnh máy, file trong phạm vi, ngân sách, phạm vi quyền ⊆ phiên chính. → Kiểm: prompt giao việc chứa đủ 5 trường; thiếu Gate → từ chối giao. · Nguồn: `research/2026-10-13-ai-agent-research.md` §2.3
- [ ] `LOOP-ORCH-003` **MUST** Subagent không được cấp quyền/tool rộng hơn phiên chính và không tự nâng mức tin cậy T0–T4 của hành động. → Kiểm: `xt.py harness-check` exit 0 (lệnh tự viết `python3 -c` bị guard chặn); `tools:` của agent là tập con; hành động T3–T4 trong output subagent bị phiên chính đưa về điểm dừng (`xt.py loop block`). · Nguồn: [`stop-points-and-escalation.md`](stop-points-and-escalation.md)
- [ ] `LOOP-ORCH-004` **MUST** Kết quả "xanh" do subagent khai chỉ được tick task sau khi phiên chính chạy lại Gate bằng `xt.py loop record`. → Kiểm: `.autopilot/evidence/T-xxx.json` tồn tại cho task đã tick; `loop status` không trả `verify`.
- [ ] `LOOP-ORCH-005` **MUST@L** Reviewer có **năng lực cao hơn** người viết — agent năng lực cao nhất đã góp vào diff (kể cả `executor-deep` và phiên chính): model bậc cao hơn (Haiku < Sonnet < Opus < Fable), hoặc cùng họ với effort cao hơn (low < medium < high < xhigh < max); khác nhà cung cấp (máy không xếp hạng được) nhận như khác họ; diff chỉ gồm commit của bot tin cậy (Dependabot — `--author-model dependabot[bot]`, máy kiểm trên GitHub tác giả PR và mọi commit không phải merge) thì reviewer chỉ cần có họ model rõ (AUD-XFEAT-039); chỉ có tool đọc + Bash kiểm, không sửa file; reviewer không kết luận được (diff bị cắt, hết ngân sách, thiếu file) trả INCONCLUSIVE, phiên chính ghi `pr reviewed --inconclusive` và giao reviewer khác — không ghi sạch. → Kiểm: `.claude/agents/reviewer.md` có `model:` bậc cao hơn `executor.md`, `reviewer-alt.md` cao hơn `executor-deep.md` (cùng họ thì `effort:` cao hơn), cả hai `tools:` không chứa `Edit`/`Write`; `pr reviewed --clean` với reviewer không cao hơn người viết exit 2 (D-161, ADR-0044 — thay "khác họ" của D-045).
- [ ] `LOOP-ORCH-006` **MUST@L** Hai task chạm cùng file, migration, port hoặc biến môi trường không chạy song song. → Kiểm: `PLAN.md` ghi `files:`/`depends_on:` cho task song song; script kiểm giao nhau tập file trước khi tách. · Nguồn: stored 21 §6
- [ ] `LOOP-ORCH-007` **MUST@L** Trước khi chạy song song, hợp đồng giao diện (OpenAPI/schema/type) đã commit và có test contract. → Kiểm: `API-CONTRACT.md` hoặc file schema trong `git log` trước commit đầu của nhánh song song. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `LOOP-ORCH-008` **MUST@L** Số subagent đồng thời ≤ 5 và mỗi subagent có `maxTurns`. → Kiểm: `.claude/agents/*.md` đều có `maxTurns:`; PLAN ghi số song song tối đa. · Nguồn: stored 23 §2 (dòng 72, trích ADR-0011 projects-template) và 03 §5 — trích dẫn cũ "23 §4.5" lệch, sửa 2026-11-01 (AUD-DOC-137)
- [ ] `LOOP-ORCH-009` **MUST** Hành động đối ngoại (push, publish, gửi thông báo) không giao cho subagent; chỉ phiên chính làm; guard chặn hành động không đảo ngược, không hỏi (ADR-0018). → Kiểm: prompt subagent không chứa lệnh push/publish; `pre-bash-guard.sh` chặn (không `ask`) ở phiên chính. · Nguồn: [`stop-points-and-escalation.md`](stop-points-and-escalation.md)
- [ ] `LOOP-ORCH-010` **SHOULD** Dùng mô hình nhánh A (một nhánh, task = commit) mặc định; chỉ chuyển sang worktree (`isolation: worktree`) khi task độc lập file và cần ≥ 2 executor đồng thời (`topo: parallel`, đợt ≤ 4 — ADR-0061). · Nguồn: stored 23 §4.5
- [ ] `LOOP-ORCH-011` **SHOULD** Subagent trả báo cáo ≤ 25 dòng theo khuôn: đã làm · lệnh + exit code · còn treo · đề xuất; không trả transcript dài về phiên chính.
- [ ] `LOOP-ORCH-012` **SHOULD** Việc đọc dài (tài liệu, log, repo lạ) giao `researcher` để giữ context phiên chính; phiên chính chỉ nhận tóm tắt có URL/đường dẫn. · Nguồn: [`context-and-token-budget.md`](context-and-token-budget.md)
- [ ] `LOOP-ORCH-013` **SHOULD** Nhiều PR mở cùng lúc merge theo FIFO (tạo trước merge trước), cập nhật nhánh sau với `main` rồi mới merge tiếp. · Nguồn: [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md)
- [ ] `LOOP-ORCH-014` **SHOULD** Subagent thất bại 2 lần cùng task → phiên chính đổi cách tiếp cận, chia nhỏ task, **hoặc chuyển cấp lên tầng sâu** (`executor-deep`, ADR-0029) kèm diff + evidence lỗi + giả thuyết đã loại, không giao lại nguyên văn; lần 3 → hỏi người (`max_same_failure: 3` giữ nguyên — lần chuyển cấp tiêu một lần thử). → Kiểm: `loop status --json` trả `escalated: true` sau 2 lần đỏ của tầng mặc định; `loop stats` có `escalation_rate`. · Nguồn: stored 23 §4.5
- [ ] `LOOP-ORCH-015` **SHOULD** Khi cần đa dạng phương án (thiết kế, cách sửa bug khó), chạy ≥ 2 subagent **ngữ cảnh tách biệt** rồi phiên chính so sánh; chỉ cho việc mở, vì tốn ~5–10× chi phí. · Nguồn: stored 21 §6
- [ ] `LOOP-ORCH-016` **MAY** Ghi topology điều phối (ai giao ai, giới hạn song song, tool bị ẩn) vào ADR khi dự án ≥ M chạy autopilot thường xuyên. · Nguồn: [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `LOOP-ORCH-017` **SHOULD** Đo theo lát/tuần tỉ lệ **lần chạy Gate đỏ của task đã giao subagent** khi phiên chính `loop record` (xấp xỉ "bị bác": harness không ghi báo cáo của subagent, chỉ phiên chính chạy `loop record` — `LOOP-ORCH-004`) cùng tỉ lệ tự làm (`LOOP-ORCH-020`); bác > 20 % (tính theo lần chạy) → siết spec/handoff trước khi tăng song song hay đổi tầng. → Kiểm: chuẩn theo LẦN CHẠY: `grep -E '"exit_code": -?[1-9]' .autopilot/runs.jsonl | grep -vc '"executor": null'` trên `grep -vc '"executor": null' .autopilot/runs.jsonl`; theo task chỉ là xấp xỉ (`xt.py loop stats --all --json`: task có `tasks.<T>.executors` khác rỗng và `failed > 0` — đếm cả lần đỏ lúc task còn tự làm rồi mới giao); số ghi ở báo cáo cuối lát/phiên. · Nguồn: [`LOOP-DESIGN-024`](loop-design.md); ADR-0045
- [ ] `LOOP-ORCH-019` **SHOULD** Hai tầng executor, tên tầng không tên model (ADR-0029): `executor` (mặc định) và `executor-deep` (sâu) là hai agent file, model thật chỉ trong frontmatter `model:` của agent; PLAN ghi `(topo: parallel; exec: deep)` cho task khởi đầu ở tầng sâu (thiếu `topo: parallel` thì `exec` không giao agent — ADR-0061) theo 4 khía cạnh (phức tạp · bất định · rủi ro · phạm vi), còn lại mặc định; phiên chính ghi `loop record --executor <agent>` để `runs.jsonl`/`loop stats` đo tỉ lệ chuyển cấp; phiên chính (điều phối — lập PLAN, viết SPEC/thiết kế, không giao subagent) chạy model cao nhất sẵn có theo thứ tự **Fable → Opus → Sonnet** (bậc trên không khả dụng mới xuống bậc dưới) — chọn lúc mở phiên, không ghi trong artefact commit; subagent giữ model theo frontmatter. Giữ cache khi đổi model/effort: [`LOOP-DESIGN-012`](loop-design.md). → Kiểm: `.claude/agents/executor-deep.md` tồn tại với `model:` khác `executor.md`; `grep -c 'exec: deep' docs/autopilot/PLAN.md` ≤ số task rủi ro cao ghi trong PLAN; `xt.py loop stats --json` có `escalation_rate`; không chuỗi tên model trong `PLAN.md`/commit (LOOP-HARNESS-027). · Nguồn: Anthropic *Building effective agents* (routing: "sending simpler questions to cheaper models"; orchestrator-workers) — `research/2026-10-19-rapid-build-then-harden.md` §9
- [ ] `LOOP-ORCH-018` **SHOULD** Trước `loop decide` duyệt PLAN, `reviewer` (năng lực cao hơn người viết PLAN) rà phần Gate của PLAN: lệnh kiểm **hành vi theo SPEC** ([`QA-STRAT-023`](../14-testing-quality/test-strategy.md): test viết từ SPEC, không từ code) và **không chứa lệnh đối ngoại/phá huỷ** ([`LOOP-STOP-027`](stop-points-and-escalation.md)). → Kiểm: mục D-NNN "Duyệt PLAN" trong `docs/autopilot/DECISIONS.md` dẫn kết quả reviewer. · Nguồn: `seeker19110/stored` 01 §3g.3 (rà 2026-10-18)
- [ ] `LOOP-ORCH-020` **SHOULD** Mặc định giao việc của harness là **tự làm** (`topo: self`, `executor: null` — `LOOP-ORCH-024`, ADR-0061); đổi mặc định **lần kế** (sang giao, thêm/bỏ tầng, nới đợt) chỉ **khi có số**. Nhóm tự làm = task `self`/`review`/`audit`: phiên chính làm, `loop record` **không** `--executor`, báo cáo cuối lát liệt kê ID task tự làm kèm lý do (`loop stats` nhóm theo executor của LẦN CHẠY ĐẦU của task — `self_done` phải khớp danh sách; lệch là "quên cờ", không tính); nhóm giao = `parallel` (và task chuyển cấp từ lần chạy đầu). Báo cáo cuối lát/phiên ghi: tỉ lệ giao (`delegation_rate`), tỉ lệ xanh lần đầu mỗi nhóm (`runs_to_green == 1`), tỉ lệ bác (`LOOP-ORCH-017`); đây là quan sát trên hai tập task khác nhau (không cặp, có thiên lệch chọn); chi phí/token mỗi task harness chưa ghi → ADR nêu ước lượng hoặc "chưa đo". Đổi mặc định giao việc, thêm/bỏ tầng hay nới đợt chỉ sau ≥ 10 task mỗi nhóm qua ≥ 2 vòng **và** KPI thời gian (`LOOP-DESIGN-024`) giảm mà xanh lần đầu/`reverts` không xấu đi — khởi điểm tự đặt (mượn cỡ bộ eval khởi đầu của kit; task phát triển không lặp lại được nên không đo nhiễu kiểu rep; báo khoảng tin cậy Wilson theo [`AI-EVAL-018`](../13-ai-engineering/evaluation.md)) — rồi ghi research note + ADR. Task tự làm đỏ 2 lần → harness chuyển `executor-deep` như thường (ADR-0029) và vẫn là tự làm (nhóm theo lần chạy đầu); `escalation_rate` không thấy trường hợp này — đếm tay từ `tasks`. Lưu ý phép đo: `--all` gộp task theo ID — dự án đánh lại `T-001` ở đợt sau thì đo từng đợt (không `--all`). → Kiểm: `xt.py loop stats --all` in dòng "Giao việc"; `--json` có `delegation_rate`, `delegated`, `self_done`, `first_pass_rate_delegated`, `first_pass_rate_self` (nhóm theo executor của lần chạy đầu trong `runs.jsonl`; `tasks.<T>.runs_to_green`); `grep -c '"executor": null' .autopilot/runs.jsonl` đếm theo LẦN CHẠY (ghi rõ đơn vị); báo cáo cuối lát/`PROGRESS.md` ghi số hai nhóm; ADR đổi mặc định dẫn bảng so sánh. · Nguồn: claude.com *When to fold subagents* (2026-10-22, "measure, change one thing at a time, and keep what holds up"); kit `anthropics/single-agent-loop-kit` README ("It measures."), `skill/steps/01-baseline.md` ("Ten good tasks is enough to start"; c437962, 2026-10-21); ADR-0045
- [ ] `LOOP-ORCH-021` **SHOULD** Vòng tự động **không bật Agent Teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) trừ khi có ADR: khi bật, mọi lần gọi Agent tool có `name` thành teammate mà không hỏi, teammate **kế thừa chế độ quyền của lead** (kể cả `--dangerously-skip-permissions`), plan của teammate được tự duyệt và teammate nhắn nhau trực tiếp — đi vòng qua `LOOP-ORCH-001`/`003`/`009`. ADR cho bật thì: hook `TaskCompleted`/`TeammateIdle` chạy Gate, ≤ 5 teammate (`LOOP-ORCH-008`), mỗi teammate sở hữu tập file riêng. → Kiểm: `xt.py doctor` không có cảnh báo `orchestration` (đọc môi trường phiên và khối `env` của `.claude/settings*.json`; có ADR nhắc biến thì không báo). · Nguồn: Claude Code docs *agent-teams* (2026-10-31)
- [ ] `LOOP-ORCH-022` **SHOULD** Định nghĩa agent lấy từ bên thứ ba khai `model:` là `inherit` hoặc một tầng của khung (`LOOP-ORCH-019`), không ghim ID/họ model cứng (`model: opus`): agent ghim cứng chạy model đắt dù phiên chính rẻ, chi phí không đoán được. → Kiểm: `xt.py doctor` không có cảnh báo `orchestration` (agent ngoài bộ của khung có `model:` là `inherit` hoặc không khai).
- [ ] `LOOP-ORCH-023` **MAY** Bật **Advisor Tool** (`/advisor`, `advisorModel`) cho phiên chính ở hai điểm: duyệt PLAN và trước `/complete`; advisor đọc transcript nhưng **không có tool** và không độc lập về dữ kiện, nên **không thay** `reviewer` (`LOOP-ORCH-005`); chỉ bật mặc định sau eval bật/tắt (`LOOP-DESIGN-025`). Đặt `DISABLE_TELEMETRY` làm advisor tắt (feature flag không tải được). → Kiểm: D-NNN ghi cặp model, số eval và chi phí đo bằng `/usage`. · Nguồn: Claude Code docs *advisor*; Claude API *advisor tool* (beta `advisor-tool-2026-03-01`) — đọc 2026-10-31
- [ ] `LOOP-ORCH-024` **SHOULD** Cấu hình agent chọn theo **loại việc** (bảng topology, ADR-0061): mặc định một agent chính (phiên chính) sở hữu code và tích hợp — `loop status` trả `topology: self`, `executor: null`; `review` khi xuyên module/chạm bảo mật-kiến trúc-dữ liệu (reviewer độc lập trước PR); `parallel` chỉ khi các module độc lập file với hợp đồng đầu ra rõ, đợt ≤ 4; `audit` = một lượt sau pha lớn rồi sửa batch. Tăng số agent (đổi mặc định sang giao, nới đợt) chỉ khi số đo `LOOP-ORCH-020` + KPI thời gian (`LOOP-DESIGN-024`: `time_to_green_hours`, `pr stats.lead_time_hours`) cho thấy thời gian giảm mà tỉ lệ xanh lần đầu/`reverts` không xấu đi. → Kiểm: `xt.py loop status --json` có `topology`; task không ghi `topo:` trả `self` và `executor: null`; `(topo: parallel)` trả tầng theo `exec:`; `plan waves` mặc định `--max 4`; test `test_topology_default_self_executor_null`. · Nguồn: chủ dự án 2026-11-01 (`research/2026-11-01-adaptive-agent-topology.md`); ADR-0045 (đo trước khi đổi)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Subagent gọi tiếp subagent "cho nhanh" | Không ai nắm ngân sách; lỗi nhân bản theo tầng | Bỏ `Agent` khỏi `tools:`; depth = 1 |
| Tin báo cáo "test pass" của subagent | Tick task không có bằng chứng; Stop hook trả `verify` muộn | Phiên chính `loop record` lại Gate |
| Hai executor cùng sửa `schema.prisma`/migration | Xung đột merge, migration lệch số | Khai `files:` trong PLAN; serial hoá task chạm schema |
| Reviewer không cao hơn người viết (cùng model, cùng effort), nhận cả lý luận của executor | Cùng điểm mù, review "xanh" rỗng | Reviewer năng lực cao hơn (`LOOP-ORCH-005`); chỉ đưa diff + SPEC |
| Giao task spec hở để "subagent tự lấp" | Subagent bịa yêu cầu, làm việc khác hẳn | Spec hở → phiên chính quyết D-NNN trước khi giao; subagent trả câu hỏi về, không tự lấp |
| Mở 10 subagent song song trên máy 8 GB | OOM, timeout giả, chữ ký lỗi nhiễu | Trần 5; giảm khi máy yếu |
| Subagent được quyền push/publish | Hành động đối ngoại không qua điểm dừng | Chỉ phiên chính push/publish, qua hook guard (deny việc không đảo ngược) và `loop defer` cho việc cần người |
| Đưa transcript subagent nguyên văn vào context chính | Context phình, compaction sớm | Báo cáo ≤ 25 dòng, link file/log |
| Bật Agent Teams "cho nhanh" trong phiên autopilot | Subagent có tên thành teammate không hỏi; teammate kế thừa quyền lead, plan tự duyệt | Giữ biến tắt; bật chỉ qua ADR + hook Gate (`LOOP-ORCH-021`) |
| Cài bộ agent ngoài có `model: opus` | Subagent luôn chạy model đắt nhất, chi phí vọt | Đổi `model:` về `inherit`/tầng khung khi cài (`LOOP-ORCH-022`) |
| Giao mọi task cho `executor` "vì rẻ"/"cho chuẩn quy trình", tách thêm agent "cho nhanh" không có số, hay mở `rethink` nhiều lượt để "sửa cho sạch" | Handoff + đọc lại repo tốn hơn việc, không có số để so; PR #372 (2026-11-01) 7 lượt review đăng dấu vẫn đỏ, đóng không merge | `topo: self` mặc định, đo rồi mới tăng số agent (`LOOP-ORCH-020`); `rethink` ≤ 1 lần/PR (`max_rethink`, trừ PR cắt bản — ADR-0059 §6), hết thì tách PR hoặc đóng (`LOOP-ORCH-024`, ADR-0061) |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Cấm lồng subagent | Kiểm `tools:` của `.claude/agents/*.md` không có `Agent` (grep) | Test harness `tests/test_hooks.py` hoặc script CI | 0 vi phạm |
| Bằng chứng task do subagent làm | `xt.py loop record --task T-xxx -- <Gate>` ở phiên chính | Trước khi tick `[x]` | `exit_code: 0` |
| Giao nhau tập file giữa task song song | Script đọc `files:` trong PLAN, báo cặp giao nhau | Trước khi tách subagent | 0 cặp giao nhau |
| Reviewer năng lực cao hơn, read-only | Kiểm frontmatter `model:`/`effort:`/`tools:` | `xt.py pr reviewed --clean` (từ chối reviewer không cao hơn); `tools:` do `harness-check`, `model:`/`effort:` do review rà | Bậc cao hơn `executor` (cùng họ: effort cao hơn); không `Edit/Write` |
| Trần turn mỗi subagent | `maxTurns:` trong frontmatter agent | `.claude/agents/*.md` | Có giá trị (repo này: 80–160) |
| Tự làm / giao / bác | `xt.py loop stats --all --json` (`delegation_rate`, `self_done`, `first_pass_rate_*`; `tasks.<T>.executors`, `failed`) + `grep` trên `.autopilot/runs.jsonl` (`"executor": null`) — `LOOP-ORCH-017`, `LOOP-ORCH-020` | Báo cáo cuối lát/phiên | Có số, đúng đơn vị (task so với lần chạy); tăng số agent (đổi mặc định `self`, nới đợt) cần bảng so sánh + ADR (`LOOP-ORCH-024`) |

## Nguồn

- Harness thật của repo: `.claude/agents/{researcher,executor,executor-deep,reviewer,reviewer-alt}.md` (`tools`, `model`, `maxTurns`; `effort` ở `executor-deep`/`reviewer-alt`; không có `Agent` trong `tools`) và `AGENTS.md` §8 — đọc 2026-10-24.
- Claude Code docs — subagents (`tools`, `disallowedTools`, `maxTurns`, `isolation: worktree`): <https://code.claude.com/docs/en/sub-agents> · env `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (mặc định 3, `1` = tắt lồng): <https://code.claude.com/docs/en/env-vars> — xác minh 2026-10-13 (`research/2026-10-13-claude-code-hooks-skills.md`).
- Anthropic, *How we built our multi-agent research system* (ngữ cảnh tách biệt, chi phí ~15× token, chỉ cho việc rộng): <https://www.anthropic.com/engineering/multi-agent-research-system> — theo `research/2026-10-13-ai-agent-research.md` §2.3 [F].
- `seeker19110/stored` mục 21 §6 (giới hạn song song, hợp đồng giao diện trước), mục 23 §4.3 (chọn worker 2 trục), §4.4 (subagent không lồng, điều phối = phiên chính), §4.5 (trần 5 đồng thời, mô hình nhánh A/B, thất bại 2× đổi cách, 3× hỏi người) — đọc 2026-10-13.
- Handoff schema (depth ≤ 3, concurrent ≤ 8, scopes ⊆ parent, `trust_level: untrusted`): `research/2026-10-13-ai-agent-research.md` §2.3 — khung này siết chặt hơn (depth 1, đồng thời ≤ 5) theo stored 23.
- Catalog `seeker19110/stored` 01 §3g.3 (reviewer rà Gate của PLAN trước khi duyệt) — rà 2026-10-18.
- claude.com, *Building agents: When to fold subagents into your main agent loop* (2026-10-22): <https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop> · kit single-agent-loop-kit (`c437962`, 2026-10-21; "It measures."): <https://github.com/anthropics/single-agent-loop-kit> — xác minh 2026-10-24 (`research/2026-10-24-single-agent-loop.md`, ADR-0045); nhà luật sản phẩm: [`AI-AGENTIC-011`](../13-ai-engineering/agentic-systems.md), `AI-AGENTIC-019`.
- Claude Code docs — agent teams (biến bật, teammate kế thừa quyền lead, plan tự duyệt, hook `TaskCompleted`/`TeammateIdle`, giới hạn): <https://code.claude.com/docs/en/agent-teams> — xác minh 2026-10-31
- Claude Code docs — advisor (cặp model, không cache phía advisor, `DISABLE_TELEMETRY` tắt advisor): <https://code.claude.com/docs/en/advisor> · Claude API advisor tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool> — xác minh 2026-10-31
- Catalog `seeker19110/stored` 03 §8e–§8f (kiểm docs Advisor/Agent Teams), 20 §3q.2 (54/202 agent của wshobson/agents ghim `model: opus`), `X-TEMPLATES.md` stored§XT-H-001/007/009 — rà 2026-10-31
- Chủ dự án, nhận định "Adaptive Agent" 2026-11-01 (bảng loại việc → cấu hình, 6 KPI, "1 agent chính + tối đa 2–4 subagent"): `research/2026-11-01-adaptive-agent-topology.md`; ADR-0061
