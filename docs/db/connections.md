# Kết nối CSDL, isolation và vacuum (DB-PERF-004, DB-TX-002, DB-PERF-008)

Rào máy: `packages/app/src/db/connections-doc.test.ts` đối chiếu bảng dưới với mã (`createPool`, pg-boss) — đổi trần pool mà quên sửa tài liệu → test đỏ.

## 1. Bảng tổng kết nối (mỗi bản sao tiến trình)

| Tiến trình | Pool | Vai trò DB | Trần `max` | Nguồn |
|---|---|---|---|---|
| web | dữ liệu ứng dụng | `app_runtime` | 20 | `packages/app/src/server/context.ts` |
| web | xác thực (Better Auth, `search_path=auth`) | `app_runtime` | 10 | `packages/app/src/auth/auth.ts` |
| worker | job nền/relay outbox | `app_worker` | 10 | `apps/worker/src/runtime.ts` |
| worker | lệnh theo ngữ cảnh tổ chức | `app_runtime` | 5 | `apps/worker/src/runtime.ts` |
| worker | pg-boss (hàng đợi) | `app_worker` | 5 | `apps/worker/src/runtime.ts` |

Mỗi pool có `connectionTimeoutMillis` 5 s và `idleTimeoutMillis` 30 s (`packages/app/src/db/pool.ts`): hết chỗ thì lỗi sớm, không treo.

**Tổng theo bản sao:** web = 20 + 10 = **30**; worker = 10 + 5 + 5 = **20**.

## 2. Ngân sách so với `max_connections`

`max_connections = 100` (Postgres 17, theo `docs/RUNBOOK.md`).

| Khoản | Số kết nối |
|---|---|
| Dự phòng superuser (`superuser_reserved_connections`, mặc định) | 3 |
| Công cụ vận hành (migrate, psql, pgBackRest, exporter) | 10 |
| Còn cho ứng dụng | **87** |

Công thức: `30 × W + 20 × K ≤ 87` với W = số bản sao web, K = số bản sao worker.
- Pilot (W = 1, K = 1): 50 ≤ 87, dư 37.
- W = 2, K = 1: 80 ≤ 87 — **trần của một máy Postgres mặc định**. Thêm bản sao thứ ba của web ⇒ phải nâng `max_connections` (kèm RAM: ~10 MB/kết nối) hoặc đặt PgBouncer (chế độ transaction; lưu ý `SET LOCAL`/`set_config(..., true)` của `withTenant` an toàn ở chế độ này, còn `SET` cấp phiên thì không).
- Cảnh báo: `numbackends` của `pg_stat_database` > 80% `max_connections` (ngưỡng đội chọn, chưa có nguồn chuẩn) — rule `HmDbConnectionsHigh` ở `deploy/prometheus/alerts.yml` trên metric `hm_db_connections` / `hm_db_max_connections` (§6).

## 3. Isolation và retry (DB-TX-002)

- Mọi lệnh chạy trong **một transaction `READ COMMITTED`** (mặc định Postgres) qua `executeCommand` (`packages/app/src/pipeline/command.ts`); tính đúng của tiền/tồn dựa vào **khoá hàng tường minh** (`SELECT … FOR UPDATE`, thứ tự khoá cố định) và ràng buộc DB (`EXCLUDE`, `UNIQUE`, `CHECK`, trigger sổ cái), không dựa vào `SERIALIZABLE`.
- Vì không dùng `REPEATABLE READ`/`SERIALIZABLE`, lỗi tuần tự hoá `40001` không xảy ra do isolation; vẫn bọc **retry toàn bộ transaction** khi gặp `40001` hoặc `40P01` (deadlock), bằng helper chung `retryAsync`/`withTenantRetry` (`packages/db/src/retry.ts`, `tenant.ts`): lệnh HTTP theo `REQUEST_TX_RETRY` (3 lần, lùi mũ + full jitter 25–250 ms, tổng ≤ 3 s), job nền theo `WORKER_TX_RETRY` (5 lần, ≤ 2 s mỗi lần chờ, tổng ≤ 15 s); lỗi nghiệp vụ không retry. Idempotency-Key bảo đảm lần chạy lại không ghi đôi.
- Không có `BEGIN ISOLATION LEVEL …` nằm ngoài helper (grep trong mã = 0).
- `statement_timeout` và `idle_in_transaction_session_timeout` đặt cho vai trò `app_runtime` (test `tenancy.db.test.ts`).
- Rào máy: `packages/app/src/tx-guards.test.ts` (mức cô lập và mã 40001/40P01 chỉ nằm ở helper), `packages/db/src/retry.test.ts`, `packages/app/src/pipeline/command-pipeline-tx-retry.db.test.ts` (40001 thật).

