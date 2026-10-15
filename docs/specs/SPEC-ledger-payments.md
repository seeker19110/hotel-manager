# SPEC-ledger-payments — Sổ phụ, thu tiền, phân bổ, cọc, hoàn/đảo, QR, đối soát, chốt kỳ

| Trường | Giá trị |
|---|---|
| ID tính năng | F-005 (luồng gốc: R-001 phần thu và phân bổ; R-002 phần cọc) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 (2026-10-15) — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch gốc §08 (tài chính, đối soát), §12, §13 (ghi tiền và webhook); backlog T033–T040; DOMAIN-MODEL v1.2 §1, §4, §5, §7 (tài khoản, bút toán, INV-F1…F6, INV-F3b, INV-F4b, `bank_transactions`, ca quầy tối thiểu) |
| Phụ thuộc | SPEC-metering-billing (phát hành phiếu) · SPEC-lease (quyết toán) · SPEC-audit-reporting (xuất) · SPEC-notifications |

> Tên tài khoản, bảng và bút toán **chỉ** theo DOMAIN-MODEL v1.2 (§1, §5, §7); mọi bảng của spec này đã có ở đó, không còn tên **†**.
> Phiếu (`invoices`) là chứng từ nghiệp vụ nội bộ, **không phải hoá đơn điện tử**; mọi màn hình/PDF ghi rõ "Phiếu tính tiền — không phải hoá đơn GTGT". Hệ thống **không giữ tiền** và không chạm dữ liệu thẻ.
> Webhook vào theo một đường duy nhất `POST /api/v1/webhooks/{provider}/{account}`; trong pilot là **nhà cung cấp mô phỏng** (`provider='sim'`); adapter ngân hàng thật thuộc F-016.
> Hạn mức duyệt tiền theo vai trò chỉ quyết **một chỗ**: mục 10 (đề xuất, chờ PO); các nơi khác chỉ tham chiếu.

## 1. User story
- Là **kế toán**, tôi muốn ghi tiền thu có chứng cứ, phân bổ vào một hay nhiều phiếu, để công nợ đúng và không ai xác nhận tiền "khách nói đã chuyển".
- Là **chủ**, tôi muốn cọc tách khỏi doanh thu, hoàn/khấu trừ phải có duyệt và kỳ đã chốt không sửa được, để số liệu tin được (M-04 = 0 sai lệch không giải thích).

## 2. Tiêu chí chấp nhận (Given/When/Then)

Fixture `ledger-basic`: phiếu I1 (trọ, L1) tổng 3.580.000 đ đã phát hành; phiếu I2 (khách sạn, folio S1) tổng 2 × 600.000 + 80.000 + 150.000 = 1.430.000 đ; tài khoản nhận ngân hàng B1; kế toán K, quản lý M, lễ tân F, chủ O.

### S-001 Thu một phần — ví dụ bắt buộc 1.580.000 đ
- Given I1 còn 3.580.000 đ
- When K gọi `payment.record` 2.000.000 đ chuyển khoản B1 kèm dòng sao kê (mã giao dịch `FT26288001`), `payment.confirm`, rồi `payment.allocate` 2.000.000 vào I1
- Then có 1 `bank_transactions` `(B1, FT26288001)` và thanh toán `confirmed` tham chiếu nó (INV-F4b); bút toán 1: Nợ `BANK` 2.000.000 / Có `CUSTOMER_CREDIT` 2.000.000; bút toán 2: Nợ `CUSTOMER_CREDIT` 2.000.000 / Có `AR` 2.000.000; I1 còn **1.580.000 đ**; cọc 3.000.000 của L1 không đổi

### S-002 Ứng trước khách sạn — ví dụ bắt buộc 930.000 đ
- Given khách S1 đã trả trước 500.000 đ (`confirmed`, nằm ở `CUSTOMER_CREDIT`)
- When phiếu I2 1.430.000 đ phát hành và K phân bổ 500.000 vào I2
- Then I2 còn **930.000 đ**; số dư `CUSTOMER_CREDIT` của S1 = 0

### S-003 Mọi bút toán cân bằng, append-only (INV-F1)
- Given transaction ghi bút toán Nợ `AR` 100.000 / Có `REV_FEE` 99.999
- When COMMIT
- Then constraint trigger deferred báo lỗi, rollback toàn bộ; API trả 500 `LEDGER_UNBALANCED` và phát cảnh báo; `UPDATE`/`DELETE` trên `journal_lines` bị từ chối

