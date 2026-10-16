import { expect, type Page } from "@playwright/test";

/** Bấm "Đồng ý" trong hộp xác nhận thao tác không hoàn tác (T-310) và chờ hộp đóng. */
export async function confirmAction(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Đồng ý" }).click();
  await expect(dialog).toBeHidden();
}
