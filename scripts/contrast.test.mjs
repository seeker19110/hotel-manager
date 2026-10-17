// T-701: rào tương phản token (UX-DS-003, UX-A11Y-002, D-054). Đọc MỌI khối token màu của globals.css và đo theo WCAG 2.x:
// chữ ≥ 4,5:1; viền/focus/thành phần UI ≥ 3:1. Theme tối thêm sau (khối `prefers-color-scheme: dark` hoặc
// `[data-theme]`) tự bị kiểm vì `themes()` quét mọi khối khai `--c-*`.
import { describe, expect, it } from "vitest";
import {
  checkContrast,
  colorTokens,
  composite,
  contrastRatio,
  EXEMPT,
  PAIRS,
  parseBlocks,
  parseColor,
  readCss,
  THRESHOLD,
  themes,
} from "./contrast.mjs";

const css = readCss();
const rgb = (hex) => parseColor(hex);

describe("công thức WCAG", () => {
  it("đen/trắng = 21:1 và đối xứng", () => {
    expect(contrastRatio(rgb("#000000"), rgb("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb("#ffffff"), rgb("#000000"))).toBeCloseTo(21, 5);
  });
  it("cùng màu = 1:1", () => {
    expect(contrastRatio(rgb("#777777"), rgb("#777777"))).toBeCloseTo(1, 5);
  });
  it("giá trị chuẩn: #767676 trên trắng ≈ 4,54:1 (ngưỡng AA kinh điển)", () => {
    expect(contrastRatio(rgb("#767676"), rgb("#ffffff"))).toBeCloseTo(4.54, 2);
  });
  it("tiền cảnh trong suốt được trộn lên nền trước khi đo", () => {
    const half = parseColor("rgb(0 0 0 / 0.5)");
    expect(composite(half, rgb("#ffffff"))).toMatchObject({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(contrastRatio(half, rgb("#ffffff"))).toBeCloseTo(contrastRatio(rgb("#808080"), rgb("#ffffff")), 1);
  });
  it("nền trong suốt → ném lỗi (không đoán)", () => {
    expect(() => contrastRatio(rgb("#000000"), parseColor("rgb(0 0 0 / 0.4)"))).toThrow(/không đặc/);
  });
});

describe("parseColor", () => {
  it.each([
    ["#fff", { r: 255, g: 255, b: 255, a: 1 }],
    ["#0F4C81", { r: 15, g: 76, b: 129, a: 1 }],
    ["#00000080", { r: 0, g: 0, b: 0, a: 128 / 255 }],
    ["rgb(1 2 3)", { r: 1, g: 2, b: 3, a: 1 }],
    ["rgba(1, 2, 3, 0.25)", { r: 1, g: 2, b: 3, a: 0.25 }],
    ["rgb(1 2 3 / 50%)", { r: 1, g: 2, b: 3, a: 0.5 }],
  ])("%s", (v, expected) => {
    expect(parseColor(v)).toEqual(expected);
  });
  it.each(["", "red", "#12", "hsl(0 0% 0%)", "var(--x)"])("không hiểu %j → ném lỗi", (v) => {
    expect(() => parseColor(v)).toThrow(/Không phân tích được/);
  });
});

describe("parseBlocks / themes", () => {
  it("bỏ comment, thấy khối con trong @media với context", () => {
    const src = `/* :root { --c-x: #000; } */ :root { --c-a: #111; } @media (prefers-color-scheme: dark) { :root { --c-a: #eee; } }`;
    const blocks = parseBlocks(src);
    expect(blocks.map((b) => [b.selector, b.context])).toEqual([
      [":root", ""],
      [":root", "@media (prefers-color-scheme: dark)"],
    ]);
    expect(colorTokens(blocks[0].body).get("a")).toBe("#111");
  });
  it("khối theme ghi đè lên base và kế thừa token còn lại", () => {
    const t = themes(
      `:root { --c-a: #111111; --c-b: #222222; } :root[data-theme="dark"] { --c-a: #eeeeee; }`,
    );
    expect(t.map((x) => x.name)).toEqual([":root", ':root[data-theme="dark"]']);
    expect(t[1].tokens.get("a")).toBe("#eeeeee");
    expect(t[1].tokens.get("b")).toBe("#222222");
  });
  it("thiếu :root → ném lỗi", () => {
    expect(() => themes(".x { --c-a: #000; }")).toThrow(/Thiếu khối :root/);
  });
  it("CSS rỗng → ném lỗi (không xanh giả)", () => {
    expect(() => themes("")).toThrow();
  });
});

describe("checkContrast (hàm kiểm)", () => {
  const pair = [{ fg: "t", bg: "b", kind: "text", use: "x" }];
  it("cặp đạt → ok", () => {
    const r = checkContrast(":root { --c-t: #000000; --c-b: #ffffff; }", pair, {});
    expect(r.errors).toEqual([]);
    expect(r.results[0].ok).toBe(true);
  });
  it("cặp chữ 4,0:1 → không đạt (ngưỡng 4,5)", () => {
    const r = checkContrast(":root { --c-t: #808080; --c-b: #ffffff; }", pair, {});
    expect(r.results[0].ratio).toBeLessThan(THRESHOLD.text);
    expect(r.results[0].ok).toBe(false);
  });
  it("cùng giá trị 3,5:1 đạt UI nhưng không đạt chữ", () => {
    const css2 = ":root { --c-t: #949494; --c-b: #ffffff; }";
    expect(checkContrast(css2, [{ ...pair[0], kind: "ui" }], {}).results[0].ok).toBe(true);
    expect(checkContrast(css2, pair, {}).results[0].ok).toBe(false);
  });
  it("khối theme tối có token kém → bị bắt ở theme đó", () => {
    const src = `:root { --c-t: #000000; --c-b: #ffffff; } @media (prefers-color-scheme: dark) { :root { --c-t: #333333; --c-b: #222222; } }`;
    const bad = checkContrast(src, pair, {}).results.filter((x) => !x.ok);
    expect(bad.map((x) => x.theme)).toEqual(["@media (prefers-color-scheme: dark) :root"]);
  });
  it("thiếu token của cặp → lỗi cấu trúc", () => {
    expect(checkContrast(":root { --c-t: #000; }", pair, {}).errors[0]).toMatch(/thiếu token --c-b/);
  });
  it("token không thuộc cặp nào và không miễn trừ → lỗi; miễn trừ thì qua", () => {
    const src = ":root { --c-t: #000; --c-b: #fff; --c-lạ: #123456; }";
    expect(checkContrast(src, pair, {}).errors.join()).toMatch(/--c-lạ không thuộc cặp nào/);
    expect(checkContrast(src, pair, { lạ: "trang trí" }).errors).toEqual([]);
  });
  it("màu không phân tích được → lỗi cấu trúc, không bỏ qua", () => {
    expect(checkContrast(":root { --c-t: red; --c-b: #fff; }", pair, {}).errors[0]).toMatch(
      /Không phân tích được/,
    );
  });
});

describe("token màu thật của globals.css", () => {
  const { results, errors } = checkContrast(css);

  it("không có lỗi cấu trúc (token đủ, mọi token thuộc cặp hoặc miễn trừ)", () => {
    expect(errors).toEqual([]);
  });

  it("có ít nhất một theme và đủ phép đo (không xanh giả)", () => {
    expect(themes(css).length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBe(PAIRS.length * themes(css).length);
  });

  it("mọi cặp chữ ≥ 4,5:1 và viền/focus/UI ≥ 3:1 ở mọi theme", () => {
    const fails = results
      .filter((r) => !r.ok)
      .map((r) => `[${r.theme}] --c-${r.fg} / --c-${r.bg} (${r.use}): ${r.ratio.toFixed(2)} < ${r.min}`);
    expect(fails).toEqual([]);
  });

  it("ngoại lệ miễn trừ đều có lý do và là token có thật", () => {
    const names = new Set(themes(css)[0].tokens.keys());
    for (const [name, why] of Object.entries(EXEMPT)) {
      expect(names.has(name), `--c-${name} không còn trong :root`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });

  it("skip-link đè thanh tiêu đề dùng vòng focus trắng (focus cam chỉ 1,88:1 trên nền thương hiệu)", () => {
    expect(css).toMatch(/\.skip-link:focus-visible\s*\{[^}]*outline-color:\s*var\(--c-brand-contrast\)/);
  });
});
