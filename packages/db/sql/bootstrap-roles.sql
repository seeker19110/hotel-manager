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
