---
title: Quan sát & chi phí: trace OTel GenAI, token, gateway, failover
kind: module
prefix: AI-OBS
applies_to: [ai-agent, agentic-system, data-ml, api-service, web-app]
updated: 2026-10-16
---

# Quan sát & chi phí: trace OTel GenAI, token, gateway, failover

> Mọi lời gọi model là một span có token, chi phí, model thực tế, tenant. Module này quy định trace theo OpenTelemetry
> GenAI semantic conventions, đo token/chi phí theo tenant, và luật gateway/failover (chỉ failover khi 401/403/429/quota,
> có cooldown). Nền tảng quan sát chung ở [`../15-operations/observability.md`](../15-operations/observability.md);
> quản trị chi phí hạ tầng ở [`../15-operations/cost-management.md`](../15-operations/cost-management.md).

## Nguyên tắc

1. **Một lời gọi = một span chuẩn**: thuộc tính theo OTel GenAI semconv (`gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`); agent/tool/retrieval cũng là span.
2. **Chi phí tính từ `usage`, không ước**: lưu token vào/ra/cache theo request; nhân giá theo model thực tế đã phục vụ (sau fallback).
3. **Theo tenant và tính năng**: chi phí phải quy về ai dùng và tính năng nào; không có thì không giới hạn được.
4. **Nội dung prompt/response là Opt-In**: mặc định không ghi nội dung vào trace; bật có chủ đích, có che PII, có thời hạn lưu.
5. **Failover chỉ khi đáng**: 401/403/429/quota → chuyển nhà cung cấp; 5xx/timeout → retry có backoff tại chỗ trước; stream chỉ failover trước chunk đầu.
6. **Gateway là điểm kiểm soát, không phải điểm tin cậy**: gateway thêm rate limit, key ảo, log; app vẫn validate output.

## Quyết định

### Span tối thiểu (OTel GenAI semconv, trạng thái Development, xác minh 2026-10-13)

