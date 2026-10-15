# SPEC-lease — Hợp đồng thuê dài hạn: người ở, phiên bản điều khoản, bàn giao, gia hạn, thanh lý

| Trường | Giá trị |
|---|---|
| ID tính năng | F-003 (luồng gốc: R-002 Vòng đời hợp đồng) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 (2026-10-15) — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch gốc §05, §07 (vòng đời giao dịch), §12, §15; backlog T025–T027, T031, T032; DOMAIN-MODEL v1.2 §4, §5, §7 |
| Phụ thuộc | SPEC-access-and-property (quyền, phạm vi cơ sở) · SPEC-inventory-allocation (allocation `kind='lease'`) · SPEC-metering-billing (chỉ số, kỳ thu) · SPEC-ledger-payments (cọc, khấu trừ, hoàn) · SPEC-notifications (outbox) |

> Tên thực thể/trạng thái/tài khoản theo `docs/design/DOMAIN-MODEL.md` v1.2; mọi bảng của spec này (`lease_settlements`, `services`, `lease_occupants`…) đã có ở §1/§7, không còn tên **†**.
> Mọi lỗi trả `application/problem+json` có trường `code` (mục 6). Mọi command ghi nhận `Idempotency-Key` (INV-G5).

## 1. User story
- Là **quản lý cơ sở trọ**, tôi muốn lập hợp đồng có phiên bản điều khoản, ghi người ở và bàn giao có chỉ số đầu, để kỳ thu tính đúng từ ngày bắt đầu tính tiền và tranh chấp có căn cứ.
- Là **chủ trọ**, tôi muốn gia hạn bằng phụ lục và thanh lý có chốt nợ, khấu trừ/hoàn cọc có duyệt, để không mất lịch sử giá và không hoàn sai cọc.
- Là **người thuê**, tôi muốn xem hợp đồng và biên bản bàn giao trên portal, để biết mình đã cam kết gì.

## 2. Tiêu chí chấp nhận (Given/When/Then)

Dữ liệu nền chung (fixture `lease-basic`): cơ sở P1 (trọ, `Asia/Ho_Chi_Minh`), phòng U101, người thuê A (`persons`), quản lý M (`manager`, phạm vi P1), lễ tân F (`front_desk`), buồng phòng H (`housekeeping`).

### S-001 Tạo hợp đồng nháp với phiên bản 1 và bốn mốc ngày tách biệt
- Given phòng U101 trống từ 2026-11-01
- When M gọi `lease.createDraft` với giá 3.000.000 đ/tháng, kỳ thu `monthly`, cọc 3.000.000 đ, dịch vụ [điện, nước, phí khác 100.000 đ], `signed_on`=2026-10-20, `billing_start_on`=2026-11-01, hiệu lực 2026-11-01 → 2027-10-31
- Then hợp đồng ở trạng thái `draft`, có `lease_versions` số 1; `signed_on`, `billing_start_on`, ngày bàn giao (`handovers`, chưa có) và `moved_out_on` (null) là 4 trường riêng; chưa tạo allocation

### S-002 Ký hợp đồng: điều khoản bất biến và giữ phòng
- Given hợp đồng S-001 ở `pending_signature`
- When M gọi `lease.sign` với người ký A
- Then trạng thái `signed_awaiting_handover`; phiên bản 1 lưu `terms_snapshot` + `terms_hash` (SHA-256); allocation `kind='lease'` active cho U101 từ 00:00 giờ cơ sở ngày 2026-11-01 (mốc giờ theo đề xuất Q-04, mục 10; nếu có hold của hợp đồng này thì hold được chuyển thành allocation `lease`, S-023); audit `lease.signed`

### S-003 Không sửa điều khoản sau ký
- Given hợp đồng đã ký (S-002)
- When M gọi `lease.updateDraft` đổi giá phiên bản 1 thành 2.800.000 đ
- Then lỗi 409 `DOCUMENT_IMMUTABLE` (mã chung, INV-G4); giá phiên bản 1 vẫn 3.000.000 đ; hướng dẫn lập phụ lục (`lease.renew`)

### S-004 Ký khi phòng đã bị chiếm (INV-I1)
- Given U101 có allocation `stay` active 2026-10-30 → 2026-11-03
- When M gọi `lease.sign` cho hợp đồng bắt đầu 2026-11-01
- Then lỗi 409 `ROOM_UNAVAILABLE`; hợp đồng vẫn `pending_signature`; không có allocation mới

### S-005 Không kích hoạt khi chưa có bàn giao
- Given hợp đồng `signed_awaiting_handover`, chưa có `handovers` loại `move_in` đã xác nhận
- When M gọi `lease.activate`
- Then lỗi 409 `HANDOVER_REQUIRED`; trạng thái không đổi; audit ghi lần bị từ chối

