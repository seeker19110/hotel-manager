---
title: Quốc tế hoá & bản địa hoá: chuỗi, số/ngày/tiền, RTL, tiếng Việt
kind: module
prefix: XC-I18N
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo, api-service, ai-agent, agentic-system, data-ml, blockchain]
updated: 2026-10-14
---

# Quốc tế hoá & bản địa hoá: chuỗi, số/ngày/tiền, RTL, tiếng Việt

> Làm sản phẩm chạy đúng cho người dùng ở mọi ngôn ngữ/locale mà không viết lại: chuỗi tách khỏi mã, số nhiều và
> định dạng theo CLDR/ICU, thẻ ngôn ngữ BCP 47, bố cục chịu được RTL và văn bản dài hơn 30–300 %, và các đặc thù tiếng
> Việt (NFC, font, tên, `vi-VN`). Biểu diễn **lưu trữ** thời gian/tiền là nhà của
> [`units-time-and-money.md`](units-time-and-money.md); a11y ở [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md);
> nội dung/microcopy ở [`../06-design-ux/content-and-microcopy.md`](../06-design-ux/content-and-microcopy.md).

## Nguyên tắc

- **i18n là kiến trúc, l10n là nội dung**: làm i18n từ đầu (rẻ), thêm ngôn ngữ sau (chỉ là dữ liệu).
- **Không nối chuỗi, không giả định ngữ pháp**: thứ tự từ, số nhiều, giống, dạng xưng hô khác nhau theo ngôn ngữ — mọi
  câu là một thông điệp có tham số (ICU MessageFormat).
- **Dữ liệu thô đi qua, định dạng ở lớp trình bày**: API trả số/ngày/tiền dạng chuẩn; client định dạng theo locale của
  người xem bằng CLDR (Intl/ICU), không tự viết.
- **Locale là của người dùng, không của máy chủ**: xác định từ hồ sơ → `Accept-Language` → mặc định; không lấy từ
  `LANG` của server hay vị trí IP.
- **Tiếng Việt là "first-class"**: NFC, dấu thanh, họ–đệm–tên, định dạng `1.234.567,89 ₫`, `dd/MM/yyyy`.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Định dạng thông điệp | **ICU MessageFormat** (`{count, plural, one {…} other {…}}`); MessageFormat 2.0 (Unicode LDML, ổn định) khi thư viện hỗ trợ. | Template chuỗi tự chế `%s`/`{0}` không có plural/select. |
| Thư viện | JS/TS: `@formatjs/intl` 6.x / `react-intl`, `i18next` 26.x (+ ICU plugin), `next-intl` 4.x, `@lingui/core` 6.x · Python: `babel` 2.18 (CLDR) + `gettext` · Java: ICU4J/`MessageFormat` · Go: `golang.org/x/text` · .NET: resx + `CultureInfo`. | Thư viện không dựa trên CLDR cho số/ngày. |
| Định dạng số/ngày/tiền | Nền tảng: `Intl.NumberFormat`/`DateTimeFormat`/`RelativeTimeFormat`/`ListFormat` (ECMA-402), ICU, `Babel`, `java.text`/ICU4J; dữ liệu CLDR 48.x. | Chuỗi định dạng hard-code `dd/MM/yyyy`, `toFixed(2)`, tự chèn dấu phân cách. |
| Khoá thông điệp | Khoá ngữ nghĩa ổn định (`checkout.pay_button`) + mô tả ngữ cảnh cho người dịch; nguồn gốc tiếng Việt hoặc Anh là **một** ngôn ngữ nguồn được chọn. | Dùng câu nguồn làm khoá (đổi dấu chấm là mất bản dịch). |
| Định tuyến locale (web) | Tiền tố đường dẫn `/vi/`, `/en/` + `hreflang`; cookie ghi nhớ; `<html lang="vi">`. | Chỉ dùng cookie/Accept-Language → SEO không index được bản dịch. |
| Bố cục RTL | CSS logical properties (`margin-inline-start`), `dir="rtl"` ở gốc, icon có hướng phản chiếu. | `margin-left/right` cứng — chỉ khi chắc chắn không bao giờ có RTL (ghi ADR). |

## Checklist

