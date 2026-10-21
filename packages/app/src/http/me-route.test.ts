// AUD-XFEAT-004: /api/v1/me dựng 401 riêng, thiếu mã tra cứu — nay cùng khuôn problem của mọi route.
import { describe, expect, it } from "vitest";
import { handleMe } from "./me-route.ts";

const req = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1/api/v1/me", { headers });

describe("handleMe", () => {
  it("chưa đăng nhập → 401 problem+json có correlation_id = header x-correlation-id, no-store, không gọi danh sách tổ chức", async () => {
    let listed = false;
    const r = await handleMe(req(), {
      getUser: async () => null,
      listOrganizations: async () => {
        listed = true;
        return [];
      },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { code: string; correlation_id: string };
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(body.correlation_id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(r.headers.get("x-correlation-id")).toBe(body.correlation_id);
    expect(listed).toBe(false);
  });

  it("giữ mã tra cứu client gửi lên (hợp lệ); bỏ mã sai dạng", async () => {
    const deps = { getUser: async () => null, listOrganizations: async () => [] };
    const ok = await handleMe(req({ "x-correlation-id": "client-abc-123" }), deps);
    expect(ok.headers.get("x-correlation-id")).toBe("client-abc-123");
    const bad = await handleMe(req({ "x-correlation-id": "<script>" }), deps);
    expect(bad.headers.get("x-correlation-id")).not.toBe("<script>");
  });

  it("đã đăng nhập → 200 chỉ các trường công khai của user + tổ chức, có x-correlation-id", async () => {
    const r = await handleMe(req(), {
      getUser: async () => ({ id: "u1", email: "a@example.test", name: "A", twoFactorEnabled: null }),
      listOrganizations: async (id) => [{ id: `org-of-${id}` }],
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-correlation-id")).toBeTruthy();
    expect(await r.json()).toEqual({
      user: { id: "u1", email: "a@example.test", name: "A", twoFactorEnabled: false },
      organizations: [{ id: "org-of-u1" }],
    });
  });
});
