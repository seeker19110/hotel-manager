# SPEC-metering-billing — Dịch vụ, công tơ và kỳ thu xem trước → phát hành

| Trường | Giá trị |
|---|---|
| ID tính năng | F-004 (luồng gốc: R-001 Kỳ thu trọ) |
| Trạng thái | Approved — câu [chặn] chốt theo PLAN đợt 2 (tham số hoá) |
| Phiên bản | 2 (2026-10-15) — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi chủ dự án ngày 2026-10-15 (duyệt PLAN đợt 2) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch gốc §05 (kỳ thu, tình huống bắt buộc), §08 (snapshot, làm tròn), §12; backlog T028–T030, T074; DOMAIN-MODEL v1.2 §4, §7; nghiên cứu pháp lý `docs/research/2026-10-15-stack-va-phap-ly.md` (giá điện cho người thuê) |
| Phụ thuộc | SPEC-lease (phiên bản giá, người ở, chỉ số bàn giao) · SPEC-ledger-payments (bút toán, `period_locks`) |

> Tên theo `docs/design/DOMAIN-MODEL.md` v1.2; `services`, `service_prices`, `meter_events` đã có ở §7, không còn tên **†**.
> Lỗi trả `application/problem+json` có `code`. Command ghi nhận `Idempotency-Key` (INV-G5).
> **Pháp lý:** quy định giá điện cho người thuê có các nguồn mâu thuẫn (bậc 2 hay bậc 3). Sản phẩm **không** đưa ra "mức đúng luật": biểu giá do cơ sở cấu hình, có ngày hiệu lực và ô "căn cứ". Đơn giá trong ví dụ chỉ để kiểm phép tính (kế hoạch §05).

## 1. User story
- Là **chủ trọ**, khi đến kỳ thu tôi muốn chốt điện nước theo tầng và xem trước từng phòng và tổng trước khi phát hành, để thu đúng và giảm ≥ 50% thời gian lập kỳ (M-01).
- Là **kế toán**, tôi muốn mỗi dòng phí lưu snapshot giá, lượng và cách làm tròn, để đối chiếu lại được dù biểu giá đổi sau này.

## 2. Tiêu chí chấp nhận (Given/When/Then)

Fixture `billing-basic`: cơ sở P1 (`Asia/Ho_Chi_Minh`, làm tròn `HALF_UP_1`), phòng U101 tầng 1, hợp đồng L1 `active` (giá 3.000.000 đ/tháng), dịch vụ: điện `metered` 3.000 đ/kWh, nước `metered` 15.000 đ/m³, phí khác `fixed_per_unit` 100.000 đ. Quản lý M, kế toán K, chủ O.

### S-001 Kỳ thu chuẩn — ví dụ bắt buộc 3.580.000 đ
- Given kỳ 10/2026 `draft`, điện đầu 1.250 cuối 1.350, nước 12 m³, L1 ở trọn tháng
- When M gọi `billing.previewPeriod`
- Then U101 có 4 dòng: tiền thuê 3.000.000; điện 100 × 3.000 = 300.000; nước 12 × 15.000 = 180.000; phí khác 100.000; tổng phòng **3.580.000 đ**; tổng kỳ = Σ tổng phòng

### S-002 Phát hành tạo phiếu và bút toán AR/REV (INV-F1)
- Given kỳ S-001 ở `reviewing`, `preview_hash` = H
- When O gọi `billing.issuePeriod` với `preview_hash` = H
- Then kỳ `issued`; tạo 1 `invoices` cho L1 tổng 3.580.000 đ với 4 `invoice_lines`; 1 bút toán: Nợ `AR` 3.580.000 / Có `REV_ROOM` 3.000.000, `REV_UTIL` 480.000, `REV_FEE` 100.000; Σ Nợ = Σ Có; outbox `invoice.issued`

### S-003 Snapshot không đổi khi biểu giá đổi (INV-G3, INV-G4)
- Given phiếu S-002 đã phát hành
- When M đổi đơn giá điện thành 3.500 đ từ 2026-11-01
- Then dòng điện của phiếu S-002 vẫn `quantity`=100, `unit_price`=3.000, `amount`=300.000, `rounding_rule`=`HALF_UP_1`, `formula_version` cũ; UPDATE trực tiếp bị trigger chặn

