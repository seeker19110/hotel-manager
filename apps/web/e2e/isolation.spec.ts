// E2E cô lập dữ liệu giữa hai người dùng (PLAN đợt 6 T-506; PRF-WEB-001, QA-E2E-001, kiểm thử đa tổ chức): hai nhân viên ở
// HAI tổ chức khác nhau (buồng phòng Hoa Sen = ORG_MAIN, buồng phòng khách sạn Biển = ORG_HOTEL) — mỗi người chỉ thấy cơ sở/
// phòng/tổ chức của mình ở trang lẫn API; route có đăng nhập không cho cache chia sẻ (`no-store`/`private`); đổi người dùng
// trên cùng trình duyệt không lộ trang của người trước; mượn phiên của mình để gọi vào tổ chức kia → từ chối, không ghi gì.
// Chỉ ĐỌC (và một lệnh bị từ chối) nên không đổi dữ liệu của spec khác. Dữ liệu seed dùng chung ở `fixtures.ts`.
import { expect, type Page, test } from "@playwright/test";
import { HOTEL_HK, MAIN_PROPERTY, ORG_HOTEL, ORG_MAIN, ORG_OTHER, SMOKE_USER } from "./fixtures.ts";
import { type Cookies, loginStaff } from "./sessions.ts";

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "block" });

const HOTEL_PROPERTY = `${ORG_HOTEL} — CS1`;
const CACHEABLE_SHARED = /\bpublic\b|\bs-maxage\b/i;

let main: Cookies = [];
let hotel: Cookies = [];

test.beforeAll(async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL as string;
  main = await loginStaff(browser, baseURL, "main");
  hotel = await loginStaff(browser, baseURL, "hotel");
});

/** Mã tổ chức trang đang hiển thị (thẻ meta do server render). */
const orgOf = (page: Page) => page.locator('meta[name="hm-org-context"]').getAttribute("content");