### S-004 Phân bổ vượt số tiền thanh toán (INV-F2)
- Given thanh toán P2 2.500.000 đ `confirmed`, I1 còn 1.580.000, I2 còn 930.000
- When K phân bổ P2: I1 1.580.000 + I2 930.000 (tổng 2.510.000)
- Then lỗi 409 `OVER_ALLOCATION`, không ghi dòng nào; phân bổ I1 1.580.000 + I2 920.000 thì thành công, I2 còn 10.000 đ

### S-005 Phân bổ vượt số còn lại của phiếu (INV-F2)
- Given I1 còn 1.580.000
- When phân bổ 1.580.001 vào I1
- Then lỗi 409 `OVER_ALLOCATION`

### S-006 Hai người phân bổ cùng một tiền đồng thời (INV-F2)
- Given thanh toán P3 2.000.000 đ chưa phân bổ, I3 và I4 mỗi phiếu còn 1.500.000
- When K phân bổ P3 → I3 1.500.000 và M phân bổ P3 → I4 1.500.000 cùng lúc
- Then đúng 1 lệnh thành công, lệnh kia 409 `OVER_ALLOCATION`; Σ phân bổ P3 ≤ 2.000.000; khoá hàng `payments`/`invoices` theo id tăng dần, không deadlock trong 100 lần chạy

### S-007 Trả thừa thành `CUSTOMER_CREDIT`
- Given I1 còn 1.580.000
- When khách chuyển 2.000.000 đ, K xác nhận và phân bổ 1.580.000 vào I1
- Then I1 = 0 (đã tất toán); 420.000 đ nằm ở `CUSTOMER_CREDIT` của người trả, hiện ở báo cáo "số dư khách"

### S-008 Không xác nhận khi thiếu chứng cứ (INV-F3)
- Given khách bấm "đã chuyển" trên portal → chỉ tạo `payment_claims` `submitted` (SPEC-portal), **không** tạo `payments`; K tạo thanh toán `pending` 2.000.000 đ từ claim đó
- When K gọi `payment.confirm` không có `evidence`
- Then lỗi 422 `EVIDENCE_REQUIRED`; vẫn `pending`; không có bút toán; claim vẫn `submitted`

### S-009 Xác nhận hai lần / đảo khi còn pending
- Given thanh toán `confirmed`
- When gọi `payment.confirm` lần nữa bằng key mới; và với thanh toán `pending` gọi `payment.reverse`
- Then cả hai lỗi 409 `INVALID_TRANSITION`; không thêm bút toán

### S-010 Đảo thanh toán đã phân bổ
- Given thanh toán 2.000.000 đ đã phân bổ vào I1 (S-001)
- When O gọi `payment.reverse` có lý do
- Then trạng thái `reversed`; bút toán đảo phân bổ (Nợ `AR` / Có `CUSTOMER_CREDIT` 2.000.000) và đảo thu (Nợ `CUSTOMER_CREDIT` / Có `BANK` 2.000.000), mỗi bút toán có `reverses_entry_id`; I1 còn lại 3.580.000; bút toán gốc giữ nguyên; đảo lần 2 → 409 `INVALID_TRANSITION`

### S-011 Nhận cọc tách doanh thu (tiền mặt đi qua `payments`, INV-F3b — đề xuất, chờ PO)
- Given hợp đồng L1; F có ca đang mở (mục "Ca quầy tối thiểu")
- When F gọi `deposit.receive` 3.000.000 đ tiền mặt
- Then **không** ghi thẳng `CASH`: tạo `payments` `pending` (mục đích `deposit`, gắn `deposit_id`, `shift_id` của F) và biên nhận do hệ thống sinh; trước khi xác nhận không có bút toán; F xác nhận (tiền do chính F nhận trong ca đang mở) → `confirmed`, Nợ `CASH` 3.000.000 / Có `DEPOSIT_LIAB` 3.000.000 (không qua `CUSTOMER_CREDIT`); số 3.000.000 vào đối chiếu đóng ca; báo cáo doanh thu không đổi

### S-012 Khấu trừ cọc cần duyệt (INV-F5)
- Given cọc L1 3.000.000, I1 còn 1.580.000
- When M gọi `deposit.requestDeduction` 1.580.000 có lý do; O gọi `deposit.approveDeduction`
- Then trước khi duyệt: không bút toán; sau duyệt: Nợ `DEPOSIT_LIAB` 1.580.000 / Có `AR` 1.580.000, chứng từ liên kết I1 và yêu cầu; M tự duyệt → 403 `SELF_APPROVAL_FORBIDDEN`

