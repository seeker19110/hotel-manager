---
title: Index, truy vấn, N+1, EXPLAIN, pool kết nối
kind: module
prefix: DB-PERF
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Index, truy vấn, N+1, EXPLAIN, pool kết nối

> Giữ CSDL nhanh **bằng số đo**: `EXPLAIN (ANALYZE, BUFFERS)` cho mọi truy vấn trên đường nóng, index composite /
> partial / covering theo truy vấn thật, chặn N+1 bằng test, pool kết nối có giới hạn (PgBouncer khi nhiều tiến
> trình), `pg_stat_statements` làm nguồn sự thật về truy vấn chậm. Mục tiêu p95 của API ở
> [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md); phương pháp đo
> chung ở [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md).

## Nguyên tắc

1. **Đo rồi mới index.** Index theo truy vấn thật (`pg_stat_statements`, log truy vấn chậm), không theo cảm giác;
   mỗi index tốn chi phí ghi và đĩa.
2. **Thứ tự cột composite theo truy vấn**: cột bằng (`=`) trước, rồi cột khoảng/sắp xếp; index `(a, b)` phục vụ
   `WHERE a = ?` nhưng không phục vụ `WHERE b = ?`.
3. **Partial index cho tập con nóng** (đơn chưa xử lý, bản ghi chưa xoá); **covering (`INCLUDE`)** để index-only scan
   khi truy vấn chỉ cần vài cột.
4. **N+1 là lỗi logic, không phải tối ưu**: test đếm số truy vấn cho mỗi endpoint/luồng và chặn tăng.
5. **Kết nối là tài nguyên khan hiếm**: mỗi tiến trình có pool giới hạn; tổng kết nối tới PostgreSQL ≤ `max_connections`
   trừ dự phòng; nhiều tiến trình/serverless → PgBouncer transaction mode.
6. **Thống kê và vacuum là một phần của hiệu năng**: planner sai vì thống kê cũ; bloat và wraparound là sự cố hiệu năng
   trước khi thành sự cố dữ liệu.
7. **Phân trang keyset** cho danh sách lớn; `OFFSET` lớn quét bỏ hàng.

## Quyết định

| Nhu cầu | Chọn | Không dùng khi |
|---|---|---|
| Lọc/sắp xếp theo cột thường | **B-tree** (mặc định) | — |
| Tìm trong JSONB, mảng, tsvector, trigram | **GIN** | Cột cập nhật rất nhiều (GIN ghi chậm) → cân nhắc |
| Khoảng cách/hình học/pg_trgm sắp theo gần nhất | **GiST** | — |
| Bảng rất lớn, cột tương quan vật lý với thứ tự chèn (thời gian) | **BRIN** | Dữ liệu không tương quan |
| Tập con nhỏ được truy vấn nhiều | **Partial index** `WHERE …` | Điều kiện thay đổi theo tham số |
| Truy vấn chỉ cần vài cột ngoài khoá | **Covering** `INCLUDE (…)` | Cột rộng (bloat, vượt kích thước tuple) |
| Pool kết nối | Ứng dụng một tiến trình/ít worker: **pool trong driver** (HikariCP, pgx, node-postgres, SQLAlchemy) · Nhiều tiến trình, serverless, > vài trăm client: **PgBouncer 1.26.0** (ISC) `pool_mode = transaction` | Transaction mode phá tính năng theo phiên: `SET` không `LOCAL`, `LISTEN`, prepared statement cấp SQL (`PREPARE`), advisory lock cấp phiên; cần `max_prepared_statements` cho protocol-level |
| Phân trang | **Keyset** (`WHERE (created_at, id) < (?, ?) ORDER BY … LIMIT n`) | `OFFSET` chỉ cho trang đầu nhỏ/giao diện quản trị |
| Phát hiện truy vấn chậm | **`pg_stat_statements`** (bật `shared_preload_libraries`) + **`auto_explain`** với `log_min_duration` | `auto_explain.log_analyze = on` toàn cục (đo mọi câu, chậm server) |
| MySQL | `EXPLAIN ANALYZE` (8.0.18+), `performance_schema`, slow query log; InnoDB `REPEATABLE READ` mặc định có gap lock | — |
| SQLite | `EXPLAIN QUERY PLAN`, `PRAGMA optimize`, WAL mode; một writer | Nhiều writer đồng thời → client/server |

## Checklist

