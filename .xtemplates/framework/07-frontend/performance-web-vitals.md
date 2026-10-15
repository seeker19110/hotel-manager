---
title: Hiệu năng: Core Web Vitals, bundle, ảnh, font, ngân sách
kind: module
prefix: FE-PERF
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Hiệu năng: Core Web Vitals, bundle, ảnh, font, ngân sách

> "Nhà" của ngưỡng hiệu năng web trong khung: **LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1, đo ở phân vị 75 (p75) trên người
> dùng thật, tách mobile/desktop** (web.dev). Lab (Lighthouse) là cổng PR; field (RUM) là sự thật. Ngân sách bundle/ảnh/font
> là cổng máy. Test tải backend → [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md);
> phương pháp chung → [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md).

## Nguyên tắc

1. **Đo field, chặn lab.** RUM (`web-vitals`) cho p75 thật; Lighthouse CI chặn PR hồi quy. Không tối ưu theo điểm lab khi field đã tốt.
2. **Ngân sách trước, tính năng sau.** Entry JS, tổng ảnh trên fold, số font, số request bên thứ ba có trần ghi trong repo; vượt là CI đỏ.
3. **LCP = TTFB + tải tài nguyên LCP + render.** Ảnh LCP phải thấy được trong HTML đầu, `fetchpriority="high"`, không lazy;
   TTFB nhỏ nhờ cache/CDN (xem [`rendering-and-routing.md`](rendering-and-routing.md)).
4. **INP là main thread.** Chia nhỏ long task, hydrate ít, bên thứ ba sau tương tác, danh sách dài virtualize.
5. **CLS = thiếu chỗ giữ.** Ảnh/embed/quảng cáo có kích thước; font không đổi metric; không chèn nội dung trên đầu.
6. **Ít byte hơn luôn thắng**: AVIF/WebP, woff2 subset, code-split theo route, tree-shake, gỡ dependency thừa.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Cổng lab trong CI | **Lighthouse CI** (`@lhci/cli` 0.15.1 + lighthouse 13.5.0) với assert | Mọi web app | Repo lhci **không commit từ 26/06/2025** — vẫn chạy được; nếu lỗi tương thích → chạy `lighthouse` CLI trực tiếp + script assert JSON (`categories.performance.score`, `audits.largest-contentful-paint.numericValue`), hoặc `@unlighthouse/cli` 0.19.1 (MIT) cho quét nhiều trang |
| RUM | `web-vitals` 6.2.3 (Apache-2.0) + `sendBeacon` về endpoint/observability của dự án | Production | Chỉ dùng dashboard của nhà cung cấp hosting khi không xuất được dữ liệu thô |
| Ảnh | Pipeline tạo AVIF + WebP + fallback, nhiều kích thước (`sharp` 0.35.5 hoặc component ảnh của framework) | Mọi ảnh nội dung | SVG cho icon/logo; không chuyển ảnh có chữ sắc nét sang JPEG |
| Font | Self-host woff2, subset (`unicode-range` latin + vietnamese), `font-display: swap` (hoặc `optional` cho font phụ), preload font chính | Mọi dự án | Nạp từ Google Fonts runtime cho tài liệu nội bộ (rò rỉ IP, chậm) |
| Ngân sách bundle | `size-limit` 14.2.0 (MIT) theo entry + chunk route | Mọi dự án | Chỉ nhìn cảnh báo `chunkSizeWarningLimit` 500 kB của Vite (không chặn) |
| Bên thứ ba (analytics, chat, ads) | Nạp sau tương tác/idle, qua một loader có danh sách cho phép | Khi bắt buộc | Nhúng `<script>` đồng bộ trong `<head>` |

## Checklist

