---
title: UX cho tính năng AI: minh bạch, streaming, xác nhận, sửa sai
kind: module
prefix: UX-AI
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo, ai-agent, agentic-system, data-ml]
updated: 2026-10-14
---

# UX cho tính năng AI: minh bạch, streaming, xác nhận, sửa sai

> Giao diện cho tính năng dùng mô hình AI phải **nói rõ đây là AI**, **cho thấy nó đang làm gì** (streaming, trạng thái),
> **thừa nhận không chắc chắn**, **cho người dùng sửa/hoàn tác/dừng**, **xin xác nhận trước hành động có tác dụng phụ**, và
> **thu phản hồi** để cải thiện. Guardrail runtime → [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md);
> kiến trúc agent/HITL → [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md); nghĩa vụ pháp lý →
> [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md); mối đe doạ (prompt injection) →
> [`../12-security/ai-security.md`](../12-security/ai-security.md).

## Nguyên tắc

1. **Không giả vờ là người.** Người dùng biết mình đang tương tác với AI ngay lần đầu; nội dung AI tạo được gắn nhãn
   (EU AI Act Art. 50 — mốc áp dụng ở [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md); P11).
2. **Đặt kỳ vọng đúng** (HAX G1–G2): nói hệ thống làm được gì, tốt đến đâu, không hứa "luôn đúng".
3. **Thấy được tiến trình:** streaming từng phần, trạng thái `submitted → streaming → ready | error`, nút Dừng luôn có.
4. **Người dùng cầm lái** (HAX G7–G9, G17): gọi/tắt dễ, sửa kết quả tại chỗ, hoàn tác, quy về chế độ không AI.
5. **Hành động có tác dụng phụ cần xác nhận trước** (gửi email, thanh toán, xoá, ghi dữ liệu) — hiển thị chính xác điều sẽ làm
   (dry-run) rồi mới làm.
