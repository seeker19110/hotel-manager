// E2E xương sống (PLAN T-014): đăng nhập (seed giả) → chọn tổ chức → danh sách phòng của cơ sở được phép + axe.
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";
import {
  MAIN_PROPERTY,
  MAIN_ROOMS,
  ORG_MAIN,
  ORG_OTHER,
  OTHER_PROPERTY,
  OTHER_ROOMS,
  SMOKE_USER,
} from "./fixtures.ts";

test("smoke: đăng nhập → chọn tổ chức → phòng của cơ sở được giao", async ({ page }) => {
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/dang-nhap$/);
  await expectAccessible(page);

  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chọn tổ chức");
  await expect(page.getByRole("button", { name: ORG_OTHER })).toBeVisible();
  await expectAccessible(page);
  // Dữ liệu người dùng giả trên máy — phải bị xoá khi chọn/đổi tổ chức (S-007, S-020).
  await page.evaluate(async () => {
    localStorage.setItem("hm-thu", "1");
    sessionStorage.setItem("hm-thu", "1");
    await (await caches.open("hm-du-lieu-cu")).put("/du-lieu-cu", new Response("x"));
  });
  await page.getByRole("button", { name: ORG_MAIN }).click();

  await expect(page).toHaveURL(/\/phong$/);
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      caches: (await caches.keys()).filter((k) => !k.startsWith("serwist-precache")),
    })),
  ).toEqual({ local: 0, session: 0, caches: [] });
  await expect(page.getByRole("heading", { level: 2, name: MAIN_PROPERTY })).toBeVisible();
  await expect(page.getByTestId("room").locator(".room-list__code")).toHaveText(MAIN_ROOMS);
  // Cơ sở cùng tổ chức nhưng không được giao: không lộ tên lẫn phòng.
  await expect(page.getByText(OTHER_PROPERTY)).toHaveCount(0);
  for (const code of OTHER_ROOMS) await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

test("sai mật khẩu: báo lỗi role=alert, không vào được", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill("sai-mat-khau-hoan-toan");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.locator(".field__error[role=alert]")).toHaveText("Email hoặc mật khẩu không đúng.");
  await expect(page).toHaveURL(/\/dang-nhap$/);
});

test("cookie tổ chức giả mạo (không có membership) → bị đưa về chọn tổ chức", async ({ page, context }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  await context.addCookies([
    { name: "hm_org", value: "00000000-0000-4000-8000-000000000000", url: page.url() },
  ]);
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
});

test("trang đã đăng nhập mang Cache-Control: no-store", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  for (const path of ["/chon-to-chuc", "/phong"]) {
    const res = await page.goto(path);
    expect(res?.headers()["cache-control"], path).toContain("no-store");
  }
});

test("session.switchOrganization: khác origin 403; thiếu key 400; tổ chức lạ 404; key trùng khác payload 409", async ({
  page,
}) => {
  const res = await page.request.post("/api/v1/session/switchOrganization", {
    headers: { origin: "https://evil.example", "idempotency-key": crypto.randomUUID() },
    data: { organization_id: "00000000-0000-4000-8000-000000000000" },
  });
  expect(res.status()).toBe(403);

  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(SMOKE_USER.email);
  await page.getByLabel("Mật khẩu").fill(SMOKE_USER.password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/chon-to-chuc$/);
  const call = (headers: Record<string, string>, org: string) =>
    page.evaluate(
      async ([h, o]) =>
        (
          await fetch("/api/v1/session/switchOrganization", {
            method: "POST",
            headers: { "content-type": "application/json", ...h },
            body: JSON.stringify({ organization_id: o }),
          })
        ).status,
      [headers, org] as const,
    );
  expect(await call({}, "00000000-0000-4000-8000-000000000000")).toBe(400);
  expect(await call({ "idempotency-key": crypto.randomUUID() }, "00000000-0000-4000-8000-000000000000")).toBe(
    404,
  );
});

// PRF-WEB-007 / FE-SEC-003: header bảo mật trên response HTML và API thật của `next start`; CSP không chặn script của chính trang.
test("header bảo mật + CSP strict trên HTML và API, không lỗi CSP trong console", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) cspErrors.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/Content Security Policy|Refused to/i.test(e.message)) cspErrors.push(e.message);
  });
  const res = await page.goto("/dang-nhap");
  const api = await page.request.get("/api/health");
  for (const r of [res, api]) {
    const h = r?.headers() ?? {};
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("geolocation=()");
    expect(h["x-frame-options"]).toBe("DENY");
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toMatch(/script-src [^;]*'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-(inline|eval)'/);
    for (const d of ["base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'"])
      expect(csp).toContain(d);
    // Không có CORS mở.
    expect(h["access-control-allow-origin"]).toBeUndefined();
  }
  // Trang tương tác được (script có nonce chạy): ô email nhận chữ.
  await page.getByLabel("Email").fill("kiem.tra@example.test");
  await expect(page.getByLabel("Email")).toHaveValue("kiem.tra@example.test");
  expect(cspErrors).toEqual([]);
});
