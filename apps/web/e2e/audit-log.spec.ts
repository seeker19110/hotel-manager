// E2E màn Nhật ký hoạt động (T-2313; IND-SAAS-009, CMP-AUDIT-002, D-122): chủ khách sạn mở /nhat-ky thấy sự kiện (đăng nhập của chính
// mình), lọc theo loại hành động, gửi yêu cầu xuất CSV; cấp truy cập hỗ trợ (lý do + thời hạn) cho nhân viên hỗ trợ nền tảng rồi thu
// hồi một bước — danh sách hiện đúng trạng thái và nhật ký có sự kiện cấp/thu hồi. Axe + không cuộn ngang ở 320 px.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { HOTEL_OWNER, ORG_HOTEL, portOf, SUPPORT_AGENT } from "./fixtures.ts";
import { signInClick } from "./sign-in.ts";
import { hotelTotpFile, totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

test("chủ: nhật ký thấy sự kiện, lọc, xuất CSV; cấp rồi thu hồi truy cập hỗ trợ", async ({ page }, info) => {
  const port = portOf(info.project.use.baseURL);
  const { secret } = JSON.parse(readFileSync(hotelTotpFile(port), "utf8")) as { secret: string };
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(HOTEL_OWNER.email);
  await page.getByLabel("Mật khẩu").fill(HOTEL_OWNER.password);
  await signInClick(page);
  await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await page.getByRole("button", { name: ORG_HOTEL }).click();
  await expect(page).toHaveURL(/\/phong$/);

  // Vào từ "Thêm".
  await page.getByRole("navigation", { name: "Chức năng" }).getByRole("link", { name: "Thêm" }).click();
  await page.getByRole("main").getByRole("link", { name: "Nhật ký hoạt động" }).click();
  await expect(page).toHaveURL(/\/nhat-ky$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nhật ký hoạt động");
  await expect(page.locator('[data-testid="audit-event"][data-action="auth.login"]').first()).toBeVisible();
  await expectAccessible(page);

  // Lọc theo loại hành động.
  const filter = page.getByTestId("audit-filter");
  await filter.getByLabel("Loại hành động").selectOption("auth.login");
  await filter.getByRole("button", { name: "Lọc" }).click();
  await expect(page).toHaveURL(/action=auth\.login/);
  const events = page.getByTestId("audit-event");
  await expect(events.first()).toBeVisible();
  for (const a of await events.evaluateAll((els) => els.map((e) => e.getAttribute("data-action"))))
    expect(a).toBe("auth.login");

  // Xuất CSV theo bộ lọc (job chạy nền ở worker — ở đây kiểm yêu cầu được nhận và hiện trong danh sách bản xuất).
  await page.getByTestId("audit-export").getByRole("button", { name: "Xuất CSV" }).click();
  await expect(
    page.getByTestId("audit-export").getByText("Đã gửi yêu cầu xuất", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("audit-exports")).toContainText("Đang chờ xử lý");

  // Cấp truy cập hỗ trợ.
  await page.goto("/nhat-ky");
  const form = page.getByTestId("support-grant-form");
  await form.getByLabel("Email nhân viên hỗ trợ").fill(SUPPORT_AGENT.email);
  await form.getByLabel("Thời hạn (giờ, tối đa 72)").fill("4");
  await form.getByLabel("Lý do").fill("Ticket #E2E: kiểm tra lịch phòng");
  await form.getByRole("button", { name: "Cấp truy cập hỗ trợ" }).click();
  await expect(form.getByText("Đã cấp truy cập hỗ trợ", { exact: false })).toBeVisible();
  const grant = page.getByTestId("support-grant").filter({ hasText: "Ticket #E2E: kiểm tra lịch phòng" });
  await expect(grant).toHaveAttribute("data-status", "active");
  await expect(grant).toContainText("Đang hiệu lực");
  await expect(grant).toContainText(SUPPORT_AGENT.name);

  // Quá 72 giờ bị chặn ngay ở form (cùng schema server).
  await form.getByLabel("Email nhân viên hỗ trợ").fill(SUPPORT_AGENT.email);
  await form.getByLabel("Thời hạn (giờ, tối đa 72)").fill("73");
  await form.getByLabel("Lý do").fill("Quá hạn");
  await form.getByRole("button", { name: "Cấp truy cập hỗ trợ" }).click();
  await expect(form.getByRole("alert").first()).toBeVisible();

  // Thu hồi một bước.
  await grant.getByRole("button", { name: /Thu hồi truy cập của/ }).click();
  await expect(grant.getByText("Đã thu hồi truy cập hỗ trợ", { exact: false })).toBeVisible();
  await page.reload();
  const revoked = page.getByTestId("support-grant").filter({ hasText: "Ticket #E2E: kiểm tra lịch phòng" });
  await expect(revoked).toHaveAttribute("data-status", "revoked");
  await expect(revoked).toContainText("Đã thu hồi");

  // Nhật ký có sự kiện cấp + thu hồi.
  await expect(page.locator('[data-testid="audit-event"][data-action="support.access_granted"]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-testid="audit-event"][data-action="support.access_revoked"]')).toHaveCount(
    1,
  );
  await expectAccessible(page);

  await page.setViewportSize({ width: 320, height: 800 });
  const spill = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(spill, "/nhat-ky cuộn ngang ở 320 px").toBeLessThanOrEqual(0);
});
