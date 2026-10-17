---
status: Approved
approved_by: "chủ dự án (duyệt PLAN đợt 2)"
approved_at: 2026-10-15
---

# SPEC-ledger-payments — Sổ phụ, thu tiền, phân bổ, cọc, hoàn/đảo, QR, đối soát, chốt kỳ

| Trường | Giá trị |
|---|---|
| ID tính năng | F-005 (luồng gốc: R-001 phần thu và phân bổ; R-002 phần cọc) |
| Trạng thái | Approved — câu [chặn] chốt theo PLAN đợt 2 (tham số hoá) |
| Phiên bản | 2 (2026-10-15) — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi chủ dự án ngày 2026-10-15 (duyệt PLAN đợt 2) |
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
- Then 1 thanh toán; truy vấn trả kết quả gốc; K1 khác payload → 422 `IDEMPOTENCY_CONFLICT`

### S-027 Khách trả tiền mặt lúc check-out ca đêm, lễ tân tự xác nhận (INV-F3b — đề xuất, chờ PO)
- Given khách S1 (S-002) check-out ca đêm; phiếu folio I2 1.430.000 đã phát hành, ứng trước 500.000 đã phân bổ, còn **930.000**; F có ca đang mở (`shift.open` đầu ca 2.000.000)
- When khách đưa 930.000 tiền mặt; F gọi `stay.checkOut` kèm thanh toán tiền mặt 930.000 (hệ thống gọi `payment.record` rồi `payment.confirm` bằng quyền của F, và phân bổ vào I2)
- Then thanh toán `pending` rồi `confirmed` bởi F (người nhận = người xác nhận, ca đang mở), chứng cứ = biên nhận hệ thống sinh (gắn `shift_id`); Nợ `CASH` 930.000 / Có `CUSTOMER_CREDIT` 930.000, rồi Nợ `CUSTOMER_CREDIT` 930.000 / Có `AR` 930.000; I2 còn **0**, folio 0 nên check-out thành công, không cần `allow_balance` hay duyệt của quản lý; 930.000 được tính vào tiền mặt dự kiến của ca (S-034)

### S-028 Giới hạn xác nhận tiền mặt của lễ tân (INV-F3b — đề xuất, chờ PO)
- Given thanh toán tiền mặt 500.000 `pending` do F2 nhận trong ca của F2; F không có ca đang mở; thanh toán chuyển khoản `pending` của K
- When F xác nhận khoản của F2; F (chưa mở ca) nhận và xác nhận tiền mặt của chính mình; F xác nhận khoản chuyển khoản
- Then lần 1 → 403 `FORBIDDEN` (không phải tiền do F nhận); lần 2 → 409 `SHIFT_NOT_OPEN`; lần 3 → 403 `FORBIDDEN` (lễ tân chỉ tự xác nhận tiền mặt do mình nhận, chuyển khoản vẫn cần chứng cứ theo INV-F3); cả ba lần không có bút toán; M xác nhận khoản của F2 với biên nhận thì thành công

### S-029 Nhập tay kèm dòng sao kê rồi import cùng sao kê (INV-F4b)
- Given K đã `payment.record` + `payment.confirm` + `payment.allocate` 2.000.000 vào I1 kèm dòng sao kê mã `FT26288001` (S-001): 1 `bank_transactions`, 1 payment, `CUSTOMER_CREDIT` = 0 sau phân bổ
- When K gọi `reconciliation.importStatement` với file B1 gồm dòng `FT26288001` (2.000.000 đ) và 2 dòng mới; rồi K gọi `payment.record` lại với cùng mã `FT26288001`
- Then dòng `FT26288001` báo "đã nhập" (trùng `(B1, FT26288001)`), **không** tạo payment hay `CUSTOMER_CREDIT` thứ hai; 2 dòng mới vào `bank_transactions`; I1 và số dư khách không đổi; lệnh `payment.record` lặp → 409 `BANK_TRANSACTION_ALREADY_USED` kèm `payment_id` hiện có

### S-030 Webhook mô phỏng và sao kê cùng một giao dịch → 1 payment (INV-F4b)
- Given webhook `sim` `event_id`=E2, `bank_txn_ref`=`SIM00002`, B1, 500.000 đ đã xử lý: 1 `bank_transactions`, 1 payment `confirmed`
- When K import sao kê B1 có dòng cùng giao dịch (`SIM00002`, 500.000 đ); rồi (ca ngược) sao kê có `SIM00003` được import trước, sau đó webhook E3 cùng `bank_txn_ref` `SIM00003` tới; và một dòng sao kê `SIM00002` có số tiền 600.000
- Then trường hợp 1: dòng báo "đã nhập", vẫn 1 payment; trường hợp 2: webhook trả 200, `inbox` `(sim, B1, E3)` gắn vào `bank_transactions` có sẵn, không tạo payment thứ hai; trường hợp 3: cùng `bank_txn_ref` khác số tiền → `reconciliation_break` lý do `HASH_MISMATCH`, không ghi tiền, báo động cho O