### S-013 Hoàn cọc có hạn mức và không vượt số còn lại
- Given cọc còn 1.420.000 (sau S-012), hạn mức hoàn của M = 5.000.000 đ/lần (đề xuất mục 10)
- When M yêu cầu hoàn 1.420.001 → lỗi 409 `REFUND_EXCEEDS_BALANCE`; yêu cầu 1.420.000, O duyệt
- Then Nợ `DEPOSIT_LIAB` 1.420.000 / Có `CASH` 1.420.000; cọc còn 0; hai lệnh duyệt đồng thời → đúng 1 hiệu lực

### S-014 Hạn mức vai trò
- Given hạn mức hoàn của M = 5.000.000 đ
- When M duyệt yêu cầu hoàn 6.000.000 đ do người khác lập
- Then lỗi 403 `APPROVAL_LIMIT_EXCEEDED`

### S-015 QR chỉ là thông tin chuyển tiền
- Given I1 còn 1.580.000, mã tham chiếu `HM7Q4K2P` (sinh ngẫu nhiên, duy nhất theo tổ chức)
- When người thuê mở `payment.getTransferInfo` cho I1
- Then trả số tài khoản B1, số tiền 1.580.000, nội dung CK chứa `HM7Q4K2P`, ảnh QR; trạng thái I1 không đổi cho đến khi có xác nhận có chứng cứ

### S-016 Webhook mô phỏng — 100 lần cùng payload = 1 hiệu lực (INV-F4)
- Given I1 còn 1.580.000; payload `sim` hợp lệ: `event_id`=E1, `bank_txn_ref`=`SIM00001`, B1, 1.580.000 đ, nội dung `HM7Q4K2P`, chữ ký HMAC-SHA256 đúng
- When gửi 100 lần song song tới `POST /api/v1/webhooks/{provider}/{account}` với provider=`sim`, account=B1
- Then đúng 1 dòng `inbox` `(sim, B1, E1)`, 1 `bank_transactions` `(B1, SIM00001)`, 1 thanh toán `confirmed` (chứng cứ = webhook đã xác minh, trỏ `bank_transaction_id`), 1 phân bổ vào I1; I1 = 0; 99 lần còn lại trả 200 `duplicate=true`

### S-017 Webhook sai chữ ký
- Given payload có chữ ký sai
- When gửi webhook
- Then 401 `WEBHOOK_SIGNATURE_INVALID`; không ghi `inbox`, không ghi tiền; đếm số lần sai trong metrics

### S-018 Trùng ID khác nội dung (INV-F4)
- Given `inbox` đã có E1 với hash h1
- When nhận E1 với số tiền khác (hash h2)
- Then 409 `INBOX_HASH_MISMATCH` (mã lỗi API); tạo `reconciliation_break` với **lý do** `HASH_MISMATCH` (không phải mã lỗi API, mục 6); báo động cho O; không ghi tiền

### S-019 Import sao kê CSV và chống nhập trùng
- Given file sao kê B1 gồm 5 dòng; 2 dòng đã nhập ở lần trước
- When K gọi `reconciliation.importStatement`
- Then 3 dòng mới vào `inbox` (`provider='statement_csv'`, `provider_event_id` = mã giao dịch ngân hàng, hoặc hash của ngày + số tiền + nội dung + số dư nếu không có mã) và vào `bank_transactions` với `bank_txn_ref` tương ứng; 2 dòng báo "đã nhập", không tạo bản ghi mới

### S-020 Ghép và hàng chờ khoản bất thường
- Given 4 dòng sao kê: (a) 1.580.000 nội dung `HM7Q4K2P`; (b) 500.000 nội dung "tien phong"; (c) 2.510.000 nội dung có 2 mã I1 và I2; (d) 2.000.000 có mã I1 nhưng I1 còn 1.580.000
- When xem trước ghép (`reconciliation.previewMatches`)
- Then (a) gợi ý khớp I1; (b) vào hàng chờ với lý do break `WRONG_REFERENCE`; (c) `COMBINED`; (d) `OVERPAID` (đều là lý do break, không phải mã lỗi API) (đề xuất phân bổ 1.580.000 + 420.000 vào `CUSTOMER_CREDIT`); không dòng nào ghi tiền trước khi K bấm xác nhận

