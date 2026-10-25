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
