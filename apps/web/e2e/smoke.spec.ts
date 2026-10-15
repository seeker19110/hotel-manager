// E2E xương sống (PLAN T-014): đăng nhập (seed giả) → chọn tổ chức → danh sách phòng của cơ sở được phép + axe.
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import {
  MAIN_PROPERTY,
  MAIN_ROOMS,
  ORG_MAIN,
  ORG_OTHER,
  OTHER_PROPERTY,
  OTHER_ROOMS,
  SMOKE_USER,
} from "./fixtures.ts";

test("smoke: đăng nhập → chọn tổ chức → phòng của cơ sở được giao", async ({ page }) => {
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/dang-nhap$/);
  await expectAccessible(page);

  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chọn tổ chức");
  await expect(page.getByRole("button", { name: ORG_OTHER })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: ORG_MAIN }).click();

  await expect(page).toHaveURL(/\/phong$/);
  await expect(page.getByRole("heading", { level: 2, name: MAIN_PROPERTY })).toBeVisible();
  await expect(page.getByTestId("room").locator(".room-list__code")).toHaveText(MAIN_ROOMS);
  // Cơ sở cùng tổ chức nhưng không được giao: không lộ tên lẫn phòng.
  await expect(page.getByText(OTHER_PROPERTY)).toHaveCount(0);
  for (const code of OTHER_ROOMS) await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

test("sai mật khẩu: báo lỗi role=alert, không vào được", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill("sai-mat-khau-hoan-toan");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.locator(".field__error[role=alert]")).toHaveText("Email hoặc mật khẩu không đúng.");
  await expect(page).toHaveURL(/\/dang-nhap$/);
});

test("cookie tổ chức giả mạo (không có membership) → bị đưa về chọn tổ chức", async ({ page, context }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await context.addCookies([
    { name: "hm_org", value: "00000000-0000-4000-8000-000000000000", url: page.url() },
  ]);
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
});