### S-021 Xác nhận từ sao kê; người khác trả hộ
- Given dòng (b) ở hàng chờ
- When K gán dòng (b) cho phiếu của L1 và đánh dấu `THIRD_PARTY_PAYER` với ghi chú
- Then tạo thanh toán `confirmed` (chứng cứ = `bank_transaction` của dòng sao kê), người trả ghi theo sao kê, phân bổ 500.000; `THIRD_PARTY_PAYER` là lý do break (không phải mã lỗi API) và break được đóng; audit có lý do

### S-022 Chốt kỳ và điều chỉnh sau khoá (INV-F6)
- Given kỳ 09/2026 của P1 đã `ledger.lockPeriod`
- When K ghi thanh toán có `business_date`=2026-09-28
- Then lỗi 409 `PERIOD_LOCKED`; `ledger.issueAdjustment` (giảm 100.000 cho phiếu kỳ 09, có lý do, O duyệt) ghi vào kỳ đang mở và tham chiếu phiếu gốc: Nợ `DISCOUNT` 100.000 / Có `AR` 100.000

### S-023 Mở khoá kỳ: chỉ owner, không sửa chứng từ đã phát hành
- Given kỳ 09/2026 khoá (có `period_locks` hiệu lực; `billing_periods.status='locked'`)
- When M gọi `ledger.unlockPeriod`; K gọi; O gọi không có lý do; O gọi có lý do; sau đó K gọi sửa trực tiếp số tiền phiếu I1 của kỳ 09
- Then M và K → 403 `FORBIDDEN`; O không lý do → 422 `VALIDATION_FAILED`; O có lý do → `period_locks` ghi `released_by/released_at/release_reason` (không xoá dòng), kỳ chuyển `locked → issued`, audit `period.unlocked`; sửa trực tiếp phiếu I1 → 409 `DOCUMENT_IMMUTABLE` (mở khoá chỉ cho thêm điều chỉnh/đảo ghi ngày trong kỳ, không cho sửa chứng từ đã phát hành); gọi `ledger.unlockPeriod` khi kỳ không khoá → 409 `INVALID_TRANSITION`

### S-024 Báo cáo tách tiền thu, doanh thu, cọc, nợ
- Given tháng 10/2026: phát hành I1 3.580.000; thu 2.000.000 (S-001); nhận cọc 3.000.000 (S-011)
- When O xem `report.financialSummary` tháng 10
- Then doanh thu 3.580.000 (`REV_ROOM` 3.000.000, `REV_UTIL` 480.000, `REV_FEE` 100.000); tiền thu thanh toán 2.000.000; tiền nhận cọc 3.000.000 (dòng riêng); số dư cọc 3.000.000; nợ phải thu 1.580.000; tổng khớp chi tiết từng phiếu

### S-025 Scenario Outline — phân bổ và số còn lại
- Given phiếu tổng `<tong>`, đã phân bổ `<da>`, thanh toán mới `<tt>`, yêu cầu phân bổ `<pb>`
- When `payment.allocate`
- Then kết quả `<kq>`, phiếu còn `<con>`, `CUSTOMER_CREDIT` tăng `<du>`
- Examples:

| tong | da | tt | pb | kq | con | du |
|---|---|---|---|---|---|---|
| 3.580.000 | 0 | 2.000.000 | 2.000.000 | ok | 1.580.000 | 0 |
| 1.430.000 | 0 | 500.000 | 500.000 | ok | 930.000 | 0 |
| 3.580.000 | 2.000.000 | 2.000.000 | 1.580.000 | ok | 0 | 420.000 |
| 1 | 0 | 1 | 1 | ok | 0 | 0 |
| 0 | 0 | 1 | 1 | `OVER_ALLOCATION` | 0 | 1 |
| 1.580.000 | 0 | 1.580.000 | 0 | `VALIDATION_FAILED` | 1.580.000 | 1.580.000 |
| 967.742 | 0 | 1.000.000 | 967.742 | ok | 0 | 32.258 |