- [ ] `FE-PERF-001` **MUST** Core Web Vitals field đạt "tốt" ở p75: LCP ≤ 2 500 ms, INP ≤ 200 ms, CLS ≤ 0,1, tách mobile và desktop, trên trang chính. → Kiểm: dashboard RUM p75 theo 28 ngày (hoặc CrUX nếu đủ lưu lượng) cho ≥ 3 URL chính. · Nguồn: web.dev Web Vitals
- [ ] `FE-PERF-002` **MUST** Lighthouse mobile trên PR cho ≥ 3 URL chính: Performance ≥ 0,9; audit `largest-contentful-paint` ≤ 2 500 ms, `cumulative-layout-shift` ≤ 0,1, `total-blocking-time` theo ngưỡng dự án (lab proxy cho INP); 3 lần chạy, lấy median. → Kiểm: `lighthouserc` có `numberOfRuns: 3`, `aggregationMethod: median`, assert `error`; CI fail khi vi phạm. · Nguồn: Lighthouse CI configuration; Lighthouse scoring
- [ ] `FE-PERF-003` **MUST@L** RUM thu CLS/INP/LCP/FCP/TTFB bằng `web-vitals` (bản attribution ở staging) gửi qua `sendBeacon`, gắn route và loại thiết bị, không PII. → Kiểm: request beacon có mặt trong E2E production-like; payload không có email/id người dùng; dữ liệu xuất hiện trên dashboard. · Nguồn: web-vitals README
- [ ] `FE-PERF-004` **MUST** Ngân sách bundle ghi trong repo và chặn: entry JS gzip ≤ ngân sách đã chốt (đặt trong `.size-limit.json`), chunk route không vượt trần. → Kiểm: `size-limit` chạy trong CI, fail khi vượt; ngân sách ghi lý do trong `docs/PERF-BUDGET.md`.
- [ ] `FE-PERF-005` **MUST@L** Ảnh LCP (hero/sản phẩm) nằm trong HTML đầu (`<img src/srcset>`, không CSS background, không chèn bằng JS), có `fetchpriority="high"`, **không** `loading="lazy"`. → Kiểm: Lighthouse audit `lcp-lazy-loaded`, `prioritize-lcp-image` = pass; E2E kiểm thuộc tính ảnh LCP. · Nguồn: web.dev Optimize LCP
- [ ] `FE-PERF-006` **MUST@L** Mọi `<img>`/`<video>`/iframe có `width`/`height` hoặc `aspect-ratio`; không chèn banner/nội dung phía trên nội dung đã hiển thị. → Kiểm: Lighthouse `unsized-images` = 0; CLS lab ≤ 0,1; axe không liên quan. · Nguồn: web.dev Web Vitals (CLS)
- [ ] `FE-PERF-007` **MUST@L** Ảnh nội dung phục vụ ở định dạng AVIF/WebP (có fallback) với nhiều kích thước (`srcset`/`sizes`) phù hợp viewport; ảnh ngoài fold `loading="lazy"`. → Kiểm: Lighthouse insight "Improve image delivery"/`uses-responsive-images`, `offscreen-images` không cảnh báo; pipeline build tạo biến thể. · Nguồn: Lighthouse image formats
- [ ] `FE-PERF-008` **MUST@L** Font: woff2, subset theo `unicode-range` (có dải tiếng Việt), `font-display: swap|optional`, preload ≤ 2 file font chính; không FOIT (`block`). → Kiểm: grep `font-display` trong CSS ≠ `block`; Lighthouse `font-display` pass; số request font trên trang chủ ≤ ngưỡng. · Nguồn: MDN `font-display`; MDN `unicode-range`
- [ ] `FE-PERF-009` **MUST** Script bên thứ ba không chặn render: `async/defer`, nạp sau tương tác/idle; tổng kích thước bên thứ ba có ngân sách. → Kiểm: Lighthouse `third-party-summary`, `render-blocking-resources`; danh sách cho phép trong `docs/THIRD-PARTY.md`. · Nguồn: [`client-security.md`](client-security.md) (SRI/CSP cho script ngoài)
- [ ] `FE-PERF-010` **MUST@L** Code-split theo route; thư viện nặng (chart, editor, map, animation) tải lazy khi cần. → Kiểm: bundle analyzer: chunk đầu không chứa các module đó; `size-limit` theo route.
- [ ] `FE-PERF-011` **MUST@L** Hồi quy CWV field có cảnh báo (p75 vượt ngưỡng 7 ngày liên tiếp) tới kênh của đội. → Kiểm: rule cảnh báo tồn tại trong observability (xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)); diễn tập cảnh báo một lần.
- [ ] `FE-PERF-012` **SHOULD** TTFB p75 ≤ 800 ms trang chính (TTFB thường ~40% LCP): cache/CDN cho HTML công khai, không redirect chuỗi, không query cache-busting. → Kiểm: RUM TTFB p75; `curl -w '%{time_starttransfer}'` từ 2 khu vực; Lighthouse `server-response-time`. · Nguồn: web.dev Optimize LCP (TTFB subpart)
- [ ] `FE-PERF-013` **SHOULD** `preconnect` tới origin bên thứ ba cần sớm (≤ 2–3), `preload` tài nguyên LCP chỉ khi không thấy được trong HTML (CSS background). → Kiểm: Lighthouse `uses-rel-preconnect`; số `<link rel=preload>` ≤ 4 (tránh preload tràn). · Nguồn: web.dev Optimize LCP
- [ ] `FE-PERF-014` **SHOULD** Không long task > 50 ms trong luồng chính khi tương tác; hydrate chọn lọc; tính toán nặng vào Web Worker; danh sách dài virtualize. → Kiểm: DevTools Performance trace cho 3 tương tác chính; Lighthouse TBT ≤ ngưỡng; RUM INP attribution chỉ ra phần tử/script gây chậm.
- [ ] `FE-PERF-015` **SHOULD** Fallback font có `size-adjust`/metric override để swap không gây CLS. → Kiểm: CLS lab trên trang chữ nhiều ≤ 0,05; `@font-face` fallback có `size-adjust` (công cụ `fontaine` 1.0.1 hoặc `@capsizecss/core` 4.1.3 sinh). · Nguồn: MDN `font-display`
- [ ] `FE-PERF-016` **SHOULD** Dependency được tỉa định kỳ: không gói thừa, không hai thư viện cùng việc (2 bộ icon, 2 date lib). → Kiểm: `knip` 6.41.0 0 unused; bundle analyzer không có bản sao thư viện (duplicate).
- [ ] `FE-PERF-017` **SHOULD** Bộ nhớ đệm HTTP cho asset bất biến: tên file có hash + `Cache-Control: public, max-age=31536000, immutable`; HTML không cache lâu. → Kiểm: `curl -I` asset có header trên; HTML `no-cache`/`s-maxage` ngắn. · Nguồn: MDN HTTP Caching
- [ ] `FE-PERF-018` **SHOULD** Đo trên điều kiện thật: Lighthouse mobile preset (throttle 4G/CPU chậm); RUM phân đoạn theo thiết bị và kết nối. → Kiểm: `lighthouserc` không tắt throttling; dashboard có chiều `effectiveType`.
- [ ] `FE-PERF-019` **MAY** `prefers-reduced-data`/`saveData` giảm ảnh/video tự phát. → Kiểm: E2E với `Save-Data: on` tải ít byte hơn.
- [ ] `FE-PERF-020` **MAY** Speculation Rules/prefetch route kế tiếp với giới hạn trên mạng chậm. → Kiểm: có `<script type="speculationrules">` hoặc prefetch của framework; tắt khi `saveData`.
- [ ] `FE-PERF-021` **MAY** Service worker cache asset tĩnh (PWA) với chiến lược rõ (`serwist` 9.5.13). → Kiểm: audit offline tải lại được shell.

