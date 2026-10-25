// E2E quyền xoá (T-2311, D-120; STD-PRIV-004 `rights-delete`, CMP-RIGHTS-007): đăng ký → trang Bảo mật → khối "Xoá tài khoản" nêu rõ
// cái bị xoá và cái được giữ → gõ sai email bị chặn → gõ đúng + MỘT nút → đã nhận yêu cầu; phiên bị thu hồi; đăng nhập lại bằng mật
// khẩu cũ thất bại. Không hộp xác nhận thêm, không đếm ngược (UX-CONTENT-005).
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { CORE_CONSENT, submitSignUp } from "./consent.ts";
import { signInClick } from "./sign-in.ts";

const PASSWORD = ["e2e", "xoa", "tai", "khoan", "gia"].join("-");
const email = () => `xoa.tai.khoan.${Date.now().toString(36)}@example.test`;

test("đăng ký → /bao-mat → xoá tài khoản (gõ lại email) ⇒ đăng xuất mọi nơi, không đăng nhập lại được", async ({
  page,
  baseURL,
}) => {
  const mail = email();
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill("Người xoá tài khoản (giả)");
  await page.getByLabel("Email").fill(mail);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await page.getByLabel(CORE_CONSENT).check();
  await submitSignUp(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  await page.goto("/bao-mat");
  const block = page.getByTestId("account-rights");
  await expect(block.getByRole("heading", { name: "Xoá tài khoản" })).toBeVisible();
  // Nói rõ hậu quả và phần được giữ kèm lý do.
  await expect(block).toContainText("Bạn không đăng nhập lại được bằng tài khoản này.");
  await expect(block).toContainText("bản ghi đồng ý");
  await expect(block).toContainText("nghĩa vụ kế toán");
  await expectAccessible(page);

  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const confirm = block.getByLabel("Gõ lại email của bạn để xác nhận");
  await confirm.fill("nguoi.khac@example.test");
  await block.getByRole("button", { name: "Xoá tài khoản" }).click();
  await expect(block.getByRole("alert").filter({ hasText: "Email không khớp" })).toBeVisible();
  // Chưa có gì bị xoá: phiên vẫn còn.
  expect((await page.request.get("/api/v1/privacy/dsar")).status()).toBe(200);

  // Dữ liệu người dùng trên máy (storage + Cache Storage ngoài precache) phải bị xoá sau khi xoá tài khoản.
  await page.evaluate(async () => {
    localStorage.setItem("hm-e2e-probe", "1");
    sessionStorage.setItem("hm-e2e-probe", "1");
    await (await caches.open("hm-e2e-probe")).put("/hm-e2e-probe", new Response("x"));
  });
  await confirm.fill(mail);
  await block.getByRole("button", { name: "Xoá tài khoản" }).click();
  await expect(page.getByTestId("account-deleted")).toContainText("Đã nhận yêu cầu xoá tài khoản");
  await expect
    .poll(() =>
      page.evaluate(async () => ({
        local: localStorage.getItem("hm-e2e-probe"),
        session: sessionStorage.getItem("hm-e2e-probe"),
        cache: (await caches.keys()).includes("hm-e2e-probe"),
      })),
    )
    .toEqual({ local: null, session: null, cache: false });
  expect(dialogs).toBe(0);

  // Phiên đã bị thu hồi ở server.
  const after = await page.request.get("/api/v1/privacy/dsar");
  expect(after.status()).toBe(401);

  // Đăng nhập lại bằng thông tin cũ: API từ chối, giao diện không vào được.
  const origin = new URL(baseURL as string).origin;
  const api = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: { email: mail, password: PASSWORD },
  });
  expect(api.status()).toBe(401);
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(mail);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await signInClick(page);
  await expect(page.getByRole("alert").filter({ hasText: "Email hoặc mật khẩu không đúng." })).toBeVisible();
  await expect(page).toHaveURL(/\/dang-nhap/);
});