### S-006 Bàn giao nhận phòng rồi kích hoạt
- Given hợp đồng `signed_awaiting_handover`
- When F gọi `lease.recordHandover` loại `move_in` ngày 2026-11-01 với chỉ số điện 1.250, nước 340, 3 tài sản (tình trạng + ảnh), 2 chìa khoá, xác nhận của F và của A (`confirmed_by_tenant_at`), rồi M gọi `lease.activate`
- Then `handovers` lưu đủ; tạo `meter_readings` nguồn `handover`, trạng thái đã duyệt (điện 1.250, nước 340); hợp đồng `active`; kỳ thu sau dùng 1.250 làm chỉ số đầu

### S-007 Bàn giao thiếu mục bắt buộc
- Given hợp đồng `signed_awaiting_handover`, U101 có công tơ điện và nước
- When F gọi `lease.recordHandover` không có chỉ số nước
- Then lỗi 422 `VALIDATION_FAILED`, `errors[0].field`=`readings.water`; không lưu biên bản dở

### S-008 Người ở và PII tối thiểu
- Given hợp đồng S-001
- When M gọi `lease.addOccupant` cho B với họ tên + SĐT, vai trò `occupant`, không có số giấy tờ
- Then thêm `lease_occupants` (B) thành công; số/ảnh giấy tờ là tuỳ chọn và nếu có thì nằm ở `identity_documents`; A là `representative`=true duy nhất

### S-009 Buồng phòng không đọc giấy tờ (quyền PII)
- Given A có `identity_documents` (ảnh CCCD)
- When H gọi `person.get` cho A (và xin URL ký file giấy tờ của A)
- Then lỗi 404 `NOT_FOUND` (quy ước SPEC-access-and-property mục 2: tài nguyên vai trò không được đọc thì 404, không 403, không lộ sự tồn tại); phản hồi không chứa họ tên, SĐT hay số giấy tờ; không cấp URL ký; audit ghi lần truy cập bị từ chối

### S-010 Người thuê chỉ xem hợp đồng của mình
- Given người thuê A (portal, `tenant`) và hợp đồng L2 của người khác
- When A gọi `lease.get` cho L2
- Then lỗi 404 `NOT_FOUND` (không lộ sự tồn tại); `lease.get` cho hợp đồng của A trả phiên bản đang hiệu lực và biên bản bàn giao

### S-011 Gia hạn bằng phụ lục, giữ lịch sử giá
- Given hợp đồng `active`, phiên bản 1: 3.000.000 đ, hiệu lực đến 2027-10-31
- When M gọi `lease.renew` tạo phiên bản 2: giá 3.300.000 đ, `effective_from`=2027-11-01, hết hạn 2028-10-31
- Then có 2 phiên bản, khoảng hiệu lực không chồng; phiên bản 1 không đổi; kỳ thu 10/2027 dùng 3.000.000 đ, kỳ 11/2027 dùng 3.300.000 đ

### S-012 Tăng giá giữa kỳ chỉ áp từ ngày hiệu lực
- Given phiên bản 1 (3.000.000 đ) hiệu lực đến 2026-11-14, phiên bản 2 (3.300.000 đ) từ 2026-11-15
- When kỳ thu 11/2026 được xem trước (quy tắc prorata đề xuất ở mục 10)
- Then dòng tiền thuê = 3.000.000 × 14/30 + 3.300.000 × 16/30 = 1.400.000 + 1.760.000 = **3.160.000 đ**

### S-013 Phụ lục chồng hiệu lực
- Given phiên bản 2 hiệu lực từ 2027-11-01
- When M gọi `lease.renew` với `effective_from`=2027-10-15
- Then lỗi 409 `LEASE_VERSION_OVERLAP`

### S-014 Nhắc hết hạn không gửi lặp
- Given hợp đồng hết hạn 2027-10-31, mốc nhắc 30/7/0 ngày (cấu hình cơ sở)
- When job `lease.remindExpiring` chạy 3 lần trong ngày 2027-10-01 (giờ địa phương)
- Then đúng 1 bản ghi outbox khoá dedupe `(lease_id, version_no, 30)`; lần 2–3 không tạo thêm

### S-015 Quá hạn chưa bàn giao trả → cảnh báo chiếm dụng (INV-I4 áp cho hợp đồng)
- Given hợp đồng hết hạn 2027-10-31, không gia hạn, chưa có `handovers` loại `move_out`
- When job chạy ngày 2027-11-01 (giờ địa phương)
- Then allocation của hợp đồng **không** tự kết thúc; tạo `exception` loại `LEASE_OVERSTAY` cho M; nếu U101 có allocation khác từ 2027-11-01 thì exception ghi rõ allocation bị đụng; không tự huỷ bên nào

