---
title: Đơn vị, thời gian (UTC, timezone), tiền (số nguyên), ID, so sánh chuỗi
kind: module
prefix: XC-UNITS
applies_to: [all]
updated: 2026-10-14
---

# Đơn vị, thời gian (UTC, timezone), tiền (số nguyên), ID, so sánh chuỗi

> **Nhà** của các quy tắc biểu diễn dữ liệu hay sai nhất: thời gian (UTC, offset, IANA tz, DST, đồng hồ đơn điệu), tiền
> (số nguyên đơn vị nhỏ nhất, ISO 4217, làm tròn, phân bổ), đơn vị đo (ghi trong tên/kiểu), định danh (UUIDv7/v4,
> ULID) và so sánh/sắp xếp chuỗi Unicode. [`../01-baseline/data-correctness.md`](../01-baseline/data-correctness.md)
> giữ sàn tối thiểu và trỏ về đây; kiểu cột CSDL cụ thể ở [`../09-database/data-modeling.md`](../09-database/data-modeling.md); cách **test** ca biên ở [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md);
> định dạng hiển thị theo locale ở [`i18n-and-l10n.md`](i18n-and-l10n.md).

## Nguyên tắc

- **Lưu một dạng chuẩn, hiển thị nhiều dạng**: UTC + RFC 3339 trong kho và trên dây; locale chỉ ở lớp trình bày.
- **Thời điểm ≠ thời gian địa phương ≠ khoảng thời gian**: ba khái niệm, ba kiểu (`Instant`/`ZonedDateTime`/`PlainDate`
  hoặc `Duration`); lịch hẹn "9:00 sáng tại Hà Nội" phải lưu kèm tên múi giờ IANA, không lưu offset.
- **Tiền mặc định là số nguyên có đơn vị tiền tệ** (decimal scale cố định chỉ khi có ADR, không bao giờ float); phép chia tiền phải trả về danh sách phần có tổng bằng gốc.
- **Đơn vị nằm trong tên hoặc kiểu**; không có `timeout`, chỉ có `timeout_ms`.
- **ID: thời gian-sắp-xếp được cho khoá dữ liệu, ngẫu nhiên hoàn toàn cho bí mật.**
- **Chuỗi so sánh theo Unicode, không theo byte**: chuẩn hoá trước, collation khi sắp xếp.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Kiểu thời điểm trong CSDL | Postgres `timestamptz` · MySQL `DATETIME(6)` lưu UTC + cột tz khi cần · SQLite TEXT RFC 3339 `Z` · Mongo `Date` (UTC). | `timestamp without time zone` cho thời điểm — cấm; chỉ dùng cho "giờ địa phương không gắn thời điểm" (lịch mở cửa). |
| Thư viện thời gian | JS: **Temporal** (TC39, có polyfill) hoặc `date-fns-tz`/Luxon; **không** dùng `Date` cho tính toán · Python: `datetime` aware + `zoneinfo` · Java: `java.time` · Go: `time` + `time.LoadLocation` · .NET: `DateTimeOffset` + `TimeZoneInfo` (IANA). | `moment` (bảo trì), `pytz` (API dễ sai `localize`), `Date` JS cho phép toán. |
| Lưu lịch hẹn tương lai | Giờ địa phương + tên tz IANA (`2027-03-29T09:00[Asia/Ho_Chi_Minh]`, RFC 9557) **và** UTC tính sẵn để truy vấn; tính lại UTC khi tzdata đổi. | Chỉ lưu UTC cho sự kiện tương lai ở vùng có DST → sai 1 giờ khi luật đổi. |
| Tiền | **Mặc định** `amount_minor BIGINT` + `currency CHAR(3)` (số nguyên đơn vị nhỏ nhất theo ISO 4217: VND 0, USD 2, KWD 3); `DECIMAL(p,s)` scale cố định **chỉ khi** cần độ chính xác dưới đơn vị nhỏ nhất (tỷ giá, đơn giá theo gram/kWh) + ADR; thư viện: `dinero.js` 2.x, Python `decimal`, Java `BigDecimal`/JavaMoney, Go `shopspring/decimal`, .NET `decimal`. | Float/double: cấm. Số thực nhị phân chỉ cho đo lường/khoa học. |
| ID khoá chính | **UUIDv7** (RFC 9562, sắp xếp theo thời gian, index locality tốt) hoặc ULID; số tự tăng chỉ cho bảng nội bộ không lộ ra ngoài. | UUIDv4 cho token/bí mật/không muốn lộ thứ tự tạo; không dùng UUIDv7 làm token bảo mật (đoán được thời gian). |
| So sánh chuỗi | Khoá/định danh: NFC + case-fold (`casefold()`, `toLocaleLowerCase`) · Sắp xếp hiển thị: ICU/`Intl.Collator(locale)`/`COLLATE "vi-x-icu"`. | So byte chỉ cho dữ liệu nhị phân, hash, mã máy. |

