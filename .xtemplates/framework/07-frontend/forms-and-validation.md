---
title: Form, validation, lỗi, a11y form, upload
kind: module
prefix: FE-FORM
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Form, validation, lỗi, a11y form, upload

> Form là nơi dữ liệu ngoài vào hệ thống: **một schema dùng chung cho client và server**, server là thẩm quyền, client chỉ để
> trải nghiệm; lỗi inline gắn với ô nhập và tiếp cận được; không hỏi lại điều đã biết; upload kiểm ở server; nháp được tự lưu.
> Yêu cầu a11y chung → [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md); microcopy lỗi →
> [`../06-design-ux/content-and-microcopy.md`](../06-design-ux/content-and-microcopy.md); xử lý file phía server →
> [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md).

## Nguyên tắc

1. **Schema là hợp đồng duy nhất** (P5): định nghĩa một lần (Zod/Valibot qua Standard Schema; Pydantic; validator Go; FluentValidation),
   client và server cùng import/sinh; server luôn validate lại (P6) — client validate chỉ để phản hồi nhanh.
2. **Lỗi phải có địa chỉ**: mỗi lỗi gắn với ô (`aria-describedby`, `aria-invalid`), có tóm tắt đầu form, focus về ô lỗi đầu, nói cách sửa.
3. **Không bắt nhập lại, không chặn công cụ hỗ trợ**: autofill đúng `autocomplete`, cho dán mật khẩu/OTP, nhớ dữ liệu giữa các bước.
4. **Form dài không mất dữ liệu**: tự lưu nháp, khôi phục sau reload/mất mạng, cảnh báo khi rời trang có thay đổi.
5. **Upload: client kiểm để báo sớm, server kiểm để tin** (loại thật theo magic bytes, kích thước, quét); có tiến độ, huỷ, resumable khi lớn.
6. **Tiếng Việt vào đúng**: chờ `compositionend` (Telex/VNI), chuẩn hoá NFC, không cắt/so sánh giữa chừng.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Thư viện schema (TS) | **Zod 4.6.7** hoặc **Valibot 1.5.0** (nhỏ hơn, tree-shake), đều theo Standard Schema v1 (`~standard`) | TS full-stack | Backend khác ngôn ngữ → schema nguồn ở backend (OpenAPI/JSON Schema) sinh type + validator client |
| Thư viện form (React) | React Hook Form 7.90.0 + `@hookform/resolvers` 5.9.1 · TanStack Form 1.33.5 · Conform 1.21.2 (progressive enhancement với server action) | App nhiều form | Form 2–3 ô → `<form>` + `FormData` + schema đủ |
| Thời điểm validate | On blur cho ô đơn; on submit toàn form; on change chỉ sau lần lỗi đầu (reward early, punish late) | Mọi form | Validate từng phím ngay từ đầu (gây lỗi giữa chừng khi gõ dấu) |
| Nháp (autosave) | Debounce → lưu server (có phiên) hoặc `localStorage` (không nhạy cảm), kèm phiên bản/`updated_at` để xử lý xung đột | Form dài, nhiều bước | Dữ liệu nhạy cảm (thẻ, mật khẩu, y tế) → không lưu nháp client |
| Upload lớn | Resumable/chunked (tus hoặc multipart S3 presigned) với tiến độ + huỷ | File > vài chục MB, mạng di động | File nhỏ → một request `multipart/form-data` |
| Multi-step | Trạng thái bước trong URL + nháp server; mỗi bước validate schema con | Wizard | Lưu toàn bộ ở client memory (mất khi reload) |

## Checklist

