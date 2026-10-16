# SPEC-notifications — Thông báo trong app, email qua outbox và nhắc hạn

| Trường | Giá trị |
|---|---|
| ID tính năng | F-011 (yêu cầu gốc: R-001 "người thuê xem trên portal", R-002 "gia hạn"; kế hoạch §11, §14, §15; backlog T015, T046, T047, phần nhắc của T031) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) ngày (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Ngày | 2026-10-15 |
| Phụ thuộc | DOMAIN-MODEL INV-G6 (audit + outbox cùng transaction), ADR-0001 (pg-boss 12.x), ARCHITECTURE (luồng worker), SPEC-ledger-payments (số dư phiếu), SPEC-lease (ngày hết hạn), SPEC-reservation-stay (`residence_notices`, `stay.exportResidenceNotice`, `stay.markNoticeSubmitted`), SPEC-portal |

## 1. User story
- Là **người thuê**, tôi muốn nhận thông báo khi có phiếu mới và khi phiếu quá hạn, để trả đúng hạn — và không bị nhắc khi đã trả xong.
- Là **quản lý/lễ tân**, tôi muốn được nhắc hợp đồng sắp hết hạn và hạn thông báo lưu trú, để không lỡ việc phải làm.
- Là **chủ cơ sở**, tôi muốn xem lịch sử gửi trung thực (đang chờ, đã chuyển cho nhà cung cấp, thất bại), để biết ai chưa nhận được.

Ngoài phạm vi pilot: Web Push, SMS, Zalo (PROJECT §3 "Không làm"), tự nộp thông báo lưu trú cho cơ quan nhà nước.

## 2. Tiêu chí chấp nhận (Given/When/Then)
Bối cảnh chung: tổ chức B, cơ sở `HS1` (múi giờ `Asia/Ho_Chi_Minh`), người thuê An (đã đồng ý nhận email nhắc). Email dùng **bản giả** `FakeEmailSender` ghi vào thư mục/bộ nhớ test.

### S-001 Phát hành phiếu → thông báo trong app + email
- Given kỳ thu 10/2026 phát hành phiếu cho An; transaction ghi `outbox` sự kiện `invoice.issued`
- When worker chạy `outbox.relay` rồi `notify.dispatch`
- Then tạo 1 `notifications` trong app cho An và 1 `notification_deliveries` kênh email trạng thái `queued → sending → sent`; `FakeEmailSender` nhận đúng 1 email mẫu `invoice_issued`

### S-002 Outbox chỉ phát sau commit
- Given command phát hành phiếu bị rollback (lỗi sau khi ghi outbox, trước COMMIT)
- When worker chạy
- Then không có `notifications` hay email nào

### S-003 Dedupe khi sự kiện xử lý hai lần
- Given sự kiện `invoice.issued` id `ev1` được pg-boss giao 2 lần (mô phỏng worker chết sau khi gửi, trước khi ack)
- When worker xử lý lần 2
- Then vẫn 1 `notifications` và 1 delivery email (unique `dedupe_key`); `FakeEmailSender` nhận 1 lần (adapter truyền `idempotency_key` = `delivery_id`)

### S-004 Retry có backoff rồi dead letter
- Given `FakeEmailSender` cấu hình trả lỗi tạm thời (5xx/timeout) mọi lần
- When worker xử lý delivery
- Then delivery qua `retrying` với `attempts` = 1…5 và khoảng chờ tăng dần (đề xuất 1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ — Q-05); sau lần 5 → `dead`; có cảnh báo vận hành (metric `notification_dead_total` tăng 1); thông báo trong app vẫn còn

### S-005 Lỗi vĩnh viễn không retry
- Given nhà cung cấp trả lỗi vĩnh viễn (địa chỉ không hợp lệ)
- When worker gửi
- Then delivery → `failed` ngay, `attempts=1`, `last_error_code=RECIPIENT_INVALID`; không retry

### S-006 Giao diện không báo "đã gửi" khi mới xếp hàng
- Given delivery ở `queued`
- When quản lý mở lịch sử gửi của An
- Then nhãn là "Đang chờ gửi"; chỉ khi `sent` mới hiện "Đã chuyển cho nhà cung cấp email" (không dùng "Đã nhận"); `dead`/`failed` hiện "Gửi thất bại — cần xử lý"

### S-007 Nhắc quá hạn
- Given phiếu 10/2026 của An hạn 2026-10-10, còn nợ 1.580.000; lịch nhắc ngày +1 sau hạn
- When job `reminder.scanOverdue` chạy ngày 2026-10-11 lúc 08:00 giờ cơ sở
- Then tạo 1 thông báo `invoice_overdue` cho An (trong app + email nếu đồng ý); `dedupe_key = invoice_overdue:{invoice_id}:2026-10-11`

### S-008 Không nhắc phiếu đã tất toán
- Given phiếu đã được phân bổ đủ (`balance=0`) **sau khi** nhắc đã được xếp hàng nhưng trước khi gửi
- When worker xử lý delivery
- Then worker đọc lại số dư trong transaction; delivery → `suppressed` lý do `SETTLED`; không có email; job quét ngày sau không tạo nhắc mới

### S-009 Opt-out theo loại
- Given An tắt email cho loại `invoice_overdue` nhưng giữ `invoice_issued`
- When có cả phiếu mới và nhắc quá hạn
- Then email `invoice_issued` được gửi; email `invoice_overdue` → `suppressed` lý do `OPTED_OUT`; thông báo trong app vẫn tạo cho cả hai

### S-010 Huỷ đăng ký từ email
- Given email nhắc có liên kết huỷ đăng ký ký số (token có hạn)
- When An mở liên kết (không cần đăng nhập)
- Then lựa chọn email cho đúng loại đó chuyển `opted_out`; trang xác nhận "Bạn sẽ không nhận email nhắc quá hạn từ Nhà trọ Hoa Sen nữa"; audit `notification.preference_changed`; token dùng lại → kết quả như cũ; token hết hạn → 410 `LINK_EXPIRED`

### S-011 Loại bắt buộc không cho tắt
- Given loại `account_security` (lời mời, đăng nhập) là bắt buộc
- When An gọi `notifications.updatePreferences` tắt loại đó
- Then HTTP 422 `PREFERENCE_REQUIRED`; lựa chọn không đổi

### S-012 Nội dung không chứa PII nhạy cảm
- Given mọi mẫu email/thông báo trong app
- When chạy test quét nội dung render với dữ liệu giả có CCCD `012345678901`, SĐT, số tài khoản
- Then không mẫu nào chứa số CCCD/hộ chiếu, ảnh giấy tờ, SĐT đầy đủ, nội dung hợp đồng; email nhắc chỉ có tên cơ sở, kỳ thu, hạn và liên kết tới portal yêu cầu đăng nhập (số tiền theo Q-03); log worker không chứa địa chỉ email đầy đủ (che dạng `a***@example.com`)

### S-013 Nhắc hợp đồng sắp hết hạn, không lặp
- Given hợp đồng của An `active`, kết thúc 2026-11-30; mốc nhắc 30 ngày trước (Q-06)
- When job `reminder.scanLeaseExpiry` chạy ngày 2026-10-31 hai lần (chạy lại sau sự cố)
- Then quản lý cơ sở `HS1` nhận đúng 1 thông báo `lease_expiring` (dedupe theo `lease_id` + mốc); nếu đã gia hạn (phiên bản mới có ngày kết thúc mới) thì không nhắc theo ngày cũ

### S-014 Nhắc hạn thông báo lưu trú — khách đến trước 23 giờ
- Given cơ sở cấu hình hạn thông báo lưu trú "trước 23:00 ngày bắt đầu; đến sau 23:00 thì trước 08:00 hôm sau" (giá trị cấu hình, nguồn [T] chưa đối chiếu bản gốc); khách check-in lúc 2026-10-15 20:10 giờ cơ sở
- When job `reminder.scanStayNotice` chạy
- Then lễ tân/quản lý `HS1` nhận thông báo trong app `stay_notice_due` "Phòng 203: cần thông báo lưu trú trước 23:00 15/10/2026" kèm liên kết tới `stay.exportResidenceNotice` (SPEC-reservation-stay, nguồn dữ liệu là `residence_notices` trạng thái `pending`/`exported`); hệ thống **không** gửi gì tới cơ quan nhà nước

### S-015 Nhắc hạn lưu trú — khách đến sau 23 giờ và khách nước ngoài
- Examples:

| Check-in (giờ cơ sở) | Loại khách | Hạn hiển thị |
|---|---|---|
| 2026-10-15 23:40 | trong nước | trước 08:00 16/10/2026 |
| 2026-10-15 14:00 | nước ngoài, cấu hình 12 giờ | trước 02:00 16/10/2026 |

- Then hạn tính theo `properties.timezone`, lưu UTC

### S-016 Dừng nhắc khi đã đánh dấu nộp
- Given nhân viên đã gọi `stay.markNoticeSubmitted` (người gửi, thời điểm, kênh, file bằng chứng tuỳ chọn — SPEC-reservation-stay) → `residence_notices.status='submitted'` trước hạn
- When job quét lần kế tiếp
- Then không tạo nhắc mới; nếu chưa đánh dấu khi còn 30 phút đến hạn (đề xuất) → nhắc lần 2 mức "Khẩn"

### S-017 Người nhận chỉ xem thông báo của mình
- Given thông báo `n_B` thuộc Bình
- When An gọi `notifications.markRead(n_B)`
- Then HTTP 404 `NOT_FOUND`; trạng thái `n_B` không đổi

### S-018 Lịch sử gửi theo quyền
- Given vai trò `housekeeping`
- When gọi `notifications.listDeliveries`
- Then HTTP 403 `FORBIDDEN`; `manager` chỉ thấy delivery của cơ sở trong phạm vi; `owner` thấy toàn tổ chức

### S-019 Gửi lại thủ công delivery `dead`
- Given delivery `dead` và quản lý có quyền
- When quản lý bấm "Gửi lại" (`notifications.retryDelivery`, có `Idempotency-Key`)
- Then delivery về `queued`, `attempts` đặt lại, audit ghi người thao tác; bấm lại cùng key không tạo lần thứ hai

### S-020 Chưa cấu hình hạn thông báo lưu trú
- Given `notification_settings` của cơ sở `HS1` chưa có hạn thông báo lưu trú (không có mặc định cứng — Q-08); khách check-in
- When job `reminder.scanStayNotice` chạy
- Then không tính `due_at` và không tạo nhắc `stay_notice_due`; `residence_notices` vẫn được tạo `pending` để xuất mẫu/đánh dấu được; owner/manager thấy một cảnh báo cấu hình trong app "Chưa cấu hình hạn thông báo lưu trú" (dedupe theo cơ sở, mỗi ngày tối đa 1 lần)

### S-021 Quá hạn mà chưa đánh dấu đã thông báo
- Given `residence_notices` của phòng 203 có `due_at` đã qua, `status` còn `pending`/`exported`
- When job `reminder.scanStayNotice` chạy lần kế tiếp (và các lần sau trong ngày)
- Then tạo đúng 1 thông báo `stay_notice_due` mức "Quá hạn" cho lễ tân/quản lý `HS1` mỗi `business_date` (`dedupe_key = stay_notice_overdue:{notice_id}:{business_date}`); khi `stay.markNoticeSubmitted` được gọi (kể cả sau hạn) thì ngừng nhắc; hạn lưu bản ghi quá hạn để báo cáo

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Người nhận không có email; mẫu thiếu biến | Chỉ tạo thông báo trong app, delivery email `suppressed` lý do `NO_ADDRESS`; thiếu biến → lỗi render, delivery `failed` `TEMPLATE_ERROR`, không gửi email rỗng | S-005 |
| Cực đại/độ dài | Kỳ thu 100 phòng phát hành cùng lúc; quét 5.000 phòng | Gửi theo lô, rate limit theo tổ chức (đề xuất 10 email/giây, Q-05); không chặn transaction nghiệp vụ | S-001 |
| Trùng lặp/idempotency | Sự kiện giao lại, job quét chạy lại, bấm gửi lại | `dedupe_key` unique; adapter nhận `idempotency_key` | S-003, S-013, S-019 |
| Song song | Thanh toán được phân bổ đúng lúc nhắc đang gửi | Kiểm lại số dư khi gửi → `suppressed` `SETTLED` | S-008 |
| Mất mạng giữa chừng | Nhà cung cấp timeout; worker chết giữa chừng | Retry backoff; trạng thái `sending` quá hạn khoá → trả về `retrying` | S-003, S-004 |
| Thời gian/múi giờ | Hạn 23:00/08:00, nhắc theo ngày địa phương, đổi ngày lúc nửa đêm; hạn thông báo lưu trú chưa cấu hình; quá hạn | Tính theo `properties.timezone`; lưu UTC; giờ gửi nhắc nợ trong khung cấu hình (đề xuất 08:00–20:00); chưa cấu hình → không nhắc, có cảnh báo cấu hình | S-007, S-014, S-015, S-020, S-021 |
| Quyền | Người nhận khác, vai trò không có quyền xem lịch sử, huỷ đăng ký không đăng nhập | 404/403; token huỷ đăng ký chỉ đổi đúng một loại của đúng người | S-010, S-017, S-018 |
| Tiền/đơn vị | Số tiền trong nội dung (nếu Q-03 cho phép) | Lấy từ sổ tại thời điểm render, VND số nguyên, định dạng `1.580.000 đ` | S-008 |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `outbox` (có sẵn, INV-G6) | `id`, `organization_id`, `event_type`, `payload` (chỉ id, không PII), `created_at`, `published_at` | | Ghi cùng transaction nghiệp vụ | Command ghi; worker đọc |
| `notifications` (**mới**) | `organization_id`, `property_id`, `recipient_person_id`, `type`, `title`, `body`, `link`, `dedupe_key`, `read_at`, `created_at` | | unique `(organization_id, dedupe_key, recipient_person_id)` | Worker ghi; người nhận đọc/đánh dấu đã đọc |
| `notification_deliveries` (**mới**) | `notification_id`, `channel` (`email`), `status` (`queued → sending → sent`; `retrying`; `failed`; `dead`; `suppressed`), `suppressed_reason`, `attempts`, `next_attempt_at`, `provider_message_id`, `last_error_code` | | unique `(notification_id, channel)` | Worker ghi; quản lý/owner đọc |
| `notification_preferences` (**mới**) | `organization_id`, `person_id`, `type`, `channel`, `state` (`opted_in`/`opted_out`), `changed_at`, `source` | | Loại bắt buộc không có hàng `opted_out` | Người dùng ghi của mình; audit |
| `residence_notices` (SPEC-reservation-stay, chỉ đọc ở đây) | `stay_id`, `status` (`pending`/`exported`/`submitted`), `due_at`, `is_foreign` | | Job `reminder.scanStayNotice` đọc theo `organization_id`; không ghi | Worker đọc |
| `notification_settings` (**mới**, theo cơ sở) | lịch nhắc quá hạn, mốc nhắc hết hạn hợp đồng, hạn thông báo lưu trú (giờ, số giờ cho khách nước ngoài), khung giờ gửi | | Có `updated_by`, audit | Owner/manager ghi |

- Loại thông báo pilot: `account_security` (bắt buộc), `invoice_issued`, `invoice_overdue`, `lease_expiring`, `stay_notice_due` (nhân viên, bắt buộc trong app), `maintenance_status` (người thuê), `export_ready` (SPEC-audit-reporting).
- Bốn bảng thông báo đã có trong DOMAIN-MODEL §7 (v1.2; Q-07 đã đóng); `residence_notices` thuộc DOMAIN-MODEL §7 nhóm Vận hành. Migration ở T046 (rollback được).

## 5. Giao diện / API
| Loại | Tên | Mô tả |
|---|---|---|
| Query | `notifications.listMine` | Thông báo trong app của người dùng, phân trang, đếm chưa đọc |
| Command | `notifications.markRead` / `notifications.markAllRead` | |
| Query/Command | `notifications.getPreferences` / `notifications.updatePreferences` | Theo loại × kênh |
| Command | `notifications.unsubscribe` | Token từ email, không cần đăng nhập |
| Query | `notifications.listDeliveries` | Lịch sử gửi (quản lý/owner), lọc người nhận, loại, trạng thái |
| Command | `notifications.retryDelivery` | Gửi lại delivery `dead`/`failed` |
| Command | `notifications.updateSettings` | Cấu hình lịch nhắc của cơ sở |
| Job | `outbox.relay`, `notify.dispatch`, `notify.sendEmail`, `reminder.scanOverdue` (hằng ngày), `reminder.scanLeaseExpiry` (hằng ngày), `reminder.scanStayNotice` (định kỳ, đề xuất 15 phút) | pg-boss |

- Adapter: `EmailSender.send({to, template, vars, idempotencyKey}) → {providerMessageId}`, phân loại lỗi `TEMPORARY`/`PERMANENT`. Bản giả `FakeEmailSender` cho dev/CI (ghi file/bộ nhớ, cấu hình được lỗi); bản thật chọn sau (Q-01). Secret phía server.
- Trạng thái UI: chuông có số chưa đọc · đang tải: khung xương · rỗng: "Chưa có thông báo" · lỗi: thông điệp theo mã + "Thử lại" · lịch sử gửi: nhãn chữ + icon cho từng trạng thái (S-006).
- Tiếp cận: số chưa đọc có `aria-label` "3 thông báo chưa đọc"; thông báo mới đọc qua `aria-live="polite"`; trang tuỳ chọn dùng checkbox có nhãn; email có phiên bản văn bản thuần, ngôn ngữ `vi`.

- Ghi chú triển khai (T-207, đợt 3): job `reminder.scanStayNotice` chạy hai bước — cảnh báo chưa cấu hình hạn (S-020) và `scanResidenceNotices` đọc `residence_notices` qua `app.residence_notices_due`, phát outbox `stay_notice.reminder {notice_id, phase, business_date}` với `phase`: `due` (nhắc đầu, S-014/S-015) → `urgent` ("Khẩn", còn ≤ 30 phút, S-016) → `overdue` ("Quá hạn", `dedupe_key = stay_notice_overdue:{notice_id}:{business_date}` ở thông báo, S-021). Mỗi lượt quét một giai đoạn mới nhất cho mỗi thông báo (không dồn). Dừng khi `submitted` (SQL không chọn + mapper kiểm lại). Người nhận: owner/manager/lễ tân trong phạm vi cơ sở; chỉ trong app (D-010), không email.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| `NOT_FOUND` | Thông báo/delivery không thuộc phạm vi người dùng; token huỷ đăng ký sai chữ ký hoặc bị sửa (không phân biệt lý do) | 404 | Không tìm thấy dữ liệu. | S-017 |
| `FORBIDDEN` | Không có quyền xem lịch sử/cấu hình | 403 | Bạn không có quyền thực hiện thao tác này. | S-018 |
| `VALIDATION_FAILED` | Cấu hình sai (giờ không hợp lệ, mốc âm) | 422 | Thông tin chưa hợp lệ: {trường}. | — |
| `PREFERENCE_REQUIRED` | Tắt loại bắt buộc | 422 | Loại thông báo này cần thiết cho tài khoản và không tắt được. | S-011 |
| `LINK_EXPIRED` | Token huỷ đăng ký hết hạn | 410 | Liên kết đã hết hạn. Vui lòng đổi tuỳ chọn trong mục Tài khoản. | S-010 |
| `DELIVERY_NOT_RETRYABLE` | Gửi lại delivery `sent`/`suppressed` | 409 | Thông báo này không cần gửi lại. | S-019 |
| `IDEMPOTENCY_CONFLICT` | Cùng key khác thân | 409 | Yêu cầu bị trùng mã thao tác. Vui lòng tải lại. | — |
| Mã nội bộ delivery | `RECIPIENT_INVALID`, `PROVIDER_TEMPORARY`, `TEMPLATE_ERROR`, `RATE_LIMITED` | — | Hiện trong lịch sử gửi dạng chữ: "Địa chỉ email không hợp lệ", "Nhà cung cấp tạm lỗi — đang thử lại"… | S-004, S-005 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Không chặn nghiệp vụ | Gửi thất bại không làm rollback/mất chứng từ | kế hoạch §11 | test S-002, S-004 |
| Độ trễ outbox | Theo dõi p95 thời gian `created_at → sent` (ngưỡng chốt sau T079) | ARCHITECTURE "Quan sát" | metric |
| Dead letter | Mỗi delivery `dead` sinh cảnh báo | kế hoạch §14 | metric + cảnh báo |
| PII | 0 PII nhạy cảm trong nội dung và log | kế hoạch §15, §16 | test S-012 + quét log |
| Cách ly | Job quét chỉ đọc dữ liệu theo từng `organization_id` | kế hoạch §16 | test chéo tenant trên worker |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `notification.created`, `notification.delivery_status_changed` (thuộc tính `status`, `type`, không PII), `notification.opted_out`, `reminder.suppressed_settled` → M-05 (dùng hằng tuần); tỷ lệ `dead` theo nhà cung cấp làm đầu vào chọn nhà cung cấp.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 Nhà cung cấp email transactional (vùng dữ liệu, giá, hợp đồng xử lý dữ liệu, webhook bounce) — [không chặn spec/dev nhờ adapter + bản giả; **chặn pilot với người dùng thật**] — hỏi: chủ dự án + pháp lý — **đề xuất:** dùng `/research` so 2–3 nhà cung cấp có DPA và webhook ký số, chốt bằng ADR trước tuần 8 (T046).
- [ ] Q-02 Có cần email "đã nhận" (delivered/bounce) hay chỉ "đã chuyển cho nhà cung cấp"? — [không chặn] — hỏi: PO — **đề xuất:** pilot chỉ `sent`; bounce cứng → tự đặt `suppressed` cho email đó khi nhà cung cấp hỗ trợ webhook.
- [ ] Q-03 Email nhắc có được ghi số tiền không? — [không chặn] — hỏi: pháp lý — **đề xuất:** pilot không ghi số tiền trong email, chỉ kỳ thu + hạn + liên kết portal; thông báo trong app (đã đăng nhập) hiển thị đủ.
- [ ] Q-04 Lịch nhắc quá hạn mặc định — [không chặn] — hỏi: PO (quan sát T001) — **đề xuất:** +1, +3, +7 ngày sau hạn, cấu hình theo cơ sở, tối đa 1 nhắc/phiếu/ngày.
- [ ] Q-05 Tham số retry và rate limit — [không chặn] — hỏi: Tech Lead — **đề xuất:** 5 lần (1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ); 10 email/giây/tổ chức; chỉnh theo giới hạn nhà cung cấp.
- [ ] Q-06 Mốc nhắc hết hạn hợp đồng — [không chặn] — hỏi: PO — **đề xuất:** 30 và 7 ngày trước ngày kết thúc, gửi cho quản lý; người thuê nhận bản ngắn cùng mốc.
- [x] Q-07 Bổ sung `notifications`, `notification_deliveries`, `notification_preferences`, `notification_settings` vào DOMAIN-MODEL — đã đóng: có ở DOMAIN-MODEL §7 (v1.2).
- [ ] Q-08 Hạn thông báo lưu trú (23:00/08:00; 12 giờ cho khách nước ngoài) mới có nguồn thứ cấp [T] — [không chặn vì là cấu hình; chặn dùng làm giá trị mặc định khi pilot] — hỏi: pháp lý — **đề xuất:** để trống mặc định, cơ sở tự nhập khi onboarding cho tới khi pháp lý đối chiếu bản gốc.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · outbox/pg-boss từ T015 sẵn sàng · mỗi task có Gate.
- DoD: mọi S-NNN có test xanh (S-002/S-003/S-008 chạy trên Postgres thật + pg-boss) · ca biên có test · không PII trong log/fixture · cổng commit/merge xanh · sự kiện có schema · blueprint tick có bằng chứng.

## 12. Truy vết
| Task | PR | Bằng chứng (CI/evidence) |
|---|---|---|
| T015 (outbox, worker, retry, idempotency) | — | — |
| T046 (thông báo trong app và email) | — | — |
| T047 (lựa chọn thông báo, nhắc quá hạn) | — | — |
| T031 (phần nhắc hết hạn hợp đồng) | — | — |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-011 | (chưa) |
| 2 | 2026-10-15 | sửa theo review độc lập: tham chiếu đúng `stay.exportResidenceNotice`/`stay.markNoticeSubmitted` và bảng `residence_notices` (S-014, S-016); thêm S-020 (chưa cấu hình hạn), S-021 (quá hạn); đóng Q-07 | review O8, G5 | (chưa) |
| 3 | 2026-10-16 | ghi quyết định khi cài T-211 (chờ phiên chính duyệt, D-NNN): (a) retry = 1 lần gửi đầu + 5 lần thử lại (chờ 1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ), lần thứ 6 lỗi tạm → `dead` (`attempts` 1…5 ở `retrying` — S-004); (b) chưa có hàng `notification_preferences` = `opted_in` (thông báo giao dịch); (c) `stay_notice_due` chỉ trong app (không delivery email); (d) `notifications.params` (jsonb không PII) để dựng email tối thiểu; (e) `notifications.unsubscribe` là `GET /api/v1/notifications/unsubscribe?token=` (liên kết trong email; POST bị chặn bởi kiểm same-origin của proxy); (f) `listDeliveries` chỉ `owner`/`manager`; (g) chưa giới hạn tốc độ 10 email/giây/tổ chức (mới giới hạn lô mỗi lượt) | cài đặt T-211 | (chưa) |
