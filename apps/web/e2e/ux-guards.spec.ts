// E2E rào UX (PLAN đợt 4 T-310): màn hẹp 320 px không cuộn ngang (UX-RESP-001), `prefers-reduced-motion` tắt chuyển động
// (UX-VISUAL-001), đăng nhập → chọn tổ chức chỉ bằng bàn phím (UX-A11Y-003), lỗi 5xx chỉ hiện câu chung + mã tra cứu, không
// lộ chi tiết nội bộ (UX-STATE-005), icon là SVG không phải ký tự emoji (UX-VISUAL-006). Tài khoản buồng phòng khách sạn
// (mật khẩu, không TOTP) — không đụng dữ liệu của các spec khác.
// Đợt 5 T-411 thêm: 320 px cho MỌI route trong app/**/page.tsx (UX-RESP-001), bàn phím luồng lập kỳ/portal/hộp xác nhận
// (UX-A11Y-003), bấm đúp ⇒ đúng 1 POST + "Gửi lại" đúng một lần cùng key (UX-STATE-005/006, FE-FORM-007), lỗi theo ô có
// aria-invalid/aria-describedby (FE-FORM-002), scrim là token, chuỗi có dấu hiển thị không ô vuông (UX-DS-006).
// Lệnh ghi (thu tiền báo chuyển, gửi sự cố) được MOCK ở tầng mạng để không đổi dữ liệu của spec khác.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { accessibilityProblems } from "./a11y.ts";
import { confirmAction } from "./confirm.ts";
import { GUEST_STAY_ID, GUEST_TOKEN, HOTEL_HK, ORG_HOTEL } from "./fixtures.ts";
import { hydrated } from "./hydration.ts";
import { type Cookies, cachedSession } from "./sessions.ts";

// `page.route` không chặn được request do service worker đã nắm (production bật SW): chặn SW để mock luôn có tác dụng.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
// Spec dùng page.route: chặn service worker (SW của app có thể trả phản hồi trước khi route giả chặn được — tránh flaky).
test.use({ serviceWorkers: "block" });

let hkCookies: Cookies = [];

// Phiên dùng lại giữa các worker (sessions.ts `cachedSession`): worker mới không được đăng nhập lại — gửi OTP bị giới hạn 3 lần/phút.
test.beforeAll(async ({ browser }, info) => {
  hkCookies = await cachedSession("staff-hotel", browser, info.project.use.baseURL as string);
});

/** Phần tử tràn ra ngoài mép phải khung nhìn — rỗng khi không cuộn ngang; dùng để báo đúng thủ phạm khi đỏ. */
const overflowing = (page: Page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w) return [];
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > w + 0.5)
      .slice(0, 8)
      .map(
        (el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
      );
  });

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("320 px: các màn chính không cuộn ngang", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/dang-nhap", "/offline"]) {
    await page.goto(path);
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
  await context.addCookies(hkCookies);
  for (const path of ["/phong", "/buong-phong", "/su-co", "/thong-bao"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
});

test("prefers-reduced-motion: spinner/chuyển động gần như tắt", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dang-nhap");
  const ms = await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "spinner";
    document.body.append(el);
    const s = getComputedStyle(el);
    return Number.parseFloat(s.animationDuration) * (s.animationDuration.endsWith("ms") ? 1 : 1000);
  });
  expect(ms).toBeLessThanOrEqual(1);
});

