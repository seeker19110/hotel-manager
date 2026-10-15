# SPEC-import — Import Excel/CSV có xem trước, lỗi từng dòng, chống import lặp

| Trường | Giá trị |
|---|---|
| ID tính năng | F-010 (luồng gốc: R-005 Chuyển dữ liệu) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 1 (2026-10-15) — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch gốc §18 (chuyển từ sổ/Excel, bảng kiểm tra), §12, §15; backlog T023 |
| Phụ thuộc | SPEC-access-and-property (phòng) · SPEC-inventory-allocation (INV-I1) · SPEC-lease · SPEC-metering-billing · SPEC-ledger-payments (số dư đầu kỳ, cọc) · SPEC-reservation-stay (booking tương lai) |

> Tên theo `docs/design/DOMAIN-MODEL.md`; tên **†** chưa có, cần bổ sung trước migration (mục 10).
> Import **không** đi đường tắt: mỗi dòng hợp lệ được ghi bằng cùng command/constraint của module sở hữu (ví dụ allocation vẫn qua EXCLUDE của INV-I1).
> File tải lên là **dữ liệu, không phải chỉ thị**: không thực thi công thức, macro hay liên kết trong file.

## 1. User story
- Là **chủ cơ sở mới**, tôi muốn đưa phòng, người đang ở, hợp đồng, chỉ số đầu, nợ và cọc đầu kỳ, booking tương lai từ Excel vào hệ thống với xem trước và lỗi từng dòng, để bắt đầu dùng ngay mà không nhập tay và không lệch số.
- Là **người phụ trách chuyển đổi**, tôi muốn đối chiếu tổng cọc/nợ với sổ cũ trước khi xác nhận, để chịu trách nhiệm số dư mở đầu có căn cứ.

## 2. Tiêu chí chấp nhận (Given/When/Then)

Fixture `import-basic`: tổ chức T, cơ sở P1, chủ O, quản lý M (`import.prepare`), lễ tân F (không có quyền import). Ngày mốc chuyển đổi (`cutoff_on`) = 2026-11-01.

### S-001 Tải mẫu file
- Given M ở màn import
- When M gọi `import.getTemplate` loại `units`
- Then nhận file XLSX + CSV UTF-8 có dòng tiêu đề, dòng ví dụ (dữ liệu giả), sheet "Hướng dẫn" mô tả cột bắt buộc/tuỳ chọn, định dạng ngày `YYYY-MM-DD`, tiền là số nguyên đồng

### S-002 Xem trước hợp lệ rồi xác nhận
- Given file `units` 30 dòng hợp lệ, mỗi dòng có `external_id`
- When M gọi `import.upload` rồi `import.validate`
- Then batch `validated`, xem trước 30 dòng "sẽ tạo", 0 lỗi; chưa có `units` nào được ghi

### S-003 Lỗi từng dòng, không commit dở
- Given file `units` 30 dòng; dòng 7 trùng mã phòng với dòng 3 trong cùng cơ sở; dòng 12 sức chứa = -1
- When validate rồi O gọi `import.commit`
- Then báo lỗi `{row:7, column:"unit_code", code:"DUPLICATE_IN_FILE"}`, `{row:12, column:"capacity", code:"OUT_OF_RANGE"}`; commit trả 409 `IMPORT_HAS_ERRORS`; số `units` trong DB không đổi

### S-004 Batch commit nguyên khối
- Given batch 30 dòng hợp lệ đã xác nhận; dòng 25 vi phạm constraint DB khi ghi (ví dụ phòng vừa được người khác tạo trùng mã)
- When `import.commit`
- Then toàn bộ transaction rollback, 0 dòng được ghi; batch về `validated` kèm lỗi dòng 25 (`code:"CONFLICT_AT_COMMIT"`)

### S-005 Import lại cùng file không nhân đôi
- Given batch `units` đã `committed` với `external_id` U-001…U-030
- When M import lại đúng file đó
- Then xem trước: 30 dòng "không đổi — bỏ qua"; commit tạo 0 bản ghi; số dư/phòng không nhân đôi

