import { describe, expect, it } from "vitest";
import { buildCsp, isSameOriginWrite } from "./security.ts";

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
  });
  it("nonce ngắn/lạ bị từ chối", () => {
    expect(() => buildCsp("x';")).toThrow();
  });
});