- [ ] `FE-FORM-001` **MUST** Một schema cho mỗi form được import/sinh ở cả client và server; server validate lại mọi request. → Kiểm: test import cùng module schema ở handler server và component; test gửi request bỏ qua client (curl) với dữ liệu sai → 400/422 có lỗi theo field. · Nguồn: P5, P6; Standard Schema v1
- [ ] `FE-FORM-002` **MUST** Mỗi ô nhập có `<label>` gắn chương trình; lỗi gắn qua `aria-describedby` + `aria-invalid="true"`; thông điệp lỗi nói cách sửa. → Kiểm: axe rule `label`, `aria-valid-attr-value`; E2E submit sai → ô có `aria-invalid` và `aria-describedby` trỏ tới phần tử chứa lỗi. · Nguồn: WAI Forms tutorial; WCAG 2.2 SC 3.3.1, 3.3.3
- [ ] `FE-FORM-003` **MUST@L** Sau submit lỗi: focus chuyển tới ô lỗi đầu tiên (hoặc tóm tắt lỗi có `role="alert"` liên kết tới từng ô); tiêu đề/`<title>` phản ánh số lỗi khi xử lý server. → Kiểm: E2E `document.activeElement` là ô lỗi đầu; tóm tắt có link `href="#field-id"`. · Nguồn: WAI Forms tutorial
- [ ] `FE-FORM-004` **MUST@L** Thuộc tính `autocomplete` đúng mục đích cho ô thông tin cá nhân (`name`, `email`, `tel`, `street-address`, `one-time-code`, `new-password`/`current-password`); `type`/`inputmode` phù hợp (`email`, `tel`, `numeric`). → Kiểm: lint/script kiểm input có `autocomplete` trong form đăng ký/thanh toán; axe `autocomplete-valid`. · Nguồn: WCAG 2.2 SC 1.3.5 (H98)
- [ ] `FE-FORM-005` **MUST@L** Không chặn dán/autofill ở ô mật khẩu, OTP; OTP là một ô (không một ký tự mỗi ô chặn dán). → Kiểm: E2E dán chuỗi vào ô mật khẩu/OTP → giá trị đầy đủ; grep `onPaste` return false = 0. · Nguồn: WCAG 2.2 SC 3.3.8
- [ ] `FE-FORM-006` **MUST@L** Dữ liệu đã nhập trong cùng quy trình (multi-step, quay lại bước trước, lỗi server) không bị mất và không phải nhập lại. → Kiểm: E2E điền bước 1 → bước 2 → Quay lại → giá trị còn; lỗi server → form giữ giá trị. · Nguồn: WCAG 2.2 SC 3.3.7
- [ ] `FE-FORM-007` **MUST** Không double-submit: nút gửi vô hiệu + trạng thái đang gửi; mutation tạo mới có idempotency key. → Kiểm: E2E bấm 2 lần → 1 request; server nhận cùng key trả cùng kết quả (xem [`../08-backend/api-design.md`](../08-backend/api-design.md)).
- [ ] `FE-FORM-008` **MUST@L** Upload: client kiểm kích thước/loại để báo sớm; server kiểm loại thật (magic bytes), kích thước, tên file chuẩn hoá, quét mã độc theo chính sách; không tin `Content-Type` client. → Kiểm: test gửi file `.exe` đổi tên `.png` → server từ chối; file > giới hạn → 413 có thông điệp. · Nguồn: [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md)
- [ ] `FE-FORM-009` **MUST@L** Upload có tiến độ (%), huỷ được, lỗi giữa chừng có thử lại; UI không "treo" khi file lớn. → Kiểm: E2E upload file 10 MB với throttle → `role="progressbar"` cập nhật; bấm Huỷ → request abort.
- [ ] `FE-FORM-010` **MUST** Form mutation được bảo vệ CSRF (SameSite cookie + token/`Origin` check phía server). → Kiểm: xem [`../12-security/appsec-web.md`](../12-security/appsec-web.md); E2E POST không token → 403.
- [ ] `FE-FORM-011` **MUST@L** Form dài (> ~10 ô hoặc nhiều bước) tự lưu nháp và khôi phục sau reload/mất mạng; dữ liệu nhạy cảm không lưu nháp client. → Kiểm: E2E điền nửa form → reload → giá trị khôi phục; danh sách field loại trừ nháp trong cấu hình.
- [ ] `FE-FORM-012` **SHOULD** Validate theo nhịp: on blur cho ô, on submit toàn form, on change chỉ sau khi ô đã lỗi; không báo lỗi khi đang gõ dấu (IME: chờ `compositionend`/`isComposing`). → Kiểm: test gõ "Việt" qua composition events → không lỗi giữa chừng; cấu hình `mode: 'onBlur', reValidateMode: 'onChange'` (RHF) hoặc tương đương. · Nguồn: MDN `compositionstart`
- [ ] `FE-FORM-013` **SHOULD** Chuẩn hoá đầu vào ở lớp biên: trim, NFC, số điện thoại/tiền theo [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); không chuẩn hoá mật khẩu. → Kiểm: schema có `.transform(normalizeNFC)` cho text; test "Việt" NFD → NFC.
- [ ] `FE-FORM-014` **SHOULD** Cảnh báo rời trang khi có thay đổi chưa lưu (`beforeunload` + chặn điều hướng SPA), bỏ cảnh báo sau khi lưu thành công. → Kiểm: E2E sửa ô → điều hướng → dialog xác nhận; sau lưu → không dialog.
- [ ] `FE-FORM-015` **SHOULD** Lỗi server theo field ánh xạ về đúng ô (mã lỗi → key field) thay vì một thông điệp chung; lỗi không thuộc field hiện ở tóm tắt. → Kiểm: test response 422 `{ errors: { email: 'EMAIL_TAKEN' } }` → lỗi hiện dưới ô email với microcopy từ bảng mã.
- [ ] `FE-FORM-016` **SHOULD** Ô bắt buộc đánh dấu nhất quán (chữ "bắt buộc" hoặc chú thích dấu *), `required`/`aria-required`; ô tuỳ chọn ít hơn ô bắt buộc (chỉ hỏi cái cần). → Kiểm: axe không vi phạm; review số ô form đăng ký ≤ ngưỡng dự án.
- [ ] `FE-FORM-017` **SHOULD** Thành phần form tuỳ chỉnh (select, date picker, combobox) dùng component headless đã test a11y hoặc native `<select>`/`<input type=date>` khi đủ. → Kiểm: story có test bàn phím; axe không vi phạm (xem [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)).
- [ ] `FE-FORM-018` **SHOULD** Form hoạt động không JS (progressive enhancement) cho luồng cốt lõi khi dùng server action/`<form action>`. → Kiểm: E2E `javaScriptEnabled: false` submit form đăng nhập/liên hệ thành công.
- [ ] `FE-FORM-019` **SHOULD** Test schema bao phủ ca biên: rỗng, khoảng trắng, Unicode, độ dài tối đa, số âm/0, ngày biên, email lạ; dùng property-based test khi phù hợp. → Kiểm: Vitest + fast-check cho schema chính; coverage nhánh schema ≥ ngưỡng dự án (xem [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md)).
- [ ] `FE-FORM-020` **MAY** Honeypot/rate limit cho form công khai (liên hệ, đăng ký) thay CAPTCHA làm bước đầu; CAPTCHA có phương án tiếp cận. → Kiểm: test bot điền honeypot → bị từ chối lặng; CAPTCHA (nếu có) đạt 3.3.8.
- [ ] `FE-FORM-021` **MAY** Mask/format hiển thị (số thẻ, SĐT) không làm sai giá trị gửi đi; lưu giá trị thô. → Kiểm: test giá trị submit không chứa ký tự định dạng.