- [ ] `XC-I18N-001` **MUST** Mọi chuỗi người dùng thấy (UI, email, thông báo đẩy, lỗi, PDF) nằm trong **file tài nguyên** (`messages/<locale>.json`, `.po`, `.resx`, `.arb`), không hard-code trong mã; chuỗi nguồn có mô tả ngữ cảnh. → Kiểm: lint "no literal string in JSX/template" (`i18next/no-literal-string`, `formatjs/enforce-description`); script trích khoá so với file nguồn = 0 khoá thiếu. · Nguồn: W3C i18n Best Practices (localization)
- [ ] `XC-I18N-002` **MUST@L** Không **nối chuỗi** để tạo câu; thông điệp có tham số, **số nhiều** và **select** theo ICU MessageFormat; mỗi ngôn ngữ dùng đúng tập dạng số nhiều CLDR (tiếng Việt chỉ `other`, tiếng Anh `one/other`, Ả Rập 6 dạng). → Kiểm: lint cấm `+`/template literal với chuỗi i18n; test render `{count, plural}` với 0/1/2/5/21 cho `vi`, `en`, `ar`. · Nguồn: Unicode CLDR plural rules; ICU MessageFormat
- [ ] `XC-I18N-003` **MUST** Số, ngày/giờ, tiền, danh sách, thời gian tương đối định dạng bằng **CLDR/Intl/ICU** theo locale người dùng; không có chuỗi định dạng cứng. → Kiểm: grep không có `toFixed(`, `toLocaleDateString()` không tham số, `strftime('%d/%m/%Y')` ở lớp UI; test `vi-VN`: `1234567.89 → "1.234.567,89"`, `VND → "1.234.568 ₫"`, ngày `13/10/2026`; `en-US`: `"1,234,567.89"`, `10/13/2026`. · Nguồn: ECMA-402 (Intl.NumberFormat, DateTimeFormat); CLDR 48.2
- [ ] `XC-I18N-004` **MUST@L** Thẻ ngôn ngữ theo **BCP 47** (`vi`, `vi-VN`, `en-US`, `zh-Hant-TW`) ở API, CSDL, URL, `<html lang>`, `Content-Language`; không dùng mã tự chế (`vn`, `VI_vn`). → Kiểm: schema cột `locale` validate regex BCP 47 hoặc `Intl.getCanonicalLocales`; test `vn` bị từ chối; HTML có `lang` đúng. · Nguồn: RFC 5646 (BCP 47)
- [ ] `XC-I18N-005` **MUST** Mã hoá UTF-8 đầu–cuối và chuỗi người nhập **chuẩn hoá NFC** (tiếng Việt gõ Telex/VNI/Unikey có thể ra dạng tổ hợp); tìm kiếm không phân biệt dấu/hoa thường dùng case-fold + bỏ dấu có chủ ý. → Kiểm: test nhập "Việt" NFD và NFC → một bản ghi; tìm "viet" ra "Việt" nếu spec yêu cầu bỏ dấu; chi tiết [`../01-baseline/data-correctness.md`](../01-baseline/data-correctness.md). · Nguồn: UAX #15 rev. 58; W3C i18n (encoding)
- [ ] `XC-I18N-006` **MUST@L** Bố cục chịu được **giãn văn bản**: chuỗi ngắn (≤ 10 ký tự) có thể dài 200–300 %, chuỗi dài 130 %; không cắt chữ, không tràn, không nút cố định chiều rộng theo chữ tiếng Anh; chữ Việt có dấu cần line-height ≥ 1.4 để không cắt dấu. → Kiểm: test pseudo-localization (`[!!! Ţĥîš îš ä ţéšţ !!!]`) + screenshot/visual regression ở 390 px không tràn; CSS không có `height` cố định cho hộp chữ. · Nguồn: W3C i18n "Text size in translation" (bảng IBM)
- [ ] `XC-I18N-007` **MUST@L** Form tên người: không bắt buộc "họ" + "tên" tách theo mẫu phương Tây; hỗ trợ tên một từ, tên dài, ký tự ngoài ASCII, không ép hoa/thường; tiếng Việt: họ–đệm–tên, xưng hô bằng **tên** (ông Dũng, không phải ông Nguyễn). → Kiểm: test nhập `"Nguyễn Tấn Dũng"` hiển thị xưng hô đúng theo locale; validate không từ chối tên 1 ký tự hay có dấu nháy/gạch nối. · Nguồn: W3C i18n "Personal names around the world"
- [ ] `XC-I18N-008` **MUST@L** Locale/múi giờ xác định theo thứ tự: tuỳ chọn trong hồ sơ → `Accept-Language`/thiết bị → mặc định; người dùng đổi được ngôn ngữ trong ứng dụng mà không đổi hệ điều hành; email/thông báo nền dùng locale **của người nhận**. → Kiểm: test gửi email cho người `vi` và người `en` từ cùng sự kiện → hai ngôn ngữ; không đọc `process.env.LANG` để chọn ngôn ngữ UI. · Nguồn: RFC 5646 §4.1 (language matching); W3C i18n (language)
- [ ] `XC-I18N-009` **MUST** File dịch được **validate trong CI**: mọi locale có đủ khoá của nguồn (hoặc fallback khai báo), đúng cú pháp ICU, cùng tập tham số với nguồn (`{name}` không bị mất/đổi tên), không có HTML/script lạ chèn vào. → Kiểm: `formatjs compile`/`i18next-parser --fail-on-warnings`/`lingui compile --strict`/`pybabel compile --statistics` + script so khoá = 0 lỗi. · Nguồn: P6 (file dịch cũng là đầu vào)
- [ ] `XC-I18N-010` **MUST@L** Hỗ trợ **RTL** nếu có ngôn ngữ RTL trong lộ trình: `dir` ở gốc theo ngôn ngữ, CSS logical properties, icon định hướng phản chiếu, số/ngày trong văn bản RTL dùng bidi isolation (`<bdi>`, `unicode-bidi: isolate`). → Kiểm: stylelint `csstools/use-logical` 0 vi phạm; screenshot `ar` không vỡ; test chuỗi trộn số–chữ RTL hiển thị đúng thứ tự. · Nguồn: W3C i18n Best Practices (text direction, bidi)
- [ ] `XC-I18N-011` **MUST@L** Font và bộ ký tự bao phủ mọi ngôn ngữ hỗ trợ: font tiếng Việt có đủ glyph dấu tổ hợp (ví dụ Inter, Noto Sans, Be Vietnam Pro), fallback cho CJK/Ả Rập; không để tofu (□). → Kiểm: test render chuỗi `"Ắ Ầ Ẫ Ậ Ế Ệ Ỗ Ợ Ữ Ự"` và mẫu CJK/Arabic trong screenshot; `font-display` + subset có tiếng Việt (`unicode-range` chứa U+1EA0–1EF9). · Nguồn: W3C i18n (typography); Unicode 18.0.0
- [ ] `XC-I18N-012` **SHOULD** Sắp xếp và lọc danh sách theo **collation của locale** (`Intl.Collator('vi')`, ICU, CSDL `COLLATE`), không theo byte; tìm kiếm tiếng Việt xử lý cả có dấu/không dấu theo spec. → Kiểm: test sắp xếp tên Việt đúng thứ tự từ điển (xem [`units-time-and-money.md`](units-time-and-money.md) XC-UNITS-012). · Nguồn: UTS #10 rev. 55
- [ ] `XC-I18N-013` **SHOULD** Nội dung dịch có **quy trình**: ngôn ngữ nguồn duy nhất, nền tảng/định dạng trao đổi chuẩn (XLIFF/`.po`/JSON ICU), review bởi người bản ngữ cho ngôn ngữ phát hành; bản dịch máy (kể cả LLM) phải được đánh dấu và review trước khi lên production. → Kiểm: file dịch có metadata `reviewed_by`/trạng thái; CI chặn locale có khoá `machine-translated: true` chưa review ở nhánh phát hành. · Nguồn: P11; [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md)
- [ ] `XC-I18N-014` **SHOULD** Web: URL có tiền tố locale (`/vi/…`, `/en/…`) hoặc domain riêng, `hreflang` + `x-default`, sitemap theo ngôn ngữ; không chỉ dựa cookie. → Kiểm: `curl -I /vi/` 200; HTML có `<link rel="alternate" hreflang="vi">`; Lighthouse SEO không cảnh báo `hreflang`. · Nguồn: [`../07-frontend/rendering-and-routing.md`](../07-frontend/rendering-and-routing.md)
- [ ] `XC-I18N-015` **SHOULD** Ảnh, icon, màu, ví dụ, đơn vị đo (km/mi, °C/°F, A4/Letter), định dạng địa chỉ và số điện thoại (E.164 lưu trữ, hiển thị theo quốc gia) theo locale; không nhúng chữ vào ảnh. → Kiểm: review checklist; test số điện thoại `+84` hiển thị `0xx xxx xxxx` ở `vi-VN`; thư viện `libphonenumber`. · Nguồn: W3C i18n (locale-sensitive data)
- [ ] `XC-I18N-016` **SHOULD** Test **pseudo-localization** và ít nhất một locale thật khác nguồn chạy trong CI (E2E render các màn chính) để bắt chuỗi hard-code, tràn, khoá thiếu trước khi dịch thật. → Kiểm: job E2E với `locale=qps-ploc` (hoặc `en-XA`) và `vi`/`en` xanh. · Nguồn: [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md)
- [ ] `XC-I18N-017` **SHOULD** Với sản phẩm có AI/LLM: prompt hệ thống, guardrail và eval có phiên bản **theo ngôn ngữ**; chất lượng tiếng Việt được đo riêng (không suy ra từ tiếng Anh); đầu ra giữ nguyên dấu tiếng Việt và không "dịch ngược" tên riêng. → Kiểm: bộ eval có tập tiếng Việt với ngưỡng riêng; test đầu ra NFC. · Nguồn: [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md); catalog 18 §4b–4c
- [ ] `XC-I18N-018` **MAY** Dùng MessageFormat 2.0 (LDML) khi stack hỗ trợ (ICU 75+, `Intl.MessageFormat` khi có) để thống nhất cú pháp đa nền tảng. → Kiểm: thư viện hỗ trợ MF2; test cú pháp MF2 trong CI. · Nguồn: Unicode MessageFormat WG
- [ ] `XC-I18N-019` **MAY** Nội dung do người dùng tạo lưu kèm `lang` (BCP 47) phát hiện/khai báo để dịch, đọc màn hình (`lang` attribute) và tìm kiếm đúng ngôn ngữ. → Kiểm: schema bài viết có cột `lang`; HTML render có `lang` trên khối nội dung. · Nguồn: W3C i18n (identifying language of content)

