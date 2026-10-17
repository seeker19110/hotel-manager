// SPEC-pwa S-007 (phần máy chủ): Clear-Site-Data chỉ có ở đăng xuất thành công.
import { describe, expect, it } from "vitest";
import { CLEAR_SITE_DATA, withClearSiteData } from "./clear-site-data.ts";

const req = (path: string, method = "POST") => new Request(`http://local.test${path}`, { method });

describe("withClearSiteData", () => {
  it('POST /api/auth/sign-out thành công ⇒ có đúng giá trị "cache", "storage"; giữ nguyên status/thân/header khác', async () => {
    const res = withClearSiteData(
      req("/api/auth/sign-out"),
      Response.json({ success: true }, { headers: { "set-cookie": "a=; Max-Age=0", "x-k": "1" } }),
    );
    expect(res.headers.get("clear-site-data")).toBe('"cache", "storage"');
    expect(CLEAR_SITE_DATA).toBe('"cache", "storage"');
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe("a=; Max-Age=0");
    expect(res.headers.get("x-k")).toBe("1");
    expect(await res.json()).toEqual({ success: true });
  });
  it("chịu dấu gạch cuối và tiền tố khác", () => {
    expect(
      withClearSiteData(req("/x/sign-out/"), new Response(null, { status: 204 })).headers.get(
        "clear-site-data",
      ),
    ).toBe(CLEAR_SITE_DATA);
  });
  it("đăng xuất lỗi (4xx/5xx/3xx) hoặc không phải sign-out hoặc GET ⇒ KHÔNG xoá gì", () => {
    for (const status of [302, 401, 403, 429, 500])
      expect(
        withClearSiteData(req("/api/auth/sign-out"), new Response(null, { status })).headers.has(
          "clear-site-data",
        ),
      ).toBe(false);
    expect(
      withClearSiteData(req("/api/auth/sign-in/email"), Response.json({})).headers.has("clear-site-data"),
    ).toBe(false);
    expect(
      withClearSiteData(req("/api/auth/sign-out", "GET"), Response.json({})).headers.has("clear-site-data"),
    ).toBe(false);
    expect(
      withClearSiteData(req("/api/auth/not-sign-out"), Response.json({})).headers.has("clear-site-data"),
    ).toBe(false);
  });
});