| Operation (`gen_ai.operation.name`) | Khi nào | Thuộc tính bắt buộc |
|---|---|---|
| `chat` / `embeddings` | Mỗi lời gọi model | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.response.model` (model thực tế) |
| `invoke_agent` / `create_agent` | Mỗi lần chạy agent | id agent, `trace_id` xuyên suốt |
| `execute_tool` | Mỗi tool call | tên tool, kết quả (không nội dung PII) |
| `retrieval` | Mỗi lần retrieve | số đoạn, điểm; không nội dung mặc định |
| `invoke_workflow` | Mỗi workflow | trạng thái, ngân sách còn |

Semconv GenAI chưa có release tag (repo `open-telemetry/semantic-conventions-genai`, status Development) → pin phiên bản
instrumentation đang dùng trong ADR và kiểm lại khi nâng.

### Luật gateway/failover

| Tín hiệu | Hành động | Cooldown nhà cung cấp |
|---|---|---|
| 401/403 | Failover ngay; cảnh báo (key hỏng/bị thu hồi) | 300 s (401), 3600 s (403) |
| 429/quota (402) | Failover; tôn trọng `Retry-After` nếu có | 3600 s hoặc theo `Retry-After` (ưu tiên) |
| 5xx/timeout | Retry backoff tại chỗ (trần 2–3); vẫn lỗi → failover | Không đánh dấu nhà cung cấp |
| 400/validation | Không retry, không failover; lỗi app | — |
| Stream đã gửi chunk | Không failover; báo lỗi cho client | — |
| Health | `/health` của gateway trả 503 khi mọi nhà cung cấp cooldown | — |

### Công cụ (xác minh 2026-10-13)

`langfuse` 4.17.0 (PyPI 2026-10-05) — trace, dataset, eval online; `litellm` 1.105.0 (PyPI 2026-10-11) — gateway/proxy
đa nhà cung cấp, key ảo, ngân sách; hoặc OTel SDK + collector + backend sẵn có của tổ chức.

## Checklist

- [ ] `AI-OBS-001` **MUST** Mỗi lời gọi model có span với `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, model phản hồi thực tế, `gen_ai.usage.input_tokens`/`output_tokens` (và token cache nếu có). → Kiểm: trace mẫu trong staging có đủ thuộc tính; test instrumentation. · Nguồn: OTel GenAI semconv
- [ ] `AI-OBS-002` **MUST@L** Chi phí tính từ `usage` × bảng giá theo model thực tế đã phục vụ, lưu theo request với `tenant_id`, `feature`, `trace_id`. → Kiểm: truy vấn chi phí theo tenant/ngày khớp hoá đơn nhà cung cấp ±5%.
- [ ] `AI-OBS-003` **MUST** Ngân sách token/tiền theo tenant và theo tính năng có cảnh báo ở 80% và chặn ở 100% (trả lỗi có mã), cấu hình được. → Kiểm: test vượt hạn mức; dashboard ngân sách. · Nguồn: [`llm-app-foundations.md`](llm-app-foundations.md)
- [ ] `AI-OBS-004` **MUST** Nội dung prompt/response không ghi vào trace/log mặc định; bật Opt-In theo môi trường, có che PII, thời hạn lưu và quyền xem. → Kiểm: config mặc định tắt; log production không chứa prompt thô. · Nguồn: OTel GenAI semconv (content capture Opt-In); [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md)
- [ ] `AI-OBS-005` **MUST@L** Failover sang nhà cung cấp khác chỉ trên 401/403/429/quota (và sau khi retry tại chỗ thất bại với 5xx); không failover trên 400; stream đã gửi chunk không failover. → Kiểm: test bảng tín hiệu → hành động; log model/provider thực tế. · Nguồn: stored 10
- [ ] `AI-OBS-006` **MUST@L** Nhà cung cấp bị lỗi có cooldown (401 → 300 s; 402/403/429 → 3600 s; `Retry-After` ưu tiên) và endpoint `/health` trả 503 khi không còn nhà cung cấp khả dụng. → Kiểm: test cooldown; probe `/health`. · Nguồn: stored 10
- [ ] `AI-OBS-007` **MUST@L** Fallback đổi model/nhà cung cấp được ghi trong span (`gen_ai.response.model` khác request) và có cảnh báo khi tỉ lệ fallback > ngưỡng (vd 5%/giờ). → Kiểm: dashboard tỉ lệ fallback; alert rule.
- [ ] `AI-OBS-008` **MUST@L** `trace_id` xuyên suốt từ request người dùng → agent → tool → outbox → nhà cung cấp (qua `traceparent`/`_meta` với MCP). → Kiểm: chọn 1 request, tái dựng chuỗi span. · Nguồn: [`agentic-systems.md`](agentic-systems.md)
- [ ] `AI-OBS-009` **MUST** Key nhà cung cấp chỉ ở gateway/server; ứng dụng dùng key ảo theo tenant/tính năng có hạn mức, thu hồi được. → Kiểm: không có key gốc ngoài secret manager; thu hồi key ảo có test. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `AI-OBS-010` **SHOULD** Dashboard: token/chi phí theo tenant, tính năng, model; p50/p95 độ trễ; tỉ lệ lỗi theo mã; tỉ lệ cache hit; tỉ lệ guardrail chặn. · Nguồn: [`../15-operations/observability.md`](../15-operations/observability.md)
- [ ] `AI-OBS-011` **SHOULD** SLO riêng cho tính năng AI (vd p95 thời gian tới token đầu, tỉ lệ lỗi) với alert theo [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md).
- [ ] `AI-OBS-012` **SHOULD** Lấy mẫu production (đã che PII) vào dataset eval online; điểm giảm so tuần trước → cảnh báo. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-OBS-013` **SHOULD** Pin phiên bản instrumentation OTel GenAI trong ADR (semconv chưa có release tag); kiểm thuộc tính đổi tên khi nâng. · Nguồn: OTel GenAI semconv repo
- [ ] `AI-OBS-014` **SHOULD** Báo cáo chi phí hàng tháng theo tính năng với đề xuất hạ tier/cache/batch; đo trước–sau khi áp. · Nguồn: [`../15-operations/cost-management.md`](../15-operations/cost-management.md)
- [ ] `AI-OBS-015` **SHOULD** Rate limit theo tenant ở gateway, tách khỏi rate limit của nhà cung cấp; cảnh báo khi một tenant chiếm > X% tổng token.
- [ ] `AI-OBS-016` **MAY** Dùng nền tảng trace LLM chuyên biệt (`langfuse`) khi cần dataset/eval/annotation gắn trace; nếu đã có OTel backend, xuất song song qua OTLP.
- [ ] `AI-OBS-017` **MAY** Đo carbon/điện năng ước tính theo token khi tổ chức có mục tiêu bền vững. · Nguồn: [`../18-cross-cutting/sustainability-and-efficiency.md`](../18-cross-cutting/sustainability-and-efficiency.md)
- [ ] `AI-OBS-018` **SHOULD** (**MUST@L** khi luồng có dữ liệu cá nhân) `docs/ai/data-flows.md` liệt kê **mọi** lời gọi model — sinh, embed, rerank, judge/eval online, fine-tune, lưu artefact (checkpoint, trace, dataset) — kèm endpoint, bên xử lý, loại dữ liệu gửi đi, DPA/điều khoản. Thành phần khai là tự host được kiểm bằng cách khởi động và chạy luồng chính với **egress deny-all**; chức năng cần dịch vụ ngoài phải báo lỗi rõ (mã + tên dịch vụ/biến thiếu), không im lặng treo hay trả rỗng. → Kiểm: job CI mạng chặn (container `--network none` hoặc egress deny-all) chạy smoke luồng chính xanh; endpoint ngoài nào thấy trong log kết nối đều có trong `data-flows.md`. · Nguồn: `seeker19110/stored` 07 (case study Overmind: bản "self-host giữ trace trong mạng" nhưng chấm trace qua OpenRouter, train trên Modal, checkpoint lên S3), 10 §4d.2 (Hindsight chạy không cần key với `LLM_PROVIDER=none`, `reflect` trả 400 rõ ràng); đọc 2026-10-16

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Ước chi phí bằng độ dài chuỗi | Sai 20–40%, không khớp hoá đơn | Dùng `usage` |
| Không ghi model thực tế sau fallback | Chất lượng giảm không ai thấy | `gen_ai.response.model` + alert |
| Failover trên 5xx ngay | Chuyển nhà cung cấp vì lỗi thoáng qua, tốn cooldown | Retry tại chỗ trước |
| Failover giữa stream | Client nhận hai nửa khác nhau | Chỉ trước chunk đầu |
| Ghi nguyên prompt vào trace | PII trong backend trace | Opt-In + che |
| Không có cooldown | Đập vào nhà cung cấp lỗi liên tục | Cooldown theo mã |
| Key gốc trong app | Không thu hồi theo tenant được | Key ảo qua gateway |
| Tin semconv "ổn định" | Thuộc tính đổi tên khi nâng | Pin + ADR |
| Gọi là "self-host" nhưng trace/chấm điểm/checkpoint đi qua dịch vụ ngoài | Dữ liệu cá nhân rời mạng mà không ai biết; cam kết "dữ liệu ở VN/trong mạng" sai | `docs/ai/data-flows.md` + job egress deny-all (`AI-OBS-018`) |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Span có đủ thuộc tính | Test instrumentation với exporter in-memory | CI | 100% lời gọi có 5 thuộc tính tối thiểu |
| Failover/cooldown | Test bảng tín hiệu với mock provider | CI | Đúng bảng |
| Ngân sách | Test vượt hạn mức | CI | Chặn ở 100%, cảnh báo 80% |
| Không nội dung trong log | Scanner trên log staging | CI/đêm | 0 prompt thô |
| Chi phí khớp hoá đơn | Script đối chiếu tháng | Vận hành | ±5% |
| Luồng dữ liệu ra ngoài | Job CI mạng chặn (container `--network none`/egress deny-all) chạy luồng chính | CI | Lỗi không rõ hoặc endpoint ngoài không có trong `data-flows.md` = đỏ |

## Nguồn

- OpenTelemetry GenAI semantic conventions (repo `open-telemetry/semantic-conventions-genai`, status Development, chưa có release tag; thuộc tính `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`; operations chat/embeddings/invoke_agent/create_agent/execute_tool/retrieval/invoke_workflow; content capture Opt-In): <https://github.com/open-telemetry/semantic-conventions-genai> · <https://opentelemetry.io/docs/specs/semconv/gen-ai/> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §7).
- PyPI: `langfuse` 4.17.0 (2026-10-05) <https://pypi.org/project/langfuse/> · `litellm` 1.105.0 (2026-10-11) <https://pypi.org/project/litellm/> — xác minh 2026-10-13.
- `seeker19110/stored` mục 10 (gateway failover chỉ 401/403/429/quota; cooldown 401 → 300 s, 402/403/429 → 3600 s; `Retry-After` thắng; stream chỉ failover trước chunk đầu; `/health` 503) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Anthropic API — `usage` và token cache (`cache_read_input_tokens`): <https://docs.claude.com/en/docs/build-with-claude/prompt-caching> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 07 (Overmind: README "self-hosting keeps traces inside your network" lệch với code — OpenRouter, Modal, S3), 10 §4d.2 (Hindsight chạy không key, lỗi 400 rõ) — đọc 2026-10-16.
