// AUD-SEC-006: handler HTTP của Better Auth dùng cửa sổ 10 s của plugin 2FA và 60 s của app; khoá tài khoản giữ 15 phút.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handler } = vi.hoisted(() => ({ handler: vi.fn<(req: Request) => Promise<Response>>() }));
vi.mock("@hm/app", async () => ({
  serverContext: () => ({ auth: { handler } }),
  withClearSiteData: (_req: Request, res: Response) => res,
  withHttpMetrics: (_label: string, handle: (req: Request) => Promise<Response>) => handle,
  withRetryAfter: (await import("../../../../packages/app/src/http/retry-after.ts")).withRetryAfter,
}));

import { POST } from "../../app/api/auth/[...all]/route.ts";

beforeEach(() => handler.mockReset());

describe("auth route — Retry-After", () => {
  it.each([
    ["/two-factor/enable", 10],
    ["/two-factor/verify-totp", 10],
    ["/two-factor/verify-backup-code", 10],
    ["/sign-in/email", 60],
    ["/email-otp/send-verification-otp", 60],
    ["/sign-in/email-otp", 60],
    ["/sign-up/email", 60],
  ])("%s: X-Retry-After bị nối chuỗi ⇒ cửa sổ %i giây", async (path, seconds) => {
    handler.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "x-retry-after": "179296519744877" } }),
    );
    const req = new Request(`https://hotel.example.com/api/auth${path}?next=/chon-to-chuc`, {
      method: "POST",
    });
    const res = await POST(req);
    expect(handler).toHaveBeenCalledWith(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(seconds));
  });

  it("khoá tài khoản có Retry-After 900 ⇒ giữ nguyên, không rút xuống 60 giây", async () => {
    const locked = new Response(JSON.stringify({ code: "ACCOUNT_LOCKED" }), {
      status: 429,
      headers: { "retry-after": "900" },
    });
    handler.mockResolvedValueOnce(locked);
    expect(await POST(new Request("https://hotel.example.com/api/auth/sign-in/email"))).toBe(locked);
  });
});
