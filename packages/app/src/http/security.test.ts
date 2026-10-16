import { describe, expect, it } from "vitest";
import { buildCsp, isCacheablePublicPath, isSameOriginWrite, requiresSameOrigin } from "./security.ts";

const BASE = "https://app.example.vn";
const h = (init: Record<string, string>) => new Headers(init);

describe("isSameOriginWrite (TM-09)", () => {
  it.each([
    ["GET", {}, true],
    ["POST", { origin: BASE }, true],
    ["POST", { origin: "https://evil.example" }, false],
    ["POST", { referer: `${BASE}/rooms` }, true],
    ["POST", { referer: "https://evil.example/x" }, false],
    ["POST", {}, false],
    ["DELETE", { origin: "null" }, false],
  ])("%s %j → %s", (method, headers, ok) => {
    expect(isSameOriginWrite(method, h(headers), BASE)).toBe(ok);
  });
});

describe("buildCsp", () => {
  it("có nonce, không 'unsafe-inline', chặn framing", () => {
    const csp = buildCsp("abcdefghijklmnop1234");
    expect(csp).toContain("'nonce-abcdefghijklmnop1234'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("worker-src 'self'");
  });
  it("nonce ngắn/lạ bị từ chối", () => {
    expect(() => buildCsp("x';")).toThrow();
  });
});

describe("isCacheablePublicPath (SPEC-pwa S-005)", () => {
  it.each([
    ["/icons/icon-192.png", true],
    ["/manifest.webmanifest", true],
    ["/", false],
    ["/offline", false],
    ["/api/v1/me", false],
    ["/icons", false],
    ["/manifest.webmanifest/x", false],
  ])("%s → %s", (path, ok) => {
    expect(isCacheablePublicPath(path)).toBe(ok);
  });
});

describe("requiresSameOrigin: chỉ webhook nhà cung cấp được miễn (xác thực bằng chữ ký, không cookie)", () => {
  it.each([
    ["/api/v1/payment/record", true],
    ["/api/v1/webhooks/sim/123", false],
    ["/api/v1/webhooksx/sim", true],
    ["/api/auth/sign-in", true],
    ["/phong", false],
  ])("%s → %s", (path, need) => {
    expect(requiresSameOrigin(path)).toBe(need);
  });
});
