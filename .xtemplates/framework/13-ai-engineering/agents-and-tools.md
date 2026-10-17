---
title: Agent & tool: ACI, allowlist, schema, HITL, memory
kind: module
prefix: AI-AGENT
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-10-16
---

# Agent & tool: ACI, allowlist, schema, HITL, memory

> Một agent đơn = model + vòng lặp + tập tool. Module này quy định **giao diện agent–máy tính (ACI)**: ít tool, tham
> số tra được, schema đầu ra đi qua policy validator, allowlist tool + tham số, human-in-the-loop cho hành động không
> đảo ngược, và memory qua pipeline đề xuất → duyệt → ghi. Đa agent/durable execution ở [`agentic-systems.md`](agentic-systems.md);
> mối đe doạ ở [`../12-security/ai-security.md`](../12-security/ai-security.md).

## Nguyên tắc

1. **Tool là API cho model, thiết kế như API cho người mới**: tên rõ, mô tả có ví dụ, tham số ít và tra được (ID thay vì tên tự do), lỗi trả về có hướng dẫn sửa.
2. **Ít tool hơn tốt hơn**: model nhỏ thấy ≤ 8 tool; hợp nhất tool tương tự; tool hiếm dùng nạp theo ngữ cảnh.
3. **Model đề xuất, code quyết**: output của model là *đề xuất hành động*; allowlist tool + tham số và policy validator ở ngoài model quyết có chạy không. Prompt không phải cơ chế bảo mật.
4. **Hành động không đảo ngược cần người**: xoá, gửi, thanh toán, đổi quyền → trạng thái `waiting_approval`; timeout mặc định **huỷ**, không tự duyệt.
5. **Memory là dữ liệu được kiểm duyệt**: agent đề xuất ghi nhớ; pipeline duyệt (tự động theo luật hoặc người) rồi mới ghi; memory có nguồn, thời hạn, và có thể xoá.
6. **Mọi hành động có nhật ký**: tool, tham số, kết quả, ai duyệt — để tái hiện và audit.

## Quyết định

### Tool có cần không, và ở dạng nào

| Nhu cầu | Dạng | Ghi chú |
|---|---|---|
| Đọc dữ liệu nội bộ | Tool đọc với filter quyền ở server | Trả về ID + tóm tắt, không dump bảng |
| Tính toán/định dạng xác định | Code trong ứng dụng, không qua model | Tiền, ngày, đơn vị — [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md) |
| Hành động có tác dụng phụ (gửi, ghi, thanh toán) | Tool ghi qua policy validator + HITL theo mức | Idempotency key bắt buộc |
| Dịch vụ ngoài có MCP server | MCP client với allowlist tool | Xem [`protocols-mcp-a2a.md`](protocols-mcp-a2a.md) |

### Mức tin cậy hành động (áp cho tool ghi)

| Mức | Ví dụ | Cơ chế |
|---|---|---|
| T0 đọc | tra cứu, tìm kiếm | Tự động, có log |
| T1 ghi đảo ngược được nội bộ | tạo nháp, ghi ghi chú | Tự động, có log, có undo |
| T2 ghi khó đảo ngược nội bộ | cập nhật bản ghi, đổi trạng thái | Policy validator + giới hạn số lượng/giờ |
| T3 đối ngoại | gửi email/tin nhắn, tạo đơn | HITL duyệt từng hành động hoặc theo lô có xem trước |
| T4 không đảo ngược/tiền | xoá, thanh toán, đổi quyền | HITL bắt buộc, kill switch, giới hạn giá trị |

