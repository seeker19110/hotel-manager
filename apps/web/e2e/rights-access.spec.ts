// E2E quyền truy cập (T-2311, D-120; STD-PRIV-004 `rights-access`): đăng ký → trang Bảo mật → "Tải dữ liệu của tôi" (phiên vừa tạo nên đã
// xác thực lại ≤ 5 phút) → tệp JSON của CHÍNH tài khoản: email, đồng ý, yêu cầu truy cập đã ghi; không chứa mật khẩu/token phiên.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { CORE_CONSENT, submitSignUp } from "./consent.ts";

const PASSWORD = ["e2e", "xuat", "du", "lieu", "gia"].join("-");
const email = () => `xuat.du.lieu.${Date.now().toString(36)}@example.test`;

test("đăng ký → /bao-mat → tải dữ liệu của tôi ⇒ tệp JSON đủ phần của chính mình, ghi yêu cầu truy cập", async ({
  page,
}) => {
  const mail = email();
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill("Người xuất dữ liệu (giả)");
  await page.getByLabel("Email").fill(mail);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await page.getByLabel(CORE_CONSENT).check();
  await submitSignUp(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  await page.goto("/bao-mat");
  const block = page.getByTestId("account-rights");
  await expect(block.getByRole("heading", { name: "Dữ liệu của bạn" })).toBeVisible();
  await expectAccessible(page);

  const download = page.waitForEvent("download");
  await block.getByRole("button", { name: "Tải dữ liệu của tôi" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^du-lieu-ca-nhan-\d{4}-\d{2}-\d{2}\.json$/);
  const text = readFileSync((await file.path()) as string, "utf8");
  const data = JSON.parse(text) as {
    format: string;
    account: { email: string; name: string };
    consents: { purpose: string; action: string; channel: string }[];
    memberships: unknown[];
    sessions: unknown[];
    dsar_requests: { kind: string; status: string }[];
    analytics: { pseudonymous: boolean; total: number };
  };
  expect(data.format).toBe("hm-dsar-access/1");
  expect(data.account).toEqual(expect.objectContaining({ email: mail, name: "Người xuất dữ liệu (giả)" }));
  expect(data.consents).toEqual([
    expect.objectContaining({ purpose: "service_core", action: "grant", channel: "register" }),
  ]);
  expect(data.memberships).toEqual([]);
  expect(data.sessions.length).toBeGreaterThanOrEqual(1);
  expect(data.analytics).toEqual(expect.objectContaining({ pseudonymous: true, total: 0 }));
  expect(data.dsar_requests[0]).toEqual(expect.objectContaining({ kind: "access", status: "completed" }));
  expect(text).not.toContain(PASSWORD);
  await expect(page.getByRole("status").filter({ hasText: "Đã tạo tệp dữ liệu của bạn." })).toBeVisible();

  // Lịch sử yêu cầu ở server: một yêu cầu truy cập đã xong, có hạn.
  const st = await page.request.get("/api/v1/privacy/dsar");
  expect(st.status()).toBe(200);
  const body = (await st.json()) as { requests: { kind: string; status: string; due_at: string }[] };
  expect(body.requests).toEqual([expect.objectContaining({ kind: "access", status: "completed" })]);
});
