# SPEC-reservation-stay — Khách sạn cơ bản: loại phòng, giá ngày/đêm, booking, nhận/trả phòng, folio

| Trường | Giá trị |
|---|---|
| ID tính năng | F-006 (luồng: R-003, R-004) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch §06, §07, §08, §13; DOMAIN-MODEL §1, §3–§5, §7; backlog T049–T054, T056 |

## 1. User story
- Là **lễ tân**, tôi muốn báo giá, giữ phòng có hạn, xác nhận kèm ứng trước/cọc, nhận khách (booking hoặc walk-in) dưới 2 phút và trả phòng với folio rõ ràng, để quầy không ùn và tiền ca khớp.
- Là **lễ tân ca đêm**, tôi muốn khách trả tiền mặt lúc check-out thì tôi tự xác nhận khoản tiền mình vừa nhận trong ca đang mở, để trả phòng ngay mà không phải gọi quản lý (đề xuất, chờ PO — INV-F3b).
- Là **quản lý**, tôi muốn cho phép trả phòng khi khách còn nợ có chủ thể và hạn trả, để không giữ khách vô lý mà vẫn theo dõi được công nợ.
- Là **lễ tân/quản lý**, tôi muốn xuất file thông báo lưu trú theo mẫu đã cấu hình và đánh dấu đã gửi kèm bằng chứng, để cơ sở làm đúng nghĩa vụ thông báo lưu trú và có dấu vết khi bị hỏi (hệ thống không tự nộp cho cơ quan nhà nước).

Phạm vi pilot: 1 dòng phòng/booking, phòng gán cụ thể ngay khi giữ, giá theo đêm (ngày thường/cuối tuần) theo loại phòng, nguồn booking `direct`/`walk_in`.
Ngoài phạm vi (F-013): giá giờ, phụ thu sớm/muộn tự động, booking nhiều dòng/đoàn, rate plan theo ngày hiệu lực, chính sách huỷ có phiên bản, night audit. Ca quầy tối thiểu (mở ca, đóng ca, đối chiếu tiền mặt) thuộc pilot, định nghĩa ở SPEC-ledger-payments; module này chỉ dùng. Phụ thu trả muộn ở pilot là khoản phí nhập tay.

## 2. Tiêu chí chấp nhận (Given/When/Then)
Fixture chung: cơ sở P1 mẫu `hotel`, `timezone=Asia/Ho_Chi_Minh`, giờ nhận 14:00 / trả 12:00 (giá trị fixture, chờ Q-01); loại phòng `STD` sức chứa 2, giá ngày thường 600.000 đ (kế hoạch §06), cuối tuần 700.000 đ (giá trị fixture); phòng `201`, `202` loại `STD`. 20/10/2026 là thứ Ba.

### S-001 Báo giá ngày thường
- Given `201` trống
- When `reservation.quote` {`STD`, đến 20/10, đi 22/10, 2 khách}
- Then `nights=2`, dòng giá [20/10: 600.000, 21/10: 600.000], `room_total=1200000` (số nguyên đồng), kèm điều kiện huỷ đang áp dụng (Q-04)

### S-002 Giá ngày thường/cuối tuần (Scenario Outline)
- Given giá `STD` như fixture, định nghĩa đêm cuối tuần = `<cuối_tuần>`
- When báo giá đến 22/10 (thứ Năm), đi 25/10 (Chủ nhật)
- Then `room_total` = `<tổng>`; mỗi đêm xác định theo `business_date` của đêm đó
- Examples: | cuối_tuần | tổng |
  | đêm thứ Sáu + thứ Bảy (đề xuất Q-03) | 2.000.000 |
  | đêm thứ Bảy + Chủ nhật | 1.900.000 |

### S-003 Tạo booking và giữ phòng có hạn
- Given `201` trống 20/10 14:00 → 22/10 12:00
- When `reservation.create` {khách, `201`, 20/10→22/10, 2 khách, nguồn `direct`} rồi `reservation.hold`
- Then booking `draft → held`; gọi `inventory.createHold` → allocation `hold` [20/10 07:00Z, 22/10 05:00Z) có `expires_at`; giá từng đêm được snapshot vào booking

### S-004 Hai lễ tân giữ cùng phòng cuối (R-004)
- Given `201` là phòng `STD` trống cuối cùng
- When hai lễ tân gọi `reservation.hold` song song cùng khoảng
- Then một người `200`/`201`; người còn lại `409 ROOM_UNAVAILABLE` kèm gợi ý; chỉ một allocation (chi tiết tải 100 lệnh: SPEC-inventory-allocation S-005)

### S-005 Xác nhận kèm ứng trước có chứng cứ
- Given booking `held`, hold còn hạn
- When `reservation.confirm` kèm ghi nhận 500.000 đ chuyển khoản là **ứng trước**, người có quyền xác nhận với ảnh sao kê (INV-F3); khoản tiền quy về một `bank_transactions` `(receiving_account_id, bank_txn_ref)` và `payments` tham chiếu đúng một `bank_transaction_id` (INV-F4b)
- Then booking `confirmed`; tạo `stays` trạng thái `expected`; allocation đổi `kind='stay'`, `source_id`=stay, `expires_at=NULL` (không có khe hở); `payments` `confirmed` (nhập tay kèm sao kê và webhook cùng giao dịch → vẫn một payment); bút toán Nợ `BANK` 500.000 / Có `CUSTOMER_CREDIT` 500.000 (cân đối, INV-F1)

### S-006 "Khách bấm đã chuyển" không đủ để xác nhận tiền (INV-F3)
- Given booking `held`
- When lễ tân ghi khoản chuyển khoản 500.000 không có chứng cứ
- Then `payments.status='pending'`; không có bút toán `BANK`; số dư folio không giảm; booking chỉ `confirmed` nếu chính sách cho phép xác nhận không cần tiền (Q-05)

### S-007 Xác nhận khi hold đã hết hạn
- Given hold của booking quá `expires_at`
- When `reservation.confirm`
- Then `409 HOLD_EXPIRED`; booking `held → expired` đúng một lần; phòng được nhả

