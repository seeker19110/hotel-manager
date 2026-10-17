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

/**
 * Đường cần kiểm Origin: mọi `/api/` dùng cookie phiên, TRỪ webhook nhà cung cấp (server-to-server, không gửi Origin,
 * không đọc cookie — xác thực bằng chữ ký HMAC, API-CONTRACT §3).
 */
export function requiresSameOrigin(pathname: string): boolean {
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/v1/webhooks/");
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
    // SW/manifest cùng origin (SPEC-pwa); nêu rõ vì worker-src mặc định rơi về script-src có 'strict-dynamic'.
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    // FE-SEC-003: không dùng <base>, nên cấm hẳn — chặn kẻ chèn thẻ <base> đổi gốc URL tương đối của script/form.
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Đường dẫn được phép cache ở trình duyệt (không chứa dữ liệu người dùng): icon và manifest. Mọi phản hồi khác qua
 * proxy (trang HTML, /api/*) mang `Cache-Control: no-store` (SPEC-pwa S-005). Asset `_next/static` không qua proxy.
 */
export function isCacheablePublicPath(pathname: string): boolean {
  return pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest";
}

/** HSTS (PRF-WEB-007): chỉ đặt khi ứng dụng chạy sau https (APP_BASE_URL https); Caddy đặt cùng giá trị ở deploy/Caddyfile. */
export const HSTS_HEADER = "max-age=31536000; includeSubDomains";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};

/**
 * Toàn bộ header bảo mật của MỘT response đi qua `proxy.ts` (CSP có nonce, nosniff, Referrer-Policy, Permissions-Policy,
 * X-Frame-Options, HSTS khi https, no-store cho trang/API có dữ liệu người dùng). Hàm thuần để test đọc header thật.
 */
export function responseSecurityHeaders(opts: {
  nonce: string;
  pathname: string;
  appBaseUrl: string;
  dev: boolean;
}): Record<string, string> {
  return {
    "content-security-policy": buildCsp(opts.nonce, { dev: opts.dev }),
    ...SECURITY_HEADERS,
    // HSTS chỉ có nghĩa qua https (trình duyệt bỏ qua trên http); đặt khi APP_BASE_URL là https.
    ...(opts.appBaseUrl.startsWith("https://") ? { "strict-transport-security": HSTS_HEADER } : {}),
    // Trang và API có thể chứa dữ liệu người dùng: không lưu ở HTTP cache/bfcache (SPEC-pwa S-005, S-007).
    ...(isCacheablePublicPath(opts.pathname) ? {} : { "cache-control": "no-store" }),
  };
}

export { safeUrl } from "./safe-url.ts";
