---
title: Dữ liệu, fine-tuning, dataset, bản quyền, PII trong dữ liệu huấn luyện
kind: module
prefix: AI-DATA
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-10-14
---

# Dữ liệu, fine-tuning, dataset, bản quyền, PII trong dữ liệu huấn luyện

> Dữ liệu cho eval/few-shot/fine-tune là **tài sản có phiên bản, nguồn gốc, giấy phép và PII phải xử lý**. Module này
> quy định versioning dataset (DVC/lakeFS), lineage, PII và giấy phép trong dữ liệu huấn luyện, và khi nào fine-tune
> (chỉ sau khi prompt + RAG thất bại, có eval trước/sau). Giấy phép/IP chi tiết ở
> [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md); luật dữ liệu Việt Nam ở [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md).

## Nguyên tắc

1. **Dataset là mã**: có phiên bản (hash), changelog, chủ sở hữu, lineage (từ đâu, biến đổi gì); tái tạo được từ nguồn + pipeline.
2. **Fine-tune là bước cuối**: thử prompt (few-shot, hướng dẫn) → RAG → structured output trước; fine-tune khi eval chứng minh còn khoảng cách và chi phí/độ trễ đáng.
3. **Không PII thật trong dữ liệu huấn luyện/few-shot** trừ khi có cơ sở pháp lý và đã đánh giá rủi ro; mặc định che/tổng hợp.
4. **Giấy phép của dữ liệu là giấy phép của model**: dữ liệu không rõ nguồn/giấy phép không vào tập huấn luyện; dữ liệu khách hàng chỉ dùng khi hợp đồng cho phép.
5. **Eval trước và sau**: fine-tune không có baseline + holdout + regression trên tác vụ khác = không đo được.
6. **Tách tập**: train/validation/holdout/eval không rò lẫn nhau, không trùng với few-shot trong prompt production.

## Quyết định

### Có nên fine-tune?

| Tình huống | Quyết định |
|---|---|
| Thiếu kiến thức miền/thực tế mới | **Không** — RAG ([`rag-and-knowledge.md`](rag-and-knowledge.md)) |
| Cần định dạng đầu ra cố định | **Không** — structured output ([`llm-app-foundations.md`](llm-app-foundations.md)) |
| Cần giọng/văn phong, phân loại chuyên biệt khối lượng lớn, giảm độ trễ/chi phí với model nhỏ, sau khi prompt + RAG đã tối ưu mà eval còn thiếu | **Cân nhắc** — có baseline, dataset ≥ vài trăm mẫu sạch, eval holdout |
| Dữ liệu có PII/giấy phép chưa rõ | **Không** cho tới khi xử lý xong |

### Công cụ versioning (xác minh 2026-10-13)

| Nhu cầu | Công cụ | Phiên bản |
|---|---|---|
| Version dữ liệu/pipeline/experiment cạnh git | DVC (`dvc` 3.67.1, PyPI 2026-03-31) | File lớn ở remote storage, `.dvc` trong git |
| Nhánh/commit cho data lake (object store) | lakeFS v1.88.0 (GitHub release 01 Oct; năm không hiển thị trên trang — (chưa xác minh) năm) | Thao tác kiểu git trên bucket |
| PII detect/anonymize | Presidio (`presidio-analyzer` 2.2.364) | Xem [`guardrails-and-safety.md`](guardrails-and-safety.md) |

### Hồ sơ dataset tối thiểu (datasheet)

Nguồn + ngày thu · giấy phép/cơ sở pháp lý · cách lọc/biến đổi · thống kê (kích thước, phân bố nhãn) · PII đã xử lý
thế nào · hạn chế đã biết · chủ sở hữu · hash phiên bản.

## Checklist

