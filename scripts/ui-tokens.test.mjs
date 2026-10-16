// Rào token giao diện (PLAN đợt 4 T-310, đợt 5 T-411; UX-DS-001/002, UX-VISUAL-006): mọi màu (hex, rgb()/hsl()/…, tên màu)
// chỉ khai ở `:root` của globals.css — ngoài token → đỏ; mọi đầu ra màu khác (lib/brand.ts, manifest, theme-color, icon PWA)
// SINH/đọc từ cùng token (diff sinh = 0, `node scripts/build-tokens.mjs --check`); không dùng emoji làm icon trong JSX.
// Ngoại lệ có lý do: mã QR phải đen trên trắng tuyệt đối để máy quét đọc (components/portal/qr-code.tsx).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hexToRgb, readToken, renderBrand } from "./build-tokens.mjs";

const WEB = "apps/web";
const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
// Không cờ /g: dùng với .test() theo từng dòng, lastIndex không được giữ giữa các dòng (review lát 9).
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const HEX_ALL = /#[0-9a-fA-F]{3,8}\b/g;
// Hàm màu CSS (mọi không gian màu) — chỉ được xuất hiện trong khai báo token `--…`.
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color|light-dark)\(/i;
// Tên màu CSS (CSS Color 4). `transparent`/`currentcolor`/`inherit` không phải màu cố định nên không có trong danh sách.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver " +
    "skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);
// Thuộc tính mà giá trị là tên/định danh không phải màu (font, hoạt ảnh, lưới…): bỏ qua khi tìm tên màu.
const NON_COLOR_PROPS =
  /^(?:font(?:-family)?|content|animation(?:-name)?|grid(?:-[\w-]+)?|will-change|transition-property|counter-[\w-]+|list-style(?:-type)?|quotes|src)$/;

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "e2e" || name === "test-results") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** Các khai báo `thuộc-tính: giá-trị` của CSS (đã bỏ comment) ngoài biến `--…`, kèm số dòng. */
function declarations(source) {
  const text = stripComments(source);
  const out = [];
  for (const m of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gi)) {
    const prop = m[1].toLowerCase();
    if (prop.startsWith("--")) continue;
    out.push({ line: text.slice(0, m.index).split("\n").length, prop, value: m[2] });
  }
  return out;
}

