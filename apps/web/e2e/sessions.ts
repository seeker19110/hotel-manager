// Đăng nhập dùng chung cho E2E rào UX: mỗi tài khoản đăng nhập MỘT lần rồi dùng lại cookie (Better Auth giới hạn tần suất
// `/two-factor/*` và gửi OTP theo IP). Gặp giới hạn (429) thì đợi rồi thử lại, không bỏ qua rào.
import { readFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import {
  HOTEL_OWNER,
  ORG_HOTEL,
  ORG_PORTAL,
  ORG_RENTAL,
  outboxFile,
  PORTAL_TENANT,
  RENTAL_OWNER,
} from "./fixtures.ts";
import { hotelTotpFile, totp, totpFile } from "./totp.ts";

export type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
const PORT = Number(process.env.E2E_PORT ?? 3100);

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
  const file = who === "rental" ? totpFile(PORT) : hotelTotpFile(PORT);
  return withFreshPage(browser, baseURL, async (page) => {
    const { secret } = JSON.parse(readFileSync(file, "utf8")) as { secret: string };
    await page.goto("/dang-nhap");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Mật khẩu").fill(account.password);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.getByLabel("Mã xác thực 6 số").fill(totp(secret));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 10_000 });
    await page.getByRole("button", { name: org }).click();
    await expect(page).toHaveURL(/\/phong$/);
  });
}

const mailsTo = (email: string) =>
  readFileSync(outboxFile(PORT), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { to: string; text: string })
    .filter((m) => m.to === email);

/** Mã OTP của thư MỚI gửi tới `email` (thư thứ `before + 1` trở đi) — không lấy nhầm mã của lần đăng nhập trước. */
async function newOtpFor(email: string, before: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const mine = mailsTo(email);
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
    const before = mailsTo(PORTAL_TENANT.email).length;
    await page.getByRole("button", { name: "Gửi mã" }).click();
    const code = await newOtpFor(PORTAL_TENANT.email, before);
    await page.getByLabel("Mã đăng nhập 6 số").fill(code);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 10_000 });
    await page.getByRole("button", { name: new RegExp(`^${ORG_PORTAL.replace(/[()]/g, "\\$&")}`) }).click();
    await expect(page).toHaveURL(/\/portal$/);
  });
}
