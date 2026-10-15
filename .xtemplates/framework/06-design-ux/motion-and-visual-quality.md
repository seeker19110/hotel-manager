---
title: Chuyển động, hình ảnh, chống 'AI slop', kiểm bằng máy
kind: module
prefix: UX-VISUAL
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Chuyển động, hình ảnh, chống 'AI slop', kiểm bằng máy

> Chuyển động có mục đích, tôn trọng `prefers-reduced-motion`, chỉ animate thuộc tính rẻ; hình ảnh/icon/minh hoạ nhất quán
> một hệ; giao diện có "gu" được giữ bằng **cổng máy** (Lighthouse 4 category, contrast, kiểm hai theme ở zoom lớn, luật
> chống "AI slop" grep được) chứ không bằng cảm tính. Token duration/easing → [`design-system-and-tokens.md`](design-system-and-tokens.md).

## Nguyên tắc

1. **Chuyển động phải trả lời "để làm gì"**: định hướng (đâu rồi), phản hồi (đã nhận), liên tục (từ đâu tới đâu). Trang trí thuần
   là ứng viên đầu tiên để xoá.
2. **Người dùng tắt được**: `prefers-reduced-motion: reduce` → thay dịch chuyển/zoom/parallax bằng fade hoặc bỏ; không bao giờ
   nhấp nháy > 3 lần/giây.
3. **Chỉ animate `transform` và `opacity`** (compositor); không animate `top/left/width/height/box-shadow` gây layout/paint.
4. **Thời lượng và easing là token** (ngắn/vừa/dài), không số lẻ trong component.
5. **"Xoá trước khi thêm"**: mật độ vừa phải, một màu nhấn, một bộ icon, một phong cách minh hoạ. Giao diện "AI slop" nhận
   diện được bằng danh sách trope cụ thể và bị chặn khi review.
6. **Gu chỉ bền khi có cổng máy**: Lighthouse 4 category, contrast, visual regression, kiểm hai theme ở zoom 4×.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Kỹ thuật chuyển động web | CSS transition/animation + View Transitions API (React 19.3 có `<ViewTransition>`) | Phần lớn UI | JS animation library (motion 14.1.0, MIT) chỉ khi cần gesture/spring/layout animation phức tạp |
| Chuyển trang | View transition ngắn, fade/slide nhẹ; tắt khi reduced-motion | SPA/App Router | Trang tĩnh nội dung → không cần |
| Hiệu ứng tải | Skeleton tĩnh + shimmer nhẹ (tắt khi reduced-motion) | Danh sách | Spinner toàn trang |
| Bộ icon | Một thư viện (vd Lucide/Tabler, license MIT/OFL) cùng stroke/size | Mọi dự án | Trộn nhiều bộ, emoji làm icon |
| Minh hoạ/ảnh | Một phong cách; ảnh thật có nguồn/quyền; không stock "doanh nhân bắt tay" | Marketing/empty state | Ảnh AI không nhãn (xem [`ai-ux.md`](ai-ux.md)) |
| Visual regression | Playwright `toHaveScreenshot` (WebP, chạy trong container cố định) | Có E2E | Chromatic (SaaS, có phí) khi đội cần review UI cộng tác; OSS tự host nếu nhạy cảm |

## Luật chống "AI slop" (grep được)

| Trope | Dấu hiệu máy bắt | Thay bằng |
|---|---|---|
| Gradient tím/hồng mesh làm nền hero | `linear-gradient|radial-gradient` chứa màu ngoài token | Nền surface token, một màu nhấn |
| Hero căn giữa + 3 card giống hệt + CTA to | ≥ 3 card cùng class trong section đầu, `text-align:center` toàn section | Bố cục bất đối xứng có nội dung thật |
| Font Inter + ảnh stock + icon lẫn bộ | `font-family` ngoài token; ảnh không trong `assets/` có nguồn | Token typography, ảnh có quyền |
| Mọi thứ đều có bóng + bo góc lớn + glassmorphism | `backdrop-filter: blur` > N chỗ; `box-shadow` ngoài token | Elevation token 3–4 bậc |
| Animation "wow" khi scroll cho mọi khối | `IntersectionObserver` + class `animate-*` trên > 30% khối | Chuyển động chỉ ở nơi có nghĩa |
| Emoji làm icon/bullet | regex emoji trong JSX/markup UI | Bộ icon SVG có `aria-hidden` |