### S-031 Huỷ booking có ứng trước 500.000 rồi hoàn `CUSTOMER_CREDIT` (cần duyệt)
- Given booking R1 của khách G đã trả ứng trước 500.000 đ chuyển khoản B1 (`confirmed`, nằm ở `CUSTOMER_CREDIT`, chưa phân bổ); R1 bị huỷ (SPEC-reservation-stay: huỷ không tạo doanh thu)
- When F gọi `credit.requestRefund` 500.000 đ về tài khoản của G có lý do; F gọi `credit.approveRefund`; M gọi `credit.approveRefund`; (lập yêu cầu khác) F yêu cầu hoàn 500.001
- Then trước khi duyệt: không bút toán; F tự duyệt → 403 `SELF_APPROVAL_FORBIDDEN`; M duyệt (500.000 ≤ hạn mức mục 10): Nợ `CUSTOMER_CREDIT` 500.000 / Có `BANK` 500.000, số dư `CUSTOMER_CREDIT` của G = 0, không có dòng `REV_*`; yêu cầu 500.001 → 409 `REFUND_EXCEEDS_BALANCE`; hai lệnh duyệt đồng thời → đúng 1 hiệu lực

### S-032 Ai được chốt kỳ (O4; khớp ma trận SPEC-access-and-property mục 5.3)
- Given kỳ 09/2026 và 10/2026 của P1 đã `issued`; K (accountant), M (manager), F (front_desk)
- When K gọi `ledger.lockPeriod` kỳ 09; M gọi `ledger.lockPeriod` kỳ 10; F gọi `ledger.lockPeriod` kỳ 10 (trước khi M chốt)
- Then K và M thành công (mỗi lệnh có `period_locks` với `locked_by`, `reason`, audit `period.locked`); F → 403 `FORBIDDEN` (lễ tân chỉ chốt **ca của mình**, S-034); mở khoá chỉ owner (S-023)

### S-033 Hạn mức duyệt hoàn/khấu trừ cọc khách sạn theo vai trò (đề xuất, chờ PO — số ở mục 10)
- Given cọc bảo đảm khách sạn 3.000.000 đ của stay S2 (đã nhận qua `payments`); K lập yêu cầu hoàn 1.500.000 tiền mặt lúc check-out; K lập yêu cầu hoàn 2.500.000; F có ca đang mở
- When F duyệt yêu cầu 1.500.000; F duyệt yêu cầu 2.500.000; K duyệt yêu cầu bất kỳ do người khác lập; F tự lập rồi tự duyệt
- Then 1.500.000 ≤ 2.000.000 → thành công: Nợ `DEPOSIT_LIAB` 1.500.000 / Có `CASH` 1.500.000, tính vào chi/hoàn tiền mặt của ca F; 2.500.000 → 403 `APPROVAL_LIMIT_EXCEEDED` (cần M hoặc O); K duyệt → 403 `FORBIDDEN` (kế toán lập, không duyệt); tự duyệt → 403 `SELF_APPROVAL_FORBIDDEN`

### Ca quầy tối thiểu (pilot)
Pilot cần kiểm soát tiền mặt theo ca nhưng chưa cần ca quầy đầy đủ. **Ca quầy đầy đủ (nhiều quỹ, báo cáo ca) vẫn là F-013**, tên bảng theo DOMAIN-MODEL v1.2 (`shifts`, `shift_discrepancies`).
- **Mở ca** (`shift.open`): người mở nhập tiền đầu ca (`opening_cash`); mỗi nhân viên tối đa 1 ca `open` cùng lúc. Tiền mặt nhận hoặc chi (nhận cọc, hoàn cọc, hoàn ứng trước bằng tiền mặt) chỉ ghi được khi người thao tác có ca đang mở (`SHIFT_NOT_OPEN`).
- **Đóng ca** (`shift.close`): hệ thống tính **tiền mặt dự kiến = tiền đầu ca + thu tiền mặt đã xác nhận (đã trừ khoản bị đảo) − chi/hoàn tiền mặt** trong ca; người đóng nhập **tiền đếm thực tế**; còn thanh toán tiền mặt `pending` của ca thì không đóng được (`SHIFT_HAS_PENDING_PAYMENTS`). Chênh lệch = đếm thực tế − dự kiến; **≠ 0** thì tạo `shift_discrepancies` có người chịu trách nhiệm (mặc định người chủ ca; quản lý có thể gán lại, có audit), không tự sửa số dư. Xử lý chênh lệch bằng `ledger.issueAdjustment` tham chiếu `shift_discrepancy_id` do người có quyền duyệt (không phải người chịu trách nhiệm).
- **Bàn giao ca** (`shift.handover`): hai bước — người giao khai báo số tiền giao (= tiền đếm thực tế) và người nhận; người nhận (≠ người giao) xác nhận số tiền nhận. Hai bên khớp thì ca của người nhận mở với tiền đầu ca = số đã nhận; lệch thì tạo thêm `shift_discrepancies` loại `handover`.
- Quyền (khớp ma trận SPEC-access-and-property mục 5.3): lễ tân mở/đóng/giao **ca của mình**; owner, manager mở/đóng ca bất kỳ; accountant đóng/đối chiếu ca (không nhận tiền). Sau khi đóng ca chỉ được thêm chứng từ điều chỉnh/đảo có duyệt (INV-F6).

