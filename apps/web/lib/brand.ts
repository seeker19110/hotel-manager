// SINH TỰ ĐỘNG bởi scripts/build-tokens.mjs từ token `:root` của app/globals.css — không sửa tay (UX-DS-001).
// Dùng ở nơi không đọc được CSS: manifest PWA (app/manifest.ts), meta theme-color (app/layout.tsx), icon (scripts/gen-icons.mjs).
// Đổi màu: sửa --c-brand / --c-bg ở globals.css rồi chạy `pnpm build:tokens`; `pnpm check:tokens` và test ui-tokens bắt lệch.
export const BRAND_COLOR = "#0f4c81";
export const BRAND_BG = "#ffffff";
