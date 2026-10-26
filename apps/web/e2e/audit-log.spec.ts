// E2E nhật ký hoạt động + truy cập hỗ trợ (PLAN T-2313; IND-SAAS-009, CMP-AUDIT-002; D-128): chủ khách sạn mở /nhat-ky, thấy sự
// kiện (nhãn tiếng Việt), lọc, yêu cầu xuất CSV → cấp truy cập hỗ trợ (email + lý do + 24 giờ) → người hỗ trợ nhận lời mời bằng tài
// khoản RIÊNG (không impersonation), bật xác thực hai lớp (bắt buộc), thấy phòng nhưng mọi lệnh ghi bị 403, biểu ngữ hiện → chủ thấy
// thao tác của hỗ trợ trong nhật ký (lọc "Tài khoản hỗ trợ nền tảng") và biểu ngữ có nút thu hồi → thu hồi một bước → hỗ trợ mất
// quyền ở request kế tiếp. Buồng phòng mở /nhat-ky ⇒ "Không có quyền". Axe + vùng chạm ≥ 44 px.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { HOTEL_HK, HOTEL_OWNER, ORG_HOTEL, portOf, supportTokensFile } from "./fixtures.ts";
import { signInClick, signUpClick, twoFactorClick } from "./sign-in.ts";
import { hotelTotpFile, totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

let PORT = Number.NaN; // NaN đến khi beforeAll gán
test.beforeAll(({ browserName: _ }, info) => {
  PORT = portOf(info.project.use.baseURL);
});

// Spec dùng chung giới hạn `/two-factor/*` (3 lần/10 s theo IP) và mã TOTP của chủ khách sạn với spec chạy liền sau (hotel.spec):
// đợi hết cửa sổ giới hạn + một bước TOTP (30 s) để spec sau không gặp 429/mã vừa dùng (xem sign-in.ts).
test.afterAll(async () => {
  test.setTimeout(60_000);
  await new Promise((r) => setTimeout(r, 31_000));
});

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
let ownerCookies: Cookies = [];
let supportCookies: Cookies = [];
const SUPPORT = {
  name: "Người hỗ trợ (giả)",
  email: `ho.tro.${randomUUID().slice(0, 8)}@example.test`,
  password: ["e2e", "ho", "tro", "gia"].join("-"),
};
const REASON = "Phiếu hỗ trợ #E2E: kiểm tra lịch phòng";
const ORG_RE = new RegExp(ORG_HOTEL.replace(/[()]/g, "\\$&"));

async function asContext(
  browser: Browser,
  baseURL: string,
  cookies: Cookies,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  await ctx.addCookies(cookies);
  return { ctx, page: await ctx.newPage() };
}

/** Đăng nhập mật khẩu + mã TOTP; 429 ở bước hai lớp ⇒ đợi hết cửa sổ rồi thử lại. */
async function signInWithTotp(page: Page, email: string, password: string, secret: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mật khẩu").fill(password);
    await signInClick(page);
    await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
    const verify = page.waitForResponse((r) => r.url().includes("/api/auth/two-factor/"));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    if ((await verify).status() !== 429) break;
    test.info().setTimeout(test.info().timeout + 70_000);
    await page.waitForTimeout(61_000);
  }
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.getByRole("button", { name: ORG_RE }).click();
  await expect(page).not.toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
}

async function supportToken(): Promise<string> {
  const file = supportTokensFile(PORT);
  for (let i = 0; i < 30; i++) {
    if (existsSync(file)) {
      const map = JSON.parse(readFileSync(file, "utf8") || "{}") as Record<string, string>;
      const tok = map[SUPPORT.email];
      if (tok) return tok;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server E2E chưa ghi token lời mời hỗ trợ");
}

test("owner: nhật ký có sự kiện (nhãn tiếng Việt), lọc theo loại hành động, yêu cầu xuất CSV", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { secret } = JSON.parse(readFileSync(hotelTotpFile(PORT), "utf8")) as { secret: string };
  await signInWithTotp(page, HOTEL_OWNER.email, HOTEL_OWNER.password, secret);
  ownerCookies = await page.context().cookies();

  await page.goto("/nhat-ky");
  await expect(page.getByRole("heading", { level: 1, name: "Nhật ký hoạt động" })).toBeVisible();
  const events = page.getByTestId("audit-event");
  await expect(events.first()).toBeVisible();
  // Lần đăng nhập vừa rồi có trong nhật ký với nhãn tiếng Việt + nguồn IP đã cắt.
  await expect(page.getByTestId("audit-events")).toContainText("Đăng nhập");
  await expectAccessible(page);

  await page.getByLabel("Loại hành động").selectOption("auth.login");
  await page.getByRole("button", { name: "Lọc nhật ký" }).click();
  await expect(page).toHaveURL(/action=auth\.login/);
  await expect(events.first()).toBeVisible();
  for (const a of await events.evaluateAll((els) => els.map((e) => e.getAttribute("data-action"))))
    expect(a).toBe("auth.login");

  const exported = page.waitForResponse((r) => r.url().includes("/api/v1/exports/request"));
  await page.getByRole("button", { name: "Xuất CSV" }).click();
  const res = await exported;
  expect(res.status(), res.url()).toBe(202);
  await expect(page.getByText("Đã yêu cầu xuất")).toBeVisible({ timeout: 15_000 });
  const mine = (await (await page.request.get("/api/v1/exports/listMine")).json()) as {
    data: { kind: string }[];
  };
  expect(mine.data.some((e) => e.kind === "audit")).toBe(true);
});

test("buồng phòng mở /nhat-ky ⇒ không có quyền; API nhật ký 403", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(HOTEL_HK.email);
  await page.getByLabel("Mật khẩu").fill(HOTEL_HK.password);
  await signInClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.getByRole("button", { name: ORG_RE }).click();
  await expect(page).not.toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.goto("/nhat-ky");
  await expect(page.getByText("Chỉ chủ và quản lý xem được nhật ký")).toBeVisible();
  expect((await page.request.get("/api/v1/audit/listEvents")).status()).toBe(403);
});