### S-004 Xem trước đã cũ thì không phát hành
- Given O xem trước với `preview_hash` = H, sau đó M sửa chỉ số nước (kỳ quay lại `draft` rồi `reviewing`)
- When O gọi `billing.issuePeriod` với H
- Then lỗi 409 `BILLING_PREVIEW_STALE`; không có phiếu nào được tạo

### S-005 Chặn chỉ số giảm
- Given chỉ số điện đã duyệt gần nhất của U101 là 1.350
- When M gọi `meter.recordReading` giá trị 1.340
- Then lỗi 422 `METER_READING_DECREASED`, kèm `previous_value`=1.350; không lưu

### S-006 Thay công tơ (reset) có quyền
- Given công tơ cũ chỉ số đầu kỳ 1.250
- When M (quyền `meter.replace`) gọi `meter.replace`: chỉ số cuối công tơ cũ 1.300, công tơ mới bắt đầu 0, ảnh cả hai; cuối kỳ công tơ mới đọc 50
- Then tạo `meter_events` loại `replacement`; lượng điện kỳ = (1.300 − 1.250) + (50 − 0) = 100 kWh → 300.000 đ

### S-007 Thay công tơ không có quyền
- Given F (`front_desk`) không có quyền `meter.replace`
- When F gọi `meter.replace`
- Then lỗi 403 `FORBIDDEN`

### S-008 Cảnh báo bất thường phải được xử lý trước khi duyệt
- Given điện U101 ba kỳ trước 100/110/90 kWh (trung bình 100), kỳ này đọc 260 kWh (ngưỡng đề xuất: > 2 × trung bình)
- When M gọi `billing.submitForReview`
- Then lỗi 409 `UNRESOLVED_ANOMALIES` kèm danh sách `[{unit:"U101", meter:"electric", consumption:260, average:100}]`; sau khi M ghi nhận (`meter.acknowledgeAnomaly` + ghi chú) thì gửi duyệt thành công

### S-009 Thiếu chỉ số
- Given phòng U102 có hợp đồng `active` nhưng chưa có chỉ số kỳ
- When M gọi `billing.submitForReview`
- Then lỗi 409 `READINGS_INCOMPLETE` kèm danh sách phòng thiếu; hợp đồng có bàn giao nguồn `import` còn `readings_pending` cũng bị liệt kê cho đến khi đủ chỉ số `import` đã duyệt (SPEC-lease S-026, SPEC-import S-010)

### S-010 Chốt chỉ số theo tuyến tầng
- Given cơ sở có tầng 1 (U101, U102), tầng 2 (U201)
- When M gọi `meter.getReadingRoute` cho kỳ 10/2026
- Then danh sách sắp theo tầng rồi mã phòng; mỗi mục có chỉ số trước, ảnh trước, ô nhập, cờ đã nhập

### S-011 Không sửa số sau phát hành
- Given kỳ 10/2026 `issued`
- When M gọi `meter.recordReading` thay chỉ số kỳ đó
- Then lỗi 409 `PERIOD_ISSUED`; thông điệp hướng dẫn dùng điều chỉnh (`ledger.issueAdjustment`)

### S-012 Kỳ đã khoá: chỉ owner mở khoá, mở khoá không cho sửa phiếu đã phát hành
- Given kỳ 09/2026 `locked` (có `period_locks` hiệu lực — cùng một cơ chế với `ledger.lockPeriod`); M (manager), K (accountant), O (owner)
- When M gọi `billing.reopenPeriod`; K gọi; O gọi không có lý do; O gọi có lý do; rồi M sửa phiếu kỳ 09 (và, ở kỳ khác còn `locked`, M sửa phiếu mà chưa mở khoá)
- Then M và K → 403 `FORBIDDEN`; O không lý do → 422 `VALIDATION_FAILED`; O có lý do → kỳ `locked → issued` (DOMAIN-MODEL §4), `period_locks` ghi `released_by/released_at/release_reason` (không xoá dòng), audit `period.unlocked`; sau mở khoá sửa trực tiếp phiếu kỳ 09 → 409 `DOCUMENT_IMMUTABLE` và sửa chỉ số → 409 `PERIOD_ISSUED` (chỉ được thêm điều chỉnh/đảo ghi ngày trong kỳ, `ledger.issueAdjustment`); sửa phiếu của kỳ còn `locked` → 409 `PERIOD_LOCKED` (INV-F6); `billing.reopenPeriod` khi kỳ không `locked` → 409 `INVALID_TRANSITION`

