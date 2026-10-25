// E2E rút đồng ý (T-2310, D-119; CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004): đăng ký có tick phân tích sản phẩm → trang Bảo mật thấy
// "Đang bật" → tắt MỘT bước (một lần bấm, như một lần tick lúc đăng ký) → "Đang tắt" và bản ghi mới nhất là rút (kênh settings).
// Đăng ký thiếu ô bắt buộc service_core bị chặn ở giao diện VÀ ở server (gọi thẳng API, không tạo tài khoản).
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { ANALYTICS_CONSENT, CORE_CONSENT } from "./consent.ts";
import { signInClick } from "./sign-in.ts";

test.describe.configure({ mode: "serial" });

const PASSWORD = ["e2e", "rut", "dong", "y", "gia"].join("-");
// Mỗi project (mobile/desktop) có CSDL riêng nhưng thêm hậu tố để chạy lại `--repeat-each` không trùng email.
const email = (tag: string) => `rut.dong.y.${tag}.${Date.now().toString(36)}@example.test`;

interface ConsentRow {
  purpose: string;
  granted: boolean;
  channel: string | null;
}
async function consentsOf(page: Page): Promise<ConsentRow[]> {
  const res = await page.request.get("/api/v1/privacy/consents");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { consents: ConsentRow[] }).consents;
}

async function fillRegister(page: Page, mail: string) {
  await page.goto("/dang-ky");
  await page.getByLabel("Họ và tên").fill("Người rút đồng ý (giả)");
  await page.getByLabel("Email").fill(mail);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
}

test("đăng ký thiếu ô đồng ý bắt buộc → bị chặn (giao diện + server), không tạo tài khoản; hai ô không tick sẵn", async ({
  page,
  baseURL,
}) => {
  const mail = email("thieu");
  await fillRegister(page, mail);
  // Không dark pattern: cả ô bắt buộc lẫn ô phân tích đều trống khi mở trang.
  await expect(page.getByLabel(CORE_CONSENT)).not.toBeChecked();
  await expect(page.getByLabel(ANALYTICS_CONSENT)).not.toBeChecked();
  await expectAccessible(page);
  let signUps = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/auth/sign-up/")) signUps++;
  });
  await page.getByLabel(ANALYTICS_CONSENT).check(); // chỉ tick ô tuỳ chọn
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Cần đánh dấu ô đồng ý bắt buộc để tạo tài khoản." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dang-ky$/);
  expect(signUps).toBe(0);

  // Server không tin client: gọi thẳng API đăng ký không kèm đồng ý → 400 CONSENT_REQUIRED, tài khoản không tồn tại.
  const origin = new URL(baseURL as string).origin;
  for (const consents of [undefined, { service_core: false, product_analytics: true }]) {
    const res = await page.request.post("/api/auth/sign-up/email", {
      headers: { origin },
      data: { name: "Không đồng ý", email: mail, password: PASSWORD, ...(consents ? { consents } : {}) },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("CONSENT_REQUIRED");
  }
  const signIn = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: { email: mail, password: PASSWORD },
  });
  expect(signIn.status()).toBe(401);
});

test("đăng ký có tick phân tích → /bao-mat 'Đang bật' → tắt một bước → 'Đang tắt', bản ghi mới nhất là rút (kênh settings)", async ({
  page,
}) => {
  const mail = email("rut");
  await fillRegister(page, mail);
  await page.getByLabel(CORE_CONSENT).check();
  await page.getByLabel(ANALYTICS_CONSENT).check();
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });

  // Bằng chứng lúc cấp: cả hai mục đích đang đồng ý, kênh đăng ký.
  expect(await consentsOf(page)).toEqual([
    expect.objectContaining({ purpose: "service_core", granted: true, channel: "register" }),
    expect.objectContaining({ purpose: "product_analytics", granted: true, channel: "register" }),
  ]);

  await page.goto("/bao-mat");
  const block = page.getByTestId("privacy-settings");
  await expect(block.getByRole("heading", { name: "Quyền riêng tư" })).toBeVisible();
  await expect(page.getByTestId("consent-status-product_analytics")).toHaveText("Đang bật");
  await expect(page.getByTestId("consent-status-service_core")).toHaveText("Đang bật");
  // Mục đích bắt buộc: không có nút tắt, chỉ giải thích phải xoá tài khoản.
  await expect(page.getByTestId("consent-service_core").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("consent-service_core")).toContainText("cần xoá tài khoản");
  await expectAccessible(page);

  // MỘT bước: một lần bấm, không hộp xác nhận, không hỏi lại.
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/privacy/consents")) posts.push(r.postData() ?? "");
  });
  await page.getByRole("button", { name: "Tắt phân tích sản phẩm" }).click();
  await expect(page.getByTestId("consent-status-product_analytics")).toHaveText("Đang tắt");
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu lựa chọn của bạn." })).toBeVisible();
  expect(dialogs).toBe(0);
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0] as string)).toEqual({
    purpose: "product_analytics",
    action: "withdraw",
    channel: "settings",
  });
  // Nút bật lại cùng chỗ, cùng kiểu (bật lại cũng một bước).
  await expect(page.getByRole("button", { name: "Bật phân tích sản phẩm" })).toBeVisible();

  // Trạng thái lưu ở server: tải lại vẫn tắt; API cho thấy bản ghi mới nhất là rút qua kênh settings; service_core giữ nguyên.
  await page.reload();
  await expect(page.getByTestId("consent-status-product_analytics")).toHaveText("Đang tắt");
  expect(await consentsOf(page)).toEqual([
    expect.objectContaining({ purpose: "service_core", granted: true, channel: "register" }),
    expect.objectContaining({ purpose: "product_analytics", granted: false, channel: "settings" }),
  ]);

  // Đăng nhập lại (phiên mới) vẫn thấy đã tắt — không có gì tự bật lại.
  await page.request.post("/api/auth/sign-out", {
    headers: { origin: new URL(page.url()).origin },
    data: {},
  });
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(mail);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await signInClick(page);
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.goto("/bao-mat");
  await expect(page.getByTestId("consent-status-product_analytics")).toHaveText("Đang tắt");
});
