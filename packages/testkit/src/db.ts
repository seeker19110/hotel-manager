import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { inject } from "vitest";
import { TEST_ROLE_PASSWORD } from "./constants.ts";

/** Cấu hình S3 test do global-setup cung cấp. Gọi `inject` ở đây vì gói khác có thể nạp biến thể peer khác của
 *  vitest, khi đó khai báo `ProvidedContext` bên dưới không áp sang được. */
export function testS3Config(): import("./s3-server.ts").S3TestConfig {
  return inject("s3");
}

const TEMPLATE_DB = "hm_test_template";

declare module "vitest" {
  export interface ProvidedContext {
    /** URL superuser của Postgres test — do global-setup cung cấp. */
    pgAdminUrl: string;
    /** Cấu hình S3 test (SeaweedFS tạm hoặc TEST_S3_*). */
    s3: import("./s3-server.ts").S3TestConfig;
  }
}

export interface TestDb {
  /** Kết nối superuser/owner — dùng cho dựng dữ liệu và kiểm catalog; KHÔNG chịu RLS. */
  admin: Kysely<unknown>;
  /** Kết nối role `app_runtime` (chịu RLS) — dùng để chứng minh bất biến như ứng dụng thật thấy. */
  runtime: Kysely<unknown>;
  /** URL kết nối role app_runtime tới DB này (cho thư viện tự tạo pool, vd Better Auth). */
  runtimeUrl: string;
  /** Kết nối role `app_worker` (relay outbox, job nền). */
  worker: Kysely<unknown>;
  workerUrl: string;
  /** URL superuser tới DB này (cài schema pg-boss trong test). */
  adminUrl: string;
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
  const runtimeUrl = withDb(adminUrl, name, "app_runtime");
  const runtime = connect(runtimeUrl, 120);
  const workerUrl = withDb(adminUrl, name, "app_worker");
  const worker = connect(workerUrl, 10);
  return {
    admin,
    runtime,
    runtimeUrl,
    worker,
    workerUrl,
    adminUrl: withDb(adminUrl, name),
    name,
    async drop() {
      await worker.destroy();
      await runtime.destroy();
      await admin.destroy();
      const s = connect(adminUrl, 1);
      // Chờ các kết nối đang đóng của pool kết thúc hẳn (tối đa 5 s) trước khi xoá: FORCE cắt một client đang đóng
      // làm nó phát lỗi 57P01 không ai bắt (test chập chờn — tìm thấy ở T-009). FORCE chỉ còn là lưới cuối.
      for (let i = 0; i < 50; i++) {
        const r = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where datname = ${name}`.execute(s);
        if ((r.rows[0]?.n ?? 0) === 0) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      await sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).execute(s);
      await s.destroy();
    },
  };
}
