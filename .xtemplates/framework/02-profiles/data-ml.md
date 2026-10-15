---
title: Data pipeline / ML system
kind: profile
slug: data-ml
prefix: PRF-DATA
modules: [04-standards/*, 05-architecture/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 13-ai-engineering/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Data pipeline / ML system

> Hệ thống mà **dữ liệu là sản phẩm**: pipeline ETL/ELT, kho dữ liệu, feature, huấn luyện và phục vụ mô hình ML.
> Cổng chất lượng thay a11y/CWV bằng **lũy đẳng, hợp đồng dữ liệu, lineage, tái lập được, eval mô hình, giám sát
> drift và bảo vệ PII**. Ứng dụng LLM/agent dùng hồ sơ `ai-agent`; hồ sơ này ghép thêm khi có pipeline dữ liệu/fine-tuning.

## Khi nào dùng

- Pipeline batch/stream nạp, biến đổi, xuất dữ liệu cho báo cáo, sản phẩm hoặc mô hình.
- Huấn luyện, đăng ký, triển khai và giám sát mô hình ML (dự đoán, phân loại, gợi ý, embedding).
- Fine-tuning/đánh giá mô hình ngôn ngữ (ghép với [`../13-ai-engineering/data-and-fine-tuning.md`](../13-ai-engineering/data-and-fine-tuning.md)).
- **Không** dùng cho: API thuần không có pipeline (→ `api-service`), dashboard UI (→ `web-app` + ghép hồ sơ này).

## Kiến trúc tham chiếu

```text
[Nguồn: DB app · event stream · file · API ngoài]
        │ ingest (lũy đẳng, theo partition, data contract ở biên)
        ▼
[Raw/bronze] → [Validated/silver] → [Curated/gold]      ← Great Expectations / pandera ở mỗi cổng
        │ orchestrator (Dagster/Airflow) · dbt cho SQL · lineage (manifest / OpenLineage)
        ├──────────────► [Feature store / feature định nghĩa một nơi] ──► [Train job: seed + data hash + lock]
        │                                                                      │
        ▼                                                                      ▼
[BI / sản phẩm dữ liệu]                                   [Model registry (MLflow): version · metrics · model card]
                                                                               │ promote qua cổng eval
                                                                               ▼
                                                     [Serving: batch / online API] → [Drift & quality monitor (Evidently)]
```

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** (PyPI/endoflife.date) — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Ngôn ngữ | Python | 3.14.8 (3.15.0 ra 2026-10-09 — chờ vá; kiểm tương thích wheel ML) | Scala/Java khi đã có Spark; SQL thuần qua dbt |
| Gói/lint | uv + ruff | uv 0.13.0 · ruff 0.17.0 (2026-10-09) | — |
| DataFrame | Polars (hiệu năng) · pandas (hệ sinh thái) | polars 2.0.0 (2026-10-06 — bản `x.0.0`, né cho production tới bản vá) | Spark/Dask khi vượt bộ nhớ một máy |
| Biến đổi SQL | dbt-core | 1.12.5 (2026-09-15); 2.0.0rc8 **pre-release**, chưa dùng production | SQLMesh |
| Orchestrator | Dagster (asset-based, lineage sẵn) | 1.13.26 (2026-10-09) | Apache Airflow 3.3.2 (2026-09-17) khi đội đã quen; Prefect |
| Validation dữ liệu | pandera (schema code) · Great Expectations (suite, docs) | pandera 0.34.1 (2026-10-06) · great-expectations 1.24.0 (2026-10-07) | Soda; dbt tests cho SQL |
| Version dữ liệu/model | DVC | 3.67.1 (2026-03-31) | lakeFS; Delta/Iceberg time travel |
| Thư viện ML | scikit-learn · PyTorch | scikit-learn 1.9.1 (2026-09-10) · torch 2.14.1 (2026-09-30) | XGBoost/LightGBM cho bảng |
| Tracking + registry | MLflow | 3.17.0 (2026-10-07; Linux Foundation) | Weights & Biases (SaaS) |
| Feature store | Feast (khi ≥ 2 mô hình dùng chung feature) | 0.66.0 (2026-08-21) | Bảng feature + hàm dùng chung nếu nhỏ |
| Drift/monitor | Evidently | 0.7.23 (2026-09-11) | whylogs; metric tự tính + dashboard |
| Serving | FastAPI (online) · job batch | fastapi 0.143.0 (2026-10-08) | BentoML, KServe khi nhiều mô hình |
| CSDL | PostgreSQL | 18.6 (2026-08-11) | Kho cột (BigQuery/ClickHouse/DuckDB) cho phân tích |

## Checklist

- [ ] `PRF-DATA-001` **MUST** Mỗi job pipeline lũy đẳng: chạy lại cùng đầu vào/partition cho cùng kết quả (ghi đè partition hoặc merge theo khoá), không nhân đôi bản ghi. → Kiểm: test chạy job 2 lần trên cùng partition → số dòng và checksum đầu ra không đổi.
- [ ] `PRF-DATA-002` **MUST** Mỗi dataset giao tiếp giữa đội/hệ có **data contract** (schema, kiểu, ràng buộc, chủ sở hữu, SLA tươi mới) trong repo; thay đổi phá vỡ bị CI chặn. → Kiểm: file contract (dbt `contract: enforced` / pandera schema / JSON Schema) + job CI diff schema fail khi xoá cột/đổi kiểu.
- [ ] `PRF-DATA-003` **MUST** Validation dữ liệu chạy **trong** pipeline ở cổng nạp và trước khi publish: null, miền giá trị, duy nhất khoá, tươi mới, khối lượng; fail → không publish. → Kiểm: suite GX/pandera là bước của DAG; test bơm dữ liệu xấu → job fail, bảng gold không đổi.
- [ ] `PRF-DATA-004` **MUST** Lineage đầy đủ: mọi bảng/model biết upstream và code sinh ra nó. → Kiểm: `dbt docs generate` manifest không có node mồ côi, hoặc Dagster asset graph/OpenLineage event cho mọi asset.
- [ ] `PRF-DATA-005` **MUST** Tái lập được: seed cố định, lockfile (`uv.lock`), phiên bản dữ liệu (hash DVC/lakeFS), commit code; run huấn luyện ghi đủ ba thứ. → Kiểm: MLflow run có tag `git_commit`, `data_hash`, `seed`; huấn luyện lại 2 lần → metric chênh trong ngưỡng ADR.
- [ ] `PRF-DATA-006` **MUST** Mô hình đi qua **registry** có phiên bản, metric eval, model card; chỉ promote lên production khi qua cổng eval do code kiểm. → Kiểm: bước CD promote đọc metric từ registry và fail khi dưới ngưỡng; model card tồn tại cho model production.
- [ ] `PRF-DATA-007` **MUST** Tập eval holdout cố định, không rò vào train; eval chạy lại trong CI khi đổi code/data/tham số. → Kiểm: test giao của hash bản ghi train ∩ eval = ∅; job CI `eval` xuất báo cáo metric theo commit.
- [ ] `PRF-DATA-008` **MUST@M** Giám sát drift đầu vào và phân phối dự đoán, chất lượng (khi có nhãn trễ), kèm cảnh báo ngưỡng đã thử kích. → Kiểm: báo cáo Evidently định kỳ + alert rule; log diễn tập alert.
- [ ] `PRF-DATA-009` **MUST** PII: phân loại cột, mask/giả danh ở môi trường non-prod, không PII thô trong feature store/log/artifact huấn luyện; kiểm soát truy cập theo [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md). → Kiểm: tag cột PII trong catalog + scan artifact xuất (vd Presidio) 0 PII; test môi trường staging chỉ chứa dữ liệu đã mask. · Nguồn: Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP (xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md))
- [ ] `PRF-DATA-010` **MUST** Feature tính bằng **một** đường code cho cả train và serve (feature store hoặc module dùng chung) để tránh train/serve skew. → Kiểm: test so sánh giá trị feature offline vs online cho cùng khoá → bằng nhau trong sai số.
- [ ] `PRF-DATA-011` **MUST** Backfill/xử lý lại an toàn: theo partition, có giới hạn phạm vi, có `--dry-run`, không khoá bảng production. → Kiểm: lệnh backfill có tham số phạm vi bắt buộc và dry-run in kế hoạch; test dry-run không ghi.
- [ ] `PRF-DATA-012` **MUST** Notebook không phải code production: logic chuyển vào package có test; notebook commit không chứa output. → Kiểm: hook `nbstripout` trong pre-commit; coverage đo trên package, không trên notebook.
- [ ] `PRF-DATA-013` **MUST** Mô hình/artifact tải về hoặc phát hành dùng định dạng an toàn (safetensors/ONNX), không `pickle` từ nguồn không tin; quét artifact trước khi nạp. → Kiểm: lint cấm `torch.load` không `weights_only=True`/`pickle.load` trên file ngoài; scanner model trong CI. · Nguồn: OWASP LLM 2026 LLM04 Supply Chain
- [ ] `PRF-DATA-014` **SHOULD** DAG có retry + timeout từng task, cảnh báo SLA miss; không cron thủ công ngoài orchestrator. → Kiểm: mọi task khai `retries`, `timeout`; alert SLA cấu hình trong repo.
- [ ] `PRF-DATA-015` **SHOULD** Chỉ số chất lượng dữ liệu (freshness, completeness, tỷ lệ fail validation) phát ra như metric và có SLO. → Kiểm: dashboard + SLO ở [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md).
- [ ] `PRF-DATA-016` **SHOULD** Chi phí mỗi lần chạy pipeline/huấn luyện (compute, GPU giờ, lưu trữ) được ghi và có ngân sách. → Kiểm: tag chi phí theo job; báo cáo tháng (phương pháp → [`../15-operations/cost-management.md`](../15-operations/cost-management.md)).
- [ ] `PRF-DATA-017` **SHOULD** Serving online: validate schema đầu vào, endpoint có phiên bản mô hình trong phản hồi, canary khi đổi mô hình, p95 latency có ngưỡng. → Kiểm: contract test endpoint; header/trường `model_version`; k6 threshold.
- [ ] `PRF-DATA-018` **SHOULD** Môi trường huấn luyện đóng gói (container ghim CUDA/driver/thư viện) và chạy được trên CI runner nhỏ với dữ liệu mẫu. → Kiểm: job CI `train --smoke` trên 1% dữ liệu xanh.
- [ ] `PRF-DATA-019` **MUST@L** Mô hình trong lĩnh vực rủi ro cao (y tế, tín dụng, tuyển dụng, dịch vụ công) có hồ sơ quản trị: mục đích, dữ liệu, đánh giá thiên lệch, giám sát người. → Kiểm: tài liệu theo [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) được review ký. · Nguồn: EU AI Act Annex III (áp dụng 2027-12-02 theo Digital Omnibus — xem research AI agent 2026-10-13)
- [ ] `PRF-DATA-020` **MAY** Dữ liệu tổng hợp (synthetic) cho test/dev; DVC pipelines; lakehouse (Iceberg/Delta) khi khối lượng lớn. → Kiểm: ADR ghi lựa chọn.

## Cổng chất lượng tương đương

| Cổng chung | Tương đương data/ML | Công cụ |
|---|---|---|
| Core Web Vitals | Freshness SLA, thời gian chạy pipeline, p95 latency serving | Orchestrator SLA, k6 |
| E2E trình duyệt | Chạy pipeline end-to-end trên dữ liệu mẫu + eval mô hình | CI job `pipeline --sample`, `eval` |
| A11y | Data contract + model card + tài liệu dataset (ai dùng được, hiểu được) | dbt docs, MLflow model card |
| Type check | Schema validation (pandera/GX) + kiểu cột trong contract | pandera, dbt contract |
| Coverage | Coverage trên package + tỷ lệ cột có test validation | pytest-cov, dbt test coverage |
| Lighthouse CI | Báo cáo eval + drift theo commit, so với baseline | MLflow, Evidently |

## Bẫy

1. **Pipeline "append" không khoá** — chạy lại nhân đôi dữ liệu; luôn ghi theo partition/merge (PRF-DATA-001).
2. **Rò holdout vào train** qua join/feature tính trên toàn tập — metric đẹp giả; kiểm giao hash (PRF-DATA-007).
3. **Train/serve skew** vì feature viết lại bằng SQL ở serving — PRF-DATA-010.
4. **Notebook là production** — không test, output chứa PII commit lên git (PRF-DATA-012).
5. **`pickle`/`torch.load` artifact từ hub** — thực thi mã tuỳ ý; dùng safetensors (PRF-DATA-013).
6. **Dữ liệu production copy nguyên sang dev** — vi phạm Luật 91/2025/QH15 (xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)); mask trước (PRF-DATA-009).
7. **Chỉ đo accuracy lúc release** — không drift monitor; mô hình "mục" âm thầm (PRF-DATA-008).
8. **Phiên bản `x.0.0`** (polars 2.0.0, dbt 2.0 rc) kéo vào production ngay — chờ bản vá, ghim lock.
9. **Benchmark tự công bố** của vendor (vector DB, feature store) làm cơ sở chọn — đo trên dữ liệu của mình (luật 11 chống ảo giác).
10. **Backfill toàn bảng không giới hạn** làm nghẽn DB production — bắt buộc phạm vi + dry-run (PRF-DATA-011).

## Nguồn

- Phiên bản gói: <https://pypi.org/project/dbt-core/>, `apache-airflow`, `dagster`, `torch`, `mlflow`, `great-expectations`, `pandera`, `dvc`, `polars`, `scikit-learn`, `feast`, `evidently`, `fastapi`, `uv`, `ruff` (trang project + `/pypi/<pkg>/<ver>/json`) — xác minh 2026-10-13
- Python/PostgreSQL: <https://endoflife.date/api/python.json>, <https://endoflife.date/api/postgresql.json> — xác minh 2026-10-13
- OWASP Top 10 for LLM Applications 2026 (LLM04 Supply Chain, LLM05 Data and Model Poisoning; bản 2025 là LLM03/LLM04 — bảng đổi mã ở [`../12-security/ai-security.md`](../12-security/ai-security.md)): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14
- EU AI Act + Digital Omnibus (EU) 2026/1744 (Annex III → 02/12/2027): mốc ở nhà [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md)
- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 + NĐ 356/2025/NĐ-CP (hiệu lực 01/01/2026, thay NĐ 13/2023/NĐ-CP) — xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) (số hiệu, hiệu lực, điều khoản)
- Khung cũ X-stored PHẦN C7 (commit `1b80fe4`); `research/2026-10-13-stored-catalog-extraction.md` §2.13 (benchmark vendor không đáng tin), §3 (công cụ nên dùng/tránh).
