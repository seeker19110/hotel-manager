// E2E khách sạn + vận hành (PLAN đợt 3 T-223; SPEC-reservation-stay, SPEC-housekeeping-maintenance, SPEC-audit-reporting S-006…S-008,
// SPEC-notifications S-017) với dữ liệu giả. R-003: báo giá → giữ phòng → xác nhận → nhận phòng → dịch vụ → mở ca → trả phòng tiền
// mặt → buồng phòng nhận/bắt đầu/xong (điện thoại) → nghiệm thu → phòng sẵn sàng. Thêm: "Hôm nay" + chuông, sự cố có ảnh,
// thông báo lưu trú, hộp thông báo, khách vãng lai, phòng bận, quyền buồng phòng. Axe WCAG 2.2 AA (0 serious/critical) +
// vùng chạm ≥ 44 px ở mọi màn.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import { confirmAction } from "./confirm.ts";
import { HOTEL_HK, HOTEL_NOTIFICATION_TITLE, HOTEL_OWNER, JPEG, ORG_HOTEL } from "./fixtures.ts";
import { hotelTotpFile, totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 3100);
const vnd = (n: number) => `${new Intl.NumberFormat("vi-VN").format(n)} đ`;
const GUEST = { name: "Khách E2E (giả)", phone: "0100000077", doc: "079123456789" };
const UUID_URL = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
let ownerCookies: Cookies = [];
let hkCookies: Cookies = [];

// Đăng nhập MỘT lần mỗi tài khoản rồi dùng lại cookie: Better Auth giới hạn tần suất `/two-factor/*` theo IP.
test.beforeAll(async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL as string;
  const { secret } = JSON.parse(readFileSync(hotelTotpFile(PORT), "utf8")) as { secret: string };
  const o = await browser.newContext({ baseURL });
  const op = await o.newPage();
  await op.goto("/dang-nhap");
  await op.getByLabel("Email").fill(HOTEL_OWNER.email);
  await op.getByLabel("Mật khẩu").fill(HOTEL_OWNER.password);
  await op.getByRole("button", { name: "Đăng nhập" }).click();
  await op.getByLabel("Mã xác thực 6 số").fill(totp(secret));
  await op.getByRole("button", { name: "Xác nhận" }).click();
  await expect(op).toHaveURL(/\/chon-to-chuc$/);
  await op.getByRole("button", { name: ORG_HOTEL }).click();
  await expect(op).toHaveURL(/\/phong$/);
  ownerCookies = await o.cookies();
  await o.close();

  const h = await browser.newContext({ baseURL });
  const hp = await h.newPage();
  await hp.goto("/dang-nhap");
  await hp.getByLabel("Email").fill(HOTEL_HK.email);
  await hp.getByLabel("Mật khẩu").fill(HOTEL_HK.password);
  await hp.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(hp).toHaveURL(/\/chon-to-chuc$/);
  await hp.getByRole("button", { name: ORG_HOTEL }).click();
  await expect(hp).toHaveURL(/\/phong$/);
  hkCookies = await h.cookies();
  await h.close();
});

const asOwner = (c: BrowserContext) => c.addCookies(ownerCookies);
const asHousekeeping = (c: BrowserContext) => c.addCookies(hkCookies);
const nav = (page: Page) => page.getByRole("navigation", { name: "Chức năng" });

let roomTotal = 0;
let stayUrl = "";

