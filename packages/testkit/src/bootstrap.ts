// Dựng role ứng dụng cho DB test/E2E (dùng chung: global-setup Vitest, diễn tập sao lưu, server E2E).
import { readFileSync } from "node:fs";
import { type Kysely, sql } from "kysely";
import { TEST_ROLE_PASSWORD } from "./constants.ts";

const ROLES_SQL = new URL("../../db/sql/bootstrap-roles.sql", import.meta.url);

/** Tạo role app_runtime/app_worker (idempotent) + mật khẩu CHỈ cho cluster/service test dùng một lần. */
export async function bootstrapRoles(admin: Kysely<unknown>): Promise<void> {
  await sql.raw(readFileSync(ROLES_SQL, "utf8")).execute(admin);
  await sql.raw(`ALTER ROLE app_runtime PASSWORD '${TEST_ROLE_PASSWORD}'`).execute(admin);
  await sql.raw(`ALTER ROLE app_worker PASSWORD '${TEST_ROLE_PASSWORD}'`).execute(admin);
}

/** Đổi database (và tuỳ chọn user + mật khẩu test) trong URL Postgres. */
export function pgUrl(base: string, database: string, user?: "app_runtime" | "app_worker"): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user;
    u.password = TEST_ROLE_PASSWORD;
  }
  return u.toString();
}
