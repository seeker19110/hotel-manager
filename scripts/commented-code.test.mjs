// T-703: rào code comment-out bỏ dở ở mã chạy (QA-STATIC-005, D-055). Cùng kiểu packages/app/src/logging/no-console.test.ts.
import { describe, expect, it } from "vitest";
import { commentedCodeIn, commentLines, looksLikeCode, scanRepo } from "./commented-code.mjs";

// Tránh chuỗi thường chứa `${…}` (biome noTemplateCurlyInString): ghép từ hai nửa.
const INTERP = "$" + "{name}";

/** Ngoại lệ có lý do — chỉ được co (ratchet). Khoá `file:dòng` không bền nên ghi theo `file` + nội dung. Hiện 0. */
const BASELINE = {};

describe("looksLikeCode — nhận ra code bị comment-out", () => {
  it.each([
    "const x = 1;",
    "let y = await foo(a, b);",
    "export const handler = async () => {",
    "await foo();",
    "return x;",
    "return;",
    "throw new Error('x');",
    "if (a && b) {",
    "} else {",
    "} else if (c) {",
    "for (const x of xs) {",
    "try {",
    "} catch (e) {",
    "case 1:",
    "import { a } from './a.js';",
    "export { a, b } from './c';",
    "function foo(a, b) {",
    "export async function bar() {",
    "class A extends B {",
    "type X = { a: number };",
    "foo(a, b);",
    "this.state.set(a);",
    "obj.method(arg)",
    "x = y + 1;",
    "count++;",
    "});",
    "}",
    "console.log(x);",
    'throw new Error("Không tìm thấy phòng");',
    'const label = "Phòng trống";',
    `await sendSms(phone, \`Xin chào ${INTERP}\`);`,
    "return 'Đã thu đủ';",
    '<Button variant="primary" onClick={save}>Lưu</Button>',
    '<Button variant="primary" onClick={save} />',
    "<Button",
    'variant="primary"',
    "</div>",
    "</>",
    "{items.map((i) => <li key={i} />)}",
  ])("%s → mã", (line) => {
    expect(looksLikeCode(line)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "Hợp đồng được tạo; sau đó mở kỳ thu;",
    "Gọi startWorker(deps) rồi chờ;",
    "returns the cached value from the store when it is fresh;",
    "return early when the lease is already closed.",
    "XLSX (ghi)",
    "-----------------------------",
    "biome-ignore lint/suspicious/noExplicitAny: lý do",
    "@ts-expect-error vì thư viện thiếu kiểu",
    "TODO: bỏ khi có API mới;",
    "https://example.test/x;",
    "Nguồn: RFC 9110 §15.5;",
    "@param x giá trị đầu vào",
    "Note that foo(bar) is idempotent",
    'Hiển thị "Phòng trống" khi không có khách;',
    "Báo lỗi `không tìm thấy` rồi dừng;",
    "<token> là mã một lần",
    "Use <b> for bold text",
    "x=1 mặc định",
  ])("%j → không phải mã", (line) => {
    expect(looksLikeCode(line)).toBe(false);
  });
});

describe("commentLines — chỉ lấy comment thật", () => {
  it("gỡ ký hiệu // và /* * */; mỗi dòng của comment khối là một mục", () => {
    const src = "/**\n * const a = 1;\n * mô tả\n */\n// return b;\nconst z = 1; // await c();";
    expect(commentLines(src).map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 2, text: "const a = 1;" },
      { line: 3, text: "mô tả" },
      { line: 5, text: "return b;" },
      { line: 6, text: "await c();" },
    ]);
  });
  it("chuỗi/template/regex trông như comment không phải comment", () => {
    const src = [
      'const a = "// const x = 1;";',
      "const b = `// await y();`;",
      "const c = /\\/\\/ return z;/;",
      "const d = 'http://x';",
    ].join("\n");
    expect(commentLines(src)).toEqual([]);
  });
  it("nguồn rỗng → không có comment", () => {
    expect(commentLines("")).toEqual([]);
  });
});

