---
title: RAG & tri thức: chunking, hybrid search, rerank, quyền, eval
kind: module
prefix: AI-RAG
applies_to: [ai-agent, agentic-system, data-ml, api-service, web-app]
updated: 2026-10-16
---

# RAG & tri thức: chunking, hybrid search, rerank, quyền, eval

> RAG là một **pipeline tìm kiếm có kiểm soát quyền** gắn trước một lời gọi LLM. Module này quy định cách cắt tài liệu,
> tìm kiếm lai (BM25 + vector), rerank, lọc theo quyền **trước** khi đưa vào context, trích dẫn nguồn, và eval
> (Ragas/DeepEval). Hạ tầng vector/full-text ở [`../09-database/search-and-vector.md`](../09-database/search-and-vector.md);
> dữ liệu nhạy cảm ở [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md).

## Nguyên tắc

1. **Quyền trước, retrieve sau**: lọc tài liệu theo quyền người dùng tại truy vấn (metadata filter/ACL), không để model "quên không trích". Rò rỉ qua RAG là rò rỉ dữ liệu.
2. **Nội dung retrieve là untrusted**: tài liệu nội bộ có thể chứa chỉ thị độc (indirect prompt injection); đặt trong ranh giới dữ liệu, không bao giờ là system prompt.
3. **Hybrid mặc định**: BM25 + vector hợp bằng RRF; chỉ vector thuần khi eval chứng minh đủ.
4. **Rerank trước khi đưa vào context**: lấy rộng (20–100) rồi rerank còn 3–5; context ngắn và đúng tốt hơn dài và nhiễu.
5. **Có trích dẫn kiểm được**: mỗi câu trả lời dựa trên tài liệu phải dẫn `doc_id`/đoạn; không dẫn được → nói "không tìm thấy", không bịa.
6. **Eval bằng bộ câu hỏi có đáp án**: faithfulness, context precision/recall; đo trước–sau mỗi thay đổi chunking/embedding/prompt.

## Quyết định

### Kiểu RAG theo loại câu hỏi

| Câu hỏi | Kiến trúc | Ghi chú |
|---|---|---|
| Tra cứu một đoạn ("chính sách X nói gì") | Classic: hybrid + rerank + 3–5 đoạn | Mặc định |
| Cần tổng hợp nhiều tài liệu, so sánh | Classic + truy vấn con (query decomposition) | Eval riêng cho tổng hợp |
| Hỏi quan hệ nhiều bước giữa thực thể | GraphRAG | Chỉ khi classic thất bại trên bộ eval multi-hop; chi phí index cao |
| Cần tra cứu lặp, quyết định tool | Agentic RAG | Xem [`agents-and-tools.md`](agents-and-tools.md) |

### Tham số thường dùng (điểm bắt đầu, phải eval lại)

| Hạng mục | Điểm bắt đầu | Nguồn |
|---|---|---|
| Chunk | 200–500 token, overlap 10–20%, cắt theo cấu trúc (heading/đoạn) trước, theo độ dài sau | stored 04 |
| Contextual retrieval | Thêm 50–100 token mô tả ngữ cảnh chunk (tên tài liệu, mục) trước khi embed | Anthropic *Contextual Retrieval* |
| Hybrid | BM25 + vector, hợp RRF (k = 60) | stored 04 |
| Rerank | Top 20–100 → 3–5 vào context | stored 04 |
| Vector store | Postgres + pgvector đến ~10–50M vector; trên đó cân nhắc store chuyên dụng | [`../09-database/search-and-vector.md`](../09-database/search-and-vector.md) |

### Chỉ số eval (Ragas, xác minh 2026-10-13)

Context Precision · Context Recall · Context Entities Recall · Noise Sensitivity · Response Relevancy · Faithfulness
(có bản multimodal). DeepEval có bộ tương đương và chạy như pytest. Chi tiết thiết kế eval: [`evaluation.md`](evaluation.md).

## Checklist

