// SPEC-pwa S-009, S-012, S-013: hành vi client của command — client quá cũ (426), hỏi lại kết quả theo backoff, phiên hết hạn.
// Dùng form báo sự cố của buồng phòng khách sạn (ORG_HOTEL); lệnh ghi được MOCK ở tầng mạng khi cần để không đổi dữ liệu spec khác.
import { expect, type Page, test } from "@playwright/test";
import { HOTEL_HK, JPEG } from "./fixtures.ts";
import { type Cookies, loginStaff } from "./sessions.ts";

// page.route không thấy request đi qua service worker của PWA: chặn SW để route giả luôn có tác dụng.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

let hkCookies: Cookies = [];

test.beforeAll(async ({ browser }, info) => {
  hkCookies = await loginStaff(browser, info.project.use.baseURL as string, "hotel");
});

const CREATE = "**/api/v1/maintenance/createWorkOrder";

/** Phản hồi JSON giả cho `route.fulfill`. */
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  contentType: "application/json",
  headers,
  body: JSON.stringify(body),
});
const COMMANDS = "**/api/v1/commands/*";
const LOST = "Phiên đăng nhập đã hết";

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

test("S-009 tải ảnh: gửi X-App-Version đúng bản build; client cũ ⇒ 426 từ server THẬT, hiện nút Cập nhật, ảnh không được ghi", async ({
  page,
  context,
  request,
}) => {
  const { version } = (await (await request.get("/api/version")).json()) as { version: string };
  await context.addCookies(hkCookies);
  const UPLOAD = "**/api/v1/files/upload?*";
  const sent: (string | undefined)[] = [];
  const statuses: number[] = [];
  let downgrade = false;
  let createPosts = 0;
  await page.route(CREATE, (r) => {
    createPosts++;
    return r.continue();
  });
  await page.route(UPLOAD, (r) => {
    const headers = r.request().headers();
    sent.push(headers["x-app-version"]);
    return r.continue({ headers: downgrade ? { ...headers, "x-app-version": "0.0.1" } : headers });
  });
  page.on("response", (res) => {
    if (res.url().includes("/api/v1/files/upload")) statuses.push(res.status());
  });
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Sự cố kèm ảnh kiểm tra phiên bản");
  await form.getByLabel("Mô tả").fill("Mô tả sự cố cho kiểm thử tải ảnh.");
  await form.getByLabel(/^Ảnh/).setInputFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: JPEG });
  downgrade = true;
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  await expect(page.getByTestId("outdated-banner")).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Ứng dụng cần cập nhật để tiếp tục" }).first(),
  ).toBeVisible();
  expect(sent).toEqual([version]);
  expect(statuses).toEqual([426]);
  expect(createPosts).toBe(0); // chưa tới bước gửi lệnh: ảnh bị chặn thì phiếu không được tạo
});