### S-008 Đổi ngày nguyên tử (T051)
- Given booking `confirmed` `201` 20/10→22/10; `201` bận từ 23/10 14:00
- When `reservation.changeDates` đi 23/10 (preview trước), rồi đi 24/10
- Then preview trả chênh lệch +600.000 trước khi lưu; đổi đến 23/10 → `200`, allocation cập nhật cùng transaction, đêm cũ giữ giá snapshot, đêm mới lấy giá hiện hành (Q-06); đổi đến 24/10 → `409 ROOM_UNAVAILABLE`, booking và allocation **không đổi**

### S-009 Huỷ booking: nhả phòng, không tự coi tiền là doanh thu (INV-F5)
- Given booking `confirmed` có ứng trước 500.000
- When lễ tân `reservation.cancel` {lý do, phí huỷ=0}
- Then booking `cancelled`, stay `expected → cancelled` (DOMAIN-MODEL §4), allocation `active=false` tại thời điểm commit; 500.000 vẫn ở `CUSTOMER_CREDIT` chờ hoàn hoặc quyết định có lý do + người duyệt; **không** có bút toán `REV_*`
- And khi phí huỷ > 0: tạo `charges` loại phí (`REV_FEE` khi phát hành), phải trong hạn mức người thao tác, vượt → `403 APPROVAL_LIMIT_EXCEEDED`

### S-010 Chuyển trạng thái không hợp lệ
- Given booking `draft` / booking `checked_out`
- When `stay.checkIn` trên booking `draft` / `reservation.cancel` booking `checked_out`
- Then `409 INVALID_TRANSITION`, có `audit_events` ghi lần từ chối

### S-011 No-show
- Given booking `confirmed` với stay `expected`, ngày đến 20/10, khách không đến; màn "Hôm nay" đang đếm 1 khách sắp đến cho booking này
- When lễ tân `reservation.markNoShow` lúc 20/10 18:00; rồi lúc 21/10 sau giờ chốt ngày; rồi `stay.checkIn` trên booking đó
- Then lần 1 → `409 INVALID_TRANSITION` (chưa qua ngày đến, Q-07); lần 2 → booking `no_show` **và** stay `expected → no_show` cùng transaction, allocation nhả, ứng trước/cọc giữ nguyên chờ quyết định có duyệt; stay `no_show` **không còn** được đếm là khách sắp đến ở màn "Hôm nay" (số đếm 1 → 0) và không còn dòng nhắc check-in; lần 3 → `409 INVALID_TRANSITION` (không check-in từ `no_show`); không tạo `residence_notices` cho stay này

### S-012 Check-in booking có sẵn (T052)
- Given booking `confirmed` `201`; `201` vệ sinh `inspected`, khả dụng `active`, không có lượt ở `in_house`
- When `stay.checkIn` {booking, thông tin khách bắt buộc (Q-08)}
- Then stay `expected → in_house`, booking `in_house`; ghi `charges` phòng mỗi đêm (unique theo stay + `business_date`); giấy tờ khách lưu ở `identity_documents` (che khi hiển thị); tạo một `residence_notices` `pending` cho stay trong cùng transaction (S-028); sự kiện `stay.check_in_started` (mở form) và `stay.checked_in` (commit)

### S-013 Phòng chưa sạch hoặc còn khách
- Given `201` vệ sinh `dirty` (hoặc còn lượt ở `in_house` quá hạn)
- When `stay.checkIn`
- Then `409 ROOM_NOT_READY` (hoặc `409 ROOM_OCCUPIED`); stay vẫn `expected`; UI gợi ý chuyển sang phòng `inspected` cùng loại

### S-014 Vượt sức chứa
- Given `STD` sức chứa 2
- When tạo booking/check-in với 3 khách
- Then `422 CAPACITY_EXCEEDED`

### S-015 Walk-in (T052)
- Given `202` trống, `inspected`; hiện tại 20/10 15:10
- When `stay.walkIn` {`202`, đi 21/10, 1 khách, thông tin khách}
- Then **một command** khởi tạo thẳng `in_house` (DOMAIN-MODEL §4): một transaction tạo booking nguồn `walk_in` trạng thái `in_house`, stay `in_house`, allocation `stay` [20/10 15:10, 21/10 12:00), 1 đêm 600.000, `residence_notices` `pending`; không có bước trung gian `draft`/`held`/`confirmed`/`expected` (lịch sử trạng thái và audit chỉ có một sự kiện tạo, không có `stay.checkIn` riêng); nếu `202` bị chiếm → `409 ROOM_UNAVAILABLE` và không tạo gì

### S-016 Qua 00:00 không tự tạo sai một đêm (kế hoạch §06)
- Given giờ chốt ngày P1 = 04:00 (giá trị fixture); (a) khách `in_house` 20/10→22/10 có 2 phí đêm; (b) khách walk-in lúc 16/10 01:30, đi 16/10
- When (a) đồng hồ qua 21/10 00:00 và 22/10 00:00; (b) `stay.walkIn`
- Then (a) vẫn đúng 2 phí đêm, không job nào tạo thêm phí theo đồng hồ; (b) `business_date` đêm đầu = 15/10, `nights=1`, giá 1 đêm thứ Năm (600.000), **không** tính 2 đêm và không báo lỗi "ngày đi phải sau ngày đến"

### S-017 Folio ví dụ bắt buộc (kế hoạch §06, DOMAIN-MODEL §5)
- Given stay `201` 20/10→22/10 (2 × 600.000), ứng trước 500.000 đã xác nhận (S-005)
- When ghi minibar 80.000 (`stay.postCharge`, loại dịch vụ) và phụ thu trả muộn 150.000 (loại phí, nhập tay); rồi `stay.checkOut`
- Then folio: tổng phí **1.430.000**; phát hành phiếu: Nợ `AR` 1.430.000 / Có `REV_ROOM` 1.200.000, `REV_SERVICE` 80.000, `REV_FEE` 150.000; phân bổ ứng trước: Nợ `CUSTOMER_CREDIT` 500.000 / Có `AR` 500.000; còn phải thu **930.000**. Cọc bảo đảm (nếu có) hiển thị riêng, không trừ vào 930.000 (INV-F5)

### S-018 Không ghi dịch vụ hai lần (T053)
- Given stay `in_house`
- When gửi `stay.postCharge` minibar 80.000 hai lần cùng `Idempotency-Key`; rồi lần ba cùng key khác số tiền
- Then 1 `charges`; lần ba `409 IDEMPOTENCY_CONFLICT`. Hai lần bấm với key khác nhau là hai khoản hợp lệ, hủy bằng `stay.voidCharge` có lý do trước khi phát hành