### S-013 Job tạo kỳ chạy lại không tạo trùng
- Given job `billing.generatePeriods` đã tạo kỳ 11/2026 cho P1
- When job chạy lại 3 lần (kể cả 2 worker song song)
- Then đúng 1 `billing_periods` unique `(property_id, period_start)`; lần sau trả kỳ hiện có

### S-014 Job tạo kỳ theo ngày địa phương
- Given job chạy lúc 2026-10-31T17:05Z (= 00:05 ngày 01/11 giờ VN)
- When job chạy
- Then tạo kỳ 11/2026 (không phải 10/2026)

### S-015 Phát hành lặp (INV-G5)
- Given `billing.issuePeriod` đã thành công với key K1
- When gửi lại K1 cùng payload
- Then trả kết quả cũ; vẫn 1 phiếu cho L1 (unique `(billing_period_id, lease_id)`) và 1 bút toán

### S-016 Phí theo người và phí một lần
- Given dịch vụ "rác" `per_person` 20.000 đ/người, L1 có 2 người ở vào ngày cuối kỳ; phí một lần "làm chìa" 50.000 đ hiệu lực trong kỳ
- When xem trước
- Then dòng rác 2 × 20.000 = 40.000 đ; dòng làm chìa 50.000 đ (`REV_FEE`) chỉ xuất hiện ở đúng 1 kỳ

### S-017 Dịch vụ chưa đến ngày hiệu lực
- Given dịch vụ "wifi" 100.000 đ hiệu lực từ 2026-11-01
- When xem trước kỳ 10/2026
- Then không có dòng wifi

### S-018 Scenario Outline — prorata tiền thuê kỳ đầu/cuối lẻ (theo ngày thực của tháng — đề xuất mục 10)
- Given giá tháng `<gia>` đ, số ngày tính tiền trong kỳ `<ngay_o>`, số ngày của tháng `<ngay_thang>`
- When tính dòng tiền thuê bằng `money.prorate` rồi `money.round(HALF_UP_1)`
- Then thành tiền `<thanh_tien>` đ
- Examples:

| gia | ngay_o | ngay_thang | ví dụ | thanh_tien |
|---|---|---|---|---|
| 3.000.000 | 31 | 31 | trọn tháng 10 | 3.000.000 |
| 3.000.000 | 15 | 31 | bắt đầu 17/10 | 1.451.613 |
| 3.000.000 | 10 | 31 | trả 10/10 | 967.742 |
| 3.000.000 | 1 | 31 | 1 ngày | 96.774 |
| 3.000.000 | 14 | 28 | bắt đầu 15/02/2027 | 1.500.000 |
| 2.500.000 | 1 | 28 | 1 ngày tháng 2 | 89.286 |
| 3.000.000 | 29 | 29 | trọn tháng 02/2028 | 3.000.000 |
| 3.000.000 | 15 | 30 | nửa tháng 11 | 1.500.000 |
| 0 | 10 | 31 | giá 0 | 0 |
| 1 | 1 | 31 | 1 đ, 1 ngày | 0 |
| 1 | 16 | 31 | 1 đ, 16 ngày | 1 |

### S-019 Scenario Outline — dòng theo chỉ số
- Given chỉ số đầu `<dau>`, cuối `<cuoi>`, đơn giá `<don_gia>` đ
- When tính dòng
- Then lượng `<luong>`, thành tiền `<thanh_tien>` đ
- Examples:

| dau | cuoi | don_gia | luong | thanh_tien |
|---|---|---|---|---|
| 1.250 | 1.350 | 3.000 | 100 | 300.000 |
| 1.250 | 1.250 | 3.000 | 0 | 0 |
| 1.250 | 1.251 | 1 | 1 | 1 |
| 100,5 | 112,7 | 15.000 | 12,2 | 183.000 |
| 1.250 | 1.253 | 3.000,5 | 3 | 9.002 |

### S-020 Làm tròn qua một hàm duy nhất
- Given mã nguồn `packages/domain`, `packages/app`
- When chạy test kiến trúc
- Then không có phép làm tròn tiền ngoài `packages/domain/money` (`Math.round`/`toFixed` trên tiền bị lint/test chặn); property test (fast-check): tổng phiếu = Σ dòng đã làm tròn, mọi dòng là số nguyên ≥ 0

### S-021 Đổi giá giữa kỳ tách hai đoạn
- Given phiên bản 1 (3.000.000 đ) đến 14/11/2026, phiên bản 2 (3.300.000 đ) từ 15/11/2026
- When xem trước kỳ 11/2026
- Then 2 dòng tiền thuê: 1.400.000 + 1.760.000 = 3.160.000 đ, mỗi dòng ghi `lease_version_id`

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Kỳ không có hợp đồng nào; phòng trống có công tơ; dịch vụ giá 0 | Kỳ rỗng vẫn phát hành được với 0 phiếu; phòng trống không tạo phiếu; dòng 0 đ vẫn hiển thị | S-017, S-018 |
| Cực đại/độ dài | 100 phòng/kỳ; chỉ số 7 chữ số; công tơ quay vòng 99.999 → 00.012 | Xem trước < 3 s; quay vòng xử lý như thay công tơ (luồng có quyền), không tự đoán | S-006 |
| Trùng lặp/idempotency | Job tạo kỳ chạy lại; phát hành bấm 2 lần; nhập chỉ số 2 lần | unique kỳ; unique phiếu theo (kỳ, hợp đồng); chỉ số cùng (công tơ, kỳ) là cập nhật bản nháp | S-013, S-015 |
| Song song | 2 người nhập cùng phòng; phát hành khi người khác đang sửa | Khoá lạc quan theo `version` → 409 cho người sau; `preview_hash` chặn phát hành số cũ | S-004 |
| Mất mạng giữa chừng | Mất mạng khi nhập tuyến tầng | Pilot chỉ online: báo lỗi rõ, chỉ số đã lưu từng phòng giữ nguyên (nháp offline ở F-014) | S-010 |
| Thời gian/múi giờ | Job 00:05 giờ VN; tháng 28/29/30/31 ngày | Ngày kỳ là `date` địa phương | S-014, S-018 |
| Quyền | Lễ tân thay công tơ; quản lý/kế toán mở khoá kỳ; buồng phòng xem số tiền | 403; buồng phòng không thấy số tiền | S-007, S-012 |
| Tiền/đơn vị | 0 đ; 1 đ; lượng thập phân; đơn giá lẻ | `bigint` đồng; lượng/đơn giá `numeric`; làm tròn một hàm | S-018, S-019, S-020 |