(Thang tương ứng với T0–T4 của vòng lặp phát triển ở [`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md).)

### Memory

| Loại | Lưu ở đâu | Luật |
|---|---|---|
| Hội thoại (ngắn hạn) | Context/phiên | Cắt theo ngân sách; không coi là sự thật |
| Hồ sơ người dùng (dài hạn) | DB có schema + nguồn + thời hạn | Đề xuất → duyệt → ghi; người dùng xem/xoá được |
| Tri thức tổ chức | RAG index có quyền | [`rag-and-knowledge.md`](rag-and-knowledge.md) |

## Checklist

- [ ] `AI-AGENT-001` **MUST@L** Mỗi tool có schema tham số (JSON Schema) với mô tả, ví dụ và ràng buộc (enum, min/max, pattern); tham số tham chiếu dùng ID tra được. → Kiểm: lint schema tool; test tham số ngoài ràng buộc bị từ chối trước khi chạy.
- [ ] `AI-AGENT-002` **MUST** Allowlist tool theo vai trò/agent và allowlist giá trị tham số nhạy cảm (đường dẫn, domain, số tiền, người nhận) kiểm ở code ngoài model. → Kiểm: test model yêu cầu tool/tham số ngoài allowlist → từ chối + log; không có "deny bằng prompt". · Nguồn: `research/2026-10-13-ai-agent-research.md` §2
- [ ] `AI-AGENT-003` **MUST** Đầu ra hành động của model đi qua policy validator (schema + luật nghiệp vụ) trước khi thực thi; validator fail-closed. → Kiểm: test validator lỗi/ngoại lệ → hành động không chạy.
- [ ] `AI-AGENT-004` **MUST** Hành động T3–T4 vào trạng thái `waiting_approval` với bản xem trước; timeout mặc định huỷ; người duyệt khác với người yêu cầu khi liên quan tiền/quyền. → Kiểm: test timeout → `cancelled`; log có `approved_by`.
- [ ] `AI-AGENT-005` **MUST@L** Mọi tool ghi có idempotency key và kết quả `outcome_unknown` (timeout/mất kết nối) được reconcile bằng đọc lại trước khi retry. → Kiểm: test gọi 2 lần cùng key → 1 tác dụng; test timeout → reconcile. · Nguồn: [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md)
- [ ] `AI-AGENT-006` **MUST@L** Số tool model thấy mỗi lượt có trần (≤ 8 với model nhỏ, ≤ 20–30 với model lớn — eval lại); tool hiếm nạp theo ngữ cảnh. → Kiểm: đếm tool trong request; eval tỉ lệ chọn đúng tool. · Nguồn: stored 02
- [ ] `AI-AGENT-007` **MUST** Kết quả tool là dữ liệu untrusted: đặt trong ranh giới, cắt theo trần token, lọc chỉ thị; tool lấy nội dung ngoài (web, email) gắn nhãn nguồn. → Kiểm: test tool trả về chuỗi chứa chỉ thị → không hành động lệch. · Nguồn: [`../12-security/ai-security.md`](../12-security/ai-security.md)
- [ ] `AI-AGENT-008` **MUST@L** Vòng lặp agent có trần: số bước, token, thời gian, số lần gọi cùng tool với cùng tham số (phát hiện lặp, k = 3). → Kiểm: test agent lặp → dừng với lý do `loop_detected`; config trần tồn tại. · Nguồn: `research/2026-10-13-ai-agent-research.md` §2
- [ ] `AI-AGENT-009` **MUST@L** Memory dài hạn ghi qua pipeline đề xuất → duyệt → ghi, có nguồn, thời điểm, thời hạn; người dùng xem và xoá được. → Kiểm: không có đường ghi memory trực tiếp từ output model; endpoint xoá memory có test. · Nguồn: stored 02
- [ ] `AI-AGENT-010` **MUST@L** Nhật ký hành động: tool, tham số (đã che PII), kết quả, người duyệt, trace id; lưu theo chính sách audit. → Kiểm: trace một phiên tái hiện được chuỗi hành động. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-AGENT-011` **SHOULD** Lỗi tool trả về cho model có mã + gợi ý sửa ("thiếu `customer_id`, dùng `search_customer` trước") thay vì stack trace.
- [ ] `AI-AGENT-012` **SHOULD** Tool trả về tóm tắt + ID, có phân trang; không trả bảng hàng nghìn dòng vào context. · Nguồn: [`../11-autonomous-loop/context-and-token-budget.md`](../11-autonomous-loop/context-and-token-budget.md)
- [ ] `AI-AGENT-013` **MUST@L** Mỗi tool khai metadata máy đọc được: `readOnly`/idempotent (tool đọc được gọi song song), tác dụng phụ của tool ghi (`external_side_effects`), **`tier`** (T0–T4, xem "Mức tin cậy hành động") và **`cost_class`** (`free`/`compute`/`llm`/`gpu`); dựng catalog tool **thất bại** nếu thiếu trường. Tool khai `readOnly` phải qua **test hành vi** (chạy trên snapshot trạng thái rồi diff → không đổi); **không suy quyền từ tên tool** (`get_*`, `delete_*`) mà từ khai báo đã kiểm. → Kiểm: test dựng catalog với tool thiếu `tier`/`cost_class` → lỗi; test tool `readOnly` chạy trên snapshot DB/file → diff rỗng (tool tên `get_*` nhưng ghi trạng thái → đỏ). · Nguồn: Anthropic tool use docs; `seeker19110/stored` 07 (Overmind: `cost_class` bắt buộc ở catalog nhưng chặn theo tên/cờ tự khai nên `set_active_model` vẫn ghi đè trạng thái; đọc 2026-10-16)
- [ ] `AI-AGENT-014` **SHOULD** Eval chọn tool: bộ ≥ 30 tình huống với tool đúng kỳ vọng; đổi mô tả tool → chạy lại. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-AGENT-015` **SHOULD** Giới hạn tốc độ và giá trị theo tenant cho tool ghi (vd ≤ N email/giờ, ≤ X tiền/ngày) ở tầng tool, không ở prompt.
- [ ] `AI-AGENT-016` **SHOULD** Giao diện xem trước/duyệt hành động cho người dùng cuối theo [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md): hiển thị tool, tham số, hậu quả, nút huỷ.
- [ ] `AI-AGENT-017` **MAY** Thử nghiệm mô tả tool bằng cách cho model dùng thử và đọc transcript thất bại (ACI tuning) trước khi thêm tool mới vào production. · Nguồn: Anthropic *Building effective agents*
- [ ] `AI-AGENT-018` **MAY** Memory tổ chức chia sẻ giữa agent chỉ qua RAG index có quyền, không qua file chung không kiểm soát.
- [ ] `AI-AGENT-019` **SHOULD** Agent nhận lệnh qua kênh nhắn (chat, email, SMS) xác định **mức tin cậy theo người gửi** và kiểm ở hook trước mỗi lời gọi tool bằng code (không bằng prompt), ghi audit; kênh giả mạo được người gửi (email chưa qua SPF/DKIM/DMARC) nhận mức thấp nhất. → Kiểm: test gửi cùng yêu cầu từ người gửi tin cậy/không tin cậy → tool bị chặn ở mức thấp; dòng audit tương ứng. · Nguồn: `seeker19110/stored` 21 §10b (open-instinct: `beforeToolCall` 6 mức + `audit.jsonl`)
- [ ] `AI-AGENT-020` **SHOULD** Memory phân loại theo CoALA (working · episodic · semantic · **procedural**); procedural memory (skill, luật, `AGENTS.md`, prompt hệ thống) chỉ đổi qua PR có review như code, agent không tự ghi. → Kiểm: tool ghi memory của agent không có quyền ghi vào thư mục skill/luật; đổi file đó đi qua CODEOWNERS. · Nguồn: Sumers và cộng sự, *Cognitive Architectures for Language Agents* (CoALA, 2023); `seeker19110/stored` 03 §8d
- [ ] `AI-AGENT-021` **MUST@L** Xoá memory (cả theo yêu cầu quyền chủ thể dữ liệu, xem [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)) lan tới **mọi dữ liệu phái sinh** — entity, link/quan hệ, mental model/reflection, tóm tắt, embedding, cache — và **tạo lại** các tóm tắt còn lại từ nguồn đã trừ mục xoá. → Kiểm: test xoá memory nguồn → `recall`/`reflect` không còn trả fact đó; truy vấn trực tiếp các bảng phái sinh không còn tham chiếu tới nó. · Nguồn: `seeker19110/stored` 10 §4d.2 (Hindsight: schema 25 bảng, dữ liệu phái sinh nằm ở `entities`, `mental_models`, `memory_links`…; đọc 2026-10-16)
- [ ] `AI-AGENT-022` **SHOULD** Bank memory phân vùng theo user/agent/dự án (không một bank chung cho tất cả); đo p95 recall theo kích thước bank và đặt **ngưỡng cảnh báo** (số memory/bank) trong cấu hình; vượt ngưỡng → tách bank hoặc đổi backend. → Kiểm: dashboard p95 recall theo kích thước bank; alert ở ngưỡng đã ghi. · Nguồn: `seeker19110/stored` 10 §4d.1, §4d.3 (Hindsight: recall 7 qps ở 33k memory → 1,9 qps ở 164k trên 4 vCPU; chính nhà phát triển khuyến nghị giữ bank dưới ~50k memory — số do họ đo, dự án tự đo lại; đọc 2026-10-16)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| 40 tool cho model nhỏ | Chọn sai tool, lặp, chi phí | ≤ 8; nạp theo ngữ cảnh |
| "Không được xoá" viết trong prompt | Injection vượt qua | Allowlist + validator ở code |
| Timeout duyệt → tự duyệt | Hành động không ai muốn | Timeout = huỷ |
| Tool ghi không idempotency key | Gửi 2 email, trừ tiền 2 lần | Key + reconcile |
| Model ghi memory trực tiếp | Memory nhiễm injection, không xoá được | Đề xuất → duyệt → ghi |
| Tool trả stack trace | Model "sửa" sai hướng | Lỗi có mã + gợi ý |
| Tham số là tên tự do | Gửi nhầm người, cập nhật nhầm bản ghi | ID tra được |
| Không trần bước | Chạy 400 lời gọi/5 phút | Trần bước/token/lặp |
| Tool tên `get_*` nhưng ghi trạng thái; chặn theo tên/cờ tự khai | Quyền suy từ tên bị vượt; trạng thái bị ghi đè | Test hành vi trên snapshot + diff (`AI-AGENT-013`) |
| Xoá memory nguồn mà entity/link/tóm tắt còn nguyên | Fact đã "xoá" vẫn được recall/reflect; DSAR không hoàn tất | Xoá lan + tạo lại tóm tắt (`AI-AGENT-021`) |
| Một bank memory chung cho mọi user/agent | Recall chậm dần khi bank lớn; lẫn dữ liệu | Phân vùng + đo p95 theo kích thước (`AI-AGENT-022`) |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Schema tool | Lint JSON Schema + test tham số biên | CI | 0 tool thiếu mô tả/ràng buộc |
| Allowlist/validator | Test tool/tham số ngoài allowlist | CI | 100% bị chặn, có log |
| HITL | Test timeout → `cancelled`; test `approved_by` | CI | Xanh |
| Idempotency | Test gọi trùng key | CI | 1 tác dụng |
| Lặp/trần | Test agent lặp | CI | Dừng ≤ k = 3 lần cùng tool+tham số |
| Eval chọn tool | Bộ ≥ 30 tình huống | CI khi đổi tool | Không giảm quá ngưỡng baseline |
| Catalog tool | Test dựng catalog thiếu `tier`/`cost_class` | CI | Dựng thất bại |
| Tool `readOnly` | Chạy trên snapshot trạng thái rồi diff | CI | Diff rỗng |
| Xoá memory | Xoá nguồn → recall/reflect + bảng phái sinh | CI | Không còn fact |

## Nguồn

- Anthropic, *Building effective agents* (ACI, "invest as much in tool docs as in prompts"): <https://www.anthropic.com/engineering/building-effective-agents> · *Writing tools for agents* (2025-09-11): <https://www.anthropic.com/engineering/writing-tools-for-agents> · tool use docs (song song, idempotent): <https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview> — xác minh 2026-10-13.
- OWASP Top 10 for Agentic Applications 2026 (ASI01 Agent Goal Hijack, ASI02 Tool Misuse, ASI04 Memory Poisoning…): <https://genai.owasp.org/> — (chưa xác minh — không truy cập được ngày 2026-10-13, 403; theo `research/2026-10-13-ai-agent-research.md` §5).
- `research/2026-10-13-ai-agent-research.md` §2 (allowlist tool+tham số, policy validator, HITL `waiting_approval` timeout huỷ, loop detection k = 3, ngân sách 5 chiều) — tổng hợp 2026-10-13.
- `seeker19110/stored` mục 02 (ACI, ≤ 8 tool cho model nhỏ, memory đề xuất→duyệt→ghi, "prompt không phải cơ chế bảo mật"), mục 12 §1–2 — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- Sumers và cộng sự, *Cognitive Architectures for Language Agents* (CoALA; working/episodic/semantic/procedural memory): <https://arxiv.org/abs/2309.02427> — đọc 2026-10-15. Catalog `seeker19110/stored` 03 §8d, 21 §10b (open-instinct: mức tin cậy theo người gửi ở `beforeToolCall`, `audit.jsonl`) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 07 (Overmind: `cost_class`, chặn theo tên), 10 §4d (Hindsight: 25 bảng, p95 recall theo kích thước bank) — đọc 2026-10-16.