- [ ] `AI-DATA-001` **MUST** Mọi dataset (eval, few-shot, fine-tune) có phiên bản bằng hash và được theo dõi bằng công cụ (DVC/lakeFS/kho có versioning); code tham chiếu dataset theo phiên bản, không "bản mới nhất". → Kiểm: `.dvc`/lakeFS ref trong repo; pipeline chạy lại cho cùng hash. · Nguồn: DVC docs
- [ ] `AI-DATA-002` **MUST@L** Mỗi dataset có datasheet: nguồn, ngày, giấy phép/cơ sở pháp lý, biến đổi, PII, hạn chế, chủ sở hữu. → Kiểm: file datasheet cạnh dataset; thiếu → không dùng cho huấn luyện.
- [ ] `AI-DATA-003` **MUST** Dữ liệu huấn luyện/few-shot không chứa PII thật chưa xử lý; quét PII trước khi đưa vào; dữ liệu cá nhân chỉ dùng khi có cơ sở pháp lý và DPIA khi cần. → Kiểm: báo cáo scan PII (Presidio) = 0 hoặc có quyết định ghi nhận; xem [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md).
- [ ] `AI-DATA-004` **MUST** Chỉ dùng dữ liệu có giấy phép cho phép mục đích huấn luyện/thương mại; dữ liệu khách hàng chỉ khi hợp đồng/điều khoản cho phép rõ; ghi trong datasheet. → Kiểm: cột giấy phép không trống; đối chiếu [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md).
- [ ] `AI-DATA-005` **MUST@L** Fine-tune chỉ sau khi có bằng chứng prompt + RAG + structured output không đạt trên bộ eval; quyết định ghi ADR với số liệu. → Kiểm: ADR có bảng eval baseline. · Nguồn: [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `AI-DATA-006` **MUST@L** Fine-tune có baseline, tập holdout không dùng khi huấn luyện, và regression eval trên tác vụ khác để phát hiện suy giảm; kết quả trước/sau trong báo cáo. → Kiểm: báo cáo có 3 số: baseline, holdout sau fine-tune, regression. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-DATA-007` **MUST@L** Tập train/validation/holdout/eval không trùng mẫu (kiểm bằng hash/near-duplicate) và không trùng few-shot trong prompt production. → Kiểm: script dedup chạy trong pipeline; báo cáo 0 trùng.
- [ ] `AI-DATA-008` **MUST** Yêu cầu xoá dữ liệu cá nhân lan tới dataset và model phái sinh: có quy trình gỡ mẫu và đánh giá lại/huấn luyện lại hoặc ngừng model nếu không gỡ được. → Kiểm: runbook; lineage mẫu → model. · Nguồn: [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `AI-DATA-009` **MUST@L** Model đã fine-tune có phiên bản, gắn với hash dataset + cấu hình huấn luyện + kết quả eval; triển khai qua cùng cổng như model gốc (eval, guardrail). → Kiểm: registry model ghi lineage; deploy có eval gate.
- [ ] `AI-DATA-010` **SHOULD** Pipeline dữ liệu là mã có test (schema, thống kê, null, phân bố nhãn) chạy trước khi tạo phiên bản dataset mới. · Nguồn: [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)
- [ ] `AI-DATA-011` **SHOULD** Dữ liệu tổng hợp (synthetic) do model sinh được gắn nhãn nguồn và không vượt tỉ lệ đã chốt trong tập huấn luyện; eval trên dữ liệu thật.
- [ ] `AI-DATA-012` **SHOULD** Nhãn do người gán có hướng dẫn, đo agreement giữa người gán, mẫu khó được review lại. · Nguồn: [`evaluation.md`](evaluation.md)
- [ ] `AI-DATA-013` **SHOULD** Lưu trữ dataset có quyền truy cập theo vai trò, mã hoá at-rest, nhật ký truy cập; dataset có PII chỉ trong môi trường được phê duyệt. · Nguồn: [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md)
- [ ] `AI-DATA-014` **SHOULD** Dữ liệu từ production vào dataset chỉ qua pipeline che PII + lấy mẫu + duyệt; không copy log thô.
- [ ] `AI-DATA-015` **SHOULD** Ghi chi phí fine-tune (huấn luyện + phục vụ) so với prompt/RAG và đo lại sau 3 tháng khi model nền nâng cấp; model nền mới có thể xoá lợi thế. · Nguồn: [`observability-and-cost.md`](observability-and-cost.md)
- [ ] `AI-DATA-016` **MAY** Dùng lakeFS khi dữ liệu ở object store lớn cần nhánh/commit/rollback kiểu git; DVC khi dữ liệu vừa và pipeline chạy cạnh repo.
- [ ] `AI-DATA-017` **MAY** Đánh giá thiên lệch (bias) theo nhóm trên holdout khi tác vụ ảnh hưởng tới người (tuyển dụng, tín dụng, y tế); tham chiếu [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Fine-tune để "dạy kiến thức mới" | Vẫn bịa, tốn tiền; RAG rẻ hơn | RAG trước |
| Dataset "latest" trong bucket | Không tái tạo được kết quả | Hash + DVC/lakeFS |
| Log production đổ thẳng vào tập huấn luyện | PII, injection, nhiễu | Pipeline che + duyệt |
| Holdout rò vào train | Điểm cao giả | Dedup hash/near-dup |
| Không regression trên tác vụ khác | Fine-tune làm hỏng việc khác | Regression eval |
| Dữ liệu web không rõ giấy phép | Rủi ro pháp lý, phải gỡ model | Datasheet có giấy phép |
| Không lineage mẫu → model | Không xử lý được yêu cầu xoá | Lineage + runbook |
| Quên đo lại khi model nền nâng cấp | Trả tiền phục vụ model fine-tune đã thua model nền | Đo lại định kỳ |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Version dataset | `dvc status`/`dvc repro` hoặc lakeFS commit | CI pipeline dữ liệu | Không có thay đổi chưa commit |
| PII | Presidio scan trên dataset mới | CI | 0 hoặc có quyết định ghi nhận |
| Dedup/rò tập | Script hash/near-dup | CI | 0 trùng giữa tập |
| Datasheet | Lint file datasheet đủ trường | CI | Đủ 8 trường |
| Eval trước/sau fine-tune | Job eval holdout + regression | Trước deploy | Không giảm quá ngưỡng baseline |

## Nguồn

- DVC (version dữ liệu/pipeline/experiment): <https://doc.dvc.org/> · PyPI `dvc` 3.67.1 (2026-03-31) <https://pypi.org/project/dvc/> — xác minh 2026-10-13.
- lakeFS v1.88.0: <https://github.com/treeverse/lakeFS/releases> — xác minh 2026-10-13 (trang release hiển thị "01 Oct", năm không hiển thị — (chưa xác minh) năm).
- Presidio / Data Privacy Stack: <https://presidio.dataprivacystack.org/> · PyPI `presidio-analyzer` 2.2.364 (2026-07-22) — xác minh 2026-10-13.
- Datasheets for Datasets (Gebru et al., CACM 2021): <https://cacm.acm.org/research/datasheets-for-datasets/> — xác minh 2026-10-13 (khái niệm datasheet).
- NIST AI 600-1 Generative AI Profile (2024-07-26, rủi ro dữ liệu huấn luyện/privacy/IP): <https://www.nist.gov/itl/ai-risk-management-framework> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §5). EU AI Act Reg. (EU) 2024/1689 nghĩa vụ dữ liệu: <https://eur-lex.europa.eu/eli/reg/2024/1689/oj> — (chưa xác minh — trang trả nội dung rỗng ngày 2026-10-13; xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md)).
