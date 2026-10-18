// E2E lời mời nhân viên (T-605; SPEC-access S-007, S-008): `/loi-moi#token=…` → đăng ký/đăng nhập → chấp nhận → vào tổ chức;
// lời mời hết hạn / đúng email khác / thiếu token báo rõ; token KHÔNG nằm ở URL sau khi mở và không được gửi lên máy chủ.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { HOTEL_HK, INVITEE, INVITEE_EXPIRED_EMAIL, inviteTokensFile, ORG_HOTEL, portOf } from "./fixtures.ts";
import { signInClick } from "./sign-in.ts";

test.describe.configure({ mode: "serial" });

// Cổng của server của project đang chạy (mỗi project có server riêng) — đặt trước mọi test của tệp.
let PORT = Number.NaN; // NaN đến khi beforeAll gán: quên gán thì đọc tệp "…-NaN" và đỏ ngay
test.beforeAll(({ browserName: _ }, info) => {
  PORT = portOf(info.project.use.baseURL);
});
const tokens = () =>
  JSON.parse(readFileSync(inviteTokensFile(PORT), "utf8")) as Record<"valid" | "expired" | "other", string>;
const PASSWORD = INVITEE.password;

async function register(page: import("@playwright/test").Page, email: string, name: string) {
  await page.getByRole("button", { name: "Tôi chưa có tài khoản" }).click();
  await page.getByLabel("Họ và tên").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await page.getByRole("button", { name: "Tạo tài khoản và tiếp tục" }).click();
}

test("thiếu token hoặc token sai dạng → báo liên kết không đầy đủ, không gọi API", async ({ page }) => {
  let apiCalls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/member/")) apiCalls++;
  });
  await page.goto("/loi-moi");
  await expect(page.getByText("Liên kết không đầy đủ")).toBeVisible();
  await expectAccessible(page);
  await page.goto("/loi-moi#token=sai");
  await expect(page.getByText("Liên kết không đầy đủ")).toBeVisible();
  expect(apiCalls).toBe(0);
});

test("token nằm ở fragment: bị xoá khỏi URL ngay và KHÔNG đi lên máy chủ (không có trong URL của mọi request)", async ({
  page,
}) => {
  const { valid } = tokens();
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(`/loi-moi#token=${valid}`);
  await expect(page.getByRole("button", { name: "Đăng nhập" })).toBeVisible();
  expect(page.url()).not.toContain(valid);
  expect(page.url()).not.toContain("#");
  expect(urls.filter((u) => u.includes(valid))).toEqual([]);
  await expectAccessible(page);
});

test("lời mời hết hạn: đăng ký đúng email → báo không còn hiệu lực rõ ràng, có hướng xử lý", async ({
  page,
}) => {
  const { expired } = tokens();
  await page.goto(`/loi-moi#token=${expired}`);
  await register(page, INVITEE_EXPIRED_EMAIL, "Người hết hạn (giả)");
  await page.getByRole("button", { name: "Chấp nhận lời mời" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Lời mời không còn hiệu lực" })).toBeVisible();
  await expect(page.getByText("Hãy nhờ quản trị gửi lại")).toBeVisible();
  await expectAccessible(page);
});

test("sai email: đăng nhập bằng tài khoản khác với email được mời → 410 như hết hạn, lời mời vẫn còn cho đúng người", async ({
  page,
}) => {
  const { other } = tokens();
  await page.goto(`/loi-moi#token=${other}`);
  await page.getByLabel("Email").fill(HOTEL_HK.email);
  await page.getByLabel("Mật khẩu").fill(HOTEL_HK.password);
  await signInClick(page);
  await expect(page.getByText(HOTEL_HK.email)).toBeVisible();
  await page.getByRole("button", { name: "Chấp nhận lời mời" }).click();
  await expect(page.getByText("Lời mời không còn hiệu lực", { exact: false }).first()).toBeVisible();
});

test("@smoke S-007 lời mời hợp lệ: tạo tài khoản đúng email → chấp nhận → vào tổ chức (đã chọn sẵn) và thấy trong danh sách tổ chức", async ({
  page,
}) => {
  const { valid } = tokens();
  await page.goto(`/loi-moi#token=${valid}`);
  await expectAccessible(page);
  await register(page, INVITEE.email, INVITEE.name);
  await expect(page.getByText(INVITEE.email)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Chấp nhận lời mời" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/, { timeout: 15_000 });
  await page.goto("/chon-to-chuc");
  await expect(
    page.getByRole("button", { name: new RegExp(ORG_HOTEL.replace(/[()]/g, "\\$&")) }),
  ).toBeVisible();
  // Dùng lại token (lời mời đã chấp nhận) → không còn hiệu lực.
  await page.goto(`/loi-moi#token=${valid}`);
  await page.getByRole("button", { name: "Chấp nhận lời mời" }).click();
  await expect(page.getByText("Lời mời không còn hiệu lực", { exact: false }).first()).toBeVisible();
});
