---
title: Site nội dung tĩnh / tài liệu / landing
kind: profile
slug: static-site
prefix: PRF-STATIC
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-13
---

# Hồ sơ: Site nội dung tĩnh / tài liệu / landing

> Site sinh ra **file tĩnh lúc build** (HTML/CSS/JS/ảnh) và phục vụ qua CDN: blog, docs, landing, marketing,
> portfolio. Không có server runtime của riêng mình (form/search/comment dùng dịch vụ ngoài hoặc edge function).
> Cổng chất lượng: build tái lập, **link không gãy**, Core Web Vitals, SEO, CSP qua header hosting.

## Khi nào dùng

- Nội dung thay đổi theo chu kỳ biên tập, không theo từng người dùng; không có đăng nhập.
- Ưu tiên tốc độ, SEO, chi phí gần 0, bề mặt tấn công nhỏ.
- Không dùng khi: có tài khoản/dữ liệu người dùng → [`web-app.md`](web-app.md); nếu chỉ một vài tính năng động (form, search) → vẫn dùng hồ sơ này + dịch vụ ngoài/edge function; tài liệu của thư viện → ghép cùng [`library-sdk.md`](library-sdk.md).

## Kiến trúc tham chiếu (C4 mức 1)

```text
[Biên tập viên] → [Nội dung: Markdown/MDX trong git  hoặc  Headless CMS → webhook]
                                  │ build (CI)
                   [Static site generator] → [dist/: HTML + asset có hash + sitemap + search index]
                                  │ deploy
[Người dùng] ─HTTPS─> [CDN/hosting tĩnh: headers (CSP/HSTS), redirects, preview mỗi PR]
                                  │ (tùy chọn)
                   [Edge function / dịch vụ ngoài: form, search, comment, analytics không cookie]
```

- Mọi "động" được đẩy ra ngoài ranh giới: form → dịch vụ có CAPTCHA/rate limit; search → index tĩnh (Pagefind) hoặc dịch vụ.
- Ảnh/font được tối ưu **lúc build** (định dạng hiện đại, kích thước đúng, `width/height` để tránh CLS).

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Generator | Astro (content collections, islands, 0 JS mặc định) | 7.3.8 (endoflife.date không có `astro`) | Next.js 16.4.0 `output: 'export'` khi đội đã dùng Next; Eleventy `@11ty/eleventy` 3.1.6 khi muốn tối giản; Hugo v0.167.0 (GitHub release 28/09, năm không hiển thị) khi site rất lớn cần build nhanh; MkDocs Material 9.7.7 cho docs Python |
| Ngôn ngữ | TypeScript 7.0.2 (nếu có script) + Markdown/MDX | — | — |
| Node CI | 24 LTS | 24.21.0 | — |
| CSS | Tailwind 4.3.3 hoặc CSS thuần với tokens | — | — |
| Search | Pagefind (index tĩnh lúc build) | v1.5.2 (GitHub release 12/04, năm không hiển thị) | Dịch vụ search ngoài khi > hàng chục nghìn trang (chưa xác minh) |
| Link check | lychee | v0.24.2 (GitHub release 01/05, năm không hiển thị) | `linkinator` (chưa xác minh phiên bản) |
| Hiệu năng/SEO/a11y CI | `@lhci/cli` 0.15.1 (cảnh báo repo ít hoạt động — xem [`web-app.md`](web-app.md)) + `@axe-core/playwright` 4.13.0 | — | `lighthouse` 13.5.0 trực tiếp |
| E2E | Playwright 1.64.0 | — | — |
| Lint/format | Biome 2.5.15; markdownlint (chưa xác minh phiên bản) | — | — |
| Hosting | Cloudflare Pages / Netlify / Vercel / GitHub Pages | `wrangler` 4.149.0 | Object storage + CDN tự quản khi ràng buộc dữ liệu |
| CMS (tùy chọn) | Git-based (Markdown trong repo) | — | Headless CMS (Decap, Sanity, Contentful — chưa xác minh phiên bản) khi có biên tập viên không dùng git |

## Checklist

