// Cấu hình môi trường (BASE-CFG-001/002/005, ADR-0002). Mọi đọc `process.env` của server đi qua module này.
import { z } from "zod";

/** Biến là bí mật: không bao giờ in giá trị, không được có tiền tố NEXT_PUBLIC_ (lọt vào bundle client). */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "SMTP_URL",
  "PGBACKREST_REPO_CIPHER_PASS",
  "SIM_WEBHOOK_SECRET",
  "NOTIFICATION_TOKEN_SECRET",
] as const;

const url = z.url();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_BASE_URL: url,
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "phải là URL postgres://"),
  BETTER_AUTH_SECRET: z.string().min(32, "tối thiểu 32 ký tự"),
  S3_ENDPOINT: url,
  S3_REGION: z.string().min(1).default("vn-local"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  SMTP_URL: z
    .string()
    .regex(/^(smtps?|fake):\/\//, "phải là smtp://, smtps:// hoặc fake://")
    .default("fake://local"),
  PGBACKREST_REPO_CIPHER_PASS: z.string().min(16).optional(),
  /** HMAC của webhook ngân hàng MÔ PHỎNG (API-CONTRACT §3); không đặt → `/api/v1/webhooks/sim/*` trả 404. */
  SIM_WEBHOOK_SECRET: z.string().min(32, "tối thiểu 32 ký tự").optional(),
  /** Khoá HMAC ký token huỷ đăng ký trong email (SPEC-notifications S-010); không đặt → liên kết huỷ đăng ký tắt. */
  NOTIFICATION_TOKEN_SECRET: z.string().min(32, "tối thiểu 32 ký tự").optional(),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[];

export class ConfigError extends Error {
  /** Chỉ tên biến và lý do — không bao giờ chứa giá trị. */
  readonly issues: readonly { key: string; reason: string }[];

  constructor(issues: readonly { key: string; reason: string }[]) {
    super(`Cấu hình môi trường không hợp lệ: ${issues.map((i) => `${i.key} (${i.reason})`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const MASK = "***";

/** Bản sao an toàn để in/log: mọi khoá bí mật thành `***` (BASE-CFG-005). */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = (SECRET_KEYS as readonly string[]).includes(k) && v !== undefined ? MASK : v;
  }
  return out;
}

/**
 * Đọc và validate env. Sai/thiếu → ConfigError liệt kê TÊN biến (không in giá trị).
 * Object trả về đông cứng; `JSON.stringify`/`String()` chỉ ra bản đã che.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      key: String(i.path[0] ?? "?"),
      reason: i.code === "invalid_type" ? "thiếu hoặc sai kiểu" : i.message,
    }));
    throw new ConfigError(issues);
  }
  const config = { ...parsed.data } as AppConfig;
  Object.defineProperties(config, {
    toJSON: { value: () => redactConfig(config), enumerable: false },
    toString: { value: () => JSON.stringify(redactConfig(config)), enumerable: false },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: () => redactConfig(config), enumerable: false },
  });
  return Object.freeze(config);
}
