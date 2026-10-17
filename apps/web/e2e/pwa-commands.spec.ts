// SPEC-pwa S-009, S-012, S-013: hành vi client của command — client quá cũ (426), hỏi lại kết quả theo backoff, phiên hết hạn.
// Dùng form báo sự cố của buồng phòng khách sạn (ORG_HOTEL); lệnh ghi được MOCK ở tầng mạng khi cần để không đổi dữ liệu spec khác.
import { expect, type Page, test } from "@playwright/test";
import { HOTEL_HK } from "./fixtures.ts";
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

test("S-012 lệnh đang xử lý: hỏi lại theo backoff 1-2-4-8-15 s (tổng 30 s), 'Gửi lại' khoá suốt thời gian chờ; quá hạn hiện RESULT_UNKNOWN kèm command_id", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.addCookies(hkCookies);
  let posts = 0;
  let commandId = "";
  // Server đã nhận nhưng phản hồi bị mất (S-010) rồi luôn báo in_progress.
  await page.route(CREATE, (r) => {
    posts++;
    commandId = r.request().headers()["idempotency-key"] ?? "";
    return r.abort("failed");
  });
  const asks: number[] = [];
  await page.route("**/api/v1/commands/*", (r) => {
    asks.push(Date.now());
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ command_id: commandId, status: "in_progress" }),
    });
  });
  await submitIncident(page, "Sự cố đang xử lý mãi");
  await expect(page.getByText("Đang kiểm tra kết quả…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
  const unknown = page.getByTestId("result-unknown");
  await expect(unknown).toBeVisible({ timeout: 60_000 });
  await expect(unknown).toContainText(
    "Chưa xác định được kết quả. Đừng thao tác lại; kiểm tra lịch sử hoặc liên hệ quản lý.",
  );
  await expect(page.getByTestId("result-unknown-id")).toHaveText(commandId);
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
  expect(posts).toBe(1); // không gửi lại lệnh
  // Khoảng cách giữa các lần hỏi ≈ 1, 2, 4, 8, 15 s (sai số 0,5 s về phía nhanh, 3 s về phía chậm).
  expect(asks).toHaveLength(6);
  const gaps = asks.slice(1).map((t, i) => (t - (asks[i] as number)) / 1000);
  for (const [i, want] of [1, 2, 4, 8, 15].entries()) {
    expect(gaps[i], `lần hỏi ${i + 2}`).toBeGreaterThanOrEqual(want - 0.5);
    expect(gaps[i], `lần hỏi ${i + 2}`).toBeLessThanOrEqual(want + 3);
  }
});

/** Mở /su-co, điền form báo sự cố rồi GIỮ NGUYÊN trang (chưa bấm gửi) — để cho phiên hết hạn trước khi bấm. */
async function fillIncident(page: Page, title: string) {
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill(title);
  await form.getByLabel("Mô tả").fill("Mô tả sự cố cho kiểm thử phiên hết hạn.");
  return form;
}

/** Đăng nhập lại trong hộp thoại bằng tài khoản buồng phòng khách sạn. */
async function reloginInDialog(page: Page) {
  const dialog = page.getByTestId("reauth-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Đăng nhập lại" })).toBeFocused();
  await expect(dialog.getByText("Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.")).toBeVisible();
  await dialog.getByLabel("Email").fill(HOTEL_HK.email);
  await dialog.getByLabel("Mật khẩu").fill(HOTEL_HK.password);
  await dialog.getByRole("button", { name: "Đăng nhập" }).click();
}

test("S-013 phiên hết hạn: 401 ⇒ hộp đăng nhập lại (form giữ nguyên); đăng nhập xong gửi lại với CÙNG command_id, cùng tổ chức", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const keys: string[] = [];
  const statuses: number[] = [];
  let first = true;
  await page.route(CREATE, (r) => {
    keys.push(r.request().headers()["idempotency-key"] ?? "");
    // Lượt đầu đi tới server THẬT (phiên đã mất ⇒ 401); lượt sau đăng nhập lại được giả lập thành công để không đổi dữ liệu.
    if (first) {
      first = false;
      return r.continue();
    }
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ command_id: keys.at(-1), status: "committed", data: {} }),
    });
  });
  page.on("response", (res) => {
    if (res.url().endsWith("/maintenance/createWorkOrder")) statuses.push(res.status());
  });
  const title = "Sự cố khi phiên hết hạn";
  const form = await fillIncident(page, title);
  await context.clearCookies({ name: /session/ }); // phiên hết hạn; cookie chọn tổ chức còn nguyên
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();

  await reloginInDialog(page);
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  await expect(page.getByTestId("reauth-dialog")).toBeHidden();
  expect(statuses[0]).toBe(401);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]); // cùng command_id
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

test("S-013 sau đăng nhập lại mà ngữ cảnh tổ chức không còn: huỷ form (CONTEXT_CHANGED), không gửi sang tổ chức khác", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const statuses: number[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/maintenance/createWorkOrder")) statuses.push(res.status());
  });
  const form = await fillIncident(page, "Sự cố đổi ngữ cảnh");
  await context.clearCookies(); // mất cả phiên lẫn cookie chọn tổ chức ⇒ sau đăng nhập chưa có tổ chức nào đang chọn
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  await reloginInDialog(page);
  await expect(
    page.getByRole("alert").filter({ hasText: "Bạn vừa đổi tổ chức ở tab khác" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Tải lại trang" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
  expect(statuses).toEqual([401, 409]); // lượt hai bị chặn ở máy chủ, không ghi gì
});

test("S-013 bấm 'Để sau': không gửi gì, báo phiên đã hết, form dùng lại được", async ({ page, context }) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/maintenance/createWorkOrder")) posts++;
  });
  const form = await fillIncident(page, "Sự cố bỏ qua đăng nhập");
  await context.clearCookies({ name: /session/ });
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const dialog = page.getByTestId("reauth-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Để sau" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: "Phiên đăng nhập đã hết" })).toBeVisible();
  await expect(form.getByLabel("Sự cố", { exact: true })).toBeEnabled();
  expect(posts).toBe(1);
});
