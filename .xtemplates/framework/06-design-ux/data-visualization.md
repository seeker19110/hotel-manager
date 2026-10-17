---
title: Trực quan hoá dữ liệu (biểu đồ, KPI, readout)
kind: module
prefix: UX-VIZ
applies_to: [web-app, mobile-app, desktop-app, static-site, monorepo]
updated: 2026-10-16
---

# Trực quan hoá dữ liệu (biểu đồ, KPI, readout)

> Số trên biểu đồ phải **đúng** trước khi đẹp, và biểu đồ phải **đọc được** không cần màu. Module này giữ hai việc đó:
> số đến từ một hàm dữ liệu có test, và có lối thay thế văn bản. Thẩm mỹ, chuyển động và kiểm hai theme ở zoom 4× →
> [`motion-and-visual-quality.md`](motion-and-visual-quality.md) (`UX-VISUAL-009`); tiền, đơn vị, locale →
> [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); tiếp cận chung →
> [`accessibility.md`](accessibility.md). Không lặp lại ở đây.

## Nguyên tắc

1. **Sự thật trước hình** ("truth first"): thu thập/tính số liệu trong module thuần (không I/O, không DOM), rồi mới vẽ. Hình
   chỉ trình bày lại kết quả của hàm đó.
2. **Một số, một nguồn**: số trên cột, KPI, tooltip, readout và bảng thay thế đều lấy từ cùng hàm; không tính lại trong component.
3. **Lỗi "trông hợp lý nhưng sai" là loại khó thấy nhất** (tổng waterfall lệch vài đơn vị, phần trăm không cộng đủ 100):
   mắt người không bắt được, nên cần fixture đối nghịch mà test phải làm đỏ.
4. **Không mã hoá chỉ bằng màu**: người mù màu, in đen trắng, trình đọc màn hình đều cần một kênh khác (nhãn, hình dạng, bảng).
5. **Không đánh lừa bằng trục hoặc đơn vị**: cột bắt đầu từ 0, đơn vị ghi rõ.

## Quyết định

| Loại hiển thị | Lối thay thế tối thiểu | Ghi chú |
|---|---|---|
| Biểu đồ ít điểm (≤ ~12) | Mô tả văn bản 1–2 câu: xu hướng + số chính (`figcaption`/`aria-describedby`) | Số trong mô tả lấy từ hàm dữ liệu |
| Nhiều chuỗi hoặc nhiều điểm | Bảng dữ liệu `<table>` cạnh biểu đồ hoặc nút "Xem bảng" | Bảng cũng lấy từ hàm dữ liệu |
| Thẻ KPI / readout | Số là **văn bản thật**, không phải ảnh hay `canvas` | Kèm đơn vị và kỳ so sánh |
| Hơn 1 chuỗi | Nhãn trực tiếp, kiểu nét/hình điểm khác nhau, không chỉ chú giải màu | Màu chuỗi ≥ 3:1 với nền |

## Checklist

