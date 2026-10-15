---
title: Chuẩn AI (ISO/IEC 42001, NIST AI RMF, EU AI Act, OWASP LLM/Agentic, MCP, A2A)
kind: standard
prefix: STD-AI
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-10-14
---

# Chuẩn AI (ISO/IEC 42001, NIST AI RMF, EU AI Act, OWASP LLM/Agentic, MCP, A2A)

> Phiên bản hiện hành của khung quản trị AI, luật, danh sách rủi ro OWASP và giao thức agent; chọn gì theo quy mô và
> thị trường; bằng chứng máy. Mối đe doạ và cách phòng ở [`../12-security/ai-security.md`](../12-security/ai-security.md);
> guardrail runtime ở [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md);
> giao thức kỹ thuật ở [`../13-ai-engineering/protocols-mcp-a2a.md`](../13-ai-engineering/protocols-mcp-a2a.md);
> nghĩa vụ pháp lý chi tiết ở [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).

## Nguyên tắc

- **Phân loại rủi ro trước, chọn chuẩn sau.** EU AI Act xếp hệ thống theo mức (cấm / rủi ro cao / minh bạch / tối thiểu); mức quyết định nghĩa vụ và chuẩn cần ánh xạ.
- **Giao thức agent đổi theo ngày, không theo số.** MCP ghi phiên bản dạng `YYYY-MM-DD` (hiện 2026-07-28); ghim và kiểm phiên bản trong code, không "mới nhất".
- **Danh sách OWASP là nhận thức, eval là bằng chứng.** Ánh xạ LLM/Agentic Top 10 chỉ có giá trị khi mỗi hạng mục có test/eval đỏ-xanh (xem [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md)).
- **Minh bạch là tính năng.** Tiết lộ AI, đánh dấu nội dung tổng hợp, log quyết định — là code có test, không phải điều khoản.
- **Nội dung từ model/tool/web là dữ liệu, không phải chỉ thị** (P6) — áp cho cả mô tả tool MCP và Agent Card A2A.

## Quyết định

| Tình huống | Bắt buộc khai báo | Bổ sung theo quy mô | Không cần |
|---|---|---|---|
| Có LLM trong sản phẩm (mọi quy mô) | OWASP LLM Top 10 2026 ánh xạ; EU AI Act phân loại (nếu người dùng EU) | M: NIST AI RMF 1.0 profile + AI 600-1 (GenAI); L: ISO/IEC 42001:2023 AIMS | ISO 42001 khi S |
| Agent gọi tool / hành động | + OWASP Agentic Top 10 (ASI01–10) | M: eval pass^k cho luồng hành động | — |
| Dùng/phát hành MCP server hoặc client | + MCP spec 2026-07-28 + MCP Top 10 (beta) | M: ghim/diff tool list, sandbox server local | — |
| Agent giao tiếp agent (đa tổ chức) | + A2A 1.0.1 (Agent Card ký, security schemes) | L: mTLS/OIDC giữa agent | — |
| Hệ thống "rủi ro cao" theo Annex III AI Act (tuyển dụng, tín dụng, giáo dục, y tế…) | AI Act Ch. III (áp từ 2027-12-02 cho Annex III) | ISO/IEC 42001 + hồ sơ kỹ thuật, giám sát con người | — |
| Chatbot/tạo nội dung cho người dùng EU | AI Act Art. 50 (minh bạch; áp dụng từ 02/08/2026; riêng đánh dấu máy đọc được Art. 50(2) cho hệ thống đã đưa ra thị trường EU trước 02/08/2026: tới 02/12/2026 — nhà mốc: [`ai-regulation.md`](../16-compliance-privacy/ai-regulation.md)) | — | — |
| Chỉ dùng AI để viết code nội bộ (không có AI trong sản phẩm) | không áp file này; xem [`../11-autonomous-loop/`](../11-autonomous-loop/README.md) | — | — |

Mặc định: **OWASP LLM Top 10 2026 + Agentic Top 10 + phân loại AI Act + NIST AI RMF profile (M+)**; ISO/IEC 42001 chỉ khi L hoặc khách hàng yêu cầu.

## Bảng phiên bản hiện hành (xác minh 2026-10-13)