test("bàn phím: đăng nhập → chọn tổ chức → danh sách phòng không cần chuột", async ({ page }) => {
  // Better Auth giới hạn /sign-in/email 20 lần/phút theo IP và chỉ đặt lại sau 60 s không có yêu cầu; bộ E2E đăng nhập nhiều
  // lần liên tiếp nên gặp 429 thì đợi hết cửa sổ rồi thử lại (không tắt rào), như sessions.ts.
  test.setTimeout(150_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").focus();
    await page.keyboard.type(HOTEL_HK.email);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Mật khẩu")).toBeFocused();
    await page.keyboard.type(HOTEL_HK.password);
    const signIn = page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-in/email"));
    await page.keyboard.press("Enter");
    if ((await signIn).status() !== 429) break;
    await page.waitForTimeout(61_000);
  }
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  const org = page.getByRole("button", { name: ORG_HOTEL });
  for (let i = 0; i < 20 && !(await org.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(org).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/phong$/);
});

test("lỗi 5xx đường thật: POST 500 → tra lệnh 404 → 'Chưa rõ… Gửi lại' + mã tra cứu, không lộ chi tiết", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const leak = "TypeError: cannot read 'x' at /srv/app/packages/app/src/secret.ts:12";
  await page.route("**/api/v1/maintenance/createWorkOrder", (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "INTERNAL", title: leak, detail: leak, correlation_id: "e2e-corr-real" }),
    }),
  );
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "COMMAND_NOT_FOUND" }),
    }),
  );
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Ổ cắm hỏng");
  await form.getByLabel("Mô tả").fill("Ổ cắm cạnh giường không có điện.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Chưa rõ máy chủ đã nhận" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("Mã tra cứu: e2e-corr-real");
  await expect(page.getByText(leak)).toHaveCount(0);
});

test("lỗi 5xx: chỉ câu chung + mã tra cứu, không lộ chi tiết nội bộ; icon là SVG", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const leak = "TypeError: cannot read 'x' at /srv/app/packages/app/src/secret.ts:12";
  await page.route("**/api/v1/maintenance/createWorkOrder", (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({
        code: "INTERNAL",
        status: 500,
        title: leak,
        detail: leak,
        correlation_id: "e2e-corr-500",
      }),
    }),
  );
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "failed",
        problem: { code: "INTERNAL", status: 500, detail: leak, correlation_id: "e2e-corr-500" },
      }),
    }),
  );
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Bóng đèn hỏng");
  await form.getByLabel("Mô tả").fill("Bóng đèn hành lang không sáng.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Hệ thống đang gặp lỗi" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("e2e-corr-500");
  await expect(page.getByText(leak)).toHaveCount(0);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const banner = page.getByTestId("network-banner");
  await expect(banner).toBeVisible();
  await expect(banner.locator("svg.icon")).toHaveCount(1);
  expect(await banner.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
  await context.setOffline(false);
});

// ───────────────────────────── helpers ─────────────────────────────

type Who = "public" | "hotel" | "rental" | "tenant";
async function asSession(
  who: Who,
  browser: Parameters<typeof cachedSession>[1],
  baseURL: string,
  context: BrowserContext,
) {
  await context.clearCookies();
  if (who === "public") return;
  await context.addCookies(await cachedSession(who, browser, baseURL));
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Mọi id (UUID) trong liên kết `prefix<uuid>` của trang hiện tại. */
async function idsOnPage(page: Page, prefix: string): Promise<string[]> {
  const re = new RegExp(`^${prefix.replaceAll("/", "\\/")}(${UUID})$`);
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  return [...new Set(hrefs.map((h) => re.exec(h)?.[1]).filter((x): x is string => Boolean(x)))];
}

/** Bấm Tab cho tới khi `target` có focus; quá `max` lần ⇒ coi là không tới được bằng bàn phím / bẫy focus. */
async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Không Tab tới được phần tử (không tiếp cận được bằng bàn phím, hoặc bẫy focus)");
}

