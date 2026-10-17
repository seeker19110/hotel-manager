---
title: Eval: offline/online, pass^k, negative control, record/replay, judge
kind: module
prefix: AI-EVAL
applies_to: [ai-agent, agentic-system, data-ml, api-service, web-app]
updated: 2026-10-16
---

# Eval: offline/online, pass^k, negative control, record/replay, judge

> Eval là **test của hệ thống có LLM**: không có eval thì không biết thay đổi prompt/model/pipeline làm tốt hơn hay
> tệ hơn. Module này quy định hai loại eval (capability vs regression), grader (tất định → model judge → người),
> negative control, record/replay trong CI không gọi model, judge khác họ model, ma trận claim, và mutation. Áp cho
> mọi tính năng LLM; chiến lược test chung ở [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md).

## Nguyên tắc

1. **Hai loại eval, hai mục đích**: *capability* (pass rate thấp, đo tiến bộ) và *regression* (pass rate ~100%, chặn PR). Không trộn.
2. **Grader tất định trước**: regex, schema, exact match, test chạy code; model judge chỉ khi tất định không đủ; người chỉ cho mẫu nhỏ và hiệu chuẩn judge.
3. **Negative control bắt buộc**: bộ câu phải trả lời "không biết"/từ chối; eval chỉ có ca dương là eval mù.
4. **CI không gọi model**: record/replay (fixture ghi từ lần chạy thật, có phiên bản) cho PR; gọi model thật chỉ ở job đêm/nightly có ngân sách.
5. **Judge khác họ model với hệ được chấm**: cùng họ → cùng điểm mù; hiệu chuẩn judge với mẫu người chấm.
6. **Đọc transcript**: số liệu không thay được việc đọc 20 transcript thất bại mỗi tuần.
7. **Claim có hạng**: mỗi kết luận eval ghi rõ *real-path* (chạy thật), *faithful-fixture* (replay) hay *asserted-not-measured* (chưa đo).

## Quyết định

### Grader theo loại đầu ra

| Đầu ra | Grader | Ghi chú |
|---|---|---|
| Có schema/enum/số | Schema + so sánh tất định | Nhanh, không nhiễu |
| Code | Chạy test/compile | Kết quả thật |
| Trích xuất từ tài liệu | Exact/fuzzy match với ground truth | Chuẩn hoá trước khi so |
| Văn bản mở (tóm tắt, trả lời) | Model judge có rubric + mẫu người chấm (≥ 50) để hiệu chuẩn | Judge khác họ model; đo agreement |
| Agent nhiều bước | Kiểm trạng thái cuối (DB, file) + chuỗi tool hợp lệ | Không chấm "trông hợp lý" |

### Ma trận claim

| Hạng | Nghĩa | Được viết là |
|---|---|---|
| real-path | Chạy end-to-end với model/dịch vụ thật | "đo được X trên N mẫu, ngày…" |
| faithful-fixture | Replay fixture ghi từ lần chạy thật, có phiên bản | "replay fixture v… đạt X" |
| asserted-not-measured | Suy luận/kỳ vọng, chưa đo | "chưa đo" — không được ghi là "đạt" |

### Công cụ (xác minh 2026-10-13)

| Nhu cầu | Công cụ | Phiên bản |
|---|---|---|
| Eval prompt/model đa nhà cung cấp, so sánh, CI | `promptfoo` | 0.124.1 (npm) |
| Eval kiểu pytest, metric LLM + RAG | `deepeval` | 4.2.8 (PyPI 2026-10-02) |
| Metric RAG | `ragas` | 0.4.3 (PyPI 2026-01-13) |
| Trace + dataset + eval online | `langfuse` | 4.17.0 (PyPI 2026-10-05) — xem [`observability-and-cost.md`](observability-and-cost.md) |

## Checklist

