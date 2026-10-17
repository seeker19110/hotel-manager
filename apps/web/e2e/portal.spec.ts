// E2E portal người thuê (PLAN T-219; SPEC-portal S-001…S-013, S-016…S-022; SPEC-notifications S-010) với dữ liệu giả:
// đăng nhập OTP email (hộp thư giả) → Kỳ thu · Chi tiết phiếu · Thanh toán QR + "Tôi đã chuyển" · Hợp đồng · Điện nước ·
// Yêu cầu có ảnh · chuyển hướng khỏi trang nhân viên · X-Org-Context/CONTEXT_CHANGED · liên kết khách · huỷ đăng ký.
// Axe WCAG 2.2 AA (0 serious/critical) + vùng chạm ≥ 44 px ở mọi màn của S-022.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { confirmAction } from "./confirm.ts";
import {
  GUEST_PHONE_LAST4,
  GUEST_STAY_ID,
  GUEST_TOKEN,
  GUEST_TOKEN_EXPIRED,
  GUEST_TOKEN_REVOKED,
  JPEG,
  ORG_PORTAL,
  ORG_PORTAL_2,
  outboxFile,
  PORTAL_BANK_ACCOUNT,
  PORTAL_MEMO,
  PORTAL_TENANT,
  PORTAL_UNIT,
  SMOKE_USER,
  unsubFile,
} from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

// page.route() không thấy request đi qua service worker của PWA (Playwright khuyên chặn SW khi chặn bắt request) —
// trên CI SW đã kiểm soát trang thì lệnh đi thẳng tới server, bộ đếm route = 0. PWA được test riêng ở pwa.spec.ts.
test.use({ serviceWorkers: "block" });

const PORT = Number(process.env.E2E_PORT ?? 3100);

/** Mã OTP mới nhất gửi tới `email` trong hộp thư giả. */
async function otpFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const lines = readFileSync(outboxFile(PORT), "utf8").trim().split("\n").filter(Boolean);
    const mine = lines
      .map((l) => JSON.parse(l) as { to: string; text: string })
      .filter((m) => m.to === email);
    const code = /\b(\d{6})\b/.exec(mine.at(-1)?.text ?? "")?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("không thấy OTP trong hộp thư giả");
}

const outboxCount = (email: string) =>
  readFileSync(outboxFile(PORT), "utf8")
    .split("\n")
    .filter((l) => l.includes(`"to":"${email}"`)).length;

// Better Auth giới hạn gửi OTP (3 lần/phút/IP): đăng nhập MỘT lần rồi dùng lại cookie phiên cho các test sau.
let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
let invoiceUrl = "";