### S-019 Check-out còn nợ cần quản lý cho phép (kế hoạch §06)
- Given folio còn 930.000; lễ tân không có quyền cho nợ
- When lễ tân `stay.checkOut` không thu đủ; rồi gửi lại kèm `approval` của manager, người nợ (`persons`) và hạn trả 30/10
- Then lần 1 → `409 OUTSTANDING_BALANCE`; lần 2 → stay `checked_out`, `AR` còn 930.000 gắn người nợ + hạn trả; thiếu người nợ hoặc hạn → `422 VALIDATION_FAILED`. Khách trả đủ tiền mặt thì không cần duyệt của manager (S-026)

### S-020 Check-out tạo việc dọn trong cùng quy trình (T054)
- Given stay `in_house` `201`, folio đã thu đủ
- When `stay.checkOut` lúc 22/10 10:30
- Then trong một transaction: stay `checked_out` (`checked_out_at` lưu UTC), booking `checked_out`; allocation `end` = 22/10 10:30 (trả sớm hơn dự kiến nhả phòng ngay); `201` vệ sinh `dirty`; tạo 1 việc dọn `open` (F-007); trả muộn hơn dự kiến thì **không** kéo dài allocation hồi tố, giờ thực lưu ở stay

### S-021 Đổi giá bảng không ảnh hưởng booking đã giữ (snapshot)
- Given booking `confirmed` 20/10→22/10 tổng 1.200.000
- When owner đổi giá `STD` ngày thường thành 650.000
- Then booking vẫn 1.200.000; booking mới báo giá 650.000/đêm

### S-022 Kỳ đã khoá (INV-F6)
- Given `period_locks` khoá đến 21/10
- When `stay.postCharge` hoặc `stay.voidCharge` với `business_date` 21/10
- Then `409 PERIOD_LOCKED`; chỉ được thêm chứng từ điều chỉnh có duyệt (SPEC-ledger-payments)

### S-023 Phiếu đã phát hành bất biến (INV-G4)
- Given đã check-out, phiếu 1.430.000 đã phát hành
- When sửa số tiền minibar trên phiếu
- Then `409 DOCUMENT_IMMUTABLE`; sửa bằng chứng từ điều chỉnh/đảo tham chiếu bản gốc, có lý do và người duyệt

### S-024 Phân bổ vượt số tiền (INV-F2)
- Given thanh toán 500.000 đã phân bổ 500.000
- When phân bổ thêm 100.000 từ cùng thanh toán vào phiếu
- Then `409 OVER_ALLOCATION`; Σ phân bổ vẫn 500.000

### S-025 Quyền và tenant (INV-G1)
- Given nhân viên `housekeeping` P1; người dùng tổ chức B
- When `housekeeping` gọi `stay.getFolio` hoặc `stay.exportResidenceNotice`; người B gọi `reservation.get` của A
- Then cả ba `404 NOT_FOUND`

### S-026 Check-out ca đêm, khách trả tiền mặt: lễ tân tự xác nhận (INV-F3b, đề xuất chờ PO)
- Given ca đêm không có quản lý trực; lễ tân L có ca `shifts` đang mở (mở 22:00, tiền đầu ca 2.000.000); stay `201` `in_house`, folio còn 930.000 (S-017); khách trả 930.000 tiền mặt cho L; giờ chốt ngày P1 = 04:00 (fixture S-016)
- When L gọi `stay.checkOut` {payments: [{method `cash`, amount 930.000}]} lúc 23/10 00:40
- Then trong một transaction: `payments` ghi bởi L → L xác nhận (tiền mặt do chính L nhận trong ca đang mở) → `confirmed`, hệ thống sinh biên nhận; bút toán Nợ `CASH` 930.000 / Có `CUSTOMER_CREDIT` 930.000 rồi phân bổ Nợ `CUSTOMER_CREDIT` / Có `AR` 930.000; folio = **0**; stay `checked_out`; không cần `approval` của quản lý; khoản 930.000 vào số tiền mặt kỳ vọng khi đóng ca của L; `business_date` của khoản thu và đêm cuối là 22/10 (00:40 < giờ chốt 04:00)
- And biến thể: (a) L không có ca đang mở hoặc ca đã đóng → `403 FORBIDDEN`, không có payment/bút toán/check-out nào; (b) khách đưa 900.000 → folio còn 30.000 → `409 OUTSTANDING_BALANCE` (đi tiếp theo S-019); (c) tiền do lễ tân khác nhận → `403 FORBIDDEN`; (d) gửi lại cùng `Idempotency-Key` → cùng kết quả, một payment, một biên nhận

### S-027 Hoàn cọc khách sạn lúc check-out theo hạn mức lễ tân (đề xuất chờ PO)
- Given booking có cọc bảo đảm `security_deposit` (nhận qua `reservation.confirm`, vào `DEPOSIT_LIAB`, không phải doanh thu); folio đã thu đủ; hạn mức hoàn của lễ tân 2.000.000 đ/lần chỉ khi check-out (SPEC-access-and-property 5.3)
- When (a) cọc 1.000.000: L `stay.checkOut` kèm hoàn cọc 1.000.000 tiền mặt; (b) cọc 3.000.000: L hoàn 3.000.000; (c) cọc 1.000.000, folio còn nợ phát sinh 200.000 phí hư hỏng: cần khấu trừ cọc
- Then (a) bút toán Nợ `DEPOSIT_LIAB` 1.000.000 / Có `CASH` 1.000.000, cọc còn 0, tiền ra ghi vào ca của L; (b) stay vẫn `checked_out` nhưng hoàn cọc vượt hạn mức nên tạo `approval_requests` `pending` (số tiền, lý do), cọc còn 3.000.000 ở `DEPOSIT_LIAB` chờ quản lý/owner; L gọi trực tiếp `deposit.approveRefund` → `403 APPROVAL_LIMIT_EXCEEDED`; (c) khấu trừ cọc vào nợ luôn cần người duyệt khác người lập (INV-F5), lễ tân tự duyệt → `403 SELF_APPROVAL_FORBIDDEN`; mọi trường hợp không có bút toán `REV_*` từ cọc