6. **Nội dung AI là dữ liệu, không phải chỉ thị:** link/nút do AI sinh không tự chạy; render qua escape/sanitize như mọi dữ liệu ngoài (P6).
7. **Mỗi kết quả có đường phản hồi** (đúng/sai + lý do) nối vào vòng đánh giá ([`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md)).

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Hình thức AI trong sản phẩm | **Trợ lý trong ngữ cảnh** (gợi ý, hoàn thiện, tóm tắt tại chỗ) | Tác vụ rõ, có dữ liệu ngữ cảnh | Chat tự do khi tác vụ có cấu trúc — chat là giao diện cuối cùng, không phải mặc định |
| Streaming | Có, theo part (text/tool/reasoning/source) với `stop()` | Phản hồi > 1 s | Kết quả rất ngắn, hoặc kết quả có cấu trúc phải validate toàn bộ trước khi hiện (số tiền, lệnh) |
| Mức tự chủ của hành động | Đề xuất → người xác nhận → thực thi (HITL) | Có tác dụng phụ ngoài UI | Tự động hoàn toàn chỉ khi đảo ngược được và có giới hạn (xem agentic-systems) |
| Hiển thị độ không chắc chắn | Nhãn mức tin cậy/nguồn trích dẫn/khoảng giá trị; "không biết" là câu trả lời hợp lệ | Thông tin dùng để ra quyết định | Hiển thị số % tin cậy giả (mô hình không hiệu chuẩn) |
| Thư viện UI chat (web) | Vercel AI SDK 7 `useChat` (ai 7.0.138, MIT) + assistant-ui 0.15.28 (headless) | React/Next | Cần giao thức agent↔UI đa framework → AG-UI (@ag-ui/core 1.0.2); CopilotKit nặng, chỉ khi cần cả nền tảng |
| Nhãn nội dung AI | Nhãn nhìn thấy + metadata máy đọc (trường `generated_by`/manifest C2PA cho media) | Mọi output AI | Chỉ ghi trong điều khoản dịch vụ |

## Checklist

- [ ] `UX-AI-001` **MUST** Người dùng được thông báo rõ đang tương tác với AI tại lần tương tác đầu (và mỗi phiên), bằng chữ nhìn thấy, không chỉ icon. → Kiểm: E2E mở tính năng AI → phần tử `[data-ai-disclosure]` hiển thị text nhãn; axe không vi phạm. · Nguồn: EU AI Act Art. 50(1), 50(5)
- [ ] `UX-AI-002` **MUST** Nội dung do AI tạo (văn bản, ảnh, âm thanh, video) có nhãn nhìn thấy và metadata máy đọc được. → Kiểm: API trả `generated_by: "ai"` + `model_family` (không tên model trong UI người dùng cuối nếu không cần); E2E mỗi message AI có nhãn; media có manifest/tag. · Nguồn: EU AI Act Art. 50(2), 50(4)
- [ ] `UX-AI-003` **MUST@L** Phản hồi dài được stream và có nút **Dừng** hoạt động; trạng thái hiển thị theo `submitted/streaming/ready/error`. → Kiểm: E2E bấm Dừng trong khi streaming → request bị abort (không còn chunk mới), UI về `ready`. · Nguồn: AI SDK `useChat` status/`stop()`
- [ ] `UX-AI-004` **MUST** Hành động có tác dụng phụ (gửi, mua, xoá, ghi, gọi API ngoài) do AI đề xuất phải hiển thị bản xem trước chính xác và chờ người dùng xác nhận; không có "tự động chấp nhận" mặc định. → Kiểm: E2E agent đề xuất gửi email → không có request gửi cho tới khi bấm Xác nhận; config `autoApprove` mặc định false. · Nguồn: [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md) (HITL)
- [ ] `UX-AI-005` **MUST@L** Kết quả AI sửa được tại chỗ (edit) và hoàn tác được; bản gốc người dùng không bị ghi đè không hỏi. → Kiểm: E2E "Viết lại bằng AI" → có Hoàn tác trả về văn bản gốc. · Nguồn: HAX G9
- [ ] `UX-AI-006` **MUST@L** Lỗi/không khả dụng của mô hình có thông điệp rõ và đường đi thay thế (làm tay, thử lại, chế độ không AI); không treo vô hạn. → Kiểm: E2E mock API mô hình 503/timeout → thông báo + nút Thử lại/Làm thủ công; timeout client có giới hạn cấu hình. · Nguồn: HAX G10
- [ ] `UX-AI-007` **MUST** Link, nút, mã, lệnh trong output AI được render như dữ liệu không tin cậy: sanitize HTML, không tự thực thi, link ngoài hiện domain. → Kiểm: test đưa output chứa `<script>`/`javascript:`/markdown link lừa → không chạy, hiển thị domain thật. · Nguồn: [`../12-security/ai-security.md`](../12-security/ai-security.md); [`../07-frontend/client-security.md`](../07-frontend/client-security.md)
- [ ] `UX-AI-008` **MUST@L** Có cơ chế phản hồi trên từng kết quả (ít nhất đúng/sai + ghi chú tuỳ chọn) và phản hồi được lưu kèm id phiên/prompt (không kèm PII thừa). → Kiểm: E2E bấm phản hồi → bản ghi trong bảng `ai_feedback` với `response_id`. · Nguồn: HAX G15
- [ ] `UX-AI-009` **MUST@L** Người dùng xem, xuất và xoá được lịch sử hội thoại/dữ liệu đã gửi cho AI; nêu rõ dữ liệu có dùng để huấn luyện không. → Kiểm: E2E xoá hội thoại → API trả 404 cho id đó; chính sách hiển thị trong màn hình AI. · Nguồn: [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `UX-AI-010` **SHOULD** Giới hạn năng lực được nói trước ("có thể sai, hãy kiểm tra thông tin quan trọng") đặt gần output, không chỉ trong onboarding. → Kiểm: chuỗi cảnh báo xuất hiện trên màn hình kết quả (snapshot). · Nguồn: HAX G1–G2
- [ ] `UX-AI-011` **SHOULD** Khi dựa trên tài liệu/nguồn (RAG), mỗi khẳng định quan trọng có trích dẫn bấm được tới đoạn gốc; "không tìm thấy" là câu trả lời hợp lệ. → Kiểm: E2E hỏi câu ngoài tài liệu → trả lời "không có trong tài liệu" thay vì bịa; message có `sources[]`. · Nguồn: [`../13-ai-engineering/rag-and-knowledge.md`](../13-ai-engineering/rag-and-knowledge.md)
- [ ] `UX-AI-012` **SHOULD** Hiển thị mức tin cậy/phạm vi chỉ khi có cơ sở (đánh giá hiệu chuẩn); nếu không, dùng nhãn định tính + khuyến nghị kiểm tra. → Kiểm: eval ghi calibration; UI không hiển thị % khi chưa có.
- [ ] `UX-AI-013` **SHOULD** Streaming tiếp cận được: vùng kết quả `aria-busy="true"` khi đang stream, công bố một lần khi xong (`role="status"`), không đọc từng token. → Kiểm: E2E kiểm thuộc tính `aria-busy` đổi true→false; axe không vi phạm. · Nguồn: WAI-ARIA APG Alert; [`accessibility.md`](accessibility.md)
- [ ] `UX-AI-014` **SHOULD** Chỉ báo thời gian chờ: hiển thị "đang suy nghĩ/đang tìm" trước token đầu; nếu > 10 s có tiến độ bước (tool đang gọi) và nút Dừng. → Kiểm: E2E throttle → chỉ báo xuất hiện trước chunk đầu. · Nguồn: [`ui-states-and-feedback.md`](ui-states-and-feedback.md)
- [ ] `UX-AI-015` **SHOULD** Tính năng AI tắt được (toàn cục hoặc theo tính năng) và sản phẩm vẫn dùng được khi tắt. → Kiểm: E2E với cờ `ai.enabled=false` → luồng chính vẫn xanh. · Nguồn: HAX G17
- [ ] `UX-AI-016` **SHOULD** Hiển thị chi phí/giới hạn sử dụng (lượt, token, tiền) khi người dùng trả tiền theo mức dùng; cảnh báo trước khi hết. → Kiểm: E2E tài khoản gần hạn mức thấy cảnh báo; không bị chặn đột ngột. · Nguồn: [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md)
- [ ] `UX-AI-017` **SHOULD** Không dark pattern với AI: không tự bật tính năng AI thu dữ liệu, không ẩn nút tắt, không "giả tiến độ" khi mô hình chưa chạy. → Kiểm: checklist dark-pattern trong PR (xem [`content-and-microcopy.md`](content-and-microcopy.md)).
- [ ] `UX-AI-018` **SHOULD** Thay đổi hành vi mô hình (đổi phiên bản, đổi prompt hệ thống) được thông báo cho người dùng khi ảnh hưởng kết quả. → Kiểm: changelog trong sản phẩm có mục AI; test eval trước khi đổi. · Nguồn: HAX G18
- [ ] `UX-AI-019` **MAY** Cho người dùng chỉnh "giọng/độ dài/ngôn ngữ" của output qua tuỳ chọn thay vì phải viết prompt. → Kiểm: tuỳ chọn tồn tại trong UI và được truyền vào request.
- [ ] `UX-AI-020` **MAY** Media AI tạo gắn Content Credentials (C2PA) ngoài nhãn nhìn thấy. → Kiểm: file xuất có manifest đọc được bằng công cụ C2PA (phiên bản SDK **chưa xác minh**).

## Bẫy thường gặp

- **Avatar người thật + tên người** cho bot: vi phạm Art. 50 và mất niềm tin khi lộ. Tên bot + nhãn "Trợ lý AI".
- **Streaming output có cấu trúc** (số tiền, JSON lệnh) hiển thị nửa chừng → người dùng hành động trên dữ liệu chưa validate. Buffer rồi hiện.
- **Nút Dừng chỉ ẩn UI** nhưng request vẫn chạy → tốn tiền, kết quả về muộn ghi đè. Abort thật ở transport.
- **"Tự động áp dụng" gợi ý AI** (ghi đè văn bản, gửi email) → mất dữ liệu/gửi nhầm; luôn xem trước + xác nhận + hoàn tác.
- **Phần trăm tin cậy giả** từ logprob chưa hiệu chuẩn → người dùng tin sai chỗ.
- **Render markdown của AI bằng `dangerouslySetInnerHTML`** không sanitize → XSS qua prompt injection.
- **Chat là mặc định cho mọi thứ**: người dùng không biết hỏi gì; dùng gợi ý/nút tác vụ có cấu trúc trước.
- **Không có đường không AI**: mô hình lỗi là sản phẩm chết. Luôn có fallback thủ công.
- **Phản hồi 👍/👎 không nối vào eval**: thu rồi bỏ. Phản hồi phải thành test case.
- **Thông báo AI chỉ trong Điều khoản dịch vụ**: Art. 50(5) đòi rõ ràng, tại lần tương tác đầu.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Playwright 1.64.0 (Apache-2.0) | E2E: nhãn AI hiện, Dừng abort request, xác nhận trước side-effect, Hoàn tác, mock 503 | CI E2E | xanh |
| MSW 3.0.3 (MIT) mock stream SSE | handler stream + lỗi dùng chung | component/E2E test | mọi trạng thái `submitted/streaming/ready/error` có test |
| Test sanitize output (Vitest 5.0.4 + DOMPurify 3.4.17) | fixture output độc (script, `javascript:`, link giả) | CI unit | 0 node nguy hiểm sau render |
| Contract test API (schema `generated_by`, `sources[]`, `response_id`) | test hợp đồng | CI | trường bắt buộc có mặt |
| `@axe-core/playwright` 4.13.0 | quét màn hình AI khi streaming và khi xong | CI E2E | 0 vi phạm; `aria-busy` đúng |
| Eval harness (xem 13-ai-engineering/evaluation) | chạy bộ phản hồi người dùng thành case | CI nightly | không hồi quy |
| Checklist PR "AI disclosure" (3 mục: nhãn, xác nhận, hoàn tác) | review người | PR tính năng AI | đủ 3 |

## Nguồn

- EU AI Act — Regulation (EU) 2024/1689 Article 50 (minh bạch: chatbot phải cho biết là AI; nội dung tổng hợp đánh dấu máy đọc được; deepfake gắn nhãn; thông tin rõ ràng tại lần tương tác đầu; áp dụng từ 02/08/2026): <https://artificialintelligenceact.eu/article/50/> — xác minh 2026-10-13 (nguồn thứ cấp uy tín; bản eur-lex <https://eur-lex.europa.eu/eli/reg/2024/1689/oj> **không truy cập được nội dung ngày 2026-10-13**). Mốc áp dụng (Art. 50 từ 02/08/2026; đánh dấu Art. 50(2) cho hệ đã lưu hành trước mốc tới 02/12/2026 theo Omnibus 2026/1744): nhà là [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).
- Microsoft HAX Toolkit — 18 Guidelines for Human-AI Interaction (CHI 2019; G1 Make clear what the system can do … G18 Notify users about changes): <https://www.microsoft.com/en-us/haxtoolkit/library/> — xác minh 2026-10-13.
- Vercel AI SDK — `useChat` (status `submitted/streaming/ready/error`, `stop()`, `regenerate()`, message parts): <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot> — xác minh 2026-10-13; phiên bản `ai` 7.0.138 (npm, 2026-10-13).
- AG-UI protocol (sự kiện agent↔UI; `@ag-ui/core` 1.0.2 npm 2026-10-13): <https://docs.ag-ui.com> — theo `research/2026-10-13-ai-agent-research.md` §2.3 (release `release/2026-10-12`; "1.0 spec ổn định" **chưa xác minh trên docs**).
- WAI-ARIA APG Alert (live region, không cướp focus): <https://www.w3.org/WAI/ARIA/apg/patterns/alert/> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): ai 7.0.138 · @assistant-ui/react 0.15.28 · @ag-ui/core 1.0.2 · dompurify 3.4.17 · msw 3.0.3 · @playwright/test 1.64.0 · c2pa 0.30.17 (SDK JS; tính năng ký manifest **chưa xác minh**).
- Google PAIR People + AI Guidebook: <https://pair.withgoogle.com/guidebook/> — **không truy cập được nội dung ngày 2026-10-13**; không trích.
- Catalog `seeker19110/stored` mục 06 §6 (agentic UI: AG-UI, assistant-ui, CopilotKit), đọc 2026-10-13.