### S-006 `external_id` đã có nhưng nội dung khác
- Given U-005 đã import với sức chứa 2
- When import lại U-005 với sức chứa 3
- Then lỗi dòng `IMPORT_EXTERNAL_ID_CONFLICT` (V1 không cập nhật qua import; sửa trên giao diện)

### S-007 Hợp đồng đang chạy + người ở
- Given file `leases` 2 dòng: hợp đồng HD-01 (U101, người thuê "Nguyễn Văn A" + SĐT, giá 3.000.000, `billing_start_on`=2026-03-01, hết hạn 2027-02-28, cọc 3.000.000), người ở thêm 1 người
- When validate và commit
- Then tạo `persons`, `leases` (`active`), `lease_versions` số 1 (`kind`=`original`, ghi `source=import`), `lease_occupants`, allocation `kind='lease'`, và `handovers` loại `move_in` nguồn `import` (bàn giao chuyển đổi do người xác nhận batch xác nhận) — hợp đồng không `active` khi thiếu bàn giao (DOMAIN-MODEL §4)

### S-008 Hợp đồng chồng nhau (INV-I1)
- Given hai dòng hợp đồng cùng U101, khoảng chồng 2026-03-01→2027-02-28 và 2026-12-01→2027-11-30
- When validate
- Then dòng thứ hai lỗi `ROOM_UNAVAILABLE` kèm `external_id` dòng bị chồng; batch không commit được

### S-009 Booking tương lai trùng phòng
- Given U201 đã có booking 2026-11-10→2026-11-12 trong hệ thống
- When import booking U201 2026-11-11→2026-11-13
- Then lỗi dòng `ROOM_UNAVAILABLE`; dòng booking khác trong file vẫn hiện "sẽ tạo" ở xem trước

### S-010 Chỉ số đầu
- Given file `meter_readings`: U101 điện 1.250 ngày 2026-11-01, nước 340
- When commit
- Then `meter_readings` nguồn `import`, đã duyệt, `read_on`=2026-11-01; kỳ thu 11/2026 dùng 1.250 làm chỉ số đầu; chỉ số âm → lỗi dòng `OUT_OF_RANGE`

### S-011 Nợ đầu kỳ = chứng từ số dư đầu kỳ, không bịa doanh thu
- Given file `opening_balances`: người thuê A nợ 1.580.000 đ tại `cutoff_on`
- When commit
- Then tạo 1 `invoices` loại `opening_balance` 1.580.000 đ (một dòng "Số dư đầu kỳ") và bút toán Nợ `AR` 1.580.000 / Có `OPENING_BALANCE`† 1.580.000; **không** có dòng `REV_*`; báo cáo doanh thu trước `cutoff_on` = 0

### S-012 Cọc đầu kỳ
- Given file `opening_balances`: cọc HD-01 3.000.000 đ
- When commit
- Then `deposits` 3.000.000 gắn HD-01 và bút toán Nợ `OPENING_BALANCE`† 3.000.000 / Có `DEPOSIT_LIAB` 3.000.000; không ghi `CASH`/`BANK`

### S-013 Đối chiếu tổng cọc/nợ với số nguồn
- Given người phụ trách nhập tổng nguồn: nợ 12.450.000 đ, cọc 45.000.000 đ; file cho nợ 12.450.000, cọc 42.000.000
- When `import.commit`
- Then 409 `IMPORT_TOTALS_MISMATCH` kèm `{deposit:{expected:45000000, actual:42000000, diff:-3000000}}`; sửa file cho khớp thì commit được

### S-014 Bắt buộc người phụ trách xác nhận
- Given batch hợp lệ (mọi loại đều cần xác nhận; ở đây `opening_balances`), tổng khớp, chưa xác nhận
- When M gọi `import.commit`
- Then 409 `IMPORT_CONFIRMATION_REQUIRED`; O gọi `import.confirm` (ghi tên, thời điểm, tổng đã đối chiếu) rồi commit thành công

### S-015 Không có quyền
- Given F không có quyền `import.prepare`
- When F gọi `import.upload`
- Then 403 `FORBIDDEN`

### S-016 Huỷ batch chưa commit
- Given batch `validated`
- When M gọi `import.cancel`
- Then batch `cancelled`; file gốc xoá theo hạn giữ (mục 10); không có dữ liệu nghiệp vụ nào được ghi; huỷ batch `committed` → 409 `INVALID_TRANSITION`

