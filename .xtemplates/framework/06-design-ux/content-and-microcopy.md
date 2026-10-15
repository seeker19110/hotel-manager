---
title: Nội dung, microcopy, ngôn ngữ, tiếng Việt có dấu
kind: module
prefix: UX-CONTENT
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Nội dung, microcopy, ngôn ngữ, tiếng Việt có dấu

> Chữ trên giao diện là một phần của sản phẩm: **tiếng Việt có dấu, chuẩn Unicode NFC, một giọng, một bộ thuật ngữ**,
> thông điệp nói rõ việc gì xảy ra và làm gì tiếp, **không dark pattern**. Đa ngôn ngữ, định dạng số/ngày/tiền →
> [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md); đồng ý/quyền người dùng →
> [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md).

## Nguyên tắc

1. **Tiếng Việt có dấu, mã hoá Unicode (TCVN 6909:2001 ≈ Unicode), chuẩn hoá NFC.** Không chữ không dấu trên UI, không trộn
   dạng tổ hợp/dựng sẵn làm tìm kiếm và so sánh sai.
2. **Một bộ thuật ngữ, một giọng.** Sổ thuật ngữ (`docs/GLOSSARY.md`) là nguồn sự thật; cùng một khái niệm không có hai tên
   ("Giỏ hàng" vs "Giỏ"); giọng nhất quán (xưng "bạn", chủ động, ngắn).
3. **Microcopy nói việc, không nói hệ thống.** Nút ghi động từ + đối tượng ("Lưu thay đổi", không "OK"); lỗi nói nguyên nhân
   + cách sửa; không thuật ngữ nội bộ, mã lỗi trần.
4. **Trung thực và không thao túng.** Không ép chọn, không giấu nút huỷ, không đếm ngược giả, không mặc định bất lợi — vi phạm
   luật ở EU (DSA Art. 25), Mỹ (FTC) và Việt Nam (Luật BVQLNTD 19/2023/QH15 Đ.10).
5. **Chuỗi là dữ liệu, không nằm cứng trong component**: để dịch, kiểm, đếm và sửa một chỗ.

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Nơi đặt chuỗi UI | File message theo ngôn ngữ (`messages/vi.json`, ICU MessageFormat) qua thư viện i18n | Có ≥ 2 ngôn ngữ hoặc dự kiến có | Site tĩnh một ngôn ngữ nhỏ → vẫn tách thành hằng/module, không rải chuỗi trong JSX |
| Xưng hô | "bạn" + ngôi trung tính cho hệ thống ("Chúng tôi") | Sản phẩm đại chúng | Nội bộ/B2B có quy ước riêng → ghi trong GLOSSARY |
| Thông điệp lỗi | Bảng mã lỗi → microcopy (một file), phân nhóm mạng/quyền/dữ liệu/server | Mọi dự án | Không lấy `error.message` của thư viện đưa thẳng lên UI |
| Kiểm chính tả tự động | cspell 10.3.6 + `@cspell/dict-vi-vn` 3.0.7 (MIT) trên file message | Có file message tách riêng | Chuỗi nằm trong code → chạy trên toàn `src/` với từ điển thuật ngữ dự án |
| Dấu câu, số, ngày, tiền | Theo `Intl` locale `vi-VN` (xem 18) | Mọi dự án | Không format tay bằng string concat |

## Checklist

