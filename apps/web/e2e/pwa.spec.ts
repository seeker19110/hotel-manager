// SPEC-pwa (PLAN T-013): manifest, SW app shell, trang offline, không cache PII, tiếp cận.
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./a11y.ts";

/** Chờ SW kích hoạt rồi tải lại để SW điều khiển trang (không clientsClaim — S-008). */
async function withActiveSw(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state))
    .toBe("activated");
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

/** Mọi URL trong Cache Storage (đường dẫn, bỏ query revision). */
async function cachedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out.sort();
  });
}

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test("S-001 manifest hợp lệ, icon đúng kích thước, có apple-touch-icon", async ({ page, request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({
    lang: "vi",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    theme_color: expect.any(String),
    background_color: expect.any(String),
  });
  expect(m.name).toBeTruthy();
  expect(m.short_name).toBeTruthy();
  const sizes = new Set<string>();
  for (const icon of m.icons as { src: string; sizes: string; purpose?: string }[]) {
    const [w, h] = pngSize(await (await request.get(icon.src)).body());
    expect(`${w}x${h}`).toBe(icon.sizes);
    sizes.add(icon.sizes);
  }
  expect([...sizes].sort()).toEqual(["192x192", "512x512"]);
  expect(m.icons.some((i: { purpose?: string }) => i.purpose?.includes("maskable"))).toBe(true);

  await page.goto("/");
  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveAttribute("sizes", "180x180");
  const href = (await apple.getAttribute("href")) ?? "";
  expect(pngSize(await (await request.get(href)).body())).toEqual([180, 180]);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});

test("S-005 trang và API mang Cache-Control: no-store", async ({ request }) => {
  for (const path of ["/", "/offline", "/api/health"]) {
    const res = await request.get(path);
    expect(res.headers()["cache-control"], path).toContain("no-store");
  }
});

test("S-005 Cache Storage chỉ chứa asset tĩnh có hash, icon và /offline — không trang/API", async ({
  page,
}) => {
  await withActiveSw(page);
  await page.goto("/offline");
  await page.goto("/");
  await page.evaluate(() => fetch("/api/health").then((r) => r.text()));
  const paths = await cachedPaths(page);
  expect(paths).toContain("/offline");
  const bad = paths.filter(
    (p) =>
      !(
        p.startsWith("/_next/static/") ||
        p.startsWith("/icons/") ||
        p === "/offline" ||
        p === "/manifest.webmanifest"
      ),
  );
  expect(bad, "entry ngoài danh sách cho phép").toEqual([]);
});

test("S-004 mất mạng: điều hướng hiện trang offline + banner role=status, không dữ liệu cũ", async ({
  page,
  context,
}) => {
  await withActiveSw(page);
  await context.setOffline(true);
  await page.goto("/?tab=phong");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Không có kết nối mạng");
  await expect(
    page.getByText("Ứng dụng cần mạng để xem và lưu dữ liệu. Chưa có thao tác nào được gửi."),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Mất kết nối — thao tác chưa được gửi" }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("network-banner")).toHaveCount(0);
});

test("S-015 tiếp cận: axe 0 serious/critical, vùng chạm ≥ 44px ở / và /offline", async ({ page }) => {
  for (const path of ["/", "/offline"]) {
    await page.goto(path);
    await expectAccessible(page);
  }
});

test("CSP không chặn script/SW (không lỗi console)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await withActiveSw(page);
  expect(errors).toEqual([]);
});