### S-017 Commit lặp (INV-G5)
- Given `import.commit` thành công với key K1
- When gửi lại K1; hai người bấm commit cùng lúc bằng key khác nhau
- Then lần lặp trả kết quả cũ; lệnh song song: 1 thành công, lệnh kia 409 `INVALID_TRANSITION` (batch đã `committed`)

### S-018 Chống CSV formula injection khi xuất lỗi
- Given dòng có tên `=HYPERLINK("http://x","bấm")` và ghi chú `+84 912…`, `@SUM(A1)`, `-1+2`
- When M tải `import.downloadErrorReport`
- Then dùng đúng bộ chống formula injection của SPEC-audit-reporting (S-016): ô văn bản bắt đầu bằng `=`, `+`, `-`, `@`, tab hoặc CR được thêm tiền tố `'`; mở bằng Excel/LibreOffice không chạy công thức; cột số giữ kiểu số

### S-019 File có công thức hoặc định dạng lạ
- Given XLSX có ô `=B2*2` và ô ngày kiểu số seri Excel
- When upload
- Then chỉ đọc giá trị đã lưu (không tính lại); ngày seri được chuyển đúng sang `date` và hiện ở xem trước; macro/liên kết ngoài bị bỏ qua

### S-020 Scenario Outline — số dư đầu kỳ
- Given dòng số dư loại `<loai>` số tiền `<tien>` (chuỗi trong file)
- When validate
- Then kết quả `<kq>`
- Examples:

| loai | tien | kq |
|---|---|---|
| nợ | 1580000 | sẽ tạo phiếu số dư đầu kỳ 1.580.000 |
| nợ | 0 | bỏ qua, ghi chú "không có số dư" |
| nợ | 1 | sẽ tạo 1 đ |
| cọc | 3.000.000 | sẽ tạo cọc 3.000.000 (dấu chấm phân cách nghìn được chấp nhận) |
| nợ | 1580000,5 | lỗi `NOT_INTEGER_VND` |
| nợ | -500000 | lỗi `OUT_OF_RANGE` (trả thừa nhập ở cột "số dư khách") |
| cọc | (trống) | lỗi `REQUIRED` |

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | File chỉ có tiêu đề; ô bắt buộc trống; `external_id` trống | File rỗng → 422 `VALIDATION_FAILED`; dòng lỗi `REQUIRED` | S-020 |
| Cực đại/độ dài | > 5.000 dòng hoặc > 5 MB (đề xuất); ô > 500 ký tự | 413 `FILE_TOO_LARGE`; lỗi dòng `TOO_LONG` | — |
| Trùng lặp/idempotency | Import lại cùng file; trùng trong file; commit lặp | Bỏ qua dòng không đổi; lỗi dòng trùng; commit 1 hiệu lực | S-003, S-005, S-017 |
| Song song | 2 batch cùng tạo một phòng; 2 người commit | Constraint DB → rollback cả batch, lỗi dòng; 1 commit thắng | S-004, S-017 |
| Mất mạng giữa chừng | Mất mạng khi upload/commit | Upload lỗi thì tải lại; commit timeout thì hỏi kết quả command; không commit dở | S-004 |
| Thời gian/múi giờ | Ngày `dd/mm/yyyy` vs `yyyy-mm-dd`; ngày seri Excel; giờ booking không có múi giờ | Chỉ nhận định dạng mẫu + seri Excel; giờ hiểu theo `properties.timezone` | S-019 |
| Quyền | Lễ tân upload; người chuẩn bị tự xác nhận số dư tiền | 403; xác nhận số dư cần `import.confirm` (owner) | S-014, S-015 |
| Tiền/đơn vị | 0 đ, 1 đ, số lẻ, số âm, dấu phân cách nghìn | Số nguyên đồng; lỗi rõ | S-020 |

