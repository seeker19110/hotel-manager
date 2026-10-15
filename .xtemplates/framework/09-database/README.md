---
title: Cơ sở dữ liệu
kind: index
updated: 2026-10-14
---

# 09 — Cơ sở dữ liệu

> Bảy module cho mọi hồ sơ có dữ liệu bền: mô hình đúng từ kiểu, migration an toàn, hiệu năng bằng số đo, giao dịch
> đúng dưới đồng thời, sao lưu đã diễn tập, kiểm soát dữ liệu nhạy cảm ở tầng CSDL, tìm kiếm/vector bắt đầu trong
> PostgreSQL. PostgreSQL 18 là tham chiếu mặc định; MySQL 8.4 LTS, SQLite, MongoDB, Redis/Valkey, Meilisearch,
> OpenSearch có ghi điều kiện và giấy phép. Phiên bản xác minh 2026-10-13 — xác minh lại trước khi dùng.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`data-modeling.md`](data-modeling.md) | Chọn CSDL, PK `bigint identity`/UUIDv7, `timestamptz`, tiền số nguyên (`numeric` chỉ khi có ADR), ràng buộc ở CSDL, soft-delete có điều kiện, audit cột, JSONB có kiểm | G4 khi thiết kế schema; review mọi migration tạo bảng mới; brownfield khi audit schema |
| [`migrations.md`](migrations.md) | Migration có phiên bản, lũy đẳng, `lock_timeout`, `CONCURRENTLY`, `NOT VALID`, expand/contract, đường lùi, công cụ theo stack (Atlas, Flyway, Liquibase, Prisma, Drizzle, Alembic, golang-migrate, Supabase CLI) | G5 khi dựng pipeline migrate; mỗi PR đổi schema; trước deploy chạm dữ liệu |
| [`indexing-and-query-performance.md`](indexing-and-query-performance.md) | `EXPLAIN (ANALYZE, BUFFERS)`, index composite/partial/covering, N+1, pool và PgBouncer, `pg_stat_statements`, vacuum, keyset | G6 cho endpoint lõi; khi p95 vượt SLO; trước kiểm tải |
| [`transactions-and-consistency.md`](transactions-and-consistency.md) | Mức cô lập, retry `40001`, `FOR UPDATE`/`SKIP LOCKED`, advisory lock, UNIQUE cho idempotency, nhất quán cuối | Mọi luồng tiền/kho/hạn mức/hàng đợi; khi có bug "trùng"/"âm" |
| [`backup-and-recovery.md`](backup-and-recovery.md) | PITR (base backup + WAL), pgBackRest/WAL-G, `pg_dump` đúng vai trò, SQLite/MySQL, RPO/RTO đã đo, diễn tập định kỳ, backup bất biến | G5 (bật backup), G7 (đã khôi phục thử trước ra mắt), G8 (diễn tập) |
| [`sensitive-data-and-access.md`](sensitive-data-and-access.md) | Phân loại cột, vai trò tối thiểu, TLS `verify-full`, RLS `FORCE`, mã hoá cột với KMS, mặt nạ cho dev, xoá theo yêu cầu, audit | G4 threat model dữ liệu; mọi bảng có PII/tenant; trước GO/NO-GO |
| [`search-and-vector.md`](search-and-vector.md) | FTS PostgreSQL + `unaccent`/`pg_trgm` cho tiếng Việt, Meilisearch/OpenSearch, pgvector HNSW đến ngưỡng, hybrid RRF + rerank, eval chất lượng, index tái dựng được | Khi có tính năng tìm kiếm hoặc RAG; khi chọn kho vector |