### S-028 Xuất file thông báo lưu trú theo mẫu (nghĩa vụ của cơ sở)
- Given stay `in_house` của khách trong nước (họ tên, loại + số giấy tờ ở `identity_documents`); cơ sở đã cấu hình mẫu thông báo lưu trú; `residence_notices` của stay ở `pending`
- When lễ tân gọi `stay.exportResidenceNotice` {stay_id}
- Then trả file riêng tư (link ký có hạn ngắn) sinh theo mẫu, **chỉ** gồm các trường mẫu yêu cầu (không kèm ảnh giấy tờ, SĐT, ghi chú nội bộ, số tiền); `residence_notices.status = exported` (`exported_at`, `exported_by`, `export_file_id`); xuất lại được (mỗi lần một audit, `exported` giữ nguyên); chưa cấu hình mẫu → `409 NOTICE_TEMPLATE_MISSING`; thiếu trường bắt buộc của mẫu (vd số giấy tờ) → `422 VALIDATION_FAILED` kèm danh sách trường thiếu; `housekeeping` gọi → `404 NOT_FOUND`

### S-029 Đánh dấu đã thông báo lưu trú
- Given `residence_notices` ở `pending` hoặc `exported`
- When lễ tân gọi `stay.markNoticeSubmitted` {notice_id, submitted_at, channel, evidence_file_id?}
- Then `status = submitted`, lưu người gửi (= người thao tác), `submitted_at` (UTC), `channel` (`in_person`/`online`/`other`), file bằng chứng nếu có (file riêng tư); hệ thống **không** gửi gì tới cơ quan nhà nước; gọi lại cùng `Idempotency-Key` → cùng kết quả; gọi lại với key khác khi đã `submitted` → `409 INVALID_TRANSITION`; `submitted_at` ở tương lai → `422 VALIDATION_FAILED`; job nhắc (SPEC-notifications S-016) ngừng nhắc

### S-030 Khách nước ngoài và quá hạn thông báo lưu trú
- Given khách có quốc tịch khác Việt Nam (hộ chiếu); cơ sở đã cấu hình hạn thông báo (giá trị fixture 24 giờ, nguồn pháp lý [T] — Q-13) hoặc chưa cấu hình; check-in 15/10 14:00
- When `stay.checkIn` rồi `stay.exportResidenceNotice`; đồng hồ qua `due_at` mà chưa `stay.markNoticeSubmitted`
- Then `residence_notices.is_foreign = true`; file xuất có thêm trường quốc tịch, số hộ chiếu theo mẫu; `due_at` tính theo `properties.timezone`, lưu UTC; khi quá hạn mà còn `pending`/`exported` → nhắc mức "Quá hạn" qua SPEC-notifications (S-021) và hiện cờ trên màn "Hôm nay"; nếu chưa cấu hình hạn thì `due_at` rỗng, không có nhắc, nhưng vẫn xuất/đánh dấu được (SPEC-notifications S-020)

## 3. Ca biên
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Booking không có khách; ngày không có giá cấu hình; check-in thiếu trường bắt buộc; chưa cấu hình mẫu/hạn thông báo lưu trú; xuất mẫu khi thiếu số giấy tờ | `422 VALIDATION_FAILED` / `422 RATE_NOT_CONFIGURED` / `409 NOTICE_TEMPLATE_MISSING`; chưa có hạn → không nhắc | S-014, S-019, S-028, S-030 |
| Cực đại/độ dài | Booking 30 đêm; ghi chú dài | Tính đúng từng đêm; giới hạn đêm tối đa theo Q-10 | S-002 |
| Trùng lặp/idempotency | Bấm xác nhận/ghi dịch vụ/check-out 2 lần; check-out tiền mặt gửi lại; đánh dấu thông báo lưu trú 2 lần | 1 hiệu lực, cùng kết quả (một payment, một biên nhận, một lần đánh dấu) | S-018, S-026, S-029 |
| Song song | 2 lễ tân giữ phòng cuối; huỷ và check-in cùng lúc; 2 người check-out cùng stay; no-show và check-in cùng lúc | Khoá hàng booking/stay; lệnh sau `409 INVALID_TRANSITION` hoặc `ROOM_UNAVAILABLE` | S-004, S-010, S-011 |
| Mất mạng giữa chừng | Timeout khi check-in/check-out | Hỏi kết quả qua `command_id`; mất mạng → không cho check-in/out (kế hoạch §10) | S-012, S-020 |
| Thời gian/múi giờ | Qua 00:00; walk-in và check-out ca đêm trước giờ chốt ngày; đêm cuối tuần; trả muộn; hạn thông báo lưu trú | Theo `business_date`; không phí theo đồng hồ; `due_at` theo `properties.timezone`, lưu UTC | S-002, S-016, S-020, S-026, S-030 |
| Quyền | Lễ tân cho nợ; giảm giá vượt hạn mức; lễ tân xác nhận tiền mặt ngoài ca/của người khác; hoàn cọc vượt hạn mức; buồng phòng xem folio/xuất thông báo lưu trú; khác tổ chức | 409/403/404 | S-009, S-019, S-025, S-026, S-027 |
| Tiền/đơn vị | 1.430.000/930.000; ứng trước ≠ cọc; huỷ không tạo doanh thu; phân bổ vượt; khách đưa thiếu tiền mặt; hoàn cọc đúng/vượt hạn mức | `bigint` đồng; bút toán cân đối | S-005, S-009, S-017, S-024, S-026, S-027 |

