// T-702: rào test có khẳng định (QA-COV-004). Bộ phân tích + quét toàn repo. Nền ngoại lệ chỉ được co (ratchet): hiện 0.
import { describe, expect, it } from "vitest";
import {
  assertionHelpers,
  blank,
  collectDefs,
  countAssertions,
  findTests,
  helperFixpoint,
  scanRepo,
  violationsIn,
} from "./test-assertions.mjs";

/** Ngoại lệ có lý do — chỉ được XOÁ bớt, không thêm (khoá bằng test `nền ngoại lệ không nở`). Khoá `file:tên test`. */
const BASELINE = {};

// Tránh chuỗi thường chứa `${…}` (biome noTemplateCurlyInString): ghép từ hai nửa.
const D = "$" + "{";
const reasons = (src, helpers) => violationsIn(src, helpers).map((v) => v.reason);

describe("blank (lexer)", () => {
  it("xoá nội dung chuỗi, comment, template, regex nhưng giữ độ dài/dòng", () => {
    const src =
      'const a = "expect(1)"; // expect(2)\n/* expect(3) */ const r = /expect\\(/; const t = `expect(' +
      D +
      "x})`;";
    const out = blank(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toMatch(/expect\(\s*[123]\)/);
    expect(out).not.toMatch(/expect\\\(/);
  });
  it("chuỗi chứa dấu // hoặc dấu nháy khác không làm hỏng phần còn lại", () => {
    const out = blank(`const u = "http://x"; const q = 'a"b'; expect(1);`);
    expect(out).toContain("expect(1)");
  });
  it("regex có dấu nháy trong lớp ký tự không mở chuỗi giả", () => {
    expect(blank(`const r = /["']/g; expect(1);`)).toContain("expect(1)");
  });
  it("giữ mã trong phần nhúng của template", () => {
    expect(blank(`const t = \`a ${D}expect(1)} b\`;`)).toContain("expect(1)");
  });
});

describe("findTests", () => {
  it("nhận it/test, .each, .only, .skip; bỏ describe/hook/test.use/test.step", () => {
    const src = `
describe("g", () => {
  beforeEach(() => {});
  it("a", () => { expect(1).toBe(1); });
  it.each([[1]])("b %s", (x) => { expect(x).toBe(1); });
  it.only("c", () => { expect(1).toBe(1); });
  test("d", async ({ page }) => { await test.step("s", async () => { expect(1).toBe(1); }); });
  test.use({ x: 1 });
  test.describe.configure({ mode: "serial" });
  test.skip(!process.env.X, "lý do");
});`;
    expect(findTests(src).map((t) => t.line)).toEqual([4, 5, 6, 7]);
  });
  it("test.todo là vi phạm; không thân thực thi", () => {
    expect(reasons(`it.todo("x");`)).toEqual(["todo"]);
  });
  it("tên test chứa 'expect(' không được tính là khẳng định", () => {
    expect(reasons(`it("expect(1) trong tên", () => { foo(); });`)).toEqual(["no-assertion"]);
  });
  it("file không có test → rỗng", () => {
    expect(findTests("")).toEqual([]);
    expect(findTests("export const x = 1;")).toEqual([]);
  });
});

describe("countAssertions", () => {
  it("expect thật vs snapshot", () => {
    expect(countAssertions("expect(a).toBe(1); expect(b).toMatchSnapshot();")).toEqual({
      real: 1,
      snapshot: 1,
    });
    expect(countAssertions("expect(a).not.toMatchInlineSnapshot();")).toEqual({ real: 0, snapshot: 1 });
    expect(countAssertions("await expect(f()).resolves.toMatchFileSnapshot('x');")).toEqual({
      real: 0,
      snapshot: 1,
    });
    expect(countAssertions("await expect(p).rejects.toThrow();")).toEqual({ real: 1, snapshot: 0 });
  });
  it("expect.soft, expectTypeOf, assert.*, assertXxx, expectXxx (helper khai), fc.assert", () => {
    expect(countAssertions("expect.soft(a).toBe(1)").real).toBe(1);
    expect(countAssertions("expectTypeOf(a).toBeString()").real).toBe(1);
    expect(countAssertions("assert.equal(a, 1)").real).toBe(1);
    expect(countAssertions("assertBalanced(x)").real).toBe(1);
    expect(countAssertions("fc.assert(fc.property(a, f))").real).toBe(1);
    expect(countAssertions("await expectAccessible(page)", new Set(["expectAccessible"])).real).toBe(1);
    expect(countAssertions("await expectAccessible(page)").real).toBe(0);
  });
  it("thân rỗng → không khẳng định", () => {
    expect(countAssertions("")).toEqual({ real: 0, snapshot: 0 });
  });
});

describe("violationsIn", () => {
  it("test không expect → no-assertion", () => {
    expect(reasons(`it("a", () => { foo(); });`)).toEqual(["no-assertion"]);
    expect(reasons(`it("a", async () => {});`)).toEqual(["no-assertion"]);
  });
  it("test có expect → sạch", () => {
    expect(reasons(`it("a", () => { expect(foo()).toBe(1); });`)).toEqual([]);
  });
  it("snapshot là khẳng định duy nhất → snapshot-only; kèm expect thật thì sạch", () => {
    expect(reasons(`it("a", () => { expect(x).toMatchSnapshot(); });`)).toEqual(["snapshot-only"]);
    expect(reasons(`it("a", async () => { await expect(x).toMatchFileSnapshot("f"); });`)).toEqual([
      "snapshot-only",
    ]);
    expect(reasons(`it("a", () => { expect(x).toBe(1); expect(x).toMatchSnapshot(); });`)).toEqual([]);
  });
  it("it.each: khẳng định ở hàm thân (không ở bảng dữ liệu)", () => {
    expect(reasons(`it.each([[1]])("a", (x) => { foo(x); });`)).toEqual(["no-assertion"]);
    expect(reasons(`it.each([[1]])("a", (x) => { expect(x).toBe(1); });`)).toEqual([]);
    expect(reasons(`it.each([[expect(1).toBe(1)]])("a", (x) => { foo(x); });`)).toEqual(["no-assertion"]);
  });
  it("khẳng định chỉ nằm trong comment/chuỗi → vẫn vi phạm", () => {
    expect(reasons(`it("a", () => { // expect(1).toBe(1)\n foo("expect(1)"); });`)).toEqual(["no-assertion"]);
  });
  it("helper khẳng định (ca dùng được; ca không phải helper)", () => {
    const helpers = new Set(["expectAccessible"]);
    expect(reasons(`test("a", async ({ page }) => { await expectAccessible(page); });`, helpers)).toEqual([]);
    expect(reasons(`test("a", async ({ page }) => { await gotoPage(page); });`, helpers)).toEqual([
      "no-assertion",
    ]);
  });
  it("ghi đúng số dòng", () => {
    expect(violationsIn(`\n\nit("a", () => { foo(); });`)[0].line).toBe(3);
  });
});

describe("helper khẳng định", () => {
  it("collectDefs + điểm cố định: helper gọi helper", () => {
    const src = `
export async function expectOk(p) { expect(p).toBe(1); }
export const expectBoth = async (p) => { await expectOk(p); };
export const plain = (p) => p + 1;
export function noop() {}`;
    const h = helperFixpoint(collectDefs(src));
    expect([...h].sort()).toEqual(["expectBoth", "expectOk"]);
  });
  it("chỉ lấy helper ở hạ tầng test; mã sản phẩm có assert… không thành helper", () => {
    const files = {
      "packages/app/src/x.ts": "export function checkIn() { assertRoomReady(); }",
      "apps/web/e2e/h.ts": "export async function expectX() { expect(1).toBe(1); }",
      "packages/testkit/src/t.ts": "export function viaKit() { expectX(); }",
    };
    expect([...assertionHelpers(files)].sort()).toEqual(["expectX", "viaKit"]);
  });
});

describe("toàn repo", () => {
  const scan = scanRepo();

  it("quét thật: thấy nhiều file/test và các helper nền (không xanh giả)", () => {
    expect(scan.files).toBeGreaterThan(150);
    expect(scan.tests).toBeGreaterThan(1500);
    expect(scan.helpers.has("expectAccessible")).toBe(true);
  });

  it("mọi it/test có khẳng định thật; snapshot không là khẳng định duy nhất", () => {
    const fresh = scan.violations
      .filter((v) => !(`${v.file}:${v.name}` in BASELINE))
      .map((v) => `${v.file}:${v.line} ${v.reason}`);
    expect(fresh).toEqual([]);
  });

  it("nền ngoại lệ không nở và mỗi mục có lý do", () => {
    expect(Object.keys(BASELINE).length).toBeLessThanOrEqual(0);
    for (const why of Object.values(BASELINE)) expect(why.length).toBeGreaterThan(10);
  });
});
