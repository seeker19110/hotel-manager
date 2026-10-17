---
title: Thiết kế & UI/UX
kind: index
updated: 2026-10-16
---

# 06 — Thiết kế & UI/UX

> Yêu cầu kiểm được cho **mọi hồ sơ có giao diện** (web, mobile, desktop, site tĩnh, game): token và theme, tiếp cận WCAG 2.2 AA
> + hướng dẫn nền tảng mobile, bốn trạng thái UI, microcopy tiếng Việt và chống dark pattern, mobile-first, UX cho tính năng AI,
> chuyển động và chất lượng thị giác có cổng máy, biểu đồ/KPI đúng số và đọc được. Mảng này là "nhà" của a11y và của ngưỡng thiết kế; cách test E2E a11y ở
> `14-testing-quality/`, hiệu năng web ở `07-frontend/performance-web-vitals.md`. Đọc theo giai đoạn: G4 (thiết kế) đọc 1–2 +
> 5; G6 (xây) đọc 3–4 + 7; tính năng AI đọc 6 trước khi làm UI.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`design-system-and-tokens.md`](design-system-and-tokens.md) | Token 3 tầng (DTCG 2025.10), thang spacing/type/radius/elevation, theme sáng/tối không flash, Tailwind `@theme inline`, font tiếng Việt, cổng `check:contrast`/`hex-hardcode` | G4 khi dựng design system; mỗi khi thêm màu/font/theme; áp khung lên dự án có UI sẵn |
| [`accessibility.md`](accessibility.md) | WCAG 2.2 AA (9 SC mới: 2.4.11, 2.5.7, 2.5.8 vùng chạm 24 px, 3.3.7, 3.3.8…), tương phản 4.5:1/3:1, bàn phím, dialog, mobile 44 pt/48 dp, axe/pa11y/Lighthouse | Trước khi code component tương tác; G7 nghiệm thu; khi hồ sơ mobile/web trỏ tới vùng chạm |
| [`ui-states-and-feedback.md`](ui-states-and-feedback.md) | Loading/empty/error/success, skeleton, ngưỡng 0,1/1/10 s, optimistic có rollback, undo thay xác nhận, toast/inline/dialog | Mỗi màn hình hiển thị dữ liệu; khi viết mutation; review PR UI |
| [`content-and-microcopy.md`](content-and-microcopy.md) | Tiếng Việt có dấu, NFC/TCVN 6909, GLOSSARY, giọng, thông điệp lỗi, không dark pattern (DSA Art. 25, FTC, Luật 19/2023/QH15), IME | Viết chuỗi UI; màn hình thanh toán/đồng ý/huỷ; thiết lập i18n |
| [`responsive-and-mobile-first.md`](responsive-and-mobile-first.md) | Reflow 320 px, breakpoint/container query, vùng chạm, safe area, bàn phím ảo, hover, Playwright desktop + mobile, thiết bị thật | G4 wireframe; mỗi màn hình mới; trước release mobile |
| [`ai-ux.md`](ai-ux.md) | Nhãn AI (EU AI Act Art. 50), HAX G1–G18, streaming + Dừng, xác nhận trước side-effect, sửa/hoàn tác, phản hồi, sanitize output | Trước khi thiết kế bất kỳ tính năng dùng mô hình AI; review PR AI |
| [`motion-and-visual-quality.md`](motion-and-visual-quality.md) | `prefers-reduced-motion`, chỉ animate transform/opacity, token motion, luật chống "AI slop" grep được, Lighthouse 4 category ≥ 0.9, visual regression 2 theme × zoom 4× | Thêm animation/chuyển trang; dựng landing/marketing; thiết lập cổng thị giác |
| [`data-visualization.md`](data-visualization.md) | Số trên biểu đồ/KPI từ một hàm dữ liệu có test + fixture "trông hợp lý nhưng sai", bảng/mô tả thay thế, không mã hoá chỉ bằng màu (WCAG 1.1.1, 1.4.1, 1.4.11), trục từ 0, định dạng `vi-VN` | Thêm biểu đồ, thẻ KPI, dashboard, readout; review PR có số liệu hiển thị |

**Prefix ID:** `UX-DS` · `UX-A11Y` · `UX-STATE` · `UX-CONTENT` · `UX-RESP` · `UX-AI` · `UX-VISUAL` · `UX-VIZ`. Ghép vào blueprint qua
`modules: [06-design-ux/*]` của hồ sơ; hồ sơ không có UI (API, CLI, thư viện) không ghép mảng này.
