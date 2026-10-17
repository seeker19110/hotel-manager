---
title: Tiếp cận (a11y) theo WCAG 2.2 AA và nền tảng mobile
kind: module
prefix: UX-A11Y
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-16
---

# Tiếp cận (a11y) theo WCAG 2.2 AA và nền tảng mobile

> "Nhà" của yêu cầu tiếp cận trong khung: sàn là **WCAG 2.2 mức AA** cho web/hybrid, cộng hướng dẫn nền tảng cho mobile
> native (Apple HIG, Android). Phiên bản chuẩn/luật và cách chứng minh tuân thủ → [`../04-standards/accessibility-standards.md`](../04-standards/accessibility-standards.md);
> cách viết test E2E a11y → [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md).

## Nguyên tắc

1. **A11y là chất lượng đo được**, không phải "nếu còn thời gian". Máy quét trong CI, người kiểm phần máy không thấy.
2. **Máy chỉ bắt được một phần.** axe-core tự công bố phát hiện trung bình ~57% vấn đề WCAG; phần còn lại (thứ tự focus hợp lý,
   nhãn có nghĩa, luồng bằng bàn phím/trình đọc màn hình) phải kiểm tay theo kịch bản.
3. **HTML ngữ nghĩa trước, ARIA sau.** Dùng `<button>`, `<a>`, `<label>`, `<dialog>`, landmark; chỉ thêm ARIA khi HTML không đủ.
   ARIA sai còn tệ hơn không có ARIA.
4. **Bàn phím là đầu vào hạng nhất.** Mọi thứ chuột làm được thì bàn phím làm được; focus luôn nhìn thấy và không bị che.
5. **Không giả định cỡ chữ, màu, chuyển động.** Người dùng phóng chữ 200%, reflow 320 px, giảm chuyển động, tương phản cao —
   giao diện phải vẫn dùng được.
6. **Mobile native theo nền tảng:** VoiceOver/TalkBack, Dynamic Type/font scale, vùng chạm, Reduce Motion.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Mức tuân thủ | **WCAG 2.2 AA** | Mặc định mọi dự án có UI | Dịch vụ công/EU/ngành bị quản lý → thêm EN 301 549/Section 508 (xem 04-standards); AAA chỉ cho mục chọn lọc |
| Máy quét động (DOM đã render) | axe-core 4.14.0 (MPL-2.0) qua `@axe-core/playwright` 4.13.0 | Có E2E Playwright | Không có E2E → pa11y 10.0.0 (LGPL-3.0-only; chú ý license) hoặc Lighthouse accessibility |
| Lint tĩnh (JSX/HTML) | Biome 2.5.15 nhóm rule `a11y` hoặc `eslint-plugin-jsx-a11y` 6.10.2 | React/JSX, HTML template | Vue/Svelte/Angular → rule a11y của bộ lint tương ứng; native → Accessibility Inspector (Xcode) / Accessibility Scanner (Android) |
| Component tuỳ chỉnh (menu, combobox, dialog) | Headless đã test a11y (Base UI 1.9.0, Ark UI 5.39.3, Radix) | Cần component phức tạp | Tự viết khi không có lựa chọn — bám đúng pattern WAI-ARIA APG + test bàn phím |
| Trình đọc màn hình để kiểm tay | NVDA (Windows, GPL), VoiceOver (macOS/iOS), TalkBack (Android) | Mỗi release luồng chính | Không thay bằng máy quét |

## Checklist

