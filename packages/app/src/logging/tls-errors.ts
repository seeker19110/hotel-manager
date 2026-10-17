// Lỗi TLS/chứng chỉ khi nối backend (CSDL, object storage, SMTP, clamd…) — SEC-LOG-001 "lỗi TLS/chứng chỉ backend".
// Nhận diện theo `code` của Node/OpenSSL (đi theo chuỗi `cause`/`errors` — pg ném thẳng, `fetch` bọc trong `cause`), không theo thông
// điệp (thông điệp đổi theo phiên bản và có thể chứa tên máy). Ghi MỘT sự kiện bảo mật `backend.tls_error` với mã lỗi cố định.
import type { Logger } from "./logger.ts";
import { emitSecurity } from "./security-events.ts";

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
]);
const MAX_DEPTH = 5;

/** Mã lỗi TLS đầu tiên trong chuỗi lỗi (≤ 5 tầng), hoặc `null` nếu không phải lỗi TLS/chứng chỉ. */
export function tlsFailureCode(err: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH || typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && (TLS_CODES.has(e.code) || /^ERR_(TLS|SSL)_/.test(e.code))) return e.code;
  const next = [e.cause, ...(Array.isArray(e.errors) ? e.errors : [])];
  for (const n of next) {
    const c = tlsFailureCode(n, depth + 1);
    if (c) return c;
  }
  return null;
}

/**
 * Lỗi là TLS/chứng chỉ ⇒ phát `backend.tls_error` (outcome failure, reason = mã) và trả `true`; không thì `false`, không ghi gì.
 * `backend`: tên nơi đang nối (`postgres`, `s3`, `smtp`…) — hằng do mã gọi chọn, không lấy từ đầu vào.
 */
export function reportBackendTlsError(
  err: unknown,
  opts: { backend: string; log?: Logger; correlationId?: string | null },
): boolean {
  const code = tlsFailureCode(err);
  if (!code) return false;
  emitSecurity({
    event: "backend.tls_error",
    outcome: "failure",
    target: { type: "backend", id: opts.backend },
    reason: code,
    correlationId: opts.correlationId ?? null,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return true;
}