test("Hôm nay: thẻ có tên đầy đủ, 0 việc → 'Không có việc'; chuông 1 thông báo chưa đọc; axe", async ({
  page,
  context,
}) => {
  await asOwner(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Hôm nay" })).toBeVisible();
  await expect(page.getByTestId("business-date")).toContainText("ngày kinh doanh");
  const arrivals = page.getByRole("link", { name: "Khách đến hôm nay: 0" });
  await expect(arrivals).toContainText("Không có việc");
  await expect(page.getByRole("link", { name: "Khách đi hôm nay: 0" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Thông báo lưu trú sắp/quá hạn: 0" })).toBeVisible();
  await expect(page.getByTestId("bell")).toHaveAccessibleName("1 thông báo chưa đọc");
  await expectAccessible(page);
  await arrivals.click();
  await expect(page.getByText("Không có dòng nào trong mục này hôm nay.")).toBeVisible();
  await expectAccessible(page);
  // Thẻ lạ → 404, không lộ gì.
  const res = await page.goto("/hom-nay/khong-co-the-nay");
  expect(res?.status()).toBe(404);
});

test("R-003: báo giá → giữ → xác nhận → nhận phòng → dịch vụ → mở ca → trả phòng tiền mặt", async ({
  page,
  context,
}) => {
  await asOwner(context);

  // Báo giá: vượt sức chứa → lỗi theo mã; đúng → tổng giá + từng đêm.
  await page.goto("/dat-phong/moi");
  await expectAccessible(page);
  await page.getByLabel("Số khách").fill("9");
  await page.getByRole("button", { name: "Báo giá" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
  await page.getByLabel("Số khách").fill("2");
  await page.getByRole("button", { name: "Báo giá" }).click();
  const total = page.getByTestId("quote-total");
  await expect(total).toHaveText(/^(600\.000|700\.000) đ$/);
  roomTotal = Number((await total.innerText()).replaceAll(/\D/g, ""));
  await expectAccessible(page);

  // Giữ phòng: thiếu thông tin → lỗi theo ô; đủ → mở booking đang giữ + hạn giữ.
  await page.getByRole("button", { name: "Tạo và giữ phòng" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bắt buộc nhập" })).toBeVisible();
  await page.getByLabel("Họ tên người đặt").fill(GUEST.name);
  await page.getByLabel("Số điện thoại").fill(GUEST.phone);
  await page.getByRole("button", { name: "Tạo và giữ phòng" }).click();
  await expect(page).toHaveURL(UUID_URL);
  await expect(page.getByTestId("booking-status")).toHaveText(/Đang giữ phòng/);
  await expect(page.getByTestId("hold-until")).toContainText("Giữ phòng đến");
  await expect(page.getByTestId("room-total")).toHaveText(vnd(roomTotal));
  await expectAccessible(page);

  // Hôm nay: khách đến = 1 (đúng số dòng danh sách).
  const bookingUrl = page.url();
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Khách đến hôm nay: 1" })).toBeVisible();
  await page.getByRole("link", { name: "Khách đến hôm nay: 1" }).click();
  await expect(page.getByTestId("today-item")).toHaveCount(1);
  await page.getByTestId("today-item").getByRole("link").click();
  await expect(page).toHaveURL(bookingUrl);

  // Xác nhận (chưa thu trước) rồi nhận phòng: số giấy tờ ngắn → lỗi theo ô; khách chính = người đặt.
  await page.getByRole("button", { name: "Xác nhận (chưa thu trước)" }).click();
  await confirmAction(page, /^Xác nhận đặt phòng \S+ \(phòng \d+\) không thu trước$/);
  await expect(page.getByTestId("booking-status")).toHaveText(/Đã xác nhận/);
  await expectAccessible(page);
  await page.getByLabel("Số giấy tờ khách 1").fill("123");
  await page.getByRole("button", { name: "Xác nhận nhận phòng" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Số giấy tờ tối thiểu 5 ký tự" })).toBeVisible();
  await page.getByLabel("Số giấy tờ khách 1").fill(GUEST.doc);
  await page.getByRole("button", { name: "Xác nhận nhận phòng" }).click();
  await expect(page).toHaveURL(/\/luu-tru\/[0-9a-f-]{36}$/);
  stayUrl = page.url();
  await expect(page.getByTestId("stay-status")).toHaveText(/Đang ở/);
  await expect(page.getByTestId("folio-charges")).toHaveText(vnd(roomTotal));
  await expect(page.getByTestId("folio-balance")).toHaveText(vnd(roomTotal));
  // Số giấy tờ không hiện lại ở bất kỳ đâu trên trang.
  await expect(page.locator("body")).not.toContainText(GUEST.doc);
  await expectAccessible(page);

  // Dịch vụ + phụ thu; huỷ một khoản có lý do (khoản huỷ gạch ngang, không tính vào tổng).
  const charge = page.getByTestId("charge-form");
  await charge.getByLabel("Nội dung").fill("Nước suối");
  await charge.getByLabel("Số lượng").fill("2");
  await charge.getByLabel("Đơn giá (đồng)").fill("20000");
  await charge.getByRole("button", { name: "Thêm khoản" }).click();
  await expect(page.getByTestId("folio-charges")).toHaveText(vnd(roomTotal + 40_000));
  await charge.getByLabel("Loại khoản").selectOption("fee");
  await charge.getByLabel("Nội dung").fill("Khăn thêm");
  await charge.getByLabel("Số lượng").fill("1");
  await charge.getByLabel("Đơn giá (đồng)").fill("30000");
  await charge.getByRole("button", { name: "Thêm khoản" }).click();
  await expect(page.getByTestId("folio-charges")).toHaveText(vnd(roomTotal + 70_000));
  await page.getByText("Huỷ khoản: Khăn thêm").click();
  await page.getByLabel('Lý do huỷ "Khăn thêm"').fill("Khách không dùng");
  await page.getByRole("button", { name: "Huỷ khoản này" }).click();
  await confirmAction(page, /^Huỷ khoản "Khăn thêm" \(phòng \d+\)$/);
  await expect(page.getByTestId("folio-charges")).toHaveText(vnd(roomTotal + 40_000));
  await expect(page.getByTestId("charge").filter({ hasText: "đã huỷ" })).toHaveCount(1);
  await expectAccessible(page);

  // Trả phòng tiền mặt: chưa mở ca → mở ca; thu đúng số còn lại → trả phòng; folio về 0 đ.
  const due = roomTotal + 40_000;
  await page.getByRole("button", { name: "Mở ca" }).click();
  await expect(page.getByTestId("shift-open")).toBeVisible();
  const cash = page.getByLabel("Tiền mặt thu (đồng)");
  await expect(cash).toHaveValue(String(due));
  await page.getByRole("button", { name: "Thu tiền mặt và trả phòng" }).click();
  await confirmAction(page, new RegExp(`^Thu ${vnd(due).replace(/\./g, "\\.")} và trả phòng \\d+$`));
  await expect(page.getByTestId("stay-status")).toHaveText(/Đã trả phòng/);
  await expect(page.getByTestId("folio-balance")).toHaveText("0 đ");
  await expect(page.getByTestId("folio-paid")).toHaveText(vnd(due));
  await expect(page.getByTestId("folio-payment")).toContainText("Tiền mặt");
  await expect(page.getByTestId("folio-payment")).toContainText("Đã xác nhận");
  await expectAccessible(page);
});

test("buồng phòng (điện thoại): nhận → bắt đầu → xong, nút ≥ 44 px; không thấy tiền/đặt phòng; báo sự cố có ảnh", async ({
  page,
  context,
}) => {
  await asHousekeeping(context);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Phòng cần dọn: 1" })).toBeVisible();
  await expect(page.getByTestId("card-receivables")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(" đ");
  await expect(nav(page).getByRole("link", { name: "Đặt phòng" })).toHaveCount(0);
  await expectAccessible(page);

  // Quyền ở máy chủ: không có thẻ nợ, không xem được đặt phòng/folio.
  await page.goto("/hom-nay/receivables");
  await expect(page.getByText("Vai trò của bạn không có thẻ này.")).toBeVisible();
  await page.goto("/dat-phong");
  await expect(page.getByText("Vai trò của bạn không xem được đặt phòng.")).toBeVisible();
  expect((await page.goto(stayUrl))?.status()).toBe(404);

  await page.goto("/buong-phong");
  const task = page.getByTestId("task").filter({ hasText: "Phòng 101" });
  await expect(task).toContainText("Chưa nhận");
  await expectAccessible(page);
  await task.getByRole("link").click();
  await expect(page.getByTestId("task-status")).toHaveText(/Chưa nhận/);
  await expectAccessible(page);
  const big = async (name: string) => {
    const b = page.getByRole("button", { name });
    expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    return b;
  };
  await (await big("Nhận việc")).click();
  await expect(page.getByTestId("task-status")).toHaveText(/Đã nhận/);
  await (await big("Bắt đầu dọn")).click();
  await expect(page.getByTestId("task-status")).toHaveText(/Đang làm/);
  // Mất mạng khi bấm "Xong" (cơ chế SPEC-pwa S-006 trên màn buồng phòng): báo chưa gửi, không request, không báo thành công,
  // trạng thái giữ nguyên; có mạng lại thì bấm được và đúng một request.
  let completePosts = 0;
  const countPost = (r: { method(): string; url(): string }) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/housekeeping/completeTask")) completePosts++;
  };
  page.on("request", countPost);
  await context.setOffline(true);
  await (await big("Xong")).click();
  await expect(page.getByRole("alert").filter({ hasText: "Không có kết nối mạng" })).toHaveText(
    "Không có kết nối mạng. Thao tác chưa được gửi.",
  );
  await expect(page.getByTestId("task-status")).toHaveText(/Đang làm/);
  await expect(page.getByText("Đã xong — chờ nghiệm thu")).toHaveCount(0);
  expect(completePosts).toBe(0);
  await context.setOffline(false);
  await expect(page.getByTestId("network-banner")).toHaveCount(0);
  await (await big("Xong")).click();
  await expect(page.getByTestId("task-status")).toHaveText(/Đã xong — chờ nghiệm thu/);
  expect(completePosts).toBe(1);
  page.off("request", countPost);
  // Buồng phòng không tự nghiệm thu: không có nút.
  await expect(page.getByRole("button", { name: /Đạt/ })).toHaveCount(0);
  await expectAccessible(page);

  // Báo sự cố có ảnh: ảnh sai loại bị từ chối; ảnh đúng được kiểm tra rồi đính kèm.
  await page.goto("/su-co");
  await expect(page.getByText("Không có sự cố đang mở")).toBeVisible();
  await expectAccessible(page);
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Vòi nước rò rỉ");
  await form.getByLabel("Mô tả").fill("Vòi lavabo phòng 101 chảy nhỏ giọt.");
  await form.getByLabel(/^Ảnh/).setInputFiles({
    name: "ghi-chu.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("không phải ảnh"),
  });
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Chỉ nhận ảnh JPEG, PNG, WebP." })).toBeVisible();
  await form.getByLabel(/^Ảnh/).setInputFiles({ name: "voi-nuoc.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const order = page.getByTestId("work-order").filter({ hasText: "Vòi nước rò rỉ" });
  await expect(order).toContainText("1 ảnh đính kèm");
  await expect(order).toContainText("Mới báo");
  await expectAccessible(page);
});

test("nghiệm thu: phòng sẵn sàng; lịch phòng hiện lượt đã trả; thông báo của buồng phòng không lộ", async ({
  page,
  context,
}) => {
  await asOwner(context);
  await page.goto("/buong-phong");
  const task = page.getByTestId("task").filter({ hasText: "Phòng 101" });
  await expect(task).toContainText("Đã xong — chờ nghiệm thu");
  await task.getByRole("link").click();
  await page.getByRole("button", { name: "Không đạt" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bắt buộc nhập" })).toBeVisible();
  await page.getByRole("button", { name: "Đạt — phòng sẵn sàng" }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/Đã nghiệm thu/);
  await expectAccessible(page);
  await page.goto("/phong");
  await expect(page.getByTestId("room").filter({ hasText: "101" })).toContainText("Đã kiểm");

  await page.goto("/lich-phong");
  const today = page.getByTestId("calendar-day").first();
  await expect(today.getByTestId("calendar-room").filter({ hasText: "101" })).toContainText("Đã trả phòng");
  await expect(today.getByTestId("calendar-room").filter({ hasText: "102" })).toContainText("Trống");
  await expect(page.getByTestId("calendar-day")).toHaveCount(7);
  await expectAccessible(page);
  await page.goto("/dat-phong");
  await expect(page.getByTestId("booking")).toHaveCount(1);
  await expect(page.getByTestId("booking")).toContainText(GUEST.name);
  await expectAccessible(page);
});

test("sự cố: nhận xử lý → bắt đầu → sửa xong; người làm không tự nghiệm thu (SELF_APPROVAL_FORBIDDEN)", async ({
  page,
  context,
}) => {
  await asOwner(context);
  await page.goto("/su-co");
  const order = page.getByTestId("work-order").filter({ hasText: "Vòi nước rò rỉ" });
  await order.getByRole("button", { name: "Nhận xử lý" }).click();
  await expect(order).toContainText("Đã giao");
  await order.getByRole("button", { name: "Bắt đầu sửa" }).click();
  await expect(order).toContainText("Đang sửa");
  await order.getByLabel(/^Ghi chú sau sửa/).fill("Đã thay gioăng");
  await order.getByRole("button", { name: "Đã sửa xong" }).click();
  await expect(order).toContainText("Đã sửa — chờ nghiệm thu");
  await order.getByRole("button", { name: "Nghiệm thu" }).click();
  await expect(order.getByRole("alert")).toContainText("Bạn không thể tự nghiệm thu việc mình đã làm.");
  await expect(order).toContainText("Đã sửa — chờ nghiệm thu");
  await expectAccessible(page);
});

test("thông báo lưu trú: xuất file theo mẫu rồi đánh dấu đã nộp (hệ thống không tự nộp)", async ({
  page,
  context,
}) => {
  await asOwner(context);
  await page.goto("/thong-bao-luu-tru");
  const notice = page.getByTestId("notice").filter({ hasText: "Phòng 101" });
  await expect(notice).toContainText("Chưa xuất");
  await expectAccessible(page);
  await notice.getByRole("button", { name: "Xuất file phòng 101" }).click();
  await expect(notice.getByTestId("notice-download")).toBeVisible();
  await expect(notice).toContainText("Đã xuất — chưa nộp");
  await notice.getByLabel("Kênh đã nộp (phòng 101)").selectOption("online");
  await notice.getByRole("button", { name: "Đánh dấu đã nộp phòng 101" }).click();
  await expect(notice).toContainText("Đã nộp");
  await expect(notice.getByRole("button", { name: /Đánh dấu đã nộp/ })).toHaveCount(0);
  await expectAccessible(page);
});

test("hộp thông báo: chưa đọc → đã đọc; chuông cập nhật; rỗng có chữ", async ({ page, context }) => {
  await asOwner(context);
  await page.goto("/thong-bao");
  await expect(page.getByTestId("unread-count")).toHaveText("1 thông báo chưa đọc");
  const n = page.getByTestId("notification").filter({ hasText: HOTEL_NOTIFICATION_TITLE });
  await expect(n).toContainText("chưa đọc");
  await expectAccessible(page);
  await n.getByRole("button", { name: "Đánh dấu đã đọc" }).click();
  await expect(page.getByTestId("unread-count")).toHaveText("Không có thông báo chưa đọc");
  await expect(n).toContainText("đã đọc");
  await expect(page.getByTestId("bell")).toHaveAccessibleName("Thông báo");
  await expectAccessible(page);
  // Thông báo của người khác không lộ: buồng phòng không thấy thông báo của chủ.
  await context.clearCookies();
  await asHousekeeping(context);
  await page.goto("/thong-bao");
  await expect(page.getByText("Chưa có thông báo")).toBeVisible();
  await expect(page.getByText(HOTEL_NOTIFICATION_TITLE)).toHaveCount(0);
});

test("khách vãng lai nhận phòng ngay; đặt trùng phòng đang có khách bị từ chối, booking nháp giữ lại được", async ({
  page,
  context,
}) => {
  await asOwner(context);
  await page.goto("/luu-tru/moi");
  await expectAccessible(page);
  await page.getByLabel("Phòng", { exact: true }).selectOption({ label: "102 — Đã kiểm — sẵn sàng" });
  await page.getByRole("button", { name: "Nhận khách ngay" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bắt buộc nhập" }).first()).toBeVisible();
  await page.getByLabel("Họ tên khách 1").fill("Khách vãng lai (giả)");
  await page.getByLabel("Số điện thoại khách 1").fill("0100000099");
  await page.getByLabel("Số giấy tờ khách 1").fill("079012345678");
  await page.getByRole("button", { name: "Nhận khách ngay" }).click();
  await expect(page).toHaveURL(/\/luu-tru\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("stay-status")).toHaveText(/Đang ở/);

  await page.goto("/dat-phong/moi");
  await page.getByLabel("Phòng", { exact: true }).selectOption({ label: "102 · Tiêu chuẩn" });
  await page.getByRole("button", { name: "Báo giá" }).click();
  await expect(page.getByTestId("quote-total")).toBeVisible();
  await page.getByLabel("Họ tên người đặt").fill("Khách đặt trùng (giả)");
  await page.getByLabel("Số điện thoại").fill("0100000088");
  await page.getByRole("button", { name: "Tạo và giữ phòng" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Phòng đã có người" })).toBeVisible();
  const draft = page.getByRole("link", { name: "Mở đặt phòng nháp" });
  await expect(draft).toBeVisible();
  await expectAccessible(page);
  await draft.click();
  await expect(page.getByTestId("booking-status")).toHaveText(/Nháp/);
  await expectAccessible(page);
});
