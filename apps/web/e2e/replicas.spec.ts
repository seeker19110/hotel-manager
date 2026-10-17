// E2E hai bản sao web dùng chung CSDL, KHÔNG sticky session (ARC-RES-005, ARC-STYLE-004; PLAN đợt 7 T-607): `e2e/server.ts`
// chạy hai tiến trình `next start` (cổng E2E_PORT và +1) cùng Postgres/bí mật; test đi xen kẽ A/B/A/B cho luồng chính — phiên,
// chọn tổ chức, lệnh ghi có Idempotency-Key, đọc lại, đăng xuất. Mọi kết quả phải như một bản duy nhất: nếu tiến trình giữ
// trạng thái trong bộ nhớ (phiên, idempotency, cache "nguồn sự thật") thì xen kẽ sẽ lệch.
import { expect, type Page, test } from "@playwright/test";
import { ORG_MAIN, SMOKE_USER } from "./fixtures.ts";
import { type Cookies, loginStaff } from "./sessions.ts";

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "block" });

let urlA = "";
let urlB = "";
let cookies: Cookies = [];

const origin = (u: string) => new URL(u).origin;
const DEFAULT_TYPE = "lease_expiring"; // loại không bắt buộc: bật/tắt được

test.beforeAll(async ({ browser }, info) => {
  urlA = info.project.use.baseURL as string;
  const u = new URL(urlA);
  u.port = String(Number(u.port) + 1);
  urlB = u.origin;
  // Bản sao B có thể lên chậm hơn A một nhịp (webServer của Playwright chỉ chờ A).
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${urlB}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Đăng nhập CHỈ ở A: phiên phải dùng được ở B (lưu ở CSDL, không ở bộ nhớ của A).
  cookies = await loginStaff(browser, urlA, "main");
});

async function api(browser: import("@playwright/test").Browser, base: string, jar: Cookies = cookies) {
  const ctx = await browser.newContext({ baseURL: base });
  await ctx.addCookies(jar.map((c) => ({ ...c, domain: "127.0.0.1", path: "/" })));
  return ctx;
}

test("@smoke hai bản sao: phiên đăng nhập ở A dùng được ở B; GET /api/v1/me xen kẽ A/B/A/B cho kết quả y hệt", async ({
  browser,
}) => {
  const bodies: string[] = [];
  for (const base of [urlA, urlB, urlA, urlB, urlB, urlA]) {
    const ctx = await api(browser, base);
    try {
      const res = await ctx.request.get("/api/v1/me");
      expect(res.status(), base).toBe(200);
      bodies.push(await res.text());
    } finally {
      await ctx.close();
    }
  }
  expect(new Set(bodies).size).toBe(1);
  expect(bodies[0]).toContain(ORG_MAIN);
  expect(bodies[0]).toContain(SMOKE_USER.email);
});

