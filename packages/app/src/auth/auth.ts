// Xác thực tự host bằng Better Auth (ADR-0002). CHỈ bật: email/mật khẩu, twoFactor (TOTP), quản lý phiên.
// Không bật magic link, OAuth proxy, SSO, SCIM, Stripe, device login (các plugin có advisory 2026).
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import pg from "pg";
import { clearFailures, DEFAULT_LOCKOUT, isLocked, type LockoutPolicy, recordFailure } from "./lockout.ts";

export const ENABLED_PLUGINS = ["two-factor"] as const;

export interface AuthDeps {
  /** URL tới Postgres bằng role app_runtime; pool riêng với search_path=auth. */
  databaseUrl: string;
  secret: string;
  baseURL: string;
  lockout?: LockoutPolicy;
  /** Giới hạn tần suất theo IP của Better Auth (mặc định bật). Test khoá theo tài khoản tắt để cô lập hành vi. */
  ipRateLimit?: boolean;
  /** Phiên rảnh quá lâu thì hết hạn (access Q-07: 12 giờ, tham số). */
  sessionIdleHours?: number;
  now?: () => Date;
}

export function createAuth(deps: AuthDeps) {
  const pool = new pg.Pool({ connectionString: deps.databaseUrl, options: "-c search_path=auth", max: 10 });
  pool.on("error", () => {
    // Lỗi kết nối nhàn rỗi (DB khởi động lại…) — pool tự bỏ client hỏng; request kế tiếp mở kết nối mới.
  });
  const lockout = deps.lockout ?? DEFAULT_LOCKOUT;
  const now = deps.now ?? (() => new Date());
  const idleSeconds = (deps.sessionIdleHours ?? 12) * 3600;

  const auth = betterAuth({
    appName: "Hotel Manager",
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: pool,
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: false },
    // Phiên lăn: hết hạn sau `idle` không hoạt động; gia hạn tối đa mỗi giờ.
    session: { expiresIn: idleSeconds, updateAge: 3600 },
    plugins: [twoFactor({ issuer: "Hotel Manager" })],
    // Theo IP: chống dò mật khẩu hàng loạt; khoá theo TÀI KHOẢN nằm ở hooks bên dưới.
    rateLimit: {
      enabled: deps.ipRateLimit ?? true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 20 } },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: deps.baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
        if (email && (await isLocked(pool, email, now()))) {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_LOCKED",
            message: "Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau.",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
        if (!email) return;
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError && returned.status === "UNAUTHORIZED";
        if (failed) await recordFailure(pool, email, now(), lockout);
        else if (!(returned instanceof APIError)) await clearFailures(pool, email);
      }),
    },
  });

  return { auth, pool, close: () => pool.end() };
}

export type Auth = ReturnType<typeof createAuth>["auth"];
