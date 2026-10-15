// T-006 — bảng của Better Auth 1.7.9 (schema `auth`, ADR-0002) + khoá đăng nhập theo tài khoản (access Q-07).
// SQL lấy từ `getMigrations(...).compileMigrations()` của better-auth 1.7.9 với plugin twoFactor + rateLimit database,
// đặt vào schema `auth`. Nâng cấp Better Auth mà schema đổi → migration MỚI (không sửa file này).
import { type Kysely, sql } from "kysely";

const UP = `
CREATE SCHEMA auth;

CREATE TABLE auth."user" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "twoFactorEnabled" boolean
);
CREATE TABLE auth."session" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE
);
CREATE TABLE auth."account" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  "scope" text, "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE auth."verification" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE auth."twoFactor" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);
CREATE TABLE auth."rateLimit" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
CREATE INDEX "session_userId_idx" ON auth."session" ("userId");
CREATE INDEX "account_userId_idx" ON auth."account" ("userId");
CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");
CREATE INDEX "twoFactor_secret_idx" ON auth."twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON auth."twoFactor" ("userId");

-- Khoá tạm theo TÀI KHOẢN sau N lần sai (access Q-07; rate limit của Better Auth chỉ theo IP).
-- Lưu băm email, không lưu email rõ.
CREATE TABLE auth.login_throttle (
  email_hash bytea PRIMARY KEY CHECK (octet_length(email_hash) = 32),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);

ALTER TABLE memberships ADD CONSTRAINT fk_memberships_auth_user
  FOREIGN KEY (auth_user_id) REFERENCES auth."user" ("id") ON DELETE RESTRICT;

-- Liệt kê tổ chức của người đăng nhập TRƯỚC khi có ngữ cảnh tổ chức (ERD §1): phạm vi hẹp, chỉ trả cột cần.
CREATE FUNCTION app.list_my_organizations(p_auth_user_id uuid)
  RETURNS TABLE (organization_id uuid, organization_name text, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT o.id, o.name, m.id, m.role
    FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.auth_user_id = p_auth_user_id AND m.status = 'active' AND o.status = 'active'
      AND m.valid_from <= now() AND (m.valid_to IS NULL OR m.valid_to > now())
    ORDER BY o.name
  $$;
REVOKE ALL ON FUNCTION app.list_my_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_my_organizations(uuid) TO app_runtime;

GRANT USAGE ON SCHEMA auth TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO app_runtime;
`;

const DOWN = `
DROP FUNCTION IF EXISTS app.list_my_organizations(uuid);
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS fk_memberships_auth_user;
DROP SCHEMA IF EXISTS auth CASCADE;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db);
}