### S-034 Mở ca, đóng ca có chênh lệch, người chịu trách nhiệm
- Given F mở ca đêm với đầu ca 2.000.000 đ; trong ca: thu tiền mặt đã xác nhận 930.000 (S-027) + 500.000 (khách khác); hoàn tiền mặt 200.000 (hoàn cọc đã duyệt); không còn tiền mặt `pending`
- When F gọi `shift.close` với tiền đếm thực tế 3.180.000
- Then dự kiến = 2.000.000 + (930.000 + 500.000) − 200.000 = **3.230.000**; chênh lệch = 3.180.000 − 3.230.000 = **−50.000** (thiếu); tạo `shift_discrepancies` −50.000, người chịu trách nhiệm = F, trạng thái `open`; không có bút toán tự động; ca `closed`. Đóng ca đếm đúng 3.230.000 → chênh lệch 0, không tạo `shift_discrepancies`. F đóng ca của F2 → 403 `FORBIDDEN`; M đóng ca của F2 được (K đối chiếu/đóng ca theo ma trận). F mở ca thứ hai khi ca đầu còn mở → 409 `SHIFT_ALREADY_OPEN`; đóng ca khi còn tiền mặt `pending` → 409 `SHIFT_HAS_PENDING_PAYMENTS`

### S-035 Bàn giao ca có xác nhận hai bên
- Given ca của F đã `closed` với tiền đếm 3.180.000 (S-034); F2 là lễ tân ca sáng
- When F gọi `shift.handover` giao 3.180.000 cho F2; F2 xác nhận nhận 3.180.000; (ca khác) F2 xác nhận nhận 3.150.000; F tự nhận cho chính mình
- Then trường hợp khớp: ca của F `handed_over`, ca mới của F2 mở với đầu ca 3.180.000, audit cả hai xác nhận; trường hợp lệch: tạo `shift_discrepancies` loại `handover` −30.000 (người chịu trách nhiệm mặc định = người giao, quản lý xác minh và gán lại); tự nhận → 403 `SELF_APPROVAL_FORBIDDEN`; xác nhận lần 2 → 409 `INVALID_TRANSITION`

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Phân bổ 0 đ; thanh toán thiếu chứng cứ; sao kê rỗng; đóng ca không nhập tiền đếm; mở ca đầu ca 0 đ | 422; không ghi gì; đầu ca 0 đ hợp lệ | S-008, S-025, S-034 |
| Cực đại/độ dài | Số tiền 10^12 đ; sao kê 5.000 dòng; nội dung CK dài | `bigint` không tràn; giới hạn file cấu hình → 413 | S-019 |
| Trùng lặp/idempotency | Bấm 2 lần; webhook lặp; sao kê nhập lại; nhập tay + sao kê + webhook cùng giao dịch | 1 hiệu lực, 1 payment | S-016, S-019, S-026, S-029, S-030 |
| Song song | 2 người phân bổ cùng tiền; 2 lệnh hoàn cùng cọc/`CUSTOMER_CREDIT`; webhook song song | Khoá theo id tăng dần; đúng 1 hiệu lực | S-006, S-013, S-016, S-031 |
| Mất mạng giữa chừng | Timeout sau COMMIT | Hỏi kết quả command, không tạo mới | S-026 |
| Thời gian/múi giờ | Thanh toán 23:30 ngày 30/09 giờ VN (16:30Z) khi kỳ 09 đã khoá; ca đêm qua nửa đêm | Kỳ tính theo `business_date` địa phương → `PERIOD_LOCKED`; thu tiền mặt thuộc ca đang mở lúc xác nhận | S-022, S-027 |
| Quyền | Lễ tân vượt hạn mức; kế toán duyệt; quản lý/kế toán mở khoá kỳ; lễ tân chốt kỳ hoặc đóng ca người khác; xác nhận tiền mặt của người khác; tự duyệt | 403 | S-012, S-014, S-023, S-028, S-032, S-033, S-034 |
| Tiền/đơn vị | 0 đ, 1 đ, số lẻ từ prorata, trả thừa; hoàn 500.001 khi dư 500.000; chênh lệch ca âm/dương | Số nguyên đồng; thừa → `CUSTOMER_CREDIT`; hoàn không vượt số dư | S-007, S-025, S-031, S-034 |

