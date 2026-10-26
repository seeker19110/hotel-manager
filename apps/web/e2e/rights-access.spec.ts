// E2E quyền truy cập dữ liệu (PLAN T-2311; STD-PRIV-004, CMP-RIGHTS-007; D-123): tài khoản tạo riêng trong test (không đụng seed
// dùng chung) → trang Quyền riêng tư → "Yêu cầu bản sao dữ liệu" → job `privacy.dsar` (server E2E chạy job này mỗi giây — e2e/server.ts)
// dựng gói → "Tải dữ liệu (JSON)" tải được gói có dữ liệu của CHÍNH mình (email, lựa chọn đồng ý, yêu cầu này), không có dữ liệu
// của người khác; người khác/không đăng nhập không tải được. Axe + vùng chạm 44 px.
import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { HOTEL_OWNER, PORTAL_TENANT, SMOKE_USER } from "./fixtures.ts";
import { signUpClick } from "./sign-in.ts";

test.describe.configure({ mode: "serial" });

const newAccount = (tag: string) => ({
  name: `Người ${tag} (giả)`,
  email: `${tag}.${randomUUID().slice(0, 8)}@example.test`,
  password: ["e2e", tag, "gia", "mk"].join("-"),
});
const ME = newAccount("truy-cap");
const OTHER = newAccount("nguoi-khac");

async function signUp(page: Page, who: typeof ME, consent: boolean): Promise<void> {
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Mật khẩu").fill(who.password);
  if (consent) await page.getByLabel(/Tôi đồng ý cho Hotel Manager đo lường/).check();
  await signUpClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
}

interface DataRequestsApi {
  requests: { id: string; type: string; status: string; due_at: string; download_url: string | null }[];
}

let downloadPath = "";
let requestId = "";

test("yêu cầu bản sao → job xử lý → tải được gói JSON chỉ có dữ liệu của chính mình", async ({ page }) => {
  await signUp(page, ME, true);
  await page.goto("/quyen-rieng-tu");
  const card = page.getByTestId("dsar-access-card");
  await expect(card.getByRole("heading", { name: "Tải dữ liệu của tôi" })).toBeVisible();
  await expect(page.getByTestId("dsar")).toContainText("bản sao trong 10 ngày");
  await expectAccessible(page);

  const sent = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/me/data-requests") && r.request().method() === "POST",
  );
  await card.getByRole("button", { name: "Yêu cầu bản sao dữ liệu" }).click();
  expect((await sent).status()).toBe(202);
  // (Gửi lại khi đang có yêu cầu mở ⇒ trả đúng yêu cầu đó — test DB `dsar.db.test.ts`, kể cả đồng thời; ở đây job chạy mỗi giây
  // nên yêu cầu có thể đã xong trước lần gửi lại.)

  // Job chạy mỗi giây ở server E2E: tải lại trang tới khi có liên kết tải.
  const link = card.getByRole("link", { name: "Tải dữ liệu (JSON)" });
  await expect(async () => {
    await page.reload();
    await expect(link).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("dsar-access-status")).toContainText("Bản sao đã sẵn sàng");
  await expect(page.getByTestId("dsar-history").getByRole("listitem")).toHaveCount(1);
  await expectAccessible(page);

  const api = (await (await page.request.get("/api/v1/me/data-requests")).json()) as DataRequestsApi;
  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]).toMatchObject({ type: "access", status: "completed" });
  requestId = api.requests[0]?.id as string;
  downloadPath = (await link.getAttribute("href")) as string;
  expect(downloadPath).toBe(`/api/v1/me/data-requests/${requestId}/download`);

  // Tải: 303 → URL ký của kho riêng tư → gói JSON.
  const head = await page.request.get(downloadPath, { maxRedirects: 0 });
  expect(head.status()).toBe(303);
  expect(head.headers().location).toContain(`/dsar/`);
  const res = await page.request.get(downloadPath);
  expect(res.status()).toBe(200);
  const text = await res.text();
  const pkg = JSON.parse(text) as {
    format: string;
    account: { email: string; name: string };
    consent_records: { action: string; channel: string }[];
    data_requests: { id: string; type: string }[];
    sign_in_methods: { provider: string }[];
    memberships: unknown[];
  };
  expect(pkg.format).toBe("hm-dsar-access/1");
  expect(pkg.account).toMatchObject({ email: ME.email, name: ME.name });
  expect(pkg.consent_records.map((c) => [c.action, c.channel])).toEqual([["grant", "signup"]]);
  expect(pkg.data_requests.map((d) => d.id)).toEqual([requestId]);
  expect(pkg.sign_in_methods.map((m) => m.provider)).toEqual(["credential"]);
  expect(pkg.memberships).toEqual([]);
  // Không có dữ liệu của người khác (tài khoản seed dùng chung) và không có băm mật khẩu.
  for (const foreign of [SMOKE_USER.email, HOTEL_OWNER.email, PORTAL_TENANT.email, OTHER.email])
    expect(text).not.toContain(foreign);
  expect(text).not.toMatch(/\$argon2|password"\s*:/);
});

test("người khác và người chưa đăng nhập không tải được gói của mình", async ({ browser, baseURL }) => {
  expect(downloadPath).not.toBe("");
  const anon = await (browser as Browser).newContext({ baseURL: baseURL as string });
  try {
    expect((await anon.request.get(downloadPath, { maxRedirects: 0 })).status()).toBe(401);
    expect((await anon.request.get("/api/v1/me/data-requests")).status()).toBe(401);
  } finally {
    await anon.close();
  }
  const ctx = await (browser as Browser).newContext({ baseURL: baseURL as string });
  try {
    const page = await ctx.newPage();
    await signUp(page, OTHER, false);
    expect((await page.request.get(downloadPath, { maxRedirects: 0 })).status()).toBe(404);
    const mine = (await (await page.request.get("/api/v1/me/data-requests")).json()) as DataRequestsApi;
    expect(mine.requests).toEqual([]);
  } finally {
    await ctx.close();
  }
});