test("owner cấp truy cập hỗ trợ: email + lý do + 24 giờ ⇒ lời mời chờ nhận", async ({ browser, baseURL }) => {
  const { ctx, page } = await asContext(browser, baseURL as string, ownerCookies);
  await page.goto("/nhat-ky");
  const box = page.getByTestId("support-access");
  await expect(box).toContainText("Hiện không có truy cập hỗ trợ nào");
  await box.getByLabel("Email người hỗ trợ").fill(SUPPORT.email);
  await box.getByLabel("Lý do").fill(REASON);
  await expect(box.getByLabel("Thời hạn (giờ)")).toHaveValue("24");
  await box.getByRole("button", { name: "Cấp truy cập hỗ trợ" }).click();
  await expect(box.getByText("Đã gửi lời mời hỗ trợ")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("support-list")).toContainText(`Đã mời ${SUPPORT.email}`, {
    timeout: 15_000,
  });
  await expectAccessible(page);
  await ctx.close();
});

test("hỗ trợ: nhận lời mời bằng tài khoản riêng, bật 2FA, thấy phòng + biểu ngữ, mọi lệnh ghi bị 403", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const token = await supportToken();
  await page.goto(`/loi-moi#token=${token}`);
  await page.getByRole("button", { name: "Tôi chưa có tài khoản" }).click();
  await page.getByLabel("Họ và tên").fill(SUPPORT.name);
  await page.getByLabel("Email").fill(SUPPORT.email);
  await page.getByLabel("Mật khẩu").fill(SUPPORT.password);
  await signUpClick(page, page.getByRole("button", { name: "Tạo tài khoản và tiếp tục" }));
  await page.getByRole("button", { name: "Chấp nhận lời mời" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/, { timeout: 15_000 });

  // Vai hỗ trợ bắt buộc xác thực hai lớp (đọc dữ liệu cá nhân của cả tổ chức).
  await page.goto("/bao-mat");
  await page.getByLabel("Mật khẩu hiện tại").fill(SUPPORT.password);
  await twoFactorClick(page, page.getByRole("button", { name: "Tiếp tục" }));
  const secret = (await page.getByTestId("totp-secret").textContent()) ?? "";
  const fillCode = () => page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await fillCode();
  await twoFactorClick(page, page.getByRole("button", { name: "Xác nhận và bật" }), fillCode);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.context().clearCookies();
  await signInWithTotp(page, SUPPORT.email, SUPPORT.password, secret);
  supportCookies = await page.context().cookies();

  await page.goto("/phong");
  await expect(page.getByTestId("room").first()).toBeVisible();
  const banner = page.getByTestId("support-banner");
  await expect(banner).toContainText("Đang có truy cập hỗ trợ");
  await expect(banner).toContainText(SUPPORT.name);
  // Người hỗ trợ không có nút thu hồi (chỉ owner).
  await expect(banner.getByRole("button", { name: "Thu hồi truy cập hỗ trợ" })).toHaveCount(0);
  await expectAccessible(page);

  // Ghi: mọi lệnh bị 403 trước khi đọc thân; nhật ký/xuất/thành viên không mở được.
  for (const path of ["/api/v1/unit/create", "/api/v1/exports/request", "/api/v1/member/invite"]) {
    const r = await page.request.post(path, {
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        origin: new URL(baseURL as string).origin,
      },
      data: {},
    });
    expect(r.status(), path).toBe(403);
    // 403 của pipeline (không phải chặn khác origin): thông điệp chỉ-đọc của truy cập hỗ trợ.
    expect(((await r.json()) as { title?: string }).title, path).toBe(
      "Truy cập hỗ trợ chỉ được xem, không được thay đổi dữ liệu",
    );
  }
  expect((await page.request.get("/api/v1/audit/listEvents")).status()).toBe(403);
  await page.goto("/nhat-ky");
  await expect(page.getByText("Chỉ chủ và quản lý xem được nhật ký")).toBeVisible();
});

test("owner thấy thao tác của hỗ trợ trong nhật ký rồi thu hồi một bước ⇒ hỗ trợ mất quyền", async ({
  browser,
  baseURL,
}) => {
  const { ctx, page } = await asContext(browser, baseURL as string, ownerCookies);
  await page.goto("/nhat-ky?actor=platform_support");
  const list = page.getByTestId("audit-events");
  await expect(list).toContainText("Hỗ trợ truy cập");
  await expect(list).toContainText("Thao tác bị từ chối");
  await expect(list).toContainText(REASON);
  const banner = page.getByTestId("support-banner");
  await expect(banner).toContainText(SUPPORT.name);
  await expect(banner).toContainText(REASON);
  await expectAccessible(page);
  await banner.getByRole("button", { name: "Thu hồi truy cập hỗ trợ" }).click();
  await expect(page.getByTestId("support-banner")).toBeHidden({ timeout: 15_000 });
  await ctx.close();

  const s = await asContext(browser, baseURL as string, supportCookies);
  expect((await s.page.request.get("/api/v1/today/getSummary")).status()).toBe(404);
  await s.page.goto("/phong");
  await expect(s.page).toHaveURL(/\/chon-to-chuc$/);
  await s.ctx.close();
});
