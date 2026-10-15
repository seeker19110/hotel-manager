---
title: Responsive, mobile-first, vùng chạm, bố cục
kind: module
prefix: UX-RESP
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Responsive, mobile-first, vùng chạm, bố cục

> Thiết kế cho **màn nhỏ và ngón tay trước**, rồi mở rộng. Bố cục không cuộn ngang ở 320 CSS px, vùng chạm đủ lớn
> (web ≥ 24 px tối thiểu, mục tiêu 44 pt/48 dp), tôn trọng safe area và bàn phím ảo, kiểm bằng máy trên cả viewport
> mobile lẫn desktop. Hiệu năng ảnh/font → [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md).

## Nguyên tắc

1. **Mobile-first trong CSS và trong thiết kế.** Style mặc định là màn nhỏ một cột; `min-width` media/container query mở rộng.
2. **Breakpoint theo nội dung, không theo thiết bị.** Đặt breakpoint tại nơi bố cục gãy; component tự thích nghi theo
   **container** (`@container`) thay vì viewport khi có thể.
3. **Ngón tay không phải con trỏ.** Mục tiêu vùng chạm 44×44 pt (iOS) / 48×48 dp (Android); sàn pháp lý web 24×24 CSS px;
   không giấu chức năng sau hover.
4. **Không ép người dùng cuộn ngang, không chặn zoom.** Reflow ở 320 px; chữ phóng 200% vẫn dùng được.
5. **Tôn trọng phần cứng:** safe area (tai thỏ, home indicator), bàn phím ảo, xoay màn hình, gập.
6. **Kiểm trên viewport thật, không chỉ co cửa sổ:** Playwright project mobile + thiết bị thật trước release.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Đơn vị thích nghi | **Container query** (`container-type: inline-size`) cho component; media query cho khung trang | Component tái dùng ở nhiều vùng | Trình duyệt mục tiêu cũ hơn Baseline của dự án → fallback media query |
| Bộ breakpoint | 3–4 mốc theo nội dung (vd một cột → hai cột → ba cột), ghi thành token | Mọi dự án | Không chép bộ breakpoint của framework UI làm "chuẩn thiết bị" |
| Điều hướng mobile | Thanh dưới (≤ 5 mục) hoặc menu rút gọn có nút rõ | App nhiều phần | Hamburger giấu mọi thứ khi chỉ có 2–3 mục → hiện thẳng |
| Cỡ chữ | Tỷ lệ fluid `clamp()` giữa min/max token; input ≥ 16 px | Web | Khoá cỡ chữ theo px cứng cho tiêu đề lớn trên mobile |
| Vùng chạm | Web: ≥ 24 px sàn, mục tiêu ≥ 44 px cho hành động chính; native: 44 pt / 48 dp | Mọi phần tử tương tác | Phần tử inline trong câu (ngoại lệ WCAG) |
| Mobile native vs responsive web | Native khi cần cảm biến/offline sâu/hiệu năng đồ hoạ; responsive web/PWA cho phần còn lại | Theo hồ sơ dự án | Không làm "web bọc WebView" rồi gọi là native |

## Checklist