// SPEC-housekeeping-maintenance S-024 + SPEC-pwa S-006 (D-050): có mạng lại ⇒ router.refresh() xong mới mở nút.
test("S-024 (housekeeping) + S-006: offline ⇒ không gửi; có mạng lại ⇒ tải lại trạng thái từ máy chủ rồi MỚI mở nút; bấm được và đúng một request", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  await page.route(CREATE, (r) => {
    posts++;
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        command_id: "00000000-0000-4000-8000-000000000002",
        status: "committed",
        data: {},
      }),
    });
  });
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Mất mạng rồi có lại");
  await form.getByLabel("Mô tả").fill("Mô tả sự cố cho kiểm thử S-024.");
  const submit = form.getByRole("button", { name: "Gửi báo sự cố" });

  await context.setOffline(true);
  await expect(page.getByTestId("network-banner")).toBeVisible();
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: "Không có kết nối mạng" })).toBeVisible();
  expect(posts).toBe(0);
  await expect(page.getByText("Đã ghi nhận sự cố")).toHaveCount(0);

  // Giữ phản hồi RSC của lần tải lại: trong lúc chờ, nút phải đang khoá.
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (u) => u.pathname === "/su-co",
    async (r) => {
      if (r.request().headers().rsc === "1") {
        refreshes++;
        await gate;
      }
      await r.continue();
    },
  );
  await context.setOffline(false);
  await expect(page.getByTestId("network-banner")).toHaveCount(0);
  await expect.poll(() => refreshes).toBe(1); // đã gọi router.refresh()
  await expect(submit).toBeDisabled(); // chưa tải xong trạng thái ⇒ chưa cho bấm lại
  expect(posts).toBe(0);
  release();
  await expect(submit).toBeEnabled();
  // Thông báo "mất mạng" cũ không còn đúng ⇒ đã gỡ; vẫn bấm lại được (S-006) và đúng một request.
  await expect(page.getByRole("alert").filter({ hasText: "Không có kết nối mạng" })).toHaveCount(0);
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  expect(posts).toBe(1);
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
  const asksBefore = asks.length;
  // Khoảng cách giữa các lần hỏi ≈ 1, 2, 4, 8, 15 s (sai số 0,5 s về phía nhanh, 3 s về phía chậm).
  expect(asks).toHaveLength(6);
  const gaps = asks.slice(1).map((t, i) => (t - (asks[i] as number)) / 1000);
  for (const [i, want] of [1, 2, 4, 8, 15].entries()) {
    expect(gaps[i], `lần hỏi ${i + 2}`).toBeGreaterThanOrEqual(want - 0.5);
    expect(gaps[i], `lần hỏi ${i + 2}`).toBeLessThanOrEqual(want + 3);
  }

  // D-043: từ RESULT_UNKNOWN bấm "Kiểm tra lại" mà server báo 404 (chưa thấy lệnh) ⇒ chuyển sang "unknown": bật "Gửi lại" cùng key.
  await page.unroute("**/api/v1/commands/*");
  let rechecks = 0;
  await page.route("**/api/v1/commands/*", (r) => {
    rechecks++;
    return r.fulfill(json(404, { code: "COMMAND_NOT_FOUND", status: 404 }));
  });
  await unknown.getByRole("button", { name: "Kiểm tra lại" }).click();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toBeVisible();
  await expect(page.getByTestId("result-unknown")).toHaveCount(0);
  expect(rechecks).toBe(1);
  expect(asks).toHaveLength(asksBefore); // lượt tra cũ đã dừng hẳn
  expect(posts).toBe(1); // vẫn chưa tự gửi lại
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

// Review lát T-606 🟠1: key chưa rõ kết quả không được mất khi gửi lại gặp 401 rồi "Để sau" (nếu mất ⇒ Lưu tạo key mới ⇒ ghi trùng).
test("S-013 + S-010: POST mất phản hồi ⇒ unknown; gửi lại gặp 401, 'Để sau' ⇒ GIỮ key, vẫn 'Gửi lại' được; lần sau mang CÙNG Idempotency-Key", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const keys: string[] = [];
  await page.route(CREATE, (r) => {
    keys.push(r.request().headers()["idempotency-key"] ?? "");
    if (keys.length === 1) return r.abort("failed"); // server (giả định) đã ghi nhưng mất phản hồi
    if (keys.length === 2) return r.fulfill(json(401, { code: "UNAUTHENTICATED", status: 401 }));
    return r.fulfill(json(200, { command_id: keys[0], status: "committed", data: {} }));
  });
  await page.route(COMMANDS, (r) => r.fulfill(json(404, { code: "COMMAND_NOT_FOUND", status: 404 })));
  await submitIncident(page, "Sự cố mất phản hồi rồi hết phiên");
  const resend = page.getByRole("button", { name: "Gửi lại" });
  await expect(resend).toBeVisible(); // unknown: key c1 được giữ

  await resend.click(); // POST #2 ⇒ 401 ⇒ hộp đăng nhập lại
  const dialog = page.getByTestId("reauth-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Để sau" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: LOST }).first()).toBeVisible();
  await expect(resend).toBeVisible(); // KHÔNG rơi về "error" bỏ key: vẫn khoá form, chỉ cho gửi lại cùng thao tác
  await expect(page.getByTestId("incident-form").getByLabel("Sự cố", { exact: true })).toBeDisabled();

  await resend.click(); // POST #3
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

