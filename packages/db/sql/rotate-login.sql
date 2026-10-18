-- Xoay mật khẩu role ứng dụng KHÔNG downtime (DB-SEC-004; runbook docs/ops/runbooks/db-password-rotation.md).
-- PostgreSQL chỉ giữ MỘT mật khẩu mỗi role, nên không đổi mật khẩu tại chỗ (kết nối mới của bản đang chạy sẽ hỏng tới khi triển khai
-- lại). Thay vào đó luân phiên hai role ĐĂNG NHẬP `<base>_a`/`<base>_b` là thành viên của role quyền `<base>` (app_runtime/app_worker):
-- tạo/bật login mới → đặt mật khẩu → triển khai lần lượt từng bản với URL mới (bản cũ vẫn chạy bằng login cũ) → tắt login cũ.
-- Chạy bằng superuser/ops:  psql -v base=app_runtime -v login=app_runtime_b -f packages/db/sql/rotate-login.sql
-- rồi đặt mật khẩu KHÔNG qua dòng lệnh:  \password app_runtime_b   (SCRAM, không vào log/lịch sử shell).
-- Idempotent: chạy lại an toàn. Không đụng role `<base>` (giữ quyền, RLS, giới hạn thời gian).
\set ON_ERROR_STOP on

-- Chỉ nhận đúng cặp base/login của dự án — chặn gõ nhầm tạo role lạ hoặc cấp quyền cho role khác.
SELECT (:'base' NOT IN ('app_runtime', 'app_worker') OR :'login' NOT IN (:'base' || '_a', :'base' || '_b')) AS sai \gset
\if :sai
  \echo 'rotate-login: base phải là app_runtime|app_worker và login phải là <base>_a|<base>_b'
  -- Lỗi có chủ đích để psql dừng với exit 3 (ON_ERROR_STOP): \quit không trả mã lỗi.
  SELECT current_setting('rotate_login.tham_so_khong_hop_le');
\endif

-- Login mới: cùng thuộc tính an toàn với role gốc (không superuser, không BYPASSRLS, không tạo role/DB).
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', :'login')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'login') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'login') \gexec
-- Kế thừa quyền của role gốc (PG ≥ 16: INHERIT theo từng grant), không được SET ROLE sang role gốc.
SELECT format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', :'base', :'login') \gexec
-- Thiết lập theo role (statement_timeout, lock_timeout…) KHÔNG kế thừa qua membership → chép từ role gốc.
SELECT format('ALTER ROLE %I SET %s TO %L', :'login', split_part(c, '=', 1), substr(c, strpos(c, '=') + 1))
FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole, unnest(s.setconfig) AS c
WHERE r.rolname = :'base' AND s.setdatabase = 0 \gexec
\echo 'rotate-login: ' :'login' ' sẵn sàng — đặt mật khẩu bằng \\password, triển khai lần lượt, rồi tắt login cũ (runbook).'
