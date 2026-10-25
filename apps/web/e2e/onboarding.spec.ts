// E2E khởi tạo (T-605; SPEC-access S-001…S-003, S-011, S-023): người dùng mới đăng ký → tạo tổ chức (thành chủ) → bật xác thực hai lớp
// → tạo cơ sở với mặc định đúng → lỗi múi giờ/giờ chốt báo đúng ô → sửa cơ sở. Axe + vùng chạm ≥ 44 px ở mọi màn.
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { CORE_CONSENT } from "./consent.ts";
import { signInClick } from "./sign-in.ts";
import { totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

const NEW_USER = {
  name: "Chủ mới (giả)",
  email: "chu.moi@example.test",
  password: ["e2e", "chu", "moi", "gia"].join("-"),
};
const ORG = "Nhà nghỉ Sao Mai (giả)";
let secret = "";

test("@smoke S-001 đăng ký → tạo tổ chức → thành chủ, chọn sẵn tổ chức → bị yêu cầu bật xác thực hai lớp", async ({
  page,
}) => {
  await page.goto("/dang-nhap");
  await page.getByRole("link", { name: "Tạo tài khoản mới" }).click();
  await expect(page).toHaveURL(/\/dang-ky$/);
  await expectAccessible(page);
  await page.getByLabel("Họ và tên").fill(NEW_USER.name);
  await page.getByLabel("Email").fill(NEW_USER.email);
  await page.getByLabel("Mật khẩu").fill(NEW_USER.password);
  await page.getByLabel(CORE_CONSENT).check(); // ô đồng ý bắt buộc, không tick sẵn (T-2310)
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();

  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await expect(page.getByText("Bạn chưa thuộc tổ chức nào")).toBeVisible();
  await expectAccessible(page);
  // Tên rỗng bị chặn ngay ở ô.
  await page.getByRole("button", { name: "Tạo tổ chức" }).click();
  await expect(page.locator(".field__error[role=alert]")).toContainText("Bắt buộc nhập tên tổ chức");
  await page.getByLabel("Tên tổ chức").fill(ORG);
  await page.getByRole("button", { name: "Tạo tổ chức" }).click();

  await expect(page).toHaveURL(/\/co-so$/, { timeout: 15_000 });
  // Chủ cần MFA (Q-06): chưa bật thì chỉ thấy thông báo + nút bật.
  await expect(page.getByText("Cần bật xác thực hai lớp")).toBeVisible();
  await expectAccessible(page);
});

test("bật xác thực hai lớp: sai mật khẩu báo lỗi; đúng mật khẩu + mã 6 số → bật", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(NEW_USER.email);
  await page.getByLabel("Mật khẩu").fill(NEW_USER.password);
  await signInClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await page.goto("/bao-mat");
  await expectAccessible(page);
  await page.getByLabel("Mật khẩu hiện tại").fill("sai-mat-khau-hoan-toan");
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  await expect(page.locator(".field__error[role=alert]")).toContainText("Mật khẩu không đúng");
  await page.getByLabel("Mật khẩu hiện tại").fill(NEW_USER.password);
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  secret = (await page.getByTestId("totp-secret").textContent()) ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expect(page.getByTestId("backup-codes").getByRole("listitem")).not.toHaveCount(0);
  await expectAccessible(page);
  await page.getByLabel("Mã xác thực 6 số").fill("000000");
  await page.getByRole("button", { name: "Xác nhận và bật" }).click();
  await expect(page.locator(".field__error[role=alert]")).toContainText("Mã xác thực không đúng");
  await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await page.getByRole("button", { name: "Xác nhận và bật" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
});

test("S-001/S-002/S-003/S-023 tạo cơ sở: mặc định đúng, lỗi theo ô, sửa được; tên Unicode giữ nguyên", async ({
  page,
}) => {
  // Đăng nhập qua `signInClick` (chịu 429 của /sign-in); bước xác thực hai lớp cũng bị giới hạn theo IP — gặp 429 thì đợi hết
  // cửa sổ rồi làm lại từ đầu (không tắt rào).
  test.setTimeout(180_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(NEW_USER.email);
    await page.getByLabel("Mật khẩu").fill(NEW_USER.password);
    await signInClick(page);
    await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
    const verify = page.waitForResponse((r) => r.url().includes("/api/auth/two-factor/"));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    if ((await verify).status() !== 429) break;
    await page.waitForTimeout(61_000);
  }
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(ORG.replace(/[()]/g, "\\$&")) }).click();
  await expect(page).toHaveURL(/\/phong$/);
  await page.goto("/co-so");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cơ sở");
  await expect(page.getByText("Chưa có cơ sở nào")).toBeVisible();
  await expectAccessible(page);

  const form = page.getByTestId("property-create-form");
  await form.getByLabel("Tên cơ sở").fill("Cơ sở Đà Nẵng — Biển 🌊");
  await form.getByLabel("Loại hình").selectOption("hotel");
  await form.getByLabel("Múi giờ (tên IANA)").fill("GMT+7");
  await form.getByRole("button", { name: "Tạo cơ sở" }).click();
  await expect(form.getByRole("alert")).toContainText("Múi giờ phải là tên IANA");
  await form.getByLabel("Múi giờ (tên IANA)").fill("");
  await form.getByLabel("Giờ chốt ngày (HH:MM)").fill("25:00");
  await form.getByRole("button", { name: "Tạo cơ sở" }).click();
  await expect(form.getByRole("alert").first()).toBeVisible();
  await form.getByLabel("Giờ chốt ngày (HH:MM)").fill("");
  await form.getByRole("button", { name: "Tạo cơ sở" }).click();
  await expect(form.getByText("Đã tạo cơ sở")).toBeVisible();

  const row = page.getByTestId("property").filter({ hasText: "Cơ sở Đà Nẵng — Biển 🌊" });
  await expect(row).toContainText("múi giờ Asia/Ho_Chi_Minh");
  await expect(row).toContainText("chốt ngày 00:00");
  await expect(row).toContainText("Khách sạn / nhà nghỉ");

  await row.locator("summary").click();
  await row.getByLabel("Giờ chốt ngày (HH:MM)").fill("04:00");
  await row.getByLabel("Giờ nhận phòng (HH:MM)").fill("14:00");
  await row.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(row.getByText("Đã lưu cơ sở")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("property").filter({ hasText: "Cơ sở Đà Nẵng" })).toContainText(
    "chốt ngày 04:00",
  );
  await expect(page.getByTestId("property").filter({ hasText: "Cơ sở Đà Nẵng" })).toContainText(
    "nhận phòng 14:00",
  );
  await expectAccessible(page);
});