test("hai người dùng, hai tổ chức: trang /phong chỉ có cơ sở của mình, mã tổ chức khác nhau", async ({
  browser,
}, info) => {
  const baseURL = info.project.use.baseURL as string;
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  try {
    await a.addCookies(main);
    await b.addCookies(hotel);
    const [pa, pb] = [await a.newPage(), await b.newPage()];
    await pa.goto("/phong");
    await pb.goto("/phong");
    await expect(pa.getByRole("heading", { level: 2, name: MAIN_PROPERTY })).toBeVisible();
    await expect(pb.getByRole("heading", { level: 2, name: HOTEL_PROPERTY })).toBeVisible();
    const [orgA, orgB] = [await orgOf(pa), await orgOf(pb)];
    expect(orgA).toMatch(/^[0-9a-f-]{36}$/);
    expect(orgB).toMatch(/^[0-9a-f-]{36}$/);
    expect(orgA).not.toBe(orgB);
    // Không rò tên cơ sở/tổ chức hay mã tổ chức của người kia, ở bất kỳ màn nhân viên nào mà vai trò này vào được.
    for (const path of ["/phong", "/buong-phong", "/su-co", "/thong-bao"]) {
      for (const [page, others, otherOrg] of [
        [pa, [ORG_HOTEL, HOTEL_PROPERTY, HOTEL_HK.email], orgB],
        [pb, [ORG_MAIN, ORG_OTHER, MAIN_PROPERTY, SMOKE_USER.email], orgA],
      ] as const) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(500);
        const html = await page.content();
        for (const text of others) expect(html, `${path} lộ ${text}`).not.toContain(text);
        expect(html, `${path} lộ mã tổ chức khác`).not.toContain(otherOrg as string);
      }
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("route có đăng nhập không cho cache chia sẻ: Cache-Control no-store/private, không public/s-maxage", async ({
  browser,
}, info) => {
  const baseURL = info.project.use.baseURL as string;
  for (const cookies of [main, hotel]) {
    const ctx = await browser.newContext({ baseURL });
    try {
      await ctx.addCookies(cookies);
      for (const path of ["/phong", "/buong-phong", "/su-co", "/thong-bao", "/chon-to-chuc", "/api/v1/me"]) {
        const res = await ctx.request.get(path, { maxRedirects: 0 });
        const cc = res.headers()["cache-control"] ?? "";
        expect(cc, `${path} (${res.status()})`).toMatch(/no-store|private/);
        expect(cc, path).not.toMatch(CACHEABLE_SHARED);
      }
    } finally {
      await ctx.close();
    }
  }
});

test("API /me: mỗi người chỉ liệt kê tổ chức của mình", async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL as string;
  const names = async (cookies: Cookies) => {
    const ctx = await browser.newContext({ baseURL });
    try {
      await ctx.addCookies(cookies);
      const res = await ctx.request.get("/api/v1/me");
      expect(res.status()).toBe(200);
      const j = (await res.json()) as { organizations: { organizationName?: string; name?: string }[] };
      return j.organizations.map((o) => o.organizationName ?? o.name).sort();
    } finally {
      await ctx.close();
    }
  };
  expect(await names(main)).toEqual([ORG_MAIN, ORG_OTHER].sort());
  expect(await names(hotel)).toEqual([ORG_HOTEL]);
});

test("cùng một trình duyệt đổi người dùng: trang của người trước không hiện lại cho người sau (không cache)", async ({
  browser,
}, info) => {
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL as string });
  try {
    const page = await ctx.newPage();
    await ctx.addCookies(hotel);
    await page.goto("/phong");
    await expect(page.getByRole("heading", { level: 2, name: HOTEL_PROPERTY })).toBeVisible();
    await ctx.clearCookies();
    await ctx.addCookies(main);
    await page.goto("/phong");
    await expect(page.getByRole("heading", { level: 2, name: MAIN_PROPERTY })).toBeVisible();
    await expect(page.getByText(HOTEL_PROPERTY)).toHaveCount(0);
    // Quay lại bằng lịch sử cũng không lấy bản của người trước từ bộ nhớ đệm.
    await page.goBack();
    await page.goForward();
    await expect(page.getByText(HOTEL_PROPERTY)).toHaveCount(0);
    await ctx.clearCookies();
    await page.goto("/phong");
    await expect(page).toHaveURL(/\/dang-nhap$/);
    await expect(page.getByText(MAIN_PROPERTY)).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("mượn phiên của mình để gọi vào tổ chức kia (X-Org-Id) → từ chối 404, không có lệnh nào được ghi", async ({
  browser,
}, info) => {
  const baseURL = info.project.use.baseURL as string;
  const orgIdOf = async (cookies: Cookies) => {
    const ctx = await browser.newContext({ baseURL });
    try {
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto("/phong");
      return (await orgOf(page)) as string;
    } finally {
      await ctx.close();
    }
  };
  const [orgA, orgB] = [await orgIdOf(main), await orgIdOf(hotel)];
  for (const [cookies, ownOrg, foreignOrg] of [
    [main, orgA, orgB],
    [hotel, orgB, orgA],
  ] as const) {
    const ctx = await browser.newContext({ baseURL });
    try {
      await ctx.addCookies(cookies);
      const call = (org: string) =>
        ctx.request.post("/api/v1/notifications/markAllRead", {
          headers: {
            origin: new URL(baseURL).origin,
            "x-org-id": org,
            "idempotency-key": crypto.randomUUID(),
          },
          data: {},
        });
      // Thiếu Origin (CSRF) bị chặn trước mọi thứ — chứng tỏ kiểm Origin chạy trước khi xét tổ chức.
      const noOrigin = await ctx.request.post("/api/v1/notifications/markAllRead", {
        headers: { "x-org-id": ownOrg, "idempotency-key": crypto.randomUUID() },
        data: {},
      });
      expect(noOrigin.status(), "thiếu Origin").toBe(403);
      const own = await call(ownOrg);
      expect(own.status(), `tổ chức của mình: ${await own.text()}`).toBe(200);
      const foreign = await call(foreignOrg);
      expect(foreign.status(), "tổ chức của người kia").toBe(404);
      expect(await foreign.text()).not.toContain(foreignOrg === orgA ? ORG_MAIN : ORG_HOTEL);
      // Kể cả không khai X-Org-Id mà đặt cookie tổ chức của người kia → bị đưa về chọn tổ chức, không vào được.
      await ctx.addCookies([{ name: "hm_org", value: foreignOrg, url: baseURL }]);
      const page = await ctx.newPage();
      await page.goto("/phong");
      await expect(page).toHaveURL(/\/chon-to-chuc$/);
    } finally {
      await ctx.close();
    }
  }
});
