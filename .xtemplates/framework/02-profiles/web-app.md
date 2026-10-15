---
title: Ứng dụng web
kind: profile
slug: web-app
prefix: PRF-WEB
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Ứng dụng web

> Hồ sơ **mặc định** cho sản phẩm có giao diện chạy trong trình duyệt, có đăng nhập, dữ liệu người dùng và
> logic phía server. Ghép đủ frontend + backend + CSDL; cổng chất lượng là Core Web Vitals, a11y, security
> headers và E2E trên cả viewport mobile.

## Khi nào dùng

- Sản phẩm có UI trong trình duyệt **và** có trạng thái phía server (tài khoản, CRUD, thanh toán, realtime nhẹ, SEO cho trang công khai).
- Không dùng khi: chỉ nội dung tĩnh/landing/docs → [`static-site.md`](static-site.md); không có UI → [`api-service.md`](api-service.md); nhiều app/package trong một repo → [`monorepo.md`](monorepo.md); cần API thiết bị sâu (camera nền, push, offline dài) → [`mobile-app.md`](mobile-app.md).
- Hệ web + mobile dùng chung API: chọn hồ sơ chính theo nơi tạo giá trị, các thành phần khác ghép blueprint riêng (xem [`../00-method/composition.md`](../00-method/composition.md)).

## Kiến trúc tham chiếu (C4 mức 1)

```text
[Người dùng] --HTTPS--> [CDN/Edge: cache tĩnh, WAF, security headers]
                               |
                   [Web app: framework SSR/SSG/CSR + API route/server action]
                     |                |                 |
            [CSDL Postgres]   [Auth/Session]   [Hàng đợi/Job nền]
                     |                                  |
            [Object storage]                 [Dịch vụ ngoài: email, thanh toán, LLM]
  Quan sát: log có cấu trúc + error tracking (client & server) + RUM Core Web Vitals
```

- Ranh giới tin cậy: mọi thứ từ trình duyệt là **không tin cậy**; kiểm quyền và validate ở server (xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md), [`../07-frontend/forms-and-validation.md`](../07-frontend/forms-and-validation.md)).
- Chiến lược render chọn **theo nhóm route** (trang công khai SSG/ISR; trang theo người dùng SSR hoặc CSR không cache chia sẻ) — ghi ADR (xem [`../07-frontend/rendering-and-routing.md`](../07-frontend/rendering-and-routing.md)).

## Stack mặc định khuyến nghị

Phiên bản lấy từ registry/endoflife.date ngày **2026-10-13** — **xác minh lại trước khi dùng**. Né bản `x.0.0` vừa ra; ưu tiên LTS nơi có LTS.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Runtime | Node.js Active LTS | 24.21.0 (LTS từ 2025-10-28, Maintenance từ 2026-10-20, EOL 2028-04-30); Node 26.11.1 thành LTS **2026-10-28** — dự án bắt đầu sau ngày đó dùng 26 | Bun/Deno khi đội đã dùng và framework hỗ trợ chính thức (chưa xác minh phiên bản) |
| Ngôn ngữ | TypeScript `strict` | 7.0.2 (TS 7 GA 2026-07-08, bản native) | Giữ 6.x nếu tooling chưa hỗ trợ 7 — kiểm `tsc` chạy được trong CI trước khi nâng |
| Framework full-stack | Next.js App Router | 16.4.0 (dòng 15 EOL 2026-10-21) | Nuxt 4.6.1 (Vue 3.5.43) khi đội Vue; SvelteKit 3.0.1 (Svelte 5.57.2) khi cần bundle nhỏ; React Router 8.4.0 + Vite 8.3.4 khi không cần SSR tích hợp |
| UI lib | React | 19.3.0 | Vue/Svelte theo framework đã chọn |
| CSS | Tailwind CSS + design tokens | 4.3.3 | CSS Modules/vanilla khi đội không muốn utility-first; tokens xem [`../06-design-ux/design-system-and-tokens.md`](../06-design-ux/design-system-and-tokens.md) |
| Validate runtime | Zod | 4.6.7 | Valibot khi cần bundle nhỏ (chưa xác minh phiên bản) |
| Data fetching/state | TanStack Query | 5.104.2 | Server Components + cache framework khi đủ |
| CSDL | PostgreSQL (xem [`../09-database/README.md`](../09-database/README.md)) | — | SQLite (Turso/litestream) cho quy mô S |
| Unit test | Vitest | 5.0.4 | `node:test` khi muốn 0 dependency |
| E2E + a11y | Playwright + `@axe-core/playwright` | 1.64.0 + 4.13.0 | Cypress khi đội đã có (chưa xác minh phiên bản) |
| Hiệu năng CI | Lighthouse CI (`@lhci/cli`) | 0.15.1 — **cảnh báo:** repo không có commit mới từ 2025-06-26 (theo `research/2026-10-13-stored-catalog-extraction.md` §3); vẫn chạy được, theo dõi phương án thay | `lighthouse` 13.5.0 chạy trực tiếp + script assert; RUM (web-vitals) |
| Lint/format | Biome | 2.5.15 | oxlint 1.87.0 + Prettier 3.9.10; ESLint 10.12.0 khi cần plugin đặc thù (`jsx-a11y`) |
| Dead code/dup | knip | 6.41.0 | jscpd (chưa xác minh phiên bản) |
| Package manager | pnpm | 12.11.2 (npm `latest`; endoflife.date ghi 12.12.1 — lệch, dùng tag `latest`) | npm 12.2.0 |
| Error tracking | Sentry (SDK theo framework) | chưa xác minh phiên bản | GlitchTip/self-host khi ràng buộc dữ liệu |
| Hosting | Vercel/Cloudflare/Netlify (preview mỗi PR) | — | Docker + VPS/K8s khi cần kiểm soát dữ liệu (xem [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)) |

