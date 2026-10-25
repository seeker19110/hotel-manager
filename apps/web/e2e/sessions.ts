// Đăng nhập dùng chung cho E2E rào UX: mỗi tài khoản đăng nhập MỘT lần rồi dùng lại cookie (Better Auth giới hạn tần suất
// `/two-factor/*` và gửi OTP theo IP). Gặp giới hạn (429) thì đợi rồi thử lại, không bỏ qua rào.
import { readFileSync, writeFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { passTenantConsentIfAsked } from "./consent.ts";
import {
  HOTEL_HK,
  HOTEL_OWNER,
  ORG_HOTEL,
  ORG_MAIN,
  ORG_PORTAL,
  ORG_RENTAL,
  outboxFile,
  PORTAL_TENANT,
  portOf,
  RENTAL_OWNER,
  type SessionKind,
  SMOKE_USER,
  sessionCacheFile,
} from "./fixtures.ts";
import { keepSavedSession } from "./session-verdict.ts";
import { signInClick } from "./sign-in.ts";
import { hotelTotpFile, totp, totpFile } from "./totp.ts";

export type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;

async function withFreshPage(
  browser: Browser,
  baseURL: string,
  run: (page: Page) => Promise<void>,
): Promise<Cookies> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctx = await browser.newContext({ baseURL });
    try {
      await run(await ctx.newPage());
      return await ctx.cookies();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 12_000));
    } finally {
      await ctx.close();
    }
  }
  throw lastError;
}

/** Chủ có TOTP (nhà trọ hoặc khách sạn): mật khẩu → mã 6 số → chọn tổ chức. */
export function loginOwner(browser: Browser, baseURL: string, who: "rental" | "hotel"): Promise<Cookies> {
  const account = who === "rental" ? RENTAL_OWNER : HOTEL_OWNER;
  const org = who === "rental" ? ORG_RENTAL : ORG_HOTEL;
  const port = portOf(baseURL);
  const file = who === "rental" ? totpFile(port) : hotelTotpFile(port);
  return withFreshPage(browser, baseURL, async (page) => {
    const { secret } = JSON.parse(readFileSync(file, "utf8")) as { secret: string };
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Mật khẩu").fill(account.password);
    await signInClick(page);
    await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 10_000 });
    await page.getByRole("button", { name: org }).click();
    await expect(page).toHaveURL(/\/phong$/);
  });
}

/** Nhân viên đăng nhập bằng mật khẩu (không TOTP): buồng phòng Hoa Sen (ORG_MAIN) hoặc buồng phòng khách sạn Biển (ORG_HOTEL). */
export function loginStaff(browser: Browser, baseURL: string, who: "main" | "hotel"): Promise<Cookies> {
  const account = who === "main" ? SMOKE_USER : HOTEL_HK;
  const org = who === "main" ? ORG_MAIN : ORG_HOTEL;
  return withFreshPage(browser, baseURL, async (page) => {
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Mật khẩu").fill(account.password);
    await signInClick(page);
    await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 10_000 });
    await page.getByRole("button", { name: org }).click();
    await expect(page).toHaveURL(/\/phong$/);
  });
}

const mailsTo = (baseURL: string, email: string) =>
  readFileSync(outboxFile(portOf(baseURL)), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { to: string; text: string })
    .filter((m) => m.to === email);

/** Mã OTP của thư MỚI gửi tới `email` (thư thứ `before + 1` trở đi) — không lấy nhầm mã của lần đăng nhập trước. */
async function newOtpFor(baseURL: string, email: string, before: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const mine = mailsTo(baseURL, email);
    const code = mine.length > before ? /\b(\d{6})\b/.exec(mine.at(-1)?.text ?? "")?.[1] : undefined;
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("không thấy OTP mới trong hộp thư giả");
}

/** Người thuê An: OTP email (hộp thư giả) → chọn tổ chức → /portal. */
export function loginTenant(browser: Browser, baseURL: string): Promise<Cookies> {
  return withFreshPage(browser, baseURL, async (page) => {
    await page.goto("/dang-nhap/nguoi-thue");
    await page.getByLabel("Email").fill(PORTAL_TENANT.email);
    const before = mailsTo(baseURL, PORTAL_TENANT.email).length;
    await page.getByRole("button", { name: "Gửi mã" }).click();
    const code = await newOtpFor(baseURL, PORTAL_TENANT.email, before);
    await page.getByLabel("Mã đăng nhập 6 số").fill(code);
    await signInClick(page);
    await passTenantConsentIfAsked(page); // lần đầu dùng portal: bước đồng ý service_core (T-2310)
    await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 10_000 });
    await page.getByRole("button", { name: new RegExp(`^${ORG_PORTAL.replace(/[()]/g, "\\$&")}`) }).click();
    await expect(page).toHaveURL(/\/portal$/);
  });
}

/** Phiên còn hiệu lực ở server hiện tại (file cũ của server đã chết/đổi CSDL ⇒ không dùng). */
async function stillValid(browser: Browser, baseURL: string, cookies: Cookies): Promise<boolean> {
  const ctx = await browser.newContext({ baseURL });
  try {
    await ctx.addCookies(cookies);
    const res = await ctx.request.get("/api/auth/get-session");
    return keepSavedSession(res.status(), res.ok() ? await res.json() : undefined);
  } finally {
    await ctx.close();
  }
}

/**
 * Đăng nhập MỘT lần cho cả vòng đời server (không phải vòng đời worker): Playwright dựng worker mới sau mỗi test đỏ, mỗi lần
 * `--repeat-each` và mỗi nhóm serial — bộ nhớ trong tiến trình mất, đăng nhập lại mỗi lần sẽ vượt giới hạn gửi OTP (3/phút/IP) và
 * `/two-factor/*`. Cookie lưu ở tệp tạm khoá theo cổng, kiểm còn hiệu lực rồi mới dùng; không còn hiệu lực thì đăng nhập lại.
 */
export async function cachedSession(kind: SessionKind, browser: Browser, baseURL: string): Promise<Cookies> {
  const file = sessionCacheFile(portOf(baseURL), kind);
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Cookies;
    if (saved.length > 0 && (await stillValid(browser, baseURL, saved))) return saved;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  const fresh =
    kind === "tenant"
      ? await loginTenant(browser, baseURL)
      : kind === "staff-hotel"
        ? await loginStaff(browser, baseURL, "hotel")
        : await loginOwner(browser, baseURL, kind);
  writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
}
