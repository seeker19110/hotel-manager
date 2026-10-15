---
title: Render (SSR/SSG/CSR/ISR), routing, hydration
kind: module
prefix: FE-RENDER
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Render (SSR/SSG/CSR/ISR), routing, hydration

> Chọn cách render theo **loại nội dung × có cá nhân hoá hay không × yêu cầu SEO**, không theo "framework mặc định làm gì".
> Nội dung theo người dùng **không bao giờ** nằm trong cache dùng chung; URL là trạng thái; lỗi và 404 là route có thiết kế;
> hydration không được lệch. Caching phía server → [`../08-backend/caching.md`](../08-backend/caching.md).

## Nguyên tắc

1. **Tĩnh nhất có thể, động đúng chỗ.** Phần giống nhau cho mọi người → prerender/cache; phần theo người dùng → render lúc
   request, stream sau khung tĩnh (Partial Prerendering/streaming SSR).
2. **Cache theo người dùng là lỗi bảo mật.** Response có nội dung cá nhân phải `Cache-Control: private` (hoặc `no-store`
   khi nhạy cảm); không đặt dữ liệu theo request vào hàm cache dùng chung.
3. **URL là nguồn sự thật của trạng thái điều hướng**: bộ lọc, trang, tab, mục đang mở ở query/path — chia sẻ được, back/forward đúng.
4. **Render phải tất định**: không `Date.now()`, `Math.random()`, `window` trong render server; hydration mismatch là lỗi CI.
5. **Kiểm tra quyền trên server**, trước khi render (proxy/middleware/loader); client chỉ ẩn/hiện.
6. **Chia nhỏ theo route**: mỗi route một chunk; route nặng (editor, chart) tải lazy.

## Quyết định

| Nội dung | Auth/cá nhân hoá | SEO | Chọn | Ví dụ |
|---|---|---|---|---|
| Ít đổi (docs, landing, blog) | Không | Cần | **SSG/prerender** lúc build (+ ISR/`use cache` với `cacheLife` khi đổi theo giờ) | Astro 7.3.8, Next 16 `use cache`, Nuxt `prerender`, SvelteKit `prerender` |
| Đổi thường xuyên, giống nhau cho mọi người (tin, giá, danh mục) | Không | Cần | **SSR có cache dùng chung** (CDN, `s-maxage`) hoặc ISR | Next cache components, Nuxt `routeRules` swr |
| Khung chung + mảng cá nhân (dashboard công khai + lời chào) | Một phần | Có/không | **Streaming SSR / Partial Prerendering**: khung tĩnh + `<Suspense>` cho phần đọc cookie/header | Next 16 Cache Components (`cacheComponents: true`) |
| Toàn bộ theo người dùng sau đăng nhập (app nội bộ, admin) | Có | Không | **CSR/SPA** hoặc SSR `private` không cache; auth guard ở server/proxy | Vite 8.3.4 + React Router 8.4.0 / TanStack Router; SvelteKit `ssr=false` cho route |
| Tương tác nặng (editor, canvas, game) | Có | Không | CSR, lazy chunk, Web Worker cho tính toán | Vite + framework tuỳ chọn |
| Mobile/desktop native shell | — | — | Không áp dụng SSR; điều hướng theo nền tảng (navigation stack), deep link | Expo/Flutter/SwiftUI/Compose (xem hồ sơ) |

