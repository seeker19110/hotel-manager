---
title: Giao dịch, cô lập, khoá, idempotency, tính nhất quán
kind: module
prefix: DB-TX
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Giao dịch, cô lập, khoá, idempotency, tính nhất quán

> Làm cho thao tác đồng thời **đúng** ở tầng CSDL: chọn mức cô lập có chủ đích, retry serialization failure, khoá
> hàng đúng cách (`FOR UPDATE`, `SKIP LOCKED` cho hàng đợi, advisory lock cho mutex nghiệp vụ), bảng idempotency, và
> nhất quán cuối (outbox) khi vượt ranh giới một CSDL. Mẫu tích hợp xuyên dịch vụ ở
> [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md).

## Nguyên tắc

1. **Một bất biến nghiệp vụ = một transaction trong một CSDL.** Nếu bất biến trải qua hai CSDL/dịch vụ, thiết kế lại
   ranh giới trước khi nghĩ đến saga.
2. **Mức cô lập là quyết định, không phải mặc định ngầm.** PostgreSQL mặc định Read Committed: hai request đồng thời
   "kiểm số dư rồi trừ" vẫn có thể cùng qua. Chọn `SERIALIZABLE` (và retry `40001`) hoặc khoá hàng tường minh cho
   luồng tiền/kho.
3. **Retry là bắt buộc với Repeatable Read/Serializable.** Ứng dụng phải chạy lại toàn bộ transaction khi
   SQLSTATE `40001`/`40P01`; không retry từng câu.
4. **Transaction ngắn, không chờ bên ngoài.** Không gọi HTTP/LLM/hàng đợi, không chờ người dùng trong transaction;
   `idle in transaction` giữ khoá và chặn vacuum.
5. **Khoá theo thứ tự cố định** để tránh deadlock; deadlock vẫn có thể xảy ra → retry.
6. **Idempotency ở tầng dữ liệu**: ràng buộc UNIQUE trên khoá idempotency/mã giao dịch là hàng rào cuối; không tin
   kiểm tra "đã tồn tại chưa" ở code.
7. **Thời gian và tiền tính ở CSDL hoặc ở code, không cả hai** (một nguồn sự thật cho công thức).

## Quyết định

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Đọc-rồi-ghi phụ thuộc giá trị đọc (số dư, tồn kho, hạn mức) | `SELECT … FOR UPDATE` (hoặc `FOR NO KEY UPDATE` nếu không đổi khoá) trong transaction ngắn, **hoặc** `SERIALIZABLE` + retry | Read Committed đơn thuần là sai |
| Nhiều worker lấy việc từ bảng hàng đợi | `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` | Theo tài liệu PostgreSQL: cho queue-like table, không cho đọc chung |
| Mutex nghiệp vụ không gắn hàng (chạy job duy nhất, số hoá đơn) | **Advisory lock cấp transaction** `pg_advisory_xact_lock(key)` | Cấp phiên (`pg_advisory_lock`) không giải phóng khi rollback — tránh qua PgBouncer transaction mode |
| Nhiều bất biến chéo bảng, logic phức tạp, tải vừa | `SERIALIZABLE` + retry (SSI không deadlock) | Đọc-chỉ: `READ ONLY DEFERRABLE` để không bị huỷ |
| Báo cáo nhất quán một thời điểm | `REPEATABLE READ` (snapshot) trên replica | — |
| Ghi hai lần cùng yêu cầu (client retry) | Bảng idempotency `UNIQUE(scope, key)` + lưu response | Xem ARC-INT-001 |
| Đếm/tổng cập nhật nhiều | Cột đếm `UPDATE … SET n = n + 1` (nguyên tử) hoặc bảng sự kiện + tổng hợp | Không đọc-cộng-ghi ở code |
| Ràng buộc chỉ đúng ở cuối transaction (hoán đổi thứ tự, FK vòng) | `DEFERRABLE INITIALLY DEFERRED` + `SET CONSTRAINTS` | — |
| MySQL/InnoDB | Mặc định `REPEATABLE READ` có gap/next-key lock; `SELECT … FOR UPDATE` tương tự; `SKIP LOCKED` 8.0+ | Deadlock cũng phải retry |
| MongoDB | Gói thay đổi vào một document (atomic) trước; transaction đa document (4.0+/4.2 sharded) có giới hạn thời gian | Thiết kế schema để hiếm khi cần |
| SQLite | Một writer; `BEGIN IMMEDIATE` cho ghi để tránh `SQLITE_BUSY` muộn; `busy_timeout` | — |