## Bẫy thường gặp

- **"Chỉ làm tiếng Việt, i18n sau"** → chuỗi hard-code khắp nơi, chi phí tách gấp 10. Tách chuỗi từ ngày đầu kể cả một ngôn ngữ.
- **`"Bạn có " + n + " tin nhắn"`** — tiếng Anh cần `1 message / 2 messages`, tiếng Ả Rập 6 dạng. ICU plural.
- **Khoá là câu nguồn**: sửa dấu phẩy trong nguồn → mọi bản dịch mất. Khoá ngữ nghĩa ổn định.
- **`toLocaleString()` không tham số** lấy locale của **máy chủ** (thường `en-US`) khi render phía server → người Việt thấy `1,234.5`. Truyền locale tường minh.
- **Tiếng Việt NFD từ bàn phím macOS/Unikey** vs NFC từ Windows → hai "Việt" khác nhau trong CSDL. NFC ở biên.
- **Font web subset chỉ `latin`** → dấu tiếng Việt thành tofu hoặc fallback font khác, nhảy chữ. Subset `vietnamese` (`unicode-range`).
- **`line-height: 1`** cắt dấu `Ậ`, `Ễ`. ≥ 1.4 cho tiếng Việt.
- **Form "First name / Last name"** → người Việt điền ngược, hệ thống gọi "ông Nguyễn". Một trường tên đầy đủ + trường "muốn được gọi là".
- **`margin-left` cứng** → RTL vỡ toàn bộ. Logical properties ngay từ đầu, kể cả chưa có RTL.
- **Dịch máy đẩy thẳng lên production** → sai nghĩa pháp lý/thanh toán. Đánh dấu + review người bản ngữ.
- **Email nền dùng locale của worker** (`en`) thay vì của người nhận. Locale là thuộc tính của người nhận.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Chuỗi hard-code | `eslint-plugin-i18next` `no-literal-string` (MIT) · `eslint-plugin-formatjs` (MIT) · `@lingui/cli extract` (MIT) · `pybabel extract` (BSD-3) | `lint` | hook + CI | 0 |
| Khoá thiếu/thừa, cú pháp ICU | `i18next-parser --fail-on-warnings` · `formatjs compile --ast` · `lingui compile --strict` · script so khoá | `i18n:check` | CI | 0 khoá thiếu, 0 lỗi cú pháp |
| Tham số lệch giữa locale | script so tập `{param}` nguồn vs đích | `i18n:check` | CI | 0 |
| Định dạng cứng | ESLint `no-restricted-syntax` (`toFixed`, `toLocaleDateString()` không args) · ruff/Semgrep rule | `lint` | CI | 0 ở lớp UI |
| CSS logical | stylelint `csstools/use-logical` (MIT) | `stylelint "**/*.css"` | CI | 0 |
| Giãn chữ / RTL / font | Playwright (Apache-2.0) screenshot `qps-ploc`, `ar`, `vi` ở 390 px + `toHaveScreenshot` | `test:e2e` | CI | không tràn/tofu |
| BCP 47 | validate schema (`Intl.getCanonicalLocales`, `langcodes` Python) | `test` | CI | tag sai bị từ chối |
| NFC | test tích hợp | `test` | CI | pass |