describe("token giao diện", () => {
  it("globals.css: mã màu hex chỉ nằm trong khai báo biến `--…`", () => {
    const bad = css
      .split("\n")
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => HEX.test(l) && !/^\s*--[\w-]+\s*:/.test(l));
    expect(bad).toEqual([]);
  });

  it("globals.css: hàm màu rgb()/hsl()/… chỉ nằm trong khai báo biến `--…` (scrim hộp thoại là token)", () => {
    const bad = stripComments(css)
      .split("\n")
      .map((l, i) => [i + 1, l.trim()])
      .filter(([, l]) => COLOR_FN.test(l) && !/^--[\w-]+\s*:/.test(l));
    expect(bad).toEqual([]);
    expect(css).toMatch(/::backdrop\s*\{[^}]*background:\s*var\(--c-scrim\)/);
  });

  it("globals.css: không dùng tên màu (red, white…) làm giá trị thuộc tính; chỉ var(--…), transparent, currentColor", () => {
    const bad = declarations(css)
      .filter((d) => !NON_COLOR_PROPS.test(d.prop))
      .flatMap((d) =>
        (d.value.replace(/var\([^)]*\)/g, " ").match(/[a-z]+/gi) ?? [])
          .filter((w) => NAMED.has(w.toLowerCase()))
          .map((w) => `dòng ${d.line}: ${d.prop}: ${w}`),
      );
    expect(bad).toEqual([]);
  });

  it("bộ dò bắt được ca xấu (chống rào mù)", () => {
    const sample =
      ".a { color: red; background: rgb(0 0 0 / .4); border: 1px solid WhiteSmoke; }\n:root {\n  --x: rgb(1 2 3);\n}";
    const words = declarations(sample).flatMap((d) =>
      (d.value.match(/[a-z]+/gi) ?? []).filter((w) => NAMED.has(w.toLowerCase())),
    );
    expect(words).toEqual(["red", "WhiteSmoke"]);
    expect(sample.split("\n").filter((l) => COLOR_FN.test(l) && !/^\s*--/.test(l))).toHaveLength(1);
  });

  it("màu thương hiệu ở lib/brand.ts khớp token --c-brand / --c-bg", () => {
    const brand = readFileSync(join(WEB, "lib/brand.ts"), "utf8");
    const tok = (n) => css.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase();
    expect(brand.match(/BRAND_COLOR = "(#[0-9a-fA-F]+)"/)?.[1]?.toLowerCase()).toBe(tok("c-brand"));
    expect(brand.match(/BRAND_BG = "(#[0-9a-fA-F]+)"/)?.[1]?.toLowerCase()).toBe(tok("c-bg"));
  });

  it("build:tokens — lib/brand.ts đúng bằng đầu ra sinh từ :root (diff = 0), và đổi token thì đầu ra đổi", () => {
    const brand = readFileSync(join(WEB, "lib/brand.ts"), "utf8");
    expect(brand).toBe(renderBrand(css));
    expect(renderBrand(css.replace("--c-brand: #0f4c81", "--c-brand: #123456"))).not.toBe(brand);
    expect(() => renderBrand(":root {\n}")).toThrow(/--c-brand/);
  });

  it("manifest, theme-color và icon PWA đều lấy màu từ token (không chép tay)", () => {
    const manifest = readFileSync(join(WEB, "app/manifest.ts"), "utf8");
    const layout = readFileSync(join(WEB, "app/layout.tsx"), "utf8");
    expect(manifest).toMatch(/from "\.\.\/lib\/brand\.ts"/);
    expect(manifest).toMatch(/theme_color:\s*BRAND_COLOR/);
    expect(manifest).toMatch(/background_color:\s*BRAND_BG/);
    expect(layout).toMatch(/from "\.\.\/lib\/brand\.ts"/);
    expect(layout).toMatch(/themeColor:\s*BRAND_COLOR/);
    const gen = readFileSync(join(WEB, "scripts/gen-icons.mjs"), "utf8");
    expect(gen).toMatch(/readToken\(css, "c-brand"\)/);
    // Điểm ảnh (0,0) của mỗi icon = màu --c-brand (PNG RGB 8 bit, bộ lọc 0 ở dòng đầu).
    const want = hexToRgb(readToken(css, "c-brand"));
    for (const f of ["icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"]) {
      const png = readFileSync(join(WEB, "public/icons", f));
      let off = 8;
      const idat = [];
      while (off < png.length) {
        const len = png.readUInt32BE(off);
        if (png.toString("ascii", off + 4, off + 8) === "IDAT")
          idat.push(png.subarray(off + 8, off + 8 + len));
        off += 12 + len;
      }
      const raw = inflateSync(Buffer.concat(idat));
      expect([f, [...raw.subarray(1, 4)]]).toEqual([f, want]);
    }
  });

  it("mã TS/TSX của web không chép tay mã màu (ngoài QR), không hàm màu/tên màu trong style/thuộc tính SVG, không emoji làm icon", () => {
    const allowHex = new Set([join(WEB, "lib/brand.ts"), join(WEB, "components/portal/qr-code.tsx")]);
    const hex = [];
    const fn = [];
    const named = [];
    const emoji = [];
    const namedAttr =
      /\b(?:fill|stroke|color|background|backgroundColor|borderColor|outlineColor)\s*[=:]\s*\{?\s*["'`]([a-zA-Z]+)["'`]/g;
    for (const f of walk(WEB)) {
      const src = readFileSync(f, "utf8");
      // Ký tự hình (Extended_Pictographic: ⚠ ℹ ⛔ 🔔…) ngoài comment; ✓/✕ là ký tự chữ thường, không tính.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
        .join("\n");
      if (allowHex.has(f)) continue;
      if (code.match(HEX_ALL)?.length) hex.push(f);
      if (COLOR_FN.test(code)) fn.push(f);
      for (const m of code.matchAll(namedAttr))
        if (NAMED.has(m[1].toLowerCase())) named.push(`${f}: ${m[1]}`);
      if (/\p{Extended_Pictographic}/u.test(code)) emoji.push(f);
    }
    expect(hex).toEqual([]);
    expect(fn).toEqual([]);
    expect(named).toEqual([]);
    expect(emoji).toEqual([]);
  });
});
