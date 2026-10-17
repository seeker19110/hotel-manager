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