## 4. Dữ liệu
| Thực thể | Trường chính | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|
| `journal_entries` / `journal_lines` | `entry_type`, `business_date`, `reverses_entry_id`, `source_doc`; dòng: `account`, `debit`, `credit` (`bigint`) | Σ Nợ = Σ Có (deferred trigger); append-only (INV-F1, INV-G4) | hệ thống ghi; accountant/owner đọc |
| `invoices` | `total`, `allocated_total`, `memo_ref` (mã tham chiếu CK) | unique `(organization_id, memo_ref)`; `allocated_total` ≤ `total` | |
| `payments` | `status`, `method` (`cash`/`bank_transfer`), `purpose` (`receivable`: ghi `CUSTOMER_CREDIT` / `deposit`: gắn `deposit_id`, ghi `DEPOSIT_LIAB`), `amount`, `account` (`CASH`/`BANK` + tài khoản nhận), `payer_person_id`, `shift_id` (tiền mặt), `bank_transaction_id` (chuyển khoản), `evidence` (`kind`: `bank_transaction`/`inbox`/`file`/`cash_receipt` + id), `confirmed_by` | Theo DOMAIN-MODEL §4; `confirmed` cần `evidence` (INV-F3); chuyển khoản `confirmed` phải có `bank_transaction_id` **unique** (INV-F4b; `pending` từ claim chưa có dòng sao kê thì để trống); tiền mặt (kể cả cọc) luôn qua `pending → confirmed` (INV-F3b) và có `shift_id` | F/K ghi nhận; xác nhận theo quyền; lễ tân chỉ tự xác nhận tiền mặt do mình nhận trong ca đang mở |
| `bank_transactions` | `receiving_account_id`, `bank_txn_ref` (mã giao dịch ngân hàng, hoặc hash ngày + số tiền + nội dung + số dư nếu không có mã), `amount`, `occurred_at`, `description`, `first_source` (`webhook`/`statement`/`manual`), `raw_hash`, `inbox_id` | unique `(receiving_account_id, bank_txn_ref)` (INV-F4b); cùng khoá khác `raw_hash` → break `HASH_MISMATCH`, không ghi tiền; bất biến | hệ thống ghi; K/O đọc |
| `payment_allocations` | `payment_id`, `invoice_id`, `amount` | Σ theo payment ≤ amount; Σ theo invoice ≤ total (INV-F2) | K/M |
| `deposits` | `lease_id`/`reservation_id`, `amount`, `balance` | `balance` ≥ 0; khấu trừ/hoàn qua yêu cầu có duyệt | |
| `approval_requests` | `kind` (`deposit_deduction`/`deposit_refund`/`credit_refund`/`adjustment`/`reversal`), `amount`, `reason`, `requested_by`, `approved_by` | `approved_by` ≠ `requested_by`; hạn mức theo vai trò (mục 10) | |
| `inbox` | `provider`, `account`, `provider_event_id`, `payload_hash`, `raw` | unique `(provider, account, provider_event_id)` (INV-F4) | hệ thống |
| `reconciliation_breaks` | `inbox_id`, `bank_transaction_id?`, `reason` (**lý do break**, không phải mã lỗi API: `WRONG_REFERENCE`/`COMBINED`/`OVERPAID`/`THIRD_PARTY_PAYER`/`UNMATCHED`/`HASH_MISMATCH`), `assignee`, `resolution` | Không tự đóng; có người chịu trách nhiệm | K/O |
| `shifts` | `property_id`, `opened_by`, `opened_at`, `opening_cash`, `status` (`open`/`closed`/`handed_over`), `expected_cash`, `counted_cash`, `closed_by`, `closed_at`, `handed_to`, `received_cash`, `received_at` | Tối đa 1 ca `open` mỗi nhân viên; `expected_cash` do hệ thống tính (không nhập tay); `closed` bất biến (INV-F6) | lễ tân: ca của mình; owner/manager/accountant: mọi ca |
| `shift_discrepancies` | `shift_id`, `kind` (`close`/`handover`), `amount` (bigint có dấu, thiếu < 0), `responsible_membership_id`, `status` (`open`/`resolved`), `resolved_by`, `adjustment_entry_id` | `responsible_membership_id` NOT NULL; không tự đóng; xử lý bằng `ledger.issueAdjustment` do người ≠ người chịu trách nhiệm | manager/owner xử lý; accountant đọc |
| `period_locks` | `property_id`, `locked_through`, `locked_by`, `reason`, `released_by`, `released_at`, `release_reason` | Một cơ chế duy nhất: `billing_periods.status='locked'` ⇔ có `period_locks` hiệu lực (DOMAIN-MODEL §4); sau khoá chỉ thêm điều chỉnh/đảo có duyệt (INV-F6); gỡ khoá không xoá dòng, không cho sửa chứng từ đã phát hành | chốt: owner/manager/accountant; mở khoá: chỉ owner |

