// Sự kiện bảo mật chuẩn hoá (SEC-LOG-001/002; docs/security/security-events.md).
// Mọi sự kiện đi qua `emitSecurity` ⇒ cùng một hình dạng: `event`, `actor`, `target`, `outcome`, `source_ip`, `user_agent`
// (+ `reason`, `correlation_id`). Trường không có giá trị ghi `null` (không bỏ khoá) để truy vấn log ổn định.
//
// Quyết định về IP (SEC-LOG-002, quyền riêng tư): KHÔNG ghi IP đầy đủ cũng KHÔNG ghi băm trần của IP — không gian IPv4 chỉ
// 2^32 nên băm không muối đảo ngược được trong vài giây (`guest.ts` băm chỉ để làm khoá giới hạn tần suất, không ghi log).
// `source_ip` là IP đã cắt: IPv4 → /24 (`a.b.c.0`), IPv6 → /48 (`x:y:z::`): đủ để nhận ra mạng/nhà cung cấp và gom đợt tấn
// công, không đủ để định danh một thiết bị. Cần IP đầy đủ khi điều tra → lấy ở nhật ký reverse proxy (hạn giữ ngắn riêng).
import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import type { Logger } from "./logger.ts";
import { appLogger } from "./runtime.ts";

/** Danh mục sự kiện (thêm sự kiện = thêm ở đây + dòng trong docs/security/security-events.md). */
export const SECURITY_EVENTS = [
  "auth.unauthenticated",
  "auth.reauth_required",
  "authz.denied",
  "authz.org_not_found",
  "rate_limit.exceeded",
  "export.downloaded",
  "member.mfa_reset",
  "portal.tenant_access_revoked",
  "guest_link.revoked",
  "guest_link.denied",
  "guest_link.locked",
  // Sự kiện xác thực từ hook Better Auth (T-405; `auth/auth-events.ts`).
  "auth.login",
  "auth.logout",
  "auth.account_locked",
  "auth.password_changed",
  "auth.mfa_enabled",
  "auth.mfa_disabled",
  // Còn thiếu của SEC-LOG-001 (T-501): cấp token, đổi quyền, upload, đổi cấu hình, lỗi validate/deserialize, lỗi TLS backend.
  "guest_link.issued",
  "portal.tenant_access_granted",
  "config.changed",
  "file.uploaded",
  "file.upload_rejected",
  "input.validation_failed",
  "input.deserialize_failed",
  "backend.tls_error",
] as const;
export type SecurityEventName = (typeof SECURITY_EVENTS)[number];
export type SecurityOutcome = "success" | "denied" | "failure";

export interface SecurityClient {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Tham chiếu người thao tác — chỉ định danh nội bộ (UUID/vai trò), không tên/email/SĐT. Trước khi xác định được membership
 * (vd. không phải thành viên tổ chức yêu cầu) chỉ có `authUserId` + `orgId` được yêu cầu ⇒ các trường còn lại có thể thiếu.
 */
export interface ActorRef {
  authUserId?: string | null | undefined;
  orgId?: string | null | undefined;
  membershipId?: string | null | undefined;
  role?: string | null | undefined;
}

export interface SecurityEventInput {
  event: SecurityEventName;
  outcome: SecurityOutcome;
  actor?: ActorRef | null;
  target?: { type: string; id?: string | null } | null;
  /** Mã lý do ngắn (mã lỗi nghiệp vụ…), không văn bản tự do của người dùng. */
  reason?: string;
  client?: SecurityClient | null;
  correlationId?: string | null;
  log?: Logger;
}

/** Hành động thành công từ lệnh: `outcome` mặc định `success`; riêng upload bị quét từ chối ghi `denied` ở lệnh đã commit. */
export type CommandSecurityInput = Pick<SecurityEventInput, "event" | "target" | "reason"> & {
  outcome?: SecurityOutcome;
};

/** Bản ghi sự kiện bảo mật theo schema (kiểm bằng test, SEC-LOG-002). */
export const securityRecordSchema = z.looseObject({
  ts: z.iso.datetime(),
  level: z.literal("warn"),
  severity_number: z.literal(13),
  service: z.string().min(1),
  version: z.string().min(1),
  env: z.string().min(1),
  category: z.literal("security"),
  msg: z.enum(SECURITY_EVENTS),
  event: z.enum(SECURITY_EVENTS),
  actor: z
    .strictObject({
      user_id: z.string().nullable(),
      org_id: z.string().nullable(),
      membership_id: z.string().nullable(),
      role: z.string().nullable(),
    })
    .nullable(),
  target: z.strictObject({ type: z.string().min(1), id: z.string().nullable() }).nullable(),
  outcome: z.enum(["success", "denied", "failure"]),
  source_ip: z.string().nullable(),
  user_agent: z.string().max(200).nullable(),
  reason: z.string().nullable(),
  correlation_id: z.string().nullable(),
});

/** IP cắt cho log: IPv4 → /24, IPv6 → /48; không phải IP hợp lệ (vd. "unknown") → null. */
export function anonymizeIp(ip: string | null | undefined): string | null {
  const v = ip?.trim();
  if (!v) return null;
  if (isIPv4(v)) {
    const [a, b, c] = v.split(".");
    return `${a}.${b}.${c}.0`;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v)?.[1];
  if (mapped && isIPv4(mapped)) return anonymizeIp(mapped);
  if (isIPv6(v.split("%")[0] ?? "")) {
    const addr = v.split("%")[0] as string;
    const [head = "", tail = ""] = addr.split("::");
    const h = head ? head.split(":") : [];
    const t = addr.includes("::") && tail ? tail.split(":") : [];
    const groups = addr.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    const g = groups.slice(0, 3).map((x) => (Number.parseInt(x, 16) || 0).toString(16));
    return `${g.join(":")}::`;
  }
  return null;
}

/**
 * IP khách từ `X-Forwarded-For`: hop PHẢI NHẤT — chính là địa chỉ mà reverse proxy tin cậy đã thấy ở kết nối tới nó và nối vào
 * cuối. Hop đầu do client tự khai (giả được: `X-Forwarded-For: 1.2.3.4` ⇒ `1.2.3.4, <thật>`). Ràng buộc triển khai (RUNBOOK §9):
 * đúng MỘT proxy tin cậy (Caddy, không đặt `trusted_proxies`, không CDN phía trước) đứng trước ứng dụng; có thêm lớp proxy/CDN
 * thì hop phải nhất là địa chỉ của lớp đó và hàm này phải đổi (đếm số hop tin cậy). Đây là chỗ DUY NHẤT đọc header (test chặn).
 */
export function forwardedClientIp(headers: Headers): string | null {
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1) ?? null;
}

