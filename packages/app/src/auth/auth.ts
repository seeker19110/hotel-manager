// Xác thực tự host bằng Better Auth (ADR-0002). CHỈ bật: email/mật khẩu, twoFactor (TOTP), emailOTP (người thuê — D-005,
// D-011, D-016), quản lý phiên. Không bật magic link, OAuth proxy, SSO, SCIM, Stripe, device login (advisory 2026).
// emailOTP: OTP lưu dạng băm, 6 số, hạn 5 phút, 3 lần thử, không tự đăng ký; CHỈ đăng nhập (`sign-in`) và chỉ cho tài
// khoản mà mọi membership còn hiệu lực đều là `tenant` (`app.otp_sign_in_allowed`) — nhân viên luôn mật khẩu + TOTP.
// Tài khoản không đủ điều kiện: không gửi mã (phản hồi như thường, không lộ email có tồn tại không) và chặn bước đăng nhập.
import { SECONDS_PER_HOUR } from "@hm/domain";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { Kysely, PostgresDialect } from "kysely";
import { createPool } from "../db/index.ts";
import { t } from "../i18n.ts";
import { appLogger, requestClient, type SecurityClient } from "../logging/index.ts";
import { type ConsentChannel, type ConsentPurpose, grantConsent } from "../privacy/index.ts";
import { type AuthEventInput, correlationFrom, createAuthEvents } from "./auth-events.ts";
import {
  clearFailures,
  DEFAULT_LOCKOUT,
  type LockoutPolicy,
  lockRemainingSeconds,
  recordFailure,
} from "./lockout.ts";
import { hashPassword, needsRehash, verifyPassword } from "./password.ts";

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

/**
 * Trạng thái theo request giữa hook `before` → `after` (khoá theo đối tượng `ctx.context` của request — không dùng chung): người dùng
 * của `/sign-out`, đồng ý đã kiểm của `/sign-up/email`.
 */
const requestState = new WeakMap<object, { userId: string | null; consent?: SignUpConsent }>();

/**
 * Đồng ý khi ĐĂNG KÝ (T-2310, D-119; CMP-VN-001): thân `/sign-up/email` phải có `consents.service_core === true` (ô bắt buộc, không tick
 * sẵn); `consents.product_analytics` tuỳ chọn (chỉ `true` mới ghi — mặc định không đồng ý); `consent_channel` ∈ {register, invitation}
 * (đăng ký từ trang lời mời). Thiếu/sai ⇒ 400 CONSENT_REQUIRED, KHÔNG tạo tài khoản. Bản ghi đồng ý được ghi ở hook `after` cho đúng id
 * tài khoản vừa tạo (Better Auth tạo user trong transaction riêng nên không ghi chung được); văn bản/băm/phiên bản lấy ở server.
 */