## 4. Dữ liệu
| Thực thể | Trường chính | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `services` | `code`, `name`, `kind` (`fixed_per_unit`/`per_person`/`metered`/`one_time`), `revenue_account` (`REV_ROOM`/`REV_UTIL`/`REV_SERVICE`/`REV_FEE`), `meter_kind` | enum | Danh mục theo cơ sở; soft delete (INV-G7) | owner/manager |
| `service_prices` | `service_id`, `unit_price`, `effective_from`, `effective_to`, `basis_note` (căn cứ) | numeric, date, text | EXCLUDE chồng hiệu lực; giá do cơ sở nhập | owner (D-008, 2026-10-16: theo ma trận quyền SPEC-access-and-property 5.3 "Loại phòng, bảng giá"; mở cho manager = đổi ma trận + dòng này) |
| `meters` | `unit_id`, `kind` (`electric`/`water`), `serial`, `installed_on`, `removed_on` | | 1 công tơ đang dùng mỗi (phòng, loại) | manager |
| `meter_readings` | `meter_id`, `read_on`, `value`, `photo_file_id`, `status` (`draft`/`approved`), `source` (`handover`/`period`/`replacement`/`import`) | date, numeric | `value` ≥ chỉ số đã duyệt trước (trừ `replacement`) | manager/front_desk ghi; maintenance nhập nếu được giao |
| `meter_events` | `meter_id`, `kind` (`replacement`), `old_final_value`, `new_meter_id`, `new_initial_value`, `approved_by` | | Cần quyền `meter.replace` | manager/owner |
| `billing_periods` | `property_id`, `period_start`, `period_end`, `status`, `preview_hash`, `issued_at` | date, enum | unique `(property_id, period_start)`; trạng thái theo DOMAIN-MODEL §4 | manager/owner/accountant |
| `charges` | `source` (kỳ thu/folio), `service_id`, `lease_version_id`, `quantity`, `unit_price`, `amount`, `rounding_rule`, `formula_version`, `reading_ids` | numeric, bigint | Bất biến sau phát hành | hệ thống |
| `invoices` / `invoice_lines` | `billing_period_id`, `lease_id`, `number`, `total`; dòng: snapshot như `charges` | bigint | unique `(billing_period_id, lease_id)`; số phiếu tăng dần theo cơ sở | accountant/manager/owner; tenant đọc của mình |

- Hàm `packages/domain/money`: `prorate(amount, days, daysInMonth)` và `round(value, rule)` là chỗ **duy nhất** làm tròn. `formula_version` tăng khi đổi công thức.

## 5. Giao diện / API
| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `service.define` / `service.setPrice` | danh mục; giá + `effective_from` + căn cứ | `service_id` / `price_id` | `VALIDATION_FAILED` |
| `meter.register` | `unit_id`, loại, serial | `meter_id` | `VALIDATION_FAILED` |
| `meter.getReadingRoute` | `billing_period_id`, tầng? | danh sách theo tầng | `NOT_FOUND` |
| `meter.recordReading` | `meter_id`, `billing_period_id`, `value`, ảnh | `reading_id`, cờ bất thường | `METER_READING_DECREASED`, `PERIOD_ISSUED`, `PERIOD_LOCKED` |
| `meter.replace` | công tơ cũ (chỉ số cuối, ảnh), công tơ mới (serial, chỉ số đầu, ảnh), lý do | `meter_event_id` | `FORBIDDEN`, `VALIDATION_FAILED` |
| `meter.acknowledgeAnomaly` | `reading_id`, ghi chú | ok | `VALIDATION_FAILED` |
| `billing.createPeriod` / job `billing.generatePeriods` | `property_id`, tháng | `billing_period_id` (cũ nếu đã có) | `VALIDATION_FAILED` |
| `billing.previewPeriod` | `billing_period_id` | từng phòng: dòng, tổng; tổng kỳ; `preview_hash` | `NOT_FOUND` |
| `billing.submitForReview` | `billing_period_id` | `reviewing` | `READINGS_INCOMPLETE`, `UNRESOLVED_ANOMALIES`, `INVALID_TRANSITION` |
| `billing.returnToDraft` | `billing_period_id`, lý do | `draft` | `INVALID_TRANSITION` |
| `billing.issuePeriod` | `billing_period_id`, `preview_hash` | `invoice_ids`, `journal_entry_ids` | `BILLING_PREVIEW_STALE`, `INVALID_TRANSITION`, `PERIOD_LOCKED`, `FORBIDDEN` |
| `billing.lockPeriod` | `billing_period_id` | `locked` (gọi `ledger.lockPeriod`; owner/manager/accountant) | `INVALID_TRANSITION`, `FORBIDDEN` |
| `billing.reopenPeriod` | `billing_period_id`, lý do (bắt buộc) | `issued` (`locked → issued`; gọi `ledger.unlockPeriod`; chỉ owner; audit) | `FORBIDDEN`, `VALIDATION_FAILED`, `INVALID_TRANSITION` |