- [ ] `UX-A11Y-001` **MUST** Mọi trang/màn hình qua quét axe-core với tag `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` không có vi phạm (`violations.length === 0`). → Kiểm: `@axe-core/playwright` trong mọi smoke test E2E; CI đỏ nếu vi phạm. · Nguồn: WCAG 2.2 AA
- [ ] `UX-A11Y-002` **MUST** Tương phản chữ ≥ 4.5:1 (chữ lớn ≥ 3:1); thành phần UI và trạng thái (viền input, icon, focus) ≥ 3:1 với nền kề. → Kiểm: `check:contrast` trên token + axe rule `color-contrast` ở cả hai theme. · Nguồn: WCAG 2.2 SC 1.4.3, 1.4.11
- [ ] `UX-A11Y-003` **MUST** Toàn bộ chức năng dùng được bằng bàn phím; không bẫy focus (trừ dialog modal có Esc để thoát). → Kiểm: E2E luồng chính chỉ dùng `keyboard.press('Tab'|'Enter'|'Escape')`; axe rule `focus-order-semantics`. · Nguồn: WCAG 2.2 SC 2.1.1, 2.1.2
- [ ] `UX-A11Y-004` **MUST@L** Phần tử nhận focus không bị che hoàn toàn bởi header/footer dính hay banner cookie. → Kiểm: E2E Tab qua trang có sticky header, `boundingBox` của phần tử focus không nằm trọn dưới sticky element. · Nguồn: WCAG 2.2 SC 2.4.11
- [ ] `UX-A11Y-005` **MUST@L** Chỉ báo focus nhìn thấy trên mọi điều khiển, không `outline: none` mà không thay thế. → Kiểm: stylelint cấm `outline: none|0` không kèm `:focus-visible` thay thế; ảnh snapshot trạng thái focus. · Nguồn: WCAG 2.2 SC 2.4.7
- [ ] `UX-A11Y-006` **MUST@L** Vùng chạm web ≥ 24×24 CSS px (trừ ngoại lệ spacing/inline/user-agent); mobile native ≥ 44×44 pt (iOS) / 48×48 dp (Android). → Kiểm: axe rule `target-size`; native: Accessibility Scanner/Inspector báo 0 cảnh báo touch target. · Nguồn: WCAG 2.2 SC 2.5.8; Apple HIG Buttons; Android Accessibility
- [ ] `UX-A11Y-007` **MUST@L** Chức năng kéo-thả có cách thay thế bằng một con trỏ không kéo (nút di chuyển, menu). → Kiểm: E2E thực hiện sắp xếp bằng nút "Lên/Xuống" không dùng drag. · Nguồn: WCAG 2.2 SC 2.5.7
- [ ] `UX-A11Y-008` **MUST@L** Không bắt nhập lại thông tin đã nhập trong cùng quy trình (tự điền hoặc cho chọn lại), trừ khi cần vì bảo mật. → Kiểm: E2E multi-step quay lại bước trước vẫn giữ dữ liệu. · Nguồn: WCAG 2.2 SC 3.3.7
- [ ] `UX-A11Y-009` **MUST@L** Đăng nhập không ép "bài kiểm tra nhận thức": cho dán mật khẩu/OTP, không chặn trình quản lý mật khẩu, không hỏi ký tự thứ n. → Kiểm: E2E dán vào ô mật khẩu và ô OTP thành công; không có `onpaste` return false. · Nguồn: WCAG 2.2 SC 3.3.8
- [ ] `UX-A11Y-010` **MUST@L** Ảnh có `alt` có nghĩa (trang trí → `alt=""`); icon-only button có tên tiếp cận. → Kiểm: axe rule `image-alt`, `button-name`, `link-name`. · Nguồn: WCAG 2.2 SC 1.1.1, 4.1.2
- [ ] `UX-A11Y-011` **MUST** Mọi ô nhập có nhãn gắn chương trình (`<label for>`, `aria-labelledby`); placeholder không thay nhãn. → Kiểm: axe rule `label`; lint `label-has-associated-control`. · Nguồn: WCAG 2.2 SC 1.3.1, 3.3.2
- [ ] `UX-A11Y-012` **MUST@L** Trang có `lang="vi"` (hoặc đúng ngôn ngữ), tiêu đề `<title>` riêng từng trang, heading theo thứ bậc, landmark (`main`, `nav`). → Kiểm: axe rule `html-has-lang`, `document-title`, `heading-order`, `landmark-one-main`. · Nguồn: WCAG 2.2 SC 2.4.2, 3.1.1
- [ ] `UX-A11Y-013` **MUST@L** Nội dung reflow ở bề rộng 320 CSS px không cuộn hai chiều (tương đương zoom 400% từ 1280 px); chữ phóng 200% không mất nội dung. → Kiểm: Playwright viewport 320×800 → `document.scrollingElement.scrollWidth <= 320`; `page.evaluate(() => document.body.style.zoom = '2')` hoặc thiết lập font-size 200%. · Nguồn: WCAG 2.2 SC 1.4.10, 1.4.4
- [ ] `UX-A11Y-014` **MUST@L** Dialog modal: focus vào trong khi mở, Tab quay vòng trong dialog, Esc đóng, focus trả về phần tử mở; `role="dialog"` + `aria-modal="true"` + tên tiếp cận. → Kiểm: E2E theo pattern APG; dùng `<dialog>` hoặc component headless. · Nguồn: WAI-ARIA APG Dialog (Modal)
- [ ] `UX-A11Y-015` **MUST@L** Nội dung tự chuyển động/nhấp nháy > 5 giây có nút tạm dừng/dừng/ẩn; không nhấp nháy quá 3 lần/giây. → Kiểm: review carousel/auto-play có nút Pause; E2E bấm Pause dừng được. · Nguồn: WCAG 2.2 SC 2.2.2, 2.3.1
- [ ] `UX-A11Y-016` **MUST@L** Không chặn zoom (`user-scalable=no`, `maximum-scale=1`). → Kiểm: grep meta viewport; axe rule `meta-viewport`. · Nguồn: WCAG 2.2 SC 1.4.4
- [ ] `UX-A11Y-017` **MUST@L** Luồng chính được kiểm tay bằng trình đọc màn hình (VoiceOver/TalkBack/NVDA) mỗi release, có biên bản. → Kiểm: file `docs/a11y/manual-<release>.md` liệt kê luồng, thiết bị, kết quả. · Nguồn: WCAG 2.2 (phần máy không quét được)
- [ ] `UX-A11Y-018` **MUST@L** Mobile native: mọi điều khiển có nhãn (`accessibilityLabel`/`contentDescription`), hỗ trợ Dynamic Type/font scale tới 200% không cắt chữ, tôn trọng Reduce Motion. → Kiểm: Xcode Accessibility Inspector audit + Android Accessibility Scanner 0 lỗi; test UI với font scale lớn nhất. · Nguồn: Apple HIG Accessibility; Android Accessibility
- [ ] `UX-A11Y-019` **SHOULD** Thông báo động (lỗi, thành công, cập nhật) đi qua live region: `role="status"`/`aria-live="polite"` cho thường, `role="alert"` cho khẩn; không chuyển focus bằng alert. → Kiểm: E2E kiểm `[role=status]` chứa thông điệp sau hành động. · Nguồn: WAI-ARIA APG Alert; WAI tutorial Forms
- [ ] `UX-A11Y-020` **SHOULD** Có liên kết "Bỏ qua tới nội dung chính" là phần tử focus đầu tiên. → Kiểm: E2E Tab lần đầu → phần tử có text "Bỏ qua". · Nguồn: WCAG 2.2 SC 2.4.1
- [ ] `UX-A11Y-021` **SHOULD** Cơ chế trợ giúp (liên hệ, chat, FAQ) ở cùng vị trí tương đối trên mọi trang. → Kiểm: E2E kiểm selector trợ giúp xuất hiện cùng vị trí trên 3 trang. · Nguồn: WCAG 2.2 SC 3.2.6
- [ ] `UX-A11Y-022` **SHOULD** Component tuỳ chỉnh (tab, menu, combobox) bám đúng pattern WAI-ARIA APG: role/state/keyboard đầy đủ. → Kiểm: story có `play` test phím mũi tên/Home/End; axe rule `aria-*`. · Nguồn: WAI-ARIA APG
- [ ] `UX-A11Y-023` **SHOULD** Chuyển động tôn trọng `prefers-reduced-motion` (chi tiết ở [`motion-and-visual-quality.md`](motion-and-visual-quality.md)). → Kiểm: `emulateMedia({ reducedMotion: 'reduce' })` → không animation dịch chuyển lớn.
- [ ] `UX-A11Y-024` **SHOULD** Không dùng `tabindex > 0`; thứ tự DOM = thứ tự đọc = thứ tự nhìn. → Kiểm: lint `no-positive-tabindex`; axe `tabindex`.
- [ ] `UX-A11Y-025` **SHOULD** Lỗi form liên kết với ô nhập (`aria-describedby`, `aria-invalid`), focus về ô lỗi đầu tiên (chi tiết ở [`../07-frontend/forms-and-validation.md`](../07-frontend/forms-and-validation.md)). → Kiểm: E2E submit form lỗi → `document.activeElement` là ô lỗi đầu.
- [ ] `UX-A11Y-026` **MAY** Hỗ trợ `prefers-contrast: more` và chế độ "forced colors" (Windows High Contrast) không mất viền/icon. → Kiểm: `emulateMedia({ forcedColors: 'active' })` chụp ảnh so sánh.
- [ ] `UX-A11Y-027` **MAY** Phụ đề/transcript cho media; mô tả âm thanh cho video quan trọng. → Kiểm: mọi `<video>` có `<track kind="captions">`. · Nguồn: WCAG 2.2 SC 1.2.2
- [ ] `UX-A11Y-028` **SHOULD** Điều khiển đạt tương phản ≥ 3:1 (biên/icon) và chữ ≥ 4.5:1 ở các trạng thái **hover, focus-visible, active, selected**, ở **cả hai theme** (bổ sung cho `UX-A11Y-002` vốn kiểm trạng thái mặc định); trạng thái disabled được WCAG miễn. → Kiểm: Playwright `hover()`/`focus()` từng story/component rồi tính tỷ lệ từ computed style (màu chữ/viền so nền hiệu dụng) cho mỗi trạng thái × theme; dưới ngưỡng → đỏ. · Nguồn: WCAG 2.2 SC 1.4.3, 1.4.11; `seeker19110/stored` 06 §7d.2 (XIAS: README ghi "52/52" nhưng một ô harness đạt 2,92:1 < 3:1, chạy lại 49/52; đọc 2026-10-16)