- [ ] `AI-EVAL-001` **MUST** Mỗi tính năng LLM có bộ regression eval (pass rate mục tiêu ~100%) chạy trong CI trên PR đổi prompt/model/pipeline; giảm quá ngưỡng → đỏ. → Kiểm: job CI tồn tại; so với baseline lưu trong repo. · Nguồn: Anthropic *Demystifying evals*
- [ ] `AI-EVAL-002` **MUST** CI trên PR không gọi model thật: dùng record/replay fixture có phiên bản; gọi thật chỉ ở job đêm có ngân sách. → Kiểm: job PR không có API key của nhà cung cấp; fixture trong repo/kho có hash. · Nguồn: stored 07
- [ ] `AI-EVAL-003` **MUST@L** Bộ eval có negative control (≥ 10% ca phải từ chối/"không biết"/không gọi tool). → Kiểm: đếm nhãn `expected: refuse|unknown` trong dataset. · Nguồn: stored 07
- [ ] `AI-EVAL-004` **MUST** Grader ưu tiên tất định; model judge chỉ khi có rubric và hiệu chuẩn với ≥ 50 mẫu người chấm, báo cáo agreement. → Kiểm: file rubric; báo cáo agreement (vd Cohen's κ) trong repo. · Nguồn: Anthropic *Demystifying evals*
- [ ] `AI-EVAL-005` **MUST@L** Judge khác họ model với hệ được chấm, hoặc có bằng chứng agreement với người đủ cao nếu cùng họ. → Kiểm: config judge ghi nhà cung cấp/họ model khác; ADR nếu cùng họ.
- [ ] `AI-EVAL-006` **MUST@L** Mọi kết luận eval ghi hạng claim (real-path / faithful-fixture / asserted-not-measured); "asserted" không được báo là đạt. → Kiểm: báo cáo eval có cột hạng; review từ chối báo cáo thiếu. · Nguồn: stored 23 §2.3
- [ ] `AI-EVAL-007` **MUST@L** Hệ agent/nhiều bước báo pass^k (k ≥ 3) và kiểm trạng thái cuối, không chỉ chấm văn bản trả lời. → Kiểm: báo cáo có pass^k; grader đọc DB/file. · Nguồn: [`agentic-systems.md`](agentic-systems.md)
- [ ] `AI-EVAL-008` **MUST** Dataset eval có phiên bản, nguồn, giấy phép, và không chứa PII thật chưa che; tách khỏi dữ liệu huấn luyện/few-shot. → Kiểm: metadata dataset; scan PII. · Nguồn: [`data-and-fine-tuning.md`](data-and-fine-tuning.md)
- [ ] `AI-EVAL-009` **SHOULD** Bộ capability eval riêng (pass rate thấp) để đo tiến bộ theo thời gian; khi ca nào đạt ổn định → chuyển sang regression. · Nguồn: Anthropic *Demystifying evals*
- [ ] `AI-EVAL-010` **SHOULD** Mỗi tuần đọc ≥ 20 transcript thất bại/được đánh giá thấp từ production; ca mới → thêm vào dataset qua pipeline đề xuất→duyệt.
- [ ] `AI-EVAL-011` **SHOULD** Eval online: lấy mẫu production (có che PII) chấm bằng judge/người; cảnh báo khi điểm giảm so tuần trước. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-EVAL-012` **SHOULD** Mutation cho eval: thay đổi cố ý (bỏ hướng dẫn, đổi model yếu) phải làm eval đỏ; eval không đỏ → eval vô dụng. · Nguồn: [`../14-testing-quality/coverage-and-mutation.md`](../14-testing-quality/coverage-and-mutation.md)
- [ ] `AI-EVAL-013` **SHOULD** Fixture record/replay có ngày ghi và phiên bản model; làm tươi khi nâng model (ghi lại ở job đêm, review diff).
- [ ] `AI-EVAL-014` **SHOULD** Đo cả chi phí và độ trễ trong eval (p50/p95, token) để quyết đổi tier model có bằng chứng. · Nguồn: [`llm-app-foundations.md`](llm-app-foundations.md)
- [ ] `AI-EVAL-015` **SHOULD** Eval chọn tool và eval injection (tài liệu/tool trả chỉ thị độc) nằm trong regression. · Nguồn: [`../12-security/ai-security.md`](../12-security/ai-security.md)
- [ ] `AI-EVAL-016` **MAY** Red-team định kỳ với bộ tấn công cập nhật (OWASP LLM/Agentic) cho hệ đối ngoại; kết quả vào dataset negative.
- [ ] `AI-EVAL-017` **MAY** A/B online với guardrail dừng sớm khi biến thể mới giảm chỉ số an toàn.
- [ ] `AI-EVAL-018` **MUST@L** Thống kê trong eval: báo cáo ghi `n`, số lần chạy/seed và khoảng tin cậy 95% (Wilson cho tỉ lệ, hoặc bootstrap); chỉ kết luận "A tốt hơn B" hay "có regression" khi chênh lệch vượt khoảng tin cậy hoặc qua kiểm định cặp trên cùng ca; ngưỡng cổng CI phải lớn hơn nhiễu đo từ ≥ 3 lần chạy baseline; leaderboard ghi cách xếp hạng (theo điểm hay theo nhóm hoà). → Kiểm: schema báo cáo eval có `n`, `runs`, `ci_low`, `ci_high` (thiếu → báo cáo bị từ chối); file baseline ghi ≥ 3 lần chạy và độ lệch; ngưỡng cổng > độ lệch đó. · Nguồn: stored 08 §2f.1 (thống kê cho eval), stored 17 §2c.3 (AnyJev: n = 300, một seed; hạng nhóm 5 so với hạng điểm 10/168)
- [ ] `AI-EVAL-019` **SHOULD** LLM dùng để phân loại/định tuyến (chọn 1 trong K, có/không, chấm thang) được eval **theo từng tác vụ** với: accuracy; tỉ lệ đổi đáp án khi đảo thứ tự lựa chọn; sai số hiệu chuẩn (ECE); tỉ lệ quyết định tự động được ở mức sai mục tiêu (coverage@risk). Có ngưỡng "tự quyết / chuyển người"; phần leo thang sang đường đắt (suy luận dài, model lớn, người) có trần và mỗi lần leo thang được ghi lại; đầu ra mang nhãn đường xử lý (`primary`/`fallback`/`escalated`). Không có xác suất token (API đóng) → structured output + eval trên tập có nhãn. Nâng thành **MUST@L** khi quyết định được tự động hoá (không người duyệt từng ca). → Kiểm: báo cáo eval có 4 số trên **mỗi** tác vụ (không gộp); cấu hình ngưỡng + trần leo thang; log có trường `route`; test đảo thứ tự lựa chọn. · Nguồn: stored 17 §2c.3 (AnyJev: coverage ở sai ≤ 5% của Qwen3-8B trên tác vụ nhị phân `injection` sụp 0,313 → 0,013, dù cùng kỹ thuật tăng accuracy ở các ô 20 lựa chọn), §2c.5

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Chỉ có ca dương | Hệ trả lời mọi thứ kể cả khi nên từ chối | Negative control ≥ 10% |
| Judge cùng họ model, không hiệu chuẩn | Điểm cao giả | Khác họ + agreement với người |
| CI gọi model thật mỗi PR | Chậm, tốn, nhiễu | Record/replay |
| "Pass rate 92%" cho agent | Dùng 5 lần thất bại 1 | pass^k |
| Fixture cũ 6 tháng | Replay không phản ánh model hiện tại | Ngày + làm tươi khi nâng model |
| Eval không bao giờ đỏ | Không phát hiện hồi quy | Mutation eval |
| Dataset lẫn few-shot/huấn luyện | Điểm cao giả do rò | Tách tập |
| Chỉ nhìn số, không đọc transcript | Bỏ lọt lỗi hệ thống | 20 transcript/tuần |
| Kết luận "A hơn B" từ một lần chạy, n nhỏ | Chênh lệch chỉ là nhiễu; cổng đỏ/xanh ngẫu nhiên | Báo `n`, `runs`, CI 95%; ngưỡng > nhiễu đo từ ≥ 3 lần baseline (`AI-EVAL-018`) |
| Chỉ báo accuracy trung bình cho bộ phân loại/định tuyến | Coverage tự quyết có thể sụp ở tác vụ này dù accuracy tăng ở tác vụ khác | Đo 4 số theo từng tác vụ; ngưỡng tự quyết đo lại trên dữ liệu của mình (`AI-EVAL-019`) |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Regression (replay) | `promptfoo eval` / `deepeval test run` với fixture | CI mỗi PR liên quan | Không giảm quá ngưỡng baseline; negative ≥ 10% |
| Real-path | Job đêm có `--max-budget` | Nightly | Báo cáo + hạng claim |
| Judge hiệu chuẩn | Script tính agreement | Khi đổi judge/rubric | ≥ ngưỡng đã chốt trong ADR |
| Mutation | Chạy eval với prompt bị phá | Hàng tháng | Eval đỏ |
| PII trong dataset | Scanner PII (vd Presidio) | CI | 0 phát hiện |
| Thống kê báo cáo | Script đọc báo cáo eval (`n`, `runs`, `ci_low`, `ci_high`) và so ngưỡng cổng với nhiễu baseline | CI | Thiếu trường hoặc ngưỡng ≤ nhiễu = đỏ |
| Phân loại/định tuyến | Script eval theo tác vụ: accuracy, tỉ lệ đổi đáp án khi đảo thứ tự, ECE, coverage@risk | CI (replay) | Không giảm quá ngưỡng baseline theo từng tác vụ; leo thang ≤ trần |

## Nguồn

- Anthropic, *Demystifying evals for AI agents* (capability vs regression, grader tất định → judge → người, pass@k vs pass^k, đọc transcript): <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §6 [F]).
- `promptfoo` 0.124.1 <https://www.npmjs.com/package/promptfoo> · docs <https://www.promptfoo.dev/docs/intro/> · `deepeval` 4.2.8 <https://pypi.org/project/deepeval/> · `ragas` 0.4.3 <https://pypi.org/project/ragas/> · `langfuse` 4.17.0 <https://pypi.org/project/langfuse/> — xác minh 2026-10-13.
- `seeker19110/stored` mục 07 (negative control, record/replay không gọi model trong CI, judge khác họ), mục 23 §2.3 (ma trận claim real-path/faithful-fixture/asserted-not-measured) — đọc 2026-10-13 (`research/2026-10-13-stored-catalog-extraction.md`).
- OWASP Top 10 for LLM Applications 2026 cho bộ red-team (04/08/2026; mã đổi so với 2025 — bảng ở [`../12-security/ai-security.md`](../12-security/ai-security.md)): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14. Agentic Top 10 2026: <https://genai.owasp.org/> — (chưa xác minh — 403 ngày 2026-10-13).
- Catalog `seeker19110/stored` mục 08 §2f.1 (xác suất thống kê cơ bản là bắt buộc để làm eval đúng: cỡ mẫu, khoảng tin cậy, so A/B, phương sai giữa các lần chạy LLM), mục 17 §2c.3 (AnyJev: n = 300, một seed; "hạng 5/149" là hạng theo nhóm hoà, xếp theo điểm là 10/168) — đọc 2026-10-16.
- Catalog `seeker19110/stored` mục 17 §2c.3, §2c.5 (AnyJev: đọc quyết định có kiểu kèm xác suất; "tự quyết được ở sai ≤ 5%" không đồng đều giữa tác vụ; API đóng không có log-prob thì dùng structured output + eval riêng; cap leo thang giới hạn số quyết định, không giới hạn thời gian từng quyết định) — đọc 2026-10-16.
