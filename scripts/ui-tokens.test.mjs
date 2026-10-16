// Rào token giao diện (PLAN đợt 4 T-310, UX-DS-001/002, UX-VISUAL-006): màu chỉ khai ở `:root` của globals.css (ngoài token
// → đỏ), màu thương hiệu ở manifest/meta (`lib/brand.ts`) khớp token, không dùng ký tự emoji/ký hiệu làm icon trong JSX.
// Ngoại lệ có lý do: mã QR phải đen trên trắng tuyệt đối để máy quét đọc (components/portal/qr-code.tsx).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = "apps/web";
const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "e2e" || name === "test-results") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
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

  it("màu thương hiệu ở lib/brand.ts khớp token --c-brand / --c-bg", () => {
    const brand = readFileSync(join(WEB, "lib/brand.ts"), "utf8");
    const tok = (n) => css.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase();
    expect(brand.match(/BRAND_COLOR = "(#[0-9a-fA-F]+)"/)?.[1]?.toLowerCase()).toBe(tok("c-brand"));
    expect(brand.match(/BRAND_BG = "(#[0-9a-fA-F]+)"/)?.[1]?.toLowerCase()).toBe(tok("c-bg"));
  });

  it("mã TS/TSX của web không chép tay mã màu (ngoài lib/brand.ts và QR) và không dùng emoji làm icon", () => {
    const allowHex = new Set([join(WEB, "lib/brand.ts"), join(WEB, "components/portal/qr-code.tsx")]);
    const hex = [];
    const emoji = [];
    for (const f of walk(WEB)) {
      const src = readFileSync(f, "utf8");
      if (!allowHex.has(f) && src.match(HEX)?.some((m) => !/^#\d+$/.test(m))) hex.push(f);
      // Ký tự hình (Extended_Pictographic: ⚠ ℹ ⛔ 🔔…) ngoài comment; ✓/✕ là ký tự chữ thường, không tính.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
        .join("\n");
      if (/\p{Extended_Pictographic}/u.test(code)) emoji.push(f);
    }
    expect(hex).toEqual([]);
    expect(emoji).toEqual([]);
  });
});
