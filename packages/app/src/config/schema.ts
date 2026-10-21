// Cấu hình môi trường (BASE-CFG-001/002/005, ADR-0002). Mọi đọc `process.env` của server đi qua module này.
import { z } from "zod";
import { PiiKeyError, parseKeyring } from "../crypto/index.ts";
import { parseWebhookSecrets } from "./webhook-secrets.ts";

/** Biến là bí mật: không bao giờ in giá trị, không được có tiền tố NEXT_PUBLIC_ (lọt vào bundle client). */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "SMTP_URL",
  "PGBACKREST_REPO_CIPHER_PASS",
  "SIM_WEBHOOK_SECRET",
  "HM_PII_KEYS",
  "HM_PII_INDEX_KEY",
] as const;

const url = z.url();

/** Loopback: trình duyệt/Node coi là ngữ cảnh an toàn nên `http://` được chấp nhận (dev, E2E, CI); mọi máy khác phải TLS. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `http://` tới máy không phải loopback? (BASE-SEC-004: mọi kênh mạng dùng TLS ở production.) */
export function isInsecureRemoteUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Máy loopback của CSDL (sau khi bỏ ngoặc IPv6): E2E/CI một máy được miễn TLS. */
const DB_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * URL CSDL tới máy KHÁC (không loopback, không socket) mà thiếu `sslmode=verify-full`? (DB-SEC-003: kết nối CSDL qua TLS có
 * xác minh chứng chỉ; `require`/`prefer`/`disable` không xác minh máy chủ nên không đủ.) URL không đọc được → coi là không an toàn.
 *
 * Phải đọc URL GIỐNG driver (`pg-connection-string`), nếu không cổng bị qua mặt: driver lấy giá trị CUỐI của tham số lặp và
 * `?host=` ghi đè hostname. Nên: `sslmode` phải xuất hiện đúng một lần; `hostaddr` bị cấm; `?host=` chỉ chấp nhận là đường dẫn
 * socket tuyệt đối khi hostname URL rỗng (kể cả kèm verify-full cũng từ chối: một cách viết duy nhất); hostname rỗng không kèm socket → không rõ máy nào (rơi về `PGHOST`) nên không miễn.
 */
export function isDbUrlWithoutVerifiedTls(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return true;
    const params = u.searchParams;
    if (params.has("hostaddr")) return true;
    const hostParams = params.getAll("host");
    if (hostParams.length > 1) return true;
    if (hostParams.length === 1) {
      // Socket Unix qua `?host=/đường/dẫn` chỉ hợp lệ khi URL không nêu máy nào (nếu không, driver bỏ hostname và đi nơi khác).
      return !(u.hostname === "" && (hostParams[0] ?? "").startsWith("/"));
    }
    const host = decodeURIComponent(u.hostname).replace(/^\[(.+)\]$/, "$1");
    if (host.startsWith("/") || DB_LOOPBACK_HOSTS.has(host)) return false;
    return !isVerifiedTls(params);
  } catch {
    return true;
  }
}

/** `sslmode` xuất hiện đúng một lần và bằng `verify-full` (lặp tham số = không rõ driver dùng giá trị nào). */
function isVerifiedTls(params: URLSearchParams): boolean {
  const modes = params.getAll("sslmode");
  return modes.length === 1 && modes[0] === "verify-full";
}

/**
 * Tiền tố biến "công khai" — framework nhúng giá trị vào bundle client (Next `NEXT_PUBLIC_`, Vite, Expo…).
 * Dự án hiện KHÔNG dùng biến công khai nào (BASE-CFG-008): mọi khoá trong `envSchema` là server-only.
 */
export const PUBLIC_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "EXPO_PUBLIC_"] as const;
/** Tên chứa từ này mà lại có tiền tố công khai = bí mật sắp lọt vào bundle (trừ `PUBLIC_ENV_ALLOWLIST`). */
const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD/;
/** Biến công khai có tên giống bí mật nhưng đã duyệt là công khai (khoá công khai, mã site…) — hiện không có. */
export const PUBLIC_ENV_ALLOWLIST: readonly string[] = [];

/** Tên biến vi phạm: có tiền tố công khai VÀ tên giống bí mật (ngoài allowlist). */
export function publicSecretNames(names: readonly string[]): string[] {
  return names.filter(
    (n) =>
      PUBLIC_ENV_PREFIXES.some((p) => n.startsWith(p)) &&
      SECRET_NAME.test(n) &&
      !PUBLIC_ENV_ALLOWLIST.includes(n),
  );
}
/** Biến tuỳ chọn: chuỗi rỗng trong file env = không đặt. */
const optional = <T extends z.ZodType>(s: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), s.optional()) as unknown as z.ZodOptional<T>;