## 4. Vacuum cho bảng ghi nhiều (DB-PERF-008)

Autovacuum bật (mặc định, `SHOW autovacuum = on`; test `db-perf.db.test.ts`). Migration 0048 đặt tham số riêng:

| Bảng | Kiểu ghi | Tham số |
|---|---|---|
| `outbox`, `idempotency_keys`, `notification_deliveries`, `notifications`, `inbox` | ghi + cập nhật/xoá liên tục | `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_vacuum_threshold = 200`, `autovacuum_analyze_scale_factor = 0.02` |
| `audit_events`, `journal_lines` | chỉ thêm | `autovacuum_vacuum_insert_scale_factor = 0.05`, `autovacuum_vacuum_insert_threshold = 5000`, `autovacuum_analyze_scale_factor = 0.02` |

Khôi phục về mặc định: `ALTER TABLE … RESET (…)` (phần `down` của 0048).

## 5. Truy vấn nóng và EXPLAIN

`packages/app/src/db-perf.db.test.ts` chạy `EXPLAIN (FORMAT JSON)` cho: today (mọi thẻ), danh sách audit (mọi bộ lọc), xem trước kỳ thu, folio, claim outbox, claim thông báo — fail nếu có `Seq Scan` trên bảng lớn khi đã tắt `enable_seqscan` (không có index dùng được), và kiểm tự nhiên (30.000 dòng) cho audit/outbox. Bằng chứng kế hoạch: `docs/db/explain/*.txt` (bản chuẩn hoá bảng · kiểu quét · index · cột trong tiền tố khoá), test so khớp bằng `toMatchFileSnapshot` — đổi truy vấn/index làm kế hoạch đổi thì test đỏ; cập nhật có chủ đích bằng `pnpm vitest run --project db db-perf -u`. Index khoá ngoại: migration 0048 + 0051; mọi FK có `ON DELETE` tường minh (0051, D-035: RESTRICT, ngoại lệ DEFERRABLE/CASCADE có lý do ở `schema-guards.db.test.ts`); FK còn thiếu index chỉ ở ngoại lệ nhóm A (cột người thao tác) của `packages/testkit/src/schema-guards.baseline.json`.

## 6. Cảnh báo sức khoẻ CSDL (DB-PERF-004, DB-PERF-008)

Metric do `app.db_health_metrics()` (migration 0051, SECURITY DEFINER) qua `/api/metrics`; rule ở `deploy/prometheus/alerts.yml` (nhóm `hotel-manager.csdl`), xử lý ở `docs/RUNBOOK.md` §3.2, §3.10, §3.11. Test: `packages/app/src/observability/observability.db.test.ts`, `scripts/ops-docs.test.mjs`.

| Rule | Điều kiện | Mức | Căn cứ ngưỡng |
|---|---|---|---|
| `HmDbConnectionsHigh` | `hm_db_connections / hm_db_max_connections > 0,8` trong 10 phút | ticket | ngưỡng đội chọn (§2) |
| `HmDbXidAgeHigh` | `hm_db_xid_age` hoặc `hm_db_multixact_age` > 1,0 tỷ trong 30 phút | ticket | gấp 5 lần `autovacuum_freeze_max_age` mặc định (200 triệu): autovacuum đóng băng đã không theo kịp |
| `HmDbXidAgeCritical` | cùng metric > 1,8 tỷ trong 5 phút | page | còn dưới 350 triệu giao dịch; PostgreSQL cảnh báo ở 40 triệu còn lại và từ chối ghi ở 3 triệu còn lại (PostgreSQL 18 §24.1.5, xác minh 2026-10-17) |
| `HmDbDeadTuplesHigh` | `hm_db_dead_tuples > 10.000` và `hm_db_dead_tuple_ratio > 0,2` trong 1 giờ | ticket | ngưỡng khởi điểm theo `autovacuum_vacuum_scale_factor` 0,2 mặc định; chỉnh sau pilot |

## Còn treo
- Không còn mục treo cho DB-TX-002 (đã có backoff + jitter và retry phía worker từ đợt 6, T-502).