## Bẫy thường gặp

- **Tối ưu điểm Lighthouse 100 trên máy dev** (không throttle) rồi field vẫn đỏ: lab ≠ field; chạy mobile preset và nhìn RUM p75.
- **Ảnh hero `loading="lazy"`** hoặc nền CSS → LCP chậm hơn hàng trăm ms; trình quét preload không thấy.
- **Font `block` + nhiều weight** → chữ tàng hình rồi nhảy; dùng woff2 subset, 2–3 weight, `swap` + `size-adjust`.
- **Nạp thư viện UI/icon nguyên gói** (`import * as Icons`) → bundle phình; import theo tên + analyzer.
- **Bên thứ ba trong `<head>` đồng bộ** (chat, analytics, tag manager) chặn render và làm INP tệ; nạp sau idle/tương tác.
- **Hydrate toàn trang** cho nội dung tĩnh → TBT/INP cao; server component/islands/partial hydration.
- **Layout shift do banner cookie/thông báo chèn trên đầu** → CLS; đặt chỗ hoặc overlay.
- **Tin cảnh báo `chunkSizeWarningLimit`** là cổng: nó chỉ cảnh báo, không fail; dùng `size-limit`.
- **Lighthouse dao động → tắt assert**: đặt `numberOfRuns: 3` + median, hạ về `warn` tạm thời cho một audit, không tắt cả cổng.
- **RUM gửi kèm user id/email** → PII trong analytics; chỉ route + loại thiết bị.
- **Dựa vào Lighthouse CI mà không theo dõi repo**: lhci không commit từ 06/2025; có kế hoạch thay thế sẵn.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| `@lhci/cli` 0.15.1 + lighthouse 13.5.0 (Apache-2.0) | `lhci autorun` — assert `categories:performance ['error',{minScore:0.9}]`, `largest-contentful-paint ['error',{maxNumericValue:2500}]`, `cumulative-layout-shift ['error',{maxNumericValue:0.1}]`, `total-blocking-time ['warn',{maxNumericValue:<dự án>}]`; `numberOfRuns: 3`, `aggregationMethod: median` | CI PR (preview URL) | fail khi `error` |
| Đường thay (nếu lhci hỏng) | `lighthouse <url> --preset=perf --output=json --output-path=lh.json` + `node scripts/assert-lighthouse.mjs lh.json` | CI | cùng ngưỡng |
| `web-vitals` 6.2.3 (Apache-2.0) | `onLCP/onINP/onCLS` → `navigator.sendBeacon('/vitals')` | production + staging | p75 theo ngưỡng; cảnh báo 7 ngày |
| `size-limit` 14.2.0 (MIT) | `size-limit` (cấu hình theo entry + route) | CI | ≤ ngân sách trong `.size-limit.json` |
| Bundle analyzer: `@next/bundle-analyzer` 16.4.0 / `rollup-plugin-visualizer` 7.1.1 / `webpack-bundle-analyzer` 5.4.0 (MIT) | `ANALYZE=true build` | theo yêu cầu, bắt buộc khi thêm dependency > 20 kB | không duplicate, chunk đầu đúng |
| `sharp` 0.35.5 (Apache-2.0) / component ảnh framework | pipeline build sinh AVIF/WebP + kích thước | build | 100% ảnh nội dung có biến thể |
| knip 6.41.0 (ISC) | `knip` | CI | 0 dependency/export thừa |
| curl | `curl -sI <asset>` header `immutable`; `curl -w '%{time_starttransfer}'` | smoke sau deploy | đúng header; TTFB ≤ ngưỡng |

