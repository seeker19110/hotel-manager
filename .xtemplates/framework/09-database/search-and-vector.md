---
title: Tìm kiếm toàn văn, vector, hybrid, phân trang kết quả
kind: module
prefix: DB-SEARCH
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-16
---

# Tìm kiếm toàn văn, vector, hybrid, phân trang kết quả

> Chọn và vận hành **kho tìm kiếm**: full-text trong PostgreSQL (tsvector + `unaccent` + `pg_trgm`, đủ cho phần lớn
> dự án tiếng Việt), Meilisearch cho tìm kiếm tức thì/typo, OpenSearch cho quy mô lớn/log/hybrid; vector bằng
> pgvector trong Postgres đến ngưỡng vận hành, rồi mới tách; hybrid BM25 + vector + RRF + rerank; index là dẫn xuất
> tái dựng được. Pipeline RAG (chunking, embedding, eval, lọc theo quyền) là của
> [`../13-ai-engineering/rag-and-knowledge.md`](../13-ai-engineering/rag-and-knowledge.md).

## Nguyên tắc

1. **Index tìm kiếm là dẫn xuất.** Nguồn sự thật là CSDL giao dịch; index tái dựng được bằng một lệnh và đồng bộ qua
   outbox/CDC, không ghi hai nơi trong một request.
2. **Bắt đầu trong Postgres.** FTS + trigram + pgvector trong cùng CSDL loại bỏ một hệ phải vận hành, cho phép lọc theo
   quyền/tenant bằng cùng `WHERE`/RLS. Chỉ tách khi đo thấy không đạt.
3. **Tiếng Việt cần `unaccent` + cấu hình `simple`/trigram**: PostgreSQL không có stemmer tiếng Việt; Meilisearch
   không có tokenizer chuyên biệt tiếng Việt (dùng pipeline Latin mặc định) — luôn test chất lượng trên dữ liệu
   thật.
4. **Hybrid trước GraphRAG.** BM25 + vector + RRF + rerank + lọc theo quyền giải quyết phần lớn ca; GraphRAG tốn chi
   phí lúc index (catalog 10 §3b).
5. **Benchmark vendor không phải bằng chứng** (catalog 10 §2): recall/latency đo trên dữ liệu và truy vấn của mình.
6. **Kết quả tìm kiếm tôn trọng quyền**: lọc theo tenant/ACL **trước** khi xếp hạng (pre-filter) hoặc dùng iterative
   scan; không lọc sau top-k rồi trả thiếu.
7. **Phân trang kết quả xếp hạng có giới hạn độ sâu**; không `OFFSET` lớn trên truy vấn vector/FTS.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Tìm từ khoá trong vài chục nghìn–vài triệu bản ghi, cần lọc theo quyền/tenant | **PostgreSQL FTS**: cột `tsvector` generated + GIN, cấu hình `unaccent` + `simple` (tiếng Việt) hoặc `<lang>_stem`; `pg_trgm` GIN cho `ILIKE '%…%'`/tìm mờ | Cần typo tolerance, facet, phản hồi "as-you-type" phức tạp → Meilisearch |
| Tìm kiếm sản phẩm/tài liệu "tức thì", typo, facet, nhỏ–vừa | **Meilisearch 1.55.0** (MIT) | Không có tokenizer tiếng Việt chuyên biệt — test; cụm lớn nhiều node → OpenSearch |
| Quy mô lớn, log/analytics, hybrid có pipeline, nhiều node | **OpenSearch 3.9.0** (Apache-2.0; hybrid query ≤ 5 sub-query + normalization/score-ranker RRF) | Elasticsearch 9.5.5 (AGPL-3.0 / SSPL / ELv2 chọn một — kiểm giấy phép khi phân phối lại) |
| Vector ≤ ~10–50 triệu, cần join/lọc với dữ liệu giao dịch | **pgvector 0.8.7** (PostgreSQL License) HNSW (`m=16`, `ef_construction=64`, `hnsw.ef_search=40` mặc định), `halfvec` khi > 2 000 chiều (tới 4 000), `hnsw.iterative_scan` khi lọc chọn lọc | > ngưỡng (catalog 10 §2: ma sát vận hành 10–50M; pgvectorscale cải thiện — giấy phép chưa xác minh) → kho vector chuyên dụng (Qdrant/Milvus/Weaviate — phiên bản chưa xác minh) |
| Bộ nhớ nhỏ cho agent/công cụ cục bộ | **SQLite FTS5** (catalog 10 §4: đủ cho bộ nhớ nhỏ, X-Agents/dhcb chọn không pgvector) | Nhiều người dùng đồng thời → Postgres |
| Hybrid | **RRF** (Reciprocal Rank Fusion) giữa BM25/FTS và vector, rồi **rerank** cross-encoder top-k nhỏ | Chỉ một tín hiệu khi đo thấy đủ |
| Phân trang | Keyset theo `(score, id)` hoặc `search_after`; giới hạn độ sâu (`pagination_depth`/`max_result_window`) | `OFFSET` sâu |