**Framework** (xác minh npm 2026-10-13): Next.js 16.4.0 (React 19.3.0, RSC), Nuxt 4.6.1 (Vue 3.5.43), SvelteKit 3.0.1
(Svelte 5.57.2), Astro 7.3.8, Angular 22.2.2, SolidJS 1.9.17, React Router 8.4.0, TanStack Router 1.170.44. Chọn theo đội và
hệ sinh thái; ghi ADR ([`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)). Không đổi framework
cho dự án có sẵn chỉ vì "mới".

## Checklist

- [ ] `FE-RENDER-001` **MUST** Mỗi route được xếp vào một chế độ render (tĩnh / cache dùng chung / stream động / CSR) trong bảng `docs/ROUTES.md` kèm lý do. → Kiểm: file tồn tại; số route trong bảng = số route thực (script so với cây `app/`/`routes/`).
- [ ] `FE-RENDER-002` **MUST** Response chứa nội dung theo người dùng có `Cache-Control: private` (hoặc `no-store` với dữ liệu nhạy cảm) và không nằm trong cache CDN/ISR dùng chung. → Kiểm: E2E hai phiên khác nhau gọi cùng URL → nội dung khác; header `Cache-Control` khớp regex `private|no-store`; không `s-maxage` trên route có cookie phiên. · Nguồn: MDN HTTP Caching
- [ ] `FE-RENDER-003` **MUST** Không đọc cookie/header/searchParams/`Date.now()`/random bên trong hàm/component được cache dùng chung (`use cache`, ISR, `routeRules` cache). → Kiểm: lint tuỳ chỉnh hoặc review: file có `'use cache'` không import `cookies|headers`; Next dev overlay không báo `blocking-route`/`blocking-prerender-*`. · Nguồn: Next.js Caching (Cache Components)
- [ ] `FE-RENDER-004` **MUST@L** Không có hydration mismatch: console không có cảnh báo hydration trong E2E; render server tất định. → Kiểm: Playwright `page.on('console')` fail khi message khớp `/hydrat/i`; lint cấm `Date.now()|Math.random()|window\.` trong component server. · Nguồn: React 19.3 docs (hydration)
- [ ] `FE-RENDER-005` **MUST** Kiểm tra xác thực/phân quyền cho route bảo vệ thực hiện ở server (proxy/middleware/loader/action) trước khi trả dữ liệu; client guard chỉ là UX. → Kiểm: curl không cookie tới route bảo vệ → 302/401, không có dữ liệu trong body. · Nguồn: [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md)
- [ ] `FE-RENDER-006` **MUST@L** Route 404 và lỗi (error boundary cấp route + toàn cục) có giao diện thiết kế, không lộ stack trace, trả đúng mã HTTP. → Kiểm: E2E `/khong-ton-tai` → status 404 + trang 404; mock lỗi render → error boundary hiện, status 500. · Nguồn: [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)
- [ ] `FE-RENDER-007` **MUST@L** Trạng thái điều hướng (bộ lọc, trang, tab, sort) nằm trong URL; back/forward và tải lại giữ nguyên trạng thái. → Kiểm: E2E đặt bộ lọc → reload → bộ lọc còn; `goBack()` về trạng thái trước.
- [ ] `FE-RENDER-008` **MUST@L** Chia chunk theo route; route đầu không chứa code của route nặng khác. → Kiểm: bundle analyzer: chunk entry không chứa module của route editor/chart; `size-limit` cho entry (xem [`performance-web-vitals.md`](performance-web-vitals.md)).
- [ ] `FE-RENDER-009` **MUST@L** Build production không bỏ qua lỗi type/lint (`ignoreBuildErrors`, `ignoreDuringBuilds` hoặc tương đương = false). → Kiểm: grep cấu hình framework = 0 kết quả; CI chạy `build` sau `typecheck`. · Nguồn: catalog 09 §1.4
- [ ] `FE-RENDER-010` **MUST@L** Trang công khai có metadata SEO/OG đúng từng trang và được render trong HTML đầu (không chỉ sau JS); với streaming, bot nhận được `<head>` đầy đủ. → Kiểm: `curl -A Googlebot <url>` chứa `<title>` và `og:` đúng; Lighthouse SEO ≥ 0.9. · Nguồn: Next.js Streaming (Bots and crawlers)
- [ ] `FE-RENDER-011` **SHOULD** Phần đọc dữ liệu động đặt sâu trong cây (ở lá) để khung tĩnh lớn nhất; `await params/cookies` không ở layout gốc. → Kiểm: review; Next: dev overlay không báo blocking ở layout. · Nguồn: Next.js Caching ("Maximizing the static shell")
- [ ] `FE-RENDER-012` **SHOULD** Cache/ISR có cơ chế vô hiệu khi dữ liệu đổi (tag/path revalidate hoặc webhook) thay vì chỉ TTL dài. → Kiểm: test cập nhật dữ liệu → gọi revalidate → GET tiếp theo thấy dữ liệu mới. · Nguồn: [`../08-backend/caching.md`](../08-backend/caching.md)
- [ ] `FE-RENDER-013` **SHOULD** Prefetch route/dữ liệu cho liên kết trong viewport hoặc khi hover/focus, có giới hạn trên mạng chậm (`saveData`, `effectiveType`). → Kiểm: E2E thấy request prefetch khi link vào viewport; không prefetch khi `connection.saveData`.
- [ ] `FE-RENDER-014` **SHOULD** Chuyển trang giữ focus/scroll đúng: focus vào tiêu đề trang mới hoặc vùng nội dung; scroll về đầu khi route mới, giữ khi back. → Kiểm: E2E sau điều hướng SPA, `document.activeElement` nằm trong `main`; `history.scrollRestoration` xử lý. · Nguồn: [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `FE-RENDER-015` **SHOULD** Component chỉ chạy client (`'use client'`, `onMount`, `ssr: false`) giới hạn ở lá cây; server component/SSR là mặc định. → Kiểm: tỉ lệ file có `'use client'` trong `app/` được theo dõi (script), không tăng không lý do.
- [ ] `FE-RENDER-016` **SHOULD** Redirect/rewrite và trailing slash/canonical thống nhất một nơi (config framework hoặc CDN), không rải trong component. → Kiểm: grep `router.push('/old` ngoài file cấu hình redirect = 0; `curl -I` URL cũ → 301 tới canonical.
- [ ] `FE-RENDER-017` **MAY** Dùng View Transitions cho chuyển route (tắt khi reduced-motion). → Kiểm: xem [`../06-design-ux/motion-and-visual-quality.md`](../06-design-ux/motion-and-visual-quality.md).
- [ ] `FE-RENDER-018` **MAY** Edge runtime cho route nhẹ cần độ trễ thấp toàn cầu; không dùng khi cần thư viện Node hoặc kết nối DB giữ lâu. → Kiểm: ADR ghi lý do; test tích hợp chạy trên runtime đích.

## Bẫy thường gặp

- **Cache dùng chung trang có "Xin chào, Lan"** → người B thấy tên/giỏ hàng người A. Mọi route đọc cookie phải `private`/động.
- **ISR với dữ liệu theo người dùng** (ví dụ `/orders` revalidate 60 s): rò rỉ chéo. ISR chỉ cho nội dung công khai.
- **`useEffect` để fetch rồi render** trên trang SEO: bot và LCP chịu thiệt; đưa dữ liệu lên server render.
- **Hydration mismatch "đã suppress"** bằng `suppressHydrationWarning` tràn lan → che lỗi thật (thời gian, locale, theme). Chỉ dùng ở phần tử theme/thời gian có chủ đích.
- **Guard quyền bằng `if (!user) router.push('/login')` trong component**: dữ liệu đã được trả về trước khi redirect. Chặn ở server.
- **Trạng thái UI chỉ trong store** (không URL): chia sẻ link không tái tạo được, back phá luồng.
- **Một bundle cho cả app**: route landing tải cả editor. Lazy theo route + analyzer.
- **Trang 404 trả 200**: SEO và monitoring sai; trả đúng mã.
- **Streaming + bot**: bot nhận shell trống metadata; dùng cơ chế nhận diện bot của framework hoặc đảm bảo `<head>` không phụ thuộc dữ liệu động.
- **Đổi framework cho dự án brownfield** để "được RSC": chi phí lớn, lợi ích mơ hồ; ghi ADR, đo trước.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Playwright 1.64.0 (Apache-2.0) | E2E: 2 phiên cùng URL; header `Cache-Control`; console `/hydrat/i` → fail; 404/500 status; back/forward | CI E2E | xanh |
| curl + script | `curl -sI -b "" <route bảo vệ>` → 302/401; `curl -A Googlebot` chứa `<title>` | CI smoke sau deploy preview | đúng mã/nội dung |
| Grep cấu hình | `rg -n "ignoreBuildErrors|ignoreDuringBuilds" next.config.*` | pre-commit | 0 |
| Lint tuỳ chỉnh (ESLint 10.12.0 `no-restricted-syntax`) | cấm `Date.now()|Math.random()` trong file server component/`use cache` | CI | 0 |
| Bundle analyzer (`@next/bundle-analyzer` 16.4.0 / `rollup-plugin-visualizer` 7.1.1, MIT) + size-limit 14.2.0 | `size-limit` entry chunk | CI | ≤ ngân sách đã chốt |
| Lighthouse 13.5.0 (SEO/Performance) | `lhci autorun` trang công khai | CI | ≥ 0.9 |
| `docs/ROUTES.md` ↔ cây route | `node scripts/check-routes.mjs` | CI | lệch = 0 |

## Nguồn

- Next.js 16.4.0 docs — Caching (Cache Components: `use cache` + `cacheLife`; runtime APIs `cookies/headers/searchParams/params` sau `<Suspense>`; random/time cần `connection()`; Partial Prerendering; `use cache: private`; bots/crawlers): <https://nextjs.org/docs/app/getting-started/caching> — xác minh 2026-10-13 (trang ghi version 16.4.0, cập nhật 2026-10-06).
- MDN — HTTP caching (`private` cho nội dung cá nhân; cookie không tự làm response private; `no-cache, private`; tránh `Vary: Cookie`): <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching> — xác minh 2026-10-13.
- React blog — React 19.3 (09/09/2026), 19.2 (01/10/2025), bản vá RSC 19.0.1/19.1.2/19.2.1 (12/2025): <https://react.dev/blog> — xác minh 2026-10-13.
- Vite blog — Vite 8 (12/03/2026), Vite 7 (24/06/2025): <https://vite.dev/blog> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): next 16.4.0 · react 19.3.0 · vue 3.5.43 · nuxt 4.6.1 · svelte 5.57.2 · @sveltejs/kit 3.0.1 · astro 7.3.8 · @angular/core 22.2.2 · solid-js 1.9.17 · react-router 8.4.0 · @tanstack/react-router 1.170.44 · vite 8.3.4 · @next/bundle-analyzer 16.4.0 · rollup-plugin-visualizer 7.1.1 · size-limit 14.2.0 · eslint 10.12.0.
- Catalog `seeker19110/stored` mục 09 §1.4 (không `ignoreBuildErrors`; `NEXT_PUBLIC_` chỉ công khai), mục 13 §4b (stack Next 16 + React 19), đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md`.
