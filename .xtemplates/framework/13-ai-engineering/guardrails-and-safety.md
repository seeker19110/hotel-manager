---
title: Guardrail runtime, chính sách nội dung, fallback, an toàn người dùng
kind: module
prefix: AI-GUARD
applies_to: [ai-agent, agentic-system, data-ml, api-service, web-app]
updated: 2026-11-05
---

# Guardrail runtime, chính sách nội dung, fallback, an toàn người dùng

> Guardrail là **lớp kiểm ở runtime** trước và sau lời gọi model: hai tầng (từ khoá/luật tất định + model phân loại
> nhỏ), chính sách nội dung viết thành luật kiểm được, PII vào/ra, fail-closed khi tầng kiểm lỗi. Module này là nhà
> của guardrail runtime; mô hình đe doạ và kiểm thử tấn công ở [`../12-security/ai-security.md`](../12-security/ai-security.md);
> nghĩa vụ pháp lý (minh bạch, nhãn nội dung AI) ở [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).

## Nguyên tắc

1. **Hai tầng, tầng một tất định**: từ khoá/regex/allowlist/giới hạn độ dài chạy trước, rẻ, không bao giờ lỗi vì model; tầng hai là model phân loại nhỏ cho ca mờ.
2. **Fail-closed có chủ đích**: tầng kiểm lỗi/timeout → chặn hoặc hạ cấp (trả lời an toàn mặc định), không bỏ qua kiểm. Ngoại lệ phải ghi ADR.
3. **Chính sách là luật kiểm được**: mỗi điều "không được" có cách kiểm (regex, phân loại, schema) và ca test; điều không kiểm được chỉ là mong muốn.
4. **Kiểm cả hai chiều**: input (injection, PII, nội dung cấm) và output (PII rò, nội dung cấm, định dạng, link/lệnh).
5. **Guardrail không thay thiết kế an toàn**: allowlist tool, quyền server, HITL là lớp chính ([`agents-and-tools.md`](agents-and-tools.md)); guardrail là lớp giảm thiểu.
6. **Người dùng biết đang nói với AI và có lối thoát**: nhãn, cách tới người thật, cách báo cáo; chi tiết UX ở [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md).

## Quyết định

### Cấu hình theo mức rủi ro

| Mức | Ví dụ | Input | Output | Fallback khi tầng 2 lỗi |
|---|---|---|---|---|
| Thấp | Gợi ý nội bộ, tóm tắt tài liệu của chính người dùng | Tầng 1 | Tầng 1 + schema | Cho qua với log |
| Trung | Chat hỗ trợ khách, nội dung công khai | Tầng 1 + 2 | Tầng 1 + 2 + PII | Trả lời an toàn mặc định |
| Cao | Y tế, tài chính, pháp lý, trẻ em, hành động có tiền | Tầng 1 + 2 + HITL theo ngữ cảnh | Tầng 1 + 2 + PII + kiểm claim | Chặn, chuyển người |

### Công cụ (xác minh 2026-10-13)

| Nhu cầu | Công cụ | Phiên bản / lưu ý |
|---|---|---|
| Khung guardrail có validator, schema | `guardrails-ai` | 0.11.0 (PyPI 2026-08-14) |
| Luồng hội thoại + rail có cấu hình | `nemoguardrails` | 0.24.1 (PyPI 2026-09-16) |
| Bộ scanner input/output | `llm-guard` | 0.3.16 (PyPI 2025-05-19) — **không có release > 1 năm, coi là stale**, kiểm trước khi dùng |
| PII detect/anonymize | `presidio-analyzer` | 2.2.364 (PyPI 2026-07-22); dự án đã chuyển sang Data Privacy Stack |
| Model phân loại an toàn | Model nhỏ của nhà cung cấp hoặc tự host | Eval riêng với bộ ca cấm + negative control |

### Chính sách nội dung → luật kiểm

| Điều cấm/yêu cầu | Tầng kiểm | Test |
|---|---|---|
| Không lộ số thẻ, CCCD, số điện thoại trong output | Regex (Luhn, pattern VN) + Presidio | Ca có PII → bị che |
| Không tư vấn y tế/pháp lý cụ thể (nếu chính sách) | Phân loại tầng 2 + từ khoá | Bộ ≥ 30 ca |
| Không thực thi chỉ thị trong dữ liệu | Ranh giới dữ liệu + phát hiện mẫu injection | Bộ injection |
| Không link/lệnh ngoài allowlist | Regex URL/lệnh + allowlist | Ca link lạ |
| Phải tiết lộ là AI | Template giao diện | Test UI |