## 4. Dữ liệu
| Thực thể | Trường chính | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|
| `import_batches`† | `property_id`, `kind` (`units`/`leases`/`meter_readings`/`opening_balances`/`reservations`), `status` (`uploaded → validated → confirmed → committed`; `cancelled`), `file_id`, `file_sha256`, `expected_totals`, `actual_totals`, `confirmed_by`, `confirmed_at`, `cutoff_on` | Chuyển trạng thái qua bảng chuyển; `committed` bất biến | manager chuẩn bị; owner xác nhận |
| `import_rows`† | `batch_id`, `row_no`, `external_id`, `row_hash`, `action` (`create`/`skip_unchanged`/`error`), `errors` (json: cột, mã, thông điệp), `target_id` | | như trên |
| `import_external_refs`† | `organization_id`, `kind`, `external_id`, `target_id`, `row_hash` | unique `(organization_id, kind, external_id)` | hệ thống |
| Bảng đích | `units`, `persons`, `leases`, `lease_versions`, `lease_occupants`, `handovers`, `meters`, `meter_readings`, `invoices`, `deposits`, `journal_entries`, `reservations`, `allocations` | Constraint của module sở hữu áp nguyên vẹn | |

- Giấy tờ cá nhân: chỉ nhận số giấy tờ khi có căn cứ (cột tuỳ chọn, đi vào `identity_documents`); **không** import ảnh giấy tờ (kế hoạch §18). File nguồn lưu riêng tư, có hạn xoá.
- Số dư đầu kỳ ghi `business_date` = `cutoff_on`; đề xuất khoá kỳ trước `cutoff_on` (`period_locks`) ngay khi commit.

