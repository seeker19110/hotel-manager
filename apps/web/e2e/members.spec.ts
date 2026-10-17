// E2E màn Thành viên (T-605; SPEC-access S-007, S-010, S-018): chủ khách sạn mời nhân viên, đổi vai trò/cơ sở, thu hồi phiên
// (người bị thu hồi nhận 401 SESSION_REVOKED ở request kế tiếp); buồng phòng không có quyền vào màn này. Axe + vùng chạm ≥ 44 px.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { confirmAction } from "./confirm.ts";
import { HOTEL_HK, HOTEL_OWNER, ORG_HOTEL, STAFF_TARGET } from "./fixtures.ts";
import { signInClick } from "./sign-in.ts";
import { hotelTotpFile, totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 3100);
type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
let ownerCookies: Cookies = [];
let hkCookies: Cookies = [];
let targetCookies: Cookies = [];
let orgId = "";

test.beforeAll(async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL as string;
  const { secret } = JSON.parse(readFileSync(hotelTotpFile(PORT), "utf8")) as { secret: string };
  const o = await browser.newContext({ baseURL });
  const op = await o.newPage();
  await op.goto("/dang-nhap");
  await op.getByLabel("Email").fill(HOTEL_OWNER.email);
  await op.getByLabel("Mật khẩu").fill(HOTEL_OWNER.password);
  await signInClick(op);
  await op.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await op.getByRole("button", { name: "Xác nhận" }).click();
  await expect(op).toHaveURL(/\/chon-to-chuc$/);
  await op.getByRole("button", { name: ORG_HOTEL }).click();
  await expect(op).toHaveURL(/\/phong$/);
  ownerCookies = await o.cookies();
  orgId = ownerCookies.find((c) => c.name.endsWith("hm_org"))?.value ?? "";
  await o.close();

  for (const [who, set] of [
    [HOTEL_HK, (c: Cookies) => (hkCookies = c)],
    [STAFF_TARGET, (c: Cookies) => (targetCookies = c)],
  ] as const) {
    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    await p.goto("/dang-nhap");
    await p.getByLabel("Email").fill(who.email);
    await p.getByLabel("Mật khẩu").fill(who.password);
    await signInClick(p);
    await expect(p).toHaveURL(/\/chon-to-chuc$/);
    await p.getByRole("button", { name: ORG_HOTEL }).click();
    await expect(p).toHaveURL(/\/phong$/);
    set(await ctx.cookies());
    await ctx.close();
  }
});

test("buồng phòng không thấy mục Thành viên và vào /thanh-vien bị từ chối rõ ràng", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Chức năng" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Chức năng" }).getByRole("link", { name: "Thành viên" }),
  ).toHaveCount(0);
  // Thanh dưới chỉ 5 điểm vào (SPEC-pwa S-014); các màn còn lại nằm ở "Thêm" — buồng phòng cũng không thấy ở đó.
  await page.getByRole("navigation", { name: "Chức năng" }).getByRole("link", { name: "Thêm" }).click();
  await expect(page).toHaveURL(/\/them$/);
  await expect(page.getByRole("main").getByRole("link", { name: "Thành viên" })).toHaveCount(0);
  await page.goto("/thanh-vien");
  await expect(page.getByText("Chỉ chủ và quản lý xem được danh sách thành viên.")).toBeVisible();
  await expect(page.getByTestId("invite-form")).toHaveCount(0);
  await expectAccessible(page);
});