## 4. Dữ liệu
| Thực thể | Trường chính | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `room_types` | organization_id, property_id, id, code, name, capacity | int | capacity ≥ 1; unique (property_id, code) | owner ghi |
| `rate_plans` ¹ | organization_id, property_id, room_type_id, id, weekday_price, weekend_price, weekend_nights, currency, effective_from, effective_to | `bigint`, `smallint[]`, `date` | giá > 0; `weekend_nights` ⊂ 0..6 (0 = Chủ nhật), mặc định `{5,6}` (Q-03, D-006); hiệu lực không chồng, một bản mở cuối/loại phòng | owner ghi; owner/manager/lễ tân đọc |
| `reservations` | organization_id, property_id, id, status, source (`direct`\|`walk_in`), booker_person_id, policy_snapshot | | trạng thái theo DOMAIN-MODEL §4 | lễ tân/manager/owner |
| `reservation_items` | reservation_id, id, unit_id, room_type_id, arrival_date, departure_date, guests, nightly_prices (snapshot) | `date` địa phương, jsonb `bigint` | departure_date > arrival_business_date | như trên |
| `stays` | organization_id, property_id, id, reservation_item_id, unit_id, status, checked_in_at, checked_out_at, debtor_person_id?, debt_due_date? | `timestamptz` UTC | `expected → in_house → checked_out`; `expected → cancelled`; `expected → no_show` (khi booking no-show); walk-in khởi tạo → `in_house` (DOMAIN-MODEL §4) | như trên |
| `identity_documents` | organization_id, property_id, person_id, id, doc_type, doc_number, file_id? | text, uuid | file riêng tư, che số khi hiển thị, retention riêng; ảnh không lưu mặc định (Q-08) | lễ tân/manager/owner đọc; `housekeeping` không đọc |
| `residence_notices` | organization_id, property_id, id, stay_id, status (`pending`\|`exported`\|`submitted`), is_foreign, due_at?, exported_at, exported_by, export_file_id, submitted_at, submitted_by, channel, evidence_file_id? | `timestamptz` UTC, uuid | unique (stay_id); tạo cùng transaction khi stay thành `in_house`; `due_at` null khi chưa cấu hình hạn; `status` chỉ đi tiến `pending → exported → submitted` (xuất lại không đổi `exported`) | lễ tân/manager/owner ghi; `housekeeping` không đọc |
| `charges` | organization_id, id, stay_id, kind (room/service/fee/discount), business_date, quantity, unit_price, amount, tax_profile_id, rounding_rule, formula_version, voided_at | `bigint`, `numeric` | unique (stay_id, business_date) where kind=room and voided_at null | ghi qua `billing.createCharges` |
| `payments`, `payment_allocations`, `deposits`, `bank_transactions`, `shifts`, `journal_*` | theo SPEC-ledger-payments | chuyển khoản tham chiếu đúng một `bank_transaction_id` (INV-F4b); tiền mặt đi qua `payments` (INV-F3b) | INV-F1–F6 | F-005 |

¹ Tên từ kế hoạch §12; `rate_plans`, `identity_documents`, `residence_notices` đã có trong DOMAIN-MODEL §7 (v1.2). Folio = khung nhìn trên `charges` + `payment_allocations` theo stay (DOMAIN-MODEL §1).
Số đêm: `nights = departure_date − arrival_business_date` (walk-in: `business_date` lúc check-in; booking: `arrival_date`). `during` = ngày địa phương + giờ nhận/trả của cơ sở, đổi sang UTC.

## 5. Giao diện / API
Hợp đồng chi tiết: `docs/design/API-CONTRACT.md`. Mọi command nhận `Idempotency-Key`. Module này gọi `inventory.*` (F-002), `billing.*`/`payments.*` (F-005), `housekeeping.createTask` (F-007).

| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `roomType.create` / `roomType.update`, `rate.set` | code, capacity / room_type_id, weekday_price, weekend_price, effective_from, weekend_nights? (đóng bản đang mở tại effective_from − 1; phải sau bản gần nhất và không hồi tố — ERD `rate_plans`) | id (`rate.set`: rate_plan_id, closed_rate_plan_id) | VALIDATION_FAILED, FORBIDDEN, NOT_FOUND |
| `reservation.quote` (query) | room_type_id\|unit_id, arrival_date, departure_date, guests | nights, nightly_prices, room_total, policy | RATE_NOT_CONFIGURED, CAPACITY_EXCEEDED |
| `reservation.create` | booker, unit_id, arrival_date, departure_date, guests, source | reservation_id (draft) | VALIDATION_FAILED, CAPACITY_EXCEEDED |
| `reservation.hold` | reservation_id | allocation_id, expires_at | ROOM_UNAVAILABLE, UNIT_OUT_OF_SERVICE |
| `reservation.confirm` | reservation_id, payment? {amount, method, kind: `advance`\|`security_deposit`, evidence} | status, stay_id | HOLD_EXPIRED, INVALID_TRANSITION |
| `reservation.changeDates` | reservation_id, arrival_date, departure_date, preview_only | price_diff, reservation | ROOM_UNAVAILABLE, APPROVAL_LIMIT_EXCEEDED |
| `reservation.cancel` | reservation_id, reason, cancellation_fee | status | INVALID_TRANSITION, APPROVAL_LIMIT_EXCEEDED |
| `reservation.markNoShow` | reservation_id, reason | status (booking + stay `no_show`) | INVALID_TRANSITION |
| `stay.checkIn` | reservation_id, guests[], required_guest_fields | stay | ROOM_NOT_READY, ROOM_OCCUPIED, CAPACITY_EXCEEDED, INVALID_TRANSITION |
| `stay.walkIn` | unit_id, departure_date, guests[] | reservation_id, stay | ROOM_UNAVAILABLE, ROOM_NOT_READY |
| `stay.postCharge` / `stay.voidCharge` | stay_id, kind, description, quantity, unit_price / charge_id, reason | charge | PERIOD_LOCKED, APPROVAL_LIMIT_EXCEEDED |
| `stay.getFolio` (query) | stay_id | charges, payments, allocations, balance, deposits (tách) | NOT_FOUND |
| `stay.checkOut` | stay_id, payments? [{method, amount}] (tiền mặt: lễ tân tự xác nhận khoản mình nhận trong ca mở), allow_balance? {approval_id, debtor_person_id, due_date}, deposit_refund? {amount, method} | stay, invoice_id, balance, deposit_refund_status (`done`\|`pending_approval`) | OUTSTANDING_BALANCE, VALIDATION_FAILED, FORBIDDEN, SELF_APPROVAL_FORBIDDEN |
| `stay.exportResidenceNotice` | stay_id | file (link ký có hạn), notice_id, status | NOT_FOUND, NOTICE_TEMPLATE_MISSING, VALIDATION_FAILED |
| `stay.markNoticeSubmitted` | notice_id, submitted_at, channel, evidence_file_id? | notice | NOT_FOUND, INVALID_TRANSITION, VALIDATION_FAILED |
| `stay.listNotices` (query) | property_id, status?, due_before? | danh sách `residence_notices` (quá hạn nổi lên đầu) | NOT_FOUND |
| `reservation.list` / `reservation.get` (query) | property_id, date range, status | danh sách/chi tiết | NOT_FOUND |