### S-016 Báo trả phòng
- Given hợp đồng `active`
- When M gọi `lease.giveNotice` với `planned_move_out_on`=2027-03-15
- Then trạng thái `notice_given`; allocation chưa đổi

### S-017 Thanh lý: phí hư hỏng thành phiếu trước, khấu trừ không vượt AR còn mở, hoàn phần còn lại
- Given hợp đồng `notice_given`, cọc 3.000.000 đ (`DEPOSIT_LIAB`), phiếu I1 của L1 còn mở (`AR`) 1.580.000 đ, bàn giao trả ngày 2027-03-15 ghi phí hư hỏng 200.000 đ (lý do + ảnh)
- When F gọi `lease.recordHandover` loại `move_out`, M gọi `lease.prepareSettlement` (khai phí hư hỏng 200.000 và khấu trừ), rồi chủ O gọi `lease.approveSettlement`
- Then trạng thái `settling` sau bàn giao trả; trước khi O duyệt chưa có bút toán nào. Khi duyệt, trong **một** transaction, theo thứ tự: **(1)** tạo charge/phiếu phí hư hỏng I-HH liên kết `lease_id`: Nợ `AR` 200.000 / Có `REV_FEE` 200.000, nên AR còn mở của các phiếu liên kết = 1.580.000 + 200.000 = 1.780.000; **(2)** khấu trừ = min(cọc 3.000.000; AR còn mở 1.780.000) = **1.780.000 đ**: Nợ `DEPOSIT_LIAB` 1.780.000 / Có `AR` 1.780.000 (I1 1.580.000 + I-HH 200.000), AR còn 0; **(3)** hoàn = 3.000.000 − 1.780.000 = **1.220.000 đ**: Nợ `DEPOSIT_LIAB` 1.220.000 / Có `CASH`/`BANK`; tổng Nợ `DEPOSIT_LIAB` = 1.780.000 + 1.220.000 = 3.000.000 nên cọc còn 0; mọi chứng từ liên kết `lease_id`. Sau duyệt mới `closed` và allocation kết thúc: `moved_out_on`=2027-03-15, `upper(during)` = 00:00 giờ cơ sở ngày 2027-03-16 (00:00 ngày sau ngày thực trả, đề xuất Q-04) nên phòng trống từ 16/03

### S-018 Cọc không tự trừ (INV-F5)
- Given hợp đồng `settling`, quyết toán chưa duyệt
- When M gọi `lease.close`
- Then lỗi 409 `SETTLEMENT_REQUIRED`; không có bút toán nào trên `DEPOSIT_LIAB`

### S-019 Người lập không tự duyệt quyết toán
- Given M lập quyết toán S-017
- When M gọi `lease.approveSettlement`
- Then lỗi 403 `SELF_APPROVAL_FORBIDDEN`

### S-020 Chuyển trạng thái ngoài bảng
- Given hợp đồng `draft`
- When gọi `lease.giveNotice`
- Then lỗi 409 `INVALID_TRANSITION` kèm `from`=`draft`, `to`=`notice_given`; audit ghi lần bị từ chối

### S-021 Scenario Outline — quyết toán cọc
- Given cọc `<coc>` đ, nợ còn mở (AR) `<no>` đ, phí hư hỏng `<phi>` đ (phí được tạo thành phiếu/AR **trước** khi khấu trừ)
- When quyết toán được duyệt
- Then khấu trừ `<khau_tru>` = min(cọc, nợ + phí) đ, hoàn `<hoan>` = cọc − khấu trừ đ, nợ còn lại sau thanh lý `<no_sau>` = nợ + phí − khấu trừ đ
- Examples:

| coc | no | phi | khau_tru | hoan | no_sau |
|---|---|---|---|---|---|
| 3.000.000 | 1.580.000 | 200.000 | 1.780.000 | 1.220.000 | 0 |
| 3.000.000 | 0 | 0 | 0 | 3.000.000 | 0 |
| 0 | 1 | 0 | 0 | 0 | 1 |
| 3.000.000 | 3.580.000 | 0 | 3.000.000 | 0 | 580.000 |
| 1 | 1 | 0 | 1 | 0 | 0 |
| 100.000 | 0 | 200.000 | 100.000 | 0 | 100.000 |
| 3.000.000 | 0 | 200.000 | 200.000 | 2.800.000 | 0 |