- Số dư `CUSTOMER_CREDIT` tính theo người trả (`payer_person_id`); hoàn qua `credit.requestRefund`/`credit.approveRefund` không vượt số dư đó.

## 5. Giao diện / API
| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `payment.record` | phương thức, số tiền, tài khoản nhận, người trả, chứng cứ?, dòng sao kê (`bank_txn_ref`) nếu chuyển khoản | `payment_id` (`pending`); tiền mặt: biên nhận hệ thống sinh, gắn ca đang mở | `VALIDATION_FAILED`, `PERIOD_LOCKED`, `SHIFT_NOT_OPEN`, `BANK_TRANSACTION_ALREADY_USED` |
| `payment.confirm` | `payment_id`, `evidence` (tiền mặt: biên nhận hệ thống) | `confirmed`, `journal_entry_id` | `EVIDENCE_REQUIRED`, `INVALID_TRANSITION`, `FORBIDDEN`, `SHIFT_NOT_OPEN` |
| `payment.allocate` | `payment_id`, `[{invoice_id, amount}]` | phân bổ, số còn của từng phiếu | `OVER_ALLOCATION`, `VALIDATION_FAILED` |
| `payment.collectCash` (thao tác quầy, PLAN đợt 2 T-117) | `invoice_id`, `amount` | `payment_id`, `receipt_no`, `unallocated` — gộp `payment.record` (tiền mặt, ca mở) + `payment.confirm` + `payment.allocate` một phiếu trong một transaction, đi qua đúng ba hàm trên | như ba lệnh thành phần |
| `payment.reverse` | `payment_id`, lý do | `reversed`, bút toán đảo | `INVALID_TRANSITION`, `FORBIDDEN`, `PERIOD_LOCKED` |
| `payment.getTransferInfo` | `invoice_id` | tài khoản, số tiền còn, nội dung CK, QR | `NOT_FOUND` |
| `deposit.receive` | `lease_id`/`reservation_id`, số tiền, phương thức, chứng cứ | `deposit_id`, `payment_id` (`pending`; tiền mặt đi qua `payments`, INV-F3b) | `EVIDENCE_REQUIRED`, `SHIFT_NOT_OPEN` |
| `deposit.requestDeduction` / `deposit.approveDeduction` | cọc, phiếu, số tiền, lý do / `request_id` | bút toán khấu trừ | `REFUND_EXCEEDS_BALANCE`, `SELF_APPROVAL_FORBIDDEN`, `APPROVAL_LIMIT_EXCEEDED` |
| `deposit.requestRefund` / `deposit.approveRefund` | cọc, số tiền, phương thức, lý do / `request_id` | bút toán hoàn | như trên, thêm `SHIFT_NOT_OPEN` (hoàn tiền mặt) |
| `credit.requestRefund` / `credit.approveRefund` | `person_id` (chủ số dư `CUSTOMER_CREDIT`), số tiền, phương thức, lý do / `request_id` | bút toán Nợ `CUSTOMER_CREDIT` / Có `CASH`/`BANK`; hạn mức và cấm tự duyệt như mục 10 | `REFUND_EXCEEDS_BALANCE`, `SELF_APPROVAL_FORBIDDEN`, `APPROVAL_LIMIT_EXCEEDED`, `SHIFT_NOT_OPEN` |
| `shift.open` | `property_id`, `opening_cash` | `shift_id` (`open`) | `SHIFT_ALREADY_OPEN`, `VALIDATION_FAILED`, `FORBIDDEN` |
| `shift.close` | `shift_id`, `counted_cash` | `expected_cash`, chênh lệch, `shift_discrepancy_id?` | `SHIFT_HAS_PENDING_PAYMENTS`, `INVALID_TRANSITION`, `VALIDATION_FAILED`, `FORBIDDEN` |
| `shift.handover` | `shift_id`, người nhận, số tiền giao / (người nhận) số tiền nhận | `handed_over`, ca mới của người nhận | `SELF_APPROVAL_FORBIDDEN`, `INVALID_TRANSITION`, `FORBIDDEN` |
| `ledger.issueAdjustment` | phiếu gốc, số tiền ±, lý do | chứng từ điều chỉnh | `FORBIDDEN`, `SELF_APPROVAL_FORBIDDEN` |
| `ledger.lockPeriod` / `ledger.unlockPeriod` | `property_id`, ngày khoá, lý do (mở khoá: lý do bắt buộc) | `period_lock_id` | `FORBIDDEN`, `INVALID_TRANSITION`, `VALIDATION_FAILED` |
| `reconciliation.importStatement` | tài khoản, file CSV | số dòng mới/trùng/lỗi | `VALIDATION_FAILED`, `FILE_TOO_LARGE` |
| `reconciliation.previewMatches` / `reconciliation.confirmMatch` / `reconciliation.resolveBreak` | dòng sao kê, phiếu, ghi chú | gợi ý / thanh toán `confirmed` / break đóng | `OVER_ALLOCATION`, `INVALID_TRANSITION` |
| `POST /api/v1/webhooks/{provider}/{account}` (pilot: provider=`sim`) | payload + header chữ ký | 200 (`duplicate`?) | `WEBHOOK_SIGNATURE_INVALID`, `INBOX_HASH_MISMATCH` |
| `report.financialSummary`, `report.receivables`, `report.deposits`, `report.customerCredit` | cơ sở, kỳ | số tổng + chi tiết, xuất CSV | `FORBIDDEN` |

