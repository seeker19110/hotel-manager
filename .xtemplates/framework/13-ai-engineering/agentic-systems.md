---
title: Hệ agentic: đa agent, durable execution, outbox, ranh giới ủy quyền
kind: module
prefix: AI-AGENTIC
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-10-14
---

# Hệ agentic: đa agent, durable execution, outbox, ranh giới ủy quyền

> Hệ agentic là **sản phẩm** chạy nhiều bước/nhiều agent trong runtime, có tác dụng phụ thật. Module này quy định:
> dùng 5 workflow pattern trước khi tự trị, thực thi bền (durable execution) với checkpoint, outbox + lease + fencing
> cho tác dụng phụ, kill switch, ngân sách nhiều chiều, ranh giới ủy quyền, và đo pass^k. Agent đơn/tool ở
> [`agents-and-tools.md`](agents-and-tools.md); vòng lặp phát triển phần mềm ở [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md).

## Nguyên tắc

1. **Workflow trước, agent sau**: prompt chaining → routing → parallelization → orchestrator-workers → evaluator-optimizer; chỉ tự trị khi eval chứng minh workflow không đủ.
2. **Đa agent là đắt**: ~15× token so với chat đơn; chỉ cho việc rộng (breadth-first), không cho việc tuần tự hẹp.
3. **Trạng thái sống ngoài tiến trình**: mỗi bước là checkpoint; tiến trình chết → tiếp tục từ bước cuối, không chạy lại tác dụng phụ.
4. **Tác dụng phụ qua outbox**: ý định ghi vào DB cùng giao dịch, worker có lease + fencing token gửi đi; `outcome_unknown` → đọc lại (receipt read-back) trước khi retry.
5. **Ranh giới ủy quyền thu hẹp theo tầng**: agent con nhận ⊆ quyền/ngân sách/tool của cha; depth (khuyến nghị 2, trần 3) và số đồng thời có trần; dữ liệu con trả về là untrusted.
   Phạm vi: áp cho **sản phẩm agentic** của dự án; vòng lặp phát triển bằng agent lập trình dùng luật riêng — subagent không lồng (độ sâu 1), xem [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md).
6. **Dừng được trong ≤ 10 giây**: kill switch theo tenant/workflow/toàn hệ thống ở tầng runtime, không phụ thuộc model.
7. **Tin cậy đo bằng pass^k**: hệ cần đúng mọi lần dùng pass^k, không pass@k.

## Quyết định

### Pattern theo bài toán

| Pattern | Dùng khi | Rủi ro chính |
|---|---|---|
| Prompt chaining | Bước cố định, kiểm giữa chừng | Lỗi tích luỹ — có gate giữa bước |
| Routing | Phân loại rồi chuyên môn hoá | Phân loại sai — eval router riêng |
| Parallelization | Bước độc lập, hoặc bỏ phiếu | Chi phí ×n |
| Orchestrator-workers | Số việc con không biết trước | Điều phối lồng — trần depth |
| Evaluator-optimizer | Có tiêu chí đánh giá rõ | Lặp vô hạn — trần vòng |
| Agent tự trị | Việc mở, có sandbox và HITL | Mọi rủi ro trên — chỉ sau eval |

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
`trust_level: untrusted`, `trace_id`. Số con đồng thời ≤ 8 (thấp hơn khi RAM/rate limit giới hạn).

## Checklist