### S-026 Gửi lại command tiền (INV-G5)
- Given `payment.record` thành công với key K1
- When gửi lại K1 cùng payload; timeout rồi gọi `GET /api/v1/commands/{id}`
- Then 1 thanh toán; truy vấn trả kết quả gốc; K1 khác payload → 409 `IDEMPOTENCY_CONFLICT`

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Phân bổ 0 đ; thanh toán thiếu chứng cứ; sao kê rỗng | 422; không ghi gì | S-008, S-025 |
| Cực đại/độ dài | Số tiền 10^12 đ; sao kê 5.000 dòng; nội dung CK dài | `bigint` không tràn; giới hạn file cấu hình → 413 | S-019 |
| Trùng lặp/idempotency | Bấm 2 lần; webhook lặp; sao kê nhập lại | 1 hiệu lực | S-016, S-019, S-026 |
| Song song | 2 người phân bổ cùng tiền; 2 lệnh hoàn cùng cọc; webhook song song | Khoá theo id tăng dần; đúng 1 hiệu lực | S-006, S-013, S-016 |
| Mất mạng giữa chừng | Timeout sau COMMIT | Hỏi kết quả command, không tạo mới | S-026 |
| Thời gian/múi giờ | Thanh toán 23:30 ngày 30/09 giờ VN (16:30Z) khi kỳ 09 đã khoá | Kỳ tính theo `business_date` địa phương → `PERIOD_LOCKED` | S-022 |
| Quyền | Lễ tân hoàn cọc; quản lý mở khoá kỳ; tự duyệt | 403 | S-012, S-014, S-023 |
| Tiền/đơn vị | 0 đ, 1 đ, số lẻ từ prorata, trả thừa | Số nguyên đồng; thừa → `CUSTOMER_CREDIT` | S-007, S-025 |

## 4. Dữ liệu
| Thực thể | Trường chính | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|
| `journal_entries` / `journal_lines` | `entry_type`, `business_date`, `reverses_entry_id`, `source_doc`; dòng: `account`, `debit`, `credit` (`bigint`) | Σ Nợ = Σ Có (deferred trigger); append-only (INV-F1, INV-G4) | hệ thống ghi; accountant/owner đọc |
| `invoices` | `total`, `allocated_total`, `memo_ref` (mã tham chiếu CK) | unique `(organization_id, memo_ref)`; `allocated_total` ≤ `total` | |
| `payments` | `status`, `method` (`cash`/`bank_transfer`), `amount`, `account` (`CASH`/`BANK` + tài khoản nhận), `payer_person_id`, `evidence` (file/dòng sao kê/inbox id), `confirmed_by` | Theo DOMAIN-MODEL §4; `confirmed` cần `evidence` (INV-F3) | F/K ghi nhận; xác nhận theo quyền |
| `payment_allocations` | `payment_id`, `invoice_id`, `amount` | Σ theo payment ≤ amount; Σ theo invoice ≤ total (INV-F2) | K/M |
| `deposits` | `lease_id`/`reservation_id`, `amount`, `balance` | `balance` ≥ 0; khấu trừ/hoàn qua yêu cầu có duyệt | |
| `approval_requests`† | `kind` (`deposit_deduction`/`deposit_refund`/`adjustment`/`reversal`), `amount`, `reason`, `requested_by`, `approved_by` | `approved_by` ≠ `requested_by`; hạn mức theo vai trò | |
| `inbox` | `provider`, `account`, `provider_event_id`, `payload_hash`, `raw` | unique `(provider, account, provider_event_id)` (INV-F4) | hệ thống |
| `reconciliation_breaks`† | `inbox_id`, `reason` (`WRONG_REFERENCE`/`COMBINED`/`OVERPAID`/`THIRD_PARTY_PAYER`/`UNMATCHED`/`HASH_MISMATCH`), `assignee`, `resolution` | Không tự đóng; có người chịu trách nhiệm | K/O |
| `period_locks` | `property_id`, `locked_through`, `locked_by`, `reason` | Sau khoá chỉ thêm điều chỉnh/đảo có duyệt (INV-F6) | owner |