- Khoá kỳ chỉ có **một cơ chế** là `period_locks` (SPEC-ledger-payments): `billing_periods.status='locked'` ⇔ có `period_locks` hiệu lực. `billing.lockPeriod`/`billing.reopenPeriod` là lớp bọc theo kỳ thu của `ledger.lockPeriod`/`ledger.unlockPeriod`, không có cờ khoá riêng.
- UI: bảng tuyến tầng (một tay, ô số lớn, ảnh), danh sách bất thường, màn xem trước (từng phòng mở rộng được, tổng kỳ cố định ở đáy), nút phát hành hiển thị tổng + số phiếu để xác nhận.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp | Scenario |
|---|---|---|---|---|
| `METER_READING_DECREASED` | Chỉ số < chỉ số đã duyệt trước | 422 | Chỉ số nhỏ hơn lần đọc trước. Nếu đã thay công tơ, dùng chức năng thay công tơ. | S-005 |
| `READINGS_INCOMPLETE` | Gửi duyệt khi còn phòng thiếu chỉ số | 409 | Còn phòng chưa nhập chỉ số. | S-009 |
| `UNRESOLVED_ANOMALIES` | Còn bất thường chưa ghi nhận | 409 | Còn chỉ số bất thường chưa kiểm tra. | S-008 |
| `BILLING_PREVIEW_STALE` | `preview_hash` khác số hiện tại | 409 | Số liệu đã thay đổi sau khi bạn xem trước. Hãy xem lại. | S-004 |
| `PERIOD_ISSUED` | Sửa số sau phát hành | 409 | Kỳ đã phát hành. Dùng chứng từ điều chỉnh. | S-011 |
| `PERIOD_LOCKED` | Ghi vào kỳ đã khoá | 409 | Kỳ đã khoá. Cần chứng từ điều chỉnh có duyệt. | S-012 |
| `DOCUMENT_IMMUTABLE` (mã chung) | Sửa trực tiếp phiếu đã phát hành, kể cả sau khi mở khoá kỳ | 409 | Phiếu đã phát hành, không sửa trực tiếp. Hãy tạo điều chỉnh. | S-012 |
| `INVALID_TRANSITION` | Chuyển trạng thái kỳ ngoài bảng (kể cả mở khoá kỳ không khoá) | 409 | Không thể chuyển kỳ thu sang trạng thái này. | S-012 |
| `FORBIDDEN` | Không đủ quyền (thay công tơ; mở khoá kỳ không phải owner) | 403 | Bạn không có quyền thực hiện thao tác này. | S-007, S-012 |
| `NOT_FOUND` | Không tồn tại/ngoài phạm vi | 404 | Không tìm thấy. | — |
| `VALIDATION_FAILED` | Sai trường; mở khoá kỳ không có lý do | 422 | Dữ liệu chưa hợp lệ: xem từng trường. | S-012 |
| `IDEMPOTENCY_CONFLICT` | Cùng key khác payload | 409 | Yêu cầu trùng mã nhưng khác nội dung. | S-015 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng | Xem trước 100 phòng p95 < 3 s; phát hành 100 phòng < 10 s (đề xuất, chờ PO) | PROJECT.md §5 (p95 API thường < 800 ms) | k6 + test tích hợp |
| Đúng tiền | Property test ≥ 1.000 bộ ngẫu nhiên: tổng = Σ dòng; Σ Nợ = Σ Có | T074 | Vitest + fast-check |
| Tiếp cận | Ô nhập chỉ số ≥ 44 px, bàn phím số trên mobile | PROJECT.md §5 | axe + kiểm tay |

## 8. Hành vi AI
Không áp dụng (OCR công tơ có người duyệt nằm ngoài pilot).

