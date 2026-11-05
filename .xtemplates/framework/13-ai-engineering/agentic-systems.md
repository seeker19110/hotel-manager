---
title: Hệ agentic: đa agent, durable execution, outbox, ranh giới ủy quyền
kind: module
prefix: AI-AGENTIC
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-11-04
---

# Hệ agentic: đa agent, durable execution, outbox, ranh giới ủy quyền

> Hệ agentic là **sản phẩm** chạy nhiều bước/nhiều agent trong runtime, có tác dụng phụ thật. Module này quy định:
> chọn kiến trúc bằng eval so sánh (khởi điểm khi đã cần agent: một vòng lặp + skill/tool nạp theo nhu cầu; tách agent con
> chỉ vì context), thực thi bền (durable execution) với checkpoint, outbox + lease + fencing
> cho tác dụng phụ, kill switch, ngân sách nhiều chiều, ranh giới ủy quyền, và đo pass^k. Agent đơn/tool ở
> [`agents-and-tools.md`](agents-and-tools.md); vòng lặp phát triển phần mềm ở [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md).

## Nguyên tắc

1. **Đơn giản nhất mà eval chấp nhận**: 5 workflow pattern là từ vựng mô tả, không phải thang leo theo thứ tự cố định. Khi bài toán đã cần agent (một lời gọi + schema không đủ — [`AI-APP-010`](llm-app-foundations.md)), khởi điểm là **một vòng lặp + skill/tool nạp theo nhu cầu** — trong so sánh của đội Applied AI (Anthropic) trên một số triển khai doanh nghiệp, cách này *thường* thắng cả "một prompt cho tất cả" lẫn router + agent con theo miền về chất lượng (không nêu n; không phải "luôn"). Thêm hay bớt agent đều qua eval so sánh (`AI-AGENTIC-001`); tách chỉ vì lý do context (`AI-AGENTIC-011`). Khởi điểm này dựa trên năng lực thế hệ model hiện tại: ghi ngày và giả định model trong ADR kiến trúc, xét lại khi đổi model ([`AI-EVAL-013`](evaluation.md)).
2. **Đa agent là đắt và mất thông tin**: ~15× token so với chat đơn; mỗi handoff là một lần tóm tắt có mất mát ("telephone game"); chỉ cho việc rộng (breadth-first), không cho việc tuần tự hẹp.
3. **Trạng thái sống ngoài tiến trình**: mỗi bước là checkpoint; tiến trình chết → tiếp tục từ bước cuối, không chạy lại tác dụng phụ.
4. **Tác dụng phụ qua outbox**: ý định ghi vào DB cùng giao dịch, worker có lease + fencing token gửi đi; `outcome_unknown` → đọc lại (receipt read-back) trước khi retry.
5. **Ranh giới ủy quyền thu hẹp theo tầng**: agent con nhận ⊆ quyền/ngân sách/tool của cha; depth (khuyến nghị 2, trần 3) và số đồng thời có trần; dữ liệu con trả về là untrusted.
   Phạm vi: áp cho **sản phẩm agentic** của dự án; vòng lặp phát triển bằng agent lập trình dùng luật riêng về độ sâu — subagent không lồng (độ sâu 1), xem [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md); ba lý do tách agent con (`AI-AGENTIC-011`) dùng chung.
6. **Dừng được trong ≤ 10 giây**: kill switch theo tenant/workflow/toàn hệ thống ở tầng runtime, không phụ thuộc model.
7. **Tin cậy đo bằng pass^k**: hệ cần đúng mọi lần dùng pass^k, không pass@k.

## Quyết định

### Pattern theo bài toán

| Pattern | Dùng khi | Rủi ro chính |
|---|---|---|
| Prompt chaining | Bước cố định, kiểm giữa chừng | Lỗi tích luỹ — có gate giữa bước |
| Routing | Phân loại rồi chuyên môn hoá — chỉ khi nhánh có lý do context (`AI-AGENTIC-011`) | Phân loại sai — eval router riêng; tách theo loại vấn đề → handoff mất thông tin |
| Parallelization | Bước độc lập, hoặc bỏ phiếu | Chi phí ×n |
| Orchestrator-workers | Số việc con không biết trước **và** việc con độc lập, context vứt được khi xong | Điều phối lồng — trần depth |
| Evaluator-optimizer | Có tiêu chí đánh giá rõ | Lặp vô hạn — trần vòng |
| Agent tự trị (một vòng lặp + tool/skill) | Việc mở, có sandbox và HITL; khởi điểm khi đã cần agent (Nguyên tắc 1) | Mọi rủi ro trên — hàng rào ở harness/tool (`AI-AGENTIC-006`, `AI-AGENTIC-008`); so với pattern khác qua eval (`AI-AGENTIC-001`) |