| Chuẩn / luật | Phiên bản | Phát hành / hiệu lực | URL | Áp dụng khi | Chứng minh tuân thủ |
|---|---|---|---|---|---|
| ISO/IEC 42001 | **2023** (ấn bản 1) | 2023-12-18 (theo IEC webstore — iso.org 403) | <https://www.iso.org/standard/42001> | L, chứng nhận AIMS | SoA AI + hồ sơ rủi ro; **không phải harmonised standard của AI Act** (nguồn thứ cấp) |
| NIST AI RMF | **1.0** (đang sửa đổi theo AI Action Plan) | 2023-01-26 | <https://www.nist.gov/itl/ai-risk-management-framework> | M+ | Profile Govern/Map/Measure/Manage có bảng ánh xạ |
| NIST AI 600-1 Generative AI Profile | bản 1 | 2024-07-26 | <https://www.nist.gov/itl/ai-risk-management-framework> | Có GenAI | Hàng bổ sung trong profile |
| EU AI Act | **Regulation (EU) 2024/1689** | OJ 2024-07-12; hiệu lực 2024-08-01; cấm & AI literacy 2025-02-02; GPAI 2025-08-02; phần còn lại (gồm Art. 50) 2026-08-02; Annex III high-risk 2027-12-02, Annex I 2028-08-02 (Omnibus (EU) 2026/1744) | <https://eur-lex.europa.eu/eli/reg/2024/1689/oj> (eur-lex không trả nội dung ngày 2026-10-13); mốc chi tiết ở nhà [`ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) | Người dùng/thị trường EU | Hồ sơ phân loại rủi ro; Art. 50 test tiết lộ AI/đánh dấu nội dung |
| OWASP Top 10 for LLM Applications | **2026** (mã đổi so với 2025 — bảng ánh xạ ở [`ai-security.md`](../12-security/ai-security.md)) | 2026-08-04 | <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> | Có LLM | Bảng LLM01–10 → biện pháp + eval |
| OWASP Top 10 for Agentic Applications | 2026 (ASI01–ASI10) | 2025-12-09 (theo research 2026-10-13) | <https://genai.owasp.org/> | Agent có tool | Bảng ASI01–10 → biện pháp + eval |
| OWASP MCP Top 10 | MCP01–10:2025, **beta (Phase 3)** | chưa final | <https://owasp.org/www-project-mcp-top-10/> | MCP | Checklist tham khảo, không ghim ID |
| Model Context Protocol | **2026-07-28** (stateless, `server/discover`, MRTR, Tasks extension) | 2026-07-28 | <https://modelcontextprotocol.io/specification/latest> | MCP server/client | Phiên bản khai trong `_meta`; test tool list deterministic |
| A2A Protocol | **1.0.1** (1.0.0 2026-03-12) | 2026-05-26 | <https://a2a-protocol.org/latest/specification/> | Agent ↔ agent | Agent Card hợp lệ, header `A2A-Version` |
| OTel GenAI semantic conventions | trạng thái **Development** (tên attribute có thể đổi) | — | <https://github.com/open-telemetry/semantic-conventions-genai> | Trace LLM/agent | Span `invoke_agent`/`execute_tool`, `gen_ai.usage.*` |

## Checklist