## Bẫy thường gặp

- **`<div onClick>` thay `<button>`**: không focus, không Enter/Space, không role. Lint `click-events-have-key-events` + `no-static-element-interactions`.
- **Placeholder làm nhãn**: biến mất khi gõ, tương phản thấp, trình đọc màn hình không ổn định. Luôn có `<label>`.
- **OTP một ký tự mỗi ô** chặn dán → vi phạm 3.3.8. Dùng một ô `inputmode="numeric" autocomplete="one-time-code"`.
- **Sticky header + anchor** che phần tử focus → vi phạm 2.4.11. Dùng `scroll-padding-top` bằng chiều cao header.
- **Icon-only button không tên** (`<button><svg/></button>`): thêm `aria-label` hoặc text ẩn trực quan.
- **Tắt zoom "để giống app"** (`user-scalable=no`): vi phạm 1.4.4, vẫn chặn được người dùng kém thị lực.
- **Toast tự biến mất sau 3 giây**: người dùng chậm không kịp đọc (2.2.1); lỗi phải ở inline, toast chỉ cho thông báo không cần hành động.
- **Chỉ kiểm axe trên trang chủ**: lỗi nằm ở dialog, bước 3 của form, trạng thái lỗi. Quét sau mỗi bước trong E2E.
- **Tin điểm Lighthouse 100 là đạt AA**: Lighthouse chỉ chạy một phần rule axe; không thay kiểm tay.
- **Mobile: ẩn Dynamic Type để giữ layout** → chữ không phóng được; sửa layout, không khoá cỡ chữ.
- **Chỉ kiểm tương phản ở trạng thái mặc định, hoặc tin con số công bố**: hover/focus/selected nhạt hơn nền mà bộ kiểm không chạm tới (XIAS công bố "52/52", tự chạy lại có ô 2,92:1 < 3:1). Chụp computed style từng trạng thái × theme (`UX-A11Y-028`).

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| `@axe-core/playwright` 4.13.0 (MPL-2.0) | `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()` sau mỗi bước E2E | CI E2E (desktop + mobile) | `violations = []` |
| Biome 2.5.15 nhóm `a11y` (MIT/Apache-2.0) hoặc `eslint-plugin-jsx-a11y` 6.10.2 (MIT) | `biome lint` / `eslint .` | pre-commit + CI | 0 lỗi, 0 cảnh báo |
| Lighthouse 13.5.0 category `accessibility` qua `@lhci/cli` 0.15.1 (Apache-2.0) | `lhci autorun` với `categories:accessibility minScore 0.9` | CI (PR) | ≥ 0.9 (bổ trợ, không thay axe) |
| pa11y 10.0.0 (**LGPL-3.0-only** — kiểm license khi vendor) | `pa11y-ci --sitemap <url>` | CI nightly cho site tĩnh không có E2E | 0 lỗi |
| Storybook `@storybook/addon-a11y` 10.6.2 (MIT) | `vitest --project=storybook` | CI | 0 vi phạm trên story |
| Xcode Accessibility Inspector · Android Accessibility Scanner | audit thủ công theo kịch bản | Trước release (mobile) | 0 cảnh báo touch target/label |
| Kiểm tay trình đọc màn hình | kịch bản luồng chính | Trước release (M/L) | biên bản trong `docs/a11y/` |
| Tương phản theo trạng thái | Playwright `hover()`/`focus()` từng story + tính tỷ lệ từ computed style | CI | < 3:1 (biên/icon) hoặc < 4.5:1 (chữ) = đỏ; disabled bỏ qua |