## Checklist

- [ ] `DB-SEARCH-001` **MUST** Index tìm kiếm/vector tái dựng được từ nguồn sự thật bằng một lệnh; thời gian tái dựng đo và ghi. → Kiểm: `scripts/reindex.*` tồn tại; test CI tái dựng trên dữ liệu mẫu rồi truy vấn mẫu trả đúng; thời gian trong `docs/ops/RPO-RTO.md`. · Nguồn: P5 · [`backup-and-recovery.md`](backup-and-recovery.md) DB-BACKUP-018
- [ ] `DB-SEARCH-002` **MUST** Đồng bộ CSDL → index (ngoài Postgres) đi qua outbox/CDC hoặc job lũy đẳng; không ghi index trong cùng request ghi CSDL. → Kiểm: grep client search không nằm trong transaction/handler ghi; test tắt search engine → ghi CSDL vẫn thành công, index bắt kịp sau. · Nguồn: [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md) ARC-INT-003
- [ ] `DB-SEARCH-003` **MUST** Kết quả tìm kiếm chỉ chứa bản ghi người dùng có quyền thấy: lọc tenant/ACL ở truy vấn (pre-filter) hoặc index theo tenant; không lọc sau top-k. → Kiểm: test người dùng A tìm từ khoá chỉ có trong dữ liệu B → 0 kết quả; với pgvector có lọc: `hnsw.iterative_scan` bật hoặc partial index theo tenant. · Nguồn: pgvector README (filtering/iterative scan) · [`sensitive-data-and-access.md`](sensitive-data-and-access.md)
- [ ] `DB-SEARCH-004` **MUST** FTS PostgreSQL dùng cột `tsvector` lưu sẵn (generated/trigger) + GIN; truy vấn dùng đúng cấu hình với cột; không `to_tsvector()` tính lại mỗi truy vấn trên bảng lớn. → Kiểm: schema có cột `search_vector tsvector GENERATED ALWAYS AS (...) STORED` + `USING GIN`; EXPLAIN truy vấn tìm kiếm dùng Bitmap Index Scan. · Nguồn: PostgreSQL 18 §12 Full Text Search
- [ ] `DB-SEARCH-005` **MUST@L** Tiếng Việt: chuẩn hoá dấu bằng `unaccent` (filtering dictionary) trong cấu hình text search (`to_tsvector('vi'::regconfig, …)` hai tham số là IMMUTABLE, dùng được cho cột generated/index) hoặc index biểu thức qua hàm bọc IMMUTABLE `f_unaccent` — **không** `unaccent(lower(...))` trực tiếp: hàm của extension là STABLE, PostgreSQL báo `functions in index expression must be marked IMMUTABLE` / `generation expression is not immutable`; tìm mờ bằng `pg_trgm`; chất lượng kiểm trên bộ truy vấn mẫu tiếng Việt. → Kiểm: `CREATE TEXT SEARCH CONFIGURATION vi (COPY = simple)` + `ALTER … ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple`; migration tạo index chạy được trên Postgres thật; test "Nguyen Van A" khớp "Nguyễn Văn A"; bộ truy vấn `tests/search/vi-queries.json` với recall ≥ ngưỡng đội chốt. · Nguồn: PostgreSQL 18 unaccent, pg_trgm · Meilisearch language docs (không có pipeline tiếng Việt chuyên biệt)
- [ ] `DB-SEARCH-006` **MUST@L** Chất lượng tìm kiếm có bộ đánh giá offline (truy vấn → kết quả mong đợi) với recall@k/MRR đo trước–sau mọi thay đổi index/embedding/rerank; không đổi cấu hình theo cảm tính. → Kiểm: `tests/search/eval.*` chạy trong CI hoặc theo lịch, báo cáo lưu; PR đổi cấu hình kèm số trước–sau. · Nguồn: catalog 10 §2 (benchmark vendor mâu thuẫn → đo trên dữ liệu mình) · [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md)
- [ ] `DB-SEARCH-007` **MUST@L** Vector: chiều, model embedding, khoảng cách (cosine/L2/IP) và phiên bản model ghi trong schema/metadata của index; đổi model → tái embed toàn bộ, không trộn. → Kiểm: bảng có cột `embedding_model`/`embedding_version`; test từ chối chèn vector sai chiều; script tái embed. · Nguồn: pgvector README (dimension ≤ 2 000 cho `vector`, 4 000 `halfvec`)
- [ ] `DB-SEARCH-008` **MUST@L** Vector trên pgvector dùng HNSW (không IVFFlat khi dữ liệu còn tăng), tham số và `ef_search` ghi rõ; recall đo so với exact search trên mẫu. → Kiểm: `\d+` cho index `hnsw`; script so top-k HNSW vs exact (`SET enable_indexscan = off`) → recall ≥ ngưỡng đội chốt (ghi nguồn). · Nguồn: pgvector README (HNSW vs IVFFlat; exact search mặc định không index)
- [ ] `DB-SEARCH-009` **MUST@L** Quy mô vector được theo dõi; khi vượt ngưỡng đã ghi (catalog: ma sát vận hành 10–50M vector trên pgvector) hoặc p95 vượt SLO → ADR cân nhắc tách kho vector, không tự ý. → Kiểm: metric số vector + p95 truy vấn; ADR khi vượt ngưỡng. · Nguồn: catalog 10 §2 · [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)
- [ ] `DB-SEARCH-010` **SHOULD** Hybrid: kết hợp FTS/BM25 và vector bằng RRF (hoặc normalization + combination ở OpenSearch), rerank cross-encoder cho top-k nhỏ; bật/tắt từng tầng được để đo đóng góp. → Kiểm: cấu hình có cờ `hybrid.enabled`, `rerank.enabled`; eval DB-SEARCH-006 chạy 3 biến thể. · Nguồn: pgvector README (hybrid search + RRF/cross-encoder) · OpenSearch hybrid query · catalog 10 §3b
- [ ] `DB-SEARCH-011` **SHOULD** Phân trang kết quả xếp hạng bằng `search_after`/keyset `(score, id)` và giới hạn độ sâu; không `OFFSET` sâu trên truy vấn vector/FTS. → Kiểm: hợp đồng API có cursor; test trang sâu bị từ chối hoặc giới hạn; OpenSearch `pagination_depth` ≤ `max_result_window`. · Nguồn: OpenSearch hybrid query (`pagination_depth`) · DB-PERF-009
- [ ] `DB-SEARCH-012` **SHOULD** Độ trễ đồng bộ index (CSDL → index) là metric có cảnh báo; giao diện ghi rõ khi dữ liệu có thể trễ. → Kiểm: metric `search_index_lag_seconds`; cảnh báo; test đo độ trễ trong tích hợp. · Nguồn: ARC-INT-014
- [ ] `DB-SEARCH-013` **SHOULD** Index chỉ chứa trường cần hiển thị/lọc; PII không vào index trừ khi có cùng kiểm soát (RLS/ACL/mã hoá). → Kiểm: schema index/`searchableAttributes` so với `data_catalog` (DB-SEC-018). · Nguồn: [`sensitive-data-and-access.md`](sensitive-data-and-access.md)
- [ ] `DB-SEARCH-014` **SHOULD** Truy vấn người dùng được chuẩn hoá qua `plainto_tsquery`/`websearch_to_tsquery` (không `to_tsquery` với chuỗi thô) để tránh lỗi cú pháp/injection cú pháp. → Kiểm: grep `to_tsquery(` với input người dùng = 0; test ký tự đặc biệt không gây lỗi 500. · Nguồn: PostgreSQL 18 §12.3 Controlling Text Search
- [ ] `DB-SEARCH-015` **SHOULD** Nạp/tái embed theo lô với giới hạn đồng thời và ngân sách chi phí (API embedding tính tiền); kết quả cache theo hash nội dung để không embed lại. → Kiểm: bảng `embedding_cache(content_hash, model, vector)`; test nội dung không đổi → 0 lần gọi API. · Nguồn: catalog 23 (render cache SHA-256; gọi lại = 0 khi cache hợp lệ)
- [ ] `DB-SEARCH-016` **SHOULD** Giấy phép của engine tìm kiếm được ghi trong ADR/bảng phụ thuộc: OpenSearch Apache-2.0; Meilisearch MIT; Elasticsearch AGPL/SSPL/ELv2; Redis Search theo tri-license Redis 8. → Kiểm: `docs/adr/*` hoặc SBOM/bảng license có mục này (xem [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)). · Nguồn: LICENSE của từng dự án (Nguồn)
- [ ] `DB-SEARCH-017` **MAY** Binary quantization/`halfvec` để giảm kích thước index ở quy mô lớn, luôn rerank bằng vector gốc. → Kiểm: index trên `bit`/`halfvec` + bước rerank; recall đo lại.
- [ ] `DB-SEARCH-018` **MAY** SQLite FTS5 cho công cụ cục bộ/bộ nhớ agent nhỏ; nâng lên Postgres khi nhiều người dùng. → Kiểm: bảng FTS5 virtual; ADR khi chuyển.
- [ ] `DB-SEARCH-019` **MAY** Gợi ý/autocomplete bằng `pg_trgm` GIN hoặc Meilisearch prefix thay vì vector cho truy vấn ngắn. → Kiểm: endpoint autocomplete có p95 riêng trong eval.
- [ ] `DB-SEARCH-020` **MUST@L** Mọi thành phần tìm kiếm/RAG/memory, kể cả thư viện bên thứ ba, có bảng mặc định ngôn ngữ (text search config, embedding model, reranker, tokenizer); mặc định `english` hoặc model `-en` phải được thay, hoặc ghi lý do (ADR). Pipeline tiền xử lý (NFC, tách từ, bỏ dấu) có phiên bản và giống hệt nhau lúc index và lúc query. → Kiểm: test truy vấn tiếng Việt chạy qua đúng đường code của thư viện (không gọi hàm nội bộ đi tắt); metadata index có `preprocess_version`, truy vấn từ chối khi lệch. · Nguồn: stored 10 §4d.2–4d.3 (Hindsight: mặc định `english` và `bge-small-en`), stored 18 §4c (PhoBERT cần tách từ; embedding tiếng Việt chỉ benchmark trên một miền)