Bảng là từ vựng; thứ tự dùng không cố định (Nguyên tắc 1).

### Runtime thực thi bền (xác minh 2026-10-13)

| Nhu cầu | Lựa chọn | Phiên bản |
|---|---|---|
| Workflow dài ngày, retry, timer, signal, lịch sử đầy đủ | Temporal (`temporalio` 1.34.0, PyPI 2026-09-30) | Cần cluster/cloud |
| Durable function nhẹ, HTTP-first | Restate v1.7.13 (GitHub release 2026-10-01) | Server đơn |
| Trong Postgres, thư viện Python | DBOS (`dbos` 3.2.0, PyPI 2026-09-29) | Không dịch vụ riêng |
| Graph agent có checkpoint | LangGraph checkpointer (DB) | Checkpoint là trạng thái graph, vẫn cần outbox cho tác dụng phụ |

Chọn theo [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md); không tự viết "retry + cron" thay durable execution cho tác vụ có tiền/đối ngoại.

### Ngân sách 5 chiều (mỗi workflow/tenant)

Token · tiền · thời gian · số bước/tool call · số agent con. Vượt chiều nào → dừng có lý do và trạng thái `budget_exceeded`, không "thử nốt".

### Handoff giữa agent

Trường tối thiểu: `goal`, `acceptance_criteria`, `budget_remaining`, `depth` (khuyến nghị ≤ 2, trần 3), `granted_scopes` ⊆ cha,
`trust_level: untrusted`, `trace_id`. Chiều về: một `result_schema` chung cho mọi agent con (vd `conclusion` · `evidence` ·
`actions_taken` · `caveats`), không văn xuôi tự do, không giọng riêng; agent cha đối chiếu `conclusion` với dữ liệu thật (dựa
trên `evidence`) trước khi tổng hợp (`AI-AGENTIC-019`). Số con đồng thời ≤ 8 (thấp hơn khi RAM/rate limit giới hạn).

### Kết luận cho từng agent con đang có

Mỗi agent con (subagent) hiện có nhận một kết luận — bảng theo bước audit của kit `single-agent-loop-kit`; ba lý do context ở
`AI-AGENTIC-011`, trình tự gộp có đo ở `AI-AGENTIC-019`; hàng rào cứng đặt ở harness/tool (`AI-AGENTIC-006`, `AI-AGENTIC-008`,
[`agents-and-tools.md`](agents-and-tools.md)), không trong skill.

| Kết luận | Khi nào |
|---|---|
| `main` | Router/orchestrator hiện tại — trở thành vòng lặp duy nhất |
| `fold` (mặc định) | Agent con = prompt (quy trình, kiến thức miền) + vài lời gọi API, không cần context riêng → skill + tool trong agent chính; không còn gì cho skill thì chỉ còn tool |
| `merge:<agent>` | Hai agent con nối đầu ra của nhau, đọc cùng dữ liệu hoặc hay chạy cùng nhau → gộp thành một agent miền (kết luận sau đó thường là `fold`; cả hai mỏng → fold thẳng cặp) |
| `as-tool` | Có lý do context (1–3) và việc gói được trong một lời gọi trả kết quả có cấu trúc → agent chính gọi như tool, giữ hội thoại |
| `keep` | Phải tự trao đổi nhiều lượt với người dùng, hoặc do bên ngoài kiểm soát (công ty khác, hợp đồng, cơ quan quản lý) — hiếm |

## Checklist