### S-022 Gửi lại command (INV-G5)
- Given `lease.sign` đã thành công với `Idempotency-Key`=K1
- When gửi lại cùng K1 và cùng payload; rồi gửi K1 với người ký khác
- Then lần 2 trả đúng kết quả cũ, không tạo allocation thứ hai; lần 3 lỗi 409 `IDEMPOTENCY_CONFLICT`

### S-023 Giữ chỗ hợp đồng (`lease.hold`) có TTL riêng và nhận cọc giữ chỗ (đề xuất, chờ PO)
- Given U101 trống từ 2026-11-01; hợp đồng L-H `draft`; TTL giữ chỗ hợp đồng của P1 = 48 giờ (mặc định đề xuất, cấu hình theo cơ sở, mục 10); đồng hồ 2026-10-18 10:00 giờ VN (03:00Z); F có ca đang mở
- When M gọi `lease.hold` cho L-H; F gọi `deposit.receive` cọc giữ chỗ 1.000.000 đ tiền mặt gắn L-H (đi qua `payments` `pending → confirmed`, INV-F3b của SPEC-ledger-payments); M gọi `lease.sign` L-H trước hạn
- Then 1 allocation `kind='hold'` `active=true`, `source_id`=L-H, `during` bắt đầu 2026-11-01 00:00 giờ VN, `expires_at` = 2026-10-20 03:00Z (thời điểm commit + 48 giờ); trạng thái L-H không đổi (hợp đồng không có trạng thái `held`); cọc giữ chỗ vào `DEPOSIT_LIAB` 1.000.000 là một phần cọc hợp đồng (cùng `deposits`, không thu lại); khi `lease.sign` thành công, hold chuyển thành allocation `kind='lease'` (qua `inventory.confirmHold`), `expires_at` = null, phòng không có khoảng trống giữa hai trạng thái

### S-024 Người khác không giữ được phòng đang hold; hết hạn nhả đúng một lần
- Given hold của L-H trên U101 còn hạn (S-023); hợp đồng L-K cùng khoảng thời gian
- When M gọi `lease.hold` cho L-K; sau 2026-10-20 03:00Z, worker nhả hold chạy 3 lần (kể cả lệnh mới dọn hold quá hạn, INV-I3); rồi M gọi `lease.sign` L-H (hold của L-H đã quá hạn); rồi M gọi `lease.hold` cho L-K
- Then lệnh đầu → 409 `ROOM_UNAVAILABLE`, không có allocation mới; hold của L-H `active=false` đúng 1 lần, đúng 1 `audit_events` `allocation.hold_expired`; `lease.sign` L-H → 409 `HOLD_EXPIRED` (phải giữ lại); cọc giữ chỗ 1.000.000 **không** tự mất (vẫn `DEPOSIT_LIAB` gắn L-H, hoàn qua `deposit.requestRefund` hoặc tính vào cọc khi ký lại); `lease.hold` cho L-K sau khi hold nhả → thành công

### S-025 Khấu trừ không vượt AR còn mở của phiếu liên kết
- Given hợp đồng `settling`, cọc 3.000.000 đ, AR còn mở của các phiếu liên kết 1.000.000 đ, không có phí phát sinh
- When M gọi `lease.prepareSettlement` khai khấu trừ 1.500.000; rồi sửa thành 1.000.000
- Then lần 1 → 422 `VALIDATION_FAILED`, `errors[0].field`=`deductions[0].amount` (vượt AR còn mở 1.000.000; cọc không phải chỗ để "trừ trước" khi chưa có nợ); lần 2 thành công: khấu trừ 1.000.000, hoàn 2.000.000