// Mọi route trong app/<…>/page.tsx, dạng `/hop-dong/[id]`.
function routePatterns(): string[] {
  const root = fileURLToPath(new URL("../app/", import.meta.url));
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${rel}/${name}`);
      else if (name === "page.tsx") out.push(rel === "" ? "/" : rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Khoá thẻ "Hôm nay" lấy từ chính trang (không chép tay). */
function todayCards(): string[] {
  const src = readFileSync(fileURLToPath(new URL("../app/hom-nay/[card]/page.tsx", import.meta.url)), "utf8");
  const block = /const TITLE[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1] as string);
}

/** Đặt phòng mới (giữ phòng) qua giao diện nếu chưa có; trả id. Dùng khi chạy riêng spec (chưa có dữ liệu từ hotel.spec). */
async function ensureBooking(page: Page): Promise<string> {
  await page.goto("/dat-phong");
  const [found] = await idsOnPage(page, "/dat-phong/");
  if (found) return found;
  await page.goto("/dat-phong/moi");
  await page.getByLabel("Số khách").fill("2");
  await page.getByRole("button", { name: "Báo giá" }).click();
  await expect(page.getByTestId("quote-total")).toBeVisible();
  await page.getByLabel("Họ tên người đặt").fill("Khách rào UX (giả)");
  await page.getByLabel("Số điện thoại").fill("0100000088");
  await page.getByRole("button", { name: "Tạo và giữ phòng" }).click();
  await expect(page).toHaveURL(new RegExp(`/dat-phong/${UUID}$`));
  return page.url().split("/").at(-1) as string;
}

/** Id lượt ở: dùng lượt có sẵn; không có thì xác nhận + nhận phòng đặt phòng đầu tiên. */
async function ensureStay(page: Page): Promise<string> {
  await page.goto("/dat-phong");
  const bookings = await idsOnPage(page, "/dat-phong/");
  for (const b of bookings) {
    await page.goto(`/dat-phong/${b}`);
    const [stay] = await idsOnPage(page, "/luu-tru/");
    if (stay) return stay;
  }
  await page.goto(`/dat-phong/${bookings[0]}`);
  const plain = page.getByRole("button", { name: "Xác nhận (chưa thu trước)" });
  if (await plain.isVisible()) {
    await plain.click();
    await confirmAction(page, /^Xác nhận đặt phòng \S+ \(phòng \d+\) không thu trước$/);
    await expect(page.getByTestId("booking-status")).toHaveText(/Đã xác nhận/);
  }
  await page.getByLabel("Số giấy tờ khách 1").fill("079123456789");
  await page.getByRole("button", { name: "Xác nhận nhận phòng" }).click();
  await expect(page).toHaveURL(new RegExp(`/luu-tru/${UUID}$`));
  return page.url().split("/").at(-1) as string;
}

/** Id việc dọn phòng: dùng việc có sẵn; không có thì tạo một việc thủ công qua giao diện. */
async function ensureTask(page: Page): Promise<string> {
  await page.goto("/buong-phong");
  let [id] = await idsOnPage(page, "/buong-phong/");
  if (id) return id;
  // Phòng CUỐI danh sách: tạo việc dọn làm phòng đó "bẩn" — không được làm hỏng phòng đầu mà ensureStay sẽ nhận khách.
  const room = page.getByLabel("Phòng", { exact: true });
  await room.selectOption({ index: (await room.locator("option").count()) - 1 });
  await page.getByRole("button", { name: "Tạo việc" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã tạo việc." })).toBeVisible();
  await page.goto("/buong-phong");
  [id] = await idsOnPage(page, "/buong-phong/");
  if (!id) throw new Error("Không có việc dọn phòng sau khi tạo");
  return id;
}

/** Kỳ thu: tạo qua giao diện (idempotent) nếu chưa có; trả id. */
async function ensurePeriod(page: Page): Promise<string> {
  await page.goto("/ky-thu");
  let [id] = await idsOnPage(page, "/ky-thu/");
  if (id) return id;
  await page.getByRole("button", { name: "Tạo kỳ" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Đã có kỳ thu cho tháng này." })).toBeVisible();
  await page.goto("/ky-thu");
  [id] = await idsOnPage(page, "/ky-thu/");
  if (!id) throw new Error("Không có kỳ thu sau khi tạo");
  return id;
}

interface RouteSpec {
  who: Who;
  urls: (page: Page) => Promise<string[]>;
}
const fixed = (who: Who, ...urls: string[]): RouteSpec => ({ who, urls: async () => urls });
const firstOf = async (page: Page, list: string, prefix: string) => {
  await page.goto(list);
  const [id] = await idsOnPage(page, prefix);
  if (!id) throw new Error(`Seed E2E thiếu dữ liệu cho ${prefix}`);
  return id;
};

// Mỗi route trong app/<…>/page.tsx PHẢI có mục ở đây (thêm trang mới mà quên ⇒ test dưới đỏ). Route động dùng dữ liệu seed E2E. */
const ROUTES: Record<string, RouteSpec> = {
  "/": fixed("hotel", "/"),
  "/bao-mat": fixed("hotel", "/bao-mat"),
  "/buong-phong": fixed("hotel", "/buong-phong"),
  "/buong-phong/[id]": { who: "hotel", urls: async (p) => [`/buong-phong/${await ensureTask(p)}`] },
  "/chi-so/[id]": { who: "rental", urls: async (p) => [`/chi-so/${await ensurePeriod(p)}`] },
  "/chon-to-chuc": fixed("hotel", "/chon-to-chuc"),
  "/co-so": fixed("hotel", "/co-so"),
  "/dang-ky": fixed("public", "/dang-ky"),
  "/dang-nhap": fixed("public", "/dang-nhap"),
  "/dang-nhap/nguoi-thue": fixed("public", "/dang-nhap/nguoi-thue"),
  "/dat-phong": fixed("hotel", "/dat-phong"),
  "/dat-phong/[id]": { who: "hotel", urls: async (p) => [`/dat-phong/${await ensureBooking(p)}`] },
  "/dat-phong/moi": fixed("hotel", "/dat-phong/moi"),
  "/doi-soat": fixed("rental", "/doi-soat"),
  "/hom-nay/[card]": { who: "hotel", urls: async () => todayCards().map((c) => `/hom-nay/${c}`) },
  "/hop-dong": fixed("rental", "/hop-dong"),
  "/hop-dong/[id]": {
    who: "rental",
    urls: async (p) => [`/hop-dong/${await firstOf(p, "/hop-dong", "/hop-dong/")}`],
  },
  "/huy-dang-ky": fixed("public", "/huy-dang-ky"),
  "/khach/luot-o/[id]": fixed("public", `/khach/luot-o/${GUEST_STAY_ID}#t=${GUEST_TOKEN}`),
  "/ky-thu": fixed("rental", "/ky-thu"),
  "/ky-thu/[id]": { who: "rental", urls: async (p) => [`/ky-thu/${await ensurePeriod(p)}`] },
  "/lich-phong": fixed("hotel", "/lich-phong"),
  "/loi-moi": fixed("public", "/loi-moi#token=khong-hop-le"),
  "/luu-tru/[id]": { who: "hotel", urls: async (p) => [`/luu-tru/${await ensureStay(p)}`] },
  "/luu-tru/moi": fixed("hotel", "/luu-tru/moi"),
  "/offline": fixed("public", "/offline"),
  "/phong": fixed("hotel", "/phong"),
  "/portal": fixed("tenant", "/portal"),
  "/portal/dien-nuoc": fixed("tenant", "/portal/dien-nuoc"),
  "/portal/hop-dong": fixed("tenant", "/portal/hop-dong"),
  "/portal/phieu/[id]": {
    who: "tenant",
    urls: async (p) => [`/portal/phieu/${await firstOf(p, "/portal", "/portal/phieu/")}`],
  },
  "/portal/thanh-toan/[id]": {
    who: "tenant",
    urls: async (p) => [`/portal/thanh-toan/${await firstOf(p, "/portal", "/portal/phieu/")}`],
  },
  "/portal/yeu-cau": fixed("tenant", "/portal/yeu-cau"),
  "/su-co": fixed("hotel", "/su-co"),
  "/thanh-vien": fixed("hotel", "/thanh-vien"),
  "/thong-bao": fixed("hotel", "/thong-bao"),
  "/thong-bao-luu-tru": fixed("hotel", "/thong-bao-luu-tru"),
  "/them": fixed("hotel", "/them"),
  "/thu-tien": fixed("rental", "/thu-tien"),
};

