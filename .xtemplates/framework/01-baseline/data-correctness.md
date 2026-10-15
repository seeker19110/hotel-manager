---
title: Đúng dữ liệu: thời gian, tiền, đơn vị, mã hoá ký tự, ca biên
kind: baseline
prefix: BASE-DATA
applies_to: [all]
updated: 2026-10-14
---

# Đúng dữ liệu: thời gian, tiền, đơn vị, mã hoá ký tự, ca biên

> Sàn "đúng nghiệp vụ" mà type-checker không bắt được: mã hoá UTF-8 và chuẩn hoá Unicode, phân biệt `null`/rỗng/0,
> ca biên và tràn số, validate ngữ nghĩa ở biên, idempotency cho ghi. Quy tắc **chi tiết** về thời gian, tiền, đơn vị,
> ID và so sánh chuỗi là nhà của [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md);
> idempotency, outbox, saga là nhà của [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md)
> — ở đây chỉ giữ **sàn cho mọi quy mô** (kể cả S, ADR-0003) và trỏ; **cách test** ca biên là nhà của
> [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md).

## Nguyên tắc

- **Đúng › an toàn › ít hơn › kiểm được › nhanh** (P3): mất/sai dữ liệu đắt hơn mọi thứ khác.
- **Một biểu diễn chuẩn cho mỗi loại dữ liệu** ở ranh giới lưu trữ và trao đổi: UTF-8, NFC, UTC RFC 3339, số nguyên
  đơn vị nhỏ nhất cho tiền, đơn vị ghi trong tên.
- **"Không có" ≠ "bằng 0" ≠ "rỗng"**: ba trạng thái khác nhau, kiểu dữ liệu phải phân biệt được.
- **Ca biên là ca thường**: rỗng, một phần tử, rất nhiều, giá trị cực, ký tự lạ, cùng lúc — mỗi nhánh logic phức tạp có
  ít nhất một test ca biên.
- **Ghi hai lần phải cho cùng kết quả** (idempotency) vì mạng, người dùng và agent đều gửi lại.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Mã hoá ký tự | **UTF-8** mọi nơi: mã nguồn, CSDL (`utf8mb4` với MySQL, `UTF8` Postgres), HTTP (`charset=utf-8`), file, JSON (RFC 8259 bắt buộc UTF-8). | Giao thức cũ bắt buộc mã hoá khác → chuyển đổi ở biên, ghi ADR. |
| Chuẩn hoá Unicode | **NFC** khi lưu và so sánh chuỗi người nhập (tên, tag, username); tiếng Việt gõ Telex/VNI có thể sinh dạng tổ hợp (NFD) → phải chuẩn hoá. | NFKC/NFKD chỉ cho mục đích tìm kiếm/so khớp định danh, không ghi đè dữ liệu gốc (xoá phân biệt có nghĩa). |
| Số nguyên lớn | JSON số nguyên ngoài ±(2^53−1) → truyền dạng **chuỗi**; JS dùng `BigInt`; ID 64-bit luôn là chuỗi trên dây. | Hệ chỉ Java/Go/Python nội bộ dùng int64 trong binary protocol (protobuf) thì giữ số. |
| Thập phân | Tiền: mặc định số nguyên đơn vị nhỏ nhất (`amount_minor` + `currency`); `DECIMAL(p,s)` scale cố định chỉ khi có ADR (`XC-UNITS-005`); khoa học/đo lường: float64 có ghi sai số. | Không bao giờ float cho tiền, tỷ lệ phần trăm có làm tròn, hay so sánh bằng. |
| Validate ở đâu | Syntactic (kiểu/định dạng) + semantic (phạm vi, quan hệ: `end > start`, tồn kho ≥ 0) tại **biên tiến trình**; ràng buộc nhất quán quan trọng lặp lại ở **CSDL** (`CHECK`, `UNIQUE`, FK). | Không validate lại ở mỗi hàm nội bộ; CSDL không thay cho validate ở biên (thông điệp lỗi xấu). |

## Checklist

