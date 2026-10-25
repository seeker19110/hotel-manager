// Đồng ý theo mục đích (T-2310, D-119) trong E2E: nhãn ô lấy từ văn bản đồng ý của catalog packages/app (privacy.consent.*).
import { expect, type Page } from "@playwright/test";

/** Ô đồng ý bắt buộc `service_core` (đăng ký, lời mời, đăng nhập portal lần đầu). */
export const CORE_CONSENT = /Tôi đồng ý để Hotel Manager xử lý họ tên, địa chỉ thư điện tử/;
/** Ô tuỳ chọn `product_analytics`. */
export const ANALYTICS_CONSENT = /Cho phép Hotel Manager ghi nhận cách tôi dùng ứng dụng/;

/**
 * Sau bước OTP của người thuê: lần đầu dùng portal thì hiện bước đồng ý (tick + "Đồng ý và tiếp tục"); đã đồng ý thì đi thẳng tới
 * /chon-to-chuc. Thứ tự spec quyết định lần nào là lần đầu (phiên dùng lại giữa spec) nên chấp nhận cả hai.
 */
export async function passTenantConsentIfAsked(
  page: Page,
  /** Chạy khi bước đồng ý đang hiện, TRƯỚC khi tick/gửi (vd kiểm axe). */
  onAsked?: () => Promise<void>,
): Promise<"asked" | "skipped"> {
  const box = page.getByLabel(CORE_CONSENT);
  await expect
    .poll(async () => (await box.isVisible()) || /\/chon-to-chuc$/.test(page.url()), { timeout: 15_000 })
    .toBe(true);
  if (!(await box.isVisible())) return "skipped";
  await expect(box).not.toBeChecked();
  await onAsked?.();
  await box.check();
  await page.getByRole("button", { name: "Đồng ý và tiếp tục" }).click();
  return "asked";
}

const SIGN_UP = "/api/auth/sign-up/";
/** Cửa sổ hạn mức `/sign-up` theo IP của Better Auth (mặc định 3 lần/10 giây) + 1 giây dự phòng. */
const SIGN_UP_WINDOW_MS = 11_000;

/**
 * Gửi form đăng ký. Nhiều spec đăng ký liền nhau trên cùng server (cùng IP) có thể chạm hạn mức `/sign-up` của Better Auth ⇒ 429:
 * khi đó chờ hết cửa sổ rồi gửi lại (không tắt rào — như đăng nhập TOTP ở onboarding.spec.ts). `submit` là thao tác bấm của lần đầu
 * (spec đếm bước truyền thao tác có đếm); các lần gửi lại bấm thẳng nút, không tính bước.
 */
export async function submitSignUp(
  page: Page,
  submit: () => Promise<unknown> = () =>
    page.getByRole("button", { name: "Tạo tài khoản", exact: true }).click(),
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = page.waitForResponse((r) => r.url().includes(SIGN_UP));
    await (attempt === 0
      ? submit()
      : page.getByRole("button", { name: "Tạo tài khoản", exact: true }).click());
    if ((await res).status() !== 429) return;
    await page.waitForTimeout(SIGN_UP_WINDOW_MS);
  }
  throw new Error("đăng ký: vẫn 429 sau 3 lần chờ hết cửa sổ");
}

/** POST tới API đăng ký/đăng nhập, gặp 429 (hạn mức theo IP) thì chờ hết cửa sổ rồi gửi lại. */
export async function postRespectingRateLimit(
  page: Page,
  url: string,
  options: Parameters<Page["request"]["post"]>[1],
): Promise<Awaited<ReturnType<Page["request"]["post"]>>> {
  for (let attempt = 0; ; attempt++) {
    const res = await page.request.post(url, options);
    if (res.status() !== 429 || attempt === 2) return res;
    await page.waitForTimeout(SIGN_UP_WINDOW_MS);
  }
}
