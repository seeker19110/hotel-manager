// Một nguồn token → mọi đầu ra (PLAN đợt 5 T-411, UX-DS-001). Nguồn DUY NHẤT là khối `:root` của `apps/web/app/globals.css`.
// Đầu ra sinh bằng script này (không sửa tay):
//   · `apps/web/lib/brand.ts`          — màu cho manifest PWA (`app/manifest.ts`) và `<meta theme-color>` (`app/layout.tsx`)
//   · icon PWA                         — `apps/web/scripts/gen-icons.mjs` đọc màu thương hiệu bằng `readToken` ở đây
// Chạy:  node scripts/build-tokens.mjs           (ghi lại brand.ts)
//        node scripts/build-tokens.mjs --check   (thoát 1 nếu brand.ts lệch nguồn — diff sinh = 0; `pnpm check:tokens`)
// Không phụ thuộc thư viện ngoài. Test `ui-tokens.test.mjs` chạy cùng phép so sánh trong `pnpm test`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
export const CSS_FILE = fileURLToPath(new URL("apps/web/app/globals.css", ROOT));
export const BRAND_FILE = fileURLToPath(new URL("apps/web/lib/brand.ts", ROOT));

/** Giá trị token `--name` trong khối `:root` (chữ thường, không khoảng trắng thừa); thiếu → ném lỗi. */
export function readToken(css, name) {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const v = root
    .match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
    ?.trim()
    .toLowerCase();
  if (!v) throw new Error(`Thiếu token --${name} trong :root của globals.css`);
  return v;
}

/** `#rrggbb` → [r, g, b]. */
export function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (!m) throw new Error(`Không phải màu #rrggbb: ${hex}`);
  return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)];
}

/** Nội dung `lib/brand.ts` sinh từ token. */
export function renderBrand(css) {
  return `// SINH TỰ ĐỘNG bởi scripts/build-tokens.mjs từ token \`:root\` của app/globals.css — không sửa tay (UX-DS-001).
// Dùng ở nơi không đọc được CSS: manifest PWA (app/manifest.ts), meta theme-color (app/layout.tsx), icon (scripts/gen-icons.mjs).
// Đổi màu: sửa --c-brand / --c-bg ở globals.css rồi chạy \`pnpm build:tokens\`; \`pnpm check:tokens\` và test ui-tokens bắt lệch.
export const BRAND_COLOR = "${readToken(css, "c-brand")}";
export const BRAND_BG = "${readToken(css, "c-bg")}";
`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const want = renderBrand(readFileSync(CSS_FILE, "utf8"));
  if (process.argv.includes("--check")) {
    const have = readFileSync(BRAND_FILE, "utf8");
    if (have !== want) {
      console.error("apps/web/lib/brand.ts lệch token ở globals.css — chạy `pnpm build:tokens`.");
      process.exit(1);
    }
    console.log("token: đầu ra sinh khớp nguồn (diff = 0).");
  } else {
    writeFileSync(BRAND_FILE, want);
    console.log("đã sinh apps/web/lib/brand.ts từ token.");
  }
}