test("danh mục route của E2E 320 px khớp đúng app/**/page.tsx (thêm trang phải khai báo ở ROUTES)", () => {
  expect(Object.keys(ROUTES).sort()).toEqual(routePatterns());
  expect(todayCards().length).toBeGreaterThanOrEqual(7);
});

test("320 px: MỌI route trong app/**/page.tsx không cuộn ngang, không mất nội dung, axe 0 vi phạm", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 320, height: 800 });
  // Gom theo người dùng để đăng nhập mỗi tài khoản đúng một lần; dữ liệu động (đặt phòng → lượt ở…) chạy theo thứ tự tên route.
  const visited: string[] = [];
  const a11y: string[] = []; // gom mọi vi phạm tiếp cận của mọi route rồi đòi rỗng (một lần chạy thấy hết, không dừng ở route đầu)
  for (const who of ["public", "rental", "hotel", "tenant"] as const) {
    await asSession(who, browser, baseURL as string, context);
    for (const [pattern, spec] of Object.entries(ROUTES)) {
      if (spec.who !== who) continue;
      await page.setViewportSize({ width: 320, height: 800 });
      for (const url of await spec.urls(page)) {
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        const want = new URL(url, "http://x").pathname;
        expect(new URL(page.url()).pathname, `${pattern}: bị chuyển hướng khỏi ${url}`).toBe(want);
        await expect(page.locator("main").first(), url).toBeVisible();
        expect(await overflowing(page), `${url} cuộn ngang ở 320 px (phần tử tràn phải)`).toEqual([]);
        // UX-A11Y-001: mọi route (kể cả route động) qua axe 0 vi phạm + vùng chạm ≥ 44 px, ở màn 320 px.
        for (const p of await accessibilityProblems(page)) a11y.push(`${url} → ${p}`);
        visited.push(url);
      }
    }
  }
  expect(visited.length).toBeGreaterThanOrEqual(Object.keys(ROUTES).length);
  expect(a11y, "vấn đề tiếp cận (UX-A11Y-001)").toEqual([]);
});

