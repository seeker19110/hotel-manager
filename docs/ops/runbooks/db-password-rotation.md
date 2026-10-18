---
title: Runbook — xoay mật khẩu role CSDL của ứng dụng không downtime
kind: runbook
updated: 2026-10-18
last_drilled: "2026-10-18 — diễn tập tự động trên cluster tạm (packages/app/src/db/password-rotation.db.test.ts); chưa diễn tập trên production (chưa có VPS)"
owner: (chưa gán — Tech Lead)
---

# Xoay mật khẩu role CSDL của ứng dụng (DB-SEC-004)

> Đổi mật khẩu **tại chỗ** (`ALTER ROLE app_runtime PASSWORD …`) gây gián đoạn: PostgreSQL chỉ giữ một mật khẩu cho mỗi role, nên mọi kết nối **mới** của bản đang chạy bị từ chối tới khi bản đó được triển khai lại. Runbook này luân phiên hai role **đăng nhập** `<base>_a` / `<base>_b`, đều là thành viên của role quyền `<base>` (`app_runtime` hoặc `app_worker`). Bản cũ và bản mới chạy song song, mỗi bản bằng login riêng, nên không có downtime.
> Mật khẩu không bao giờ nằm trong mã, log hay dòng lệnh: đặt bằng `\password` (psql gửi băm SCRAM), lưu ở kho bí mật / tệp `deploy/secrets/` mode 0600 rồi tham chiếu qua `DATABASE_URL` / `WORKER_DATABASE_URL` khi triển khai. Log truy vấn của Postgres không in tham số: `log_statement=none`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0` trong [`deploy/compose.yaml`](../../../deploy/compose.yaml).

## Khi nào dùng
- Xoay định kỳ (đề xuất 90 ngày), khi người có mật khẩu rời đội, hoặc khi nghi lộ — lộ thật thì theo [`secret-leak.md`](secret-leak.md) (thu hồi trước) rồi dùng các bước dưới đây để chuyển.
- Một lần cho `app_runtime` (web, job xuất của worker) và một lần cho `app_worker` (worker).

## Điều kiện trước
- Có quyền superuser/ops trên cluster (kết nối socket trên máy CSDL hoặc qua kênh quản trị).
- Có thể triển khai **lần lượt** từng bản web/worker (hai bản web sau Caddy — ARC-RES-005), để luôn có bản đang phục vụ.
- Biết login hiện tại: `select rolname, rolcanlogin from pg_roles where rolname like 'app_runtime%' or rolname like 'app_worker%';` — lần đầu login là chính `<base>`; các lần sau là `<base>_a` hoặc `<base>_b`.

## Các bước
1. **Tạo/bật login mới** (login đang KHÔNG dùng; lần đầu chọn `_b`):
   `psql -v base=app_runtime -v login=app_runtime_b -f packages/db/sql/rotate-login.sql`
   Script chỉ nhận `app_runtime|app_worker` và `<base>_a|<base>_b`; login mới không superuser, không `BYPASSRLS`, kế thừa quyền của `<base>` (`GRANT … WITH INHERIT TRUE, SET FALSE`) và chép giới hạn thời gian của `<base>` (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`). Chạy lại an toàn.
2. **Đặt mật khẩu mới**: trong psql, `\password app_runtime_b` (nhập 2 lần, không hiện trên màn hình). Lưu ngay vào kho bí mật.
3. **Triển khai lần lượt** từng bản với `DATABASE_URL` dùng `app_runtime_b` + mật khẩu mới. Trong lúc này bản cũ vẫn mở kết nối mới bằng login cũ bình thường.
4. **Tắt login cũ** khi mọi bản đã chạy bằng login mới: `ALTER ROLE app_runtime NOLOGIN;` (lần sau: `ALTER ROLE app_runtime_a NOLOGIN;`). Truy vấn đang chạy không bị cắt.
5. **Dọn phiên còn lại của login cũ** (sau bước 4, khi chắc không còn bản nào dùng): `select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app_runtime';` — pool của ứng dụng bỏ kết nối bị cắt (`packages/app/src/db/pool.ts` bắt lỗi kết nối rảnh; worker ghi `pool.idle_error`) và mở kết nối mới bằng login mới.
6. Lặp lại cho `app_worker`. Lần xoay sau đổi chiều (`_b` → `_a`).

## Xác minh
- `select usename, count(*) from pg_stat_activity where usename like 'app_%' group by 1;` chỉ còn login mới.
- Đăng nhập bằng login cũ bị từ chối: `role "app_runtime" is not permitted to log in`.
- `/api/health` của từng bản trả 200; không có cảnh báo lỗi 5xx tăng ([`SLO.md`](../SLO.md)).
- Diễn tập tự động (chạy trong CI, project `db`): `pnpm vitest run --project db password-rotation` — bản cũ và mới chạy song song, tắt login cũ không cắt kết nối đang mở, login mới cùng RLS và `statement_timeout`, không `SET ROLE` sang role gốc, script từ chối tên lạ.

## Hoàn tác / đường lùi
- Trước bước 4: chỉ cần triển khai lại bản dùng login cũ; login mới để `NOLOGIN` (`ALTER ROLE app_runtime_b NOLOGIN;`).
- Sau bước 4 mà bản mới lỗi: `ALTER ROLE app_runtime LOGIN;` (mật khẩu cũ vẫn còn nếu chưa đổi) rồi triển khai lại bản cũ.
- Không `DROP ROLE` login luân phiên (lần xoay sau dùng lại); nếu thật cần bỏ: `REASSIGN OWNED`/`DROP OWNED` không cần vì login không sở hữu đối tượng.

## Liên hệ và leo thang
- Người trực vận hành → Tech Lead. Nghi lộ mật khẩu: SEV1 theo [`INCIDENT-RESPONSE.md`](../INCIDENT-RESPONSE.md) và [`secret-leak.md`](secret-leak.md).