### S-026 Hợp đồng đang chạy từ import: bàn giao chuyển đổi chưa có chỉ số (khớp SPEC-import S-007, S-010)
- Given batch `leases` (SPEC-import) tạo hợp đồng HD-01 `active` cho U101; file hợp đồng không có cột chỉ số công tơ
- When batch commit; rồi M gọi `billing.submitForReview`; sau đó batch `meter_readings` (SPEC-import S-010) commit với `read_on` = `cutoff_on` cho mọi công tơ điện/nước của U101
- Then `handovers` loại `move_in` có `source='import'` và `readings_pending=true` (**chọn một cách:** bàn giao từ import không bắt buộc chỉ số trên cùng dòng, nhưng bị đánh dấu `readings_pending`); `billing.submitForReview` → 409 `READINGS_INCOMPLETE` kèm U101; sau khi chỉ số `import` đã duyệt cho đủ công tơ thì `readings_pending=false` và gửi duyệt được, kỳ thu dùng chỉ số đó làm chỉ số đầu. Bàn giao tạo thủ công (`source='manual'`) vẫn bắt buộc đủ chỉ số (S-007); `readings_pending=true` với `source='manual'` bị từ chối

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Hợp đồng không thời hạn (hết hạn = null); thiếu chỉ số khi bàn giao; người ở không có giấy tờ | Allocation `[start, NULL)`; không nhắc hết hạn; thiếu chỉ số → 422; giấy tờ tuỳ chọn | S-007, S-008 |
| Cực đại/độ dài | 20 người ở/hợp đồng; 50 tài sản; 20 ảnh/biên bản; ghi chú 2.000 ký tự | Vượt giới hạn cấu hình → 422 `VALIDATION_FAILED` kèm trường | S-007 |
| Trùng lặp/idempotency | Bấm ký 2 lần; job nhắc chạy lại; ghi bàn giao 2 lần; worker nhả hold chạy nhiều lần | Một hiệu lực; dedupe outbox; bàn giao `move_in` unique theo hợp đồng; hold nhả đúng 1 lần | S-014, S-022, S-024 |
| Song song | 2 hợp đồng ký/giữ chỗ cùng phòng cùng khoảng; 2 người cùng duyệt quyết toán | DB chặn chồng (INV-I1) → 1 thành công; quyết toán khoá hàng, người sau nhận `INVALID_TRANSITION` | S-004, S-017, S-024 |
| Mất mạng giữa chừng | Timeout sau `lease.sign` | Client gọi `GET /api/v1/commands/{id}`, không ký lại bằng key mới | S-022 |
| Thời gian/múi giờ | Job lúc 00:05 giờ VN (17:05 UTC hôm trước); hết hạn 31/10 vs tháng 30 ngày; 29/02; hold hết hạn đúng mốc UTC; allocation 00:00 giờ cơ sở | Ngày hợp đồng là `date` địa phương (INV-G2); job dùng ngày theo `properties.timezone`; so hạn hold bằng UTC | S-014, S-015, S-017, S-023 |
| Quyền | `housekeeping` đọc PII; người thuê đọc hợp đồng khác; người lập tự duyệt | 404/404/403; không lộ dữ liệu | S-009, S-010, S-019 |
| Tiền/đơn vị | Cọc 0 đ; nợ 1 đ; nợ lớn hơn cọc; phí lớn hơn cọc; khấu trừ vượt AR; giá đổi giữa kỳ | `bigint` đồng; khấu trừ ≤ min(cọc, AR còn mở gồm cả phiếu phí) | S-012, S-017, S-021, S-025 |

## 4. Dữ liệu
| Thực thể | Trường chính | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `persons` | `full_name`, `phone`, `email`, `address` | text | Họ tên + SĐT bắt buộc; còn lại tuỳ chọn | ghi: owner/manager/front_desk; đọc: thêm accountant; housekeeping/maintenance: không |
| `identity_documents` | `person_id`, `doc_type`, `doc_number_masked`, `file_id` | text, uuid | Tuỳ chọn; file riêng tư, cấm cache offline (NĐ 356/2025, kế hoạch §15) | owner/manager/front_desk có quyền `pii.read_sensitive` |
| `leases` | `unit_id`, `status`, `signed_on`, `billing_start_on`, `moved_out_on`, `representative_person_id` | uuid, enum, date | `status` theo DOMAIN-MODEL §4 | manager/owner ghi; tenant đọc của mình |
| `lease_versions` | `version_no`, `effective_from`, `effective_to`, `rent_amount`, `billing_cycle`, `deposit_amount`, `services` (json tham chiếu `services`), `terms_snapshot`, `terms_hash`, `kind` (`original`/`appendix`) | int, date, bigint, jsonb | EXCLUDE chồng `daterange(effective_from, effective_to)` theo `lease_id`; bất biến sau ký (trigger) | như trên |
| `lease_occupants` | `person_id`, `role` (`primary`/`co_tenant`/`occupant`), `is_representative`, `from_on`, `to_on` | enum, bool, date | Đúng 1 `is_representative` mỗi hợp đồng | như trên |
| `handovers` | `lease_id`, `kind` (`move_in`/`move_out`), `handed_over_on`, `assets` (json: tên, số lượng, tình trạng, ảnh), `keys_count`, `photo_file_ids`, `staff_confirmed_by`, `confirmed_by_tenant_at`, `confirmation_method`, `source` (`manual`/`import`), `readings_pending` | enum, date, jsonb, bool | Unique `(lease_id, kind)`; bất biến sau xác nhận (trừ việc xoá cờ `readings_pending` khi đủ chỉ số); `readings_pending=true` chỉ khi `source='import'` (CHECK) | front_desk/manager ghi; tenant đọc |
| `allocations` | `kind='lease'` hoặc `kind='hold'` (giữ chỗ hợp đồng, `expires_at`), `source_id`=lease | tstzrange | INV-I1, INV-I3, INV-I4; mốc giờ theo Q-04 (mục 10) | hệ thống |
| `lease_settlements` | `lease_id`, `outstanding_ar`, `fees` (json: phí hư hỏng/vệ sinh/phạt đã thoả thuận — số tiền, lý do, ảnh), `deductions` (json: số tiền, lý do, chứng từ), `refund_amount`, `prepared_by`, `approved_by` | bigint, jsonb | `approved_by` ≠ `prepared_by`; Σ `deductions` ≤ min(cọc, AR còn mở của các phiếu liên kết kể cả phiếu phí); `refund_amount` = cọc − Σ `deductions`; bút toán do Ledger tạo theo thứ tự phí → khấu trừ → hoàn | manager lập, owner/manager (trong hạn mức) duyệt |