## Checklist

- [ ] `DB-TX-001` **MUST** Luồng đọc-rồi-ghi có điều kiện (số dư, tồn kho, hạn mức, ghế/slot) được bảo vệ bằng `FOR UPDATE` hoặc `SERIALIZABLE`, chứng minh bằng test đồng thời. → Kiểm: test chạy ≥ 2 giao dịch song song (threads/processes) cùng trừ → tổng đúng, không âm; test đỏ khi bỏ khoá (mutation thủ công ghi trong PR). · Nguồn: PostgreSQL 18 §13.2 (Read Committed không chặn lost update giữa hai read-modify-write)
- [ ] `DB-TX-002` **MUST** Mọi transaction ở `REPEATABLE READ`/`SERIALIZABLE` được bọc retry toàn bộ khi SQLSTATE `40001` (serialization) và `40P01` (deadlock), có trần số lần + backoff. → Kiểm: helper `run_in_tx(retry_on=['40001','40P01'])` dùng ở mọi nơi (grep không có `BEGIN ISOLATION LEVEL` ngoài helper); test chèn `40001` → chạy lại thành công. · Nguồn: PostgreSQL 18 §13.2.3 (ứng dụng phải retry serialization failure)
- [ ] `DB-TX-003` **MUST** Không gọi mạng/HTTP/LLM/hàng đợi/chờ người dùng **bên trong transaction CSDL** (giữ khoá, cạn pool, mất bản ghi khi crash sau lời gọi); `idle_in_transaction_session_timeout` bật. Nguyên tắc outbox cho tác động phụ: xem [`ARC-INT-003`](../05-architecture/integration-patterns.md). → Kiểm: lint/semgrep rule cấm client HTTP/broker trong khối transaction; cấu hình `idle_in_transaction_session_timeout` (DB-PERF-005). · Nguồn: PostgreSQL 18 §13.3.4 (giữ transaction mở khi chờ người dùng là "bad idea")
- [ ] `DB-TX-004` **MUST** Khoá idempotency/mã giao dịch ngoài (mã thanh toán, `webhook-id`) có ràng buộc `UNIQUE` ở CSDL; xử lý trùng bằng `ON CONFLICT`/bắt lỗi unique, không bằng `SELECT` rồi `INSERT`. → Kiểm: schema có UNIQUE; test chèn trùng đồng thời (2 tiến trình) → đúng một bản ghi. · Nguồn: ARC-INT-001 · catalog 23 §4.1 (SePay idempotent)
- [ ] `DB-TX-005` **MUST@L** Hàng đợi trong CSDL dùng `FOR UPDATE SKIP LOCKED` với `LIMIT`, worker đánh dấu trạng thái và có `lease_until` để việc của worker chết được lấy lại. → Kiểm: test 2 worker không lấy trùng việc; test worker bị kill → việc được lấy lại sau lease. · Nguồn: PostgreSQL 18 SELECT (SKIP LOCKED cho queue-like table) · [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)
- [ ] `DB-TX-006` **MUST@L** Mutex nghiệp vụ (job duy nhất, sinh số liên tục) dùng advisory lock **cấp transaction** hoặc hàng khoá trong bảng; không dùng advisory lock cấp phiên qua pooler transaction mode. → Kiểm: grep `pg_advisory_lock(` (cấp phiên) = 0 hoặc có lý do; test 2 tiến trình → một chạy, một chờ/bỏ qua. · Nguồn: PostgreSQL 18 §13.3.5 Advisory Locks (session vs transaction level)
- [ ] `DB-TX-007` **MUST@L** Cập nhật bộ đếm/tổng là phép nguyên tử ở CSDL (`SET n = n + ?`, `RETURNING`), không đọc-cộng-ghi ở ứng dụng. → Kiểm: grep pattern đọc rồi ghi cho cột đếm; test đồng thời 100 tăng → đúng 100. · Nguồn: PostgreSQL 18 §13.2.1
- [ ] `DB-TX-008` **MUST@L** Thứ tự lấy khoá nhiều hàng/bảng cố định (sắp theo id) và ghi trong tài liệu; deadlock là metric có cảnh báo. → Kiểm: helper khoá nhiều hàng sắp xếp id trước khi `FOR UPDATE`; metric `deadlocks` từ `pg_stat_database`. · Nguồn: PostgreSQL 18 §13.3.4 Deadlocks
- [ ] `DB-TX-009` **MUST@L** Luồng tiền/kho có test "tính lại từ sổ cái = số dư hiện tại" chạy định kỳ; lệch → cảnh báo, không tự sửa. → Kiểm: job đối chiếu + cảnh báo; test chèn lệch giả → cảnh báo. · Nguồn: ARC-INT-018 · hồ sơ `fintech`
- [ ] `DB-TX-010` **MUST@L** Transaction có timeout tổng (`statement_timeout` theo vai trò + timeout ở ứng dụng) và kích thước giới hạn (không cập nhật hàng triệu dòng trong một transaction). → Kiểm: cấu hình DB-PERF-005; job lớn dùng lô (DB-MIG-010). · Nguồn: PostgreSQL 18 §13.2.3 (giữ transaction nhỏ)
- [ ] `DB-TX-011` **SHOULD** Mức cô lập mặc định của ứng dụng ghi tường minh trong cấu hình kết nối/ORM và tài liệu; ngoại lệ theo use case ghi lý do. → Kiểm: `default_transaction_isolation` theo vai trò hoặc cấu hình ORM; `docs/db/transactions.md` liệt kê use case → mức. · Nguồn: PostgreSQL 18 §13.2
- [ ] `DB-TX-012` **SHOULD** Ràng buộc cần thoả ở cuối transaction khai báo `DEFERRABLE INITIALLY DEFERRED` thay vì tắt ràng buộc. → Kiểm: schema; grep không có `SET CONSTRAINTS ALL DEFERRED` tuỳ tiện hoặc `DISABLE TRIGGER`. · Nguồn: PostgreSQL 18 SET CONSTRAINTS
- [ ] `DB-TX-013` **SHOULD** Giao dịch chỉ đọc khai báo `READ ONLY` (và `DEFERRABLE` dưới Serializable) để không bị huỷ và có thể chạy trên replica. → Kiểm: helper đọc dùng `READ ONLY`; replica nhận truy vấn báo cáo. · Nguồn: PostgreSQL 18 §13.2.3
- [ ] `DB-TX-014` **SHOULD** Optimistic locking (cột `version`/`updated_at` trong `WHERE`) cho sửa bản ghi từ giao diện; xung đột trả 409 với dữ liệu hiện tại. → Kiểm: test hai người sửa cùng bản ghi → người sau nhận 409; `UPDATE … WHERE version = ?` ảnh hưởng 0 dòng → lỗi. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `DB-TX-015` **SHOULD** MySQL: hiểu gap/next-key lock của `REPEATABLE READ`; luồng chèn nhiều đồng thời cân nhắc `READ COMMITTED` theo phiên có lý do; deadlock cũng retry. → Kiểm: cấu hình mức cô lập theo use case; test deadlock → retry. · Nguồn: MySQL 8.4 InnoDB isolation levels
- [ ] `DB-TX-016` **SHOULD** Nhất quán cuối giữa CSDL và hệ ngoài (search index, cache, dịch vụ khác) đi qua outbox + đối chiếu; thời gian trễ là metric. → Kiểm: ARC-INT-003/014; metric độ trễ index. · Nguồn: [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md)
- [ ] `DB-TX-017` **MAY** `SERIALIZABLE` làm mặc định cho miền tiền/kho khi tải cho phép; đo tỉ lệ `40001` và điều chỉnh. → Kiểm: metric tỉ lệ retry; ADR ghi quyết định.
- [ ] `DB-TX-018` **MAY** SQLite: dùng `BEGIN IMMEDIATE` cho transaction ghi và `busy_timeout` để tránh `SQLITE_BUSY` giữa chừng. → Kiểm: helper transaction ghi; test 2 tiến trình ghi tuần tự thành công.
- [ ] `DB-TX-019` **MAY** MongoDB: thiết kế document để thao tác là atomic đơn document; transaction đa document chỉ với lý do và timeout ghi rõ. → Kiểm: ADR; test timeout transaction.