## 5. Giao diện / API
| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `import.getTemplate` | `kind` | file XLSX/CSV mẫu | `VALIDATION_FAILED` |
| `import.upload` | `property_id`, `kind`, file, `cutoff_on` | `batch_id` (`uploaded`) | `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `FORBIDDEN` |
| `import.validate` | `batch_id` | xem trước: số dòng tạo/bỏ qua/lỗi, tổng tiền, lỗi từng dòng | `INVALID_TRANSITION` |
| `import.setExpectedTotals` | `batch_id`, tổng nợ, tổng cọc theo cơ sở (và theo khách nếu có) | chênh lệch | `VALIDATION_FAILED` |
| `import.confirm` | `batch_id` | `confirmed` | `IMPORT_HAS_ERRORS`, `IMPORT_TOTALS_MISMATCH`, `FORBIDDEN` |
| `import.commit` | `batch_id` | `committed`, số bản ghi tạo theo bảng | `IMPORT_HAS_ERRORS`, `IMPORT_TOTALS_MISMATCH`, `IMPORT_CONFIRMATION_REQUIRED`, `INVALID_TRANSITION` |
| `import.cancel` | `batch_id`, lý do | `cancelled` | `INVALID_TRANSITION` |
| `import.get` / `import.list` | `batch_id` / cơ sở | trạng thái, lỗi, ai xác nhận | `NOT_FOUND` |
| `import.downloadErrorReport` | `batch_id` | CSV lỗi đã chống injection | `NOT_FOUND` |

- Thứ tự gợi ý: `units` → `leases` → `meter_readings` → `opening_balances` → `reservations` (phụ thuộc theo `external_id` của batch trước; tham chiếu chưa có → lỗi dòng `REFERENCE_NOT_FOUND`).
- UI: bước 1 chọn loại + tải mẫu → bước 2 upload → bước 3 xem trước (lọc dòng lỗi, tổng) → bước 4 đối chiếu tổng + xác nhận → bước 5 kết quả. Bảng lỗi đọc được bằng trình đọc màn hình (số dòng, cột, lỗi).

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp | Scenario |
|---|---|---|---|---|
| `IMPORT_HAS_ERRORS` | Commit/xác nhận khi còn dòng lỗi | 409 | Còn dòng lỗi. Sửa file và tải lại. | S-003 |
| `IMPORT_TOTALS_MISMATCH` | Tổng cọc/nợ khác tổng nguồn | 409 | Tổng trong file khác tổng bạn đã đối chiếu. | S-013 |
| `IMPORT_CONFIRMATION_REQUIRED` | Commit số dư khi chưa xác nhận | 409 | Cần người phụ trách xác nhận trước khi nhập. | S-014 |
| `IMPORT_EXTERNAL_ID_CONFLICT` (lỗi dòng) | `external_id` đã có, nội dung khác | — | Mã ngoài đã nhập trước đó với nội dung khác. | S-006 |
| `ROOM_UNAVAILABLE` (lỗi dòng) | Chồng allocation | — | Phòng đã có người hoặc đã được giữ trong khoảng này. | S-008, S-009 |
| `DUPLICATE_IN_FILE`, `OUT_OF_RANGE`, `REQUIRED`, `NOT_INTEGER_VND`, `TOO_LONG`, `REFERENCE_NOT_FOUND`, `CONFLICT_AT_COMMIT` (lỗi dòng) | Kiểm từng dòng | — | Thông điệp tiếng Việt theo cột | S-003, S-004, S-020 |
| `FILE_TOO_LARGE` | Vượt giới hạn | 413 | File quá lớn. Tách thành nhiều file. | — |
| `FILE_TYPE_NOT_ALLOWED` | Không phải XLSX/CSV UTF-8 | 415 | Chỉ nhận file .xlsx hoặc .csv (UTF-8). | — |
| `INVALID_TRANSITION` | Huỷ/commit sai trạng thái | 409 | Không thể thực hiện với trạng thái hiện tại của lô nhập. | S-016, S-017 |
| `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_FAILED` / `IDEMPOTENCY_CONFLICT` | dùng chung | 403/404/422/409 | như các SPEC khác | S-015, S-017 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng | Validate 5.000 dòng < 30 s; commit trong 1 transaction < 60 s (đề xuất) | Kế hoạch §18 | test tích hợp |
| Toàn vẹn | 0 bản ghi khi commit thất bại; import lại = 0 bản ghi mới | T023 | test Postgres thật |
| Bảo mật | Không thực thi nội dung file; chống formula injection; giới hạn kích thước; file riêng tư | Kế hoạch §15–16; OWASP CSV Injection (chưa xác minh phiên bản) | test đơn vị + review |

## 8. Hành vi AI
Không áp dụng.

## 9. Đo lường
- `import_batch.uploaded`, `import_batch.validated` (số lỗi), `import_batch.committed`, `import_batch.cancelled` → R-005, M-04 (tổng đối chiếu khớp).

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] DOMAIN-MODEL §5 chưa có tài khoản đối ứng cho số dư đầu kỳ — [chặn] — hỏi: kế toán + Tech Lead. **Đề xuất:** thêm `OPENING_BALANCE` (Vốn/chênh lệch mở đầu, chỉ dùng cho chứng từ chuyển đổi) và 2 bút toán ở S-011, S-012; không dùng `REV_*`.
- [ ] Trả thừa đầu kỳ (khách có số dư) — [không chặn] — hỏi: kế toán. **Đề xuất:** cột riêng → Nợ `OPENING_BALANCE`† / Có `CUSTOMER_CREDIT`.
- [ ] Ai được xác nhận số dư chuyển đổi — [không chặn] — hỏi: PO. **Đề xuất:** chỉ `owner` (hoặc đại diện pilot được chỉ định), khác người chuẩn bị.
- [ ] Giới hạn file và hạn giữ file nguồn — [không chặn] — hỏi: PO + pháp lý. **Đề xuất:** 5 MB / 5.000 dòng; xoá file nguồn 30 ngày sau commit/huỷ.
- [ ] Import cập nhật (delta có sửa) — [không chặn pilot] — hỏi: PO. **Đề xuất:** V1 chỉ thêm mới; sửa qua giao diện; rollback batch đã commit để T070.
- [ ] Khoá kỳ trước `cutoff_on` tự động khi commit — [không chặn] — hỏi: kế toán. **Đề xuất:** có.
- [ ] Bổ sung `import_batches`†, `import_rows`†, `import_external_refs`†, `OPENING_BALANCE`† vào DOMAIN-MODEL — [chặn migration] — hỏi: Tech Lead.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu [chặn] · DOMAIN-MODEL bổ sung tên † · SPEC-lease, SPEC-ledger-payments Approved.
- DoD: mọi S-NNN có test (S-004, S-005, S-008, S-017 trên Postgres thật) · E2E R-005 · test formula injection · sự kiện đo có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T023 Import Excel/CSV | — | S-001…S-020 |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | Tạo | G3 cho F-010 | (chưa) |