- [ ] `PRF-STATIC-001` **MUST** Build tái lập từ clean checkout bằng một lệnh, output vào thư mục duy nhất; asset có hash nội dung trong tên file; lockfile commit. → Kiểm: CI `pnpm i --frozen-lockfile && pnpm build` trên runner sạch; build 2 lần cho cùng hash thư mục `dist/` (trừ sitemap có ngày).
- [ ] `PRF-STATIC-002` **MUST** 0 link gãy nội bộ và 0 anchor sai trên toàn site sau build; link ngoài kiểm theo lịch (không chặn PR vì site ngoài chập chờn). → Kiểm: `lychee --offline dist/` (hoặc `lychee 'dist/**/*.html' --exclude-all-private`) trong CI PR; job cron hằng tuần kiểm link ngoài có `--accept 200,429`.
- [ ] `PRF-STATIC-003` **MUST** Core Web Vitals p75 mobile: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; Lighthouse Performance/SEO/Accessibility/Best Practices ≥ 0.9 trên trang chủ + 4 mẫu trang. → Kiểm: `lhci autorun` assertions; job required. · Nguồn: web.dev/vitals; ngân sách ở [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)
- [ ] `PRF-STATIC-004` **MUST** SEO kỹ thuật: `sitemap.xml` sinh tự động, `robots.txt`, canonical mỗi trang, `<title>`/`meta description` duy nhất, Open Graph/Twitter card, structured data (JSON-LD) cho bài viết/sản phẩm, redirect 301 khi đổi URL. → Kiểm: test E2E đọc meta mỗi mẫu trang; `curl /sitemap.xml` 200 và chứa mọi route; file `_redirects`/`vercel.json` có test.
- [ ] `PRF-STATIC-005` **MUST** Security headers qua cấu hình hosting: CSP (không `unsafe-inline` script; islands dùng hash/nonce lúc build), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; GitHub Pages không đặt header được → dùng `<meta http-equiv="Content-Security-Policy">` và ghi giới hạn. → Kiểm: test E2E đọc header trên preview; `curl -sI` trong CI. · Nguồn: CSP Level 3; [`../07-frontend/client-security.md`](../07-frontend/client-security.md)
- [ ] `PRF-STATIC-006` **MUST** A11y: axe 0 `critical`/`serious` trên mọi mẫu trang; heading có thứ tự; ảnh có `alt`; tương phản AA; điều hướng bàn phím và skip link. → Kiểm: `@axe-core/playwright` trên tập trang mẫu; Lighthouse Accessibility ≥ 0.9. · Nguồn: WCAG 2.2 AA; [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `PRF-STATIC-007` **MUST** Ảnh và font tối ưu lúc build: định dạng hiện đại (AVIF/WebP) + `srcset`, `width`/`height` đặt sẵn, lazy-load ngoài màn hình đầu; font self-host, `font-display: swap`, preload font chính. → Kiểm: Lighthouse audit "Properly size images"/"Serve images in next-gen formats" đạt; CLS ≤ 0.1.
- [ ] `PRF-STATIC-008` **MUST** Không có bí mật trong repo hay trong `dist/`; mọi khóa (CMS, form, analytics) là loại public-safe hoặc nằm ở edge function. → Kiểm: gitleaks trên repo và `dist/`; grep `dist/` tìm chuỗi `sk_|secret|token`. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `PRF-STATIC-009` **MUST@M** Preview deployment cho mỗi PR, production chỉ deploy từ nhánh chính qua CI; rollback = redeploy bản trước. → Kiểm: PR có URL preview; log deploy từ CI.
- [ ] `PRF-STATIC-010` **SHOULD** Ngân sách trang: tổng JS ≤ ngưỡng dự án đặt trong `PROJECT.md` (Astro mặc định 0 JS; mỗi island phải có lý do); ảnh LCP ≤ ngưỡng. → Kiểm: `size-limit` 14.2.0 hoặc Lighthouse budget (`budgets` trong `lighthouserc.json`).
- [ ] `PRF-STATIC-011` **SHOULD** Analytics không cookie/không PII mặc định hoặc có consent banner đúng luật khi dùng cookie theo dõi; không nhúng script bên thứ ba không cần. → Kiểm: test E2E không có cookie bên thứ ba trước khi đồng ý; danh sách script ngoài có chủ sở hữu. · Nguồn: [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `PRF-STATIC-012` **SHOULD** Nội dung có quy trình: frontmatter bắt buộc (title, description, date, updated) được validate bằng schema lúc build (content collections/Zod); bản nháp không lên production. → Kiểm: build fail khi thiếu trường; test `draft: true` không xuất hiện trong `dist/`.
- [ ] `PRF-STATIC-013` **SHOULD** Trang 404 tùy chỉnh, trang offline (nếu PWA), và kiểm tra dạng URL ổn định (không đổi slug mà không redirect). → Kiểm: `curl /khong-ton-tai` trả 404 + trang tùy chỉnh; test redirect cũ → mới.
- [ ] `PRF-STATIC-014` **SHOULD** Search tĩnh (Pagefind) hoặc tương đương với index sinh lúc build, hoạt động không cần server. → Kiểm: E2E tìm từ khóa ra kết quả trên preview.
- [ ] `PRF-STATIC-015` **SHOULD** i18n khi có nhiều ngôn ngữ: `hreflang`, URL theo locale, `lang` trên `<html>`, ngày/số theo locale. → Kiểm: test meta `hreflang` chéo giữa các bản. · Nguồn: [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md)
- [ ] `PRF-STATIC-016` **MAY** RSS/Atom feed và `llms.txt` cho site nội dung/docs; OpenGraph image sinh tự động mỗi bài. → Kiểm: `/rss.xml` hợp lệ (validator); ảnh OG trả 200.
- [ ] `PRF-STATIC-017` **MAY** Kiểm chính tả/ngữ pháp và lint Markdown trong CI (markdownlint, cspell — chưa xác minh phiên bản). → Kiểm: job lint nội dung.

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của static-site | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals | Giữ nguyên, áp trực tiếp (dễ đạt hơn web app) | p75 mobile LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; Lighthouse 4 category ≥ 0.9 | `@lhci/cli` trên preview; RUM tùy chọn |
| axe/WCAG | Giữ nguyên trên tập trang mẫu (mỗi layout 1 trang) | 0 `critical`/`serious` | `@axe-core/playwright` |
| Test backend/integration | **Link check + build tái lập + schema nội dung** | 0 link nội bộ gãy; build 1 lệnh; frontmatter hợp lệ | lychee, CI build, content collections |
| Security headers | Headers hosting + CSP hash/nonce lúc build | Không `unsafe-inline` script; HSTS | `curl -sI` test; cấu hình `_headers`/`vercel.json`/`netlify.toml` |
| Bundle budget | Tổng JS mỗi trang + ảnh LCP | Dự án đặt; Astro mặc định 0 JS | `size-limit`, Lighthouse budgets |
| SEO | Sitemap/robots/canonical/structured data | Lighthouse SEO ≥ 0.9; sitemap đủ route | E2E meta test, sitemap test |
| Preview + rollback | Preview mỗi PR; rollback = redeploy | ≤ 1 thao tác | Hosting tĩnh |
| Vận hành | Uptime + lịch link ngoài | Uptime theo SLO dự án; link ngoài gãy xử lý trong 7 ngày (dự án đặt) | Uptime check; cron lychee |

## Bẫy

- **"Site tĩnh nên không cần bảo mật"**: script bên thứ ba (analytics, chat, form) chính là bề mặt tấn công; CSP và danh sách script có chủ là bắt buộc.
- **Link check chặn PR vì site ngoài chập chờn** → đội tắt job. Hàng rào: PR chỉ kiểm `--offline` nội bộ; link ngoài chạy cron riêng.
- **Ảnh gốc 5 MB kéo thẳng vào trang** → LCP vỡ. Hàng rào: pipeline ảnh lúc build (PRF-STATIC-007), budget.
- **Đổi slug không redirect** → mất SEO và link gãy từ ngoài. Hàng rào: test redirect + sitemap diff mỗi PR.
- **Nhúng khóa "bí mật" vào JS client** vì không có server. Hàng rào: gitleaks trên `dist/`; chỉ khóa public-safe.
- **Island/JS tích tụ** vì "thêm chút tương tác" → site tĩnh thành SPA chậm. Hàng rào: ngân sách JS + mỗi island có lý do trong PR.
- **GitHub Pages không đặt được header** → CSP/HSTS thiếu mà không ai biết. Hàng rào: ghi giới hạn trong ADR; cân nhắc hosting có header.
- **Lighthouse CI đứng yên** (không commit từ 2025-06-26 theo catalog): vẫn dùng được nhưng theo dõi; có đường thay bằng `lighthouse` + script assert.

## Nguồn

- Core Web Vitals: <https://web.dev/articles/vitals> — xác minh 2026-10-13. WCAG 2.2: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- CSP reference (trỏ W3C CSP3): <https://content-security-policy.com/> — xác minh 2026-10-13.
- Phiên bản: npm `astro` 7.3.8, `@11ty/eleventy` 3.1.6, `next` 16.4.0, `@lhci/cli` 0.15.1, `lighthouse` 13.5.0, `@axe-core/playwright` 4.13.0, `@playwright/test` 1.64.0, `size-limit` 14.2.0, `wrangler` 4.149.0, `@biomejs/biome` 2.5.15, `tailwindcss` 4.3.3; PyPI `mkdocs-material` 9.7.7; GitHub releases Hugo v0.167.0, Pagefind v1.5.2, lychee v0.24.2 (trang không hiển thị năm) — xác minh 2026-10-13.
- Lighthouse CI tình trạng bảo trì: `research/2026-10-13-stored-catalog-extraction.md` §3 (catalog 13 §4b); trang GitHub không hiển thị ngày commit khi fetch 2026-10-13.
- (chưa xác minh) `linkinator`, `markdownlint`, `cspell`, Decap/Sanity/Contentful, dịch vụ search ngoài — không tra ngày 2026-10-13.
- Khung cũ KHUNG-3 C5 (commit `1b80fe4`).