## Bẫy thường gặp

- **"Kiểm rồi mới ghi" ở Read Committed** → hai request cùng qua, số dư âm, bán quá tồn kho. Tránh: DB-TX-001.
- **Retry từng câu thay vì cả transaction** sau `40001` → dữ liệu đọc trước đó đã vô hiệu. Tránh: DB-TX-002.
- **Gọi API thanh toán trong transaction** → transaction treo 30 s, khoá hàng, pool cạn; crash sau khi API thành công nhưng trước commit → mất bản ghi. Tránh: DB-TX-003 + outbox.
- **Advisory lock cấp phiên qua PgBouncer transaction mode** → khoá dính vào kết nối server khác, không bao giờ nhả hoặc nhả nhầm. Tránh: DB-TX-006.
- **`SELECT … LIMIT` với `pg_advisory_lock(id)` trong danh sách cột** → khoá nhiều hơn dự định (thứ tự đánh giá). Tránh: đưa LIMIT vào subquery (tài liệu PostgreSQL §13.3.5).
- **`SKIP LOCKED` cho truy vấn thường** → kết quả không nhất quán. Tránh: chỉ cho bảng hàng đợi (DB-TX-005).
- **Kiểm "đã tồn tại" ở code rồi insert** → race tạo trùng. Tránh: UNIQUE + `ON CONFLICT` (DB-TX-004).
- **Transaction khổng lồ** (xoá/cập nhật hàng triệu dòng) → WAL phình, replica trễ, khoá lâu. Tránh: DB-TX-010.
- **Tắt ràng buộc/trigger để "cho nhanh"** rồi quên bật. Tránh: DB-TX-012.
- **Giả định tiền nhất quán vì "đã có transaction"** nhưng cache/search không đồng bộ → hiển thị sai. Tránh: DB-TX-016.

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Test đồng thời luồng tiền/kho/hàng đợi | test runner của stack chạy song song (pytest-xdist, `Promise.all` với pool, Go goroutines) trên CSDL thật (testcontainers) | `pytest tests/concurrency/ -n 4` | CI | bất biến giữ; 0 trùng |
| Cấm I/O ngoài trong transaction | semgrep rule tự viết (phiên bản theo lockfile) | `semgrep --config .semgrep/tx.yml` | pre-commit + CI | 0 phát hiện |
| Advisory lock cấp phiên | grep `pg_advisory_lock(` | script | CI | 0 ngoài allowlist |
| UNIQUE cho khoá idempotency | SQL catalog + test chèn trùng | `psql -f scripts/db-checks.sql` | CI | có UNIQUE |
| Deadlock / serialization failure | metric `pg_stat_database.deadlocks`, đếm `40001` ở helper | cảnh báo | production | tỉ lệ < ngưỡng đã ghi |
| Idle in transaction | `idle_in_transaction_session_timeout` + metric `pg_stat_activity` | cấu hình vai trò | production | ≈ 0 phiên idle in tx > n s |
| Đối chiếu sổ cái | job theo lịch | `scripts/reconcile.py` (dự án tự viết) | production hằng ngày | lệch = 0 hoặc cảnh báo |
| Test hàm/trigger ở CSDL | pgTAP 1.3.4 · PostgreSQL License | `pg_prove tests/db/*.sql` | CI | 100% pass |