- [ ] `BASE-DATA-001` **MUST** Mọi file mã nguồn, cấu hình, template và dữ liệu văn bản là UTF-8 (không BOM, trừ nơi bắt buộc); CSDL và kết nối khai báo UTF-8 (`utf8mb4`/`UTF8`); HTTP response có `charset=utf-8`. → Kiểm: `.editorconfig` `charset = utf-8`; `file --mime-encoding` trên repo không có `iso-8859`/`utf-16`; test tích hợp lưu và đọc lại chuỗi `"Tiếng Việt 🇻🇳"` nguyên vẹn. · Nguồn: RFC 8259 §8.1; W3C i18n (UTF-8 declarations)
- [ ] `BASE-DATA-002` **MUST** Chuỗi do người nhập được **chuẩn hoá NFC ở biên trước khi lưu** (sàn mọi quy mô); so sánh làm khoá (NFC + case-fold) và sắp xếp theo locale theo [`XC-UNITS-012`](../18-cross-cutting/units-time-and-money.md). → Kiểm: test: `"Việt"` dạng NFD và NFC nhập vào được lưu thành cùng một chuỗi NFC; `unicodedata.normalize`/`String.prototype.normalize`/`golang.org/x/text/unicode/norm` xuất hiện ở lớp validate. · Nguồn: UAX #15 (rev. 58, Unicode 18.0.0); OWASP Input Validation CS (normalization)
- [ ] `BASE-DATA-003` **MUST** Phân biệt **thiếu** (`null`/`None`/`undefined`), **rỗng** (`""`, `[]`) và **0/false** trong kiểu dữ liệu, schema CSDL và API; không dùng `||`/`or` để lấy mặc định cho giá trị có thể hợp lệ là 0/rỗng. → Kiểm: lint `strict-boolean-expressions`/`prefer-nullish-coalescing` (TS), `pyright strictOptional`; test cho đầu vào `0`, `""`, `[]`, `null` ở mỗi trường số/chuỗi/danh sách tuỳ chọn. · Nguồn: khung cũ `quality-supplements.md` N2 §6
- [ ] `BASE-DATA-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-SEC-001`](security-minimum.md): validate đầu vào ở biên theo allowlist/schema (kiểu, phạm vi, ngữ nghĩa, quan hệ `end ≥ start`); chi tiết web ở `SEC-WEB-002`.
- [ ] `BASE-DATA-005` **MUST** Sàn mọi quy mô cho tiền: **không bao giờ float/double**, luôn kèm mã ISO 4217; cách biểu diễn (mặc định số nguyên đơn vị nhỏ nhất, decimal scale cố định chỉ khi có ADR), làm tròn và phân bổ theo [`XC-UNITS-005`](../18-cross-cutting/units-time-and-money.md) đến `XC-UNITS-007`. → Kiểm: schema CSDL không có cột tiền kiểu `FLOAT/REAL/DOUBLE`; lint cấm `parseFloat`/`float(` ở module tiền. · Nguồn: [`XC-UNITS-005`](../18-cross-cutting/units-time-and-money.md)
- [ ] `BASE-DATA-006` **MUST** Sàn mọi quy mô cho thời gian: thời điểm lưu/trao đổi bằng **UTC** với kiểu có múi giờ, định dạng RFC 3339; múi giờ IANA, sự kiện tương lai, đồng hồ đơn điệu theo [`XC-UNITS-001`](../18-cross-cutting/units-time-and-money.md) đến `XC-UNITS-004`. → Kiểm: schema không có `timestamp without time zone` cho thời điểm; lint cấm `datetime.now()` naive/`new Date().toString()` ở lớp lưu. · Nguồn: [`XC-UNITS-001`](../18-cross-cutting/units-time-and-money.md)
- [ ] `BASE-DATA-007` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-UNITS-010`](../18-cross-cutting/units-time-and-money.md): số nguyên 64-bit không đi qua JSON dạng số (chuỗi/`BigInt`), phép cộng tiền có kiểm tràn.
- [ ] `BASE-DATA-008` **MUST** Sàn mọi quy mô: thao tác ghi có thể bị gửi lại (tạo đơn/thanh toán, webhook, job, tool của agent) là **idempotent** — nhận lại cùng yêu cầu → cùng kết quả, không tạo bản ghi/tính tiền thứ hai; cơ chế (khoá idempotency, `UNIQUE`) theo [`ARC-INT-001`](../05-architecture/integration-patterns.md). → Kiểm: test gửi cùng request hai lần (và đồng thời) → một bản ghi, cùng response. · Nguồn: [`ARC-INT-001`](../05-architecture/integration-patterns.md); catalog 23 §4.1 (SePay HMAC + idempotent)
- [ ] `BASE-DATA-009` **MUST** Sàn mọi quy mô: thao tác nhiều bước trên dữ liệu là **tất cả hoặc không** — transaction CSDL trong một kho; xuyên kho/dịch vụ hoặc có tác động ra ngoài thì outbox/saga có bù trừ theo [`ARC-INT-003`](../05-architecture/integration-patterns.md) và `ARC-INT-006`; không để trạng thái nửa vời. → Kiểm: test giả lỗi ở bước giữa → không có bản ghi mồ côi. · Nguồn: P3; [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md)
- [ ] `BASE-DATA-010` **MUST** Ràng buộc nhất quán quan trọng (duy nhất, khoá ngoại, không âm, enum) được **CSDL/kho** thực thi, không chỉ ở mã ứng dụng. → Kiểm: schema/migration có `UNIQUE`, `FK`, `CHECK`; test chèn vi phạm trực tiếp vào CSDL bị từ chối. · Nguồn: [`../09-database/data-modeling.md`](../09-database/data-modeling.md)
- [ ] `BASE-DATA-011` **SHOULD** Mỗi nhánh logic nghiệp vụ phức tạp (tính giá, phân trang, lịch, quyền) có ≥ 1 test **ca biên**: rỗng, một, nhiều, giá trị cực, off-by-one, ký tự Unicode/emoji, đồng thời. → Kiểm: review checklist + coverage nhánh; cách test ở [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md). · Nguồn: khung cũ `quality-supplements.md` N2 §6
- [ ] `BASE-DATA-012` **SHOULD** Độ dài chuỗi giới hạn theo **ký tự Unicode (code point/grapheme)** nơi người dùng thấy, theo **byte** nơi lưu trữ; hai giới hạn được ghi rõ (tên Nhật 4 ký tự = 12 byte UTF-8). → Kiểm: test chuỗi có emoji/tiếng Việt đạt giới hạn ký tự nhưng vượt byte được xử lý đúng (không cắt giữa ký tự). · Nguồn: W3C i18n (personal names); UAX #15
- [ ] `BASE-DATA-013` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-UNITS-012`](../18-cross-cutting/units-time-and-money.md): so sánh/sắp xếp chuỗi cho người dùng theo collation locale; so khớp khoá sau NFC + case-fold.
- [ ] `BASE-DATA-014` **SHOULD** Dữ liệu từ nguồn ngoài (import CSV/Excel, API đối tác, output LLM) đi qua cùng schema validate như input người dùng; lỗi từng dòng được báo cáo, không làm hỏng cả batch im lặng. → Kiểm: test import file có 1 dòng lỗi → báo cáo dòng đó, các dòng khác xử lý theo chính sách đã khai báo. · Nguồn: P6; catalog 23 §4.5 (ranh giới tin cậy với output model)
- [ ] `BASE-DATA-015` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-UNITS-009`](../18-cross-cutting/units-time-and-money.md): đơn vị đo nằm trong tên trường/kiểu (`timeout_ms`, `size_bytes`), chuyển đổi tập trung một nơi.
- [ ] `BASE-DATA-016` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-UNITS-006`](../18-cross-cutting/units-time-and-money.md): quy tắc làm tròn tường minh; chia/phân bổ tiền theo phần dư (`XC-UNITS-007`), tổng các phần bằng gốc.
- [ ] `BASE-DATA-017` **MAY** Property-based testing (fast-check, Hypothesis 6.x, `testing/quick`) cho hàm thuần xử lý dữ liệu để tự sinh ca biên. → Kiểm: ≥ 1 property test cho module tính toán cốt lõi. · Nguồn: [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md)
- [ ] `BASE-DATA-018` **MAY** Fixture dữ liệu test chứa **Unicode khó** (tiếng Việt NFD/NFC, emoji, RTL, zero-width, tên dài) được dùng chung cho mọi test input. → Kiểm: file fixture tồn tại và được import ở test biên. · Nguồn: [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)