- [ ] `STD-AI-001` **MUST** `PROJECT.md` khai báo chuẩn AI áp dụng kèm phiên bản (vd `OWASP LLM Top 10 2026`, `MCP 2026-07-28`, `AI Act: minimal-risk`). → Kiểm: `grep -E "LLM Top 10 2026|MCP 20[0-9]{2}-[0-9]{2}-[0-9]{2}" PROJECT.md`. · Nguồn: OWASP LLM Top 10 2026; MCP spec
- [ ] `STD-AI-002` **MUST** Có hồ sơ phân loại rủi ro theo EU AI Act (cấm / rủi ro cao Annex I–III / minh bạch Art. 50 / tối thiểu) kèm lý do, kể cả khi kết luận "không thuộc phạm vi". → Kiểm: `docs/compliance/ai-act-classification.md` có trường `risk_class` và `rationale`. · Nguồn: Regulation (EU) 2024/1689 Art. 5, 6, 50
- [ ] `STD-AI-003` **MUST** Người dùng được tiết lộ đang tương tác với AI; nội dung tổng hợp (ảnh/âm thanh/video/văn bản phát hành công khai) được đánh dấu máy đọc được. → Kiểm: E2E assert banner/label AI; test metadata/watermark trên file sinh ra. · Nguồn: AI Act Art. 50(1), 50(2)
- [ ] `STD-AI-004` **MUST@L** Bảng ánh xạ OWASP LLM Top 10 2026 (LLM01–LLM10) → biện pháp → eval/test; mỗi hạng mục có ít nhất một test đỏ-xanh hoặc "không áp dụng + lý do". → Kiểm: `grep -cE "LLM(0[1-9]|10)" docs/compliance/ai-threats.md` ≥ 10 và test suite `ai-threats` chạy trong CI. · Nguồn: OWASP LLM Top 10 2026
- [ ] `STD-AI-005` **MUST@L** Agent gọi tool ánh xạ thêm Agentic Top 10 (ASI01–ASI10) với eval cho ASI01 (goal hijack qua prompt injection) và ASI02 (tool misuse). → Kiểm: eval case gắn nhãn `asi01`, `asi02` trong bộ eval, chạy mỗi lần đổi prompt/tool. · Nguồn: OWASP Agentic Top 10 ASI01, ASI02
- [ ] `STD-AI-006` **MUST@L** MCP: ghim phiên bản giao thức trong code; client lưu snapshot `tools/list` và cảnh báo/chặn khi mô tả hoặc schema tool đổi (chống rug pull). → Kiểm: unit test so snapshot tool list; CI đỏ khi diff chưa được duyệt. · Nguồn: MCP 2026-07-28 (tool list deterministic, description untrusted); MCP Top 10 MCP03 (beta)
- [ ] `STD-AI-007` **MUST@M** Hành động không đảo ngược, tiền, dữ liệu người dùng thật, gửi ra ngoài: có bước duyệt người trước khi agent thực thi. → Kiểm: test mô phỏng tool `delete`/`pay`/`send` không chạy nếu thiếu approval token. · Nguồn: Agentic Top 10 ASI02/ASI03; AI Act Art. 14 (giám sát con người, hệ thống rủi ro cao)
- [ ] `STD-AI-008` **MUST@L** Profile NIST AI RMF 1.0 (+ AI 600-1 khi GenAI): bảng Govern/Map/Measure/Manage → bằng chứng (eval, log, chính sách). → Kiểm: `docs/compliance/ai-rmf-profile.md` mỗi hàng có cột `evidence` trỏ file/CI. · Nguồn: NIST AI RMF 1.0; NIST AI 600-1
- [ ] `STD-AI-009` **MUST@L** Hệ thống quản lý AI theo ISO/IEC 42001:2023: chính sách AI, đánh giá tác động, SoA Annex A, vai trò. → Kiểm: `docs/compliance/soa-ai.csv` không hàng applicable nào thiếu bằng chứng. · Nguồn: ISO/IEC 42001:2023
- [ ] `STD-AI-010` **MUST@L** Hệ thống rủi ro cao (Annex III) có hồ sơ kỹ thuật, log tự động, quản lý dữ liệu huấn luyện theo AI Act Ch. III trước 2027-12-02. → Kiểm: checklist Art. 9–15 trong `docs/compliance/ai-act-high-risk.md` không mục nào trống. · Nguồn: AI Act Art. 9–15, Annex IV
- [ ] `STD-AI-011` **SHOULD** Trace LLM/agent theo OTel GenAI semconv (`invoke_agent`, `execute_tool`, `gen_ai.usage.input_tokens/output_tokens`), không ghi prompt/completion mặc định. → Kiểm: exporter test thấy span đúng tên; cấu hình `capture_content=false` mặc định.
- [ ] `STD-AI-012` **SHOULD** A2A: Agent Card hợp lệ theo 1.0.x, khai security scheme, server không lộ tài nguyên không được phép. → Kiểm: schema-validate Agent Card trong CI; test 401/404 cho tài nguyên ngoài quyền.
- [ ] `STD-AI-013` **SHOULD** Có model/system card (model dùng, phiên bản, giới hạn, dữ liệu, eval) cập nhật mỗi lần đổi model. → Kiểm: `docs/ai/system-card.md` có `model_version` khớp cấu hình runtime (script so sánh).
- [ ] `STD-AI-014` **MAY** Cung cấp GPAI model ra thị trường EU: tài liệu kỹ thuật, chính sách bản quyền, tóm tắt dữ liệu huấn luyện (Ch. V, áp từ 2025-08-02).
- [ ] `STD-AI-015` **MAY** Theo dõi NIST AI Agent Standards Initiative (2026-02) và AI RMF bản sửa đổi; cập nhật profile khi có bản mới.

## Bẫy thường gặp