test("S-022 đăng nhập OTP email: mã sai bị từ chối, nhân viên không nhận mã, mã đúng → chọn tổ chức → /portal", async ({
  page,
  context,
}) => {
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/dang-nhap\/nguoi-thue$/);
  await expectAccessible(page);

  // Email nhân viên: phản hồi như thường nhưng KHÔNG gửi mã (không lộ ai là nhân viên).
  const before = outboxCount(SMOKE_USER.email);
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByRole("button", { name: "Gửi mã" }).click();
  await expect(page.getByLabel("Mã đăng nhập 6 số")).toBeVisible();
  expect(outboxCount(SMOKE_USER.email)).toBe(before);

  await page.goto("/dang-nhap/nguoi-thue");
  await page.getByLabel("Email").fill(PORTAL_TENANT.email);
  await page.getByRole("button", { name: "Gửi mã" }).click();
  const code = await otpFor(PORTAL_TENANT.email);
  await expectAccessible(page);
  await page.getByLabel("Mã đăng nhập 6 số").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Mã không đúng hoặc đã hết hạn." })).toBeVisible();
  await page.getByLabel("Mã đăng nhập 6 số").fill(code);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await expect(
    page.getByRole("button", { name: new RegExp(`${ORG_PORTAL_2.replace(/[()]/g, "\\$&")}.*Người thuê`) }),
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${ORG_PORTAL.replace(/[()]/g, "\\$&")}`) }).click();
  await expect(page).toHaveURL(/\/portal$/);
  sessionCookies = await context.cookies();
});

test.beforeEach(async ({ context }) => {
  if (sessionCookies.length > 0) await context.addCookies(sessionCookies);
});

test("S-001/S-021/S-022 Kỳ thu: một phiếu 3.580.000 đ 'Còn nợ'; kỳ nháp không hiện; header 'Tổ chức · Người thuê'; axe", async ({
  page,
}) => {
  await page.goto("/portal");
  await expect(page.getByTestId("portal-context")).toHaveText(`${ORG_PORTAL} · Người thuê`);
  const cards = page.getByTestId("invoice");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Kỳ 10/2026");
  await expect(cards.first()).toContainText("Còn nợ");
  await expect(cards.first().getByTestId("invoice-balance")).toHaveText("3.580.000 đ");
  // Trình đọc màn hình đọc số tiền thành chữ.
  await expect(cards.first()).toContainText("ba triệu năm trăm tám mươi nghìn đồng");
  await expectAccessible(page);
});

test("S-002/S-003/S-004/S-022 Chi tiết phiếu: các dòng cộng đúng tổng; phiếu lạ → 404 không lộ số tiền; axe", async ({
  page,
}) => {
  await page.goto("/portal");
  await page.getByTestId("invoice").first().getByRole("link").click();
  invoiceUrl = page.url();
  await expect(page.getByRole("heading", { level: 1, name: "Chi tiết phiếu" })).toBeVisible();
  const rows = page.getByTestId("invoice-lines").locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("3.000.000 đ");
  await expect(rows.nth(1)).toContainText("300.000 đ");
  await expect(rows.nth(2)).toContainText("180.000 đ");
  await expect(rows.nth(3)).toContainText("100.000 đ");
  await expect(page.getByTestId("inv-total")).toHaveText("3.580.000 đ");
  await expect(page.getByText("Chưa có khoản thanh toán nào được ghi nhận")).toBeVisible();
  await expectAccessible(page);

  const res = await page.goto("/portal/phieu/11111111-1111-4111-8111-111111111111");
  expect(res?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText("2.500.000");
});

test("S-010/S-022 Thanh toán: QR có văn bản thay thế, nội dung CK; 'Tôi đã chuyển' kèm X-Org-Context; phiếu vẫn còn nợ", async ({
  page,
}) => {
  const headers: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/portal/submitPaymentClaim"))
      headers.push(r.headers()["x-org-context"] ?? "");
  });
  await page.goto(invoiceUrl);
  await page.getByRole("link", { name: "Thanh toán" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Thanh toán" })).toBeVisible();
  const qr = page.getByRole("img", { name: /Mã QR chuyển khoản/ });
  await expect(qr).toHaveAttribute(
    "aria-label",
    new RegExp(`${PORTAL_BANK_ACCOUNT}.*3\\.580\\.000 đ.*${PORTAL_MEMO}`),
  );
  await expect(page.getByTestId("pay-content")).toHaveText(PORTAL_MEMO);
  await expect(page.getByTestId("pay-amount")).toHaveText("3.580.000 đ");
  await expectAccessible(page);

  // Số tiền không hợp lệ → lỗi gắn với ô nhập, chưa gửi.
  await page.getByLabel("Số tiền đã chuyển (đồng)").fill("abc");
  await page.getByRole("button", { name: "Tôi đã chuyển" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Nhập số nguyên đồng" })).toBeVisible();
  expect(headers).toHaveLength(0);

  await page.getByLabel("Số tiền đã chuyển (đồng)").fill("3.580.000");
  await page.getByRole("button", { name: "Tôi đã chuyển" }).click();
  await confirmAction(page, "Gửi báo đã chuyển 3.580.000 đ");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền" }),
  ).toBeVisible();
  expect(headers).toHaveLength(1);
  expect(headers[0]).toMatch(/^[0-9a-f-]{36}$/);
  // Báo chuyển KHÔNG đổi số dư (INV-F3).
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("inv-balance")).toHaveText("3.580.000 đ");
});

test("S-006 Hợp đồng: phiên bản điều khoản + cọc có nhãn riêng", async ({ page }) => {
  await page.goto("/portal/hop-dong");
  const lease = page.getByTestId("lease");
  await expect(lease).toContainText(`Phòng ${PORTAL_UNIT}`);
  await expect(lease).toContainText("Đang thuê");
  await expect(page.getByTestId("lease-version")).toContainText("v1");
  await expect(lease).toContainText("Cọc — không phải tiền đã trả cho phiếu");
  await expect(page.getByTestId("deposit-amount")).toHaveText("3.000.000 đ");
  await expectAccessible(page);
});

test("S-007 Điện nước: chỉ thấy chỉ số đã duyệt (1.350), không thấy bản nháp (1.420)", async ({ page }) => {
  await page.goto("/portal/dien-nuoc");
  const readings = page.getByTestId("reading");
  await expect(readings).toHaveCount(1);
  await expect(readings.first()).toContainText("Điện: 1.350");
  await expect(page.locator("body")).not.toContainText("1.420");
  await expectAccessible(page);
});

test("S-008/S-009/S-022 Yêu cầu: rỗng → gửi kèm ảnh → 'Đã tiếp nhận'; ảnh sai loại bị từ chối; axe", async ({
  page,
}) => {
  await page.goto("/portal/yeu-cau");
  await expect(page.getByText("Bạn chưa gửi yêu cầu nào")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Gửi yêu cầu" }).last().click();
  await expect(page.getByRole("alert").filter({ hasText: "Bắt buộc nhập" }).first()).toBeVisible();

  await page.getByLabel("Việc cần sửa").fill("Vòi nước rò");
  await page.getByLabel("Mô tả").fill("Rò dưới bồn rửa, nhỏ giọt cả ngày");
  await page
    .getByLabel("Ảnh (tuỳ chọn)")
    .setInputFiles({ name: "ghi-chu.txt", mimeType: "text/plain", buffer: Buffer.from("không phải ảnh") });
  await page.getByRole("button", { name: "Gửi yêu cầu" }).last().click();
  await expect(page.getByRole("alert").filter({ hasText: "Chỉ nhận ảnh JPEG, PNG, WebP." })).toBeVisible();

  await page
    .getByLabel("Ảnh (tuỳ chọn)")
    .setInputFiles({ name: "voi-nuoc.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await page.getByRole("button", { name: "Gửi yêu cầu" }).last().click();
  await expect(page.getByRole("status").filter({ hasText: "Đã gửi yêu cầu" })).toBeVisible();
  const req = page.getByTestId("request");
  await expect(req).toHaveCount(1);
  await expect(req).toContainText("Vòi nước rò");
  await expect(req).toContainText("Đã tiếp nhận");
  await expectAccessible(page);
});

test("S-022 bàn phím: Tab tới thẻ phiếu rồi Enter mở chi tiết; mọi nút có tên truy cập", async ({ page }) => {
  await page.goto("/portal");
  const link = page.getByTestId("invoice").first().getByRole("link");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    if (await link.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/portal\/phieu\//);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a[href], [role='button']")]
      .filter((el) => !(el.getAttribute("aria-label") || el.textContent?.trim()))
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
});

test("S-005 người thuê vào trang nhân viên → chuyển về /portal", async ({ page }) => {
  for (const path of ["/phong", "/hop-dong", "/ky-thu", "/thu-tien", "/doi-soat"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/portal$/);
  }
  const api = await page.request.post("/api/v1/billing/createPeriod", {
    data: { property_id: "11111111-1111-4111-8111-111111111111", month: "2099-01" },
    headers: { "idempotency-key": crypto.randomUUID(), origin: new URL(page.url()).origin },
  });
  expect(api.status()).toBe(403);
});

test("S-012/S-013 đổi tổ chức ở tab khác → 409 CONTEXT_CHANGED: báo tải lại, không gửi lại", async ({
  page,
  context,
}) => {
  await page.goto(invoiceUrl);
  await page.getByRole("link", { name: "Thanh toán" }).click();
  await expect(page.getByTestId("claim-form")).toBeVisible();

  // Tab 2 chuyển sang tổ chức thứ hai (cùng cookie).
  const tab2 = await context.newPage();
  await tab2.goto("/chon-to-chuc");
  await tab2.getByRole("button", { name: new RegExp(ORG_PORTAL_2.replace(/[()]/g, "\\$&")) }).click();
  await expect(tab2).toHaveURL(/\/portal$/);
  await expect(tab2.getByTestId("portal-context")).toHaveText(`${ORG_PORTAL_2} · Người thuê`);

  const posts: { header: string; status: number }[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().includes("/api/v1/portal/submitPaymentClaim"))
      posts.push({ header: r.request().headers()["x-org-context"] ?? "", status: r.status() });
  });
  await page.getByRole("button", { name: "Tôi đã chuyển" }).click();
  await confirmAction(page, "Gửi báo đã chuyển 3.580.000 đ");
  await expect(
    page.getByRole("alert").filter({ hasText: "Bạn vừa đổi tổ chức ở tab khác — tải lại trang" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Tải lại trang" })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]?.status).toBe(409);
  expect(posts[0]?.header).toMatch(/^[0-9a-f-]{36}$/);
  // Server không ghi gì khi 409 (kiểm ở command-route.db.test.ts / files/http.db.test.ts); trả tab 2 về tổ chức 1.
  await tab2.goto("/chon-to-chuc");
  await tab2.getByRole("button", { name: new RegExp(`^${ORG_PORTAL.replace(/[()]/g, "\\$&")}`) }).click();
  await expect(tab2).toHaveURL(/\/portal$/);
  await tab2.close();
});

test("S-016/S-017/S-018/S-019 liên kết khách: bước hai 4 số cuối SĐT, hết hạn, thu hồi, thiếu mã; no-referrer; axe", async ({
  page,
}) => {
  const url = (token: string) => `/khach/luot-o/${GUEST_STAY_ID}#t=${token}`;
  // Không có mã trong fragment.
  await page.goto(`/khach/luot-o/${GUEST_STAY_ID}`);
  await expect(page.getByText("Liên kết không đầy đủ")).toBeVisible();

  await page.goto(url(GUEST_TOKEN));
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  // Token không bị gửi lên server trong URL (nằm ở fragment, header riêng).
  const apiUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/portal/guest")) apiUrls.push(r.url());
  });
  await expectAccessible(page);
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill("12");
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Nhập đúng 4 chữ số" })).toBeVisible();
  expect(apiUrls).toHaveLength(0);
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill("0000");
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Liên kết hoặc mã xác minh không đúng." }),
  ).toBeVisible();
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill(GUEST_PHONE_LAST4);
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(page.getByTestId("guest-unit")).toHaveText("101");
  await expect(page.getByTestId("guest-balance")).toBeVisible();
  expect(apiUrls.every((u) => !u.includes(GUEST_TOKEN))).toBe(true);
  await expect(page.locator("body")).not.toContainText(`090123${GUEST_PHONE_LAST4}`);
  await expectAccessible(page);

  await page.goto(url(GUEST_TOKEN_EXPIRED));
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill(GUEST_PHONE_LAST4);
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(
    page.getByText("Liên kết đã hết hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới."),
  ).toBeVisible();
  await expectAccessible(page);

  await page.goto(url(GUEST_TOKEN_REVOKED));
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill(GUEST_PHONE_LAST4);
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(page.getByText("Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân.")).toBeVisible();
});

