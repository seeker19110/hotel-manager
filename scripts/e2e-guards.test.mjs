// Rào E2E (PLAN đợt 6 T-506, QA-E2E-001, PRF-WEB-001): luồng chính có tag `@smoke` (≥ 3, ở ≥ 3 spec khác nhau — đăng nhập,
// thao tác lõi, thanh toán), spec dùng giả lập mạng (`page.route`/`context.route`) phải chặn service worker (SW của app có thể
// trả phản hồi trước khi route giả chặn được ⇒ flaky), và có E2E hai người dùng không thấy dữ liệu của nhau.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