- Quyền chốt (khớp SPEC-access-and-property mục 5.3): `ledger.lockPeriod`/`billing.lockPeriod` — owner, manager, accountant; lễ tân chỉ `shift.close`/`shift.handover` **ca của mình**; `ledger.unlockPeriod` (`locked → issued`) — chỉ owner, có lý do + audit, và **không** cho sửa chứng từ đã phát hành.
- Mã tham chiếu CK: chuỗi chữ hoa + số, không chứa thông tin cá nhân; độ dài và định dạng QR theo chuẩn ngân hàng (chưa xác minh — làm ở T037).
- Xuất CSV dùng chung bộ chống formula injection của SPEC-audit-reporting (S-016); báo cáo chi tiết và quyền xuất ở SPEC-audit-reporting.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp | Scenario |
|---|---|---|---|---|
| `OVER_ALLOCATION` | Vượt số tiền thanh toán hoặc số còn của phiếu | 409 | Số phân bổ vượt số tiền còn lại. | S-004…S-006 |
| `EVIDENCE_REQUIRED` | Xác nhận không có chứng cứ | 422 | Cần đính kèm chứng cứ (sao kê/ảnh biên nhận) để xác nhận. | S-008 |
| `INVALID_TRANSITION` | Xác nhận 2 lần, đảo khi pending, đảo 2 lần | 409 | Không thể thực hiện với trạng thái hiện tại. | S-009, S-010 |
| `REFUND_EXCEEDS_BALANCE` | Hoàn/khấu trừ vượt số dư cọc hoặc `CUSTOMER_CREDIT` | 409 | Số tiền vượt số dư còn lại. | S-013, S-031 |
| `APPROVAL_LIMIT_EXCEEDED` | Vượt hạn mức vai trò | 403 | Số tiền vượt hạn mức duyệt của bạn. | S-014, S-033 |
| `SELF_APPROVAL_FORBIDDEN` | Tự duyệt; tự nhận bàn giao ca | 403 | Bạn không thể tự duyệt chứng từ mình lập. | S-012, S-031, S-033, S-035 |
| `PERIOD_LOCKED` | Ghi vào kỳ đã khoá | 409 | Kỳ đã khoá. Cần chứng từ điều chỉnh có duyệt. | S-022 |
| `WEBHOOK_SIGNATURE_INVALID` | Chữ ký sai | 401 | (không hiển thị cho người dùng) | S-017 |
| `INBOX_HASH_MISMATCH` | Trùng ID khác nội dung | 409 | (báo động nội bộ) | S-018 |
| `LEDGER_UNBALANCED` | Bút toán lệch (lỗi hệ thống) | 500 | Lỗi hệ thống khi ghi sổ. Thao tác chưa được lưu. | S-003 |
| `FILE_TOO_LARGE` | File sao kê vượt giới hạn | 413 | File quá lớn. | — |
| `BANK_TRANSACTION_ALREADY_USED` | Giao dịch ngân hàng (`bank_txn_ref`) đã gắn một payment (INV-F4b) | 409 | Giao dịch ngân hàng này đã được ghi nhận. | S-029 |
| `SHIFT_NOT_OPEN` | Thao tác tiền mặt khi người thực hiện không có ca đang mở | 409 | Cần mở ca trước khi nhận hoặc chi tiền mặt. | S-028 |
| `SHIFT_ALREADY_OPEN` | Mở ca khi đã có ca mở | 409 | Bạn đang có một ca đang mở. | S-034 |
| `SHIFT_HAS_PENDING_PAYMENTS` | Đóng ca khi còn tiền mặt `pending` | 409 | Còn khoản tiền mặt chưa xác nhận trong ca. | S-034 |
| `DOCUMENT_IMMUTABLE` | Sửa trực tiếp chứng từ đã phát hành (kể cả sau khi mở khoá kỳ) | 409 | Chứng từ đã phát hành, không sửa trực tiếp. Hãy tạo điều chỉnh. | S-023 |
| `FORBIDDEN` / `NOT_FOUND` / `VALIDATION_FAILED` / `IDEMPOTENCY_CONFLICT` | dùng chung | 403/404/422 | như các SPEC khác | S-023, S-025, S-026, S-028 |