Tag `wcag22aa` của axe-core: kiểm danh sách tag hiện hành trong tài liệu axe-core trước khi cấu hình (tài liệu Playwright
chỉ ví dụ tới `wcag21aa`).

## Nguồn

- WCAG 2.2, W3C Recommendation 05/10/2023, bản cập nhật 12/12/2024 (9 SC mới; đã bỏ 4.1.1 Parsing): <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- Understanding WCAG 2.2: SC 2.5.8 Target Size (Minimum) <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>; SC 2.4.11 <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html>; SC 2.5.7 <https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html>; SC 3.3.7 <https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html>; SC 3.3.8 <https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html>; SC 1.4.10 <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html>; SC 2.2.2 <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html> — xác minh 2026-10-13.
- WAI-ARIA Authoring Practices Guide — Dialog (Modal) <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>, Alert <https://www.w3.org/WAI/ARIA/apg/patterns/alert/>; WAI tutorial Form notifications <https://www.w3.org/WAI/tutorials/forms/notifications/> — xác minh 2026-10-13.
- Apple HIG — Buttons ("hit region of at least 44x44 pt; visionOS 60x60 pt"): <https://developer.apple.com/design/human-interface-guidelines/buttons>; HIG Accessibility (Reduce Motion, Dynamic Type ≥ 200%; bảng cỡ điều khiển mặc định 44×44 pt / tối thiểu 28×28 pt): <https://developer.apple.com/design/human-interface-guidelines/accessibility> — xác minh 2026-10-13 qua dữ liệu JSON của trang.
- Android — Make apps more accessible (touch target ≥ 48×48 dp; contentDescription; tương phản 4.5:1 / 3:1): <https://developer.android.com/guide/topics/ui/accessibility/apps> — xác minh 2026-10-13. Material 3 (m3.material.io) không truy cập được nội dung ngày 2026-10-13 **(chưa xác minh)**.
- axe-core README (MPL-2.0; "on average 57% of WCAG issues automatically"): <https://github.com/dequelabs/axe-core>; Playwright accessibility testing: <https://playwright.dev/docs/accessibility-testing> — xác minh 2026-10-13.
- pa11y (LGPL-3.0-only, v10 cần Node ≥ 22.13): <https://github.com/pa11y/pa11y> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): axe-core 4.14.0 · @axe-core/playwright 4.13.0 · pa11y 10.0.0 · eslint-plugin-jsx-a11y 6.10.2 · @biomejs/biome 2.5.15 · lighthouse 13.5.0 · @lhci/cli 0.15.1.
- Khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 3 (a11y hai tầng, kiểm tay).
- Catalog `seeker19110/stored` 06 §7d.2 (XIAS: tự chạy `accuracy_report` → 49/52, một ô 2,92:1) — đọc 2026-10-16.