/** Trần độ dài User-Agent lưu/ghi log (ký tự Unicode, không phải byte). */
export const USER_AGENT_MAX = 200;

/**
 * User-Agent do client gửi → chuỗi an toàn để ghi log/audit: bỏ ký tự điều khiển (chống chèn dòng log), chuẩn hoá NFC
 * (BASE-DATA-002), cắt ≤ 200 ký tự theo điểm mã (không cắt đôi cặp thay thế). Rỗng → null.
 */
export function sanitizeUserAgent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ua = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: chủ ý loại ký tự điều khiển khỏi chuỗi do client gửi.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .normalize("NFC")
    .trim();
  const cut = Array.from(ua).slice(0, USER_AGENT_MAX).join("").trim();
  return cut || null;
}

/** IP (xem `forwardedClientIp`) + User-Agent đã làm sạch (`sanitizeUserAgent`). */
export function requestClient(headers: Headers): SecurityClient {
  return { ip: forwardedClientIp(headers), userAgent: sanitizeUserAgent(headers.get("user-agent")) };
}

/**
 * Hai cột "từ đâu" của `audit_events` (CMP-AUDIT-002): IP ĐÃ CẮT (/24, /48) + User-Agent đã làm sạch. Không có client
 * (worker/hệ thống, hoặc không xác định được IP hợp lệ) ⇒ `null` từng cột.
 */
export function auditSource(client: SecurityClient | null | undefined): {
  sourceIp: string | null;
  userAgent: string | null;
} {
  return { sourceIp: anonymizeIp(client?.ip), userAgent: sanitizeUserAgent(client?.userAgent) };
}

/** Phát một sự kiện bảo mật theo hình dạng chuẩn. Không bao giờ ném lỗi (log không được làm hỏng luồng nghiệp vụ). */
export function emitSecurity(e: SecurityEventInput): void {
  try {
    (e.log ?? appLogger()).security(e.event, {
      actor: e.actor
        ? {
            user_id: e.actor.authUserId ?? null,
            org_id: e.actor.orgId ?? null,
            membership_id: e.actor.membershipId ?? null,
            role: e.actor.role ?? null,
          }
        : null,
      target: e.target ? { type: e.target.type, id: e.target.id ?? null } : null,
      outcome: e.outcome,
      source_ip: anonymizeIp(e.client?.ip),
      user_agent: sanitizeUserAgent(e.client?.userAgent),
      reason: e.reason ?? null,
      correlation_id: e.correlationId ?? null,
    });
  } catch {
    // Nuốt: lỗi ghi log không đổi kết quả request.
  }
}

/** Mã lỗi/HTTP status của một kết quả từ chối → tên sự kiện (null = không phải sự kiện bảo mật). */
export function securityEventForProblem(p: { status: number; code: string }): SecurityEventName | null {
  if (p.code === "REAUTH_REQUIRED") return "auth.reauth_required";
  if (p.status === 401) return "auth.unauthenticated";
  if (p.status === 403) return "authz.denied";
  if (p.status === 429) return "rate_limit.exceeded";
  // File bị từ chối khi tải lên (quá lớn, loại không cho phép, quét mã độc) — trước 422 vì đây là sự kiện upload riêng.
  if (p.code === "FILE_TOO_LARGE" || p.code === "FILE_TYPE_NOT_ALLOWED") return "file.upload_rejected";
  if (p.status === 422 && p.code === "VALIDATION_FAILED") return "input.validation_failed";
  return null;
}