## Bẫy thường gặp

- **Validate chỉ ở client** ("đã có Zod ở form"): curl bỏ qua tất cả. Server luôn validate cùng schema.
- **Hai schema trôi nhau** (client cho phép 50 ký tự, server 40) → lỗi "không rõ" cho người dùng. Một nguồn.
- **Lỗi chỉ đổi màu viền đỏ**: không chữ, không ARIA → người mù màu/trình đọc màn hình không biết. Chữ + `aria-describedby`.
- **Validate mỗi phím từ đầu**: gõ "a" đã báo "email không hợp lệ"; gõ dấu tiếng Việt báo lỗi ký tự. Blur/submit + chờ composition.
- **OTP 6 ô chặn dán**, mật khẩu cấm paste "vì bảo mật" → vi phạm 3.3.8 và làm người dùng dùng mật khẩu yếu.
- **Reset form sau lỗi server** → mất dữ liệu; chỉ gắn lỗi, giữ giá trị.
- **Tin `file.type`/đuôi file** → upload shell đổi tên; kiểm magic bytes ở server.
- **Upload không tiến độ, không huỷ** trên mạng di động → người dùng tải lại trang, tạo file trùng.
- **Nháp lưu localStorage gồm số thẻ/mật khẩu** → rò rỉ trên máy dùng chung. Loại trừ field nhạy cảm.
- **Submit kép tạo 2 đơn hàng**: thiếu disable + idempotency key.
- **`autocomplete="off"` toàn form "cho sạch"** → phá autofill, trình quản lý mật khẩu; vi phạm 1.3.5 với ô cá nhân.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Zod 4.6.7 / Valibot 1.5.0 (MIT) + Vitest 5.0.4 + fast-check | `vitest run src/schemas` | CI | xanh; ca biên có test |
| Test "schema dùng chung" | test import cùng module ở server handler và form | CI | 1 nguồn |
| `@axe-core/playwright` 4.13.0 (MPL-2.0) + lint a11y (`jsx-a11y/label-has-associated-control`, Biome `a11y`) | quét form ở trạng thái lỗi | CI E2E + lint | 0 vi phạm |
| Playwright 1.64.0 (Apache-2.0) | E2E: focus lỗi đầu, dán OTP/mật khẩu, giữ dữ liệu khi lỗi, double-submit, upload tiến độ/huỷ, `javaScriptEnabled:false` | CI E2E | xanh |
| curl/supertest | gửi payload sai bỏ qua client → 400/422 theo field | CI integration | đúng mã + lỗi theo field |
| Script kiểm `autocomplete` | `node scripts/check-autocomplete.mjs` (đọc JSX/HTML form đăng ký/thanh toán) | CI | mọi ô cá nhân có token hợp lệ |
| Fixture file độc (đổi đuôi, quá cỡ) | test tích hợp upload | CI | từ chối đúng mã |

