// E2E rào UX (PLAN đợt 4 T-310): màn hẹp 320 px không cuộn ngang (UX-RESP-001), `prefers-reduced-motion` tắt chuyển động
// (UX-VISUAL-001), đăng nhập → chọn tổ chức chỉ bằng bàn phím (UX-A11Y-003), lỗi 5xx chỉ hiện câu chung + mã tra cứu, không
// lộ chi tiết nội bộ (UX-STATE-005), icon là SVG không phải ký tự emoji (UX-VISUAL-006). Tài khoản buồng phòng khách sạn
// (mật khẩu, không TOTP) — không đụng dữ liệu của các spec khác.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { HOTEL_HK, ORG_HOTEL } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
let hkCookies: Cookies = [];

test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL as string });
  const page = await ctx.newPage();
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(HOTEL_HK.email);
  await page.getByLabel("Mật khẩu").fill(HOTEL_HK.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await page.getByRole("button", { name: ORG_HOTEL }).click();
  await expect(page).toHaveURL(/\/phong$/);
  hkCookies = await ctx.cookies();
  await ctx.close();
});

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("320 px: các màn chính không cuộn ngang", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/dang-nhap", "/offline"]) {
    await page.goto(path);
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
  await context.addCookies(hkCookies);
  for (const path of ["/phong", "/buong-phong", "/su-co", "/thong-bao"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
});

test("prefers-reduced-motion: spinner/chuyển động gần như tắt", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dang-nhap");
  const ms = await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "spinner";
    document.body.append(el);
    const s = getComputedStyle(el);
    return Number.parseFloat(s.animationDuration) * (s.animationDuration.endsWith("ms") ? 1 : 1000);
  });
  expect(ms).toBeLessThanOrEqual(1);
});

test("bàn phím: đăng nhập → chọn tổ chức → danh sách phòng không cần chuột", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(HOTEL_HK.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Mật khẩu")).toBeFocused();
  await page.keyboard.type(HOTEL_HK.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  const org = page.getByRole("button", { name: ORG_HOTEL });
  for (let i = 0; i < 20 && !(await org.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(org).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/phong$/);
});

test("lỗi 5xx đường thật: POST 500 → tra lệnh 404 → 'Chưa rõ… Gửi lại' + mã tra cứu, không lộ chi tiết", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const leak = "TypeError: cannot read 'x' at /srv/app/packages/app/src/secret.ts:12";
  await page.route("**/api/v1/maintenance/createWorkOrder", (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "INTERNAL", title: leak, detail: leak, correlation_id: "e2e-corr-real" }),
    }),
  );
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "COMMAND_NOT_FOUND" }),
    }),
  );
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Ổ cắm hỏng");
  await form.getByLabel("Mô tả").fill("Ổ cắm cạnh giường không có điện.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Chưa rõ máy chủ đã nhận" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("Mã tra cứu: e2e-corr-real");
  await expect(page.getByText(leak)).toHaveCount(0);
});

test("lỗi 5xx: chỉ câu chung + mã tra cứu, không lộ chi tiết nội bộ; icon là SVG", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const leak = "TypeError: cannot read 'x' at /srv/app/packages/app/src/secret.ts:12";
  await page.route("**/api/v1/maintenance/createWorkOrder", (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({
        code: "INTERNAL",
        status: 500,
        title: leak,
        detail: leak,
        correlation_id: "e2e-corr-500",
      }),
    }),
  );
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        problem: { code: "INTERNAL", status: 500, detail: leak, correlation_id: "e2e-corr-500" },
      }),
    }),
  );
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Bóng đèn hỏng");
  await form.getByLabel("Mô tả").fill("Bóng đèn hành lang không sáng.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Hệ thống đang gặp lỗi" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("e2e-corr-500");
  await expect(page.getByText(leak)).toHaveCount(0);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const banner = page.getByTestId("network-banner");
  await expect(banner).toBeVisible();
  await expect(banner.locator("svg.icon")).toHaveCount(1);
  expect(await banner.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
  await context.setOffline(false);
});
