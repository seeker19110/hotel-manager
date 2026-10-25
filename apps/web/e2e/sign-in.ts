// Bấm "Đăng nhập" trên form đã điền, chịu được giới hạn tần suất của Better Auth: `/sign-in/email` 20 lần/phút theo IP và cửa
// sổ chỉ đặt lại sau 60 s không có yêu cầu. Bộ E2E chạy một worker và đăng nhập qua giao diện nhiều lần liên tiếp nên có thể gặp
// 429 — khi đó đợi hết cửa sổ (nới hạn của test tương ứng) rồi bấm lại trên CÙNG form; không tắt rào giới hạn.
import { type Locator, type Page, test } from "@playwright/test";

const WINDOW_WAIT_MS = 61_000;
const MAX_ATTEMPTS = 3;

export async function signInClick(page: Page, button?: Locator): Promise<void> {
  const submit = button ?? page.getByRole("button", { name: "Đăng nhập" });
  for (let attempt = 1; ; attempt++) {
    const res = page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/"));
    await submit.click();
    if ((await res).status() !== 429 || attempt >= MAX_ATTEMPTS) return;
    // Mọi nơi gọi đều trong test/hook (có testInfo): nới hạn đúng bằng thời gian chờ.
    test.info().setTimeout(test.info().timeout + WINDOW_WAIT_MS + 10_000);
    await page.waitForTimeout(WINDOW_WAIT_MS);
  }
}

/** Cửa sổ hạn mức `/two-factor/*` của Better Auth (3 lần/10 giây theo IP) + 1 giây dự phòng. */
const TWO_FACTOR_WINDOW_MS = 11_000;

/**
 * Đăng nhập mật khẩu + mã TOTP tới /chon-to-chuc. Spec chạy liền nhau trên cùng server (cùng IP) có thể chạm hạn mức
 * `/two-factor/*` ⇒ 429: khi đó chờ hết cửa sổ rồi làm lại từ đầu với mã mới (mã cũ chưa được dùng). Không tắt rào.
 */
export async function signInWithTotp(
  page: Page,
  account: { email: string; password: string },
  code: () => string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Mật khẩu").fill(account.password);
    await signInClick(page);
    await page.getByLabel("Mã xác thực 6 số").fill(code());
    const verify = page.waitForResponse((r) => r.url().includes("/api/auth/two-factor/"));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    if ((await verify).status() !== 429 || attempt >= MAX_ATTEMPTS) break;
    test.info().setTimeout(test.info().timeout + TWO_FACTOR_WINDOW_MS + 10_000);
    await page.waitForTimeout(TWO_FACTOR_WINDOW_MS);
  }
  await page.waitForURL(/\/chon-to-chuc$/, { timeout: 10_000 });
}