test("chủ: mời nhân viên → lời mời hiện ở danh sách chờ; mời trùng bị từ chối; thiếu cơ sở cho vai trò theo cơ sở bị chặn", async ({
  page,
  context,
}) => {
  await context.addCookies(ownerCookies);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Chức năng" }).getByRole("link", { name: "Thêm" }).click();
  await page.getByRole("main").getByRole("link", { name: "Thành viên" }).click();
  await expect(page).toHaveURL(/\/thanh-vien$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thành viên");
  await expectAccessible(page);

  const form = page.getByTestId("invite-form");
  await form.getByLabel("Email người được mời").fill("nv.moi.ui@example.test");
  await form.getByLabel("Vai trò").selectOption("front_desk");
  await form.getByLabel("Hạn mức giảm giá (đ)").fill("100.000");
  await form.getByRole("button", { name: "Gửi lời mời" }).click();
  await expect(form.getByText("Đã gửi lời mời", { exact: false })).toBeVisible();
  await expect(page.getByTestId("invitations")).toContainText("nv.moi.ui@example.test");
  await expect(page.getByTestId("invitations")).toContainText("Lễ tân");

  // Mời lại cùng email + vai trò khi còn lời mời chờ → 409, báo lỗi.
  await form.getByLabel("Email người được mời").fill("nv.moi.ui@example.test");
  await form.getByRole("button", { name: "Gửi lời mời" }).click();
  await expect(form.getByRole("alert")).toContainText("Đã có lời mời đang chờ");

  // Vai trò theo cơ sở mà không chọn cơ sở → 422 từ server (chọn "Tất cả cơ sở").
  await form.getByLabel("Email người được mời").fill("khong.co.so@example.test");
  await form.getByLabel("Cơ sở").selectOption("");
  await form.getByRole("button", { name: "Gửi lời mời" }).click();
  await expect(form.getByRole("alert").first()).toBeVisible();
  await expectAccessible(page);

  // Email rất dài, không có khoảng trắng: phải xuống dòng, không đẩy trang cuộn ngang ở 320 px (và không bị cắt mất nội dung).
  const longEmail = "danh.cho.nguoi.khac.co.ten.rat.dai.de.thu.tran.ngang.man.hinh@example.test";
  await form.getByLabel("Email người được mời").fill(longEmail);
  await form.getByLabel("Cơ sở").selectOption({ index: 1 });
  await form.getByRole("button", { name: "Gửi lời mời" }).click();
  await expect(page.getByTestId("invitations")).toContainText(longEmail);
  await page.setViewportSize({ width: 320, height: 800 });
  const spill = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(spill, "/thanh-vien cuộn ngang ở 320 px").toBeLessThanOrEqual(0);
});

test("chủ: đổi vai trò + cơ sở của nhân viên (có lý do), rồi thu hồi phiên → người đó nhận 401 SESSION_REVOKED", async ({
  page,
  context,
  browser,
}, info) => {
  await context.addCookies(ownerCookies);
  await page.goto("/thanh-vien");
  const row = page.getByTestId("member").filter({ hasText: STAFF_TARGET.name });
  await expect(row).toContainText("Buồng phòng");

  await row.locator("summary", { hasText: "Đổi vai trò" }).click();
  await row.getByLabel("Vai trò mới").selectOption("maintenance");
  await row.getByLabel("Lý do").first().fill("Chuyển sang kỹ thuật");
  await row.getByRole("button", { name: "Đổi vai trò" }).click();
  await confirmAction(page, `Đổi vai trò của ${STAFF_TARGET.name}`);
  await expect(row.getByText("Đã đổi vai trò", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("member").filter({ hasText: STAFF_TARGET.name })).toContainText("Kỹ thuật");

  // Người đích đang đăng nhập (phiên hợp lệ) → thu hồi → request kế tiếp 401 SESSION_REVOKED.
  const baseURL = info.project.use.baseURL as string;
  const t = await browser.newContext({ baseURL });
  await t.addCookies(targetCookies);
  const headers = { "x-org-id": orgId };
  expect((await t.request.get("/api/v1/notifications/listMine", { headers })).status()).toBe(200);

  const row2 = page.getByTestId("member").filter({ hasText: STAFF_TARGET.name });
  await row2.getByRole("button", { name: `Thu hồi phiên đăng nhập — ${STAFF_TARGET.name}` }).click();
  await confirmAction(page, `Thu hồi phiên của ${STAFF_TARGET.name}`);
  await expect(row2.getByText("Đã đăng xuất người này", { exact: false })).toBeVisible();

  const after = await t.request.get("/api/v1/notifications/listMine", { headers });
  expect(after.status()).toBe(401);
  expect(((await after.json()) as { code: string }).code).toBe("SESSION_REVOKED");
  await t.close();
  await expectAccessible(page);
});