## Checklist

- [ ] `UX-VISUAL-001` **MUST** Mọi animation dịch chuyển/zoom/parallax/auto-play được giảm hoặc thay bằng fade khi `prefers-reduced-motion: reduce`. → Kiểm: Playwright `emulateMedia({ reducedMotion: 'reduce' })` → không phần tử nào có `transform` animation đang chạy (`getAnimations()` lọc transform = 0); CSS có khối `@media (prefers-reduced-motion: reduce)`. · Nguồn: MDN `prefers-reduced-motion`; WCAG 2.2 SC 2.3.3
- [ ] `UX-VISUAL-002` **MUST** Không nội dung nhấp nháy quá 3 lần/giây; chuyển động tự động > 5 s có nút dừng. → Kiểm: review animation `infinite`; carousel/video nền có nút Pause (E2E). · Nguồn: WCAG 2.2 SC 2.3.1, 2.2.2
- [ ] `UX-VISUAL-003` **MUST@L** Chỉ animate `transform`/`opacity` (và `filter` có cân nhắc); không `transition: all`; không animate thuộc tính layout. → Kiểm: stylelint `declaration-property-value-disallowed-list` cho `transition: all`; rule cấm `animation`/`transition` trên `top|left|width|height|margin`. · Nguồn: web.dev Animations guide
- [ ] `UX-VISUAL-004` **MUST@L** Thời lượng/easing lấy từ token (`--motion-duration-*`, `--motion-ease-*`); không số lẻ. → Kiểm: grep `transition.*\d+ms` ngoài file token = 0.
- [ ] `UX-VISUAL-005` **MUST@L** Lighthouse mobile đạt ≥ 0.9 ở cả 4 category (Performance, Accessibility, Best Practices, SEO cho trang công khai) trên ≥ 3 URL đại diện. → Kiểm: `lhci assert` `categories:* minScore 0.9`, `numberOfRuns: 3`. · Nguồn: Lighthouse scoring (90–100 = xanh); catalog 06 §4
- [ ] `UX-VISUAL-006` **MUST** Ảnh/icon trang trí có `alt=""`/`aria-hidden`; icon có nghĩa có tên tiếp cận; không emoji làm icon. → Kiểm: axe `image-alt`, `svg-img-alt`; script regex emoji trong JSX/template UI = 0. · Nguồn: WCAG 2.2 SC 1.1.1
- [ ] `UX-VISUAL-007` **MUST** Mọi ảnh/minh hoạ có quyền sử dụng ghi trong `assets/CREDITS.md` (nguồn, license); ảnh AI tạo gắn nhãn. → Kiểm: script so khớp file trong `public/images` với dòng trong CREDITS = 100%. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)
- [ ] `UX-VISUAL-008` **MUST@L** Visual regression cho component dùng chung và 3–5 trang chính ở cả hai theme, viewport mobile + desktop; diff phải được duyệt. → Kiểm: `toHaveScreenshot` với `maxDiffPixelRatio` cấu hình; CI fail khi lệch chưa cập nhật baseline.
- [ ] `UX-VISUAL-009` **SHOULD** Kiểm hai theme ở zoom 400% (và ảnh chụp ở zoom 4×) cho màn hình chính: không chữ tàng hình, không viền mất, biểu đồ đọc được. → Kiểm: Playwright `deviceScaleFactor: 4` + `data-theme` dark/light chụp ảnh so baseline. · Nguồn: catalog 06 §7 (verify ở zoom 4×, cả hai theme)
- [ ] `UX-VISUAL-010` **SHOULD** Một bộ icon duy nhất, cùng stroke/size, nạp theo cây (tree-shake), `aria-hidden` khi trang trí. → Kiểm: `package.json` chỉ một thư viện icon; knip không báo icon thừa.
- [ ] `UX-VISUAL-011` **SHOULD** Không có trope "AI slop" trong bảng trên; section hero có nội dung thật (số liệu, ảnh sản phẩm) thay vì khẩu hiệu chung. → Kiểm: script `check:ui-ux-guard` (grep gradient ngoài token, `transition: all`, emoji, `backdrop-filter` > ngưỡng) = 0; review ảnh hero trong PR.
- [ ] `UX-VISUAL-012` **SHOULD** Mật độ thông tin vừa: tối đa một màu nhấn trên một màn hình, bóng/bo góc theo 3–4 bậc token. → Kiểm: `check:contrast` + grep `box-shadow` ngoài token = 0; review mật độ bằng checklist "xoá trước".
- [ ] `UX-VISUAL-013` **SHOULD** Chuyển trang/animation không làm giảm INP: không chặn main thread > 50 ms khi animation chạy. → Kiểm: Lighthouse TBT, DevTools Performance recording trên luồng chính; web-vitals INP p75 ≤ 200 ms (xem [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)).
- [ ] `UX-VISUAL-014` **SHOULD** Mobile native tôn trọng Reduce Motion của hệ (`UIAccessibility.isReduceMotionEnabled`, `Settings.Global.ANIMATOR_DURATION_SCALE`). → Kiểm: UI test bật Reduce Motion → không parallax/zoom. · Nguồn: Apple HIG Accessibility
- [ ] `UX-VISUAL-015` **SHOULD** Ảnh có `width`/`height` hoặc `aspect-ratio` để không gây CLS; LCP image không lazy. → Kiểm: Lighthouse `unsized-images` = 0; CLS ≤ 0.1.
- [ ] `UX-VISUAL-016` **MAY** Dùng View Transitions API cho chuyển trang/danh sách với fallback không animation. → Kiểm: `document.startViewTransition` được feature-detect.
- [ ] `UX-VISUAL-017` **MAY** Thư viện animation JS chỉ nạp lazy ở route cần. → Kiểm: bundle analyzer: `motion` không nằm trong chunk đầu.
- [ ] `UX-VISUAL-018` **MAY** Storyboard/luật chuyển động viết trong `docs/MOTION.md` (mục đích, thời lượng, easing cho từng loại). → Kiểm: file tồn tại và token motion trỏ về nó.