test("trang /phong render được ở cả hai bản sao với cùng cookie phiên + tổ chức (không phụ thuộc bộ nhớ tiến trình)", async ({
  browser,
}) => {
  const orgs: (string | null)[] = [];
  for (const base of [urlB, urlA, urlB]) {
    const ctx = await api(browser, base);
    try {
      const page: Page = await ctx.newPage();
      await page.goto("/phong");
      await expect(page).toHaveURL(/\/phong$/);
      orgs.push(await page.locator('meta[name="hm-org-context"]').getAttribute("content"));
    } finally {
      await ctx.close();
    }
  }
  expect(orgs[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Set(orgs).size).toBe(1);
});

test("lệnh ghi: gửi ở A, gửi lại CÙNG Idempotency-Key ở B → cùng kết quả (không ghi hai lần); khác payload ở B → 422; đọc lại ở B thấy giá trị của A", async ({
  browser,
}) => {
  const post = async (base: string, key: string, state: "opted_in" | "opted_out") => {
    const ctx = await api(browser, base);
    try {
      const res = await ctx.request.post("/api/v1/notifications/updatePreferences", {
        headers: { origin: origin(base), "idempotency-key": key },
        data: { type: DEFAULT_TYPE, channel: "email", state },
      });
      // Đọc thân TRƯỚC khi đóng ngữ cảnh (đóng rồi thì phản hồi bị huỷ).
      const text = await res.text();
      return {
        status: () => res.status(),
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      };
    } finally {
      await ctx.close();
    }
  };
  const read = async (base: string) => {
    const ctx = await api(browser, base);
    try {
      const res = await ctx.request.get("/api/v1/notifications/getPreferences");
      expect(res.status(), base).toBe(200);
      const j = (await res.json()) as { data: { type: string; state: string }[] };
      return j.data.find((p) => p.type === DEFAULT_TYPE)?.state;
    } finally {
      await ctx.close();
    }
  };
  try {
    expect(await read(urlB)).toBe("opted_in");
    const key = crypto.randomUUID();
    const first = await post(urlA, key, "opted_out");
    expect(first.status(), await first.text()).toBeLessThan(300);
    const firstBody = (await first.json()) as { command_id: string; status: string };
    expect(firstBody.status).toBe("committed");
    // B thấy ngay kết quả A đã ghi (không cache cục bộ cũ).
    expect(await read(urlB)).toBe("opted_out");
    // Gửi lại ở B cùng key + cùng payload → phát lại kết quả đã lưu ở CSDL.
    const replay = await post(urlB, key, "opted_out");
    expect(replay.status()).toBe(first.status());
    expect(((await replay.json()) as { command_id: string }).command_id).toBe(firstBody.command_id);
    // Cùng key, khác payload ở B → 422 IDEMPOTENCY_CONFLICT (D-034): bảng key chung, không phải Map của tiến trình.
    const conflict = await post(urlB, key, "opted_in");
    expect(conflict.status()).toBe(422);
    expect(await conflict.text()).toContain("IDEMPOTENCY_CONFLICT");
    expect(await read(urlA)).toBe("opted_out");
    // Tra trạng thái lệnh ở bản sao còn lại.
    const ctx = await api(browser, urlB);
    try {
      const status = await ctx.request.get(`/api/v1/commands/${firstBody.command_id}`);
      expect(status.status()).toBe(200);
      expect(await status.text()).toContain("committed");
    } finally {
      await ctx.close();
    }
  } finally {
    // Trả về trạng thái ban đầu cho các spec khác.
    const back = await post(urlB, crypto.randomUUID(), "opted_in");
    expect(back.status()).toBeLessThan(300);
    expect(await read(urlA)).toBe("opted_in");
  }
});

test("session.switchOrganization: chọn ở A, phát lại cùng key ở B → cùng ngữ cảnh; cookie tổ chức do A đặt dùng được ở B", async ({
  browser,
}) => {
  const ctxA = await api(browser, urlA);
  let orgId: string;
  const key = crypto.randomUUID();
  try {
    const me = (await (await ctxA.request.get("/api/v1/me")).json()) as {
      organizations: { organizationId: string; organizationName: string }[];
    };
    orgId = me.organizations.find((o) => o.organizationName === ORG_MAIN)?.organizationId as string;
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
    const res = await ctxA.request.post("/api/v1/session/switchOrganization", {
      headers: { origin: origin(urlA), "idempotency-key": key },
      data: { organization_id: orgId },
    });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await ctxA.close();
  }
  const ctxB = await api(browser, urlB);
  try {
    const same = await ctxB.request.post("/api/v1/session/switchOrganization", {
      headers: { origin: origin(urlB), "idempotency-key": key },
      data: { organization_id: orgId },
    });
    expect(same.status(), await same.text()).toBe(200);
    const other = await ctxB.request.post("/api/v1/session/switchOrganization", {
      headers: { origin: origin(urlB), "idempotency-key": key },
      data: { organization_id: crypto.randomUUID() },
    });
    expect(other.status()).toBe(422);
  } finally {
    await ctxB.close();
  }
});

test("đăng xuất ở A vô hiệu phiên ở B ngay (thu hồi ở CSDL, không phải bộ nhớ của A)", async ({
  browser,
}, info) => {
  // Phiên RIÊNG cho ca này — không làm hỏng cookie dùng chung của các ca trên.
  const own = await loginStaff(browser, urlA, "main");
  void info;
  const ctxB = await api(browser, urlB, own);
  const ctxA = await api(browser, urlA, own);
  try {
    expect((await ctxB.request.get("/api/v1/me")).status()).toBe(200);
    const out = await ctxA.request.post("/api/auth/sign-out", {
      headers: { origin: origin(urlA), "content-type": "application/json" },
      data: {},
    });
    expect(out.status(), await out.text()).toBe(200);
    expect((await ctxB.request.get("/api/v1/me")).status()).toBe(401);
    expect((await ctxA.request.get("/api/v1/me")).status()).toBe(401);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
