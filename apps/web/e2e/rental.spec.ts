// E2E vòng tháng nhà trọ (PLAN đợt 2 T-117) với dữ liệu giả: chủ trọ đăng nhập có TOTP → ký hợp đồng → bàn giao + chỉ số đầu
// → kích hoạt → tạo kỳ → chốt chỉ số theo tầng → xem trước 3.580.000 đ → gửi duyệt → phát hành → mở ca → thu tiền mặt →
// nhận/xác nhận cọc → hàng chờ đối soát; axe + vùng chạm mỗi màn. Thêm SPEC-pwa S-006 (mất mạng), S-010/S-011 (hết thời gian
// chờ, tra `GET /api/v1/commands/{id}`, gửi lại cùng key).
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { ORG_RENTAL, RENTAL_OWNER, RENTAL_TENANT, RENTAL_UNIT } from "./fixtures.ts";
import { totp, totpFile } from "./totp.ts";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 3100);

async function login(page: Page) {
  const { secret } = JSON.parse(readFileSync(totpFile(PORT), "utf8")) as { secret: string };
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(RENTAL_OWNER.email);
  await page.getByLabel("Mật khẩu").fill(RENTAL_OWNER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await page.getByRole("button", { name: ORG_RENTAL }).click();
  await expect(page).toHaveURL(/\/phong$/);
}

// Đăng nhập TOTP MỘT lần rồi dùng lại cookie phiên: Better Auth giới hạn tần suất `/two-factor/*` (vài lần mỗi 10 giây/IP) —
// đăng nhập lại ở mỗi test trên CI nhanh sẽ bị 429.
let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL as string });
  await login(await ctx.newPage());
  sessionCookies = await ctx.cookies();
  await ctx.close();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(sessionCookies);
});

const status = (page: Page) => page.getByRole("status").filter({ hasNotText: "Đang" });

