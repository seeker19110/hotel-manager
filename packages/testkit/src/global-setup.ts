// Vitest globalSetup cho project `db`: có Postgres 17 → bootstrap role → DB template đã migrate.
// Mỗi file test tạo DB riêng từ template (createTestDb) nên test cô lập và chạy song song được.
import { migrateToLatest } from "@hm/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { bootstrapRoles } from "./bootstrap.ts";
import { type PgCluster, startPgCluster } from "./pg-cluster.ts";
import { type S3Server, type S3TestConfig, startS3Server } from "./s3-server.ts";

export const TEMPLATE_DB = "hm_test_template";

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
  // Mật khẩu role CHỈ cho cluster/service test dùng một lần (CI service Postgres đòi xác thực mật khẩu).
  await bootstrapRoles(admin);
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

  // Object storage cho test file (T-011): S3 có sẵn qua TEST_S3_* hoặc tự dựng SeaweedFS tạm.
  const s3: S3Server | undefined = process.env.TEST_S3_ENDPOINT ? undefined : await startS3Server();
  const s3cfg: S3TestConfig = s3
    ? s3.config
    : {
        endpoint: process.env.TEST_S3_ENDPOINT ?? "",
        region: process.env.TEST_S3_REGION ?? "vn-local",
        bucket: process.env.TEST_S3_BUCKET ?? "hm-test",
        accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "",
      };
  project.provide("s3", s3cfg);

  return async () => {
    await s3?.stop();
    cluster?.stop();
  };
}