## 5. Giao diện / API
| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `payment.record` | phương thức, số tiền, tài khoản nhận, người trả, chứng cứ? | `payment_id` (`pending`) | `VALIDATION_FAILED`, `PERIOD_LOCKED` |
| `payment.confirm` | `payment_id`, `evidence` | `confirmed`, `journal_entry_id` | `EVIDENCE_REQUIRED`, `INVALID_TRANSITION`, `FORBIDDEN` |
| `payment.allocate` | `payment_id`, `[{invoice_id, amount}]` | phân bổ, số còn của từng phiếu | `OVER_ALLOCATION`, `VALIDATION_FAILED` |
| `payment.reverse` | `payment_id`, lý do | `reversed`, bút toán đảo | `INVALID_TRANSITION`, `FORBIDDEN`, `PERIOD_LOCKED` |
| `payment.getTransferInfo` | `invoice_id` | tài khoản, số tiền còn, nội dung CK, QR | `NOT_FOUND` |
| `deposit.receive` | `lease_id`/`reservation_id`, số tiền, phương thức, chứng cứ | `deposit_id` | `EVIDENCE_REQUIRED` |
| `deposit.requestDeduction` / `deposit.approveDeduction` | cọc, phiếu, số tiền, lý do / `request_id` | bút toán khấu trừ | `REFUND_EXCEEDS_BALANCE`, `SELF_APPROVAL_FORBIDDEN`, `APPROVAL_LIMIT_EXCEEDED` |
| `deposit.requestRefund` / `deposit.approveRefund` | cọc, số tiền, phương thức, lý do / `request_id` | bút toán hoàn | như trên |
| `ledger.issueAdjustment` | phiếu gốc, số tiền ±, lý do | chứng từ điều chỉnh | `FORBIDDEN`, `SELF_APPROVAL_FORBIDDEN` |
| `ledger.lockPeriod` / `ledger.unlockPeriod` | `property_id`, ngày khoá, lý do | `period_lock_id` | `FORBIDDEN`, `INVALID_TRANSITION` |
| `reconciliation.importStatement` | tài khoản, file CSV | số dòng mới/trùng/lỗi | `VALIDATION_FAILED`, `FILE_TOO_LARGE` |
| `reconciliation.previewMatches` / `reconciliation.confirmMatch` / `reconciliation.resolveBreak` | dòng sao kê, phiếu, ghi chú | gợi ý / thanh toán `confirmed` / break đóng | `OVER_ALLOCATION`, `INVALID_TRANSITION` |
| `POST /api/v1/webhooks/sim/{account}` | payload + header chữ ký | 200 (`duplicate`?) | `WEBHOOK_SIGNATURE_INVALID`, `INBOX_HASH_MISMATCH` |
| `report.financialSummary`, `report.receivables`, `report.deposits`, `report.customerCredit` | cơ sở, kỳ | số tổng + chi tiết, xuất CSV | `FORBIDDEN` |

- Mã tham chiếu CK: chuỗi chữ hoa + số, không chứa thông tin cá nhân; độ dài và định dạng QR theo chuẩn ngân hàng (chưa xác minh — làm ở T037).
- Xuất CSV dùng chung bộ chống formula injection của SPEC-audit-reporting (S-016); báo cáo chi tiết và quyền xuất ở SPEC-audit-reporting.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp | Scenario |
|---|---|---|---|---|
| `OVER_ALLOCATION` | Vượt số tiền thanh toán hoặc số còn của phiếu | 409 | Số phân bổ vượt số tiền còn lại. | S-004…S-006 |
| `EVIDENCE_REQUIRED` | Xác nhận không có chứng cứ | 422 | Cần đính kèm chứng cứ (sao kê/ảnh biên nhận) để xác nhận. | S-008 |
| `INVALID_TRANSITION` | Xác nhận 2 lần, đảo khi pending, đảo 2 lần | 409 | Không thể thực hiện với trạng thái hiện tại. | S-009, S-010 |
| `REFUND_EXCEEDS_BALANCE` | Hoàn/khấu trừ vượt số dư cọc | 409 | Số tiền vượt số dư cọc còn lại. | S-013 |
| `APPROVAL_LIMIT_EXCEEDED` | Vượt hạn mức vai trò | 403 | Số tiền vượt hạn mức duyệt của bạn. | S-014 |
| `SELF_APPROVAL_FORBIDDEN` | Tự duyệt | 403 | Bạn không thể tự duyệt chứng từ mình lập. | S-012 |
| `PERIOD_LOCKED` | Ghi vào kỳ đã khoá | 409 | Kỳ đã khoá. Cần chứng từ điều chỉnh có duyệt. | S-022 |
| `WEBHOOK_SIGNATURE_INVALID` | Chữ ký sai | 401 | (không hiển thị cho người dùng) | S-017 |
| `INBOX_HASH_MISMATCH` | Trùng ID khác nội dung | 409 | (báo động nội bộ) | S-018 |
| `LEDGER_UNBALANCED` | Bút toán lệch (lỗi hệ thống) | 500 | Lỗi hệ thống khi ghi sổ. Thao tác chưa được lưu. | S-003 |
| `FILE_TOO_LARGE` | File sao kê vượt giới hạn | 413 | File quá lớn. | — |
| `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_FAILED` / `IDEMPOTENCY_CONFLICT` | dùng chung | 403/404/422/409 | như các SPEC khác | S-023, S-025, S-026 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Idempotency | 100 lần cùng payload = 1 hiệu lực | Kế hoạch §13; PROJECT.md §5 | test tích hợp Postgres thật |
| Đúng sổ | Property test: mọi chuỗi thao tác ngẫu nhiên giữ Σ Nợ = Σ Có và INV-F2 | T040, T074 | fast-check trên DB thật |
| Hiệu năng | p95 < 800 ms; import 5.000 dòng sao kê < 30 s (đề xuất) | PROJECT.md §5 | k6 |
| Bảo mật | ASVS 5.0 L2 cho luồng tiền; secret webhook không vào log | PROJECT.md §5 | CI + pentest |