export const envSchema = z
  .object({
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
    /**
     * HMAC của webhook ngân hàng MÔ PHỎNG (API-CONTRACT §3); không đặt → `/api/v1/webhooks/sim/*` trả 404. Là DANH SÁCH khoá
     * phân tách dấu phẩy (tối đa 3, mỗi khoá ≥ 32 ký tự) để xoay khoá không gián đoạn: "khoá_mới,khoá_cũ" (BE-INT-002).
     */
    SIM_WEBHOOK_SECRET: z
      .string()
      .superRefine((v, ctx) => {
        try {
          parseWebhookSecrets(v);
        } catch (e) {
          ctx.addIssue({ code: "custom", message: (e as Error).message });
        }
      })
      .optional(),
    /** Khoá mã hoá số giấy tờ (D-004): "id:base64(32 byte),…"; bắt buộc ở production, dev/test dùng khoá dẫn xuất công khai. */
    HM_PII_KEYS: optional(z.string().min(1)),
    HM_PII_KEY_ID: optional(z.coerce.number().int().min(1).max(255)),
    HM_PII_INDEX_KEY: optional(z.string().min(1)),
    /** clamd (ClamAV) tự host — D-003. Bắt buộc ở production; dev/test không đặt → bản giả chỉ nhận chuỗi EICAR. */
    CLAMD_HOST: optional(z.string().min(1)),
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      // BASE-SEC-004: production không có kênh http:// tới máy khác (loopback được miễn).
      for (const k of ["APP_BASE_URL", "S3_ENDPOINT"] as const) {
        if (isInsecureRemoteUrl(env[k]))
          ctx.addIssue({ code: "custom", path: [k], message: "phải là https:// ở production" });
      }
      // DB-SEC-003: CSDL ở máy khác (container `postgres`) chỉ qua TLS có xác minh chứng chỉ; loopback (E2E/CI một máy) được miễn.
      if (isDbUrlWithoutVerifiedTls(env.DATABASE_URL))
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "production tới máy khác dùng ?sslmode=verify-full (DB-SEC-003)",
        });
      // smtp:// thuần gửi mật khẩu/thư không mã hoá: chỉ smtps://, fake:// hoặc smtp:// ép STARTTLS (`requireTLS=true`).
      if (env.SMTP_URL.startsWith("smtp://") && !/[?&]requireTLS=true(?:&|$)/.test(env.SMTP_URL)) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_URL"],
          message: "production dùng smtps:// (hoặc smtp:// kèm ?requireTLS=true)",
        });
      }
    }
    if (env.NODE_ENV === "production" && !env.CLAMD_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["CLAMD_HOST"],
        message: "bắt buộc ở production (máy quét mã độc)",
      });
    }
    const pii = [env.HM_PII_KEYS, env.HM_PII_KEY_ID, env.HM_PII_INDEX_KEY];
    if (pii.every((v) => v === undefined)) {
      if (env.NODE_ENV === "production") {
        for (const k of ["HM_PII_KEYS", "HM_PII_KEY_ID", "HM_PII_INDEX_KEY"] as const)
          ctx.addIssue({ code: "custom", path: [k], message: "bắt buộc ở production" });
      }
      return;
    }
    if (pii.some((v) => v === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["HM_PII_KEYS"],
        message: "đặt đủ HM_PII_KEYS, HM_PII_KEY_ID, HM_PII_INDEX_KEY",
      });
      return;
    }
    try {
      parseKeyring(env.HM_PII_KEYS as string, env.HM_PII_KEY_ID as number, env.HM_PII_INDEX_KEY as string);
    } catch (e) {
      const msg = e instanceof PiiKeyError ? e.message : "khoá không hợp lệ";
      ctx.addIssue({ code: "custom", path: [msg.split(":")[0] ?? "HM_PII_KEYS"], message: msg });
    }
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
  // AUD-CFG-001: mặc định `fake://local` NUỐT mọi thư (OTP người thuê, lời mời). Production quên đặt biến thì vẫn lên mà không
  // ai nhận được thư — nên production phải đặt SMTP_URL tường minh (`fake://…` vẫn được khi cố ý, như E2E).
  const smtpMissing =
    env.NODE_ENV === "production" && (env.SMTP_URL ?? "") === ""
      ? [{ key: "SMTP_URL", reason: "bắt buộc ở production (đặt smtps://… hoặc fake://local tường minh)" }]
      : [];
  if (!parsed.success || smtpMissing.length > 0) {
    const issues = (parsed.success ? [] : parsed.error.issues).map((i) => ({
      key: String(i.path[0] ?? "?"),
      reason: i.code === "invalid_type" ? "thiếu hoặc sai kiểu" : i.message,
    }));
    throw new ConfigError([...issues, ...smtpMissing.filter((m) => !issues.some((i) => i.key === m.key))]);
  }
  const config = { ...parsed.data } as AppConfig;
  Object.defineProperties(config, {
    toJSON: { value: () => redactConfig(config), enumerable: false },
    toString: { value: () => JSON.stringify(redactConfig(config)), enumerable: false },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: () => redactConfig(config), enumerable: false },
  });
  return Object.freeze(config);
}
