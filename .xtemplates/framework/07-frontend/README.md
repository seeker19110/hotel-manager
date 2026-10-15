---
title: Frontend
kind: index
updated: 2026-10-13
---

# 07 — Frontend

> Yêu cầu kỹ thuật cho tầng giao diện chạy trên trình duyệt/shell: chọn chế độ render theo nội dung và auth, quản lý state và
> data fetching, hiệu năng theo Core Web Vitals (p75), bảo mật phía client, form dùng chung schema với server, kiểm thử theo
> tháp, và chuỗi công cụ build tái lập. Áp cho mọi stack (React/Next, Vue/Nuxt, Svelte/SvelteKit, Angular, Astro…); phiên bản
> ghi kèm ngày xác minh 2026-10-13 — xác minh lại trước khi dùng. Thiết kế/UX ở `06-design-ux/`; backend ở `08-backend/`;
> AppSec/supply chain ở `12-security/`. Đọc theo giai đoạn: G2–G4 đọc 1 + 7 để chọn stack; G6 đọc 2–5 khi xây; G7 đọc 3 + 6.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`rendering-and-routing.md`](rendering-and-routing.md) | Bảng chọn SSG/ISR/streaming SSR/CSR theo nội dung × auth × SEO; Next 16 Cache Components; `Cache-Control: private` cho route theo người dùng; hydration; URL là state; 404/error route | G2 chọn framework; thêm route mới; khi bật cache/ISR; sự cố rò dữ liệu chéo người dùng |
| [`state-and-data-fetching.md`](state-and-data-fetching.md) | Server/client/URL/form state; TanStack Query 5 mặc định, query key factory, invalidation, optimistic rollback, retry/abort/offline, không PII trong storage | Khi viết lớp API client; mỗi mutation; review PR có `useEffect + fetch` |
| [`performance-web-vitals.md`](performance-web-vitals.md) | **Nhà của ngưỡng CWV**: LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1 ở p75; Lighthouse CI assert (+ đường thay); RUM `web-vitals`; ngân sách bundle/ảnh/font; AVIF/WebP, `fetchpriority`, `font-display` | G5 dựng cổng hiệu năng; mỗi PR thêm dependency/ảnh/font; G7–G8 theo dõi field |
| [`client-security.md`](client-security.md) | XSS sink + DOMPurify, strict CSP nonce/hash + `strict-dynamic`, Trusted Types, token không ở localStorage, `NEXT_PUBLIC_`/`VITE_` chỉ công khai, source map, SRI, clickjacking | Trước khi render HTML/Markdown/AI output; thiết lập CSP; review PR chạm env/token |
| [`forms-and-validation.md`](forms-and-validation.md) | Một schema client+server (Zod/Valibot/Standard Schema), lỗi `aria-describedby` + focus, `autocomplete`, cho dán OTP, giữ dữ liệu, autosave, upload magic bytes/tiến độ/huỷ, IME tiếng Việt | Mỗi form mới; luồng đăng ký/thanh toán/upload |
| [`frontend-testing.md`](frontend-testing.md) | Testing Library (`getByRole` trước), Vitest browser mode/Storybook test, visual regression trong container, Playwright desktop + mobile + axe, chính sách flaky, MSW dùng chung | G5 dựng bộ test; khi test flaky; trước khi thêm E2E |
| [`build-and-tooling.md`](build-and-tooling.md) | Node 24 LTS ghim, lockfile, TypeScript 7 strict, Biome/ESLint+oxlint, knip/jscpd, env schema client/server, không `ignoreBuildErrors`, source map, browserslist, một job `quality` | G5 scaffold; nâng cấp tool chain; áp khung lên dự án có sẵn |

**Prefix ID:** `FE-RENDER` · `FE-STATE` · `FE-PERF` · `FE-SEC` · `FE-FORM` · `FE-TEST` · `FE-BUILD`. Hồ sơ không có frontend
web (API, CLI, thư viện, data) không ghép mảng này; hồ sơ mobile/desktop native dùng các mục đánh dấu áp dụng cho shell/WebView
và cổng tương đương trong hồ sơ.
