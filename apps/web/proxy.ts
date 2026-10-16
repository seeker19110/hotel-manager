// Next.js 16 proxy (trước là middleware): CSP có nonce + header bảo mật; chặn ghi khác origin (TM-09).
import { isSameOriginWrite, requiresSameOrigin, responseSecurityHeaders } from "@hm/app/http";
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
      { status: 403, headers: { "content-type": "application/problem+json; charset=utf-8" } },
    );
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = responseSecurityHeaders({
    nonce,
    pathname: req.nextUrl.pathname,
    appBaseUrl: base,
    dev: process.env.NODE_ENV !== "production",
  });
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("content-security-policy", headers["content-security-policy"] as string);
  const res = NextResponse.next({ request: { headers: reqHeaders } });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
