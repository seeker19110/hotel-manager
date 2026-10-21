---
status: proposed — ghi nhận hiện trạng đã chạy, chờ chủ dự án xem lại
implementation-status: implemented
date: 2026-10-21
decision-makers: phiên chính (kỹ thuật); chủ dự án xem lại lúc nào cũng được (AGENTS §5)
consulted: apps/web/next.config.ts, apps/web/app/serwist/[path]/route.ts, apps/web/package.json, SPEC-pwa, AUD-DOC-002 (docs/ops/AUDIT-STATUS.md)
informed: đội phát triển
---

# ADR-0005: PWA dùng `@serwist/turbopack` (service worker phục vụ qua route handler) thay `@serwist/next`

Thay dòng "PWA" trong bảng stack của [ADR-0001](0001-modular-monolith-typescript-postgres.md) (ADR-0001 không sửa nội dung — chỉ đổi dòng trạng thái).

## Bối cảnh

ADR-0001 và SPEC-pwa ghi Serwist qua gói `@serwist/next`. Mã thực tế (từ #63) dùng `@serwist/turbopack` 9.5.13: `withSerwist` trong `apps/web/next.config.ts` và `createSerwistRoute` ở `apps/web/app/serwist/[path]/route.ts` dựng `/serwist/sw.js` bằng esbuild lúc build. Ứng dụng build bằng Turbopack của Next 16 (`next build`, `next dev` đều in "Turbopack"). Tài liệu lệch mã là phát hiện AUD-DOC-002 của audit 2026-10-19.

## Quyết định

Giữ `@serwist/turbopack` (cùng dự án Serwist, cùng phiên bản 9.5.x, giấy phép MIT theo `license-policy.json`/`pnpm licenses:check`). Cấu hình SW giữ nguyên các ràng buộc của SPEC-pwa: điều hướng `NetworkOnly` + fallback `/offline`, `/api/*` không cache, không `skipWaiting`/`clientsClaim` tự động, không phát hành sourcemap của SW, revision của `/offline` đổi theo bản build.

## Các phương án đã cân nhắc

1. **`@serwist/turbopack` (chọn):** khớp bộ build Turbopack đang dùng; SW là một route tĩnh nên CSP/proxy áp như mọi route; đã có test E2E PWA (`pwa*.spec.ts`).
2. **`@serwist/next`:** gói tích hợp theo plugin của bộ build webpack (chưa xác minh lại từ nguồn sống ở lần ghi này) — phải ép `next build --webpack`, lệch với dev/E2E đang chạy Turbopack.
3. **Bỏ Serwist, tự viết SW:** mất precache manifest có hash, tăng mã tự bảo trì.

## Điều kiện xem lại

- Serwist ngừng `@serwist/turbopack`, hoặc Next đổi bộ build mặc định khỏi Turbopack.
- E2E PWA (`apps/web/e2e/pwa*.spec.ts`) đỏ sau khi nâng Next/Serwist.

## Hệ quả

- SPEC-pwa và bảng stack đọc theo ADR này. Nâng Next/Serwist kiểm lại tương thích Turbopack trong cùng PR nâng.
- Đường lùi: đổi về `@serwist/next` + `next build --webpack` (một PR: `next.config.ts`, route `serwist`, `package.json`), E2E PWA phải xanh.
