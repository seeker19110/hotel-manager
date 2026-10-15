---
title: Bảo mật phía client: XSS, CSP, token, storage, dependency
kind: module
prefix: FE-SEC
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Bảo mật phía client: XSS, CSP, token, storage, dependency

> Trình duyệt là môi trường thù địch: mọi thứ trong bundle là công khai, mọi DOM sink là cửa XSS. Module này là phần
> **client** của bảo mật web và là **nhà của CSP strict cho script và Trusted Types**: escape/sanitize, CSP, Trusted Types, nơi giữ
> token, SRI, clickjacking. CSRF, các header bảo mật khác, injection và lớp lỗ hổng server → [`../12-security/appsec-web.md`](../12-security/appsec-web.md);
> phân loại biến môi trường công khai/bí mật → [`../01-baseline/configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md);
> phiên/token/cookie → [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md); chuỗi cung ứng → [`../12-security/supply-chain.md`](../12-security/supply-chain.md).

## Nguyên tắc

1. **Framework escape mặc định là tuyến đầu; escape hatch là điểm review bắt buộc.** `dangerouslySetInnerHTML`, `v-html`,
   `{@html}`, `bypassSecurityTrust*`, `innerHTML` chỉ dùng với HTML đã sanitize (DOMPurify) và có lý do ghi tại chỗ.
2. **CSP strict là lưới an toàn, không phải tuyến đầu**: nonce/hash + `'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`;
   không `unsafe-inline`/`unsafe-eval` cho script; triển khai Report-Only trước.
3. **Token phiên không ở nơi JavaScript đọc được** (localStorage/sessionStorage/IndexedDB); dùng cookie `HttpOnly; Secure; SameSite`
   qua server/BFF. Nếu buộc phải giữ token ở client (SPA + API bên thứ ba), chỉ trong bộ nhớ, ngắn hạn, có refresh an toàn.
4. **Bundle là công khai.** `NEXT_PUBLIC_`/`VITE_` chỉ cho giá trị công khai; source map production không public; quét bundle như quét repo.
5. **Script ngoài = mã của người khác chạy trong trang của bạn**: ghim phiên bản + SRI + `crossorigin`, hoặc self-host.
6. **Nội dung từ AI/người dùng/bên thứ ba là dữ liệu** (P6): render qua sanitize, link hiển thị domain thật, không tự thực thi.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Render HTML giàu từ người dùng/AI/CMS | Sanitize bằng **DOMPurify 3.4.17** (MPL-2.0 OR Apache-2.0) ngay trước sink, cấu hình allowlist thẻ/thuộc tính; cập nhật thường xuyên | Markdown/WYSIWYG, output AI | Có thể tránh HTML (render Markdown → React element) thì không cần sink HTML |
| CSP cho script | **Nonce per-response + `'strict-dynamic'`** (`script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'none'`) | SSR/có server render HTML | Site tĩnh không nonce → **hash** cho inline script; CDN cache HTML làm nonce tĩnh → dùng hash hoặc không cache HTML |
| Trusted Types | Bật `require-trusted-types-for 'script'` + policy có tên khi framework hỗ trợ (Angular 22 `angular`/`angular#unsafe-bypass`; React 19.3 hỗ trợ) | App có nhiều DOM sink, đội có năng lực | Thư viện bên thứ ba chưa tương thích → chạy Report-Only đến khi xử lý xong |
| Nơi giữ token phiên | Cookie `HttpOnly; Secure; SameSite=Lax|Strict` do server/BFF đặt | Web app có backend riêng | SPA gọi thẳng IdP bên thứ ba → token trong bộ nhớ (không storage), refresh qua cookie HttpOnly nếu IdP hỗ trợ (chi tiết ở 08 authn-authz) |
| Script bên thứ ba | Self-host có ghim phiên bản; nếu từ CDN → URL ghim phiên bản + `integrity` sha384 + `crossorigin="anonymous"` | Mọi script ngoài | URL `latest`/không ghim (SRI sẽ gãy khi nội dung đổi) |
| Chống clickjacking | `Content-Security-Policy: frame-ancestors 'none'|'self'` + `X-Frame-Options: DENY` fallback | Mọi trang có phiên | Trang cố ý nhúng → liệt kê origin cụ thể trong `frame-ancestors` |

## Checklist

- [ ] `FE-SEC-001` **MUST** Không có DOM sink nhận dữ liệu chưa sanitize: mọi `dangerouslySetInnerHTML|v-html|{@html}|innerHTML=|bypassSecurityTrust|insertAdjacentHTML|document.write` đi kèm `DOMPurify.sanitize` (hoặc Trusted Types policy) và chú thích lý do. → Kiểm: lint `react/no-danger` (hoặc rule tương đương) ở mức error với `eslint-disable` có lý do; grep sink → mỗi kết quả nằm trong module `safe-html` duy nhất; test fixture XSS (`<img onerror>`, `<svg/onload>`, `javascript:`) không thực thi. · Nguồn: OWASP XSS Prevention Cheat Sheet
- [ ] `FE-SEC-002` **MUST** URL từ dữ liệu ngoài được allowlist scheme `http(s):`/`mailto:` sau khi canonicalize; không render `javascript:`/`data:` vào `href`/`src`. → Kiểm: hàm `safeUrl()` dùng chung + test; grep `href={` với biến không qua `safeUrl` = 0 (lint tuỳ chỉnh). · Nguồn: OWASP XSS Prevention; Vue Security guide
- [ ] `FE-SEC-003` **MUST** CSP cho script là strict: nonce (per-response, không do middleware gắn tự động vào mọi `<script>`) hoặc hash + `'strict-dynamic'`; `object-src 'none'`; `base-uri 'none'`; không `'unsafe-inline'`/`'unsafe-eval'` cho `script-src`; `frame-ancestors` đặt. → Kiểm: `curl -I` có header; E2E Playwright không có lỗi console `Refused to execute`; test cấu hình parse header và assert các directive. · Nguồn: OWASP CSP Cheat Sheet
- [ ] `FE-SEC-004` **MUST@L** CSP có `report-to` (và `report-uri` để tương thích) tới endpoint thu vi phạm; triển khai `Content-Security-Policy-Report-Only` ở staging ≥ 1 chu kỳ trước khi enforce. → Kiểm: endpoint nhận báo cáo có trong observability; changelog ghi ngày chuyển enforce. · Nguồn: OWASP CSP Cheat Sheet
- [ ] `FE-SEC-005` **MUST** Token phiên/refresh không lưu trong localStorage/sessionStorage/IndexedDB/cookie đọc được bằng JS. → Kiểm: E2E sau đăng nhập: `Object.keys(localStorage)` và `document.cookie` không chứa token (regex JWT `^eyJ`); cookie phiên có `HttpOnly; Secure; SameSite`. · Nguồn: OWASP HTML5 Security Cheat Sheet; [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md)
- [ ] `FE-SEC-006` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-008`](../01-baseline/configuration-and-secrets.md): chỉ biến có tiền tố công khai (`NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`/`EXPO_PUBLIC_`) vào bundle và không chứa bí mật; schema env tách client/server, quét bundle.
- [ ] `FE-SEC-007` **MUST@L** Source map production không phục vụ công khai (`productionBrowserSourceMaps: false` mặc định Next; Vite `build.sourcemap: 'hidden'` nếu cần upload cho error tracker rồi xoá khỏi artifact public). → Kiểm: `curl -I <asset>.js.map` → 404 trên production; CI upload map cho Sentry rồi `rm`. · Nguồn: Next.js `productionBrowserSourceMaps`; Vite build options
- [ ] `FE-SEC-008` **MUST@L** Script/stylesheet từ CDN bên thứ ba có URL ghim phiên bản + `integrity` (sha384/sha512) + `crossorigin="anonymous"`; ưu tiên self-host. → Kiểm: script quét HTML build: mọi `<script src="https://…">` ngoài origin có `integrity`; E2E không lỗi SRI. · Nguồn: MDN Subresource Integrity
- [ ] `FE-SEC-009` **MUST@L** Chống clickjacking: `frame-ancestors` trong CSP (+ `X-Frame-Options: DENY` fallback); trang hành động nhạy cảm không nhúng được. → Kiểm: test tải trang trong iframe origin khác → bị chặn; header có mặt. · Nguồn: OWASP Clickjacking Defense Cheat Sheet
- [ ] `FE-SEC-010` **MUST@L** Dependency frontend có lockfile, quét lỗ hổng trong CI, không `postinstall` lạ; cập nhật DOMPurify/sanitizer trong vòng SLA. → Kiểm: `npm audit --audit-level=high` (hoặc `osv-scanner`) = 0 high/critical chưa xử lý; Renovate/Dependabot bật (chi tiết ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
- [ ] `FE-SEC-011` **MUST@L** `postMessage` kiểm `event.origin` theo allowlist và `targetOrigin` cụ thể (không `*`) khi gửi dữ liệu nhạy cảm. → Kiểm: grep `postMessage(` → mỗi chỗ có `targetOrigin` ≠ `'*'`; listener kiểm `origin`; test gửi từ origin lạ bị bỏ qua. · Nguồn: OWASP HTML5 Security Cheat Sheet
- [ ] `FE-SEC-012` **MUST@L** Trusted Types bật (`require-trusted-types-for 'script'` + `trusted-types <policy>`), ít nhất ở Report-Only, với policy mặc định có tên cho sanitizer. → Kiểm: header có directive; console không `TrustedHTML` violation trên luồng chính; Angular `provideTrustedTypes`/React 19.3 cấu hình. · Nguồn: W3C Trusted Types (Editor's Draft 07/10/2026); Angular Security
- [ ] `FE-SEC-013` **SHOULD** Nội dung AI/Markdown render thành element (không qua HTML string) hoặc qua DOMPurify với allowlist hẹp; link ngoài hiện domain, `rel="noopener noreferrer"`, mở tab mới có cảnh báo khi domain lạ. → Kiểm: test fixture output độc; E2E link ngoài có domain hiển thị. · Nguồn: [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md)
- [ ] `FE-SEC-014` **SHOULD** Không gửi PII/token cho analytics, error tracker, RUM; scrub trước khi gửi (`beforeSend`). → Kiểm: test `beforeSend` loại `email|phone|token`; review payload mẫu. · Nguồn: [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md)
- [ ] `FE-SEC-015` **SHOULD** Dữ liệu nhạy cảm không vào URL (query/hash), không vào `console`, không vào `window.name`/`localStorage` log. → Kiểm: grep `console.log` ở production build = 0 (minifier `drop_console` hoặc lint); E2E URL sau luồng chính không chứa `token|otp|password`.
- [ ] `FE-SEC-016` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-WEB-007`](../12-security/appsec-web.md): chống CSRF cho request đổi trạng thái dùng cookie (`SameSite` + token hoặc kiểm `Origin`/`Sec-Fetch-Site` phía server).
- [ ] `FE-SEC-017` **SHOULD** Mobile/desktop shell (WebView/Electron/Tauri): tắt `nodeIntegration`, bật `contextIsolation`/sandbox; WebView chỉ tải origin allowlist; deep link validate. → Kiểm: cấu hình shell có các cờ; test deep link lạ bị từ chối. · Nguồn: hồ sơ desktop/mobile tương ứng
- [ ] `FE-SEC-018` **SHOULD** Header phụ trợ phía client do server đặt và kiểm: `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` tắt API không dùng, `X-Content-Type-Options: nosniff` (danh sách đầy đủ ở appsec-web). → Kiểm: test header trong CI smoke.
- [ ] `FE-SEC-019` **MAY** Quét CSP bằng công cụ đánh giá (CSP Evaluator) trong CI; ghi điểm. → Kiểm: báo cáo không "High severity".
- [ ] `FE-SEC-020` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-WEB-021`](../12-security/appsec-web.md): HTML/SVG người dùng tải lên phục vụ từ origin riêng (sandbox domain) hoặc `Content-Disposition: attachment`.

## Bẫy thường gặp

- **Nonce do middleware gắn tự động cho mọi `<script>`** → script tiêm cũng được nonce; CSP vô nghĩa. Nonce phải đi qua template engine.
- **CSP allowlist domain dài** (`script-src cdn.a.com cdn.b.com …`): bypass qua JSONP/thư viện cũ trên domain tin cậy. Strict CSP với nonce/hash.
- **Cache HTML trên CDN với nonce** → nonce tĩnh cho mọi người. Dùng hash hoặc không cache HTML có script inline.
- **JWT trong localStorage "cho tiện"**: một XSS là mất phiên của mọi người dùng; HttpOnly cookie qua BFF.
- **`NEXT_PUBLIC_API_SECRET`**: tiền tố công khai với tên gợi ý bí mật là bẫy kinh điển; schema env tách client/server.
- **Source map public để debug** → lộ toàn bộ mã nguồn, endpoint ẩn, logic phân quyền client.
- **SRI với URL `latest`** → gãy khi CDN cập nhật; hoặc bỏ SRI → supply chain. Ghim phiên bản + hash.
- **`X-Frame-Options: ALLOW-FROM`**: trình duyệt hiện đại bỏ qua → không còn bảo vệ. Dùng `frame-ancestors`.
- **Sanitize rồi lại chỉnh sửa chuỗi** (thay thế, nối) trước khi chèn → mở lại lỗ hổng. Sanitize là bước cuối trước sink.
- **Tin React 19 chặn `javascript:` là đủ**: vẫn cần allowlist scheme và canonicalize URL.
- **Markdown của AI qua `dangerouslySetInnerHTML`** không sanitize → prompt injection thành XSS.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| ESLint 10.12.0 (MIT) `react/no-danger`, `no-restricted-syntax` cho sink; Biome 2.5.15 rule `noDangerouslySetInnerHtml` | `eslint .` / `biome lint` | pre-commit + CI | 0 lỗi; disable có lý do |
| DOMPurify 3.4.17 + Vitest 5.0.4 | test fixture XSS qua `safe-html` module | CI | 0 node nguy hiểm |
| Script quét bundle (gitleaks hoặc regex) | `gitleaks detect --source dist --no-git` | CI sau build | 0 phát hiện |
| Script quét SRI | `node scripts/check-sri.mjs dist/**/*.html` | CI | mọi script ngoài có `integrity` |
| curl/Playwright header & CSP | `curl -I` + `page.on('console')` lọc `Refused to` | CI smoke (preview) | header đúng; 0 vi phạm CSP trên luồng chính |
| `npm audit`/osv-scanner; Renovate/Dependabot | `npm audit --audit-level=high` | CI + lịch | 0 high/critical mở |
| Env schema (`@t3-oss/env-nextjs` 0.13.11 hoặc zod `env.ts`) | chạy trong build | build | fail khi bí mật có tiền tố công khai |
| CSP Evaluator (Google, tool web/CLI — phiên bản npm **chưa xác minh**) | đánh giá policy | theo yêu cầu | không High |

## Nguồn

- OWASP Cheat Sheet Series — Cross Site Scripting Prevention (encode theo ngữ cảnh; escape hatch `dangerouslySetInnerHTML`, `bypassSecurityTrust*`; DOMPurify; React 19 chặn `javascript:` nhưng vẫn cần validate URL; CSP là defense in depth): <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html>; Content Security Policy (strict CSP nonce/hash + `'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors`, Report-Only, `report-to`): <https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html>; HTML5 Security (không lưu session id trong localStorage; HttpOnly; postMessage): <https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html>; Clickjacking Defense (`frame-ancestors` ưu tiên, `X-Frame-Options: DENY` fallback, `ALLOW-FROM` lỗi thời, SameSite bổ trợ): <https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html> — xác minh 2026-10-13.
- MDN — Subresource Integrity (`integrity` sha256/384/512, bắt buộc CORS `crossorigin`): <https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity> — xác minh 2026-10-13.
- W3C Trusted Types — Editor's Draft 07/10/2026 (`require-trusted-types-for`, `trusted-types`; > 60 injection sink): <https://w3c.github.io/trusted-types/dist/spec/> — xác minh 2026-10-13.
- Next.js 16.4.0 — Environment variables (`NEXT_PUBLIC_` inline vào bundle lúc build; biến khác chỉ server): <https://nextjs.org/docs/app/guides/environment-variables>; `productionBrowserSourceMaps` mặc định tắt: <https://nextjs.org/docs/app/api-reference/config/next-config-js/productionBrowserSourceMaps> — xác minh 2026-10-13.
- Vite 8.3.4 — Env and Mode (`VITE_` lộ ra client, không chứa API key): <https://vite.dev/guide/env-and-mode>; `build.sourcemap` mặc định `false`, giá trị `'hidden'`: <https://vite.dev/config/build-options> — xác minh 2026-10-13.
- Vue 3 Security (`v-html`, `:href` với `javascript:`, `:style`): <https://vuejs.org/guide/best-practices/security.html>; Angular v22 Security (sanitize theo ngữ cảnh, `bypassSecurityTrust*`, Trusted Types `angular`/`angular#unsafe-bypass`, `CSP_NONCE`/`ngCspNonce`): <https://angular.dev/best-practices/security>; Svelte `{@html}` cảnh báo XSS: <https://svelte.dev/docs/svelte/@html> — xác minh 2026-10-13.
- React 19.3 (hỗ trợ Trusted Types): <https://react.dev/blog> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): dompurify 3.4.17 (MPL-2.0 OR Apache-2.0) · @t3-oss/env-nextjs 0.13.11 · eslint 10.12.0 · @biomejs/biome 2.5.15 · vitest 5.0.4 · @sentry/browser 11.7.0. `csp-evaluator` trên npm **(chưa xác minh)**.
- Catalog `seeker19110/stored` mục 09 §2 (CSP chặt không `unsafe-inline` là BLOCKER) và §1.4 (`NEXT_PUBLIC_` chỉ công khai), đọc 2026-10-13.