- Cấu hình cơ sở `lease_hold_ttl_hours` (mặc định đề xuất 48, chờ PO) cho TTL giữ chỗ hợp đồng.
- Thay đổi schema: migration theo T-003+ (có `down`); trigger chặn UPDATE `lease_versions` đã ký và `handovers` đã xác nhận (INV-G4).

## 5. Giao diện / API
| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `person.register` | họ tên, SĐT, email?, địa chỉ? | `person_id` | `VALIDATION_FAILED` |
| `person.attachIdentityDocument` | `person_id`, loại, số, file | `document_id` | `FORBIDDEN`, `VALIDATION_FAILED` |
| `lease.createDraft` | `unit_id`, người thuê, 4 mốc ngày, điều khoản phiên bản 1 | `lease_id`, `version_no`=1 | `VALIDATION_FAILED`, `NOT_FOUND` |
| `lease.updateDraft` | `lease_id`, thay đổi điều khoản | phiên bản cập nhật | `DOCUMENT_IMMUTABLE` |
| `lease.addOccupant` / `lease.removeOccupant` | `person_id`, vai trò, `from_on`/`to_on` | danh sách người ở | `VALIDATION_FAILED` |
| `lease.hold` | `lease_id` | `allocation_id` (`kind='hold'`), `expires_at` = commit + TTL hợp đồng (48 giờ mặc định đề xuất) | `ROOM_UNAVAILABLE`, `INVALID_TRANSITION`, `VALIDATION_FAILED` |
| `lease.submitForSignature` | `lease_id` | `pending_signature` | `INVALID_TRANSITION` |
| `lease.sign` | `lease_id`, người ký | `signed_awaiting_handover`, `allocation_id` (hold của hợp đồng, nếu có, được xác nhận thành `lease`) | `ROOM_UNAVAILABLE`, `HOLD_EXPIRED`, `INVALID_TRANSITION` |
| `lease.recordHandover` | `lease_id`, `kind`, ngày, chỉ số, tài sản, chìa khoá, ảnh, xác nhận | `handover_id`, `reading_ids` | `VALIDATION_FAILED`, `METER_READING_DECREASED`, `INVALID_TRANSITION` |
| `lease.activate` | `lease_id` | `active` | `HANDOVER_REQUIRED`, `INVALID_TRANSITION` |
| `lease.renew` | `lease_id`, điều khoản phiên bản mới, `effective_from` | `version_no` | `LEASE_VERSION_OVERLAP`, `INVALID_TRANSITION` |
| `lease.giveNotice` | `lease_id`, `planned_move_out_on` | `notice_given` | `INVALID_TRANSITION` |
| `lease.prepareSettlement` | `lease_id`, phí phát sinh (số tiền, lý do, ảnh), khoản khấu trừ (số tiền, lý do, chứng từ) | bảng quyết toán (nợ, phí, khấu trừ, hoàn); chưa có bút toán | `HANDOVER_REQUIRED`, `VALIDATION_FAILED` |
| `lease.approveSettlement` | `settlement_id` | bút toán đã ghi trong một transaction theo thứ tự phiếu phí → khấu trừ → hoàn (qua `ledger.*`) | `SELF_APPROVAL_FORBIDDEN`, `APPROVAL_LIMIT_EXCEEDED`, `PERIOD_LOCKED` |
| `lease.close` | `lease_id` | `closed`, allocation kết thúc | `SETTLEMENT_REQUIRED`, `INVALID_TRANSITION` |
| `lease.get` / `lease.list` | `lease_id` / bộ lọc trạng thái, cơ sở | hợp đồng + phiên bản + bàn giao | `NOT_FOUND` |
| `lease.listExpiring` | cơ sở, số ngày | danh sách sắp hết hạn | — |
| Job `lease.remindExpiring`, `lease.detectOverstay` | (worker) | outbox / `exception` | — |

