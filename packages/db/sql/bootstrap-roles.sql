-- Vai trò CSDL (INV-G1, ADR-0001/0002). Chạy MỘT lần bởi superuser/ops khi dựng cluster, KHÔNG nằm trong migration.
-- Migration chạy bằng role sở hữu (owner); ứng dụng chạy bằng app_runtime/app_worker: không owner, không BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- Giới hạn thời gian theo role (DB-TX-003, TM-13): truy vấn treo hoặc transaction bỏ dở không giữ khoá mãi.
ALTER ROLE app_runtime SET statement_timeout = '15s';
ALTER ROLE app_runtime SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_runtime SET lock_timeout = '5s';
ALTER ROLE app_worker SET statement_timeout = '120s';
ALTER ROLE app_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_worker SET lock_timeout = '10s';