- [ ] `AI-AGENTIC-001` **MUST@L** Mỗi thay đổi kiến trúc agent — đổi pattern (lời gọi đơn ↔ workflow ↔ agent) hay thêm/bớt agent, context (tách, gộp, gọi như tool, gộp thành skill + tool) — chấm trên **cùng một bộ eval end-to-end** trước và sau, mỗi task chạy > 1 lần (k theo `AI-AGENTIC-010` khi báo tin cậy; ≥ 3 khi lấy ngưỡng cổng CI — [`AI-EVAL-018`](evaluation.md)), so **từng task đổi kết quả** chứ không chỉ điểm tổng; giữ agent con khi bản gộp điểm kém hơn hoặc kết luận kiểm kê là `as-tool`/`keep` (`AI-AGENTIC-011`); ghi ADR kèm số và giả định thế hệ model. → Kiểm: ADR có bảng trước/sau trên cùng eval (n, số lần chạy, kết quả theo từng ca, ca lật); chưa có eval → dựng eval nhỏ (~10 ca) trước, không đổi kiến trúc trong cùng PR; hệ chưa có agent con không phải so hai kiến trúc. · Nguồn: Anthropic *Building effective agents*; claude.com *When to fold subagents into your main agent loop* §Task-completion evals, §Folding subagents (2026-10-22); kit `anthropics/single-agent-loop-kit` README ("It measures."; "You have no subagents yet. Start with one loop")
- [ ] `AI-AGENTIC-002` **MUST@L** Workflow nhiều bước có tác dụng phụ chạy trên runtime thực thi bền với checkpoint mỗi bước; tiến trình chết → tiếp tục, không chạy lại bước đã xong. → Kiểm: test kill worker giữa chừng → workflow hoàn tất với đúng 1 lần mỗi tác dụng phụ.
- [ ] `AI-AGENTIC-020` **MUST@L** Agent chạy trên runtime thực thi bền (bảng trên: Temporal, Restate, DBOS, Absurd; LangGraph khi bọc từng đơn vị I/O trong task để resume bỏ qua phần đã xong, tác dụng phụ qua task/outbox theo `AI-AGENTIC-003`) thoả tiêu chí: mọi tool có I/O (gọi model, HTTP, DB, file, đồng hồ, ngẫu nhiên) có kết quả được ghi nhớ theo activity/step idempotent khoá theo (`workflow_id`, `step_id`), không gọi trần ngoài đơn vị đó (vỡ replay: tác dụng phụ chạy lại hoặc lịch sử không khớp); kill worker giữa chừng: `AI-AGENTIC-002`. → Kiểm: test replay lịch sử đã ghi (Temporal `Replayer`/`replay_workflow`, hoặc chạy lại từ checkpoint) không lỗi non-determinism; lint tĩnh chặn lời gọi I/O (httpx/requests/open/datetime.now/random) nằm ngoài activity/step (cả step inline kiểu `ctx.step`, không chỉ theo module). · Nguồn: https://github.com/temporalio/ai-integrations, https://docs.temporal.io/workflow-definition, https://docs.temporal.io/develop/python/testing-suite, https://earendil-works.github.io/absurd/concepts/ (tra 2026-11-04)
- [ ] `AI-AGENTIC-021` **SHOULD** Workflow có external side effect (journal bền không nguyên tử với dịch vụ ngoài) có test chủ đích lỗi sau khi dịch vụ ngoài đã commit nhưng trước khi kết quả activity/step được persist; khoá idempotency: [`ARC-INT-002`](../05-architecture/integration-patterns.md)/`ARC-INT-011`, receipt và reconcile: `AI-AGENTIC-004`. Delta của mục: khai tổng deadline, retry cap/backoff, heartbeat/cancellation, retention/version của journal; báo rõ bảo đảm phụ thuộc API đích — checkpoint không tự bảo đảm effect đúng một lần. → Kiểm: test mất response ở cửa sổ này, replay/restart không tạo giao dịch thứ hai; config có các tham số trên. · Nguồn: https://earendil-works.github.io/absurd/concepts/ (tra 2026-11-04)
- [ ] `AI-AGENTIC-003` **MUST** Tác dụng phụ ra ngoài (gửi, thanh toán, gọi API ghi) đi qua outbox trong cùng giao dịch với trạng thái; worker gửi có lease và fencing token; không gửi trực tiếp từ bước model. → Kiểm: test hai worker tranh một outbox row → 1 lần gửi; xem [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md). · Nguồn: stored 23 §7.1
- [ ] `AI-AGENTIC-004` **MUST@L** Kết quả `outcome_unknown` (timeout, mất kết nối sau khi gửi) được reconcile bằng đọc lại từ hệ đích (receipt read-back) trước khi retry; không retry mù. → Kiểm: test timeout sau gửi → không gửi lần hai khi đích đã nhận.
- [ ] `AI-AGENTIC-005` **MUST@L** Kill switch ở tầng runtime theo tenant/workflow/toàn hệ thống, hiệu lực ≤ 10 giây, không cần model hợp tác; có runbook. → Kiểm: diễn tập bật kill switch khi workflow đang chạy → mọi bước mới bị từ chối trong ≤ 10 s. · Nguồn: `research/2026-10-13-ai-agent-research.md` §2
- [ ] `AI-AGENTIC-006` **MUST** Ngân sách 5 chiều (token, tiền, thời gian, số bước, số agent con) khai cho mỗi workflow/tenant; vượt → dừng trạng thái `budget_exceeded`, có cảnh báo ở 80%. → Kiểm: config; test vượt từng chiều.
- [ ] `AI-AGENTIC-007` **MUST** Agent con nhận quyền/tool/ngân sách ⊆ cha; độ sâu lồng khuyến nghị 2, trần cứng 3 (sâu hơn 2 phải ghi ADR); đồng thời ≤ 8; dữ liệu con trả về là untrusted. Phạm vi: agent **trong sản phẩm** — không áp cho vòng lặp phát triển (ở đó subagent không lồng, [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md)). → Kiểm: test con yêu cầu scope ngoài cha → từ chối; test depth 4 → từ chối; cấu hình `max_depth` ≤ 3 (> 2 có ADR). · Nguồn: `research/2026-10-13-ai-agent-research.md` §2.3
- [ ] `AI-AGENTIC-008` **MUST** Hành động T3–T4 (đối ngoại, tiền, không đảo ngược) qua HITL `waiting_approval`; timeout huỷ; người duyệt có đủ ngữ cảnh (xem trước). → Kiểm: test timeout; log `approved_by`. · Nguồn: [`agents-and-tools.md`](agents-and-tools.md)
- [ ] `AI-AGENTIC-009` **MUST@L** Mỗi workflow có `trace_id` xuyên suốt agent, tool, outbox; tái hiện được chuỗi quyết định từ log. → Kiểm: chọn ngẫu nhiên 1 workflow production, tái dựng được từ trace. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-AGENTIC-010` **MUST@L** Chỉ số tin cậy báo cáo bằng pass^k (k ≥ 3) trên bộ eval end-to-end, không chỉ pass@k. → Kiểm: báo cáo eval có cột pass^k. · Nguồn: Anthropic *Demystifying evals for AI agents*
- [ ] `AI-AGENTIC-011` **SHOULD** Tách thêm agent con/context chỉ khi có **một trong ba lý do context**: (1) một vòng lặp suy giảm **đo được** vì context phình (hỏi trước: tool trả ít hơn được không?); (2) nhiều việc song song cần context mới, vứt được khi xong, hoặc một bên kiểm việc bên kia mà không thấy cách làm; (3) chọn sai tool hay chỉ thị mâu thuẫn mà skill + nạp tool theo nhu cầu không sửa được. **Không** tách vì đội sở hữu, loại vấn đề, giọng riêng, prompt dài, nhiều tool hay bước cố định (bước cố định là code trong tool). Việc tuần tự hẹp: một agent + skill/tool; ước tính chi phí ~15× trước khi chọn đa agent. → Kiểm: bảng kiểm kê agent con (trong ADR hoặc file riêng; cột theo mẫu kit: `agent · owner · context_read · traffic · chains_with · verdict · evidence`), mỗi agent con một dòng: lý do 1/2/3 + số đo (token/lần gọi — gợi ý thô của kit: hàng chục nghìn thì có, vài nghìn thì không · nhánh song song · tỉ lệ chọn sai tool theo eval [`AI-AGENT-014`](agents-and-tools.md)) · kết luận `main`/`fold`/`merge:<agent>`/`as-tool`/`keep` · chủ sở hữu; không có lý do → `fold`. · Nguồn: Anthropic *multi-agent research system*; claude.com *When to fold subagents* (3 điều kiện; Conway; 2026-10-22); kit `skill/steps/00-audit.md` ("earned its own context", "As a rough guide")
- [ ] `AI-AGENTIC-012` **SHOULD** Mỗi bước có `step_id` idempotent; bước gọi model lưu input/output để replay trong eval mà không gọi lại model. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-AGENTIC-013` **SHOULD** Có chế độ "dry-run": chạy toàn workflow với outbox tắt gửi, để kiểm kế hoạch hành động trước khi bật thật cho tenant mới.
- [ ] `AI-AGENTIC-014` **SHOULD** Trạng thái workflow hiển thị cho người (bước hiện tại, đang chờ ai, ngân sách còn) theo [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md).
- [ ] `AI-AGENTIC-015` **SHOULD** Phát hiện lặp ở mức workflow (cùng bước + cùng input k = 3) và drift (bước không tiến tới tiêu chí) → dừng có lý do.
- [ ] `AI-AGENTIC-016` **SHOULD** Diễn tập sự cố agentic (runaway chi phí, outbox kẹt, nhà cung cấp lỗi) ít nhất mỗi quý theo [`../15-operations/incident-response.md`](../15-operations/incident-response.md).
- [ ] `AI-AGENTIC-017` **MAY** Kiến trúc agent-to-agent qua A2A chỉ khi cần liên tổ chức; nội bộ dùng gọi hàm/queue đơn giản hơn. · Nguồn: [`protocols-mcp-a2a.md`](protocols-mcp-a2a.md)
- [ ] `AI-AGENTIC-018` **MAY** Mô phỏng (simulation) với tenant giả và dữ liệu tổng hợp trước khi bật tự trị mức cao cho tenant thật.
- [ ] `AI-AGENTIC-019` **SHOULD** Gộp agent con đang có vào một vòng lặp theo bước nhỏ, đảo ngược được, mỗi bước một thay đổi: eval end-to-end nhỏ trước lần gộp đầu, có ca cho **mỗi chuỗi agent chạy cùng nhau** trong production (mọi cặp `chains_with` của kiểm kê) và mỗi luật không được vi phạm; agent con giữ lại gọi **như tool** — kết quả theo schema ([`AI-APP-003`](llm-app-foundations.md)), agent chính giữ hội thoại và kiểm lại kết luận bằng dữ liệu thật — để có baseline mà không viết lại; bàn giao hẳn (full handoff) chỉ khi agent con phải nói chuyện trực tiếp với người dùng; gộp trước cặp gắn chặt (chuỗi nhau, đọc cùng dữ liệu, hay chạy cùng) và agent con nhiều lưu lượng nhất; gộp (fold) **từng cái một** thành skill + tool, so eval theo `AI-AGENTIC-001`, rồi chạy lại ca của miền đó **không có skill** — điểm bằng nhau thì bỏ skill. Thứ tự giữa các bước chọn theo kiểm kê và ghi lý do trong ADR (kit xếp gộp cặp → fold → as-tool; bài coi as-tool là bước đầu an toàn). Giữ agent con là kết quả chấp nhận được: mục tiêu là hệ có bằng chứng, không phải ít agent nhất. → Kiểm: ADR gộp liệt kê từng bước kèm bảng `ca | baseline | sau | đổi?` (n, số lần chạy); ca đang đạt thành trượt mà ADR không giải thích → không gộp; script của dự án (ý tưởng từ `chain_coverage.py` của kit) đọc cột `chains_with` của kiểm kê và tag ca trong bộ eval, exit 1 khi một cặp không có ca; schema kết quả agent con có trong repo. · Nguồn: claude.com *When to fold subagents* §How to fold subagents (2026-10-22); kit `skill/steps/02-merge.md`, `03-fold.md`, `04-as-tool.md`, `skill/scripts/chain_coverage.py` (c437962, 2026-10-21 — bước merge và vế không-skill chưa chạy trên model thật trong kit)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Đổi kiến trúc không có eval so sánh (tự trị ngay, hay thêm agent con "cho chắc") | Không biết đổi có hơn; ca lật từ đạt sang trượt không ai thấy | Cùng eval end-to-end trước/sau, so từng ca (`AI-AGENTIC-001`) |
| Một agent con mỗi đội/loại vấn đề (sơ đồ tổ chức) | Handoff mất thông tin, độ trễ cộng dồn, prompt chắp vá mỗi đội một câu | Tách chỉ vì 3 lý do context (`AI-AGENTIC-011`); đội góp skill/tool + eval, không góp agent |
| Bỏ agent con vì tin "một agent luôn thắng" | Phá quy trình đang đạt mà điểm tổng không lộ | So từng ca, chạy > 1 lần; giữ khi bản gộp kém hơn (`AI-AGENTIC-019`) |
| Gửi email/thanh toán ngay trong bước model | Gửi 2 lần khi retry, không reconcile | Outbox + lease + fencing |
| Retry mù khi timeout | Trùng tác dụng phụ | Receipt read-back |
| Kill switch là "prompt bảo dừng" | Không dừng khi model lệch | Runtime chặn bước mới |
| Agent con tự cấp thêm tool | Vượt quyền | Scopes ⊆ cha ở code |
| Báo pass@k | Hệ 90% mỗi lần → thất vọng khi dùng lặp | pass^k |
| Checkpoint graph nhưng không outbox | Replay graph gửi lại tác dụng phụ | Tách tác dụng phụ qua outbox |
| Tool gọi thẳng trong thân workflow | Replay lỗi non-determinism hoặc gửi trùng | Bọc activity/step idempotent (`AI-AGENTIC-020`) |
| Không có trần agent con | Fan-out mũ | Depth ≤ 3, đồng thời ≤ 8 |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Durable + exactly-once tác dụng phụ | Test kill worker giữa chừng; test 2 worker tranh outbox | CI tích hợp | 1 tác dụng phụ/ý định |
| Kill switch | Diễn tập có đo thời gian | Hàng quý + trước release | ≤ 10 s |
| Ngân sách | Test vượt từng chiều | CI | Dừng `budget_exceeded` |
| Ủy quyền | Test scope/depth vượt | CI | Từ chối |
| pass^k | Bộ eval end-to-end, k ≥ 3 | CI đêm | Không giảm quá ngưỡng baseline |
| Trace xuyên suốt | Kiểm `trace_id` có ở agent/tool/outbox | CI | 100% span có `trace_id` |
| Đổi kiến trúc agent | Cùng bộ eval end-to-end trước/sau, > 1 lần/task, liệt kê ca lật; script kiểm mỗi cặp `chains_with` có ca (exit 1 khi thiếu) | Trước khi merge PR đổi topology | 0 ca lật đạt → trượt chưa giải thích; script chuỗi exit 0 |

