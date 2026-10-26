// E2E quyền xoá tài khoản (PLAN T-2311; CMP-RIGHTS-007, CMP-PRIV-005; D-123): tài khoản tạo riêng trong test (không phá seed dùng
// chung) → trang Quyền riêng tư nêu rõ phần sẽ xoá và phần được giữ kèm căn cứ → xác thực lại bằng mật khẩu (sai ⇒ báo lỗi, không
// xoá) → hộp xác nhận nêu hậu quả, nút ghi đúng hành động → job `privacy.dsar` (server E2E chạy mỗi giây) xoá ⇒ phiên bị thu hồi
// (401 SESSION_REVOKED) → đăng nhập lại bằng đúng email/mật khẩu cũ THẤT BẠI. Axe + vùng chạm 44 px (kể cả khi hộp xác nhận mở).
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { signInClick } from "./sign-in.ts";

test.describe.configure({ mode: "serial" });

const USER = {
  name: "Người xoá tài khoản (giả)",
  email: `xoa.tai.khoan.${randomUUID().slice(0, 8)}@example.test`,
  password: ["e2e", "xoa", "tai", "khoan"].join("-"),
};

test("xác thực lại → xác nhận → tài khoản bị xoá, phiên bị thu hồi, đăng nhập lại thất bại", async ({
  page,
}) => {
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill(USER.name);
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Mật khẩu").fill(USER.password);
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  await page.goto("/quyen-rieng-tu");
  const card = page.getByTestId("dsar-delete-card");
  await expect(card.getByRole("heading", { name: "Xoá tài khoản" })).toBeVisible();
  await expect(card).toContainText("Luật Kế toán 88/2015/QH13, Điều 41");
  await expect(card.getByRole("heading", { name: "Được giữ lại và căn cứ" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Sẽ bị xoá" })).toBeVisible();
  await expectAccessible(page);

  const password = card.getByLabel("Nhập lại mật khẩu để xác nhận");
  const submit = card.getByRole("button", { name: "Xoá tài khoản" });
  const dialog = page.getByRole("dialog");

  // Để trống ⇒ lỗi tại chỗ, không mở hộp, không gửi.
  await submit.click();
  await expect(card.getByRole("alert")).toHaveText("Nhập mật khẩu để xác nhận.");
  await expect(dialog).toBeHidden();

  // Sai mật khẩu ⇒ hộp xác nhận → gửi → 401, báo lỗi, tài khoản còn nguyên.
  await password.fill("mat-khau-sai-hoan-toan");
  await submit.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Xoá vĩnh viễn tài khoản?" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đồng ý" })).toHaveCount(0);
  await expectAccessible(page);
  // "Quay lại" không gửi gì.
  await dialog.getByRole("button", { name: "Quay lại" }).click();
  await expect(dialog).toBeHidden();
  expect((await page.request.get("/api/v1/me/data-requests")).status()).toBe(200);
  expect(
    ((await (await page.request.get("/api/v1/me/data-requests")).json()) as { requests: unknown[] }).requests,
  ).toEqual([]);
  await submit.click();
  const wrong = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/me/data-requests") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Xoá vĩnh viễn tài khoản", exact: true }).click();
  expect((await wrong).status()).toBe(401);
  await expect(card.getByRole("alert")).toHaveText("Mật khẩu không đúng. Tài khoản chưa bị xoá.");
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);

  // Đúng mật khẩu ⇒ 202, báo đã nhận.
  await password.fill(USER.password);
  await submit.click();
  const ok = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/me/data-requests") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Xoá vĩnh viễn tài khoản", exact: true }).click();
  // 202 = đã nhận; trang hiện "Đã nhận yêu cầu xoá…" tới khi job xoá xong (có thể chỉ trong một nhịp — không chờ chữ ở đây).
  expect((await ok).status()).toBe(202);

  // Job xoá chạy mỗi giây ở server E2E: phiên bị thu hồi ⇒ 401 SESSION_REVOKED.
  await expect
    .poll(async () => (await page.request.get("/api/v1/me/data-requests")).status(), { timeout: 30_000 })
    .toBe(401);
  const revoked = await page.request.get("/api/v1/me/data-requests");
  expect(((await revoked.json()) as { code: string }).code).toBe("SESSION_REVOKED");
  await page.goto("/quyen-rieng-tu");
  await expect(page).toHaveURL(/\/dang-nhap$/);

  // Đăng nhập lại bằng đúng email/mật khẩu cũ ⇒ thất bại (mật khẩu đã xoá, email đã ẩn danh).
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Mật khẩu").fill(USER.password);
  const login = page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/"));
  await signInClick(page);
  expect((await login).status()).toBe(401);
  await expect(page.getByRole("alert").filter({ hasText: "Email hoặc mật khẩu không đúng." })).toBeVisible();
  await expect(page).toHaveURL(/\/dang-nhap$/);
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
});