## Bẫy thường gặp

- **Ghi index trong cùng request với ghi CSDL** → lệch khi một bên lỗi. Tránh: DB-SEARCH-002 (outbox).
- **Lọc theo quyền sau top-k** → người dùng nhận ít/không kết quả dù có dữ liệu; hoặc rò tiêu đề của tenant khác. Tránh: DB-SEARCH-003.
- **`to_tsvector()` trong `WHERE` mỗi truy vấn** → Seq Scan + tính lại. Tránh: cột generated + GIN (DB-SEARCH-004).
- **Tiếng Việt với cấu hình `english`** → stem sai, dấu không khớp. Tránh: `simple` + `unaccent` + trigram, test trên truy vấn thật (DB-SEARCH-005).
- **`unaccent()` trực tiếp trong index biểu thức/cột generated** → migration lỗi `must be marked IMMUTABLE` (hàm là STABLE; đã tái hiện trên PostgreSQL 17, 2026-10-16). Tránh: cấu hình text search `vi` có `unaccent`, hoặc hàm bọc `CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$`.
- **IVFFlat tạo khi bảng rỗng** → danh sách rỗng, recall tệ; **HNSW không đo recall** → "nhanh" nhưng sai. Tránh: DB-SEARCH-008.
- **Trộn vector từ hai model** trong một cột → khoảng cách vô nghĩa. Tránh: DB-SEARCH-007.
- **Chọn kho vector theo benchmark blog** (pgvector QPS cao nhất vs Qdrant recall cao nhất tuỳ nguồn — catalog 10 §2). Tránh: eval của mình (DB-SEARCH-006).
- **GraphRAG trước hybrid** → tốn chi phí index mà chưa chứng minh cần. Tránh: DB-SEARCH-010, catalog 10 §3b.
- **`OFFSET 10000` trên truy vấn vector** → quét/xếp hạng lại toàn bộ. Tránh: DB-SEARCH-011.
- **Elasticsearch "open source lại"** nhưng AGPL là một lựa chọn trong ba; bản phân phối có thể còn ELv2 (x-pack). Tránh: đọc LICENSE.txt, ghi ADR (DB-SEARCH-016).
- **Thư viện bên thứ ba mang mặc định tiếng Anh** (`english` stem, embedding/reranker `-en`) → nội dung tiếng Việt bị stem/embed sai mà không báo lỗi. Tránh: bảng mặc định ngôn ngữ + test truy vấn tiếng Việt qua đường code thật; tiền xử lý index = query (`DB-SEARCH-020`).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Eval chất lượng tìm kiếm (recall@k, MRR) | script eval của dự án trên `tests/search/*.json` (FTS/vector/hybrid) | `python3 scripts/search-eval.py` | CI (dữ liệu mẫu) + theo lịch (dữ liệu thật ẩn danh) | không giảm so với baseline đã commit |
| Recall HNSW vs exact | pgvector 0.8.7 · PostgreSQL License | script so top-k với `enable_indexscan=off` | CI nightly | ≥ ngưỡng đội chốt |
| Plan FTS dùng GIN | `EXPLAIN (ANALYZE)` + script | như DB-PERF | CI | Bitmap Index Scan |
| Cách ly quyền trong kết quả | test tích hợp 2 tenant | `pytest tests/search/test_acl.py` | CI | 0 rò |
| Tái dựng index | `scripts/reindex.*` | CI trên mẫu | CI | exit 0, truy vấn mẫu đúng |
| Độ trễ đồng bộ | metric + cảnh báo | production | ≤ ngưỡng SLO |
| Chiều vector/model | ràng buộc `vector(n)` + cột model | test chèn sai chiều | CI | bị từ chối |
| Meilisearch/OpenSearch | Meilisearch 1.55.0 MIT · OpenSearch 3.9.0 Apache-2.0 (testcontainers) | test tích hợp | CI | xanh |
| Giấy phép engine | bảng license/SBOM (xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md)) | theo module đó | CI | không có license cấm |
| Mặc định ngôn ngữ + tiền xử lý | test truy vấn tiếng Việt qua đúng đường code thư viện; so `preprocess_version` index ↔ query | CI | mặc định `english`/`-en` chưa thay (hoặc chưa ghi lý do) = đỏ; lệch phiên bản = từ chối |