## Nguồn

- Anthropic, *Building effective agents* (5 pattern — giữ làm từ vựng; thứ tự "workflow trước, agent sau" thay bởi ADR-0045): <https://www.anthropic.com/engineering/building-effective-agents> · *How we built our multi-agent research system* (~15× token): <https://www.anthropic.com/engineering/multi-agent-research-system> · *Demystifying evals for AI agents* (pass@k vs pass^k): <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §2, §3, §6).
- PyPI: `temporalio` 1.34.0 (2026-09-30) <https://pypi.org/project/temporalio/> · `dbos` 3.2.0 (2026-09-29) <https://pypi.org/project/dbos/> — xác minh 2026-10-13. Restate v1.7.13 (2026-10-01): <https://github.com/restatedev/restate/releases> — xác minh 2026-10-13 (trang release).
- LangGraph persistence/checkpointer: <https://langchain-ai.github.io/langgraph/concepts/persistence/> — xác minh 2026-10-13.
- `research/2026-10-13-ai-agent-research.md` §2 (handoff schema depth ≤ 3, đồng thời ≤ 8, scopes ⊆ cha, `trust_level: untrusted`; ngân sách 5 chiều; kill switch ≤ 10 s; HITL timeout huỷ) — tổng hợp 2026-10-13.
- `seeker19110/stored` mục 23 §7.1 (outbox + lease + fencing, `outcome_unknown` → reconcile, receipt read-back), mục 21 (durable execution, failure modes: runaway 400 lời gọi/5 phút, drift, premature done) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- claude.com, *Building agents: When to fold subagents into your main agent loop* (2026-10-22; một vòng lặp + skill "frequently outperformed" cả một-prompt lẫn router + agent con theo miền — không nói "luôn"; 3 điều kiện giữ agent con; gọi như tool → baseline; gộp cặp gắn chặt; fold từng cái, so từng task, chạy > 1 lần; bằng chứng: so sánh nội bộ, n không nêu): <https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop> — xác minh 2026-10-24 (`research/2026-10-24-single-agent-loop.md`, ADR-0045).
- Anthropic, single-agent-loop-kit (Apache-2.0; "Reference implementation. Not maintained"; kết luận `main/fold/merge/as-tool/keep`, "earned its own context", `compare.py`/`chain_coverage.py`; "Keeping a subagent is a fine outcome"; mới chạy thật 2 lần trên một ví dụ, merge/upkeep chưa chạy): <https://github.com/anthropics/single-agent-loop-kit> — commit `c437962` (2026-10-21), đọc 2026-10-24.
- Nguồn bổ sung AI-AGENTIC-020–021: Temporal và Absurd (repo nay <https://github.com/earendil-works/absurd>) tra 2026-11-04; Restate, DBOS xác minh 2026-10-13 (bảng runtime); LangGraph: <https://docs.langchain.com/oss/python/langgraph/durable-execution> (trang tồn tại; câu 'bọc trong task' theo review PR #436, chưa tự đọc lại — chưa xác minh).
