// Ngữ cảnh server dùng chung (khởi tạo lười khi request đầu tiên tới; build không cần env).
import { Kysely, PostgresDialect } from "kysely";
import { type Auth, createAuth } from "../auth/auth.ts";
import { createSignInOtpSender } from "../auth/otp-mail.ts";
import { type AppConfig, loadConfig } from "../config/schema.ts";
import { createPool } from "../db/pool.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import { type AppServices, createServices } from "./services.ts";

export interface ServerContext {
  config: AppConfig;
  db: Kysely<unknown>;
  auth: Auth;
  log: Logger;
  services: AppServices;
}

let ctx: ServerContext | undefined;

export function serverContext(env: Record<string, string | undefined> = process.env): ServerContext {
  if (ctx) return ctx;
  const config = loadConfig(env);
  const sendSignInOtp = createSignInOtpSender(config.SMTP_URL);
  const pool = createPool(config.DATABASE_URL, { max: 20 });
  ctx = {
    config,
    db: new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }),
    auth: createAuth({
      databaseUrl: config.DATABASE_URL,
      secret: config.BETTER_AUTH_SECRET,
      baseURL: config.APP_BASE_URL,
      ...(sendSignInOtp ? { sendSignInOtp } : {}),
    }).auth,
    log: createLogger({ level: config.LOG_LEVEL }),
    services: createServices(config),
  };
  return ctx;
}