## Nguồn

- WAI Web Accessibility Tutorials — Forms: User Notifications (`aria-describedby`, tóm tắt lỗi `role="alert"`, focus ô lỗi đầu, `aria-live` polite/assertive): <https://www.w3.org/WAI/tutorials/forms/notifications/> — xác minh 2026-10-13.
- WCAG 2.2: SC 1.3.5 Identify Input Purpose (`autocomplete` H98): <https://www.w3.org/WAI/WCAG22/Understanding/identify-input-purpose.html>; SC 3.3.7 Redundant Entry: <https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html>; SC 3.3.8 Accessible Authentication (cho dán, trình quản lý mật khẩu; OTP từng ô chặn dán = fail): <https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html>; SC 3.3.1, 3.3.3: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- Standard Schema v1 (`~standard`; `StandardSchemaV1`, `StandardJSONSchemaV1`): <https://standardschema.dev/> — xác minh 2026-10-13 (trang không liệt kê thư viện; Zod 4/Valibot 1 tự công bố tương thích — **chưa xác minh trên trang Standard Schema**).
- MDN — `compositionstart` (IME; chờ `compositionend`): <https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionstart_event> — xác minh 2026-10-13.
- Unicode UAX #15 (NFC): <https://unicode.org/reports/tr15/> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): zod 4.6.7 · valibot 1.5.0 · react-hook-form 7.90.0 · @hookform/resolvers 5.9.1 · @tanstack/react-form 1.33.5 · @conform-to/react 1.21.2 · vitest 5.0.4 · @playwright/test 1.64.0 · @axe-core/playwright 4.13.0.
- Khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 5 (validate inline, disable submit, giữ dữ liệu) và Nhóm 2 mục 6 (ca biên, idempotency).
