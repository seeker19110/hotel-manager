// Rào E2E (PLAN đợt 6 T-506, QA-E2E-001, PRF-WEB-001): luồng chính có tag `@smoke` (≥ 3, ở ≥ 3 spec khác nhau — đăng nhập,
// thao tác lõi, thanh toán), spec dùng giả lập mạng (`page.route`/`context.route`) phải chặn service worker (SW của app có thể
// trả phản hồi trước khi route giả chặn được ⇒ flaky), và có E2E hai người dùng không thấy dữ liệu của nhau.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepSavedSession } from "../apps/web/e2e/session-verdict.ts";

const DIR = "apps/web/e2e";
const specs = readdirSync(DIR)
  .filter((n) => n.endsWith(".spec.ts"))
  .map((n) => ({ name: n, text: readFileSync(join(DIR, n), "utf8") }));

/** Tiêu đề các test (chuỗi đầu của `test("…"`) có tag @smoke. */
const smokeTitles = (text) =>
  [...text.matchAll(/^test\(\s*["'`]([^"'`]*@smoke[^"'`]*)["'`]/gm)].map((m) => m[1]);

describe("E2E: tag @smoke cho luồng chính (QA-E2E-001)", () => {
  it("bộ đếm tag bắt đúng", () => {
    expect(smokeTitles('test("@smoke a", async () => {});\ntest("b", () => {});')).toEqual(["@smoke a"]);
    expect(smokeTitles('// test("@smoke x"\n  test("@smoke y"')).toEqual([]);
  });

  it("≥ 3 test @smoke, nằm ở ≥ 3 spec khác nhau", () => {
    const tagged = specs
      .map((s) => ({ spec: s.name, titles: smokeTitles(s.text) }))
      .filter((s) => s.titles.length > 0);
    expect(tagged.flatMap((s) => s.titles).length).toBeGreaterThanOrEqual(3);
    expect(tagged.length).toBeGreaterThanOrEqual(3);
  });
});

describe("E2E: giả lập mạng phải chặn service worker", () => {
  it.each(specs.filter((s) => /\b(?:page|context)\.route\(/.test(s.text)).map((s) => [s.name, s.text]))(
    '%s dùng route() ⇒ có test.use({ serviceWorkers: "block" })',
    (_name, text) => {
      expect(text).toMatch(/^test\.use\(\{[^}]*serviceWorkers:\s*"block"/m);
    },
  );
});

describe("E2E: cô lập giữa hai người dùng (PRF-WEB-001)", () => {
  it("isolation.spec.ts có đăng nhập hai người dùng ở hai tổ chức và kiểm Cache-Control", () => {
    const t = readFileSync(join(DIR, "isolation.spec.ts"), "utf8");
    expect(t).toMatch(/loginStaff\(browser, baseURL, "main"\)/);
    expect(t).toMatch(/loginStaff\(browser, baseURL, "hotel"\)/);
    expect(t).toMatch(/no-store\|private/);
    expect(t).toMatch(/\.not\.toContain\(/);
  });
});

// Playwright dựng worker mới sau mỗi test đỏ / `--repeat-each` / nhóm serial ⇒ bộ nhớ trong tiến trình mất. Đăng nhập OTP (người
// thuê) bị giới hạn 3 lần/phút/IP ⇒ spec KHÔNG tự gọi loginTenant (chu kỳ 4 lần lặp đỏ vì 429): phải qua `cachedSession`
// (cookie lưu tệp tạm theo cổng, server xoá khi tắt).
const directOtpLogin = (text) => [...text.matchAll(/\bloginTenant\(/g)].length;

describe("E2E: phiên đăng nhập OTP/2FA dùng lại qua cachedSession (giới hạn 3 OTP/phút)", () => {
  it("bộ dò bắt đúng lời gọi trực tiếp", () => {
    expect(directOtpLogin("await loginTenant(browser, url)")).toBe(1);
    expect(directOtpLogin("await loginTenant(b, u);loginTenant(b, u)")).toBe(2);
    expect(directOtpLogin('await cachedSession("tenant", browser, url)')).toBe(0);
    expect(directOtpLogin("")).toBe(0);
  });

  it.each(specs.map((s) => [s.name, s.text]))("%s không gọi trực tiếp loginTenant", (_n, text) => {
    expect(directOtpLogin(text)).toBe(0);
  });

  it("ux-guards.spec.ts lấy phiên qua cachedSession, không giữ bộ nhớ đệm trong tiến trình", () => {
    const t = specs.find((s) => s.name === "ux-guards.spec.ts")?.text ?? "";
    expect(t).toMatch(/cachedSession\(/);
    expect(t).not.toMatch(/sessions\[\w+\]\s*\?\?=/);
  });

  it("server dọn mọi tệp phiên khi tắt (không để phiên của CSDL đã xoá)", () => {
    const server = readFileSync(join(DIR, "server.ts"), "utf8");
    expect(server).toMatch(/for \(const kind of SESSION_KINDS\) rmSync\(sessionCacheFile\(PORT, kind\)/);
  });
});

describe("E2E: dùng lại phiên đã lưu (keepSavedSession)", () => {
  it("200 có phiên ⇒ giữ; 200 null ⇒ đăng nhập lại", () => {
    expect(keepSavedSession(200, { user: { id: "u" } })).toBe(true);
    expect(keepSavedSession(200, null)).toBe(false);
    expect(keepSavedSession(200, undefined)).toBe(false);
  });
  it("429 (giới hạn tần suất) không phải bằng chứng phiên hỏng ⇒ giữ — nếu không sẽ tự gây 429 OTP (nguyên nhân gốc)", () => {
    expect(keepSavedSession(429, undefined)).toBe(true);
  });
  it("lỗi khác (401/404/500) ⇒ đăng nhập lại", () => {
    for (const st of [401, 404, 500, 199, 302]) expect(keepSavedSession(st, undefined)).toBe(false);
  });
  it("sessions.ts quyết định qua keepSavedSession", () => {
    expect(readFileSync(join(DIR, "sessions.ts"), "utf8")).toMatch(/keepSavedSession\(res\.status\(\)/);
  });
});

// Form SSR chưa hydrate mà bấm/Enter ⇒ `onSubmit` chưa gắn, trình duyệt gửi form GET và tải lại trang, hộp xác nhận không mở
// (đỏ ~1/100 lần chạy lặp). Mỗi chỗ spec thao tác nút "Tôi đã chuyển" phải chờ `hydrated(...)` trước.
const claimButtons = (text) =>
  [...text.matchAll(/getByRole\("button", \{ name: "Tôi đã chuyển" \}\)/g)].length;
const hydratedCalls = (text) => [...text.matchAll(/\bawait hydrated\(/g)].length;

describe("E2E: chờ hydrate trước khi thao tác form (hộp xác nhận)", () => {
  it("bộ đếm bắt đúng", () => {
    expect(claimButtons('x.getByRole("button", { name: "Tôi đã chuyển" }).click()')).toBe(1);
    expect(claimButtons('getByRole("button", { name: "Quay lại" })')).toBe(0);
    expect(hydratedCalls("await hydrated(form);\n// hydrated(x)")).toBe(1);
  });

  it("ux-guards.spec.ts: số lần chờ hydrate ≥ số chỗ thao tác nút 'Tôi đã chuyển'", () => {
    const t = specs.find((s) => s.name === "ux-guards.spec.ts")?.text ?? "";
    expect(claimButtons(t)).toBeGreaterThan(0);
    expect(hydratedCalls(t)).toBeGreaterThanOrEqual(claimButtons(t));
  });

  it("hydration.ts chờ dấu hiệu hydrate của React, không dùng sleep", () => {
    const h = readFileSync(join(DIR, "hydration.ts"), "utf8");
    expect(h).toMatch(/__reactProps\$/);
    expect(h).not.toMatch(/waitForTimeout|setTimeout/);
  });
});
