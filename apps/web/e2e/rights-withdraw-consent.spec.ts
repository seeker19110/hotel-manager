// E2E quyền rút đồng ý (PLAN T-2310; CMP-RIGHTS-001/004, CMP-VN-001; D-122): đăng ký với ô đồng ý analytics KHÔNG tick sẵn → tick
// ⇒ trang Quyền riêng tư báo "đang đồng ý", lịch sử 1 bản ghi → rút ở trang Quyền riêng tư với CÙNG số bước như cho (đổi ô + Lưu)
// ⇒ trạng thái "đã rút", thêm đúng một bản ghi; lưu lại khi không đổi không thêm bản ghi; cho lại cũng 2 bước. Axe + vùng chạm 44 px.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { resetAuthRateLimitFixture } from "./fixtures.ts";
import { signInClick, signUpClick } from "./sign-in.ts";

test.describe.configure({ mode: "serial" });

// D-138: cô lập bucket IP còn lại từ spec trước, một lần trước nhóm serial; limiter thật vẫn bật trong cả ba ca.
test.beforeAll(async ({ baseURL }) => {
  await resetAuthRateLimitFixture(baseURL);
});

// Email riêng mỗi lần chạy: lần thử lại (CI retries) không vướng "email đã có tài khoản".
const USER = {
  name: "Người đồng ý (giả)",
  email: `dong.y.${randomUUID().slice(0, 8)}@example.test`,
  password: ["e2e", "dong", "y", "gia"].join("-"),
};
const CONSENT_LABEL = /Tôi đồng ý cho Hotel Manager đo lường/;

interface ConsentApi {
  purposes: { id: string; granted: boolean | null }[];
  history: { action: string; channel: string; purpose: string }[];
}
async function consentApi(page: Page): Promise<ConsentApi> {
  const res = await page.request.get("/api/v1/me/consents");
  expect(res.status()).toBe(200);
  return (await res.json()) as ConsentApi;
}

test("đăng ký: ô đồng ý analytics không tick sẵn; tự tick ⇒ đang đồng ý, lịch sử 1 bản ghi (kênh đăng ký)", async ({
  page,
}) => {
  await page.goto("/dang-ky");
  const box = page.getByLabel(CONSENT_LABEL);
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expectAccessible(page);
  await page.getByLabel("Họ và tên").fill(USER.name);
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Mật khẩu").fill(USER.password);
  await box.check();
  await signUpClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  await page.goto("/quyen-rieng-tu");
  await expect(page.getByTestId("purpose-status-analytics")).toContainText("đang đồng ý");
  await expect(page.getByTestId("consent-analytics").getByRole("checkbox")).toBeChecked();
  await expect(page.getByTestId("consent-history").getByRole("listitem")).toHaveCount(1);
  // Mục đích không cần đồng ý vẫn được nêu (minh bạch) nhưng không có ô bật/tắt.
  await expect(page.getByTestId("purpose-service")).toContainText("Không cần đồng ý riêng");
  await expect(page.getByTestId("purpose-service").getByRole("checkbox")).toHaveCount(0);
  await expectAccessible(page);
  const api = await consentApi(page);
  expect(api.purposes.find((p) => p.id === "analytics")?.granted).toBe(true);
  expect(api.history.map((h) => [h.action, h.channel])).toEqual([["grant", "signup"]]);
});

test("rút ở trang Quyền riêng tư cùng số bước như cho (bỏ tick + Lưu) ⇒ đã rút, thêm một bản ghi; cho lại cũng 2 bước", async ({
  page,
}) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Mật khẩu").fill(USER.password);
  await signInClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  await page.goto("/quyen-rieng-tu");
  const form = page.getByTestId("consent-analytics");
  const box = form.getByRole("checkbox");
  const save = form.getByRole("button", { name: "Lưu lựa chọn" });
  const status = page.getByTestId("purpose-status-analytics");
  const items = page.getByTestId("consent-history").getByRole("listitem");
  await expect(box).toBeChecked();

  // Rút: đúng 2 thao tác (bỏ tick, Lưu) — bằng số thao tác để cho ở đây.
  await box.uncheck();
  await save.click();
  await expect(form.getByRole("status")).toHaveText("Đã lưu lựa chọn.");
  await expect(status).toContainText("đã rút đồng ý");
  await expect(items).toHaveCount(2);
  let api = await consentApi(page);
  expect(api.purposes.find((p) => p.id === "analytics")?.granted).toBe(false);
  expect(api.history.map((h) => [h.action, h.channel])).toEqual([
    ["grant", "signup"],
    ["withdraw", "settings"],
  ]);

  // Lưu lại khi lựa chọn không đổi ⇒ không thêm bản ghi (idempotent theo trạng thái).
  await save.click();
  await expect(form.getByRole("status")).toHaveText("Lựa chọn không thay đổi.");
  await expect(items).toHaveCount(2);

  // Cho lại: cũng 2 thao tác.
  await box.check();
  await save.click();
  await expect(status).toContainText("đang đồng ý");
  await expect(items).toHaveCount(3);
  api = await consentApi(page);
  expect(api.history.map((h) => h.action)).toEqual(["grant", "withdraw", "grant"]);
  await expectAccessible(page);

  // Tải lịch sử: tệp JSON đính kèm.
  const dl = await page.request.get("/api/v1/me/consents?download=1");
  expect(dl.headers()["content-disposition"]).toMatch(/attachment/);
});

test("chưa đăng nhập: trang Quyền riêng tư chuyển về đăng nhập, API trả 401", async ({ page }) => {
  await page.goto("/quyen-rieng-tu");
  await expect(page).toHaveURL(/\/dang-nhap$/);
  expect((await page.request.get("/api/v1/me/consents")).status()).toBe(401);
});