- [ ] `UX-VIZ-001` **MUST@L** Mọi con số trên biểu đồ, KPI, tooltip và readout được tính bằng **cùng một hàm dữ liệu thuần** (không I/O, không phụ thuộc DOM) có unit test; component chỉ vẽ lại kết quả. Có fixture "trông hợp lý nhưng sai" (waterfall có tổng lệch, phần trăm không cộng đủ 100) mà test phải làm đỏ. → Kiểm: unit test hàm dữ liệu; test fixture waterfall tổng lệch → đỏ; snapshot số hiển thị trong component khớp đầu ra hàm dữ liệu. · Nguồn: `seeker19110/stored` 06 §7 (Anatomy: "truth first", mọi số readout từ một model nhỏ), §7b.2 (diagram-design: `verify-*.py` + fixture `waterfall-plausible-wrong.html`); đọc 2026-10-16
- [ ] `UX-VIZ-002` **MUST** Mỗi biểu đồ có **bảng dữ liệu** hoặc **mô tả văn bản thay thế** nêu xu hướng và số chính; thông tin không mã hoá chỉ bằng màu (thêm nhãn trực tiếp, hình dạng hoặc kiểu nét); màu chuỗi/điểm đạt ≥ 3:1 với nền ở **cả hai theme**. → Kiểm: test mỗi biểu đồ có `<table>` hoặc `aria-describedby` trỏ tới mô tả; axe không báo lỗi `svg-img-alt`; script tính tỷ lệ màu chuỗi so nền hai theme ≥ 3; ảnh chụp thang xám vẫn phân biệt được các chuỗi. · Nguồn: WCAG 2.2 SC 1.1.1, 1.4.1, 1.4.11 (<https://www.w3.org/TR/WCAG22/>); `seeker19110/stored` 06 §7b.2 (diagram-design: verifier tương phản/a11y)
- [ ] `UX-VIZ-003` **SHOULD** Cột/thanh bắt đầu từ 0 (trục cắt chỉ cho đường/điểm và ghi rõ trên trục); đơn vị ghi ở trục hoặc nhãn; số định dạng theo locale (`vi-VN`) khi hiển thị; tiền là **số nguyên** ở dữ liệu, chỉ định dạng ở lớp hiển thị. Quy tắc tiền/đơn vị: [`XC-UNITS-005`](../18-cross-cutting/units-time-and-money.md), [`XC-UNITS-009`](../18-cross-cutting/units-time-and-money.md); định dạng locale: [`UX-CONTENT-015`](content-and-microcopy.md). → Kiểm: test cấu hình trục của biểu đồ cột có `min = 0`; snapshot định dạng `vi-VN`; test hàm vẽ nhận tiền là số nguyên (không float). · Nguồn: `seeker19110/stored` 06 §7, §7b.2; đọc 2026-10-16

## Bẫy thường gặp

- **Tính tổng/phần trăm ngay trong component** (cộng lại khi vẽ) → tooltip một số, KPI một số khác. Một hàm dữ liệu, cả hai gọi (`UX-VIZ-001`).
- **Tin "nhìn hợp lý" là đúng**: waterfall lệch vài đơn vị vẫn trông đẹp. Fixture đối nghịch + test tổng.
- **Chú giải chỉ bằng màu** (đỏ/xanh) → mù màu và ảnh in đen trắng không đọc được. Thêm nhãn trực tiếp hoặc hình điểm khác nhau.
- **Màu chuỗi đạt AA ở theme sáng nhưng mất ở theme tối** (hoặc ngược lại). Kiểm tỷ lệ ở cả hai theme.
- **Cắt trục cột để "thấy khác biệt"** → khác biệt nhỏ trông to. Cột bắt đầu từ 0.
- **Biểu đồ là ảnh/`canvas` không có bảng hay mô tả** → trình đọc màn hình không có gì để đọc (WCAG 1.1.1).
- **Định dạng số bằng nối chuỗi** (`"₫" + n`) → sai dấu phân cách theo locale; dùng `Intl` (`UX-CONTENT-015`).

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Số đúng | test đơn vị của hàm dữ liệu (vitest/pytest) | fixture "trông hợp lý nhưng sai" phải làm test đỏ | CI | 100% hàm dữ liệu có test; fixture đối nghịch bị bắt |
| Có lối thay thế | test component + axe (MPL-2.0) rule `svg-img-alt` | mỗi biểu đồ có `<table>` hoặc `aria-describedby` | CI | 0 biểu đồ thiếu |
| Tương phản chuỗi | script tự viết tính tỷ lệ từ token màu chuỗi và nền | cả hai theme (theo `UX-A11Y-002`, `UX-A11Y-028`) | CI | < 3:1 = đỏ |
| Trục và định dạng | test cấu hình biểu đồ + snapshot `Intl` `vi-VN` | `min = 0` cho cột; format tiền | CI | lệch = đỏ |

## Nguồn

- WCAG 2.2 (W3C): SC 1.1.1 Non-text Content, SC 1.4.1 Use of Color, SC 1.4.11 Non-text Contrast: <https://www.w3.org/TR/WCAG22/> — trang tải được 2026-10-16 (nội dung từng SC theo kiến thức nền; tra lại bản Understanding trước khi dẫn nguyên văn).
- Catalog `seeker19110/stored` 06 §7 (Anatomy: quy trình "truth first", số readout từ model nhỏ, kiểm bằng máy), §7b.2 (diagram-design: 30 `verify-*.py`, fixture đối nghịch `waterfall-plausible-wrong.html`) — đọc 2026-10-16. Chưa chạy lại các công cụ đó trong khung này.