## Bẫy thường gặp

- **`transition: all`**: animate cả thuộc tính layout, giật và tốn CPU; liệt kê thuộc tính cụ thể.
- **Parallax/zoom nền hero** không tắt khi reduced-motion: gây chóng mặt với người rối loạn tiền đình.
- **Carousel tự chạy không nút dừng** (2.2.2) và chuyển slide nhanh: hầu như không ai xem slide 2.
- **Mỗi khối đều "bay vào" khi cuộn**: người dùng chờ nội dung hiện; bỏ ở nội dung chính, giữ cho vài điểm nhấn.
- **Theme tối chỉ kiểm ở zoom 100%**: viền 1 px tương phản thấp biến mất ở zoom lớn/màn DPI thấp. Chụp ở 4×.
- **Emoji làm bullet/icon**: hiển thị khác mỗi hệ, trình đọc màn hình đọc tên emoji dài, không tô màu theo theme.
- **Ảnh stock/ảnh AI không nguồn** → rủi ro bản quyền và nhãn AI (Art. 50). Ghi CREDITS.
- **Visual regression trên máy dev** (font/GPU khác CI) → diff giả liên tục rồi bị tắt. Chạy trong container cố định, baseline từ CI.
- **Skill "gu" thay cho cổng**: chưa có benchmark độc lập cho các skill thẩm mỹ; dùng như gợi ý, cổng máy mới quyết.
- **Animation JS trên main thread cho danh sách dài** → INP vượt 200 ms. CSS/compositor hoặc virtualize.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| `@lhci/cli` 0.15.1 + lighthouse 13.5.0 (Apache-2.0; lhci không commit từ 26/06/2025 — theo dõi thay thế) | `lhci autorun` với `categories:performance|accessibility|best-practices|seo minScore 0.9` | CI PR | ≥ 0.9 cả 4, median của 3 lần |
| Playwright 1.64.0 (Apache-2.0) `toHaveScreenshot` | `playwright test --project=visual` (2 theme × 2 viewport, `deviceScaleFactor` 1 và 4) | CI (container cố định) | diff ≤ `maxDiffPixelRatio` đã chốt |
| Playwright `emulateMedia({ reducedMotion: 'reduce' })` + `getAnimations()` | test `@motion` | CI E2E | 0 animation transform khi reduce |
| stylelint 17.16.0 (MIT) | cấm `transition: all`, animate thuộc tính layout, số ms ngoài token | pre-commit | 0 lỗi |
| Script `check:ui-ux-guard` tự viết (grep trope) | `node scripts/check-ui-ux-guard.mjs src` | pre-commit + CI | 0 kết quả |
| Script `check:contrast` (xem design-system) | token hai theme | CI | AA |
| knip 6.41.0 (ISC) | `knip` | CI | 0 thư viện icon/animation thừa |
| Storybook 10.6.2 + addon-a11y | story có cả hai theme | CI | 0 vi phạm |