- Ghi chú triển khai (T-204, đợt 3): đã có `reservation.create/hold/confirm/changeDates/cancel/markNoShow` và query `reservation.get/list`. Khác bảng trên có chủ ý: (a) `reservation.confirm` nhận `payment` {kind, method, amount, receiving_account_id?, bank_txn? | bank_transaction_id?} — thiếu chứng cứ → `422 EVIDENCE_REQUIRED` (cả lệnh rollback), không kèm tiền chỉ được khi `properties.settings.reservation.confirm_without_payment = true` (mặc định tắt, Q-05); lễ tân chỉ xác nhận tiền mặt của mình, chuyển khoản cần quyền `payment.confirm_transfer` (manager/owner/kế toán); (b) `reservation.create` nhận `unit_id` + `guests` (pilot) hoặc `rooms[]` (tới 10 phòng chung ngày) và người đặt `{person_id}` hoặc `{full_name, phone}`; chỉ nguồn `direct` (walk-in ở `stay.walkIn`); (c) `reservation.changeDates` trả `price_diff`, `available`, `alternatives`; `preview_only` không đổi gì; (d) `reservation.cancel` phí huỷ > 0 chỉ khi đã có lượt ở: trong hạn mức `reservation.override_price` tạo `charges` loại phí, vượt → `403 APPROVAL_LIMIT_EXCEEDED` kèm `approval_request_id` (duyệt `cancellation_fee` thì huỷ chạy); (e) `reservation.markNoShow`: chỉ khi ngày kinh doanh hiện tại > ngày đến (Q-07), trước đó `409 INVALID_TRANSITION`; (f) `stays` tạo ở `reservation.confirm` (migration 0025) — check-in/out là T-205/T-206; `residence_notices` chưa có nên chưa kiểm "không tạo thông báo cho stay no_show".
- Ghi chú triển khai (T-205, đợt 3): `stay.checkIn` nhận `reservation_id`, `stay_id?` (bắt buộc khi booking nhiều phòng), `guests[]` (1–20; mỗi người `person_id` **hoặc** `full_name`, `phone` (bắt buộc với người đại diện = người đầu), `nationality?`, `document {type: cccd\|passport\|other, number, file_id?}`); `stay.walkIn` nhận `unit_id`, `departure_date`, `guests[]`, `payment?` (ứng trước/cọc như `reservation.confirm`) và trả `reservation_id`, `stay_id`, `business_date`, `nights`, `room_total`. Chủ ý khác bảng trên: (a) giấy tờ bắt buộc cho **mọi** người lưu trú (trẻ không có CCCD dùng loại `other`); khách nước ngoài (quốc tịch ≠ `VN`) bắt buộc hộ chiếu; số CCCD 9 hoặc 12 chữ số; thiếu/sai → `422 VALIDATION_FAILED` theo `guests[i].…`; (b) `file_id` ảnh giấy tờ chỉ nhận khi `properties.settings.store_id_images = true` (mặc định tắt → `422` `ID_IMAGE_NOT_ALLOWED`); số đầy đủ không vào audit/outbox/kết quả lệnh/API, chỉ `doc_number_masked`; (c) `stay.checkIn` chỉ trong khoảng ngày kinh doanh `[ngày đến, ngày đi)` (ngoài khoảng → `409 INVALID_TRANSITION`); đến sớm hơn giờ nhận thì allocation `stay` kéo đầu về giờ thực tế (một dòng liên tục, EXCLUDE chặn chồng); (d) sẵn sàng: `inspected`, hoặc `clean` khi `properties.require_inspected = false`; còn lượt `in_house` khác hoặc allocation ở/hợp đồng phủ thời điểm nhận → `409 ROOM_OCCUPIED`, block → `409 ROOM_UNAVAILABLE`; `ROOM_NOT_READY`/`ROOM_OCCUPIED` kèm `alternatives` (phòng cùng loại trống và sẵn sàng); (e) tiền phòng từng đêm ghi ở `charges` (kind `room`, `REV_ROOM`) ngay lúc check-in/walk-in theo snapshot giá (Q-11 theo đề xuất; unique theo stay + `business_date`, migration 0026); (f) query `stay.get` {stay_id}: khách + giấy tờ che; kế toán đọc được lượt ở nhưng `documents` rỗng, buồng phòng/tổ chức khác `404`; (g) chưa làm (T-207/T-206): `residence_notices` (`stay.check_in_started`/`stay.checked_in` — mới có outbox `stay.checked_in`), folio/check-out. Migration 0026: một lượt `in_house` mỗi phòng, một khoản tiền phòng mỗi đêm, một dòng mỗi (người, loại, số) giấy tờ.
- UI: các bước ngắn; tổng giá, điều kiện huỷ và phòng luôn hiện; tóm tắt trước/sau khi đổi ngày/giá/hoàn (kế hoạch §09). Chỉ báo thành công sau phản hồi máy chủ. Màn "Hôm nay": khách đến/đi (khách sắp đến = stays `expected` có ngày đến hôm nay; stay `no_show`/`cancelled` không đếm), phòng chưa sẵn sàng, thông báo lưu trú sắp/quá hạn. Thông báo lưu trú là nghĩa vụ của cơ sở: hệ thống chỉ xuất file và ghi dấu vết, không tự nộp.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| ROOM_UNAVAILABLE | Phòng bị chiếm trong khoảng | 409 | Phòng đã có người giữ trong thời gian này. Xem phòng gợi ý. | S-004, S-008, S-015 |
| HOLD_EXPIRED | Xác nhận khi hold hết hạn | 409 | Thời gian giữ phòng đã hết. Vui lòng giữ lại. | S-007 |
| ROOM_NOT_READY | Phòng chưa sạch/chưa kiểm | 409 | Phòng chưa dọn xong, chưa thể nhận khách. | S-013 |
| ROOM_OCCUPIED | Phòng còn khách thực tế | 409 | Phòng vẫn còn khách chưa trả. | S-013 |
| INVALID_TRANSITION | Chuyển trạng thái sai (gồm check-in stay `no_show`; đánh dấu thông báo lưu trú đã `submitted`) | 409 | Thao tác không hợp lệ với trạng thái hiện tại. | S-010, S-011, S-029 |
| OUTSTANDING_BALANCE | Trả phòng còn nợ không có duyệt (kể cả khách trả thiếu tiền mặt) | 409 | Khách còn nợ. Cần quản lý cho phép và hạn trả. | S-019, S-026 |
| PERIOD_LOCKED | Ghi/huỷ phí trong kỳ đã khoá | 409 | Kỳ này đã khoá. Hãy tạo điều chỉnh có duyệt. | S-022 |
| DOCUMENT_IMMUTABLE | Sửa chứng từ đã phát hành | 409 | Phiếu đã phát hành, không sửa trực tiếp. Hãy tạo điều chỉnh. | S-023 |
| OVER_ALLOCATION ² | Phân bổ vượt thanh toán/phiếu | 409 | Số tiền phân bổ vượt số còn lại. | S-024 |
| IDEMPOTENCY_CONFLICT | Cùng key khác nội dung | 409 | Thao tác trùng mã nhưng khác nội dung. Vui lòng tải lại. | S-018 |
| APPROVAL_LIMIT_EXCEEDED | Giảm giá/phí huỷ/hoàn cọc vượt hạn mức | 403 | Số tiền vượt hạn mức của bạn. Đã gửi yêu cầu duyệt. | S-009, S-027 |
| FORBIDDEN | Không đủ quyền (gồm xác nhận tiền mặt không phải do mình nhận hoặc không có ca đang mở) | 403 | Bạn không có quyền thực hiện thao tác này. | S-026 |
| SELF_APPROVAL_FORBIDDEN | Tự duyệt khấu trừ/hoàn cọc mình lập (mã dùng chung, SPEC-ledger-payments) | 403 | Bạn không thể tự duyệt chứng từ mình lập. | S-027 |
| NOT_FOUND | Khác tổ chức/không được đọc | 404 | Không tìm thấy dữ liệu. | S-025 |
| CAPACITY_EXCEEDED | Vượt sức chứa | 422 | Số khách vượt sức chứa của phòng. | S-014 |
| RATE_NOT_CONFIGURED | Ngày không có giá | 422 | Chưa cấu hình giá cho loại phòng này. | — |
| NOTICE_TEMPLATE_MISSING | Xuất thông báo lưu trú khi cơ sở chưa cấu hình mẫu | 409 | Cơ sở chưa cấu hình mẫu thông báo lưu trú. | S-028 |
| VALIDATION_FAILED | Thiếu/sai trường (gồm thiếu trường bắt buộc của mẫu thông báo lưu trú) | 422 | Thông tin chưa hợp lệ, xem các trường được đánh dấu. | S-019, S-028, S-029 |