// Review lát T-606 🟠2 (a): BE-API-008 / D-043.
test("D-043 POST 409 IDEMPOTENCY_IN_PROGRESS (Retry-After: 1): đợi rồi tra theo key; GET 404 = vẫn chạy (không bật 'Gửi lại'); committed ⇒ hiện kết quả, đúng 1 POST", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  const gets: string[] = [];
  let key = "";
  await page.route(CREATE, (r) => {
    posts++;
    key = r.request().headers()["idempotency-key"] ?? "";
    return r.fulfill(json(409, { code: "IDEMPOTENCY_IN_PROGRESS", status: 409 }, { "retry-after": "1" }));
  });
  await page.route(COMMANDS, (r) => {
    gets.push(r.request().url().split("/").at(-1) ?? "");
    if (gets.length === 1) return r.fulfill(json(404, { code: "COMMAND_NOT_FOUND", status: 404 }));
    return r.fulfill(json(200, { command_id: key, status: "committed", data: {} }));
  });
  await submitIncident(page, "Sự cố lệnh đang chạy");
  await expect(page.getByText("Đang kiểm tra kết quả…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  expect(posts).toBe(1);
  expect(gets).toEqual([key, key]); // 404 rồi committed, cùng key
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
});

// Review lát T-606 🟠2 (b): S-013 trong lúc tra kết quả.
test("S-013 phiên hết hạn lúc tra kết quả: GET 401 ⇒ hộp đăng nhập lại ⇒ tra tiếp CÙNG key ⇒ committed; không gửi lại POST", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  let key = "";
  const gets: string[] = [];
  await page.route(CREATE, (r) => {
    posts++;
    key = r.request().headers()["idempotency-key"] ?? "";
    return r.abort("failed");
  });
  await page.route(COMMANDS, (r) => {
    gets.push(r.request().url().split("/").at(-1) ?? "");
    if (gets.length === 1) return r.fulfill(json(401, { code: "UNAUTHENTICATED", status: 401 }));
    return r.fulfill(json(200, { command_id: key, status: "committed", data: {} }));
  });
  await submitIncident(page, "Sự cố hết phiên lúc tra kết quả");
  await reloginInDialog(page);
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  await expect(page.getByTestId("reauth-dialog")).toBeHidden();
  expect(posts).toBe(1);
  expect(gets).toEqual([key, key]);
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
});

// Review lát T-606 🟡3: như post() sau đăng nhập lại.
test("S-013 tra kết quả: sau đăng nhập lại mà GET trả 409 ORG_CONTEXT_REQUIRED ⇒ huỷ form (CONTEXT_CHANGED), không 'Gửi lại'", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  let gets = 0;
  await page.route(CREATE, (r) => {
    posts++;
    return r.abort("failed");
  });
  await page.route(COMMANDS, (r) => {
    gets++;
    if (gets === 1) return r.fulfill(json(401, { code: "UNAUTHENTICATED", status: 401 }));
    return r.fulfill(json(409, { code: "ORG_CONTEXT_REQUIRED", status: 409 }));
  });
  await submitIncident(page, "Sự cố mất ngữ cảnh lúc tra kết quả");
  await reloginInDialog(page);
  await expect(
    page.getByRole("alert").filter({ hasText: "Bạn vừa đổi tổ chức ở tab khác" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Tải lại trang" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toHaveCount(0);
  expect(posts).toBe(1);
  expect(gets).toBe(2);
});

// Review lát T-606 🟡4: cookie không lưu được ⇒ GET vẫn 401 sau đăng nhập lại ⇒ không mở lại hộp thoại vô hạn.
test("S-013 đăng nhập lại tối đa một lần mỗi lượt tra: GET vẫn 401 sau khi đăng nhập ⇒ dừng ở 'Gửi lại' + báo hết phiên, không lặp hộp thoại", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let gets = 0;
  await page.route(CREATE, (r) => r.abort("failed"));
  await page.route(COMMANDS, (r) => {
    gets++;
    return r.fulfill(json(401, { code: "UNAUTHENTICATED", status: 401 }));
  });
  await submitIncident(page, "Sự cố cookie không lưu được");
  await reloginInDialog(page);
  await expect(page.getByRole("alert").filter({ hasText: LOST }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại" })).toBeVisible();
  await expect(page.getByTestId("reauth-dialog")).toBeHidden();
  expect(gets).toBe(2); // một lần trước, một lần sau đăng nhập; không hỏi lần ba
});