interface SignUpConsent {
  purposes: ConsentPurpose[];
  channel: ConsentChannel;
}
export function parseSignUpConsent(body: unknown): SignUpConsent | null {
  const b = (body ?? {}) as { consents?: unknown; consent_channel?: unknown };
  const c = b.consents as { service_core?: unknown; product_analytics?: unknown } | null | undefined;
  if (c === null || typeof c !== "object" || Array.isArray(c) || c.service_core !== true) return null;
  if (c.product_analytics !== undefined && typeof c.product_analytics !== "boolean") return null;
  const extra = Object.keys(c).filter((k) => k !== "service_core" && k !== "product_analytics");
  if (extra.length > 0) return null;
  const channel = b.consent_channel ?? "register";
  if (channel !== "register" && channel !== "invitation") return null;
  return {
    purposes: c.product_analytics === true ? ["service_core", "product_analytics"] : ["service_core"],
    channel,
  };
}

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
  const idleSeconds = (deps.sessionIdleHours ?? 12) * SECONDS_PER_HOUR;
  const otpAllowed = async (email: string): Promise<boolean> => {
    if (!email || email.length > 320) return false;
    const r = await pool.query<{ ok: boolean }>("select app.otp_sign_in_allowed($1) as ok", [email]);
    return r.rows[0]?.ok === true;
  };

  // Băm lại ở chính bước verify (không ở hook `after`): đây là nơi duy nhất có đủ băm cũ + mật khẩu rõ, nên không phải
  // đọc lại tài khoản hay băm lần hai. Cập nhật kiểu so-và-đổi theo đúng băm cũ ⇒ hai lần đăng nhập song song không
  // ghi đè nhau, và nếu mật khẩu vừa bị đổi thì không ghi đè băm mới. Lỗi ghi KHÔNG làm hỏng đăng nhập (lần sau thử lại).
  const verifyAndUpgrade = async ({
    hash,
    password,
  }: {
    hash: string;
    password: string;
  }): Promise<boolean> => {
    const ok = await verifyPassword({ hash, password });
    if (ok && needsRehash(hash)) {
      try {
        await pool.query(
          `update auth.account set password = $1, "updatedAt" = $2
            where "providerId" = 'credential' and password = $3`,
          [await hashPassword(password), now(), hash],
        );
      } catch (error) {
        // Không làm hỏng đăng nhập: băm cũ vẫn hợp lệ, lần sau thử lại — nhưng ghi log (BASE-ERR-001).
        appLogger().warn("auth.password_rehash_failed", { error });
      }
    }
    return ok;
  };

  // Telemetry của Better Auth: tắt tường minh. Lưu ý thư viện còn bật nếu env BETTER_AUTH_TELEMETRY=1 (env thắng
  // tuỳ chọn) ⇒ chặn khởi động thay vì để gửi dữ liệu ra ngoài âm thầm.
  if (/^(1|true|yes|on)$/i.test(process.env.BETTER_AUTH_TELEMETRY ?? ""))
    throw new Error(t("auth.telemetry_must_be_off"));

  /** Tài khoản chỉ còn là người thuê (xuyên tổ chức): `app.otp_sign_in_allowed`. */
  const tenantOnlyUser = async (userId: string): Promise<boolean> => {
    const r = await pool.query<{ ok: boolean }>(
      `select app.otp_sign_in_allowed(u.email) as ok from auth."user" u where u.id = $1`,
      [userId],
    );
    return r.rows[0]?.ok === true;
  };

  const events = createAuthEvents(pool);
  const consentDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  /** Phát sự kiện xác thực; mọi lỗi đã được nuốt ở `record` (không làm hỏng luồng đăng nhập). */
  const record = (ctx: HookCtx, e: Omit<AuthEventInput, "client" | "correlationId">) =>
    events.record({ ...e, client: clientOf(ctx), correlationId: correlationFrom(headersOf(ctx)) });

  const auth = betterAuth({
    appName: "Hotel Manager",
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: pool,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: false,
      // Argon2id (BE-AUTH-001, D-031). `verify` nhận cả băm scrypt cũ và băm lại ngay khi mật khẩu đúng.
      password: { hash: hashPassword, verify: verifyAndUpgrade },
    },
    // Phiên lăn: hết hạn sau `idle` không hoạt động; gia hạn tối đa mỗi giờ.
    session: { expiresIn: idleSeconds, updateAge: SECONDS_PER_HOUR },
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
      // BE-AUTH-004: https → MỌI cookie của Better Auth (phiên, 2FA, thiết bị tin cậy…) mang tiền tố `__Host-` (trình duyệt buộc
      // Secure, Path=/, không Domain — subdomain không ghi đè được). Better Auth chỉ tự thêm `__Secure-` qua `useSecureCookies`,
      // nên tắt cờ đó và đặt tiền tố + `secure` rõ ràng. HTTP cục bộ/E2E không dùng được `__Host-` ⇒ tên thường, không Secure.
      useSecureCookies: false,
      ...(deps.baseURL.startsWith("https://") ? { cookiePrefix: "__Host-hm" } : {}),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        ...(deps.baseURL.startsWith("https://") ? { secure: true } : {}),
      },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          // AUD-SEC-001 (D-081): tài khoản chỉ còn là người thuê chỉ được có phiên qua OTP gửi tới hộp thư — không bao giờ qua mật khẩu,
          // thử thách TOTP đang chờ hay bất kỳ đường nào khác. Đóng mọi cửa sổ đua với bước Better Auth tự gỡ mật khẩu/phiên lúc OTP
          // xác minh email (người đăng ký trước bằng email nạn nhân không giữ/tạo được phiên người thuê của nạn nhân).
          before: async (session, context) => {
            if (context?.path === "/sign-in/email-otp") return;
            if (typeof session.userId === "string" && (await tenantOnlyUser(session.userId)))
              throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" }); // cùng phản hồi mật khẩu sai: không lộ tài khoản là người thuê
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (OTP_BLOCKED_PATHS.has(ctx.path))
          throw new APIError("NOT_FOUND", { message: t("auth.unsupported") });
        if (ctx.path === "/sign-up/email") {
          const consent = parseSignUpConsent(ctx.body);
          if (!consent)
            throw new APIError("BAD_REQUEST", {
              code: "CONSENT_REQUIRED",
              message: t("privacy.consent_required"),
            });
          requestState.set(ctx.context, { userId: null, consent });
          return;
        }
        if (ctx.path === "/sign-out") {
          // Phiên bị xoá bởi chính endpoint ⇒ phải đọc người dùng TRƯỚC (hook `after` ghi `auth.logout`).
          requestState.set(ctx.context, { userId: await sessionUserId(ctx) });
          return;
        }
        if (ctx.path === "/email-otp/send-verification-otp") {
          if ((ctx.body as { type?: unknown } | undefined)?.type !== "sign-in")
            throw new APIError("NOT_FOUND", { message: t("auth.unsupported") });
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
              message: t("auth.otp_invalid"),
            });
          }
          return;
        }
        if (ctx.path !== "/sign-in/email") return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
        const wait = email ? await lockRemainingSeconds(pool, email, now()) : 0;
        if (email && wait > 0) {
          await record(ctx, {
            event: "auth.login",
            outcome: "denied",
            userId: await events.userIdByEmail(email),
            reason: "account_locked",
          });
          throw new APIError(
            "TOO_MANY_REQUESTS",
            {
              code: "ACCOUNT_LOCKED",
              message: t("auth.locked_out"),
            },
            { "Retry-After": String(wait) },
          );
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError;
        const newUserId = ctx.context.newSession?.user.id ?? null;
        switch (ctx.path) {
          case "/sign-up/email": {
            const consent = requestState.get(ctx.context)?.consent;
            const userId = (returned as { user?: { id?: unknown } } | null)?.user?.id;
            if (failed || !consent || typeof userId !== "string") return;
            // Email đã có tài khoản: Better Auth trả người dùng GIẢ (id ngẫu nhiên, không có trong CSDL) để không lộ email tồn tại —
            // FK tới auth."user" từ chối ⇒ bỏ qua (không ghi đồng ý thay cho chủ tài khoản thật).
            try {
              for (const purpose of consent.purposes)
                await grantConsent(consentDb, { subjectId: userId, purpose, channel: consent.channel });
            } catch (error) {
              if ((error as { code?: unknown }).code !== "23503")
                appLogger().error("privacy.consent_write_failed", { error, channel: consent.channel });
            }
            return;
          }
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