## Bẫy thường gặp

- **`value || default`** biến `0` và `""` hợp lệ thành mặc định. Dùng `??`/kiểm `is None`.
- **"Việt" ≠ "Việt"**: hai chuỗi trông giống nhau nhưng NFD/NFC khác nhau → trùng tài khoản, tìm không ra. NFC ở biên.
- **`utf8` của MySQL là 3 byte** → emoji và một số ký tự lỗi. Dùng `utf8mb4`.
- **ID 64-bit qua JSON thành số** → JS làm tròn, hai ID khác nhau thành một. Chuỗi.
- **`0.1 + 0.2`** trong tiền; `Decimal(3.14)` từ float mang sai số của float — tạo Decimal từ **chuỗi**.
- **Cắt chuỗi theo byte** giữa một ký tự UTF-8 → ký tự hỏng, JSON không hợp lệ. Cắt theo grapheme.
- **Hai click = hai đơn hàng**: thiếu idempotency key; disable nút không phải biện pháp server.
- **Validate CSDL thay cho biên**: người dùng nhận "duplicate key value violates unique constraint". Biên báo lỗi đẹp; CSDL là lưới cuối.
- **Test chỉ có "happy path"** với 3 phần tử; production gặp 0 phần tử và 100.000 phần tử.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Mã hoá file | EditorConfig (`charset = utf-8`) + editorconfig-checker 7.0.0 (MIT) | `editorconfig-checker` | hook + CI | 0 |
| Null/0/rỗng | typescript-eslint `prefer-nullish-coalescing`, `strict-boolean-expressions`; pyright `strict` | `lint`, `typecheck` | CI | 0 |
| Kiểu cột cấm | script SQL lint / `squawk` (Postgres, GPL-3.0) | grep migration `FLOAT|REAL|DOUBLE|timestamp without time zone` | CI | 0 ở cột tiền/thời điểm |
| Float trong tiền | Semgrep/ESLint rule tự viết cho `modules/money/**` | `lint` | CI | 0 |
| Ca biên | fast-check (MIT) · Hypothesis 6.169.0 (MPL-2.0) · fixture Unicode | `test` | CI | property test cho module lõi |
| Idempotency | test tích hợp gửi trùng + đồng thời | `test` | CI | 1 bản ghi |
| Ràng buộc CSDL | test chèn vi phạm trực tiếp | `test` | CI | bị từ chối |