- [ ] `DB-PERF-001` **MUST** Mọi cột trong `WHERE`/`JOIN`/`ORDER BY` của truy vấn trên đường nóng (endpoint lõi, job thường xuyên) có index phù hợp, chứng minh bằng `EXPLAIN (ANALYZE, BUFFERS)` không Seq Scan trên bảng lớn. → Kiểm: file `docs/db/explain/<query>.txt` cho mỗi truy vấn lõi, cập nhật khi đổi; test tự động chạy EXPLAIN và fail nếu plan chứa `Seq Scan` trên bảng trong danh sách lớn. · Nguồn: PostgreSQL 18 §14.1 Using EXPLAIN
- [ ] `DB-PERF-002` **MUST@L** Mọi cột khoá ngoại có index (trừ bảng rất nhỏ ghi lý do). → Kiểm: truy vấn catalog FK-không-index = 0 trong CI (xem [`data-modeling.md`](data-modeling.md) DB-MODEL-004). · Nguồn: PostgreSQL 18 CREATE INDEX
- [ ] `DB-PERF-003` **MUST@L** Không N+1: endpoint/luồng lõi có test đếm truy vấn với ngưỡng cố định; số truy vấn không tăng theo số phần tử trả về. → Kiểm: test "n = 1 vs n = 50 bản ghi → số câu SQL bằng nhau" (hook đếm của ORM/driver, vd `django-assert-num-queries`, `pytest-django`, `prisma` log, `pg` event). · Nguồn: khung cũ `quality-supplements.md` (N+1 trong chống lỗi logic) · `research/2026-10-13-old-framework-analysis.md`
- [ ] `DB-PERF-004` **MUST** Pool kết nối có giới hạn trên tường minh ở mọi tiến trình; tổng `pool_size × số tiến trình` + dự phòng ≤ `max_connections`; có timeout lấy kết nối. → Kiểm: cấu hình pool (`max`, `acquireTimeout`/`pool_timeout`) trong repo; bảng tính tổng kết nối trong `docs/db/connections.md`; cảnh báo khi `numbackends` > 80% (ngưỡng đội chọn, ghi nguồn). · Nguồn: PgBouncer config · PostgreSQL `max_connections`
- [ ] `DB-PERF-005` **MUST** `statement_timeout` đặt ở mức vai trò ứng dụng (không phải `postgresql.conf` toàn cục) và `idle_in_transaction_session_timeout` bật để không giữ khoá/chặn vacuum. → Kiểm: `ALTER ROLE app SET statement_timeout = …` trong migration; `SHOW idle_in_transaction_session_timeout` ≠ 0 cho vai trò app. · Nguồn: PostgreSQL 18 runtime-config-client (khuyến nghị không đặt toàn cục)
- [ ] `DB-PERF-006` **MUST@L** `pg_stat_statements` bật trên production; có báo cáo định kỳ top truy vấn theo `total_exec_time` và `mean_exec_time`; truy vấn mới vào top phải có ticket. → Kiểm: `SELECT * FROM pg_stat_statements LIMIT 1` chạy được; dashboard/job tuần lưu báo cáo. · Nguồn: PostgreSQL 18 pg_stat_statements
- [ ] `DB-PERF-007` **MUST@L** Truy vấn chậm được log tự động với plan (`auto_explain.log_min_duration`), không bật `log_analyze` toàn cục; ngưỡng ghi trong cấu hình kèm lý do. → Kiểm: `auto_explain` trong `session_preload_libraries`/`shared_preload_libraries`; `log_min_duration` ≠ -1. · Nguồn: PostgreSQL 18 auto_explain
- [ ] `DB-PERF-008` **MUST@M** Autovacuum bật; bảng ghi nhiều có tham số autovacuum riêng; có cảnh báo tuổi XID (wraparound) và bloat. → Kiểm: `SHOW autovacuum` = on; cảnh báo `age(datfrozenxid)` trước ngưỡng 2^31 (PostgreSQL cảnh báo ở 40 triệu còn lại, từ chối ở 3 triệu); dashboard dead tuples. · Nguồn: PostgreSQL 18 §24.1 Routine Vacuuming
- [ ] `DB-PERF-009` **MUST@L** Danh sách phân trang công khai dùng keyset; `OFFSET` chỉ cho giao diện quản trị với trần trang. → Kiểm: hợp đồng API có cursor; test trang thứ 1000 có độ trễ ≈ trang 1. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `DB-PERF-010` **SHOULD** Index composite thiết kế theo truy vấn: cột `=` trước, cột khoảng/sắp xếp sau; không tạo index trùng/tiền tố của index khác. → Kiểm: script liệt kê index dư thừa (tiền tố của index khác) và index chưa dùng (`pg_stat_user_indexes.idx_scan = 0` sau N ngày) → ticket gỡ. · Nguồn: PostgreSQL 18 §11.3 Multicolumn Indexes
- [ ] `DB-PERF-011` **SHOULD** Dùng partial index cho tập con nóng (ví dụ `WHERE status = 'pending'`, `WHERE deleted_at IS NULL`) và covering index (`INCLUDE`) cho truy vấn chỉ đọc vài cột. → Kiểm: EXPLAIN cho thấy `Index Only Scan`/index partial được dùng; `Heap Fetches` thấp. · Nguồn: PostgreSQL 18 CREATE INDEX (partial, INCLUDE)
- [ ] `DB-PERF-012` **SHOULD** PgBouncer transaction mode: ứng dụng không dựa vào trạng thái phiên (`SET` không `LOCAL`, `LISTEN`, prepared statement cấp SQL); `max_prepared_statements` cấu hình; sau migration đổi kiểu chạy `RECONNECT`. → Kiểm: test suite chạy qua PgBouncer transaction mode xanh; runbook migration có bước `RECONNECT`. · Nguồn: PgBouncer config (pool_mode, max_prepared_statements, "cached plan must not change result type")
- [ ] `DB-PERF-013` **SHOULD** Đọc nặng/báo cáo chạy trên replica hoặc bảng tổng hợp; ứng dụng phân luồng read/write tường minh. → Kiểm: cấu hình `READ_REPLICA_URL`; truy vấn báo cáo gắn nhãn read-only. · Nguồn: [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md)
- [ ] `DB-PERF-014` **SHOULD** Dữ liệu test hiệu năng có kích thước gần production (ẩn danh hoá) vì plan đổi theo kích thước; EXPLAIN trên bảng nhỏ không chứng minh gì. → Kiểm: môi trường perf có bảng lớn tương đương; báo cáo nêu số dòng. · Nguồn: PostgreSQL 18 §14.1 (small tables không đại diện) · [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)
- [ ] `DB-PERF-015` **SHOULD** Nạp dữ liệu lớn dùng `COPY`, tạo index sau khi nạp, `ANALYZE` sau cùng. → Kiểm: script import dùng COPY; `ANALYZE` ở cuối. · Nguồn: PostgreSQL 18 §14.4 Populating a Database
- [ ] `DB-PERF-016` **SHOULD** Bảng rất lớn theo thời gian: BRIN hoặc phân vùng theo khoảng, giữ số phân vùng trong mức planner xử lý tốt. → Kiểm: `EXPLAIN` cho thấy partition pruning; số phân vùng ghi trong tài liệu. · Nguồn: PostgreSQL 18 §5.12 Partitioning
- [ ] `DB-PERF-017` **SHOULD** Transaction ngắn: không gọi mạng/LLM/chờ người dùng trong transaction; thời gian transaction là metric. → Kiểm: lint/review; metric `pg_stat_activity` idle in transaction gần 0. · Nguồn: PostgreSQL 18 §13.2 (tránh idle in transaction) · [`transactions-and-consistency.md`](transactions-and-consistency.md)
- [ ] `DB-PERF-018` **MAY** Ngân sách truy vấn mỗi endpoint (số câu, tổng thời gian) ghi trong test và chặn tăng (ratchet). → Kiểm: file ngưỡng commit; CI đỏ khi vượt.
- [ ] `DB-PERF-019` **MAY** Dùng `EXPLAIN (ANALYZE)` trong `BEGIN … ROLLBACK` cho câu ghi khi phân tích, không chạy trên production ngoài giờ bảo trì. → Kiểm: runbook phân tích hiệu năng nêu quy tắc.
- [ ] `DB-PERF-020` **MAY** SQLite: `PRAGMA journal_mode=WAL`, `synchronous=NORMAL` khi chấp nhận mất vài giao dịch cuối khi mất điện, `EXPLAIN QUERY PLAN` cho truy vấn lõi. → Kiểm: pragma trong mã khởi tạo; test plan không `SCAN` bảng lớn.