- [ ] `UX-RESP-001` **MUST** Không cuộn ngang ở bề rộng 320 CSS px trên mọi trang/màn hình; không mất nội dung/chức năng. → Kiểm: Playwright viewport 320×800 cho mỗi route trong sitemap: `scrollWidth <= clientWidth`. · Nguồn: WCAG 2.2 SC 1.4.10
- [ ] `UX-RESP-002` **MUST** Thẻ viewport `width=device-width, initial-scale=1` và không `user-scalable=no`/`maximum-scale<2`. → Kiểm: grep meta viewport trong layout; axe rule `meta-viewport`. · Nguồn: WCAG 2.2 SC 1.4.4
- [ ] `UX-RESP-003` **MUST@L** Bố cục mobile: hành động chính ≥ 44×44 CSS px (web) và khoảng cách giữa các mục tiêu chạm đủ để không bấm nhầm. Ngưỡng tối thiểu vùng chạm mọi phần tử (web 24×24 CSS px; native 44 pt / 48 dp): xem [`UX-A11Y-006`](accessibility.md). → Kiểm: script đo `getBoundingClientRect` cho hành động chính trên viewport mobile ≥ 44×44; E2E không có hai mục tiêu chồng vùng chạm. · Nguồn: WCAG 2.2 SC 2.5.5 (AAA); Apple HIG Buttons (44 pt)
- [ ] `UX-RESP-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`UX-A11Y-006`](accessibility.md): vùng chạm native ≥ 44×44 pt (iOS) / 48×48 dp (Android); khoảng cách mục tiêu ở `UX-RESP-003`.
- [ ] `UX-RESP-005` **MUST** Chức năng không phụ thuộc hover: mọi menu/tooltip/hành động mở được bằng chạm hoặc focus. → Kiểm: E2E project mobile (touch) mở được mọi menu; CSS hover chỉ bọc trong `@media (hover: hover)`. · Nguồn: MDN `@media (hover)`; WCAG 2.2 SC 1.4.13
- [ ] `UX-RESP-006` **MUST@L** Header/footer/nút cố định tôn trọng safe area: `padding` cộng `env(safe-area-inset-*)`, viewport `viewport-fit=cover` khi tràn cạnh. → Kiểm: Playwright thiết bị iPhone (có home indicator) chụp ảnh; nút dưới cùng không bị che; grep `safe-area-inset` trong CSS phần tử `position: fixed|sticky`. · Nguồn: MDN `env()`
- [ ] `UX-RESP-007` **MUST@L** Bàn phím ảo không che ô đang nhập và nút gửi; trang cuộn tới ô focus. → Kiểm: E2E mobile: focus ô cuối form → `scrollIntoViewIfNeeded` → ô và nút Gửi nằm trong viewport (tính `visualViewport.height`). · Nguồn: MDN `env(keyboard-inset-*)` / VirtualKeyboard API
- [ ] `UX-RESP-008` **MUST** Luồng chính chạy xanh trên **hai** project E2E: desktop và mobile (thiết bị giả lập Playwright). → Kiểm: `playwright.config` có projects `desktop` + `mobile`; CI chạy cả hai. · Nguồn: khung cũ `quality-supplements.md` Nhóm 2 mục 1; [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md)
- [ ] `UX-RESP-009` **MUST@L** Ảnh và media co giãn theo khung (`max-width: 100%`, `aspect-ratio` giữ chỗ), không tràn; bảng dữ liệu rộng có cuộn trong khung riêng hoặc dạng thẻ trên mobile. → Kiểm: E2E 320 px trang có bảng: `scrollWidth` của `html` không tăng; bảng nằm trong `overflow-x: auto`. · Nguồn: WCAG 2.2 SC 1.4.10 (ngoại lệ bảng)
- [ ] `UX-RESP-010` **MUST@L** Kiểm trên ít nhất một thiết bị iOS và một Android thật (hoặc cloud device farm) cho luồng chính trước release. → Kiểm: biên bản `docs/qa/device-matrix-<release>.md` có thiết bị, OS, kết quả.
- [ ] `UX-RESP-011` **SHOULD** CSS viết mobile-first: style mặc định cho màn nhỏ, `@media (min-width)`/`@container (min-width)`; không `max-width` chồng chéo. → Kiểm: stylelint `media-feature-range-notation` + rule cấm `max-width` trong media (hoặc quy ước review); tỉ lệ `min-width`/`max-width` trong CSS ≥ 90%.
- [ ] `UX-RESP-012` **SHOULD** Breakpoint và cột lưới là token (`--bp-md`, `--grid-cols`) dùng chung JS/CSS; không số lẻ trong component. → Kiểm: grep `@media \(min-width: \d+px\)` ngoài file token = 0 (dùng biến/`@custom-media` hoặc theme của framework).
- [ ] `UX-RESP-013` **SHOULD** Component dùng container query khi phải thích nghi với vùng chứa (sidebar vs main). → Kiểm: component thẻ/danh sách có `container-type`; story hiển thị ở 2 bề rộng container. · Nguồn: MDN Container queries
- [ ] `UX-RESP-014` **SHOULD** Cỡ chữ input ≥ 16 px trên mobile để iOS Safari không tự zoom (hành vi quan sát được, không có tài liệu chính thức — kiểm bằng thiết bị). → Kiểm: computed `font-size` của `input, select, textarea` trên project mobile ≥ 16 px.
- [ ] `UX-RESP-015` **SHOULD** Nội dung quan trọng và hành động chính nằm trong vùng ngón cái (nửa dưới màn hình) trên mobile; thanh hành động cố định dưới cùng cho form dài. → Kiểm: review wireframe mobile; E2E: nút gửi chính có `boundingBox.y + height <= viewport.height` khi ở cuối form.
- [ ] `UX-RESP-016` **SHOULD** Xoay màn hình (dọc/ngang) không mất trạng thái, không khoá hướng trừ khi thiết yếu (game, video). → Kiểm: E2E đổi viewport 390×844 ↔ 844×390 giữa chừng form → dữ liệu còn. · Nguồn: WCAG 2.2 SC 1.3.4
- [ ] `UX-RESP-017` **SHOULD** Chữ phóng 200% (zoom hoặc Dynamic Type/font scale) không cắt, không chồng; dùng `rem`/`em` cho cỡ chữ và khoảng cách liên quan chữ. → Kiểm: E2E đặt `font-size` gốc 200% → không phần tử `overflow` bị cắt (`scrollHeight > clientHeight` với `overflow: hidden`); native test với font scale lớn nhất. · Nguồn: WCAG 2.2 SC 1.4.4; Apple HIG Accessibility (≥ 200%)
- [ ] `UX-RESP-018` **SHOULD** Ảnh có `srcset`/`sizes` hoặc component ảnh của framework để mobile không tải ảnh desktop. → Kiểm: Lighthouse audit `uses-responsive-images` không có cảnh báo (chi tiết ở [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)).
- [ ] `UX-RESP-019` **MAY** Hỗ trợ màn hình gập/đa cửa sổ (viewport segments) và PWA display-mode. → Kiểm: story/E2E với viewport 1/2 màn.
- [ ] `UX-RESP-020` **MAY** Dùng `prefers-reduced-data` để giảm media nặng. → Kiểm: `emulateMedia` tương ứng giảm tải ảnh.

## Bẫy thường gặp

- **Desktop-first rồi "co lại"**: menu, bảng, modal tràn màn hình; sửa muộn tốn gấp nhiều lần. Bắt đầu từ 360 px.
- **Breakpoint theo tên thiết bị** (`iphone`, `ipad`) lỗi thời ngay năm sau; đặt theo nội dung.
- **Chặn zoom để "giữ layout"**: vi phạm WCAG, người kém thị lực không dùng được.
- **Hover-only menu**: trên cảm ứng không mở được hoặc "dính". Bọc hover trong `@media (hover: hover)` và luôn có chạm/focus.
- **Nút dưới cùng bị home indicator/bàn phím che**: thiếu `safe-area-inset-bottom`, không xử lý `visualViewport`.
- **Bảng 10 cột trên mobile** ép cuộn ngang cả trang: cuộn trong khung bảng hoặc chuyển dạng thẻ.
- **Ảnh hero 2000 px tải cho điện thoại**: thiếu `srcset/sizes` → LCP chậm, tốn dữ liệu.
- **Chỉ test bằng cách thu nhỏ cửa sổ Chrome**: không có touch, không có safe area, không bàn phím ảo. Dùng project mobile + thiết bị thật.
- **Khoá hướng dọc "cho đẹp"**: người dùng gắn máy ngang trên xe lăn không dùng được (SC 1.3.4).
- **Vùng chạm 24 px coi là đủ**: 24 px là sàn pháp lý web; ngón tay cần 44–48.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Playwright 1.64.0 (Apache-2.0) projects `desktop` + `mobile` (`devices['Pixel 7']`, `devices['iPhone 15']`) | `playwright test` | CI E2E | luồng chính xanh cả hai |
| Script reflow (Playwright) | viewport 320×800 cho mọi route: `scrollWidth <= clientWidth` | CI E2E | 0 route cuộn ngang |
| `@axe-core/playwright` 4.13.0 (MPL-2.0) rule `target-size`, `meta-viewport` | quét trên project mobile | CI E2E | 0 vi phạm |
| Lighthouse 13.5.0 (Apache-2.0) preset mobile | `lhci autorun` (mobile) audits `viewport`, `tap-targets`, `uses-responsive-images` | CI | không cảnh báo |
| stylelint 17.16.0 (MIT) | `media-feature-range-notation: context`, cấm số breakpoint cứng ngoài token | pre-commit | 0 lỗi |
| Xcode Accessibility Inspector · Android Accessibility Scanner | audit touch target | Trước release mobile | 0 cảnh báo |
| Device matrix thủ công | iOS + Android thật, luồng chính | Trước release (M/L) | biên bản `docs/qa/` |

## Nguồn

- WCAG 2.2 SC 1.4.10 Reflow (320 CSS px; tương đương 1280 px ở zoom 400%): <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html>; SC 2.5.8 Target Size (Minimum) 24×24 CSS px: <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>; SC 1.4.4, 1.3.4, 1.4.13: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- Apple HIG — Buttons ("hit region of at least 44x44 pt"): <https://developer.apple.com/design/human-interface-guidelines/buttons>; HIG Accessibility (Dynamic Type, phóng chữ ≥ 200%): <https://developer.apple.com/design/human-interface-guidelines/accessibility> — xác minh 2026-10-13 (qua dữ liệu JSON của trang).
- Android — Make apps more accessible (touch target ≥ 48×48 dp): <https://developer.android.com/guide/topics/ui/accessibility/apps> — xác minh 2026-10-13.
- MDN — `env()` (`safe-area-inset-*`, `keyboard-inset-*`): <https://developer.mozilla.org/en-US/docs/Web/CSS/env>; `@media (hover)`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover>; Container queries: <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries> — xác minh 2026-10-13. Yêu cầu `viewport-fit=cover` để có safe-area khác 0 trên iOS: theo kiến thức chung, trang MDN `env()` đã đọc không nêu — **(chưa xác minh)**.
- Phiên bản npm `latest` (2026-10-13): @playwright/test 1.64.0 · @axe-core/playwright 4.13.0 · lighthouse 13.5.0 · stylelint 17.16.0.
- Khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 1 (checklist mobile-first, project `mobile` Playwright).