- [ ] `UX-CONTENT-001` **MUST** Mọi chuỗi hiển thị là tiếng Việt có dấu (hoặc đúng ngôn ngữ đích); không chuỗi không dấu kiểu "Dang nhap", "Khong tim thay". → Kiểm: script `check:vi-diacritics` quét file message/`src` với danh sách từ không dấu hay gặp (`dang nhap|khong|thanh cong|loi|tai khoan|mat khau`) = 0 kết quả. · Nguồn: TCVN 6909:2001; QĐ 72/2002/QĐ-TTg
- [ ] `UX-CONTENT-002` **MUST** Chuỗi lưu trữ và so sánh ở dạng Unicode NFC; input tiếng Việt được chuẩn hoá NFC trước khi lưu/tìm kiếm. → Kiểm: test đơn vị `"Việt".normalize('NFD') → normalize('NFC')` khớp giá trị lưu; API lớp biên gọi `normalize('NFC')`. · Nguồn: UAX #15 (rev. 58, Unicode 18.0.0)
- [ ] `UX-CONTENT-003` **MUST@L** Nhãn nút là động từ + đối tượng, không "OK/Có/Không" cho hành động có hậu quả; dialog xác nhận nêu rõ hậu quả. → Kiểm: E2E: dialog xoá có nút text khớp `/^(Xoá|Xóa) /`; grep `>OK<` trong component dialog = 0.
- [ ] `UX-CONTENT-004` **MUST@L** Thông điệp lỗi gồm: điều gì xảy ra + cách sửa/làm gì tiếp; không mã lỗi trần, không thông điệp thư viện. → Kiểm: file `error-messages` là nguồn duy nhất; test snapshot thông điệp cho mỗi mã lỗi; E2E regex không khớp `(Error:|Exception|undefined|null)`.
- [ ] `UX-CONTENT-005` **MUST** Không dark pattern: không mặc định bật tuỳ chọn bất lợi (tự gia hạn, chia sẻ dữ liệu), huỷ dễ bằng đăng ký, không confirmshaming ("Không, tôi không muốn tiết kiệm"), không đếm ngược/khan hiếm giả, không hỏi lại liên tục sau khi đã từ chối. → Kiểm: review checklist dark-pattern trong PR template cho màn hình thanh toán/đăng ký/đồng ý; E2E luồng huỷ gói ≤ số bước luồng đăng ký. · Nguồn: DSA Reg. (EU) 2022/2065 Art. 25; FTC "Bringing Dark Patterns to Light" (09/2022); Luật 19/2023/QH15 Đ.10
- [ ] `UX-CONTENT-006` **MUST** Giá và chi phí hiển thị đầy đủ trước bước xác nhận (thuế, phí, gia hạn); không "phí ẩn" xuất hiện ở bước cuối. → Kiểm: E2E luồng thanh toán: tổng ở bước đầu = tổng ở bước xác nhận. · Nguồn: Luật 19/2023/QH15; FTC 2022
- [ ] `UX-CONTENT-007` **MUST@L** Chuỗi UI không nằm cứng trong component mà ở file message/hằng; không nối chuỗi để ghép câu (dùng ICU plural/select). → Kiểm: lint `no-literal-string` (eslint-plugin-i18next hoặc rule tương đương) trên JSX/template; grep `` `${count} mục` `` = 0. · Nguồn: [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md)
- [ ] `UX-CONTENT-008` **MUST@L** Sổ thuật ngữ `docs/GLOSSARY.md` tồn tại, mỗi khái niệm nghiệp vụ có một thuật ngữ tiếng Việt + tiếng Anh + định nghĩa; UI và tài liệu dùng đúng. → Kiểm: cspell dùng GLOSSARY làm từ điển dự án; script tìm từ cấm (biến thể không chuẩn) = 0.
- [ ] `UX-CONTENT-009` **SHOULD** Chính tả tiếng Việt được kiểm tự động trên file message. → Kiểm: `cspell --locale vi "messages/**/*.json"` 0 lỗi (từ riêng thêm vào `cspell.json`).
- [ ] `UX-CONTENT-010` **SHOULD** Giọng nhất quán: câu ngắn, chủ động, ngôi "bạn"; không viết hoa toàn bộ, không dấu chấm than dồn dập, không biệt ngữ kỹ thuật trên UI người dùng cuối. → Kiểm: hướng dẫn giọng trong `docs/CONTENT-STYLE.md`; review PR có checklist; script cảnh báo chuỗi toàn chữ hoa > 3 từ.
- [ ] `UX-CONTENT-011` **SHOULD** Microcopy trạng thái rỗng/lỗi/thành công có hướng dẫn hành động tiếp theo (xem [`ui-states-and-feedback.md`](ui-states-and-feedback.md)). → Kiểm: story Empty/Error có nút hành động với nhãn động từ.
- [ ] `UX-CONTENT-012` **SHOULD** Văn bản pháp lý/đồng ý viết dễ hiểu, tách khỏi điều khoản dài; nút đồng ý và từ chối ngang nhau về độ nổi bật. → Kiểm: ảnh snapshot banner đồng ý: hai nút cùng kích thước/kiểu; không nút nào bị ẩn dưới "Tuỳ chọn". · Nguồn: DSA Art. 25; [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `UX-CONTENT-013` **SHOULD** Cắt chuỗi dài bằng CSS (`text-overflow`, `line-clamp`) kèm tooltip/tiêu đề đầy đủ; không cắt bằng `substring` làm vỡ ký tự tổ hợp. → Kiểm: grep `.substring(0,|.slice(0,` trên chuỗi hiển thị = 0 hoặc dùng `Intl.Segmenter`.
- [ ] `UX-CONTENT-014` **SHOULD** Nhập liệu tiếng Việt qua IME (Telex/VNI): validate/tìm kiếm chỉ chạy sau `compositionend` hoặc khi `event.isComposing === false`. → Kiểm: test đơn vị/E2E gõ chuỗi có composition không gây lỗi "ký tự không hợp lệ" giữa chừng. · Nguồn: MDN `compositionstart`
- [ ] `UX-CONTENT-015` **SHOULD** Ngày, số, tiền, đơn vị hiển thị theo locale (`vi-VN`: 1.234.567 ₫, 13/10/2026) qua `Intl`; logic tiền tệ theo [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md). → Kiểm: test snapshot format với locale `vi-VN` và `en-US`.
- [ ] `UX-CONTENT-016` **SHOULD** Nội dung do AI tạo được gắn nhãn rõ trong microcopy (xem [`ai-ux.md`](ai-ux.md)). → Kiểm: chuỗi nhãn nằm trong file message với key `ai.generatedLabel`.
- [ ] `UX-CONTENT-017` **MAY** Có bản tiếng Anh song song cho thuật ngữ kỹ thuật trong tài liệu/giao diện quản trị. → Kiểm: GLOSSARY có cột EN.
- [ ] `UX-CONTENT-018` **MAY** Kiểm "dễ đọc" (độ dài câu trung bình, từ hiếm) bằng script cho trang hướng dẫn. → Kiểm: báo cáo độ dài câu trung bình ≤ ngưỡng dự án đặt.

## Bẫy thường gặp

- **Chuỗi không dấu "cho an toàn"** trong DB/URL rồi lọt lên UI. Slug không dấu chỉ dùng cho URL; tên hiển thị luôn có dấu.
- **NFD vs NFC lẫn lộn** (macOS/một số IME sinh NFD): tìm "Việt" không ra "Việt". Chuẩn hoá NFC ở lớp biên và trước khi index.
- **Font thiếu glyph** → dấu rơi sang font khác, chữ "ỡ" lệch cao độ. Xem [`design-system-and-tokens.md`](design-system-and-tokens.md).
- **Ghép câu bằng nối chuỗi** (`"Bạn có " + n + " tin nhắn"`) không dịch được số nhiều/ngữ pháp ngôn ngữ khác; dùng ICU.
- **Lấy `error.message` của thư viện** đưa lên UI: lộ nội bộ, tiếng Anh lẫn tiếng Việt.
- **Nút "OK/Huỷ" cho hành động xoá** — người dùng không biết OK làm gì. Động từ + đối tượng.
- **Confirmshaming và pre-checked** vì "tăng chuyển đổi": vi phạm pháp luật và mất niềm tin; kiểm bằng checklist trong PR.
- **Validate ngay trong lúc gõ dấu** (Telex: "a" → "á" → "ấ") báo lỗi giữa chừng. Chờ `compositionend`.
- **Thuật ngữ đổi theo người viết** ("Đơn hàng"/"Order"/"Đơn") → người dùng và support hiểu khác nhau. GLOSSARY + cspell.
- **Cắt chuỗi bằng `substring`** làm vỡ ký tự tổ hợp/emoji. Dùng CSS hoặc `Intl.Segmenter`.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| cspell 10.3.6 + `@cspell/dict-vi-vn` 3.0.7 (MIT) | `cspell --config cspell.json "messages/**/*.json" "docs/**/*.md"` | pre-commit + CI | 0 lỗi (từ riêng khai báo trong `cspell.json`) |
| Script `check:vi-diacritics` tự viết (regex từ không dấu hay gặp) | `node scripts/check-vi-diacritics.mjs messages src` | pre-commit | 0 kết quả |
| Lint chuỗi cứng (`eslint-plugin-i18next` rule `no-literal-string` hoặc rule tương đương của framework) | `eslint src --rule 'i18next/no-literal-string: error'` | CI | 0 vi phạm trong JSX/template |
| Test NFC (Vitest 5.0.4) | `vitest run src/lib/normalize.test.ts` | CI | xanh |
| Playwright 1.64.0 | E2E huỷ gói/đăng ký, thanh toán (tổng không đổi), dialog xoá có động từ | CI E2E | xanh |
| PR template checklist dark-pattern (5 mục) | review người | PR màn hình thanh toán/đồng ý | reviewer tick có bằng chứng ảnh |

Phiên bản/liên kết `eslint-plugin-i18next` **(chưa xác minh ngày 2026-10-13)** — kiểm registry trước khi dùng.

## Nguồn

- Unicode UAX #15 Unicode Normalization Forms (rev. 58, Unicode 18.0.0, 2026-08-12; W3C khuyến nghị NFC cho nội dung): <https://unicode.org/reports/tr15/> — xác minh 2026-10-13.
- TCVN 6909:2001 (bộ mã ký tự tiếng Việt 16-bit, dựa trên ISO/IEC 10646/Unicode) và Quyết định 72/2002/QĐ-TTg ngày 10/06/2002 (thống nhất dùng TCVN 6909:2001 trong trao đổi thông tin điện tử của cơ quan Đảng, Nhà nước; hiệu lực 01/01/2003): <https://moit.gov.vn/van-ban-phap-luat/van-ban-phap-quy/-quyet-dinh-cua-thu-tuong-chinh-phu-ve-viec-thong-nhat-dung-.html> — xác minh 2026-10-13 (nguồn thứ cấp caselaw.vn ghi cùng ngày); kiểm tra văn bản sửa đổi trước khi trích.
- Luật Bảo vệ quyền lợi người tiêu dùng số 19/2023/QH15 (hiệu lực 01/07/2024), Điều 10 khoản 3 (hành vi cấm với nền tảng số: ép buộc/ngăn cản dùng nền tảng khác, hạn chế lựa chọn không công khai tiêu chí, chặn đánh giá, cài sẵn/ép cài ứng dụng): <https://hethongphapluat.com/luat-bao-ve-quyen-loi-nguoi-tieu-dung-2023/khoan-3-dieu-10> — xác minh 2026-10-13 qua nguồn thứ cấp; bản trên vanban.chinhphu.vn **(chưa truy cập được ngày 2026-10-13)**; kiểm tra văn bản sửa đổi.
- Regulation (EU) 2022/2065 (Digital Services Act) Article 25 "Online interface design and organisation" (cấm giao diện lừa dối/thao túng; ví dụ: làm nổi bật lựa chọn, hỏi lại nhiều lần, huỷ khó hơn đăng ký): <https://eur-lex.europa.eu/eli/reg/2022/2065/oj> — **nội dung chưa xác minh**: eur-lex trả trang trống qua WebFetch ngày 2026-10-13; số hiệu/điều khoản theo kiến thức chuẩn, đối chiếu bản gốc trước khi trích.
- FTC — "Bringing Dark Patterns to Light" (báo cáo 09/2022): (link gốc 404, chưa tìm được bản thay — 2026-10-14).
- MDN — `compositionstart` (IME, chờ `compositionend`): <https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionstart_event> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): cspell 10.3.6 · @cspell/dict-vi-vn 3.0.7 · vitest 5.0.4 · @playwright/test 1.64.0.
- Nguyên tắc P11 (tôn trọng người dùng, không dark pattern): [`../00-method/principles.md`](../00-method/principles.md).
