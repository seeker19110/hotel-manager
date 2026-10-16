// Ngữ cảnh server dùng chung (khởi tạo lười khi request đầu tiên tới; build không cần env).
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { type Auth, createAuth } from "../auth/auth.ts";
import { type AppConfig, loadConfig } from "../config/schema.ts";
import { eicarOnlyScanner, type MalwareScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { createLogger, type Logger } from "../logging/logger.ts";

export interface ServerContext {
  config: AppConfig;
  db: Kysely<unknown>;
  auth: Auth;
  log: Logger;
  storage: ObjectStorage;
  scanner: MalwareScanner;
}

/**
 * Production CHƯA có máy quét thật (`ClamdScanner`, D-003/T-210): quét lỗi ⇒ upload thất bại (fail-closed), không để
 * adapter chỉ biết EICAR "quét sạch" file thật. Dev/CI/test dùng `eicarOnlyScanner`.
 */
const unconfiguredScanner: MalwareScanner = {
  async scan() {
    throw new Error("Chưa cấu hình máy quét mã độc (ClamdScanner) — từ chối nhận file");
  },
};

let ctx: ServerContext | undefined;

export function serverContext(env: Record<string, string | undefined> = process.env): ServerContext {
  if (ctx) return ctx;
  const config = loadConfig(env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
  ctx = {
    config,
    db: new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }),
    auth: createAuth({
      databaseUrl: config.DATABASE_URL,
      secret: config.BETTER_AUTH_SECRET,
      baseURL: config.APP_BASE_URL,
    }).auth,
    log: createLogger({ level: config.LOG_LEVEL }),
    storage: new ObjectStorage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    }),
    scanner: config.NODE_ENV === "production" ? unconfiguredScanner : eicarOnlyScanner,
  };
  return ctx;
}