## Bẫy thường gặp

- **Index mọi cột "cho chắc"** → ghi chậm, đĩa phình, planner bối rối. Tránh: DB-PERF-001/010 (đo rồi mới index; gỡ index không dùng).
- **Composite sai thứ tự** `(created_at, tenant_id)` cho `WHERE tenant_id = ? ORDER BY created_at` → không dùng được. Tránh: DB-PERF-010.
- **N+1 ẩn trong serializer/ORM lazy load** → 1 + n câu SQL mỗi request; chỉ lộ khi dữ liệu lớn. Tránh: DB-PERF-003.
- **Pool mỗi lambda/pod không giới hạn** → vượt `max_connections`, "too many clients". Tránh: DB-PERF-004 + PgBouncer.
- **PgBouncer transaction mode + `SET search_path`/prepared statement** → lỗi ngẫu nhiên "prepared statement does not exist". Tránh: DB-PERF-012.
- **`statement_timeout` trong `postgresql.conf`** → giết cả migration/backup. Tránh: DB-PERF-005 (đặt theo vai trò).
- **`auto_explain.log_analyze = on` toàn cục** → đo mọi node mọi câu, server chậm. Tránh: DB-PERF-007.
- **`OFFSET 100000`** → quét bỏ 100k dòng mỗi trang. Tránh: keyset (DB-PERF-009).
- **Thống kê cũ sau nạp lớn** → plan tệ dù có index. Tránh: `ANALYZE` (DB-PERF-015).
- **Tắt autovacuum "để nhanh hơn"** → bloat rồi wraparound dừng ghi toàn cụm. Tránh: DB-PERF-008.
- **Benchmark trên 100 dòng** rồi kết luận "nhanh". Tránh: DB-PERF-014.

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Plan truy vấn lõi | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` + script phân tích plan | `python3 scripts/explain-check.py queries/*.sql` | CI (CSDL perf) | 0 Seq Scan trên bảng lớn; 0 `Rows Removed by Filter` bất thường |
| Đếm truy vấn (N+1) | hook đếm của ORM/driver trong test | `pytest -m query_count` / `vitest` | CI | n=1 và n=50 bằng nhau |
| FK không index / index trùng / index không dùng | SQL catalog (`pg_index`, `pg_stat_user_indexes`) | `psql -f scripts/db-checks.sql` | CI + hàng tuần | 0 / 0 / ticket |
| Truy vấn chậm production | pg_stat_statements (contrib) + auto_explain (contrib) | báo cáo tuần | production | top-10 có owner |
| Pool/kết nối | metric `pg_stat_activity` + cảnh báo | exporter (xem [`../15-operations/observability.md`](../15-operations/observability.md)) | production | < ngưỡng đã ghi |
| Vacuum/wraparound/bloat | `age(datfrozenxid)`, `pg_stat_user_tables.n_dead_tup` | cảnh báo | production | theo DB-PERF-008 |
| PgBouncer tương thích | PgBouncer 1.26.0 ISC trong CI | chạy test suite qua `pool_mode=transaction` | CI | xanh |
| Tải end-to-end | k6/Locust (xem [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md)) | — | CI nightly | p95 theo SLO |

## Nguồn

- PostgreSQL 18 docs: Using EXPLAIN (ANALYZE, BUFFERS, BEGIN/ROLLBACK) <https://www.postgresql.org/docs/current/using-explain.html>; CREATE INDEX (CONCURRENTLY, partial, INCLUDE) <https://www.postgresql.org/docs/current/sql-createindex.html>; pg_stat_statements <https://www.postgresql.org/docs/current/pgstatstatements.html>; auto_explain <https://www.postgresql.org/docs/current/auto-explain.html>; runtime-config-client (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) <https://www.postgresql.org/docs/current/runtime-config-client.html>; Routine Vacuuming (wraparound 40M/3M) <https://www.postgresql.org/docs/current/routine-vacuuming.html>; Populating a Database <https://www.postgresql.org/docs/current/populate.html>; Partitioning <https://www.postgresql.org/docs/current/ddl-partitioning.html> — xác minh 2026-10-13.
- PgBouncer 1.26.0 (ISC) config — pool modes, `max_prepared_statements`, `RECONNECT`: <https://www.pgbouncer.org/config.html>, <https://formulae.brew.sh/api/formula/pgbouncer.json> — xác minh 2026-10-13.
- MySQL 8.4 InnoDB isolation (REPEATABLE READ, gap lock): <https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html> — xác minh 2026-10-13.
- SQLite WAL: <https://www.sqlite.org/wal.html>; When to use: <https://www.sqlite.org/whentouse.html> — xác minh 2026-10-13.
- Khung cũ `quality-supplements.md` (N+1, index cột lọc/sắp xếp/join), `research/2026-10-13-old-framework-analysis.md` (thiếu N+1/index/transaction chi tiết) — commit `1b80fe4`.
