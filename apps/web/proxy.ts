// Next.js 16 proxy (trước là middleware): CSP có nonce + header bảo mật; chặn ghi khác origin (TM-09).
import {
  buildCsp,
  isCacheablePublicPath,
  isSameOriginWrite,
  requiresSameOrigin,
  SECURITY_HEADERS,
} from "@hm/app/http";
import { type NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest): NextResponse {
  const base = process.env.APP_BASE_URL ?? req.nextUrl.origin;
  if (requiresSameOrigin(req.nextUrl.pathname) && !isSameOriginWrite(req.method, req.headers, base)) {
    return NextResponse.json(
      {
        type: "https://hotel-manager.invalid/errors/FORBIDDEN",
        title: "Nguồn yêu cầu không hợp lệ",
        status: 403,
        code: "FORBIDDEN",
      },
      { status: 403, headers: { "content-type": "application/problem+json" } },
    );
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production" });
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.headers.set("content-security-policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  // Trang và API có thể chứa dữ liệu người dùng: không lưu ở HTTP cache/bfcache (SPEC-pwa S-005, S-007).
  if (!isCacheablePublicPath(req.nextUrl.pathname)) res.headers.set("cache-control", "no-store");
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