- **Ghi "MCP mới nhất".** 2026-07-28 bỏ `initialize`/`Mcp-Session-Id`, đổi sang stateless; code viết cho 2025-11-25 không chạy. Cách tránh: ghim ngày, test tương thích khi nâng.
- **Dùng bản LLM Top 10 2025 vì "2026 chưa có", hoặc giữ mã 2025 sau khi nâng.** Bản 2026 công bố 04/08/2026 và **đổi mã** (vd Excessive Agency 06→03, Supply Chain 03→04, Output Handling 05→10, Unbounded Consumption 10→06); `research/2026-10-13-ai-agent-research.md` §5.1 ghi "chưa có 2026" — đã đính chính. Cách tránh: xác minh qua repo GitHub chính chủ (trang genai.owasp.org chặn bot); đổi mã theo bảng ở [`ai-security.md`](../12-security/ai-security.md).
- **Coi ISO 42001 là "đạt AI Act".** Không phải harmonised standard (theo nguồn thứ cấp 2026) → không có presumption of conformity. Cách tránh: ánh xạ trực tiếp điều khoản AI Act.
- **Tin mô tả tool MCP / Agent Card.** Mô tả là untrusted; tool poisoning và rug pull xảy ra qua đó. Cách tránh: STD-AI-006 snapshot + diff; sandbox server local.
- **Eval pass@k thay cho pass^k.** Agent production cần đúng cả k lần. Cách tránh: eval theo pass^k cho luồng hành động (catalog 07, 23 §4.3).
- **Judge cùng họ model.** Thiên lệch khi model chấm chính nó. Cách tránh: judge khác họ hoặc rubric người (catalog 03 §8).
- **Ghi prompt/completion vào trace mặc định** → PII vào hệ quan sát. Cách tránh: opt-in theo OTel GenAI; redact trước khi lưu.
- **Quên mốc Art. 50 đã áp dụng (02/08/2026)** trong khi chờ 2027 cho high-risk, hoặc tưởng Omnibus hoãn cả Art. 50 tới 02/12/2026 (chỉ phần đánh dấu 50(2) cho hệ đã lưu hành trước mốc). Cách tránh: STD-AI-003 là MUST ngay; mốc ở [`ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Promptfoo (MIT) | `promptfoo eval -c evals/ai-threats.yaml` (case `llm01`, `asi01`, `asi02`) | CI mỗi PR đổi prompt/tool; record/replay, không gọi model thật ở PR | 100% case an toàn pass; pass^k ≥ ngưỡng ghi trong `PROJECT.md` |
| Snapshot tool list MCP (test tự viết) | `pytest tests/mcp/test_tool_snapshot.py` / `vitest run mcp-snapshot` | CI | 0 diff chưa duyệt |
| Validate Agent Card A2A | `ajv validate -s a2a-agent-card.schema.json -d agent-card.json` | CI | exit 0 |
| Script kiểm file tuân thủ | `python3 scripts/check-ai-compliance.py` (ai-act-classification, ai-threats ≥ 10 LLM + 10 ASI) | CI job `gate` | 0 thiếu |
| OTel exporter test | test đơn vị span `invoke_agent` tồn tại, `capture_content` false | CI | pass |
| Guardrail runtime (NeMo Guardrails 0.24.1 Apache-2.0, LLM Guard…) | xem [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md) | runtime | — |

## Nguồn

- ISO/IEC 42001:2023: <https://www.iso.org/standard/42001> — **(iso.org trả 403 ngày 2026-10-13; ngày 2023-12-18 theo IEC webstore <https://webstore.iec.ch/publication/90574>)**
- NIST AI RMF 1.0 (2023-01-26) & AI 600-1 (2024-07-26): <https://www.nist.gov/itl/ai-risk-management-framework> — xác minh 2026-10-13
- EU AI Act Regulation (EU) 2024/1689: <https://eur-lex.europa.eu/eli/reg/2024/1689/oj> — **(eur-lex không trả nội dung ngày 2026-10-13)**; mốc thời gian và Digital Omnibus (EU) 2026/1744: theo nhà [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) (xác minh qua nguồn thứ cấp nhất quán; đối chiếu EUR-Lex 2026/1744 trước khi áp dụng)
- OWASP Top 10 for LLM Applications 2026 (công bố 04/08/2026): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> (README "Current release: 2026", thư mục `2026/final/`) — xác minh 2026-10-14; danh mục LLM01–10 và bảng đổi mã 2025 → 2026: [`../12-security/ai-security.md`](../12-security/ai-security.md). Đính chính 2026-10-14: bản trước trỏ repo cũ `OWASP/www-project-top-10-for-large-language-model-applications` (nay là lưu trữ) và ghi danh mục "chưa xác minh".
- OWASP Agentic Top 10 (2025-12-09): `research/2026-10-13-ai-agent-research.md` §5.1 [F ngày]; trang gốc <https://genai.owasp.org/> trả 403 ngày 2026-10-13
- OWASP MCP Top 10 (beta): <https://owasp.org/www-project-mcp-top-10/> — xác minh 2026-10-13
- MCP specification 2026-07-28: <https://modelcontextprotocol.io/specification/latest> — xác minh 2026-10-13
- A2A 1.0.1 (2026-05-26): <https://a2a-protocol.org/latest/specification/> · <https://github.com/a2aproject/A2A/releases> — xác minh 2026-10-13
- OTel GenAI semconv (Development): <https://github.com/open-telemetry/semantic-conventions-genai> — theo research §4.3 (đọc 2026-10-13)
- Catalog `seeker19110/stored` mục 07 (pass^k, negative control), 12 §1/§4 — đọc 2026-10-13.