test("vòng tháng: ký → bàn giao → kỳ thu 3.580.000 đ → phát hành → thu tiền mặt → cọc", async ({ page }) => {
  // Hợp đồng
  await page.goto("/hop-dong");
  await expectAccessible(page);
  const card = page.getByTestId("lease").filter({ hasText: `Phòng ${RENTAL_UNIT} — ${RENTAL_TENANT}` });
  await expect(card).toContainText("Chờ ký");
  await card.getByRole("link").click();
  await expect(page.getByTestId("lease-status")).toHaveText("Chờ ký");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Ký hợp đồng" }).click();
  await expect(page.getByTestId("lease-status")).toHaveText("Đã ký — chờ bàn giao");
  await page.getByLabel("Chỉ số điện").fill("1250");
  await page.getByLabel("Chỉ số nước").fill("30");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Xác nhận bàn giao" }).click();
  await page.getByRole("button", { name: "Kích hoạt" }).click();
  await expect(page.getByTestId("lease-status")).toHaveText("Đang thuê");
  const leaseUrl = page.url();

  // Kỳ thu + chỉ số theo tầng
  await page.goto("/ky-thu");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Tạo kỳ" }).click();
  await expect(status(page)).toHaveText("Đã có kỳ thu cho tháng này.");
  await page.getByTestId("period").first().getByRole("link").click();
  await expect(page.getByTestId("period-status")).toHaveText("Nháp");
  await page.getByRole("link", { name: "Nhập chỉ số theo tầng" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Tầng 1" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel(`Điện phòng ${RENTAL_UNIT}`).fill("1350");
  await page.getByRole("button", { name: "Lưu điện" }).click();
  await expect(page.getByText("Lần trước: 1250 · đã nhập 1350")).toBeVisible();
  await page.getByLabel(`Nước phòng ${RENTAL_UNIT}`).fill("42");
  await page.getByRole("button", { name: "Lưu nước" }).click();
  await expect(page.getByText("Lần trước: 30 · đã nhập 42")).toBeVisible();
  await page.getByRole("link", { name: "Quay lại kỳ thu" }).click();

  const room = page.getByTestId("preview-room");
  await expect(room.locator("caption")).toContainText("3.580.000 đ");
  await expect(room.locator("tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("period-total")).toHaveText("3.580.000 đ");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Gửi duyệt" }).click();
  await expect(page.getByTestId("period-status")).toHaveText("Chờ phát hành");
  await page.getByRole("button", { name: "Phát hành kỳ" }).click();
  await expect(page.getByTestId("period-status")).toHaveText("Đã phát hành");

  // Thu tiền mặt
  await page.goto("/thu-tien");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Mở ca" }).click();
  const inv = page.getByTestId("open-invoice");
  await expect(inv.getByTestId("open-amount")).toHaveText("3.580.000 đ");
  // S-010 với lệnh KHÔNG tự chống trùng: server ghi xong nhưng mất phản hồi → tra kết quả, không thu lần hai.
  let collects = 0;
  await page.route("**/api/v1/payment/collectCash", async (route) => {
    collects++;
    await route.fetch();
    await route.abort("failed");
  });
  await inv.getByRole("button", { name: "Thu tiền mặt" }).click();
  await expect(page.getByText("Không còn phiếu nào phải thu")).toBeVisible();
  expect(collects).toBe(1);
  await page.unroute("**/api/v1/payment/collectCash");
  await expectAccessible(page);

  // Cọc: nhận ở hợp đồng, xác nhận ở Thu tiền
  await page.goto(leaseUrl);
  await page.getByRole("button", { name: "Nhận cọc" }).click();
  await expect(page.getByTestId("deposit-balance")).toHaveText("0 đ");
  await page.goto("/thu-tien");
  const pending = page.getByTestId("pending-payment");
  await expect(pending).toContainText("Cọc 3.000.000 đ");
  await pending.getByRole("button", { name: "Xác nhận đã nhận tiền" }).click();
  await expect(page.getByText("Không có khoản chờ xác nhận")).toBeVisible();
  await page.goto(leaseUrl);
  await expect(page.getByTestId("deposit-balance")).toHaveText("3.000.000 đ");
  await expect(page.getByRole("heading", { level: 2, name: "Báo trả phòng" })).toBeVisible();

  // Hàng chờ đối soát (chưa có giao dịch ngân hàng)
  await page.goto("/doi-soat");
  await expect(page.getByText("Không có giao dịch chờ đối soát")).toBeVisible();
  await expectAccessible(page);
});

test("S-006: mất mạng thì không gửi lệnh, báo OFFLINE, bấm lại được khi có mạng", async ({
  page,
  context,
}) => {
  await page.goto("/ky-thu");
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/billing/createPeriod")) posts++;
  });
  await context.setOffline(true);
  await page.getByLabel("Tháng (YYYY-MM)").fill("2098-12");
  await page.getByRole("button", { name: "Tạo kỳ" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Không có kết nối mạng" })).toHaveText(
    "Không có kết nối mạng. Thao tác chưa được gửi.",
  );
  expect(posts).toBe(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Tạo kỳ" }).click();
  await expect(status(page)).toHaveText("Đã có kỳ thu cho tháng này.");
  expect(posts).toBe(1);
});

test("S-010: server đã ghi nhưng mất phản hồi → kiểm tra kết quả, không gửi lần hai", async ({ page }) => {
  await page.goto("/ky-thu");
  const keys: string[] = [];
  let lookups = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && r.url().includes("/api/v1/commands/")) lookups++;
  });
  await page.route("**/api/v1/billing/createPeriod", async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByLabel("Tháng (YYYY-MM)").fill("2099-01");
  await page.getByRole("button", { name: "Tạo kỳ" }).click();
  await expect(status(page)).toHaveText("Đã có kỳ thu cho tháng này.");
  expect(keys).toHaveLength(1);
  expect(lookups).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("period").filter({ hasText: "Kỳ 01/2099" })).toHaveCount(1);
});

test("S-011: server chưa nhận lệnh → 404 COMMAND_NOT_FOUND → Gửi lại cùng key → đúng 1 kỳ", async ({
  page,
}) => {
  await page.goto("/ky-thu");
  const keys: string[] = [];
  await page.route("**/api/v1/billing/createPeriod", async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (keys.length === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.getByLabel("Tháng (YYYY-MM)").fill("2099-02");
  await page.getByRole("button", { name: "Tạo kỳ" }).click();
  // Chưa rõ kết quả ⇒ khoá ô nhập + nút gửi: không thể sửa payload rồi gửi dưới key cũ (review lát 4 🟠2).
  await expect(page.getByRole("button", { name: "Gửi lại" })).toBeVisible();
  await expect(page.getByLabel("Tháng (YYYY-MM)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tạo kỳ" })).toBeDisabled();
  await page.getByRole("button", { name: "Gửi lại" }).click();
  await expect(status(page)).toHaveText("Đã có kỳ thu cho tháng này.");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(page.getByTestId("period").filter({ hasText: "Kỳ 02/2099" })).toHaveCount(1);
});