² Mã định nghĩa ở SPEC-ledger-payments. `DOCUMENT_IMMUTABLE` là mã đề xuất mới, cần thêm vào SPEC-ledger-payments để dùng chung.

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Thời gian check-in | Trung vị < 2 phút khi đủ thông tin | M-03 | `stay.check_in_started` → `stay.checked_in` |
| Độ trễ | p95 < 800 ms; hold p95 < 1,5 s | kế hoạch §17 | k6 |
| Đúng tiền | 0 sai lệch không giải thích; ví dụ 1.430.000/930.000 xanh | M-04, kế hoạch §06 | test tích hợp + đối soát |
| UAT | 2 cơ sở chạy booking, check-in/out, cọc, huỷ, xung đột với dữ liệu giả lập | T056 | biên bản UAT |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `reservation.held`, `reservation.confirmed`, `reservation.cancelled`, `reservation.no_show`, `stay.check_in_started`, `stay.checked_in` (M-03), `stay.checked_out`, `stay.checked_out_with_balance`, `stay.notice_exported`, `stay.notice_submitted` (không PII) → M-03, M-04, M-05.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [x] Q-01 Giờ nhận/trả mặc định và giờ chốt ngày cho mẫu `hotel` — [chặn] — hỏi: PO — đề xuất: nhận 14:00, trả 12:00, giờ chốt ngày cấu hình theo cơ sở, mặc định chờ dữ liệu T001 (PROJECT §10). — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** nhận 14:00, trả 12:00; giờ chốt ngày khách sạn 04:00 (rental 00:00) — cột `properties.check_in_time`/`check_out_time`/`business_day_cutoff`, mặc định theo mẫu đặt ở `propertyDefaults` (D-005).
- [x] Q-02 "Giá ngày/đêm": là một đơn vị (đêm theo giờ nhận/trả) hay hai sản phẩm (ngày 24h và gói qua đêm) — [chặn] — hỏi: PO — đề xuất: pilot chỉ một đơn vị "đêm"; gói qua đêm/giờ đưa vào F-013. — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** pilot một đơn vị "đêm" theo ngày đến/ngày đi; giá giờ/qua đêm để F-013.
- [x] Q-03 Đêm nào là cuối tuần — [chặn] — hỏi: PO — đề xuất: đêm thứ Sáu và thứ Bảy theo `business_date`; ngày lễ chưa hỗ trợ ở pilot. — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** đêm thứ Sáu và thứ Bảy theo `business_date`; ngày lễ chưa hỗ trợ — `rate_plans.weekend_nights` mặc định `{5,6}`.
- [x] Q-04 Chính sách huỷ mặc định ở pilot — [chặn] — hỏi: PO + kế toán — đề xuất: không phạt tự động; phí huỷ nhập tay trong hạn mức, có lý do; ứng trước/cọc không tự thành doanh thu (kế hoạch §06). — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** không phạt tự động; phí huỷ nhập tay có lý do trong hạn mức; ứng trước/cọc giữ nguyên, hoàn qua duyệt (INV-F5).
- [ ] Q-05 Có cho xác nhận booking không kèm tiền không — [không chặn] — hỏi: PO — đề xuất: có, cấu hình theo cơ sở, mặc định cho phép; kế hoạch chưa nêu mức ứng trước tối thiểu.
- [ ] Q-06 Đổi ngày: đêm mới lấy giá hiện hành hay giá snapshot — [không chặn] — hỏi: PO — đề xuất: đêm cũ giữ snapshot, đêm mới giá hiện hành, hiện chênh lệch trước khi lưu.
- [ ] Q-07 Mốc được đánh no-show — [không chặn] — hỏi: PO — đề xuất: sau giờ chốt ngày của ngày đến, thao tác tay (không tự động ở pilot).
- [x] Q-08 Trường thông tin khách bắt buộc khi check-in và có lưu ảnh giấy tờ không — [chặn] — hỏi: PO + pháp lý — đề xuất: họ tên, SĐT, loại + số giấy tờ (che khi hiển thị); không lưu ảnh mặc định (NĐ 356/2025, kế hoạch §15); khách nước ngoài thêm quốc tịch, hộ chiếu. Số giấy tờ lưu ở `identity_documents`. — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** bắt buộc họ tên, SĐT người đặt; người lưu trú: loại + số giấy tờ (hiển thị che), khách nước ngoài thêm quốc tịch + hộ chiếu; không lưu ảnh giấy tờ mặc định (`properties.settings.store_id_images=false`). Mã hoá cột số giấy tờ: chờ chủ dự án (cần khoá bí mật + migration bỏ cột chữ rõ).
- [x] Q-09 Trạng thái `cancelled` và `no_show` cho `stays` — đã đóng: có ở DOMAIN-MODEL §4 (v1.2).
- [x] Q-10 Số đêm tối đa một booking ngắn hạn trước khi phải dùng hợp đồng — [không chặn] — hỏi: PO — đề xuất: 30 đêm. — **Quyết ở T-204 (đợt 3, 2026-10-16):** tối đa 30 đêm mỗi booking (`MAX_BOOKING_NIGHTS`, kiểm ở `reservation.create` và `reservation.changeDates`); dài hơn → `422 VALIDATION_FAILED` (`departure_date`, `STAY_TOO_LONG`), dùng hợp đồng.
- [x] Q-11 Thời điểm ghi phí phòng (`rate_plans` đã có ở DOMAIN-MODEL §7) — [không chặn] — hỏi: Tech Lead — đề xuất: ghi mọi đêm lúc check-in, điều chỉnh khi đổi ngày; phát hành phiếu lúc check-out. — **Quyết ở T-205 (D-009, 2026-10-16):** ghi `charges` tiền phòng mỗi đêm ngay lúc check-in/walk-in theo snapshot giá; chỉ mục duy nhất mỗi đêm một khoản; không job ghi theo đồng hồ.
- [x] Q-12 Thuế/phí ở giá phòng (tax profile mặc định, giá đã gồm thuế?) — [chặn] — hỏi: kế toán — đề xuất: pilot coi giá niêm yết là giá cuối, không cộng thuế tự động, mỗi `charges` vẫn lưu `tax_profile_id`. — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** giá niêm yết là giá cuối, không cộng thuế tự động; `charges.tax_profile_id` vẫn lưu.
- [ ] Q-13 Thông báo lưu trú: hạn, mẫu và trường dữ liệu — [không chặn dev vì là cấu hình; chặn dùng giá trị mặc định ở pilot] — hỏi: PO + pháp lý — đề xuất: **không đặt mặc định cứng**; hạn (giờ, riêng khách nước ngoài) và mẫu file cấu hình theo cơ sở (`notification_settings`, SPEC-notifications Q-08); nguồn pháp lý mới [T] (chưa đối chiếu bản gốc); trường xuất chỉ gồm những gì mẫu yêu cầu; V1 một `residence_notices` mỗi stay.
- [x] Q-14 Hoàn/khấu trừ cọc lúc check-out và cấm tự duyệt — [chặn pilot] — hỏi: PO + kế toán — đề xuất (chờ PO): lễ tân ≤ 2.000.000 đ/lần chỉ khi check-out, quản lý ≤ 5.000.000 đ/lần, owner không giới hạn, kế toán lập đề nghị không duyệt; hoàn nguyên số cọc còn lại cho chính khách (không khấu trừ) trong hạn mức lễ tân thực hiện một bước, còn khấu trừ cọc vào nợ luôn cần người duyệt khác người lập (INV-F5). Cần thống nhất với SPEC-ledger-payments (hiện ghi lễ tân hạn mức 0). — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** đã quyết ở PLAN đợt 2 (bảng câu hỏi [chặn]): lễ tân ≤ 2.000.000 đ/lần chỉ khi check-out, hoàn nguyên số còn lại một bước; khấu trừ luôn cần người duyệt khác người lập; quản lý ≤ 5.000.000 đ; owner không giới hạn; kế toán chỉ lập đề nghị.
- [x] Q-15 Lễ tân tự xác nhận tiền mặt do mình nhận trong ca mở (INV-F3b) — [chặn pilot] — hỏi: PO + kế toán — đề xuất (chờ PO): chấp nhận cho lễ tân; chênh lệch tiền mặt xử lý ở đóng ca (SPEC-ledger-payments); đã bắt MFA hay chưa theo SPEC-access-and-property Q-06. — **Quyết theo PLAN đợt 3 (D-002/D-005, 2026-10-16):** đã quyết ở PLAN đợt 2: lễ tân xác nhận tiền mặt do chính mình nhận trong ca đang mở; chênh lệch xử lý khi đóng ca.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · F-001, F-002 xong · SPEC-ledger-payments Approved (bút toán, mã lỗi chung).
- DoD: mọi S-NNN có test xanh; S-004, S-005, S-008, S-017, S-024, S-026, S-027 chạy trên Postgres thật · E2E R-003 · UAT T056 · API-CONTRACT cập nhật.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T049, T050, T051, T052, T053, T054, T056 | — | .autopilot/evidence/<task>.json |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-006 | (chờ) |
| 2 | 2026-10-15 | sửa theo review độc lập: thông báo lưu trú (`stay.exportResidenceNotice`, `stay.markNoticeSubmitted`, `residence_notices`, S-028–S-030, Q-13); no-show đưa stay `expected → no_show` và bỏ khỏi "Hôm nay" (S-011); walk-in khởi tạo thẳng `in_house` một command (S-015); check-out tiền mặt ca đêm, lễ tân tự xác nhận (S-026); hoàn cọc theo hạn mức lễ tân (S-027, Q-14, Q-15); `identity_documents`, `bank_transactions`; đóng Q-09 | review O8, O21, G3, R4, G5 | (chờ) |