## Nguồn

- web.dev — Web Vitals (LCP ≤ 2,5 s; INP ≤ 200 ms; CLS ≤ 0,1; **p75** tách mobile/desktop; INP thay FID từ 2024; cập nhật 31/10/2024): <https://web.dev/articles/vitals> — xác minh 2026-10-13.
- web.dev — Optimize LCP (ảnh LCP thấy được trong HTML, không lazy, `fetchpriority="high"`, preload khi chỉ có trong CSS/JS; TTFB ~40% LCP; cập nhật 31/03/2025): <https://web.dev/articles/optimize-lcp> — xác minh 2026-10-13.
- Lighthouse scoring (LH10 trọng số FCP 10/SI 10/LCP 25/TBT 30/CLS 25; 90–100 xanh; biến thiên): <https://developer.chrome.com/docs/lighthouse/performance/performance-scoring>; audit định dạng ảnh (AVIF/WebP; từ Lighthouse 13 gộp vào insight "Improve image delivery"; ngưỡng 8 KiB): <https://developer.chrome.com/docs/lighthouse/performance/uses-webp-images> — xác minh 2026-10-13.
- Lighthouse CI — configuration (`assert` presets/levels, `minScore`, `maxNumericValue`, `aggregationMethod` median/optimistic/pessimistic, `numberOfRuns` mặc định 3): <https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md>; commit cuối 26/06/2025 (bump 0.15.1): <https://github.com/GoogleChrome/lighthouse-ci/commits/main> — xác minh 2026-10-13.
- `web-vitals` README (CLS/INP/LCP + FCP/TTFB; bản attribution; `sendBeacon`; Apache-2.0): <https://github.com/GoogleChrome/web-vitals> — xác minh 2026-10-13; npm `latest` 6.2.3 (README còn ví dụ `web-vitals@5`).
- MDN — `font-display` (`block` gây chữ tàng hình; `swap`/`optional`): <https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display>; `unicode-range`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range>; HTTP Caching: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching> — xác minh 2026-10-13.
- Vite build options (`build.chunkSizeWarningLimit` mặc định 500 kB **chỉ cảnh báo**; `build.target` `baseline-widely-available` mốc 2026-01-01 cho Vite 8): <https://vite.dev/config/build-options> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): @lhci/cli 0.15.1 · lighthouse 13.5.0 · web-vitals 6.2.3 · size-limit 14.2.0 · sharp 0.35.5 · @next/bundle-analyzer 16.4.0 · rollup-plugin-visualizer 7.1.1 · webpack-bundle-analyzer 5.4.0 · knip 6.41.0 · @unlighthouse/cli 0.19.1 · fontaine 1.0.1 · @capsizecss/core 4.1.3 · serwist 9.5.13.
- Catalog `seeker19110/stored` mục 13 §4b (Lighthouse CI chặn merge 4 category; repo lhci đứng yên từ 06/2025), mục 23 (Lighthouse ≥ 0,9 cùng LCP/CLS/TBT trên 5 URL), đọc 2026-10-13; khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 2.
