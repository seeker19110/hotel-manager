// SPEC-pwa S-009: hành vi client của command — client quá cũ (426).
// Dùng form báo sự cố của buồng phòng khách sạn (ORG_HOTEL); lệnh ghi được MOCK ở tầng mạng khi cần để không đổi dữ liệu spec khác.
import { expect, type Page, test } from "@playwright/test";
import { type Cookies, loginStaff } from "./sessions.ts";

// page.route không thấy request đi qua service worker của PWA: chặn SW để route giả luôn có tác dụng.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

let hkCookies: Cookies = [];

test.beforeAll(async ({ browser }, info) => {
  hkCookies = await loginStaff(browser, info.project.use.baseURL as string, "hotel");
});

const CREATE = "**/api/v1/maintenance/createWorkOrder";

/** Điền và gửi form báo sự cố (không ảnh). */
async function submitIncident(page: Page, title: string): Promise<void> {
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill(title);
  await form.getByLabel("Mô tả").fill("Mô tả sự cố cho kiểm thử PWA.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
}

test("S-009 /api/version công bố phiên bản build + mức tối thiểu; trang và command gửi X-App-Version đúng bản build", async ({
  page,
  context,
  request,
}) => {
  const res = await request.get("/api/version");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const v = (await res.json()) as { version: string; min_client_version: string };
  expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(v.min_client_version).toMatch(/^\d+\.\d+\.\d+/);

  await context.addCookies(hkCookies);
  let sent: string | undefined;
  await page.route(CREATE, (r) => {
    sent = r.request().headers()["x-app-version"];
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        command_id: "00000000-0000-4000-8000-000000000001",
        status: "committed",
        data: {},
      }),
    });
  });
  await submitIncident(page, "Kiểm tra phiên bản gửi đi");
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  expect(sent).toBe(v.version);
  await expect(page.locator('meta[name="hm-app-version"]')).toHaveAttribute("content", v.version);
});

test("S-009 client quá cũ: server THẬT trả 426 CLIENT_OUTDATED, không ghi gì; UI hiện câu + nút Cập nhật; bấm thì tải lại bản mới", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  // Hạ X-App-Version của request thật xuống bản cũ — mức tối thiểu và quyết định 426 đều do server.
  const statuses: number[] = [];
  let posts = 0;
  await page.route(CREATE, (r) => {
    posts++;
    return r.continue({ headers: { ...r.request().headers(), "x-app-version": "0.0.1" } });
  });
  page.on("response", (res) => {
    if (res.url().endsWith("/maintenance/createWorkOrder")) statuses.push(res.status());
  });
  const title = "Sự cố do client cũ gửi";
  await submitIncident(page, title);
  const banner = page.getByTestId("outdated-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Ứng dụng cần cập nhật để tiếp tục");
  expect(statuses).toEqual([426]);
  expect(posts).toBe(1); // không tự gửi lại
  // Form không kẹt ở "đang gửi/đang kiểm tra": không có nút Gửi lại / không hỏi kết quả lệnh.
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);

  // "Cập nhật" ⇒ tải lại trang (SW bị chặn trong spec này nên không có SW chờ); banner biến mất.
  await page.unroute(CREATE);
  await Promise.all([page.waitForEvent("load"), banner.getByRole("button", { name: "Cập nhật" }).click()]);
  await expect(page.getByTestId("outdated-banner")).toHaveCount(0);
  // Không có phiếu nào được ghi từ lần gửi bị 426.
  await expect(page.getByText(title)).toHaveCount(0);
});
