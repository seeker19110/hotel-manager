// Bấm nút gửi form xác thực, chịu được giới hạn tần suất của Better Auth (khoá = IP + đường dẫn, dùng chung cho MỌI spec trong
// cùng project vì một worker, một server): `/sign-in/email` 20 lần/60 s; `/sign-up/*` (quy tắc mặc định của Better Auth) và
// `/two-factor/*` (plugin two-factor) 3 lần/10 s. Cửa sổ chỉ đặt lại khi đã qua trọn cửa sổ kể từ lần ĐƯỢC PHÉP gần nhất (lần
// bị chặn không kéo dài) — các spec liền nhau gọi cùng đường dẫn cách nhau < cửa sổ sẽ dồn đếm sang spec sau và gặp 429.
// Khi đó đợi hết cửa sổ (nới hạn của test tương ứng) rồi bấm lại trên CÙNG form; không tắt/nới rào giới hạn của sản phẩm.
import { type Locator, type Page, test } from "@playwright/test";

const MAX_ATTEMPTS = 3;
/** `/sign-in/email`: 60 s. */
const SIGN_IN_WAIT_MS = 61_000;
/** `/sign-up/*`, `/two-factor/*`: 10 s. */
const SHORT_WINDOW_WAIT_MS = 11_000;

/**
 * Bấm `submit`; phản hồi đầu tiên tới `/api/auth<pathPrefix>` là 429 ⇒ đợi `waitMs`, chạy `beforeRetry` (vd điền lại mã TOTP
 * mới) rồi bấm lại, tối đa MAX_ATTEMPTS lần. Không phải 429 ⇒ trả về ngay để test tự kiểm kết quả.
 */
export async function clickThroughRateLimit(
  page: Page,
  submit: Locator,
  pathPrefix: string,
  waitMs: number,
  beforeRetry?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = page.waitForResponse((r) => r.url().includes(`/api/auth${pathPrefix}`));
    await submit.click();
    if ((await res).status() !== 429 || attempt >= MAX_ATTEMPTS) return;
    // Mọi nơi gọi đều trong test/hook (có testInfo): nới hạn đúng bằng thời gian chờ.
    test.info().setTimeout(test.info().timeout + waitMs + 10_000);
    await page.waitForTimeout(waitMs);
    await beforeRetry?.();
  }
}

export function signInClick(page: Page, button?: Locator): Promise<void> {
  return clickThroughRateLimit(
    page,
    button ?? page.getByRole("button", { name: "Đăng nhập" }),
    "/sign-in/",
    SIGN_IN_WAIT_MS,
  );
}

/** Nút gửi form đăng ký (`/dang-ky` "Tạo tài khoản", lời mời "Tạo tài khoản và tiếp tục"). */
export function signUpClick(page: Page, button?: Locator): Promise<void> {
  return clickThroughRateLimit(
    page,
    button ?? page.getByRole("button", { name: "Tạo tài khoản" }),
    "/sign-up/",
    SHORT_WINDOW_WAIT_MS,
  );
}

/** Nút gửi bước hai lớp (`/two-factor/enable`, `/two-factor/verify-totp`); `beforeRetry` điền lại mã khi mã có thể đã đổi. */
export function twoFactorClick(
  page: Page,
  button: Locator,
  beforeRetry?: () => Promise<void>,
): Promise<void> {
  return clickThroughRateLimit(page, button, "/two-factor/", SHORT_WINDOW_WAIT_MS, beforeRetry);
}