- Giữ chỗ hợp đồng không thêm trạng thái cho hợp đồng; là allocation `hold` (DOMAIN-MODEL §1, §7) với TTL riêng; hạn mức duyệt hoàn/khấu trừ theo SPEC-ledger-payments mục 10 (một chỗ).
- Lease không tự ghi bảng tiền: quyết toán gọi `ledger.approveDepositDeduction`, `ledger.approveDepositRefund` (SPEC-ledger-payments); chỉ số gọi `meter.recordReading` (SPEC-metering-billing).
- UI: danh sách hợp đồng (lọc trạng thái, sắp hết hạn); trình bàn giao từng bước (chỉ số → tài sản → chìa khoá → ảnh → xác nhận); trạng thái đang tải/rỗng/lỗi/thành công; vùng chạm ≥ 44 px; ảnh có nhãn thay thế.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp | Scenario |
|---|---|---|---|---|
| `INVALID_TRANSITION` | Chuyển trạng thái ngoài bảng | 409 | Không thể chuyển hợp đồng từ trạng thái hiện tại sang trạng thái này. | S-020 |
| `HANDOVER_REQUIRED` | Kích hoạt/quyết toán khi thiếu biên bản bàn giao | 409 | Cần hoàn tất biên bản bàn giao trước. | S-005 |
| `DOCUMENT_IMMUTABLE` (mã chung) | Sửa điều khoản/chứng từ sau ký hoặc phát hành | 409 | Điều khoản đã ký không sửa được. Hãy lập phụ lục. | S-003 |
| `HOLD_EXPIRED` (mã chung) | Ký khi hold của hợp đồng đã quá hạn | 409 | Thời gian giữ phòng đã hết. Vui lòng giữ lại. | S-024 |
| `LEASE_VERSION_OVERLAP` | Phụ lục chồng hiệu lực | 409 | Thời gian hiệu lực trùng với phiên bản khác. | S-013 |
| `ROOM_UNAVAILABLE` | Allocation chồng (INV-I1), kể cả phòng đang hold | 409 | Phòng đã có người hoặc đã được giữ trong khoảng này. | S-004, S-024 |
| `SETTLEMENT_REQUIRED` | Đóng hợp đồng khi chưa duyệt quyết toán | 409 | Cần duyệt quyết toán trước khi đóng hợp đồng. | S-018 |
| `SELF_APPROVAL_FORBIDDEN` | Người lập tự duyệt | 403 | Bạn không thể tự duyệt chứng từ mình lập. | S-019 |
| `APPROVAL_LIMIT_EXCEEDED` | Số hoàn vượt hạn mức vai trò | 403 | Số tiền vượt hạn mức duyệt của bạn. | S-017 |
| `METER_READING_DECREASED` | Chỉ số bàn giao nhỏ hơn chỉ số trước | 422 | Chỉ số nhỏ hơn lần đọc trước. Nếu đã thay công tơ, dùng chức năng thay công tơ. | — |
| `FORBIDDEN` | Không đủ quyền (vai trò đọc được tài nguyên nhưng không được thao tác) | 403 | Bạn không có quyền thực hiện thao tác này. | — |
| `NOT_FOUND` | Không tồn tại, ngoài phạm vi hoặc vai trò không được đọc | 404 | Không tìm thấy. | S-009, S-010 |
| `VALIDATION_FAILED` | Thiếu/sai trường; khấu trừ vượt AR còn mở | 422 | Dữ liệu chưa hợp lệ: xem từng trường. | S-007, S-025 |
| `IDEMPOTENCY_CONFLICT` | Cùng key khác payload | 409 | Yêu cầu trùng mã nhưng khác nội dung. | S-022 |
| `PERIOD_LOCKED` | Quyết toán ghi vào kỳ đã khoá | 409 | Kỳ đã khoá. Cần chứng từ điều chỉnh có duyệt. | — |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng | p95 < 800 ms cho command hợp đồng | PROJECT.md §5 | k6 |
| Đồng thời | 100 lệnh `lease.sign` tranh cùng phòng/khoảng → tối đa 1 thành công | Kế hoạch §13 | test tích hợp Postgres thật |
| Riêng tư | Ảnh giấy tờ không vào cache SW/offline; log che SĐT, số giấy tờ | Kế hoạch §15; ARCHITECTURE | test SW + quét log |
| Tiếp cận | WCAG 2.2 AA cho trình bàn giao | PROJECT.md §5 | axe trong E2E |