// ───────────────────────── bàn phím, hộp xác nhận, gửi đúp ─────────────────────────

const CLAIM_LABEL = /^Gửi báo đã chuyển [\d.]+ đ$/;
/** Mock lệnh báo chuyển khoản (không ghi DB); trả mảng khoá idempotency của từng POST. */
async function mockClaim(page: Page, delayMs = 0): Promise<string[]> {
  const keys: string[] = [];
  await page.route("**/api/v1/portal/submitPaymentClaim", async (r) => {
    keys.push(r.request().headers()["idempotency-key"] ?? "");
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
  });
  return keys;
}

test("hộp xác nhận: đóng rồi mở lại ngay (sự kiện close của lần đóng cũ đến muộn) → xác nhận vẫn gửi đúng 1 lần", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await asSession("tenant", browser, baseURL as string, context);
  const keys = await mockClaim(page);
  await page.goto("/portal");
  await page.getByTestId("invoice").getByRole("link").first().click();
  await page.getByRole("link", { name: "Thanh toán" }).click();
  await expect(page).toHaveURL(/\/portal\/thanh-toan\//);
  await hydrated(page.getByTestId("claim-form"));
  await page.getByRole("button", { name: "Tôi đã chuyển" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Đóng và mở lại trong CÙNG một task: sự kiện `close` của lần đóng tới sau khi hộp đã mở lại.
  await page.evaluate(() => {
    document.querySelector<HTMLDialogElement>("dialog.confirm-dialog")?.close();
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Tôi đã chuyển")?.click();
  });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(100);
  await dialog.getByRole("button", { name: CLAIM_LABEL }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận báo chuyển" })).toBeVisible();
  expect(keys).toHaveLength(1);
});

test("bàn phím (portal + hộp xác nhận): danh sách phiếu → thanh toán → Enter mở hộp → Esc/Quay lại không gửi → Enter xác nhận gửi đúng 1", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await asSession("tenant", browser, baseURL as string, context);
  const keys = await mockClaim(page);
  await page.goto("/portal");
  await tabTo(page, page.getByTestId("invoice").getByRole("link").first());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/portal\/phieu\//);
  await tabTo(page, page.getByRole("link", { name: "Thanh toán" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/portal\/thanh-toan\//);

  const submit = page.getByRole("button", { name: "Tôi đã chuyển" });
  await hydrated(page.getByTestId("claim-form"));
  await tabTo(page, page.getByLabel("Số tiền đã chuyển (đồng)"));
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  // Enter → hộp xác nhận mở, focus vào hộp (nút "Quay lại" — mặc định an toàn).
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText(/^Gửi báo đã chuyển [\d.]+ đ\?$/);
  await expect(dialog.getByRole("button", { name: "Quay lại" })).toBeFocused();
  // Hộp là modal: Tab đi tới nút xác nhận.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: CLAIM_LABEL })).toBeFocused();
  // Shift+Tab quay về "Quay lại" — focus không rơi ra trang phía sau (modal), và Esc vẫn thoát được.
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Quay lại" })).toBeFocused();
  // Esc đóng, KHÔNG gửi, focus về nút gửi.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(submit).toBeFocused();
  await page.waitForTimeout(300);
  expect(keys).toHaveLength(0);
  // Mở lại; Enter trên "Quay lại" cũng không gửi.
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Quay lại" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(keys).toHaveLength(0);
  // Mở lại; Tab tới nút xác nhận, Enter ⇒ gửi đúng một lần và báo thành công.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: CLAIM_LABEL })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận báo chuyển" })).toBeVisible();
  expect(keys).toHaveLength(1);
});

test("hộp xác nhận: nút ghi đúng hành động + đối tượng (không 'Đồng ý'), scrim là token, vừa màn 320 px, bấm đúp xác nhận ⇒ đúng 1 POST", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await asSession("tenant", browser, baseURL as string, context);
  await page.setViewportSize({ width: 320, height: 800 });
  const keys = await mockClaim(page, 400);
  const id = await firstOf(page, "/portal", "/portal/phieu/");
  await page.goto(`/portal/thanh-toan/${id}`);
  await page.getByLabel("Số tiền đã chuyển (đồng)").fill("930.000");
  await hydrated(page.getByTestId("claim-form"));
  await page.getByRole("button", { name: "Tôi đã chuyển" }).click();
  const dialog = page.getByRole("dialog");
  // Số tiền người dùng vừa nhập hiện trong nút xác nhận.
  await expect(dialog.getByRole("heading")).toHaveText("Gửi báo đã chuyển 930.000 đ?");
  await expect(
    dialog.getByRole("button", { name: "Gửi báo đã chuyển 930.000 đ", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đồng ý" })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 320).toBe(true);
  // Scrim lấy từ token --c-scrim (rgb(0 0 0 / 0.4)).
  const scrim = await dialog.evaluate((el) => getComputedStyle(el, "::backdrop").backgroundColor);
  expect(scrim).toBe("rgba(0, 0, 0, 0.4)");
  // Bấm đúp nút xác nhận ⇒ đúng 1 POST (phản hồi chậm 400 ms để lần bấm thứ hai có cơ hội lọt qua nếu rào hỏng).
  await dialog.getByRole("button", { name: "Gửi báo đã chuyển 930.000 đ", exact: true }).dblclick();
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận báo chuyển" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(keys).toHaveLength(1);
});

test("bấm đúp nút gửi (form không cần xác nhận) ⇒ đúng 1 POST; phản hồi chậm vẫn 1", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  let posts = 0;
  await page.route("**/api/v1/maintenance/createWorkOrder", async (r) => {
    posts++;
    await new Promise((res) => setTimeout(res, 600));
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
  });
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Vòi nước rỉ");
  await form.getByLabel("Mô tả").fill("Vòi nước phòng tắm rỉ nước liên tục.");
  const send = form.getByRole("button", { name: "Gửi báo sự cố" });
  await send.dblclick();
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(posts).toBe(1);
});

test('"Gửi lại" sau khi mất phản hồi: bấm đúp ⇒ chỉ gửi thêm đúng 1 lần, cùng Idempotency-Key, rồi báo thành công', async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  const keys: string[] = [];
  let mode: "drop" | "ok" = "drop";
  await page.route("**/api/v1/maintenance/createWorkOrder", async (r) => {
    keys.push(r.request().headers()["idempotency-key"] ?? "");
    if (mode === "drop") return r.abort("failed");
    await new Promise((res) => setTimeout(res, 300));
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
  });
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "COMMAND_NOT_FOUND" }),
    }),
  );
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByLabel("Sự cố", { exact: true }).fill("Máy lạnh kêu to");
  await form.getByLabel("Mô tả").fill("Máy lạnh phòng kêu to khi chạy.");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Chưa rõ máy chủ đã nhận" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  expect(keys).toHaveLength(1);
  // Form bị khoá khi chưa rõ kết quả (không sửa payload dưới key cũ).
  await expect(form.getByLabel("Sự cố", { exact: true })).toBeDisabled();
  mode = "ok";
  await banner.getByRole("button", { name: "Gửi lại" }).dblclick();
  await expect(page.getByRole("status").filter({ hasText: "Đã ghi nhận sự cố" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

test("bàn phím: lập kỳ thu (Tạo kỳ) chỉ bằng Tab/Enter; kỳ → xem trước → Gửi duyệt tới được bằng Tab", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await asSession("rental", browser, baseURL as string, context);
  await page.route("**/api/v1/billing/submitForReview", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) }),
  );
  await page.goto("/ky-thu");
  const month = page.getByLabel("Tháng (YYYY-MM)").first();
  await tabTo(page, month);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Tạo kỳ" }).first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Đã có kỳ thu cho tháng này." })).toBeVisible();
  // Từ danh sách tới kỳ vừa tạo bằng Tab + Enter.
  await page.goto("/ky-thu");
  await tabTo(page, page.getByTestId("period").getByRole("link").first());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/ky-thu/${UUID}$`));
  const review = page.getByRole("button", { name: "Gửi duyệt" });
  if (await review.isVisible()) {
    await tabTo(page, review);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Đã gửi duyệt" })).toBeVisible();
  }
});

test("bàn phím: thu tiền (trang Thu tiền) — mọi nút/ô nhập tới được bằng Tab, không bẫy focus", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await asSession("rental", browser, baseURL as string, context);
  await page.goto("/thu-tien");
  // Chờ trạng thái sẵn sàng thật trước vòng Tab: form đã hydrate và không fieldset nào đang khoá (`cmd.locked` bật khi
  // hook tra lại lệnh dở/đang kết nối lại ngay sau khi tải trang) — ô trong fieldset disabled không nhận focus.
  for (const form of await page.locator("main form").all()) await hydrated(form);
  await expect(page.locator("main fieldset[disabled]")).toHaveCount(0);
  const targets = page.locator("main").locator("button, input, select, a[href]");
  const n = await targets.count();
  const seen = new Set<string>();
  for (let i = 0; i < n + 40; i++) {
    await page.keyboard.press("Tab");
    seen.add(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el
          ? `${el.tagName}|${el.textContent?.trim().slice(0, 20)}|${el.getAttribute("name") ?? ""}`
          : "";
      }),
    );
  }
  // Mọi phần tử tương tác của vùng chính từng nhận được focus (không có phần tử chỉ dùng được bằng chuột).
  for (let i = 0; i < n; i++) {
    const t = targets.nth(i);
    if (!(await t.isVisible()) || (await t.isDisabled().catch(() => false))) continue;
    const key = await t.evaluate(
      (el) => `${el.tagName}|${el.textContent?.trim().slice(0, 20)}|${el.getAttribute("name") ?? ""}`,
    );
    expect(seen.has(key), `không Tab tới được ${key}`).toBe(true);
  }
});

// ───────────────────────── lỗi theo ô, chuỗi có dấu ─────────────────────────

test("submit sai: ô có aria-invalid=true và aria-describedby trỏ tới phần tử chứa lỗi (role=alert)", async ({
  page,
  context,
}) => {
  await context.addCookies(hkCookies);
  await page.goto("/su-co");
  const form = page.getByTestId("incident-form");
  await form.getByRole("button", { name: "Gửi báo sự cố" }).click();
  for (const label of ["Sự cố", "Mô tả"]) {
    const input = form.getByLabel(label, { exact: true });
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = (await input.getAttribute("aria-describedby")) ?? "";
    expect(describedBy).not.toBe("");
    const err = page.locator(`[id="${describedBy.split(" ").at(-1)}"]`);
    await expect(err).toHaveAttribute("role", "alert");
    await expect(err).toContainText("Bắt buộc nhập");
  }
  // Lỗi 5xx: câu chung không khớp mẫu rò rỉ nội bộ (UX-STATE-005).
  await expect(page.locator("main")).not.toContainText(/(Error:|at .*\.js|SELECT|Exception|TypeError)/);
});

test("chuỗi có dấu hiển thị đúng: 'ắ ầ ẩ ẫ ậ ờ ỡ ợ ừ ữ ự' không ô vuông (tofu) và giữ nguyên văn bản", async ({
  page,
}) => {
  // Không dùng ảnh baseline: ảnh chụp phụ thuộc phông hệ thống của từng máy/CI nên không ổn định; thay vào đó so văn bản
  // + vẽ từng ký tự ra canvas bằng đúng font-stack của trang và so với glyph "không có" (tofu) — trùng ⇒ thiếu glyph.
  await page.goto("/dang-nhap");
  const sample = "Tiếng Việt có dấu: ắ ầ ẩ ẫ ậ ờ ỡ ợ ừ ữ ự Đ đ ơ ư";
  const result = await page.evaluate((text) => {
    const holder = document.createElement("p");
    holder.id = "dau-tv";
    holder.textContent = text;
    document.body.append(holder);
    const font = `32px ${getComputedStyle(document.body).fontFamily}`;
    const draw = (ch: string) => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.font = font;
      ctx.textBaseline = "top";
      ctx.fillText(ch, 4, 4);
      return Array.from(ctx.getImageData(0, 0, 64, 64).data).join(",");
    };
    const blank = draw(" ");
    const tofu = new Set([draw("\u{10FFFE}"), draw("\u{E000}"), draw("\u{FFFFF}")]);
    const missing = [...text]
      .filter((ch) => ch.trim() !== "")
      .filter((ch) => {
        const d = draw(ch);
        return d === blank || tofu.has(d);
      });
    return { shown: holder.textContent, missing };
  }, sample);
  expect(result.shown).toBe(sample);
  expect(result.missing).toEqual([]);
  await expect(page.locator("#dau-tv")).toHaveText(sample);
  // Tiêu đề thật của trang cũng giữ nguyên dấu.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Đăng nhập/);
});