describe("commentedCodeIn", () => {
  it("báo khối code comment-out (// và /* */) kèm số dòng", () => {
    const src = [
      "export const a = 1;",
      "// const old = compute(a);",
      "// if (old) {",
      "//   send(old);",
      "// }",
      "/*",
      " * await legacy();",
      " */",
    ].join("\n");
    expect(commentedCodeIn(src).map((h) => h.line)).toEqual([2, 3, 4, 5, 7]);
  });
  it("comment tiếng Việt/giải thích/chỉ thị không bị báo; mã thật không bị báo", () => {
    const src = [
      "// Tổng tiền tính bằng đồng; không làm tròn ở đây;",
      "// biome-ignore lint/style/noNonNullAssertion: đã kiểm ở trên",
      "/** Trả về số dư (VND). */",
      "export function balance(a: number): number {",
      "  return a; // giữ nguyên",
      "}",
      'const s = "// return x;";',
    ].join("\n");
    expect(commentedCodeIn(src)).toEqual([]);
  });
  it("JSX comment-out {/* <Button … /> */} bị báo", () => {
    const src = [
      "export const A = () => (",
      "  <div>",
      '    {/* <Button variant="x" onClick={save} /> */}',
      "  </div>",
      ");",
    ].join("\n");
    expect(commentedCodeIn(src).map((h) => h.text)).toEqual(['<Button variant="x" onClick={save} />']);
  });
  it("code tiếng Việt trong chuỗi bị comment-out vẫn bị báo (// và /* */)", () => {
    const src = [
      '// throw new Error("Không tìm thấy phòng");',
      '/* const label = "Phòng trống"; */',
      `// await sendSms(phone, \`Xin chào ${INTERP}\`);`,
    ].join("\n");
    expect(commentedCodeIn(src).map((h) => h.line)).toEqual([1, 2, 3]);
  });
  it("khối @example và rào ``` trong JSDoc là tài liệu, không bị báo; hết khối thì lại kiểm", () => {
    const src = [
      "/**",
      " * Tính tiền.",
      " * @example",
      " * const x = calc(1);",
      " * await save(x);",
      " * @param a số tiền",
      " * const y = 2;",
      " */",
      "/**",
      " * ```ts",
      " * const z = 1;",
      " * ```",
      " * const w = 2;",
      " */",
      "// ```",
      "// return 1;",
      "// ```",
    ].join("\n");
    expect(commentedCodeIn(src).map((h) => h.line)).toEqual([7, 13]);
  });
  it("trạng thái @example không rò sang comment khác", () => {
    const src = ["/** @example */", "const a = 1;", "// const b = 2;"].join("\n");
    expect(commentedCodeIn(src).map((h) => h.line)).toEqual([3]);
  });
  it("mã trong chuỗi/template không bị báo; comment cuối dòng thì có", () => {
    expect(commentedCodeIn("const t = `\n// const a = 1;\n`;")).toEqual([]);
    expect(commentedCodeIn("foo(); // bar();")).toHaveLength(1);
  });
});

describe("toàn repo", () => {
  const scan = scanRepo();

  it("quét thật: phủ nhiều file mã chạy (không xanh giả)", () => {
    expect(scan.files).toBeGreaterThan(300);
  });

  it("không còn code comment-out bỏ dở ở mã chạy (trừ nền ngoại lệ có lý do)", () => {
    const fresh = scan.hits
      .filter((h) => !(`${h.file}` in BASELINE))
      .map((h) => `${h.file}:${h.line}: ${h.text}`);
    expect(fresh).toEqual([]);
  });

  it("nền ngoại lệ không nở và mỗi mục có lý do", () => {
    expect(Object.keys(BASELINE).length).toBeLessThanOrEqual(0);
    for (const why of Object.values(BASELINE)) expect(why.length).toBeGreaterThan(10);
  });
});
