import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { inject } from "vitest";
import { TEST_ROLE_PASSWORD } from "./constants.js";

const TEMPLATE_DB = "hm_test_template";

export interface TestDb {
  /** Kết nối superuser/owner — dùng cho dựng dữ liệu và kiểm catalog; KHÔNG chịu RLS. */
  admin: Kysely<unknown>;
  /** Kết nối role `app_runtime` (chịu RLS) — dùng để chứng minh bất biến như ứng dụng thật thấy. */
  runtime: Kysely<unknown>;
  name: string;
  drop(): Promise<void>;
}

function withDb(base: string, database: string, user?: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user;
    u.password = TEST_ROLE_PASSWORD;
  }
  return u.toString();
}

function connect(url: string, max = 10): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max }) }),
  });
}

/** DB mới nhân bản từ template đã migrate (CREATE DATABASE … TEMPLATE) — cô lập theo file test. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject("pgAdminUrl");
  const name = `hm_t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const server = connect(adminUrl, 1);
  await sql.raw(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`).execute(server);
  await server.destroy();
  const admin = connect(withDb(adminUrl, name));
  const runtime = connect(withDb(adminUrl, name, "app_runtime"), 120);
  return {
    admin,
    runtime,
    name,
    async drop() {
      await runtime.destroy();
      await admin.destroy();
      const s = connect(adminUrl, 1);
      await sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).execute(s);
      await s.destroy();
    },
  };
}