## Checklist

- [ ] `PRF-WEB-001` **MUST** Chiến lược render (SSG/ISR/SSR/CSR) được chọn **theo nhóm route** và ghi ADR; route theo người dùng không dùng cache chia sẻ. → Kiểm: `docs/adr/` có ADR render; test E2E đăng nhập 2 user khác nhau không thấy dữ liệu của nhau; header `Cache-Control` của route có auth là `private`/`no-store`.
- [ ] `PRF-WEB-002` **MUST** Build production không giấu lỗi: cấm `ignoreBuildErrors`, `ignoreDuringBuilds`, `skipLibCheck` để qua cổng; CI chạy `build` + `type-check` + `lint` trên mọi PR. → Kiểm: `grep -rE "ignoreBuildErrors|ignoreDuringBuilds" next.config.* vite.config.*` rỗng; job CI có 3 bước. · Nguồn: catalog 09 §1.4
- [ ] `PRF-WEB-003` **MUST** Biến môi trường chia hai lớp: tiền tố công khai (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) **chỉ** cho giá trị được phép lộ; env được validate khi khởi động, thiếu là fail-closed. → Kiểm: script CI grep tên biến chứa `SECRET|KEY|TOKEN|PASSWORD` có tiền tố công khai → fail; module env parse bằng schema (Zod). · Nguồn: catalog 09 §1.4; chi tiết ở [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `PRF-WEB-004` **MUST** Mọi endpoint ghi (API route, server action, form POST, webhook) kiểm xác thực + phân quyền **ở server** và chống CSRF; server action được coi là endpoint POST công khai. → Kiểm: test tích hợp gọi mỗi endpoint ghi không token → 401/403; test IDOR đổi `id` của user khác → 403. · Nguồn: ASVS 5.0 V4/V8; cơ chế ở [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md)
- [ ] `PRF-WEB-005` **MUST** Core Web Vitals ở p75 trên mobile đạt LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 cho ≥ 5 URL chính; Lighthouse CI chặn merge khi Performance < 0.9. → Kiểm: `lhci autorun` với `assertions` trong `lighthouserc.json`; job là required check. · Nguồn: web.dev/vitals; ngân sách chi tiết ở [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)
- [ ] `PRF-WEB-006` **MUST** E2E luồng chính chạy trên **cả** viewport desktop và mobile, mỗi trang kèm quét axe: 0 vi phạm mức `critical`/`serious`. → Kiểm: `playwright.config` có 2 project; `@axe-core/playwright` assert `violations.filter(v => ['critical','serious'].includes(v.impact)).length === 0`. · Nguồn: WCAG 2.2 AA; cách test ở [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md)
- [ ] `PRF-WEB-007` **MUST** Security headers bật trên mọi response HTML: CSP (không `unsafe-inline` cho `script-src`, dùng nonce/hash), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`. → Kiểm: test E2E đọc header; `curl -sI <url>` trong CI so với danh sách bắt buộc. · Nguồn: OWASP ASVS 5.0 V3; chi tiết ở [`../07-frontend/client-security.md`](../07-frontend/client-security.md)
- [ ] `PRF-WEB-008` **MUST@M** Error tracking phía client và server có **release + source map** tải lên riêng tư; source map không công khai trên production. → Kiểm: bước CI upload sourcemap; `curl -sI https://<host>/_next/static/.../*.map` trả 404/403; lỗi thử nghiệm hiện stack trace đọc được.
- [ ] `PRF-WEB-009` **MUST@M** Mỗi PR có **preview deployment** và staging có cùng tập biến môi trường/dịch vụ với production (khác giá trị, không khác hình dạng). → Kiểm: PR có URL preview tự động; script so khoá env giữa `staging` và `production` không lệch. · Nguồn: [`../10-workflow/environments-and-config.md`](../10-workflow/environments-and-config.md)
- [ ] `PRF-WEB-010` **MUST** Phiên bản runtime và package manager ghim trong repo (`.nvmrc`/`.node-version`, `engines`, `packageManager`) và CI dùng đúng phiên bản đó. → Kiểm: file tồn tại; workflow dùng `node-version-file`; `corepack`/`pnpm/action-setup` đọc `packageManager`.
- [ ] `PRF-WEB-011` **SHOULD** Trang lỗi 404/500 tùy chỉnh, mọi màn hình có 4 trạng thái (tải/rỗng/lỗi/thành công), thao tác ghi có trạng thái đang gửi và chống bấm đúp. → Kiểm: E2E chụp 404 và 500 giả lập; Storybook/visual test cho 4 trạng thái. · Nguồn: [`../06-design-ux/ui-states-and-feedback.md`](../06-design-ux/ui-states-and-feedback.md)
- [ ] `PRF-WEB-012` **SHOULD** SEO kỹ thuật cho trang công khai: `sitemap.xml`, `robots.txt`, canonical, Open Graph, metadata theo route, structured data khi có nội dung phù hợp. → Kiểm: Lighthouse SEO ≥ 0.9; `curl /sitemap.xml` và `/robots.txt` trả 200; trang riêng tư có `noindex`.
- [ ] `PRF-WEB-013` **SHOULD** Ngân sách JS initial theo route ghi trong `PROJECT.md` và kiểm bằng `size-limit` (hoặc bundle analyzer) trong CI; vượt ngân sách → đỏ. → Kiểm: `size-limit` 14.2.0 cấu hình + job CI.
- [ ] `PRF-WEB-014` **SHOULD** Luồng cốt lõi (đăng nhập, form chính) vẫn dùng được khi JS tải chậm/lỗi hoặc có fallback rõ ràng (progressive enhancement). → Kiểm: E2E chạy với `javaScriptEnabled: false` cho form chính, hoặc ghi lý do miễn.
- [ ] `PRF-WEB-015` **SHOULD** Theme dark + light bằng design tokens, tôn trọng `prefers-color-scheme`, đạt tương phản AA ở **cả hai** chế độ. → Kiểm: axe chạy 2 lần với `colorScheme: 'dark'|'light'`; không hard-code mã màu ngoài file tokens (`grep -rE "#[0-9a-fA-F]{6}" src/ --exclude=tokens.css` rỗng). · Nguồn: [`../06-design-ux/design-system-and-tokens.md`](../06-design-ux/design-system-and-tokens.md)
- [ ] `PRF-WEB-016` **SHOULD** Có RUM gửi Core Web Vitals thật từ người dùng (thư viện `web-vitals` hoặc tương đương) để đối chiếu với số lab của Lighthouse. → Kiểm: dashboard có p75 LCP/INP/CLS theo trang.
- [ ] `PRF-WEB-017` **MAY** PWA (manifest, service worker, offline shell) chỉ khi có yêu cầu cài đặt/offline; service worker có chiến lược cache và cập nhật rõ. → Kiểm: Lighthouse PWA audit; test cập nhật SW không kẹt bản cũ.
- [ ] `PRF-WEB-018` **MAY** Realtime (WebSocket/SSE) có reconnect với backoff, resume theo cursor, và fallback polling. → Kiểm: test ngắt mạng rồi nối lại không mất sự kiện. · Nguồn: [`../08-backend/realtime-and-streaming.md`](../08-backend/realtime-and-streaming.md)

## Cổng chất lượng tương đương

Cột "Cổng chung" là cổng nền của khung ([`../01-baseline/quality-gates.md`](../01-baseline/quality-gates.md)); cột sau là cách hồ sơ web chứng minh.

| Cổng chung | Cổng của web-app | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Hiệu năng | Core Web Vitals lab + field | p75 mobile: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; Lighthouse Performance ≥ 0.9 | `@lhci/cli` trong CI (required check); RUM `web-vitals` |
| A11y | WCAG 2.2 AA | axe 0 `critical`/`serious`; Lighthouse Accessibility ≥ 0.9; điều hướng bàn phím luồng chính | `@axe-core/playwright`; lint `jsx-a11y` |
| Bảo mật | ASVS L1 (L2 khi quy mô M/L) + headers | CSP không `unsafe-inline` script; HSTS; 0 lỗ hổng `high` trong SCA | ZAP baseline (CI theo lịch), `pnpm audit`, gitleaks |
| Test | Unit + integration + E2E 2 viewport | E2E luồng chính xanh desktop + mobile; coverage theo [`../14-testing-quality/coverage-and-mutation.md`](../14-testing-quality/coverage-and-mutation.md) | Vitest, Playwright (`workers: 4`, `retries: 2`, `trace: on-first-retry`) |
| Kích thước | Ngân sách JS initial/route | Dự án đặt trong `PROJECT.md`; vượt → đỏ | `size-limit`, bundle analyzer |
| Build/type/lint | Build prod + `tsc --noEmit` + lint 0 cảnh báo | 0 lỗi, 0 warning | Biome/oxlint, `tsc`, job `quality` gom làm required check |
| Phát hành | Preview mỗi PR + staging parity + rollback | Rollback ≤ 1 lệnh (redeploy bản trước) | Nền tảng hosting; [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md) |
| Vận hành | Error rate + uptime + CWV field | SLO ghi ở [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md) | Sentry + uptime check + RUM |

## Bẫy

- **Tắt kiểm tra để build xanh** (`ignoreBuildErrors`, `continue-on-error`): cổng trở thành trang trí. Hàng rào: hook `ask` khi sửa file cấu hình cổng; CI chạy lại mọi hook local (theo `research/2026-10-13-stored-catalog-extraction.md` §2.7).
- **Server action/API route quên auth** vì "chỉ gọi từ UI của mình": thực tế là POST công khai. Hàng rào: test gọi thẳng bằng `fetch` không cookie.
- **Cache CDN/ISR cho trang theo người dùng** → lộ dữ liệu chéo user. Hàng rào: test 2 user; route có auth luôn `no-store`.
- **Biến bí mật mang tiền tố công khai** bị inline vào bundle client. Hàng rào: grep tên biến trong CI (PRF-WEB-003).
- **Lighthouse chạy tay, số dao động**: không phải cổng. Hàng rào: `lhci` trong CI với `numberOfRuns ≥ 3` và lấy median; dùng RUM để biết số thật.
- **Chỉ test desktop**: luồng chính gãy ở 390 px không ai biết. Hàng rào: Playwright project mobile bắt buộc.
- **Nâng major theo trí nhớ** (Next/React/Tailwind/TS đổi cách cấu hình giữa các major): đọc ghi chú nâng cấp chính thức trước, chạy codemod chính chủ, không ghép đại phiên bản.
- **Source map public** để "debug cho tiện" → lộ mã nguồn. Hàng rào: PRF-WEB-008.

## Nguồn

- Core Web Vitals và ngưỡng p75: <https://web.dev/articles/vitals> — xác minh 2026-10-13.
- WCAG 2.2 (W3C Recommendation 2023-10-05, bản cập nhật 2024-12-12), SC 1.4.10 Reflow 320 CSS px: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- CSP quick reference (trỏ W3C CSP Level 3): <https://content-security-policy.com/> — xác minh 2026-10-13.
- Node.js lịch LTS: <https://endoflife.date/api/nodejs.json> — xác minh 2026-10-13. Next.js EOL: <https://endoflife.date/api/nextjs.json> — xác minh 2026-10-13.
- Phiên bản npm (`next`, `react`, `vue`, `nuxt`, `@sveltejs/kit`, `svelte`, `vite`, `typescript`, `tailwindcss`, `zod`, `@tanstack/react-query`, `vitest`, `@playwright/test`, `@axe-core/playwright`, `@lhci/cli`, `lighthouse`, `@biomejs/biome`, `oxlint`, `eslint`, `prettier`, `knip`, `size-limit`, `pnpm`, `npm`, `react-router`): `https://registry.npmjs.org/<pkg>/latest` — xác minh 2026-10-13.
- TypeScript 7 GA (2026-07-08): <https://devblogs.microsoft.com/typescript/> — xác minh 2026-10-13.
- OWASP ASVS 5.0: <https://owasp.org/www-project-application-security-verification-standard/> — nội dung mục V3/V4/V8 theo [`../04-standards/security-standards.md`](../04-standards/security-standards.md).
- Bài học catalog (Next.js checklist 09 §1.4, stack quality gate 13 §4b, Lighthouse CI đứng yên): `research/2026-10-13-stored-catalog-extraction.md`; khung cũ KHUNG-3 C1 (commit `1b80fe4`).
- (chưa xác minh) Phiên bản Sentry SDK, Bun/Deno, Valibot, Cypress, jscpd — không tra ngày 2026-10-13.
