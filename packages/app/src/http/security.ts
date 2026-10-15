// Bảo vệ HTTP tối thiểu (TM-09, API-CONTRACT §1): kiểm Origin cho request ghi; CSP có nonce.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Request ghi dùng cookie phiên phải đến từ đúng origin của ứng dụng (CSRF). Thiếu Origin → dùng Referer;
 * thiếu cả hai → từ chối (trình duyệt hiện đại luôn gửi Origin cho POST cross-site).
 */
export function isSameOriginWrite(method: string, headers: Headers, appBaseUrl: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const expected = new URL(appBaseUrl).origin;
  const origin = headers.get("origin");
  if (origin) return origin === expected;
  const referer = headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}

/** Content-Security-Policy chặt: script chỉ từ chính mình + nonce theo request; không inline tuỳ tiện. */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error("nonce không hợp lệ");
  const script = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`, ...(opts.dev ? [`'unsafe-eval'`] : [])];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};