## Nguồn

- RFC 8259 The JSON Data Interchange Format (§6 số, §8.1 UTF-8): <https://www.rfc-editor.org/rfc/rfc8259> — xác minh 2026-10-13
- UAX #15 Unicode Normalization Forms, rev. 58 (Unicode 18.0.0, 2026-08-12): <https://unicode.org/reports/tr15/> — xác minh 2026-10-13
- UTS #10 Unicode Collation Algorithm, rev. 55: <https://unicode.org/reports/tr10/> — xác minh 2026-10-13
- Unicode 18.0.0 (2026-09-16): <https://www.unicode.org/versions/Unicode18.0.0/> — xác minh 2026-10-13
- W3C i18n — Character encodings in HTML: <https://www.w3.org/International/questions/qa-html-encoding-declarations>; Personal names: <https://www.w3.org/International/questions/qa-personal-names> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Input Validation: <https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html> — xác minh 2026-10-13
- MDN `Number.MAX_SAFE_INTEGER` (2^53−1): <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER> — xác minh 2026-10-13
- Python `decimal` (ROUND_HALF_EVEN mặc định, `quantize`): <https://docs.python.org/3/library/decimal.html> — xác minh 2026-10-13
- RFC 3339 / RFC 9557: <https://www.rfc-editor.org/rfc/rfc3339>, <https://www.rfc-editor.org/rfc/rfc9557> — xác minh 2026-10-13
- ISO 4217 List One (SIX, xuất bản 2026-09-17): <https://www.six-group.com/en/products-services/financial-information/data-standards.html> — xác minh 2026-10-13
- Hypothesis 6.169.0, editorconfig-checker 7.0.0 (registry, xác minh 2026-10-13)
- Khung cũ X-stored `quality-supplements.md` N2 §6 (chống lỗi logic), commit `1b80fe4`; catalog `seeker19110/stored` 23 §4.1/§4.5 (không float cho tiền, không để model tính giá), đọc 2026-10-13.