## 9. Đo lường
- `billing_period.created` → `billing_period.issued` (M-01); `meter_reading.recorded`, `meter_reading.anomaly_flagged`, `invoice.issued`, `billing_period.locked`, `billing_period.reopened`.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [x] Quy tắc prorata kỳ đầu/cuối lẻ — [chặn] — hỏi: PO. **Đề xuất:** `giá × số ngày tính tiền / số ngày thực của tháng` (28/29/30/31); trọn tháng luôn = giá tháng; ngày bắt đầu và ngày kết thúc đều tính. Phương án khác: chia cố định 30. — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** `actual_days` (giá × ngày tính / ngày thực của tháng, tính cả ngày đầu và cuối; trọn tháng = giá tháng); tham số `properties.settings.prorata` = `actual_days` | `fixed_30`, lưu ở mỗi chứng từ (INV-G3).
- [x] Làm tròn: đến 1 đ hay 1.000 đ; từng dòng hay tổng — [chặn] — hỏi: PO + kế toán. **Đề xuất:** `HALF_UP_1` (nửa lên, đến 1 đ) **từng dòng**; tổng phiếu = Σ dòng, không làm tròn lại tổng. Nếu cơ sở muốn tròn 1.000 đ thì thêm quy tắc `HALF_UP_1000` theo cơ sở, lưu ở mỗi chứng từ. — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** `HALF_UP_1` từng dòng, tổng = Σ dòng; tham số `properties.settings.rounding` = `HALF_UP_1` | `HALF_UP_1000`, lưu ở mỗi chứng từ.
- [x] Kỳ thu theo tháng dương lịch hay theo ngày bắt đầu hợp đồng; tiền thuê thu trước hay sau; điện nước của tháng nào — [chặn] — hỏi: PO (quan sát tuần 1–2). **Đề xuất:** kỳ = tháng dương lịch của cơ sở; tiền thuê và điện nước cùng tháng, thu sau (phát hành cuối kỳ); cấu hình `rent_timing` để mở rộng. — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** tháng dương lịch của cơ sở; tiền thuê và điện nước cùng tháng, phát hành cuối kỳ; tham số `rent_timing` = `arrears` (mặc định) | `advance`.
- [ ] Ghi nhận doanh thu khi phát hành hay khi kỳ kết thúc — [không chặn pilot, chặn báo cáo doanh thu] — hỏi: kế toán. **Đề xuất:** khi phát hành (đúng bảng bút toán DOMAIN-MODEL §5).
- [ ] Ngưỡng bất thường công tơ — [không chặn] — hỏi: PO. **Đề xuất:** cảnh báo khi lượng > 2 × trung bình 3 kỳ trước, hoặc = 0 khi phòng có người ở; cơ sở chỉnh hệ số.
- [ ] Biểu giá điện bậc thang — [không chặn] — hỏi: PO + pháp lý. **Đề xuất:** pilot chỉ đơn giá phẳng do cơ sở nhập + ô căn cứ; bậc thang để V1.
- [ ] Số người cho phí `per_person` khi người ở đổi giữa kỳ — [không chặn] — hỏi: PO. **Đề xuất:** đếm người ở có hiệu lực ngày cuối kỳ.
- [x] `reviewing → draft` (trả lại sửa) và `locked → issued` (chỉ owner, lý do + audit) — đã bổ sung DOMAIN-MODEL v1.2 §4 (có lý do và audit).
- [x] Bổ sung `services`, `service_prices`, `meter_events` vào DOMAIN-MODEL — [chặn migration] — đã bổ sung DOMAIN-MODEL v1.2 §7.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu [chặn] · DOMAIN-MODEL v1.2 đã bổ sung mọi tên bảng · SPEC-lease Approved.
- DoD: mọi S-NNN có test (S-002, S-013, S-015 trên Postgres thật) · property test tiền xanh · E2E R-001 phần kỳ thu · sự kiện đo có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T028 Dịch vụ định kỳ, phí một lần | — | S-016, S-017 |
| T029 Chốt chỉ số, bất thường | — | S-005…S-010 |
| T030 Sinh kỳ thu, prorata | — | S-001…S-004, S-011…S-015, S-018…S-021 |
| T074 Test thời gian và tiền | — | S-018…S-020 |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | Tạo | G3 cho F-004 | (chưa) |
| 2 | 2026-10-15 | Sửa theo review độc lập: `billing.reopenPeriod` chỉ owner, `locked → issued`, một cơ chế `period_locks`, sửa S-012 (O3); S-009 thêm `readings_pending` (G18); đóng câu hỏi bảng/`reviewing → draft` (G5) | Review độc lập; DOMAIN-MODEL v1.2 | (chưa) |
