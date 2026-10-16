// Xác thực tự host bằng Better Auth (ADR-0002). CHỈ bật: email/mật khẩu, twoFactor (TOTP), emailOTP (người thuê — D-005,
// D-011, D-016), quản lý phiên. Không bật magic link, OAuth proxy, SSO, SCIM, Stripe, device login (advisory 2026).
// emailOTP: OTP lưu dạng băm, 6 số, hạn 5 phút, 3 lần thử, không tự đăng ký; CHỈ đăng nhập (`sign-in`) và chỉ cho tài
// khoản mà mọi membership còn hiệu lực đều là `tenant` (`app.otp_sign_in_allowed`) — nhân viên luôn mật khẩu + TOTP.
// Tài khoản không đủ điều kiện: không gửi mã (phản hồi như thường, không lộ email có tồn tại không) và chặn bước đăng nhập.
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { createPool } from "../db/pool.ts";
import { requestClient, type SecurityClient } from "../logging/security-events.ts";
import { type AuthEventInput, correlationFrom, createAuthEvents } from "./auth-events.ts";
import { clearFailures, DEFAULT_LOCKOUT, isLocked, type LockoutPolicy, recordFailure } from "./lockout.ts";

export const ENABLED_PLUGINS = ["two-factor", "email-otp"] as const;

/** Đường OTP không dùng (quên mật khẩu, đổi email, xác minh email…) — chặn hẳn. */
const OTP_BLOCKED_PATHS = new Set([
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/forget-password/email-otp",
]);

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
  /** Gửi mã OTP đăng nhập cho người thuê (EmailSender; KHÔNG ghi mã vào log/CSDL thông báo). */
  sendSignInOtp?: (email: string, otp: string) => Promise<void>;
}

/** Ngữ cảnh hook tối thiểu cần để đọc client/phiên (kiểu đầy đủ của Better Auth quá rộng). */
interface HookCtx {
  headers?: Headers | undefined;
  request?: Request | undefined;
  context: { newSession?: { user: { id: string; twoFactorEnabled?: boolean | null } } | null };
}

const clientOf = (ctx: HookCtx): SecurityClient =>
  requestClient(ctx.headers ?? ctx.request?.headers ?? new Headers());
const headersOf = (ctx: HookCtx): Headers | undefined => ctx.headers ?? ctx.request?.headers;

/** Người dùng của phiên trong request (không tạo/đổi cookie); không có phiên → null. */
async function sessionUserId(ctx: {
  getSignedCookie: (name: string, secret: string) => Promise<string | false | null | undefined>;
  context: {
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: { findSession: (token: string) => Promise<{ user: { id: string } } | null> };
  };
}): Promise<string | null> {
  try {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    if (!token) return null;
    return (await ctx.context.internalAdapter.findSession(token))?.user.id ?? null;
  } catch {
    return null;
  }
}

/** Trạng thái theo request giữa hook `before` → `after` (khoá theo đối tượng `ctx.context` của request — không dùng chung). */
const requestState = new WeakMap<object, { userId: string | null }>();

/** Đường xác minh yếu tố thứ hai của Better Auth (two-factor). */
const SECOND_FACTOR_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);