## Nguồn

- W3C Internationalization Best Practices for Spec Developers (Group Note, 2026-08-07): <https://www.w3.org/TR/international-specs/> — xác minh 2026-10-13
- W3C i18n — Text size in translation (bảng giãn chữ IBM 130–300 %): <https://www.w3.org/International/articles/article-text-size> — xác minh 2026-10-13
- W3C i18n — Personal names around the world (ví dụ tiếng Việt: "Mr. Dũng"): <https://www.w3.org/International/questions/qa-personal-names> — xác minh 2026-10-13
- W3C i18n — Declaring character encodings in HTML: <https://www.w3.org/International/questions/qa-html-encoding-declarations> — xác minh 2026-10-13
- RFC 5646 / BCP 47 Tags for Identifying Languages (2009): <https://www.rfc-editor.org/rfc/rfc5646> — xác minh 2026-10-13
- Unicode CLDR 48.2 (2026-03-17; CLDR 49 beta 2026-09-25): <https://cldr.unicode.org/> — xác minh 2026-10-13; ICU 78.3 (2026-03-17): <https://icu.unicode.org/> — xác minh 2026-10-13
- Unicode MessageFormat 2.0 (ổn định, một phần LDML/TR35; vài hàm mặc định còn Draft): <https://github.com/unicode-org/message-format-wg> — xác minh 2026-10-13
- ECMA-402 14th ed. draft (Intl.NumberFormat, DateTimeFormat, PluralRules, Collator, ListFormat, RelativeTimeFormat, DurationFormat, Segmenter, DisplayNames, Locale): <https://tc39.es/ecma402/> — xác minh 2026-10-13
- UAX #15 rev. 58 (NFC) · UTS #10 rev. 55 (collation) · Unicode 18.0.0 (2026-09-16): <https://unicode.org/reports/tr15/>, <https://unicode.org/reports/tr10/>, <https://www.unicode.org/versions/Unicode18.0.0/> — xác minh 2026-10-13
- Phiên bản thư viện (npm/PyPI, xác minh 2026-10-13): `@formatjs/intl` 6.1.3, `i18next` 26.4.4, `next-intl` 4.14.9, `@lingui/core` 6.9.1 (MIT); `babel` 2.18.0 (BSD-3-Clause)
- Khung cũ X-stored `quality-supplements.md` PHẦN 4 §1 (next-intl, `useFormatter`), commit `1b80fe4`; catalog `seeker19110/stored` 18 §4b–4c (hệ sinh thái tiếng Việt: embedding BKAI, VieNeu-TTS), đọc 2026-10-13.
