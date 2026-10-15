---
title: Nền ứng dụng LLM: chọn model, prompt-as-code, structured output, chi phí
kind: module
prefix: AI-APP
applies_to: [ai-agent, agentic-system, data-ml, web-app, mobile-app, desktop-app, static-site, game, monorepo, api-service]
updated: 2026-10-14
---

# Nền ứng dụng LLM: chọn model, prompt-as-code, structured output, chi phí

> Áp cho **mọi tính năng gọi LLM** (tóm tắt, phân loại, trích xuất, chat…) kể cả trong web/mobile app thường. Quy định:
> prompt là mã nguồn có phiên bản và test; đầu ra có schema và được validate; chọn model theo nhiệm vụ có fallback;
> chi phí/token có ngân sách và cache. Mối đe doạ (prompt injection…) ở [`../12-security/ai-security.md`](../12-security/ai-security.md);
> guardrail runtime ở [`guardrails-and-safety.md`](guardrails-and-safety.md).

## Nguyên tắc

1. **Prompt là code**: nằm trong repo, có phiên bản, có golden snapshot, có eval chạy trong CI; đổi prompt = đổi hành vi → PR + eval.
2. **Đầu ra có hợp đồng**: schema (JSON Schema/Pydantic/Zod) + validate lúc chạy; model có thể trả `refusal`, `max_tokens`, JSON hỏng → mọi nhánh đều xử lý.
3. **Chọn model theo nhiệm vụ, không theo thói quen**: tier nhỏ cho phân loại/trích xuất có schema; tier lớn cho suy luận nhiều bước; mỗi lựa chọn có eval chứng minh và fallback cùng hợp đồng.
4. **Đơn giản nhất có thể**: một lời gọi → workflow cố định → agent; chỉ lên bậc khi eval cho thấy bậc dưới không đủ (Anthropic *Building effective agents*).
5. **Chi phí là yêu cầu chức năng**: token budget theo request/tenant/ngày; cache prompt và batch khi phù hợp; đo bằng `usage`, không ước.
6. **Nội dung ngoài là dữ liệu**: tài liệu, web, output tool đưa vào prompt không phải chỉ thị — tách rõ bằng cấu trúc và nói rõ cho model (chi tiết [`../12-security/ai-security.md`](../12-security/ai-security.md)).

## Quyết định

### Cách xây theo độ phức tạp

| Cấp | Dùng khi | Không dùng khi |
|---|---|---|
| Một lời gọi + schema | Phân loại, trích xuất, viết lại, tóm tắt có khuôn | Cần tra cứu ngoài hoặc nhiều bước phụ thuộc |
| Workflow cố định (chain, routing, parallel, orchestrator, evaluator) | Các bước biết trước, cần dự đoán được | Số bước không biết trước |
| Agent (model tự chọn tool/bước) | Việc mở, cần khám phá | Có thể viết thành workflow — xem [`agents-and-tools.md`](agents-and-tools.md) |

### Structured output — chọn công cụ

| Bối cảnh | Chọn | Ghi chú |
|---|---|---|
| API đóng có native structured output | Tính năng native của nhà cung cấp (`strict`/JSON Schema) hoặc `instructor` (1.17.0, PyPI 2026-09-09) | Kiểm `stop_reason` và validate lại dù `strict` |
| Model chạy local/self-host | `outlines` (1.3.3, PyPI 2026-08-06) — ràng buộc ở tầng decoding | Bảo đảm cú pháp, không bảo đảm ngữ nghĩa |
| Hợp đồng kiểu dùng chung nhiều ngôn ngữ | BAML (`baml-py` 0.226.2, PyPI 2026-09-01) | Sinh client đa ngôn ngữ từ một schema |
| TypeScript/Node | Zod + SDK (`ai` 7.0.138, npm) hoặc native của nhà cung cấp | Validate ở server, không chỉ ở client |

### Chọn tier model + fallback

| Nhiệm vụ | Tier | Fallback |
|---|---|---|
| Phân loại/trích xuất có schema, độ trễ thấp, khối lượng lớn | Nhỏ/nhanh | Tier trên cùng schema khi validate thất bại 2 lần |
| Viết/tóm tắt chất lượng, suy luận trung bình | Trung | Tier lớn khi eval dưới ngưỡng |
| Suy luận nhiều bước, code, agent | Lớn | Nhà cung cấp thứ hai qua gateway (chỉ failover khi 401/403/429/quota — [`observability-and-cost.md`](observability-and-cost.md)) |