## Checklist

- [ ] `AI-GUARD-001` **MUST** Có tầng kiểm tất định (regex/từ khoá/allowlist/độ dài) cho input và output, chạy trước mọi tầng model. → Kiểm: test ca cấm rõ bị chặn khi tầng model tắt.
- [ ] `AI-GUARD-002` **MUST@L** Tầng kiểm bằng model (phân loại) lỗi/timeout → fail-closed theo mức rủi ro (hạ cấp hoặc chặn), không bỏ qua; ngoại lệ ghi ADR. → Kiểm: test mock tầng 2 ném lỗi → hành vi fallback đúng bảng. · Nguồn: stored 12 §2
- [ ] `AI-GUARD-003` **MUST@L** Chính sách nội dung viết thành bảng điều → tầng kiểm → ca test; mỗi điều có ≥ 5 ca dương và ca negative control. → Kiểm: file chính sách + dataset test tương ứng trong repo.
- [ ] `AI-GUARD-004` **MUST** PII trong input của model được phát hiện và che/băm trước khi vào log/trace/dataset (danh mục cấm ghi log: `BASE-ERR-007`, nhà — góc riêng ở đây là PII nằm trong văn bản tự do); PII trong output được kiểm theo quyền của người nhận. → Kiểm: test log không chứa PII mẫu; xem [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md).
- [ ] `AI-GUARD-005` **MUST** Guardrail chạy ở server; client không thể tắt hay bỏ qua; cấu hình guardrail là cấu hình cổng (đổi phải qua review). → Kiểm: endpoint không có tham số tắt kiểm; thay đổi config có PR.
- [ ] `AI-GUARD-006` **MUST@L** Mọi lần chặn/hạ cấp được log với lý do, luật khớp, trace id (không log nội dung PII thô); có dashboard tỉ lệ chặn. → Kiểm: log mẫu; dashboard tồn tại. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-GUARD-007` **MUST@L** Tính năng AI hướng người dùng có đường tới người thật và cách báo cáo nội dung AI sai/có hại; báo cáo đi vào hàng đợi xử lý có người nhận. Thông báo "đang tương tác với AI" và nhãn nội dung AI: xem [`CMP-AI-003`](../16-compliance-privacy/ai-regulation.md), `CMP-AI-004`. → Kiểm: E2E: nút báo cáo và lối gặp người thật hiện trong UI AI; gửi báo cáo → tạo bản ghi trong hàng đợi.
- [ ] `AI-GUARD-008` **MUST** Mức rủi ro cao (y tế, tài chính, pháp lý, trẻ em, tiền) có HITL hoặc chuyển người cho ca bị phân loại nhạy cảm; không để model "tự xử". → Kiểm: test ca nhạy cảm → trạng thái chuyển người.
- [ ] `AI-GUARD-009` **MUST@L** Bộ test guardrail (cấm, injection, PII, negative) chạy trong CI mỗi khi đổi prompt, model, hay config guardrail. → Kiểm: job CI; xem [`evaluation.md`](evaluation.md).
- [ ] `AI-GUARD-010` **SHOULD** Tầng 2 dùng model phân loại nhỏ chuyên biệt (độ trễ thấp) với eval riêng; không dùng cùng model sinh để tự chấm mình. · Nguồn: stored 12 §2
- [ ] `AI-GUARD-011` **SHOULD** Phản hồi an toàn mặc định (safe completion) được viết sẵn theo ngữ cảnh, có ngôn ngữ của người dùng, không lộ lý do kỹ thuật.
- [ ] `AI-GUARD-012` **SHOULD** Giới hạn tốc độ theo người dùng/tenant và phát hiện lạm dụng (nhiều lần bị chặn liên tiếp → giảm tốc/khoá tạm).
- [ ] `AI-GUARD-013` **SHOULD** Kiểm output có schema (link, lệnh, mã) qua allowlist domain/lệnh trước khi hiển thị hoặc thực thi. · Nguồn: [`agents-and-tools.md`](agents-and-tools.md)
- [ ] `AI-GUARD-014` **SHOULD** Thư viện guardrail được xem là dependency có rủi ro: kiểm ngày release, CVE, giấy phép trước khi dùng (vd `llm-guard` không có release > 1 năm). · Nguồn: [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `AI-GUARD-015` **SHOULD** Đo độ trễ thêm của guardrail (p95) và tỉ lệ chặn sai (false positive) qua mẫu người chấm hàng tháng; FP cao → hiệu chỉnh.
- [ ] `AI-GUARD-016` **MAY** Dùng khung có cấu hình (guardrails-ai/NeMo) khi số luật > 10 hoặc cần luồng hội thoại; dưới đó tự viết tầng 1 + gọi model phân loại đơn giản hơn.
- [ ] `AI-GUARD-017` **MAY** Red-team guardrail định kỳ với bộ tấn công mới; ca lọt → thêm vào tầng 1 nếu tất định hoá được.
- [ ] `AI-GUARD-018` **MUST@L** Tầng kiểm tất định (`AI-GUARD-001`) loại ký tự vô hình khỏi input người dùng, đoạn RAG và kết quả tool trước khi vào context, và khỏi output trước khi hiển thị. Ký tự gỡ: khối Tag U+E0000–U+E007F, surrogate mồ côi, U+200B, U+2060–U+2064, U+FEFF (trừ BOM đầu chuỗi), U+180E (trừ khi nằm giữa hai chữ Mông Cổ U+1820–U+18AF), bidi override/embedding/isolate U+202A–U+202E và U+2066–U+2069; U+200C/U+200D chỉ giữ theo ngữ cảnh CONTEXTJ của RFC 5892 phụ lục A.1/A.2 (sau virama — Sinhala `ශ්` + U+200D + `රී`, Devanagari `क्` + U+200D + `ष`; ZWNJ giữa hai chữ nối Ả Rập/Ba Tư) hoặc trong chuỗi emoji ZWJ của UTS #51 (kể cả emoji kèm U+FE0F trước ZWJ); variation selector U+FE00–U+FE0F và U+E0100–U+E01EF chỉ giữ một cái ngay sau ký tự cơ sở (U+FE0E/U+FE0F sau emoji, U+E0100–U+E01EF sau chữ Hán — IVS), chuỗi selector liên tiếp (kênh giấu dữ liệu) gỡ hết; lặp liên tiếp khác gộp còn một. Lọc lặp tới khi chuỗi không đổi; chỉ giữ đúng ba chuỗi cờ RGI (`gbeng`, `gbsct`, `gbwls` — so khớp nguyên văn cả chuỗi `U+1F3F4 … U+E007F`), mọi chuỗi tag khác kể cả đúng cú pháp emoji đều gỡ; ghi số ký tự bị gỡ vào log guardrail (`AI-GUARD-006`). → Kiểm: unit test: chuỗi chứa chỉ thị mã hoá bằng Tag characters (kể cả lồng để tái hợp sau một lượt lọc) → sau sanitize không còn code point trong danh sách gỡ ngoài ba cờ RGI và ZWJ/ZWNJ hợp lệ; ca âm `U+1F3F4` + tag mã hoá "ignore previous instructions" + `U+E007F` (đúng cú pháp cờ) → bị gỡ; ca dương giữ nguyên: cờ England, `👩` + U+200D + `💻` (ZWJ giữa hai emoji), `❤` + U+FE0F + U+200D + `🔥` (U+FE0F trước ZWJ), từ Ba Tư `می` + U+200C + `خواهم` (ZWNJ), `ශ්` + U+200D + `රී` (ZWJ sau virama), `ᠬᠠᠷ` + U+180E + `ᠠ` (U+180E giữa chữ Mông Cổ), `葛` + U+E0100 (IVS); ca âm thêm: 16 selector U+E0100+ liên tiếp sau một chữ → gỡ hết; log có `stripped_count`. · Nguồn: AWS Security Blog *Defending LLM applications against Unicode character smuggling* (2025-09-30)
- [ ] `AI-GUARD-019` **SHOULD** Tầng kiểm bằng model chấm cả cửa sổ hội thoại (N lượt gần nhất + tóm tắt phiên), không chỉ tin nhắn cuối; bộ test guardrail có ca tấn công nhiều lượt leo thang dần (kiểu Crescendo) mà từng lượt riêng lẻ trông vô hại. → Kiểm: bộ test guardrail có nhãn `multi_turn` (≥ 10 ca, ≥ 3 lượt mỗi ca) chạy trong CI cùng AI-GUARD-009; test đơn vị xác nhận input của classifier gồm các lượt trước; tỉ lệ chặn ca multi_turn báo riêng. · Nguồn: Russinovich và cộng sự, *Crescendo* (USENIX Security 2025, arXiv 2404.01833)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Chỉ có tầng model, không tất định | Model lỗi → không kiểm; chi phí mỗi request | Tầng 1 regex/allowlist |
| Fail-open "để không chặn nhầm khách" | Lúc sự cố là lúc không kiểm | Fail-closed theo mức |
| Chính sách bằng văn xuôi, không test | Không ai biết guardrail có làm việc | Bảng điều → kiểm → ca test |
| Log nguyên văn input để debug | PII vào log | Che trước khi log |
| Dùng model sinh tự chấm | Cùng điểm mù | Model phân loại riêng |
| Thư viện guardrail stale | CVE, không hợp model mới | Kiểm ngày release |
| Client gửi `skip_guardrail=true` | Bỏ qua kiểm | Guardrail chỉ ở server |
| Chặn quá tay, không đo FP | Người dùng bỏ đi | Mẫu người chấm hàng tháng |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Bộ test guardrail | pytest/`deepeval` với dataset cấm/injection/PII/negative | CI | 100% ca cấm bị chặn; negative không bị chặn quá ngưỡng FP |
| Fail-closed | Test mock tầng 2 lỗi | CI | Hành vi đúng bảng mức rủi ro |
| PII trong log | Scanner (Presidio) trên log mẫu | CI/đêm | 0 phát hiện |
| Config guardrail | Review PR + CODEOWNERS | Repo | Bắt buộc review |
| Độ trễ guardrail | p95 trong trace | Vận hành | ≤ ngân sách đã chốt |

## Nguồn

- PyPI: `guardrails-ai` 0.11.0 (2026-08-14) <https://pypi.org/project/guardrails-ai/> · `nemoguardrails` 0.24.1 (2026-09-16) <https://pypi.org/project/nemoguardrails/> · `llm-guard` 0.3.16 (2025-05-19) <https://pypi.org/project/llm-guard/> · `presidio-analyzer` 2.2.364 (2026-07-22) <https://pypi.org/project/presidio-analyzer/> — xác minh 2026-10-13.
- Presidio (Data Privacy Stack: analyzer, anonymizer, image redactor, structured): <https://presidio.dataprivacystack.org/> — xác minh 2026-10-13 (đính chính: tài liệu cũ trỏ microsoft.github.io/presidio đã chuyển hướng).
- NIST AI RMF 1.0 (2023-01-26) và AI 600-1 Generative AI Profile (2024-07-26): <https://www.nist.gov/itl/ai-risk-management-framework> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §5).
- OWASP Top 10 for LLM Applications 2026 (04/08/2026; mã đổi so với 2025 — bảng ở [`../12-security/ai-security.md`](../12-security/ai-security.md)): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14. Agentic Top 10 2026: <https://genai.owasp.org/> — (chưa xác minh — 403 ngày 2026-10-13).
- `seeker19110/stored` mục 12 §2 (hai tầng: từ khoá tất định + model nhỏ; fallback khi model lỗi; fail-closed) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- AWS Security Blog 2025-09-30: khối Tag U+E0000–U+E007F giấu payload; lọc lặp 'until no more changes are made'; gỡ surrogate đứng riêng; gỡ tag có thể làm hỏng cờ England/Scotland/Wales; Bedrock Guardrails chặn ở prompt và response; một lớp trong defense-in-depth (`AI-GUARD-018`): <https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/> — xác minh 2026-10-30.
- Crescendo (Russinovich, Salem, Eldan; USENIX Security 2025): jailbreak nhiều lượt bắt đầu bằng câu hỏi vô hại rồi leo thang dựa trên câu trả lời trước; tỉ lệ thành công cao trên mọi model và tác vụ đã đánh giá (`AI-GUARD-019`): <https://arxiv.org/abs/2404.01833> — xác minh 2026-10-30.
