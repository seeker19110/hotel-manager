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
- Cảnh báo: `numbackends` của `pg_stat_database` > 80% `max_connections` (ngưỡng đội chọn, chưa có nguồn chuẩn) — quy tắc nằm ở `deploy/prometheus` (**chưa thêm**: cấu hình giám sát ngoài phạm vi T-408; xem "Còn treo").

## 3. Isolation và retry (DB-TX-002)

- Mọi lệnh chạy trong **một transaction `READ COMMITTED`** (mặc định Postgres) qua `executeCommand` (`packages/app/src/pipeline/command.ts`); tính đúng của tiền/tồn dựa vào **khoá hàng tường minh** (`SELECT … FOR UPDATE`, thứ tự khoá cố định) và ràng buộc DB (`EXCLUDE`, `UNIQUE`, `CHECK`, trigger sổ cái), không dựa vào `SERIALIZABLE`.
- Vì không dùng `REPEATABLE READ`/`SERIALIZABLE`, lỗi tuần tự hoá `40001` không xảy ra do isolation; vẫn bọc **retry toàn bộ transaction** khi gặp `40001` hoặc `40P01` (deadlock), tối đa `MAX_ATTEMPTS = 3` lần (hằng ở `command.ts`); lỗi nghiệp vụ không retry. Idempotency-Key bảo đảm lần chạy lại không ghi đôi.
- Không có `BEGIN ISOLATION LEVEL …` nằm ngoài helper (grep trong mã = 0).
- `statement_timeout` và `idle_in_transaction_session_timeout` đặt cho vai trò `app_runtime` (test `tenancy.db.test.ts`).
- **Còn treo:** chưa có chờ lùi (backoff + jitter) giữa các lần retry, và transaction của worker (`withTenant` ngoài pipeline) chưa tự retry deadlock.

## 4. Vacuum cho bảng ghi nhiều (DB-PERF-008)

Autovacuum bật (mặc định, `SHOW autovacuum = on`; test `db-perf.db.test.ts`). Migration 0048 đặt tham số riêng:

| Bảng | Kiểu ghi | Tham số |
|---|---|---|
| `outbox`, `idempotency_keys`, `notification_deliveries`, `notifications`, `inbox` | ghi + cập nhật/xoá liên tục | `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_vacuum_threshold = 200`, `autovacuum_analyze_scale_factor = 0.02` |
| `audit_events`, `journal_lines` | chỉ thêm | `autovacuum_vacuum_insert_scale_factor = 0.05`, `autovacuum_vacuum_insert_threshold = 5000`, `autovacuum_analyze_scale_factor = 0.02` |

Khôi phục về mặc định: `ALTER TABLE … RESET (…)` (phần `down` của 0048).

## 5. Truy vấn nóng và EXPLAIN

`packages/app/src/db-perf.db.test.ts` chạy `EXPLAIN (FORMAT JSON)` cho: today (mọi thẻ), danh sách audit (mọi bộ lọc), xem trước kỳ thu, folio, claim outbox, claim thông báo — fail nếu có `Seq Scan` trên bảng lớn khi đã tắt `enable_seqscan` (không có index dùng được), và kiểm tự nhiên (30.000 dòng) cho audit/outbox. Index khoá ngoại: migration 0048 + nền `packages/testkit/src/schema-guards.baseline.json` (nhóm còn lại có lý do).

## Còn treo
- Cảnh báo `numbackends` > 80% và `age(datfrozenxid)`/dead tuples trong `deploy/prometheus` + `docs/RUNBOOK.md` (DB-PERF-004/008, cần sửa cấu hình giám sát).
- Backoff + jitter giữa các lần retry deadlock và retry cho transaction của worker (DB-TX-002).
- Khai `ON DELETE` tường minh cho toàn bộ FK (DB-MODEL-004): hiện 240/245 dùng NO ACTION mặc định không ghi trong DDL; test chỉ cho phép 5 FK còn lại (RESTRICT/CASCADE) có lý do.
