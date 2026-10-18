import { expect, type Locator } from "@playwright/test";

/**
 * Chờ React hydrate xong phần tử (React gắn `__reactProps$…` lên nút DOM khi hydrate). Bấm/Enter vào form SSR TRƯỚC lúc đó thì
 * `onSubmit` chưa gắn: trình duyệt gửi form kiểu GET và tải lại trang, hộp xác nhận không bao giờ mở (đỏ ~1/100 lần chạy).
 * Chờ theo điều kiện thật, không tăng timeout.
 */
export async function hydrated(el: Locator): Promise<void> {
  await expect
    .poll(() => el.evaluate((n) => Object.keys(n).some((k) => k.startsWith("__reactProps$"))))
    .toBe(true);
}