## Nguồn

- PostgreSQL 18 docs: §12 Full Text Search <https://www.postgresql.org/docs/current/textsearch-intro.html>; unaccent (filtering dictionary) <https://www.postgresql.org/docs/current/unaccent.html>; pg_trgm (GIN/GiST, LIKE/ILIKE) <https://www.postgresql.org/docs/current/pgtrgm.html> — xác minh 2026-10-13.
- Tái hiện 2026-10-16 trên PostgreSQL 17.x (extension `unaccent` 1.1 khai `LANGUAGE C STABLE`): index `lower(unaccent(col))` và cột generated `unaccent(...)` bị từ chối; hàm bọc IMMUTABLE và cấu hình text search `vi` có `unaccent` chạy được (phát hiện khi rà `seeker19110/stored` cho khung).
- pgvector 0.8.7 README (HNSW `m=16`/`ef_construction=64`/`ef_search=40`; IVFFlat lists/probes; `vector` ≤ 2 000, `halfvec` ≤ 4 000 chiều; iterative scan 0.8.0; hybrid + RRF/cross-encoder; Postgres 13+): <https://github.com/pgvector/pgvector/blob/master/README.md>; brew 0.8.7 PostgreSQL License — xác minh 2026-10-13.
- Meilisearch 1.55.0 MIT (brew; LICENSE repo: MIT và BUSL-1.1 cho một số phần — đọc trước khi tái phân phối): <https://formulae.brew.sh/api/formula/meilisearch.json>, <https://raw.githubusercontent.com/meilisearch/meilisearch/main/LICENSE>; ngôn ngữ (không có pipeline tiếng Việt chuyên biệt): <https://www.meilisearch.com/docs/learn/resources/language> — xác minh 2026-10-13.
- OpenSearch 3.9.0 Apache-2.0: <https://endoflife.date/api/opensearch.json>, <https://raw.githubusercontent.com/opensearch-project/OpenSearch/main/LICENSE.txt>; hybrid query (≤ 5 sub-query, `pagination_depth`, normalization/score-ranker): <https://docs.opensearch.org/latest/query-dsl/compound/hybrid/> — xác minh 2026-10-13.
- Elasticsearch 9.5.5: <https://endoflife.date/api/elasticsearch.json>; LICENSE.txt (AGPL-3.0 / SSPL v1 / ELv2; x-pack ELv2): <https://raw.githubusercontent.com/elastic/elasticsearch/main/LICENSE.txt> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 10 §2 (pgvector ma sát > 10–50M vector; pgvectorscale; benchmark mâu thuẫn → đo trên dữ liệu mình), 10 §3b (hybrid + rerank + lọc quyền trước GraphRAG), 10 §4 (SQLite FTS5 đủ cho bộ nhớ nhỏ; X-Agents không pgvector), 23 §4.1 (dhcb ADR-0015: FTS + `unaccent` + embedding, không pgvector vì không phải trusted extension) — đọc 2026-10-13. Mâu thuẫn nguồn ghi ở `research/2026-10-13-stored-catalog-extraction.md` ("không dùng pgvector" gán cho X-Agents ở 10 §4 và cho dhcb ở 23 §4.1 — cả hai repo đều chọn không dùng, không loại trừ nhau).
- pgvectorscale: giấy phép **(chưa xác minh — trang blog chuyển hướng sang tigerdata.com, chưa đọc ngày 2026-10-13)**; Qdrant/Milvus/Weaviate: phiên bản **(chưa xác minh)**.
- Catalog `seeker19110/stored` mục 10 §4d.2–4d.3 (vectorize-io/hindsight: embedding mặc định `BAAI/bge-small-en-v1.5`, reranker `ms-marco-MiniLM-L-6-v2`; full-text `native` mặc định ngôn ngữ `english` nên nội dung tiếng Việt bị stem theo tiếng Anh) và mục 18 §4c (PhoBERT: input cần tách từ trước, theo README, chưa tự kiểm; bi-encoder BKAI chủ yếu huấn luyện trên dữ liệu dịch máy, chỉ test trên dữ liệu pháp luật) — đọc 2026-10-16.