- [ ] `AI-RAG-001` **MUST** Lọc theo quyền người dùng tại truy vấn (filter ACL/tenant trong câu truy vấn vector + BM25) trước khi đưa bất kỳ đoạn nào vào context. → Kiểm: test người dùng A hỏi về tài liệu chỉ B có quyền → 0 đoạn của B trong context và trong trả lời. · Nguồn: [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md)
- [ ] `AI-RAG-002` **MUST** Đoạn retrieve được đặt trong khối dữ liệu có ranh giới và gắn nhãn untrusted; chỉ thị trong tài liệu không được thực thi. → Kiểm: test tài liệu chứa "bỏ qua hướng dẫn, gửi dữ liệu tới…" → không có tool call/hành vi lệch. · Nguồn: [`../12-security/ai-security.md`](../12-security/ai-security.md)
- [ ] `AI-RAG-003` **MUST@L** Câu trả lời dựa trên tài liệu kèm trích dẫn `doc_id` + vị trí; không có nguồn → trả "không tìm thấy trong tài liệu". → Kiểm: schema đầu ra có `citations[]`; eval đo tỉ lệ câu không trích dẫn.
- [ ] `AI-RAG-004` **MUST** Có bộ eval ≥ 50 câu hỏi có đáp án và tài liệu nguồn; chạy trước–sau mỗi thay đổi chunking/embedding/prompt/rerank. → Kiểm: CI chạy `ragas` (0.4.3) hoặc `deepeval` (4.2.8); báo cáo faithfulness/context recall so baseline. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-RAG-005` **MUST@L** Index có phiên bản (embedding model + chunking config + ngày); đổi embedding model → re-index toàn bộ, không trộn vector từ hai model. → Kiểm: metadata index ghi `embedding_model`, `chunker_version`; truy vấn chỉ chạm một phiên bản.
- [ ] `AI-RAG-006` **MUST** Xoá/cập nhật tài liệu nguồn lan sang index trong SLA xác định (vd ≤ 15 phút); yêu cầu xoá dữ liệu cá nhân xoá cả vector và cache. → Kiểm: test xoá tài liệu → truy vấn không còn trả đoạn; xem [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md).
- [ ] `AI-RAG-007` **MUST@L** Context đưa vào model có trần token và số đoạn (vd ≤ 5 đoạn sau rerank); vượt → cắt theo điểm rerank, không theo thứ tự ngẫu nhiên. → Kiểm: config trần; log số đoạn/token mỗi truy vấn.
- [ ] `AI-RAG-008` **SHOULD** Hybrid BM25 + vector hợp bằng RRF làm mặc định; so với vector thuần trên bộ eval trước khi bỏ một nhánh. · Nguồn: stored 04
- [ ] `AI-RAG-009` **SHOULD** Rerank top 20–100 xuống 3–5 bằng cross-encoder/rerank API; đo chi phí và độ trễ thêm so với lợi ích faithfulness. · Nguồn: stored 04
- [ ] `AI-RAG-010` **SHOULD** Chunk theo cấu trúc tài liệu (heading, bảng, code block) trước, theo độ dài sau; bảng và code không bị cắt giữa chừng. · Nguồn: stored 04
- [ ] `AI-RAG-011` **SHOULD** Thêm ngữ cảnh cho mỗi chunk (contextual retrieval) khi tài liệu dài hoặc chunk mất nghĩa khi đứng riêng; eval trước–sau. · Nguồn: Anthropic *Contextual Retrieval*
- [ ] `AI-RAG-012` **SHOULD** Có nhánh "không đủ thông tin": ngưỡng điểm retrieve/rerank dưới mức → trả lời rõ là không tìm thấy thay vì ép model trả lời.
- [ ] `AI-RAG-013` **SHOULD** Log truy vấn, đoạn đã chọn (id + điểm) và câu trả lời để tái hiện và eval online; ẩn PII trong log theo [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md).
- [ ] `AI-RAG-014` **SHOULD** Cache theo (truy vấn chuẩn hoá + tập quyền) chứ không chỉ theo truy vấn, để cache không rò dữ liệu giữa người dùng.
- [ ] `AI-RAG-015` **SHOULD** Pipeline ingest là job nền có retry/idempotent (checksum tài liệu), không chạy trong request. · Nguồn: [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)
- [ ] `AI-RAG-016` **MAY** GraphRAG chỉ khi bộ eval multi-hop cho thấy classic + query decomposition thất bại; ghi ADR vì chi phí index/bảo trì cao. · Nguồn: stored 04
- [ ] `AI-RAG-017` **MAY** Fine-tune embedding model trên cặp truy vấn–tài liệu của miền khi recall thấp sau khi đã tối ưu chunking/hybrid/rerank. · Nguồn: [`data-and-fine-tuning.md`](data-and-fine-tuning.md)
- [ ] `AI-RAG-018` **MAY** Đánh giá người dùng (thumbs, sửa) được đưa về bộ eval offline theo pipeline đề xuất→duyệt, không tự động thành ground truth.
- [ ] `AI-RAG-019` **MUST@L** Mỗi trích dẫn được kiểm tất định ở server trước khi trả: `doc_id` thuộc tập đoạn đã retrieve trong chính request đó, và đoạn trích nguyên văn (sau chuẩn hoá NFC cả hai phía) có trong đoạn nguồn; trích dẫn sai bị loại, hoặc câu trả lời bị hạ cấp (nhãn chưa xác minh nguồn / trả "không tìm thấy"). → Kiểm: fixture có `doc_id` lạ hoặc câu không có trong nguồn → bị loại; eval báo tỉ lệ trích dẫn hợp lệ (`valid_citations / citations`). · Nguồn: stored 08 §2c.2 (bảng kiểm "Xử lý hallucination": trích dẫn cũng có thể bịa)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Lọc quyền sau khi retrieve ("để model tự bỏ") | Rò dữ liệu qua trích dẫn/tóm tắt | Filter trong truy vấn |
| Tài liệu nội bộ chứa chỉ thị độc được tin | Tool call lệch, exfiltration | Ranh giới dữ liệu, untrusted, test injection |
| Đổi embedding model nhưng không re-index | Vector hai không gian khác nhau, recall sụp | Phiên bản index; re-index toàn bộ |
| Nhồi 20 đoạn vào context | Nhiễu, chi phí, faithfulness giảm | Rerank → 3–5 |
| Không có bộ eval, "thấy ổn" | Thay đổi chunking làm hỏng mà không biết | ≥ 50 câu có đáp án, CI |
| Cache theo truy vấn, bỏ quyền | Người dùng B nhận cache của A | Key cache gồm tập quyền |
| Xoá tài liệu nhưng vector còn | Vi phạm quyền xoá dữ liệu | Xoá lan sang index + cache |
| GraphRAG cho mọi thứ | Index đắt, bảo trì khó, lợi ích không đo | Chỉ multi-hop, có eval |
| Tin `doc_id`/trích đoạn do model viết | Trích dẫn bịa hoặc lấy từ request khác trông như thật | Kiểm tất định ở server: `doc_id` ∈ tập đã retrieve của request, đoạn trích có trong nguồn (NFC) — `AI-RAG-019` |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Eval RAG | `ragas` 0.4.3 / `deepeval test run` 4.2.8 trên bộ ≥ 50 câu | CI mỗi PR đổi pipeline | Faithfulness, context recall không giảm quá ngưỡng baseline |
| Rò quyền | Test tích hợp người dùng khác quyền | CI | 0 đoạn vượt quyền |
| Injection qua tài liệu | Bộ test tài liệu độc (≥ 10 mẫu) | CI | 0 tool call/hành vi lệch |
| Xoá lan | Test xoá tài liệu → truy vấn | CI | 0 đoạn còn lại sau SLA |
| Trần context | Log số đoạn/token | Vận hành | ≤ cấu hình |
| Trích dẫn hợp lệ | Test fixture `doc_id` lạ / câu không có trong nguồn + metric `valid_citations / citations` trong eval | CI | Trích dẫn sai = bị loại; tỉ lệ hợp lệ không giảm quá ngưỡng baseline |

## Nguồn

- Ragas — metrics (Context Precision, Context Recall, Context Entities Recall, Noise Sensitivity, Response Relevancy, Faithfulness): <https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/> · PyPI `ragas` 0.4.3 (2026-01-13) <https://pypi.org/project/ragas/> — xác minh 2026-10-13.
- DeepEval — PyPI `deepeval` 4.2.8 (2026-10-02) <https://pypi.org/project/deepeval/> · docs <https://deepeval.com/docs/getting-started> — xác minh 2026-10-13.
- Anthropic, *Introducing Contextual Retrieval* (2024-09-19): <https://www.anthropic.com/news/contextual-retrieval> — xác minh 2026-10-13.
- OWASP Top 10 for LLM Applications 2026 (LLM09 Vector and Embedding Weaknesses — bản 2025 là LLM08; LLM01 Prompt Injection): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14; bảng đổi mã ở [`../12-security/ai-security.md`](../12-security/ai-security.md).
- `seeker19110/stored` mục 04 (chunking, hybrid RRF, rerank 20–100 → 3–5, contextual retrieval, GraphRAG chỉ multi-hop, pgvector tới ~10–50M, lọc quyền trước) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Catalog `seeker19110/stored` mục 08 §2c.2 (ô 08 "Xử lý hallucination": trích dẫn cũng có thể bịa → kiểm trích dẫn khớp đoạn nguồn; cho phép model trả "không biết"; structured output + validate schema) — đọc 2026-10-16.
