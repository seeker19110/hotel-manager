// Cấu hình riêng của worker (PLAN đợt 4 T-301, BASE-CFG-002). Worker dùng CÙNG schema với web (`loadConfig`) cộng một biến chỉ
// worker cần: `WORKER_DATABASE_URL` — kết nối vai trò `app_worker` (relay outbox, job nền; INV-G1) tách khỏi `DATABASE_URL`
// (vai trò `app_runtime` của web). Tách khỏi `envSchema` để web không phải đặt biến này và `.env.example` của web giữ nguyên.
import { type AppConfig, ConfigError, isDbUrlWithoutVerifiedTls, loadConfig } from "./schema.ts";

export const WORKER_ENV_KEYS = ["WORKER_DATABASE_URL"] as const;
/** Biến bí mật của worker (không bao giờ in giá trị). */
export const WORKER_SECRET_KEYS = ["WORKER_DATABASE_URL"] as const;

export interface WorkerConfig {
  app: AppConfig;
  /** URL postgres:// của vai trò app_worker — bí mật. */
  workerDatabaseUrl: string;
}

/** Đọc + validate env của worker; sai/thiếu → ConfigError liệt kê TÊN biến của cả hai schema (không giá trị). */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const issues: { key: string; reason: string }[] = [];
  let app: AppConfig | undefined;
  try {
    app = loadConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    issues.push(...err.issues);
  }
  const url = env.WORKER_DATABASE_URL;
  if (url === undefined || url === "")
    issues.push({ key: "WORKER_DATABASE_URL", reason: "thiếu hoặc sai kiểu" });
  else if (!/^postgres(ql)?:\/\//.test(url))
    issues.push({ key: "WORKER_DATABASE_URL", reason: "phải là URL postgres://" });
  else if (env.NODE_ENV === "production" && isDbUrlWithoutVerifiedTls(url))
    issues.push({
      key: "WORKER_DATABASE_URL",
      reason: "production tới máy khác dùng ?sslmode=verify-full (DB-SEC-003)",
    });
  if (issues.length > 0 || !app) throw new ConfigError(issues);
  return Object.freeze({ app, workerDatabaseUrl: url as string });
}
