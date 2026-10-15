// Vitest globalSetup cho project `db`: có Postgres 17 → bootstrap role → DB template đã migrate.
// Mỗi file test tạo DB riêng từ template (createTestDb) nên test cô lập và chạy song song được.
import { readFileSync } from "node:fs";
import { migrateToLatest } from "@hm/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { TEST_ROLE_PASSWORD } from "./constants.ts";
import { type PgCluster, startPgCluster } from "./pg-cluster.ts";

export const TEMPLATE_DB = "hm_test_template";
const ROLES_SQL = new URL("../../db/sql/bootstrap-roles.sql", import.meta.url);

import "./db.ts"; // nạp khai báo ProvidedContext.pgAdminUrl

function dbUrl(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export function kyselyFor(url: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 4 }) }),
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let cluster: PgCluster | undefined;
  if (!process.env.TEST_DATABASE_URL) cluster = await startPgCluster();
  const adminUrl = process.env.TEST_DATABASE_URL ?? (cluster as PgCluster).adminUrl;

  const admin = kyselyFor(adminUrl);
  await sql.raw(readFileSync(ROLES_SQL, "utf8")).execute(admin);
  // Mật khẩu CHỈ cho cluster/service test dùng một lần (CI service Postgres đòi xác thực mật khẩu).
  await sql.raw(`ALTER ROLE app_runtime PASSWORD '${TEST_ROLE_PASSWORD}'`).execute(admin);
  await sql.raw(`ALTER ROLE app_worker PASSWORD '${TEST_ROLE_PASSWORD}'`).execute(admin);
  await sql.raw(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`).execute(admin);
  await sql.raw(`CREATE DATABASE ${TEMPLATE_DB}`).execute(admin);
  await admin.destroy();

  const tpl = kyselyFor(dbUrl(adminUrl, TEMPLATE_DB));
  try {
    await migrateToLatest(tpl);
  } finally {
    await tpl.destroy();
  }

  project.provide("pgAdminUrl", adminUrl);
  return async () => {
    cluster?.stop();
  };
}