## Nguồn

- PostgreSQL 18 docs: §13.2 Transaction Isolation (Read Committed mặc định; RR/Serializable phải retry `40001`; READ ONLY DEFERRABLE) <https://www.postgresql.org/docs/current/transaction-iso.html>; §13.3 Explicit Locking (deadlock, advisory lock session/transaction, LIMIT caveat) <https://www.postgresql.org/docs/current/explicit-locking.html>; SELECT locking clause (`FOR UPDATE`, `NOWAIT`, `SKIP LOCKED` cho queue-like table) <https://www.postgresql.org/docs/current/sql-select.html>; SET CONSTRAINTS <https://www.postgresql.org/docs/current/sql-set-constraints.html> — xác minh 2026-10-13.
- MySQL 8.4 InnoDB transaction isolation levels (REPEATABLE READ mặc định, gap/next-key lock): <https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html> — xác minh 2026-10-13.
- MongoDB transactions (4.0 replica set / 4.2 sharded; ưu tiên schema atomic đơn document): <https://www.mongodb.com/docs/manual/core/transactions/> — xác minh 2026-10-13 (giới hạn 60 s: **chưa xác minh** trên trang đó).
- Catalog `seeker19110/stored` 23 §4.1 (SePay VietQR webhook HMAC + idempotent), 21 §8 (outbox/reconcile) — đọc 2026-10-13.
- Khung cũ `quality-supplements.md` mục "Race condition / Idempotency / Thao tác nhiều bước" — commit `1b80fe4`.