test("S-020 quá nhiều lần thử → hiện thông điệp 429 từ API", async ({ page }) => {
  await page.route("**/api/v1/portal/guest/stays/**", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/problem+json",
      body: JSON.stringify({
        code: "RATE_LIMITED",
        title: "Bạn thử quá nhiều lần. Vui lòng đợi ít phút.",
        status: 429,
      }),
    }),
  );
  await page.goto(`/khach/luot-o/${GUEST_STAY_ID}#t=${GUEST_TOKEN}`);
  await page.getByLabel("4 số cuối số điện thoại đặt phòng").fill("1234");
  await page.getByRole("button", { name: "Xem lượt ở" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Bạn thử quá nhiều lần. Vui lòng đợi ít phút." }),
  ).toBeVisible();
});

test("SPEC-notifications S-010 /huy-dang-ky: không tự POST khi tải; bấm xác nhận mới POST; dùng lại token → kết quả như cũ; token sai → báo lỗi", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/notifications/unsubscribe")) posts.push(r.url());
  });
  await page.goto("/huy-dang-ky");
  await expect(page.getByText("Liên kết không hợp lệ")).toBeVisible();

  const link = new URL(readFileSync(unsubFile(PORT), "utf8").trim());
  await page.goto(`${link.pathname}${link.search}`);
  await expect(page.getByRole("button", { name: "Xác nhận huỷ đăng ký" })).toBeVisible();
  await expectAccessible(page);
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(0);
  await page.getByRole("button", { name: "Xác nhận huỷ đăng ký" }).click();
  await expect(page.getByTestId("unsub-done")).toContainText(`Bạn sẽ không nhận email`);
  await expect(page.getByTestId("unsub-done")).toContainText(ORG_PORTAL);
  expect(posts).toHaveLength(1);

  await page.goto(`${link.pathname}${link.search}`);
  await page.getByRole("button", { name: "Xác nhận huỷ đăng ký" }).click();
  await expect(page.getByTestId("unsub-done")).toContainText("Bạn sẽ không nhận email");

  await page.goto("/huy-dang-ky?t=khong-phai-token-hop-le-1234");
  await page.getByRole("button", { name: "Xác nhận huỷ đăng ký" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Liên kết không hợp lệ." })).toBeVisible();
});