## Nguồn

- MDN — `prefers-reduced-motion` (giá trị, thay scale bằng opacity; rối loạn tiền đình; Baseline từ 01/2020): <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion> — xác minh 2026-10-13.
- WCAG 2.2 SC 2.2.2 Pause, Stop, Hide: <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html>; SC 2.3.1, 2.3.3: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- web.dev — High-performance animations (giới hạn ở `opacity`/`transform`; DevTools Performance/Rendering): <https://web.dev/articles/animations-guide> — xác minh 2026-10-13.
- Lighthouse performance scoring (0–49 đỏ, 50–89 cam, 90–100 xanh; trọng số LH10: FCP 10, SI 10, LCP 25, TBT 30, CLS 25): <https://developer.chrome.com/docs/lighthouse/performance/performance-scoring> — xác minh 2026-10-13.
- Lighthouse CI configuration (assert presets, `minScore`, `maxNumericValue`, `numberOfRuns` mặc định 3, aggregation): <https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md> — xác minh 2026-10-13; commit cuối 26/06/2025: <https://github.com/GoogleChrome/lighthouse-ci/commits/main> — xác minh 2026-10-13.
- React 19.3 (09/09/2026: View Transitions, Trusted Types…): <https://react.dev/blog> — xác minh 2026-10-13.
- Apple HIG Accessibility (Reduce Motion: giảm zoom/scale/peripheral motion, thay bằng fade): <https://developer.apple.com/design/human-interface-guidelines/accessibility> — xác minh 2026-10-13 (dữ liệu JSON của trang).
- Catalog `seeker19110/stored` mục 06 §4 (trope AI slop: purple mesh gradient, hero căn giữa, 3 card giống nhau, Inter + stock; "taste chỉ bền khi có cổng máy": `check:contrast`, `ui-ux-guard`, Lighthouse 4 category; chưa có benchmark độc lập cho skill gu) và §7/§7b (verify ở zoom 4× cả hai theme, "xoá trước", mật độ 4/10, reduced-motion), đọc 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): motion 14.1.0 · @lhci/cli 0.15.1 · lighthouse 13.5.0 · @playwright/test 1.64.0 · stylelint 17.16.0 · knip 6.41.0 · storybook 10.6.2.