**Lý do break không phải mã lỗi API.** `HASH_MISMATCH`, `THIRD_PARTY_PAYER`, `WRONG_REFERENCE` (cùng `COMBINED`, `OVERPAID`, `UNMATCHED`) là giá trị của `reconciliation_breaks.reason`, hiển thị trong hàng chờ đối soát; chúng **không** xuất hiện trong `problem+json` và không có HTTP riêng. Mã lỗi API tương ứng chỉ là `INBOX_HASH_MISMATCH` (S-018).

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
- `payment.recorded`, `payment.confirmed`, `payment.allocated`, `deposit.refunded`, `reconciliation_break.created/resolved` → M-04; `period.locked`, `period.unlocked`; `credit.refunded`; `shift.opened`, `shift.closed`, `shift.handed_over`, `shift_discrepancy.created/resolved`.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [x] Hạn mức duyệt hoàn/khấu trừ/điều chỉnh theo vai trò — [chặn] — hỏi: PO. **Chỗ duy nhất quyết hạn mức; SPEC khác (lease, access…) tham chiếu mục này.** Hạn mức = trần số tiền một vai trò được **duyệt** mỗi lần (yêu cầu do người khác lập); vượt → `APPROVAL_LIMIT_EXCEEDED`. **Đề xuất (chờ PO):** — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** như đề xuất (front_desk ≤ 2.000.000 đ chỉ cọc khách sạn lúc check-out; manager ≤ 5.000.000 đ; owner không giới hạn; accountant chỉ lập đề nghị; cấm tự duyệt). Mặc định theo vai trò ở `organizations.settings.role_limits`, ghi đè ở `memberships.limits` (ERD 7.1 #9).
  - `front_desk`: hoàn/khấu trừ **cọc khách sạn** (và hoàn ứng trước, khớp ma trận access) ≤ 2.000.000 đ/lần, chỉ khi check-out; ngoài phạm vi đó (cọc trọ, điều chỉnh) chỉ lập yêu cầu.
  - `manager`: ≤ 5.000.000 đ/lần.
  - `owner`: không giới hạn.
  - `accountant`: lập đề nghị, **không duyệt**.
  - Mọi vai trò: cấm tự duyệt (`SELF_APPROVAL_FORBIDDEN`). Cơ sở chỉnh số qua `memberships.limits`.
- [x] Ma trận SPEC-access-and-property mục 5.3 ghi `front_desk` **HM (≤ 2.000.000 đ/lần, chỉ khi check-out)** cho hoàn/khấu trừ cọc và hoàn ứng trước: trong hạn mức, lễ tân có tự thực hiện không (ca đêm chỉ có 1 lễ tân)? — [chặn] — hỏi: PO. **Đề xuất (đã ghi vào INV-F5, DOMAIN-MODEL 1.2):** hoàn **nguyên số** cọc khách sạn, không khấu trừ, lúc check-out, trong hạn mức → lễ tân làm một bước (khớp SPEC-reservation-stay S-027a; ca đêm một người vẫn trả phòng được). Khấu trừ cọc, hoàn ứng trước và hoàn vượt hạn mức → luôn cần người thứ hai (S-033). — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** như đề xuất: hoàn nguyên số cọc khách sạn lúc check-out trong hạn mức → lễ tân một bước; khấu trừ, hoàn ứng trước, vượt hạn mức → luôn cần người thứ hai.
- [x] Chứng cứ cho **tiền mặt** theo INV-F3 (INV-F3b) — [chặn] — hỏi: PO + kế toán. **Đề xuất (chờ PO):** mọi tiền mặt, kể cả cọc, đi qua `payments` `pending → confirmed`; lễ tân xác nhận tiền mặt do chính mình nhận trong ca đang mở, biên nhận do hệ thống sinh (ảnh chữ ký tuỳ chọn); chênh lệch xử lý ở đóng ca (mục "Ca quầy tối thiểu"). — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** như đề xuất (mọi tiền mặt qua `payments` `pending → confirmed`, người nhận xác nhận trong ca mở của mình, biên nhận hệ thống sinh, chênh lệch xử lý khi đóng ca).
- [x] Quy tắc hoàn `CUSTOMER_CREDIT` (ứng trước, trả thừa) — [chặn pilot] — hỏi: PO + kế toán. Bút toán đã có ở DOMAIN-MODEL v1.2 §5; còn hỏi: có buộc bù trừ vào phiếu còn nợ của người đó trước khi hoàn không; hoàn tiền mặt hay chuyển khoản; thời hạn giữ số dư. **Đề xuất:** không buộc bù trừ nếu khách không còn nợ; hoàn qua `credit.requestRefund`/`credit.approveRefund` cùng hạn mức ở trên. — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** không buộc bù trừ khi không còn nợ; còn nợ thì UI gợi ý bù trừ trước; hoàn qua `credit.requestRefund`/`credit.approveRefund` cùng hạn mức; hoàn tiền mặt hoặc chuyển khoản theo lựa chọn khi duyệt; chưa đặt thời hạn giữ số dư (xem lại sau pilot).
- [x] Làm tròn (1 đ/1.000 đ, dòng/tổng) — [chặn] — hỏi: PO + kế toán. **Đề xuất:** theo SPEC-metering-billing mục 10 (`HALF_UP_1` từng dòng). — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** theo SPEC-metering-billing mục 10 (`HALF_UP_1` từng dòng, tham số theo cơ sở).
- [ ] Ghi nhận doanh thu — [không chặn pilot] — hỏi: kế toán. **Đề xuất:** khi phát hành phiếu.
- [ ] Webhook: tự phân bổ khi mã tham chiếu khớp và số tiền ≤ số còn — [không chặn] — hỏi: PO. **Đề xuất:** có; phần thừa vào `CUSTOMER_CREDIT`; không khớp → hàng chờ.
- [ ] Định dạng CSV sao kê của các ngân hàng pilot — [không chặn] — hỏi: đại diện pilot. **Đề xuất:** ánh xạ cột cấu hình theo tài khoản nhận.
- [ ] `payments` chuyển khoản ở trạng thái `pending` (tạo từ claim, chưa có dòng sao kê) có được để trống `bank_transaction_id` đến lúc xác nhận không (INV-F4b nói "phải tham chiếu") — [không chặn] — hỏi: Tech Lead. **Đề xuất:** được; ràng buộc kiểm lúc `confirmed`.
- [ ] Ngưỡng/giờ đóng ca bắt buộc (ca quên đóng qua ngày) — [không chặn pilot] — hỏi: PO. **Đề xuất:** nhắc đóng ca khi qua `business_date`; quản lý đóng thay có audit; ca quầy đầy đủ ở F-013.
- [x] Bổ sung `approval_requests`, `reconciliation_breaks`, `bank_transactions`, `shifts`, `shift_discrepancies` vào DOMAIN-MODEL — [chặn migration] — hỏi: Tech Lead. Đã bổ sung DOMAIN-MODEL v1.2 (§1, §7). — **Đóng 2026-10-15:** đã có trong DOMAIN-MODEL v1.2 (G4, sửa sau review độc lập); không cần quyết định riêng.
- [x] Hoàn tiền thừa từ `CUSTOMER_CREDIT` (Nợ `CUSTOMER_CREDIT` / Có `CASH`/`BANK`) chưa có trong bảng bút toán — Đã bổ sung DOMAIN-MODEL v1.2 §5; phần quy tắc còn lại ở câu hỏi [chặn pilot] phía trên. — **Đóng 2026-10-15:** đã có trong DOMAIN-MODEL v1.2 (G4, sửa sau review độc lập); không cần quyết định riêng.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu [chặn] · DOMAIN-MODEL v1.2 đã bổ sung mọi tên bảng · SPEC-metering-billing Approved.
- DoD: mọi S-NNN có test; INV-F1…F6, INV-F3b, INV-F4b chạy trên Postgres thật · E2E R-001 phần thu · sự kiện đo có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T033 Sổ bất biến, mã chứng từ | — | S-003, S-010 |
| T034 Phiếu nội bộ | — | S-001, S-002, S-022 |
| T035 Thu một phần, phân bổ nhiều phiếu | — | S-001, S-004…S-007, S-025, S-027, S-028 |
| T036 Sổ cọc, hoàn, duyệt | — | S-011…S-014, S-031, S-033 |
| T037 QR + mã tham chiếu | — | S-015 |
| T038 Đối soát thủ công | — | S-016…S-021, S-029, S-030 |
| T039 Báo cáo | — | S-024 |
| T040 Chốt kỳ, test toàn luồng | — | S-022, S-023, S-026, S-032 |
| Ca quầy tối thiểu (task chưa gán — đề xuất thêm vào backlog) | — | S-034, S-035 |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | Tạo | G3 cho F-005 | (chưa) |
| 2 | 2026-10-15 | Sửa theo review độc lập: tiền mặt qua `payments` (INV-F3b, R4); `bank_transactions` + INV-F4b (R5); hoàn `CUSTOMER_CREDIT` (R6); chốt kỳ/mở khoá (O4); ca quầy tối thiểu (O9); hạn mức một chỗ (O11); lý do break ≠ mã lỗi (G1); đường webhook (G9); S-016 (G11); đóng câu hỏi bảng (G5) | Review độc lập; DOMAIN-MODEL v1.2 | (chưa) |