## 8. Hành vi AI
Không áp dụng (tính năng không dùng model).

## 9. Đo lường
- `lease.created`, `lease.held`, `lease.signed`, `lease.activated`, `lease.renewed`, `lease.settled`, `lease.overstay_detected` → luồng R-002, chỉ số M-02/M-05.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Thanh lý: tiền thuê kỳ cuối tính đến `moved_out_on` (prorata) hay đến `planned_move_out_on`/hết hạn khi trả sớm; có phạt vi phạm báo trước không — [chặn] — hỏi: PO. **Đề xuất mặc định:** tính đến `moved_out_on` theo prorata (SPEC-metering-billing); không tự tính phạt, nhân viên thêm phí một lần có lý do.
- [ ] Hạn mức duyệt hoàn cọc theo vai trò — [chặn] — hỏi: PO. **Đề xuất:** xem SPEC-ledger-payments mục 10 (một chỗ quyết, dùng chung; không lặp số ở đây).
- [ ] Mốc giờ của allocation hợp đồng (ngày bắt đầu/kết thúc → `timestamptz`; chép từ SPEC-inventory-allocation Q-04) — [chặn F-003] — hỏi: PO. **Đề xuất:** bắt đầu 00:00 giờ cơ sở của ngày bàn giao (trước bàn giao: ngày bắt đầu hiệu lực); kết thúc 00:00 giờ cơ sở của ngày sau ngày thực trả (`moved_out_on` + 1).
- [ ] TTL giữ chỗ hợp đồng (`lease.hold`) — [không chặn; cùng Q-01 của SPEC-inventory-allocation] — hỏi: PO. **Đề xuất:** mặc định 48 giờ, cấu hình theo cơ sở (`lease_hold_ttl_hours`); vai trò giữ chỗ: owner/manager/lễ tân (khớp ma trận access); cọc giữ chỗ không tự mất khi hold hết hạn.
- [x] Trạng thái huỷ cho hợp đồng (`draft`/`pending_signature`/`signed_awaiting_handover` → `cancelled`) — đã bổ sung DOMAIN-MODEL v1.2 §4. Còn lại: từ `signed_awaiting_handover` thì nhả allocation và xử lý cọc qua quyết toán (làm cùng T032).
- [x] Bảng `lease_settlements`, `services` — [chặn migration] — đã bổ sung DOMAIN-MODEL v1.2 §7.
- [ ] Mốc nhắc hết hạn — [không chặn] — hỏi: PO. **Đề xuất:** 30/7/0 ngày, cơ sở cấu hình.
- [ ] Cách người thuê "xác nhận" bàn giao khi chưa có ký điện tử (ngoài phạm vi V1) — [không chặn] — hỏi: PO + pháp lý. **Đề xuất:** xác nhận trên portal hoặc ký giấy rồi chụp ảnh; lưu `confirmation_method`.
- [ ] Chuyển phòng giữa kỳ (kế hoạch §05 yêu cầu bàn giao + chỉ số cho hai phòng) — [không chặn pilot] — hỏi: PO. **Đề xuất:** để đợt V1, mô hình = thanh lý phòng cũ + hợp đồng mới không hoàn cọc mà chuyển cọc.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu [chặn] · DOMAIN-MODEL v1.2 đã bổ sung mọi tên bảng · SPEC-inventory-allocation và SPEC-ledger-payments Approved.
- DoD: mọi S-NNN có test xanh (S-004, S-022 trên Postgres thật) · ca biên có test · cổng commit/merge xanh · sự kiện đo có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T025 Hồ sơ người thuê/người ở | — | S-008, S-009, S-010 |
| T026 Hợp đồng + phiên bản điều khoản | — | S-001…S-004, S-022…S-024 |
| T027 Bàn giao | — | S-005…S-007, S-026 |
| T031 Gia hạn, tăng giá, nhắc hết hạn | — | S-011…S-015 |
| T032 Thanh lý, đối trừ cọc | — | S-016…S-021, S-025 |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | Tạo | G3 cho F-003 | (chưa) |
| 2 | 2026-10-15 | Sửa theo review độc lập: S-017 phí hư hỏng thành phiếu trước, khấu trừ ≤ AR (R3); `lease.hold` + S-023/S-024 (O7); S-009 → 404 (O6); bàn giao từ import `readings_pending` + S-026 (G18); mốc giờ allocation (G19); `LEASE_TERMS_IMMUTABLE` → `DOCUMENT_IMMUTABLE`; đóng câu hỏi bảng/`cancelled` (G5) | Review độc lập; DOMAIN-MODEL v1.2 | (chưa) |
