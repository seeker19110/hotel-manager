// SPEC-pwa S-007, S-014: điều hướng 5 điểm vào theo vai trò (390×844), cơ sở luôn ở header; đăng xuất xoá dữ liệu trên máy +
// Clear-Site-Data + Back không lộ lại trang có dữ liệu. Thêm: cài ứng dụng (nút khi có `beforeinstallprompt`, hướng dẫn trên Safari iOS)
// — phần tự động của trang "Thêm"; bước cài thật trên thiết bị nằm ở danh mục kiểm tay.
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { ORG_HOTEL } from "./fixtures.ts";
import { type Cookies, loginOwner, loginStaff } from "./sessions.ts";

test.describe.configure({ mode: "serial" });

let ownerCookies: Cookies = [];
let hkCookies: Cookies = [];

test.beforeAll(async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL as string;
  ownerCookies = await loginOwner(browser, baseURL, "hotel");
  hkCookies = await loginStaff(browser, baseURL, "hotel");
});

const MOBILE = { width: 390, height: 844 };
const navLabels = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "Chức năng" }).getByRole("link").allTextContents();

test("S-014 điều hướng dưới: đúng 5 mục theo thứ tự; cơ sở đang thao tác ở header; Thêm dẫn tới màn còn lại; axe", async ({
  page,
  context,
}) => {
  await page.setViewportSize(MOBILE);
  await context.addCookies(ownerCookies);
  await page.goto("/");
  expect(await navLabels(page)).toEqual(["Hôm nay", "Phòng/Lịch", "Thu tiền", "Công việc", "Thêm"]);
  await expect(page.getByTestId("scope-bar")).toContainText(`${ORG_HOTEL} — CS1`);
  await expect(page.getByTestId("bell")).toBeVisible();
  const nav = page.getByTestId("app-nav");
  await expect(nav.getByRole("link", { name: "Hôm nay" })).toHaveAttribute("aria-current", "page");
  // Thanh dưới nằm sát đáy khung nhìn.
  const box = await nav.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(MOBILE.height - 1);

  await nav.getByRole("link", { name: "Thêm" }).click();
  await expect(page).toHaveURL(/\/them$/);
  await expect(page.getByRole("heading", { level: 1, name: "Thêm" })).toBeVisible();
  const more = page.getByTestId("more-links");
  for (const name of ["Đặt phòng", "Sự cố", "Thông báo", "Thông báo lưu trú"])
    await expect(more.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Thêm" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);

  await nav.getByRole("link", { name: "Công việc" }).click();
  await expect(page).toHaveURL(/\/buong-phong$/);
  await expect(nav.getByRole("link", { name: "Công việc" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);
});

test("S-014 buồng phòng không thấy Thu tiền (menu theo vai trò); tiền/đặt phòng không có cả trong Thêm", async ({
  page,
  context,
}) => {
  await page.setViewportSize(MOBILE);
  await context.addCookies(hkCookies);
  await page.goto("/");
  expect(await navLabels(page)).toEqual(["Hôm nay", "Phòng/Lịch", "Công việc", "Thêm"]);
  await expect(page.getByTestId("scope-bar")).toContainText(ORG_HOTEL);
  await page.goto("/them");
  const more = page.getByTestId("more-links");
  await expect(more.getByRole("link", { name: "Sự cố", exact: true })).toBeVisible();
  await expect(more.getByRole("link", { name: "Đặt phòng" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Thu tiền" })).toHaveCount(0);
});

test("S-007 đăng xuất: Clear-Site-Data, xoá cache/IndexedDB hm-*/storage trên máy, Back không hiện lại trang có dữ liệu", async ({
  page,
  context,
  browser,
}, info) => {
  // Phiên RIÊNG cho ca này: đăng xuất thu hồi phiên ở máy chủ, không được làm hỏng phiên dùng chung của các ca khác.
  await context.addCookies(await loginStaff(browser, info.project.use.baseURL as string, "hotel"));
  await page.goto("/phong");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/them");
  // Dữ liệu người dùng "trên máy": cache runtime, IndexedDB hm-*, sessionStorage/localStorage.
  await page.evaluate(async () => {
    await (await caches.open("runtime-du-lieu-nguoi-dung")).put("/api/du-lieu", new Response("x"));
    await new Promise<void>((ok, fail) => {
      const r = indexedDB.open("hm-drafts", 1);
      r.onsuccess = () => ok();
      r.onerror = () => fail(r.error);
    });
    sessionStorage.setItem("hm-form", "nhap-do");
    localStorage.setItem("hm-pref", "1");
  });

  const signOut = page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-out"));
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  const res = await signOut;
  expect(res.status()).toBe(200);
  expect((await res.allHeaders())["clear-site-data"]).toBe('"cache", "storage"');
  await expect(page).toHaveURL(/\/dang-nhap$/);

  const left = await page.evaluate(async () => ({
    caches: (await caches.keys()).filter((k) => !k.startsWith("serwist-precache")),
    idb: ((await indexedDB.databases?.()) ?? []).map((d) => d.name).filter((n) => n?.startsWith("hm-")),
    session: sessionStorage.length,
    local: localStorage.length,
  }));
  expect(left).toEqual({ caches: [], idb: [], session: 0, local: 0 });

  // Phiên đã thu hồi ở máy chủ; Back không đưa lại trang có dữ liệu (trang no-store + không còn phiên ⇒ về đăng nhập).
  expect((await context.request.get("/api/v1/me")).status()).toBe(401);
  await page.goBack();
  await expect(page).toHaveURL(/\/dang-nhap$/);
  await expect(page.getByRole("heading", { level: 1, name: "Phòng" })).toHaveCount(0);
});

test("đăng xuất khi mất mạng: không gọi máy chủ, báo OFFLINE, vẫn đăng nhập", async ({ page, context }) => {
  await context.addCookies(hkCookies);
  await page.goto("/them");
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/auth/sign-out")) posts++;
  });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Không có kết nối mạng. Thao tác chưa được gửi." }),
  ).toBeVisible();
  expect(posts).toBe(0);
  await context.setOffline(false);
});

test("cài ứng dụng (PWA-INSTALL, phần tự động): có beforeinstallprompt ⇒ nút Cài ứng dụng mở hộp cài; chưa có sự kiện ⇒ không có nút", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  await page.goto("/them");
  const box = page.getByTestId("install-app");
  await expect(box).toHaveAttribute("data-state", "unsupported");
  await expect(box.getByRole("button", { name: "Cài ứng dụng" })).toHaveCount(0);

  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    e.prompt = () => {
      (window as unknown as { __prompted: number }).__prompted =
        ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1;
      return Promise.resolve();
    };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  const button = box.getByRole("button", { name: "Cài ứng dụng" });
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted))
    .toBe(1);
  await expect(button).toHaveCount(0); // sự kiện chỉ dùng được một lần
  await expectAccessible(page);
});

test("cài ứng dụng (PWA-INSTALL, phần tự động): Safari iOS không có sự kiện ⇒ hướng dẫn Chia sẻ → Thêm vào MH chính, không có nút cài giả", async ({
  browser,
}, info) => {
  const ctx = await browser.newContext({
    baseURL: info.project.use.baseURL as string,
    viewport: MOBILE,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  });
  await ctx.addCookies(hkCookies);
  const page = await ctx.newPage();
  await page.goto("/them");
  const box = page.getByTestId("install-app");
  await expect(box).toHaveAttribute("data-state", "ios");
  const guide = page.getByTestId("ios-install-guide");
  await expect(guide).toContainText("Chia sẻ");
  await expect(guide).toContainText("Thêm vào MH chính");
  await expect(guide.locator("svg.icon")).toHaveCount(2); // hình minh hoạ nút Chia sẻ và Thêm vào MH chính
  await expect(box.getByRole("button", { name: "Cài ứng dụng" })).toHaveCount(0);
  await expectAccessible(page);
  await ctx.close();
});