- [ ] `AI-AGENTIC-001` **MUST@L** Bài toán được thử bằng workflow pattern (chaining/routing/parallel/orchestrator/evaluator) trước; chuyển sang agent tự trị chỉ khi eval cho thấy workflow không đủ, ghi ADR. → Kiểm: ADR có kết quả eval so sánh; xem [`evaluation.md`](evaluation.md). · Nguồn: Anthropic *Building effective agents*
- [ ] `AI-AGENTIC-002` **MUST@L** Workflow nhiều bước có tác dụng phụ chạy trên runtime thực thi bền với checkpoint mỗi bước; tiến trình chết → tiếp tục, không chạy lại bước đã xong. → Kiểm: test kill worker giữa chừng → workflow hoàn tất với đúng 1 lần mỗi tác dụng phụ.
- [ ] `AI-AGENTIC-003` **MUST** Tác dụng phụ ra ngoài (gửi, thanh toán, gọi API ghi) đi qua outbox trong cùng giao dịch với trạng thái; worker gửi có lease và fencing token; không gửi trực tiếp từ bước model. → Kiểm: test hai worker tranh một outbox row → 1 lần gửi; xem [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md). · Nguồn: stored 23 §7.1
- [ ] `AI-AGENTIC-004` **MUST@L** Kết quả `outcome_unknown` (timeout, mất kết nối sau khi gửi) được reconcile bằng đọc lại từ hệ đích (receipt read-back) trước khi retry; không retry mù. → Kiểm: test timeout sau gửi → không gửi lần hai khi đích đã nhận.
- [ ] `AI-AGENTIC-005` **MUST@L** Kill switch ở tầng runtime theo tenant/workflow/toàn hệ thống, hiệu lực ≤ 10 giây, không cần model hợp tác; có runbook. → Kiểm: diễn tập bật kill switch khi workflow đang chạy → mọi bước mới bị từ chối trong ≤ 10 s. · Nguồn: `research/2026-10-13-ai-agent-research.md` §2
- [ ] `AI-AGENTIC-006` **MUST** Ngân sách 5 chiều (token, tiền, thời gian, số bước, số agent con) khai cho mỗi workflow/tenant; vượt → dừng trạng thái `budget_exceeded`, có cảnh báo ở 80%. → Kiểm: config; test vượt từng chiều.
- [ ] `AI-AGENTIC-007` **MUST** Agent con nhận quyền/tool/ngân sách ⊆ cha; độ sâu lồng khuyến nghị 2, trần cứng 3 (sâu hơn 2 phải ghi ADR); đồng thời ≤ 8; dữ liệu con trả về là untrusted. Phạm vi: agent **trong sản phẩm** — không áp cho vòng lặp phát triển (ở đó subagent không lồng, [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md)). → Kiểm: test con yêu cầu scope ngoài cha → từ chối; test depth 4 → từ chối; cấu hình `max_depth` ≤ 3 (> 2 có ADR). · Nguồn: `research/2026-10-13-ai-agent-research.md` §2.3
- [ ] `AI-AGENTIC-008` **MUST** Hành động T3–T4 (đối ngoại, tiền, không đảo ngược) qua HITL `waiting_approval`; timeout huỷ; người duyệt có đủ ngữ cảnh (xem trước). → Kiểm: test timeout; log `approved_by`. · Nguồn: [`agents-and-tools.md`](agents-and-tools.md)
- [ ] `AI-AGENTIC-009` **MUST@L** Mỗi workflow có `trace_id` xuyên suốt agent, tool, outbox; tái hiện được chuỗi quyết định từ log. → Kiểm: chọn ngẫu nhiên 1 workflow production, tái dựng được từ trace. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-AGENTIC-010` **MUST@L** Chỉ số tin cậy báo cáo bằng pass^k (k ≥ 3) trên bộ eval end-to-end, không chỉ pass@k. → Kiểm: báo cáo eval có cột pass^k. · Nguồn: Anthropic *Demystifying evals for AI agents*
- [ ] `AI-AGENTIC-011` **SHOULD** Đa agent chỉ cho việc rộng (nhiều nhánh độc lập); việc tuần tự hẹp dùng một agent + workflow. Ước tính chi phí ~15× trước khi chọn. · Nguồn: Anthropic *multi-agent research system*
- [ ] `AI-AGENTIC-012` **SHOULD** Mỗi bước có `step_id` idempotent; bước gọi model lưu input/output để replay trong eval mà không gọi lại model. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-AGENTIC-013` **SHOULD** Có chế độ "dry-run": chạy toàn workflow với outbox tắt gửi, để kiểm kế hoạch hành động trước khi bật thật cho tenant mới.
- [ ] `AI-AGENTIC-014` **SHOULD** Trạng thái workflow hiển thị cho người (bước hiện tại, đang chờ ai, ngân sách còn) theo [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md).
- [ ] `AI-AGENTIC-015` **SHOULD** Phát hiện lặp ở mức workflow (cùng bước + cùng input k = 3) và drift (bước không tiến tới tiêu chí) → dừng có lý do.
- [ ] `AI-AGENTIC-016` **SHOULD** Diễn tập sự cố agentic (runaway chi phí, outbox kẹt, nhà cung cấp lỗi) ít nhất mỗi quý theo [`../15-operations/incident-response.md`](../15-operations/incident-response.md).
- [ ] `AI-AGENTIC-017` **MAY** Kiến trúc agent-to-agent qua A2A chỉ khi cần liên tổ chức; nội bộ dùng gọi hàm/queue đơn giản hơn. · Nguồn: [`protocols-mcp-a2a.md`](protocols-mcp-a2a.md)
- [ ] `AI-AGENTIC-018` **MAY** Mô phỏng (simulation) với tenant giả và dữ liệu tổng hợp trước khi bật tự trị mức cao cho tenant thật.

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Agent tự trị ngay từ đầu | Không dự đoán được, khó eval | Workflow pattern trước |
| Gửi email/thanh toán ngay trong bước model | Gửi 2 lần khi retry, không reconcile | Outbox + lease + fencing |
| Retry mù khi timeout | Trùng tác dụng phụ | Receipt read-back |
| Kill switch là "prompt bảo dừng" | Không dừng khi model lệch | Runtime chặn bước mới |
| Agent con tự cấp thêm tool | Vượt quyền | Scopes ⊆ cha ở code |
| Báo pass@k | Hệ 90% mỗi lần → thất vọng khi dùng lặp | pass^k |
| Checkpoint graph nhưng không outbox | Replay graph gửi lại tác dụng phụ | Tách tác dụng phụ qua outbox |
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

## Nguồn

- Anthropic, *Building effective agents* (5 pattern): <https://www.anthropic.com/engineering/building-effective-agents> · *How we built our multi-agent research system* (~15× token): <https://www.anthropic.com/engineering/multi-agent-research-system> · *Demystifying evals for AI agents* (pass@k vs pass^k): <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §2, §3, §6).
- PyPI: `temporalio` 1.34.0 (2026-09-30) <https://pypi.org/project/temporalio/> · `dbos` 3.2.0 (2026-09-29) <https://pypi.org/project/dbos/> — xác minh 2026-10-13. Restate v1.7.13 (2026-10-01): <https://github.com/restatedev/restate/releases> — xác minh 2026-10-13 (trang release).
- LangGraph persistence/checkpointer: <https://langchain-ai.github.io/langgraph/concepts/persistence/> — xác minh 2026-10-13.
- `research/2026-10-13-ai-agent-research.md` §2 (handoff schema depth ≤ 3, đồng thời ≤ 8, scopes ⊆ cha, `trust_level: untrusted`; ngân sách 5 chiều; kill switch ≤ 10 s; HITL timeout huỷ) — tổng hợp 2026-10-13.
- `seeker19110/stored` mục 23 §7.1 (outbox + lease + fencing, `outcome_unknown` → reconcile, receipt read-back), mục 21 (durable execution, failure modes: runaway 400 lời gọi/5 phút, drift, premature done) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