## 8. Hành vi AI
Không áp dụng.

## 9. Đo lường
- `payment.recorded`, `payment.confirmed`, `payment.allocated`, `deposit.refunded`, `reconciliation_break.created/resolved` → M-04; `period.locked`.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Hạn mức duyệt hoàn/khấu trừ/điều chỉnh theo vai trò — [chặn] — hỏi: PO. **Đề xuất:** `front_desk` 0 (chỉ lập yêu cầu); `accountant` lập, không duyệt; `manager` duyệt ≤ 5.000.000 đ/lần; `owner` không giới hạn; luôn cấm tự duyệt. Cơ sở chỉnh số.
- [ ] Chứng cứ cho **tiền mặt** theo INV-F3 — [chặn] — hỏi: PO + kế toán. **Đề xuất:** người nhận có quyền xác nhận trong ca đang mở + biên nhận do hệ thống sinh (ảnh chữ ký tuỳ chọn); chênh lệch xử lý ở chốt ca.
- [ ] Làm tròn (1 đ/1.000 đ, dòng/tổng) — [chặn] — hỏi: PO + kế toán. **Đề xuất:** theo SPEC-metering-billing mục 10 (`HALF_UP_1` từng dòng).
- [ ] Ghi nhận doanh thu — [không chặn pilot] — hỏi: kế toán. **Đề xuất:** khi phát hành phiếu.
- [ ] Hoàn tiền thừa từ `CUSTOMER_CREDIT` cho khách (Nợ `CUSTOMER_CREDIT` / Có `CASH`/`BANK`) chưa có trong bảng bút toán DOMAIN-MODEL §5 — [không chặn] — hỏi: Tech Lead + kế toán. **Đề xuất:** thêm sự kiện này, đi qua `approval_requests`†.
- [ ] Webhook: tự phân bổ khi mã tham chiếu khớp và số tiền ≤ số còn — [không chặn] — hỏi: PO. **Đề xuất:** có; phần thừa vào `CUSTOMER_CREDIT`; không khớp → hàng chờ.
- [ ] Định dạng CSV sao kê của các ngân hàng pilot — [không chặn] — hỏi: đại diện pilot. **Đề xuất:** ánh xạ cột cấu hình theo tài khoản nhận.
- [ ] Bổ sung `approval_requests`†, `reconciliation_breaks`† vào DOMAIN-MODEL — [chặn migration] — hỏi: Tech Lead.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu [chặn] · DOMAIN-MODEL bổ sung tên † · SPEC-metering-billing Approved.
- DoD: mọi S-NNN có test; INV-F1…F6 chạy trên Postgres thật · E2E R-001 phần thu · sự kiện đo có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T033 Sổ bất biến, mã chứng từ | — | S-003, S-010 |
| T034 Phiếu nội bộ | — | S-001, S-002, S-022 |
| T035 Thu một phần, phân bổ nhiều phiếu | — | S-001, S-004…S-007, S-025 |
| T036 Sổ cọc, hoàn, duyệt | — | S-011…S-014 |
| T037 QR + mã tham chiếu | — | S-015 |
| T038 Đối soát thủ công | — | S-016…S-021 |
| T039 Báo cáo | — | S-024 |
| T040 Chốt kỳ, test toàn luồng | — | S-022, S-023, S-026 |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | Tạo | G3 cho F-005 | (chưa) |
