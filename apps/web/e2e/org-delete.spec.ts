// E2E vòng đời xoá tổ chức (PLAN T-2312; IND-SAAS-006, UX-CONTENT-005; D-125): owner tạo tổ chức RIÊNG trong test (không phá seed
// dùng chung) → bật xác thực hai lớp (owner bắt buộc) → trang Tổ chức nêu 30 ngày giữ, phần sẽ xoá/còn lại, xuất dữ liệu → yêu cầu
// xoá (xác thực lại bằng mật khẩu; sai ⇒ báo lỗi, không xoá) → biểu ngữ chờ xoá, trang khác bị khoá về trang Tổ chức → huỷ (một
// bước) → yêu cầu lại → tín hiệu cho server E2E đẩy hạn quá 30 ngày + chạy job `tenancy.purge` → tổ chức biến mất → chứng nhận xoá
// trên trang Quyền riêng tư. Đếm bước: xoá ≤ tạo tổ chức, huỷ ≤ tạo tổ chức (UX-CONTENT-005). Axe + vùng chạm 44 px.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { orgPurgeFile, portOf } from "./fixtures.ts";
import { signInClick, signUpClick, twoFactorClick } from "./sign-in.ts";
import { totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

const USER = {
  name: "Chủ xoá tổ chức (giả)",
  email: `xoa.to.chuc.${randomUUID().slice(0, 8)}@example.test`,
  password: ["e2e", "xoa", "to", "chuc"].join("-"),
};
const ORG = `Nhà nghỉ Sắp Xoá ${randomUUID().slice(0, 4)} (giả)`;

/** Đếm thao tác người dùng (nhập một ô hoặc bấm một nút) trên đường chính của mỗi luồng. */
function counter() {
  let n = 0;
  return {
    fill: async (page: Page, label: string, value: string) => {
      n += 1;
      await page.getByLabel(label).fill(value);
    },
    click: async (page: Page, name: string) => {
      n += 1;
      await page.getByRole("button", { name, exact: true }).click();
    },
    get count() {
      return n;
    },
  };
}

async function deletionStatus(page: Page) {
  const r = await page.request.get("/api/v1/organization/deletion");
  return {
    status: r.status(),
    body: (await r.json().catch(() => ({}))) as { data?: Record<string, unknown> },
  };
}

test("tạo tổ chức → yêu cầu xoá → huỷ → yêu cầu lại → purge → chứng nhận; số bước xoá/huỷ ≤ tạo", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill(USER.name);
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Mật khẩu").fill(USER.password);
  await signUpClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  // Tạo tổ chức: số bước tham chiếu.
  const create = counter();
  await create.fill(page, "Tên tổ chức", ORG);
  await create.click(page, "Tạo tổ chức");
  await expect(page).toHaveURL(/\/co-so$/, { timeout: 15_000 });

  // Owner bắt buộc MFA (Q-06).
  await page.goto("/bao-mat");
  await page.getByLabel("Mật khẩu hiện tại").fill(USER.password);
  await twoFactorClick(page, page.getByRole("button", { name: "Tiếp tục" }));
  const secret = (await page.getByTestId("totp-secret").textContent()) ?? "";
  const fillCode = () => page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await fillCode();
  await twoFactorClick(page, page.getByRole("button", { name: "Xác nhận và bật" }), fillCode);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  // Đăng nhập lại bằng mật khẩu + mã để phiên mang cờ hai lớp.
  await page.context().clearCookies();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(USER.email);
    await page.getByLabel("Mật khẩu").fill(USER.password);
    await signInClick(page);
    await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
    const verify = page.waitForResponse((r) => r.url().includes("/api/auth/two-factor/"));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    if ((await verify).status() !== 429) break;
    await page.waitForTimeout(61_000);
  }
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(ORG.replace(/[()]/g, "\\$&")) }).click();
  await expect(page).not.toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  // Trang Tổ chức: nêu rõ 30 ngày giữ, phần sẽ xoá / còn lại, xuất dữ liệu trước.
  await page.goto("/to-chuc");
  const card = page.getByTestId("org-delete-card");
  await expect(card.getByRole("heading", { name: "Xoá tổ chức" })).toBeVisible();
  await expect(card).toContainText("30 ngày");
  await expect(card.getByRole("heading", { name: "Sẽ bị xoá" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Không bị xoá" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Xuất dữ liệu trước" })).toHaveAttribute(
    "href",
    "#xuat-du-lieu",
  );
  await expect(page.getByRole("heading", { name: "Xuất dữ liệu tổ chức" })).toBeVisible();
  // Không ô tick bật sẵn (không dark pattern).
  await expect(page.locator("input[type=checkbox]:checked")).toHaveCount(0);
  await expectAccessible(page);

  // Nút xuất dữ liệu gọi ĐÚNG đường lệnh (không 308 do tiền tố /api/v1/ bị nhân đôi) và yêu cầu được nhận.
  const exportCall = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("exports/requestOrgExport"),
  );
  await page.getByTestId("org-export-request").getByRole("button", { name: "Tạo bản xuất dữ liệu" }).click();
  const exportRes = await exportCall;
  expect(new URL(exportRes.url()).pathname).toBe("/api/v1/exports/requestOrgExport");
  expect(exportRes.status()).toBe(202);
  await expect(page.getByText("Đã nhận yêu cầu. Bản xuất sẽ hiện ở danh sách dưới khi xong.")).toBeVisible({
    timeout: 15_000,
  });

  // Sai mật khẩu ⇒ báo lỗi, không xoá.
  await card.getByLabel("Nhập lại mật khẩu để xác nhận").fill("mat-khau-sai-hoan-toan");
  await card.getByRole("button", { name: "Yêu cầu xoá tổ chức" }).click();
  await expect(card.getByRole("alert")).toHaveText("Mật khẩu không đúng. Tổ chức chưa bị xoá.");
  expect((await deletionStatus(page)).body.data?.status).toBe("active");

  // Yêu cầu xoá: nhập mật khẩu + bấm.
  const del = counter();
  await del.fill(page, "Nhập lại mật khẩu để xác nhận", USER.password);
  await del.click(page, "Yêu cầu xoá tổ chức");
  const banner = page.getByTestId("org-pending-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("Tổ chức đang chờ xoá");
  expect((await deletionStatus(page)).body.data?.status).toBe("pending_deletion");
  await expectAccessible(page);
  // Trang nghiệp vụ khác bị khoá ⇒ về trang Tổ chức; API nghiệp vụ ⇒ 423.
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/to-chuc$/);
  expect((await page.request.get("/api/v1/today/getSummary")).status()).toBe(423);
  // Xuất dữ liệu vẫn được.
  expect((await page.request.get("/api/v1/exports/listMine")).status()).toBe(200);

  // Huỷ: một bước.
  const cancel = counter();
  await cancel.click(page, "Huỷ yêu cầu xoá");
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("org-delete-card")).toBeVisible();
  expect((await deletionStatus(page)).body.data?.status).toBe("active");

  expect(del.count).toBeLessThanOrEqual(create.count);
  expect(cancel.count).toBeLessThanOrEqual(create.count);
  expect({ create: create.count, delete: del.count, cancel: cancel.count }).toEqual({
    create: 2,
    delete: 2,
    cancel: 1,
  });

  // Yêu cầu lại rồi cho server E2E đẩy hạn + chạy purge.
  await page.getByLabel("Nhập lại mật khẩu để xác nhận").fill(USER.password);
  await page.getByRole("button", { name: "Yêu cầu xoá tổ chức", exact: true }).click();
  await expect(banner).toBeVisible({ timeout: 15_000 });
  const orgId = String((await deletionStatus(page)).body.data?.organization_id ?? "");
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
  writeFileSync(orgPurgeFile(portOf(baseURL)), `${orgId}\n`);
  await expect.poll(async () => (await deletionStatus(page)).status, { timeout: 30_000 }).toBe(404);

  // Tổ chức không còn: chọn lại tổ chức; tài khoản còn nguyên và xem được chứng nhận.
  await page.goto("/to-chuc");
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await page.goto("/quyen-rieng-tu");
  await page.getByRole("link", { name: "Xem chứng nhận xoá" }).click();
  await expect(page).toHaveURL(/\/quyen-rieng-tu\/chung-nhan-xoa$/);
  const cert = page.getByTestId("org-certificate");
  await expect(cert).toHaveCount(1);
  await expect(cert).toContainText(orgId);
  expect(Number(await cert.getByTestId("org-certificate-rows").textContent())).toBeGreaterThan(3);
  await expect(cert.locator("code")).toHaveText(/^[0-9a-f]{64}$/);
  await expectAccessible(page);
});