export function createAuth(deps: AuthDeps) {
  // Lỗi kết nối nhàn rỗi (DB khởi động lại…) — pool tự bỏ client hỏng; request kế tiếp mở kết nối mới.
  const pool = createPool(deps.databaseUrl, { options: "-c search_path=auth", max: 10 });
  const lockout = deps.lockout ?? DEFAULT_LOCKOUT;
  const now = deps.now ?? (() => new Date());
  const idleSeconds = (deps.sessionIdleHours ?? 12) * 3600;
  const otpAllowed = async (email: string): Promise<boolean> => {
    if (!email || email.length > 320) return false;
    const r = await pool.query<{ ok: boolean }>("select app.otp_sign_in_allowed($1) as ok", [email]);
    return r.rows[0]?.ok === true;
  };

  const events = createAuthEvents(pool);
  /** Phát sự kiện xác thực; mọi lỗi đã được nuốt ở `record` (không làm hỏng luồng đăng nhập). */
  const record = (ctx: HookCtx, e: Omit<AuthEventInput, "client" | "correlationId">) =>
    events.record({ ...e, client: clientOf(ctx), correlationId: correlationFrom(headersOf(ctx)) });

  const auth = betterAuth({
    appName: "Hotel Manager",
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: pool,
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: false },
    // Phiên lăn: hết hạn sau `idle` không hoạt động; gia hạn tối đa mỗi giờ.
    session: { expiresIn: idleSeconds, updateAge: 3600 },
    plugins: [
      twoFactor({ issuer: "Hotel Manager" }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        disableSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in" || !(await otpAllowed(email))) return;
          await deps.sendSignInOtp?.(email, otp);
        },
      }),
    ],
    // Theo IP: chống dò mật khẩu hàng loạt; khoá theo TÀI KHOẢN nằm ở hooks bên dưới.
    rateLimit: {
      enabled: deps.ipRateLimit ?? true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 20 },
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: deps.baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (OTP_BLOCKED_PATHS.has(ctx.path)) throw new APIError("NOT_FOUND", { message: "Không hỗ trợ" });
        if (ctx.path === "/sign-out") {
          // Phiên bị xoá bởi chính endpoint ⇒ phải đọc người dùng TRƯỚC (hook `after` ghi `auth.logout`).
          requestState.set(ctx.context, { userId: await sessionUserId(ctx) });
          return;
        }
        if (ctx.path === "/email-otp/send-verification-otp") {
          if ((ctx.body as { type?: unknown } | undefined)?.type !== "sign-in")
            throw new APIError("NOT_FOUND", { message: "Không hỗ trợ" });
          return;
        }
        if (ctx.path === "/sign-in/email-otp") {
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
          // Cùng phản hồi với mã sai: không lộ tài khoản có tồn tại / có phải nhân viên.
          if (!(await otpAllowed(email))) {
            await record(ctx, {
              event: "auth.login",
              outcome: "failure",
              userId: null,
              reason: "otp_not_allowed",
            });
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_OTP",
              message: "Mã không đúng hoặc đã hết hạn.",
            });
          }
          return;
        }
        if (ctx.path !== "/sign-in/email") return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
        if (email && (await isLocked(pool, email, now()))) {
          await record(ctx, {
            event: "auth.login",
            outcome: "denied",
            userId: await events.userIdByEmail(email),
            reason: "account_locked",
          });
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_LOCKED",
            message: "Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau.",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError;
        const newUserId = ctx.context.newSession?.user.id ?? null;
        switch (ctx.path) {
          case "/sign-in/email": {
            const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
            if (!email) return;
            if (returned instanceof APIError && returned.status === "UNAUTHORIZED") {
              const locked = await recordFailure(pool, email, now(), lockout);
              const userId = await events.userIdByEmail(email);
              await record(ctx, {
                event: "auth.login",
                outcome: "failure",
                userId,
                reason: "invalid_credentials",
              });
              if (locked)
                await record(ctx, { event: "auth.account_locked", outcome: "denied", userId, audit: true });
            } else if (!failed) {
              await clearFailures(pool, email);
              // Tài khoản bật MFA: mật khẩu đúng nhưng CHƯA có phiên (plugin two-factor đổi sang bước hai) ⇒ chưa phải
              // đăng nhập thành công; `auth.login` được phát khi xác minh yếu tố thứ hai xong.
              if (newUserId && !ctx.context.newSession?.user.twoFactorEnabled)
                await record(ctx, {
                  event: "auth.login",
                  outcome: "success",
                  userId: newUserId,
                  reason: "password",
                  audit: true,
                });
            }
            return;
          }
          case "/sign-in/email-otp": {
            if (failed)
              await record(ctx, {
                event: "auth.login",
                outcome: "failure",
                userId: null,
                reason: "otp_invalid",
              });
            else if (newUserId)
              await record(ctx, {
                event: "auth.login",
                outcome: "success",
                userId: newUserId,
                reason: "email_otp",
                audit: true,
              });
            return;
          }
          case "/sign-out": {
            const userId = requestState.get(ctx.context)?.userId ?? null;
            if (!failed && userId)
              await record(ctx, { event: "auth.logout", outcome: "success", userId, audit: true });
            return;
          }
          case "/change-password": {
            const userId = failed
              ? await sessionUserId(ctx)
              : ((returned as { user?: { id?: string } } | null)?.user?.id ?? null);
            await record(ctx, {
              event: "auth.password_changed",
              outcome: failed ? "failure" : "success",
              userId,
              ...(failed ? { reason: "invalid_password" } : { audit: true, notify: true }),
            });
            return;
          }
          case "/two-factor/disable": {
            const userId = failed ? await sessionUserId(ctx) : newUserId;
            await record(ctx, {
              event: "auth.mfa_disabled",
              outcome: failed ? "failure" : "success",
              userId,
              ...(failed ? { reason: "invalid_password" } : { audit: true, notify: true }),
            });
            return;
          }
          default: {
            if (!SECOND_FACTOR_PATHS.has(ctx.path)) return;
            // Hai chế độ: bước hai của ĐĂNG NHẬP (có cookie thử thách `two_factor`, chưa có phiên) hay XÁC MINH khi ĐĂNG KÝ MFA
            // (đã có phiên). Chỉ đăng nhập mới là `auth.login`; đăng ký thành công lần đầu (đổi phiên ⇒ `newSession`, người dùng
            // chưa bật 2FA trước đó) là `auth.mfa_enabled`.
            const cookie = ctx.context.createAuthCookie("two_factor").name;
            const signIn = (headersOf(ctx)?.get("cookie") ?? "")
              .split(/;\s*/)
              .some((c) => c.startsWith(`${cookie}=`));
            if (signIn) {
              if (failed)
                await record(ctx, {
                  event: "auth.login",
                  outcome: "failure",
                  userId: null,
                  reason: "mfa_invalid",
                });
              else
                await record(ctx, {
                  event: "auth.login",
                  outcome: "success",
                  userId: newUserId,
                  reason: "mfa",
                  audit: true,
                });
            } else if (failed) {
              await record(ctx, {
                event: "auth.mfa_enabled",
                outcome: "failure",
                userId: await sessionUserId(ctx),
                reason: "mfa_invalid",
              });
            } else if (newUserId) {
              await record(ctx, {
                event: "auth.mfa_enabled",
                outcome: "success",
                userId: newUserId,
                audit: true,
              });
            }
          }
        }
      }),
    },
  });

  return { auth, pool, close: () => pool.end() };
}

export type Auth = ReturnType<typeof createAuth>["auth"];