## Checklist

- [ ] `XC-UNITS-001` **MUST** Thời điểm lưu trữ và trao đổi bằng **UTC**, định dạng RFC 3339 có offset (`2026-10-13T07:14:05.123Z`); kiểu dữ liệu "aware" (có múi giờ) ở mọi ngôn ngữ; không có `datetime` naive, không `Date` không offset. → Kiểm: schema không có `timestamp without time zone`; lint cấm `datetime.now()`/`utcnow()` không `tz=`, `new Date().toLocale*` ở lớp lưu; test parse chuỗi không offset bị từ chối ở API. · Nguồn: RFC 3339 §5.6; RFC 9557
- [ ] `XC-UNITS-002` **MUST@L** Múi giờ biểu diễn bằng **tên IANA** (`Asia/Ho_Chi_Minh`), không bằng offset cố định (`+07:00`) hay chữ viết tắt (`ICT`, `EST`); tzdata của runtime/hệ điều hành được cập nhật (bản hiện hành **2026e**, 2026-09-29). → Kiểm: grep mã/cấu hình không có `+07:00`/`GMT+7` làm múi giờ; test `ZoneId.of("Asia/Ho_Chi_Minh")`; CI kiểm phiên bản tzdata (`python -c "import tzdata; print(tzdata.IANA_VERSION)"`, `node -e "console.log(process.versions.tz)"`) không cũ hơn 1 năm. · Nguồn: IANA Time Zone Database 2026e
- [ ] `XC-UNITS-003` **MUST@L** Sự kiện **tương lai gắn giờ địa phương** (lịch hẹn, nhắc, cron theo người dùng) lưu giờ địa phương + tên tz IANA; UTC dẫn xuất được tính lại khi tzdata thay đổi; test ranh giới DST và ngày đổi luật (vd Manitoba 2026-10-31 theo tzdata 2026e). → Kiểm: schema có cột `local_time` + `tz`; test chuyển DST (`Europe/Paris` 2027-03-28) và ngày 31/12→01/01 cho kết quả đúng. · Nguồn: RFC 9557 (suffix `[tz]`); IANA tzdb 2026e
- [ ] `XC-UNITS-004` **MUST@L** Khoảng thời gian và timeout đo bằng **đồng hồ đơn điệu** (`performance.now()`/`process.hrtime.bigint()`, `time.monotonic()`, `System.nanoTime()`, `time.Since`, `Stopwatch`), không bằng hiệu hai "giờ tường". → Kiểm: lint cấm `Date.now()`/`time.time()` trong hàm đo thời lượng; test với clock giả lùi thời gian không cho duration âm. · Nguồn: [`performance-engineering.md`](performance-engineering.md)
- [ ] `XC-UNITS-005` **MUST** Tiền **mặc định** lưu/tính bằng **số nguyên đơn vị nhỏ nhất** (`amount_minor`) **kèm mã ISO 4217**, số chữ số lẻ lấy từ bảng ISO 4217 (VND 0, JPY 0, USD/EUR 2, KWD/BHD 3, CLF 4); `numeric`/`decimal` với scale cố định **chỉ khi** nghiệp vụ cần độ chính xác lớn hơn đơn vị nhỏ nhất (tỷ giá, đơn giá theo gram/kWh) và có ADR; **không bao giờ float/double** ở bất kỳ tầng nào (CSDL, API, UI tính toán). → Kiểm: schema cột tiền là `BIGINT` + `currency`, cột `DECIMAL`/`NUMERIC` chỉ ở nơi ADR liệt kê; API trả `{ "amount_minor": 1500000, "currency": "VND" }` (giá trị decimal truyền dạng chuỗi); lint cấm `float`/`parseFloat`/`Number(` trong module tiền; test `Decimal('0.1') + Decimal('0.2') == Decimal('0.3')`. · Nguồn: ISO 4217 List One (SIX, 2026-09-17); Python `decimal`
- [ ] `XC-UNITS-006` **MUST** Phép tính tiền có **quy tắc làm tròn tường minh** (mode: HALF_UP cho hoá đơn VN thông thường, HALF_EVEN cho kế toán/thống kê — chọn theo nghiệp vụ, ghi trong spec) và `quantize` về đúng số chữ số lẻ sau mỗi phép nhân/chia; không dùng `round()` mặc định của ngôn ngữ mà không chỉ định mode. → Kiểm: spec/ADR ghi mode; test `2.665 → 2.67` (HALF_UP) và `→ 2.66` (HALF_EVEN) theo mode đã chọn; `round(Decimal)` không xuất hiện (Python `round()` bỏ qua context). · Nguồn: Python `decimal` docs (ROUND_HALF_EVEN mặc định, `quantize`)
- [ ] `XC-UNITS-007` **MUST@L** Chia/phân bổ tiền (chia hoá đơn, thuế theo dòng, hoa hồng) dùng thuật toán **phân bổ phần dư** (largest remainder): tổng các phần == tổng gốc đến đơn vị nhỏ nhất; không chia rồi làm tròn từng phần. → Kiểm: test phân bổ 100 (VND) cho 3 → `[34, 33, 33]`; property test tổng bất biến. · Nguồn: dinero.js `allocate`; khung cũ N2 §6
- [ ] `XC-UNITS-008` **MUST@L** Tỷ giá và thuế lưu dưới dạng số hữu tỉ/decimal có nguồn, thời điểm hiệu lực và số chữ số; không lưu float; chuyển đổi tiền tệ ghi lại tỷ giá đã dùng cùng giao dịch. → Kiểm: bảng `fx_rate(decimal, effective_at, source)`; giao dịch lưu `rate_used`; test chuyển đi–về không mất quá 1 đơn vị nhỏ nhất. · Nguồn: ISO 4217; [`../03-industries/fintech.md`](../03-industries/fintech.md)
- [ ] `XC-UNITS-009` **MUST** Mọi trường số có đơn vị mang đơn vị trong **tên** (`_ms`, `_s`, `_bytes`, `_kb`, `_kg`, `_cm`, `_percent`, `_bps`) hoặc trong **kiểu** (`Duration`, `Quantity`); hằng số chuyển đổi tập trung một module; không "số ma thuật" (`* 1000`, `/ 1024`). → Kiểm: lint schema/CSDL cảnh báo cột số không hậu tố đơn vị; grep `\* ?1000|/ ?1024` ngoài module đơn vị = 0. · Nguồn: P5; catalog 23 §4.5
- [ ] `XC-UNITS-010` **MUST@L** Số nguyên 64-bit (ID, số tiền lớn, timestamp ns) không đi qua JSON dạng số; qua dây dạng **chuỗi** hoặc `BigInt`; ngôn ngữ dùng kiểu đủ rộng và phép toán có kiểm tràn. → Kiểm: test API `id` 2^63−1 round-trip nguyên vẹn qua JS client; Go/Java/Rust dùng `int64`/`long`/`i64` với `checked_add` nơi cộng tiền. · Nguồn: RFC 8259 §6; MDN `MAX_SAFE_INTEGER`
- [ ] `XC-UNITS-011` **MUST@L** Khoá chính/ID công khai sinh bằng **UUIDv7** (hoặc ULID) cho bản ghi; **UUIDv4/CSPRNG** cho token, mã xác nhận, secret; không lộ ID tự tăng ra ngoài khi nó tiết lộ số lượng/thứ tự nghiệp vụ. → Kiểm: schema `id UUID` + hàm `uuid7()`/`uuidv7()`; token sinh bằng `crypto.randomUUID()`/`secrets.token_urlsafe`; không có endpoint `/orders/123` với số tự tăng trừ khi ADR cho phép. · Nguồn: RFC 9562 §5.4, §5.7, §6.9
- [ ] `XC-UNITS-012` **MUST@L** So sánh chuỗi làm khoá/định danh (username, email local-part, tag, slug) sau **NFC + case-fold**; email so sánh không phân biệt hoa thường ở domain; sắp xếp cho người xem dùng **collation theo locale** (`Intl.Collator('vi')`, ICU, `COLLATE`), không `ORDER BY` byte. → Kiểm: test `"Việt"` NFD và NFC là cùng khoá; test sắp xếp `["ă","a","â","b"]` theo `vi` → `["a","ă","â","b"]`; schema cột so khớp có `COLLATE` hoặc cột chuẩn hoá riêng. · Nguồn: UAX #15 rev. 58; UTS #10 rev. 55
- [ ] `XC-UNITS-013` **SHOULD** Ngày không gắn thời điểm (ngày sinh, hạn hợp đồng, ngày lễ) lưu kiểu **ngày thuần** (`DATE`, `PlainDate`, `LocalDate`), không `timestamp` 00:00 UTC (lệch ngày khi đổi múi giờ). → Kiểm: schema cột ngày sinh/hạn là `DATE`; test ngày sinh hiển thị đúng ở `Asia/Ho_Chi_Minh` và `America/Los_Angeles`. · Nguồn: Temporal `PlainDate`; java.time `LocalDate`
- [ ] `XC-UNITS-014` **SHOULD** Thời gian hiển thị cho người theo múi giờ **của người dùng** (lưu trong hồ sơ hoặc lấy từ client), định dạng theo locale (xem [`i18n-and-l10n.md`](i18n-and-l10n.md)); dữ liệu xuất (CSV/báo cáo) ghi rõ múi giờ trong tiêu đề cột hoặc dùng RFC 3339. → Kiểm: test render cùng thời điểm cho hai người dùng khác tz; CSV xuất có cột `_utc` hoặc header ghi tz. · Nguồn: RFC 3339; W3C i18n (locale-sensitive data)
- [ ] `XC-UNITS-015` **SHOULD** Phần trăm/tỷ lệ lưu dạng số hữu tỉ có đơn vị rõ (`rate_bps` basis point, `percent` 0–100, `fraction` 0–1) — chọn một và ghi trong tên; không lẫn 0.15 với 15. → Kiểm: lint tên trường; test chuyển đổi. · Nguồn: P5
- [ ] `XC-UNITS-016` **SHOULD** Thư viện thời gian/tiền được **pin** và thay thế có ADR; với JS ưu tiên `Temporal` (hoặc polyfill) cho mã mới; không trộn hai thư viện ngày trong một codebase. → Kiểm: manifest có đúng một thư viện ngày; ADR chọn. · Nguồn: TC39 Temporal; [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `XC-UNITS-017` **SHOULD** Đồng hồ máy chủ đồng bộ NTP/PTP; chênh lệch > 1 s giữa các node sinh cảnh báo (ảnh hưởng token hết hạn, thứ tự sự kiện, UUIDv7). → Kiểm: metric `clock_offset_seconds` có alert; runbook có mục. · Nguồn: [`../15-operations/observability.md`](../15-operations/observability.md)
- [ ] `XC-UNITS-018` **SHOULD** Độ dài/kích thước: `bytes` cho dữ liệu, ký tự Unicode (grapheme) cho giới hạn nhập của người, ghi rõ ở validate và CSDL (`VARCHAR(n)` là ký tự hay byte tuỳ CSDL). → Kiểm: test chuỗi tiếng Việt/emoji ở giới hạn ký tự không bị cắt giữa ký tự; tài liệu ghi đơn vị giới hạn. · Nguồn: W3C i18n (personal names: 4 ký tự Nhật = 12 byte)
- [ ] `XC-UNITS-019` **MAY** Dùng kiểu **đơn vị có kiểm kiểu** (`newtype`/branded type: `Milliseconds`, `Cents`) để compiler chặn cộng ms với s, VND với USD. → Kiểm: hàm nhận `Money` không chấp nhận `number` thô (test kiểu). · Nguồn: P3 (đúng › nhanh)
- [ ] `XC-UNITS-020` **MAY** Lịch phi Gregorian (âm lịch cho ngày lễ VN, Hijri, Buddhist) xử lý bằng ICU/`Intl.DateTimeFormat` với `calendar`, không tự tính; âm lịch Việt Nam tính theo múi giờ `Asia/Ho_Chi_Minh` (UTC+7). → Kiểm: test Tết 2027 (âm lịch) ra đúng ngày dương theo nguồn chính thống. · Nguồn: ECMA-402 `Intl.DateTimeFormat` `calendar`; CLDR 48.2

## Bẫy thường gặp

- **Lưu `+07:00` thay cho `Asia/Ho_Chi_Minh`.** Việt Nam hiện không có DST, nên lỗi ẩn nhiều năm — cho đến khi mở rộng sang khách ở múi giờ có DST hoặc luật đổi. Tên IANA luôn.
- **Sự kiện tương lai chỉ lưu UTC**: "họp 9:00 sáng thứ Hai" ở Paris bị lệch một giờ khi qua DST hoặc khi quốc gia bỏ DST (Manitoba 2026). Giờ địa phương + tz.
- **`new Date('2026-10-13')`** parse là UTC nửa đêm, hiển thị thành 12/10 ở châu Mỹ. Dùng `PlainDate` hoặc parse tường minh.
- **Đo thời lượng bằng `Date.now()`** — NTP chỉnh giờ lùi → thời lượng âm, timeout không bao giờ hết. Monotonic clock.
- **`0.1 + 0.2 ≠ 0.3`**; `Decimal(0.1)` từ float mang sai số; **`round(2.5) == 2`** (banker's rounding) gây hoá đơn lệch 1 đồng. Decimal từ chuỗi, mode tường minh.
- **Chia 100 cho 3 rồi làm tròn mỗi phần = 99 hoặc 102.** Phân bổ phần dư.
- **VND có 2 chữ số lẻ trong CSDL** vì copy schema USD → `15000000.00`, giao diện hiển thị "15.000.000,00 ₫" và cổng thanh toán từ chối. Lấy minor unit từ ISO 4217.
- **UUIDv4 làm khoá chính bảng lớn** → index phân mảnh, chèn chậm (RFC 9562 ghi rõ locality kém). UUIDv7.
- **UUIDv7 làm token đặt lại mật khẩu** → lộ thời điểm tạo, thu hẹp không gian đoán. v4/CSPRNG.
- **`ORDER BY name`** với collation mặc định `C`/byte → "Ă" đứng sau "Z". Collation `vi`.
- **`.lower()` thay cho `.casefold()`** — `ß`, `İ` sai; tiếng Thổ `i` không chấm. Case-fold + NFC.
- **tzdata trong image Docker 3 năm tuổi** — luật múi giờ đã đổi vài lần. Cập nhật tzdata là phụ thuộc có lịch.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Kiểu cột thời gian/tiền | script SQL lint / squawk (GPL-3.0, Postgres) | grep migration `timestamp without time zone|FLOAT|REAL|DOUBLE` | CI | 0 ở cột thời điểm/tiền |
| API naive/float | Semgrep OSS rule tự viết; ESLint `no-restricted-syntax`; ruff `DTZ001–DTZ012` (flake8-datetimez) | `ruff check --select DTZ`; `lint` | hook + CI | 0 |
| tzdata tươi | script so `tzdata.IANA_VERSION`/`process.versions.tz` với `https://www.iana.org/time-zones` | cron tuần | CI | ≤ 1 năm tuổi |
| DST/biên ngày | test với clock giả (`@sinonjs/fake-timers`, `freezegun`/`time-machine`, `testing/clock`) | `test` | CI | pass |
| Tiền | dinero.js 2.0.2 (MIT) · Python `decimal` · property test tổng bất biến (fast-check/Hypothesis 6.169.0) | `test` | CI | pass |
| ID | test `uuid_version == 7` cho khoá; `== 4` cho token | `test` | CI | pass |
| Collation | test sắp xếp `vi` bằng `Intl.Collator`/ICU 78.3 | `test` | CI | đúng thứ tự |
| Đơn vị trong tên | lint schema (script) | `check:units` | CI | cảnh báo → chặn sau baseline |

## Nguồn

- RFC 3339 Date and Time on the Internet: Timestamps: <https://www.rfc-editor.org/rfc/rfc3339> — xác minh 2026-10-13
- RFC 9557 IXDTF (hậu tố `[Area/City]`, cập nhật RFC 3339; 2024): <https://www.rfc-editor.org/rfc/rfc9557> — xác minh 2026-10-13
- IANA Time Zone Database — bản 2026e (2026-09-29; Manitoba chuyển −05 cố định từ 2026-10-31): <https://www.iana.org/time-zones> — xác minh 2026-10-13; gói PyPI `tzdata` 2026.5 — xác minh 2026-10-13
- ISO 4217 List One (SIX Group, maintenance agency; xuất bản 2026-09-17; VND/JPY minor unit 0, KWD/BHD 3, CLF 4): <https://www.six-group.com/en/products-services/financial-information/data-standards.html> (list-one.xml) — xác minh 2026-10-13; ấn bản ISO 4217:2015 **(chưa xác minh — iso.org trả 403 ngày 2026-10-13)**
- ISO 8601-1:2019 / 8601-2:2019 + Amd 1:2022 **(chưa xác minh trực tiếp — iso.org trả 403 ngày 2026-10-13; khung dùng RFC 3339/9557 làm chuẩn kỹ thuật)**
- RFC 9562 UUIDs (obsoletes RFC 4122; UUIDv7 §5.7, UUIDv4 §5.4, index locality §6.9): <https://www.rfc-editor.org/rfc/rfc9562> — xác minh 2026-10-13
- RFC 8259 JSON §6 (số nguyên an toàn ±(2^53−1)): <https://www.rfc-editor.org/rfc/rfc8259> — xác minh 2026-10-13; MDN `Number.MAX_SAFE_INTEGER`: <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER> — xác minh 2026-10-13
- Python `decimal` (ROUND_HALF_EVEN mặc định, `quantize`, `round()` bỏ qua context): <https://docs.python.org/3/library/decimal.html> — xác minh 2026-10-13
- TC39 Temporal (Instant, ZonedDateTime, PlainDate, Duration): <https://tc39.es/proposal-temporal/> — xác minh 2026-10-13; stage hiện tại **(chưa xác minh từ trang spec)**
- ECMA-402 14th ed. (ECMAScript 2027 Internationalization API, draft 2026-10-12; `Intl.Collator`, `DateTimeFormat`, `DurationFormat`): <https://tc39.es/ecma402/> — xác minh 2026-10-13
- UAX #15 rev. 58 (Unicode 18.0.0): <https://unicode.org/reports/tr15/>; UTS #10 rev. 55: <https://unicode.org/reports/tr10/> — xác minh 2026-10-13; ICU 78.3 (2026-03-17, CLDR 48, Unicode 17): <https://icu.unicode.org/> — xác minh 2026-10-13
- W3C i18n — Personal names around the world: <https://www.w3.org/International/questions/qa-personal-names> — xác minh 2026-10-13
- dinero.js 2.0.2 (MIT), decimal.js 10.6.0, big.js 7.0.1 (npm, xác minh 2026-10-13)
- Khung cũ X-stored `quality-supplements.md` N2 §6 (UTC, DST, float tiền), commit `1b80fe4`; catalog `seeker19110/stored` 23 §4.5 ("không dùng float cho tiền; không để model tính giá"), đọc 2026-10-13.
