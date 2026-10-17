import { expect, type Page } from "@playwright/test";

/**
 * Bấm nút xác nhận trong hộp xác nhận thao tác không hoàn tác và chờ hộp đóng. Nút phải nêu ĐÚNG hành động + đối tượng
 * (UX-STATE-008) nên `label` bắt buộc: chuỗi = khớp nguyên tên, RegExp = khớp mẫu. Không chấp nhận nhãn chung "Đồng ý".
 */
export async function confirmAction(page: Page, label: string | RegExp): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đồng ý" })).toHaveCount(0);
  await dialog.getByRole("button", { name: label, exact: typeof label === "string" }).click();
  await expect(dialog).toBeHidden();
}
