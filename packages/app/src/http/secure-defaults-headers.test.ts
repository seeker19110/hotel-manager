// FE-SEC-003 / PRF-WEB-007 — CSP strict + bộ header bảo mật trên mọi response do `apps/web/proxy.ts` tạo (đọc header thật,
// không chỉ đọc hàm dựng chuỗi). E2E (apps/web/e2e/smoke.spec.ts) kiểm lại trên server `next start`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/source-scan.ts";
import {
  buildCsp,
  HSTS_HEADER,
  isSameOriginWrite,
  requiresSameOrigin,
  responseSecurityHeaders,
} from "./security.ts";

const NONCE = "bm9uY2UtdGVzdC0xMjM0NTY3OA==";

/** Header CSP → { directive: [nguồn…] }. */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe("buildCsp — parse header và assert từng directive (FE-SEC-003)", () => {
  const prod = parseCsp(buildCsp(NONCE));

  it("script-src: self + nonce + strict-dynamic; không unsafe-inline/unsafe-eval ở production", () => {
    expect(prod["script-src"]).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(prod["script-src"]).not.toContain("'unsafe-inline'");
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(prod["style-src"]).not.toContain("'unsafe-inline'");
  });

  it("dev được thêm 'unsafe-eval' cho script (HMR) nhưng vẫn không 'unsafe-inline'", () => {
    const dev = parseCsp(buildCsp(NONCE, { dev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("object-src 'none', base-uri 'none', frame-ancestors 'none', form-action 'self', default-src 'self'", () => {
    expect(prod["object-src"]).toEqual(["'none'"]);
    expect(prod["base-uri"]).toEqual(["'none'"]);
    expect(prod["frame-ancestors"]).toEqual(["'none'"]);
    expect(prod["form-action"]).toEqual(["'self'"]);
    expect(prod["default-src"]).toEqual(["'self'"]);
    expect(prod["connect-src"]).toEqual(["'self'"]);
    expect(prod).toHaveProperty("upgrade-insecure-requests");
  });

  it("không directive nào mở nguồn ngoài (http:, https:, *) hay data:/blob: cho script", () => {
    for (const [name, sources] of Object.entries(prod)) {
      expect(sources, name).not.toContain("*");
      expect(sources, name).not.toContain("http:");
      expect(sources, name).not.toContain("https:");
    }
    expect(prod["script-src"]?.some((s) => /^(data|blob):/.test(s))).toBe(false);
  });
});

describe("responseSecurityHeaders — header của mọi response HTML/API do proxy.ts tạo (PRF-WEB-007)", () => {
  const headersOf = (pathname: string, appBaseUrl = "http://localhost:3000") =>
    new Headers(responseSecurityHeaders({ nonce: NONCE, pathname, appBaseUrl, dev: false }));

  it.each(["/", "/dang-nhap", "/api/v1/me"])("%s mang đủ header bắt buộc", (path) => {
    const h = headersOf(path);
    const csp = parseCsp(h.get("content-security-policy") ?? "");
    expect(csp["script-src"]?.some((s) => s.startsWith("'nonce-"))).toBe(true);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("permissions-policy")).toContain("geolocation=()");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("cache-control")).toBe("no-store");
  });

  it("icon/manifest công khai được cache; mọi header bảo mật khác vẫn có", () => {
    const h = headersOf("/icons/icon-192.png");
    expect(h.get("cache-control")).toBeNull();
    expect(h.get("content-security-policy")).toContain("object-src 'none'");
  });

  it("HSTS chỉ khi APP_BASE_URL là https", () => {
    expect(headersOf("/").get("strict-transport-security")).toBeNull();
    expect(headersOf("/", "https://hm.example.vn").get("strict-transport-security")).toBe(HSTS_HEADER);
    expect(HSTS_HEADER).toMatch(/max-age=\d{8,}/);
  });

  it("CORS đóng: không bao giờ phát Access-Control-*; ghi khác origin bị từ chối trước handler", () => {
    for (const p of ["/", "/api/v1/me"])
      expect([...headersOf(p).keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    expect(requiresSameOrigin("/api/v1/payment/record")).toBe(true);
    expect(
      isSameOriginWrite("POST", new Headers({ origin: "https://evil.example" }), "https://hm.example.vn"),
    ).toBe(false);
  });

  it("proxy.ts dùng đúng hàm này (không tự dựng header riêng)", () => {
    const src = readFileSync(`${REPO_ROOT}apps/web/proxy.ts`, "utf8");
    expect(src).toContain("responseSecurityHeaders(");
    expect(src).not.toMatch(/buildCsp|unsafe-inline/);
  });
});