Mọi fallback phải giữ **cùng schema đầu ra** và được eval riêng; không fallback "im lặng" sang model yếu hơn cho tác vụ nhạy cảm.

### Cache prompt (theo Anthropic API, xác minh 2026-10-13)

Prefix ổn định đứng trước (system, tool, tài liệu), phần biến đổi sau; cache tối thiểu 512 token trên thế hệ model hiện hành;
TTL 5 phút (ghi ×1.25) hoặc 1 giờ (ghi ×2), đọc ×0.1; kiểm hiệu quả qua `usage.cache_read_input_tokens`. Batch API giảm 50% cho việc không cần tức thời.

## Checklist

- [ ] `AI-APP-001` **MUST@L** Prompt lưu trong repo dưới dạng file/hàm có phiên bản (không chuỗi rải trong code), mỗi thay đổi qua PR. → Kiểm: thư mục `prompts/` hoặc module prompt có `git log`; không có prompt hard-code > 2 dòng ngoài đó. · Nguồn: `research/2026-10-13-ai-agent-research.md` §1
- [ ] `AI-APP-002` **MUST@L** Mỗi prompt có golden snapshot và bộ eval tối thiểu chạy trong CI; đổi prompt mà eval giảm quá ngưỡng → PR đỏ. → Kiểm: job CI chạy eval (vd `promptfoo` 0.124.1) và so với baseline; xem [`evaluation.md`](evaluation.md).
- [ ] `AI-APP-003` **MUST** Đầu ra dùng cho logic/giao diện có schema và được validate lúc chạy ở server; JSON hỏng, `refusal`, `max_tokens` đều có nhánh xử lý. → Kiểm: test với response giả cho 3 trường hợp; code đọc `stop_reason`.
- [ ] `AI-APP-004` **MUST@L** Không dùng prefill assistant khi bật structured output native; không tin `strict` thay cho validate ngữ nghĩa (giá trị âm, ngày không hợp lệ…). → Kiểm: review code; test schema với giá trị biên. · Nguồn: Anthropic structured outputs docs
- [ ] `AI-APP-005` **MUST@L** Chọn model theo bảng tier có eval chứng minh; ghi ADR khi chọn model cho tác vụ chính. → Kiểm: `docs/adr/` có ADR chọn model; eval so ≥ 2 tier. · Nguồn: [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `AI-APP-006` **MUST** Mỗi request LLM có `max_tokens` và timeout; mỗi tenant/người dùng có hạn mức token theo ngày; vượt → từ chối rõ ràng, không treo. → Kiểm: config hạn mức; test vượt hạn mức trả lỗi có mã.
- [ ] `AI-APP-007` **MUST** Dữ liệu ngoài đưa vào prompt (tài liệu, web, output tool) được đặt trong phần dữ liệu có ranh giới và bị coi là untrusted; không nối chuỗi thô vào system prompt. → Kiểm: review cấu trúc prompt; test prompt-injection cơ bản theo [`../12-security/ai-security.md`](../12-security/ai-security.md).
- [ ] `AI-APP-008` **MUST** API key của nhà cung cấp chỉ ở server/secret manager; client (web/mobile) gọi qua backend có auth và rate limit. → Kiểm: grep bundle client không chứa key; endpoint proxy có auth. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `AI-APP-009` **MUST@L** Lời gọi có thể lặp lại (retry) phải idempotent ở tầng ứng dụng: retry chỉ trên lỗi tạm (429/5xx/timeout), có backoff và trần số lần. → Kiểm: test retry với mock trả 429 rồi 200; không retry trên 400.
- [ ] `AI-APP-010` **SHOULD** Bắt đầu bằng một lời gọi + schema; chỉ lên workflow/agent khi eval cho thấy không đủ; ghi lý do trong ADR. · Nguồn: Anthropic *Building effective agents*
- [ ] `AI-APP-011` **SHOULD** Bật prompt caching với prefix ổn định; theo dõi `cache_read_input_tokens`/`cache_creation_input_tokens` và tỉ lệ hit theo tuần. · Nguồn: Anthropic prompt caching docs
- [ ] `AI-APP-012` **SHOULD** Việc không cần tức thời (đánh giá hàng loạt, nhãn dữ liệu, báo cáo đêm) đi Batch API hoặc hàng đợi để giảm chi phí và tránh rate limit. · Nguồn: [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)
- [ ] `AI-APP-013` **SHOULD** Stream phản hồi cho giao diện chat; vẫn validate và lưu bản đầy đủ ở server sau khi stream xong. · Nguồn: [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md)
- [ ] `AI-APP-014` **SHOULD** Nhiều tool call độc lập được trả kết quả trong cùng một message; tool khai idempotent khi có thể để model được phép gọi song song. · Nguồn: Anthropic tool use docs
- [ ] `AI-APP-015` **SHOULD** Có bộ "prompt lint": kiểm độ dài, biến chưa điền, ví dụ few-shot lỗi thời, trước khi deploy.
- [ ] `AI-APP-016` **SHOULD** Phiên bản model được ghim theo ID có ngày/snapshot; nâng phiên bản qua eval và ADR, không dùng alias trôi trong production.
- [ ] `AI-APP-017` **MAY** Dùng tính năng nén/compaction context của nhà cung cấp cho hội thoại dài, kèm eval riêng cho việc mất thông tin.
- [ ] `AI-APP-018` **MAY** Thiết kế fallback đa nhà cung cấp qua gateway (`litellm` 1.105.0, PyPI 2026-10-11) với cùng schema; chỉ khi SLA yêu cầu. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Prompt rải trong code, sửa không test | Hồi quy không ai thấy | Prompt-as-code + eval CI |
| Tin `strict` là đủ | JSON đúng cú pháp nhưng sai nghĩa (số âm, enum lạ) | Validate ngữ nghĩa + test biên |
| Không đọc `stop_reason` | Cắt giữa chừng được coi là kết quả | Xử lý `max_tokens`/`refusal` |
| Dùng tier lớn cho mọi việc | Chi phí ×10, độ trễ cao | Bảng tier + eval |
| Fallback im lặng sang model yếu | Chất lượng giảm không ai biết | Log model thực tế; cảnh báo |
| Key API trong app mobile/web | Lộ key, bị lạm dụng | Proxy backend |
| Retry trên 400/validation | Lặp lỗi, tốn tiền | Chỉ retry lỗi tạm |
| Cache prompt với prefix thay đổi mỗi request | 0% hit, trả thêm phí ghi | Prefix ổn định; đo hit |
| Nối tài liệu thô vào system prompt | Prompt injection thành chỉ thị | Ranh giới dữ liệu; untrusted |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Eval prompt | `promptfoo eval` (0.124.1) hoặc `deepeval test run` (4.2.8) với fixture record/replay | CI mỗi PR đổi prompt | Không giảm quá ngưỡng baseline |
| Schema đầu ra | Test unit với response giả (hợp lệ, hỏng, refusal, max_tokens) | CI | 4/4 xanh |
| Key không lộ | Secret scan + grep bundle client | CI | 0 phát hiện |
| Hạn mức token | Test tích hợp vượt hạn mức | CI | Trả mã lỗi, không treo |
| Chi phí | Dashboard `usage` theo tenant/ngày | Vận hành | Cảnh báo ở 80% ngân sách |

## Nguồn

- Anthropic API docs — structured outputs (`output_config.format`, `strict`, không prefill, `stop_reason`): <https://docs.claude.com/en/docs/build-with-claude/structured-outputs> · prompt caching (512 token tối thiểu, TTL 5m/1h, giá ghi/đọc, `cache_read_input_tokens`): <https://docs.claude.com/en/docs/build-with-claude/prompt-caching> · Batch API (giảm 50%): <https://docs.claude.com/en/docs/build-with-claude/batch-processing> · tool use (song song, idempotent): <https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §1 [F]).
- Anthropic, *Building effective agents* (2024-12-19): <https://www.anthropic.com/engineering/building-effective-agents> — xác minh 2026-10-13.
- PyPI: `instructor` 1.17.0 (2026-09-09) <https://pypi.org/project/instructor/> · `outlines` 1.3.3 (2026-08-06) <https://pypi.org/project/outlines/> · `baml-py` 0.226.2 (2026-09-01) <https://pypi.org/project/baml-py/> · `litellm` 1.105.0 (2026-10-11) <https://pypi.org/project/litellm/> — xác minh 2026-10-13.
- npm: `promptfoo` 0.124.1 <https://www.npmjs.com/package/promptfoo> · `ai` 7.0.138 <https://www.npmjs.com/package/ai> — xác minh 2026-10-13.
- `seeker19110/stored` mục 02 (structured output: API đóng → instructor/native; local → outlines; đa ngôn ngữ → BAML), mục 10 — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
