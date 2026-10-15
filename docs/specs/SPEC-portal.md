# SPEC-portal — Portal người thuê và khách lưu trú

| Trường | Giá trị |
|---|---|
| ID tính năng | F-008 (yêu cầu gốc: R-001 bước "người thuê xem trên portal"; kế hoạch §03, §08, §09; backlog T044, phần portal của T045) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) ngày (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Ngày | 2026-10-15 |
| Phụ thuộc | SPEC-access-and-property (vai trò `tenant`/`guest`, ma trận quyền), SPEC-lease, SPEC-metering-billing, SPEC-ledger-payments (QR, mã tham chiếu T037), SPEC-reservation-stay (folio), SPEC-housekeeping-maintenance (phiếu việc), SPEC-pwa, SPEC-notifications |

## 1. User story
- Là **người thuê**, tôi muốn xem kỳ thu, phiếu tính tiền, hợp đồng, cọc và chỉ số công tơ của mình, gửi yêu cầu sửa chữa và theo dõi tiến độ, để không phải hỏi chủ trọ qua Zalo và biết chính xác mình còn nợ bao nhiêu.
- Là **khách lưu trú**, tôi muốn mở một liên kết có hạn để xem lượt ở và folio của mình, để kiểm tra khoản phí trước khi trả phòng.
- Là **chủ cơ sở**, tôi muốn mời người thuê vào portal miễn phí trong gói của tôi, để giảm việc trả lời từng người mà không lộ dữ liệu của người khác.

Ngoài phạm vi: thanh toán online xác nhận tự động (webhook — F-016), ký điện tử, chat, tự sửa thông tin hợp đồng, người ở cùng xem khoản tiền (xem Q-05).

## 2. Tiêu chí chấp nhận (Given/When/Then)
Dữ liệu mẫu dùng chung (theo DOMAIN-MODEL §5): tổ chức **B** "Nhà trọ Hoa Sen", cơ sở `HS1`, phòng `101` (người thuê **An**) và `102` (người thuê **Bình**). Phiếu kỳ 10/2026 phòng 101: tổng **3.580.000**, đã phân bổ **2.000.000**, còn **1.580.000**; cọc **3.000.000**. Lỗi trả về `application/problem+json` có trường `code`.

### S-001 Người thuê xem danh sách kỳ thu của mình
- Given An đã đăng nhập portal của tổ chức B, có phiếu 10/2026 đã phát hành (kỳ thu 10/2026 `issued`) và kỳ thu 11/2026 còn `draft` (phiếu chỉ được sinh khi phát hành, nên kỳ `draft` **chưa có** `invoices` nào)
- When An mở "Kỳ thu"
- Then `portal.listMyInvoices` trả đúng 1 phiếu (10/2026) với `total=3580000`, `paid=2000000`, `balance=1580000`; truy vấn lọc theo trạng thái kỳ thu (`billing_periods.status` ∈ `issued`, `locked`) nên kỳ 11/2026 `draft`/`reviewing` không xuất hiện dù đã có số liệu tạm; UI hiển thị "1.580.000 đ" và nhãn "Còn nợ"

### S-002 Người thuê xem chi tiết phiếu
- Given như S-001
- When An mở phiếu 10/2026
- Then thấy các dòng: tiền phòng 3.000.000; điện (1.350 − 1.250) × 3.000 = 300.000; nước 12 × 15.000 = 180.000; phí 100.000; danh sách phân bổ 2.000.000 với ngày xác nhận; tổng dòng = `total`

### S-003 Truy cập chéo trong cùng tổ chức
- Given An đăng nhập; phiếu `inv_B102` thuộc phòng 102 của Bình
- When An gọi `GET /api/v1/portal/invoices/inv_B102`
- Then HTTP 404 `NOT_FOUND`, thân lỗi không chứa số tiền, tên, số phòng của Bình; một `audit_events` `portal.access_denied` được ghi với `correlation_id`

### S-004 Truy cập chéo khác tổ chức
- Given An là người thuê ở B; phiếu `inv_A1` thuộc tổ chức A
- When An gọi chi tiết `inv_A1` (kể cả khi gửi header/thân có `organization_id` của A)
- Then HTTP 404 `NOT_FOUND`; server lấy `organization_id` từ membership, bỏ qua giá trị client (INV-G1)

### S-005 Người thuê gọi API nhân viên
- Given An chỉ có vai trò `tenant`
- When An gọi `POST /api/v1/billing/periods` hoặc mở `/app/today`
- Then API trả 403 `FORBIDDEN`; trang `/app/*` chuyển hướng về `/portal`

### S-006 Xem hợp đồng và cọc
- Given hợp đồng của An ở trạng thái `active`, phiên bản điều khoản v2 có hiệu lực từ 2026-09-01
- When An mở "Hợp đồng"
- Then thấy phiên bản v2 (giá, kỳ thu, ngày hiệu lực, cọc 3.000.000 với nhãn "Cọc — không phải tiền đã trả cho phiếu"); không thấy CCCD/giấy tờ của người khác; giấy tờ của chính An không hiển thị trên portal ở pilot (Q-08)

### S-007 Xem chỉ số công tơ đã duyệt
- Given phòng 101 có chỉ số điện 10/2026 = 1.350 trạng thái đã duyệt và chỉ số 11/2026 = 1.420 trạng thái nháp
- When An mở "Điện nước"
- Then chỉ thấy 1.350 (đã duyệt) kèm ảnh qua URL ký ngắn hạn; không thấy 1.420

### S-008 Gửi yêu cầu sửa chữa
- Given An đăng nhập, hợp đồng `active`
- When An gửi "Vòi nước rò" kèm 1 ảnh JPEG hợp lệ với `Idempotency-Key=k1`
- Then HTTP 201, tạo 1 phiếu việc trạng thái `open` gắn phòng 101, người tạo = An; nhân viên quản lý `HS1` thấy phiếu; An thấy nhãn "Đã tiếp nhận"

### S-009 Theo dõi trạng thái yêu cầu
- Given phiếu việc của An chuyển `open → assigned → in_progress → done`
- When An mở "Yêu cầu"
- Then thấy lần lượt nhãn "Đã tiếp nhận", "Đã giao thợ", "Đang xử lý", "Đã xong — chờ nghiệm thu" kèm thời điểm theo múi giờ cơ sở; không thấy tên/SĐT nhân viên kỹ thuật (chỉ vai trò)

### S-010 Thanh toán bằng QR + "Tôi đã chuyển"
- Given phiếu 10/2026 còn 1.580.000
- When An mở "Thanh toán", quét QR, bấm "Tôi đã chuyển" với số tiền 1.580.000
- Then tạo 1 báo chuyển trạng thái `submitted`; phiếu **vẫn** `balance=1580000`, không có `payments` mới, không có bút toán (INV-F3); UI hiện "Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền"; nhân viên có quyền thu thấy báo chuyển trong hàng chờ

### S-011 Bấm "Tôi đã chuyển" hai lần
- Given S-010 đã thực hiện với `Idempotency-Key=k2`
- When client gửi lại cùng key và cùng thân
- Then trả lại kết quả cũ (HTTP 200), vẫn 1 báo chuyển; cùng key khác thân → 409 `IDEMPOTENCY_CONFLICT`

### S-012 Người dùng hai ngữ cảnh
- Given Chi là `manager` ở tổ chức A và `tenant` ở tổ chức B
- When Chi đăng nhập
- Then màn chọn ngữ cảnh liệt kê "Khách sạn Mai (A) — Quản lý" và "Nhà trọ Hoa Sen (B) — Người thuê"; sau khi chọn B, header luôn hiện "Nhà trọ Hoa Sen · Người thuê"; mọi API chạy với `app.org_id = B`; chuyển ngữ cảnh gọi xoá cache (SPEC-pwa S-007)

### S-013 Ngữ cảnh đổi giữa hai tab
- Given Chi mở tab 1 ở ngữ cảnh A, tab 2 chuyển sang B
- When tab 1 gửi một command của A
- Then server so ngữ cảnh trong phiên với ngữ cảnh client gửi kèm; khác nhau → 409 `CONTEXT_CHANGED`, UI tab 1 yêu cầu tải lại; không ghi dữ liệu

### S-014 Mời người thuê, tài khoản miễn phí
- Given tổ chức B đang dùng gói có giới hạn số tài khoản nhân viên
- When quản lý mời An bằng `portal.inviteTenant` cho hợp đồng của An
- Then tạo membership vai trò `tenant` gắn `person_id` của An; số tài khoản nhân viên tính quota **không đổi**; An nhận lời mời qua kênh ở SPEC-notifications

### S-015 Người thuê bị thu hồi quyền
- Given hợp đồng của An chuyển `closed` và quá thời gian xem lại (Q-04), hoặc quản lý thu hồi
- When An gọi `portal.listMyInvoices`
- Then HTTP 404 `NOT_FOUND` (quy ước SPEC-access-and-property mục 2 và S-009: membership bị thu hồi thì không còn đọc được tổ chức, không lộ việc tồn tại); phiên hiện tại bị từ chối ở request kế tiếp; UI hiện trang "Tài khoản này không còn truy cập được portal" kèm đường dẫn đăng nhập/chọn tổ chức khác, không hiển thị dữ liệu nào

### S-016 Khách mở liên kết lượt ở hợp lệ
- Given booking `R-778` đã `confirmed`, lễ tân tạo liên kết khách cho lượt ở phòng 203 (folio: 2 × 600.000 + 80.000 + 150.000 = 1.430.000; ứng trước 500.000 đã phân bổ)
- When khách mở liên kết và qua bước xác thực (Q-02)
- Then thấy lượt ở (ngày đến/đi, phòng 203, trạng thái) và folio `total=1430000`, `paid=500000`, `balance=930000`; không thấy hồ sơ cơ sở, khách khác hay giấy tờ

### S-017 Liên kết khách hết hạn
- Given liên kết có `expires_at` đã qua
- When khách mở liên kết
- Then HTTP 410 `LINK_EXPIRED`, trang hiện "Liên kết đã hết hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới."; không hiển thị dữ liệu nào

### S-018 Liên kết khách dùng cho lượt ở khác
- Given token hợp lệ của lượt ở phòng 203
- When gọi `GET /api/v1/portal/guest/stays/{id_khác}` với token đó
- Then HTTP 404 `NOT_FOUND`

### S-019 Thu hồi liên kết khách
- Given liên kết còn hạn
- When lễ tân thu hồi (`portal.revokeGuestLink`)
- Then request kế tiếp với token đó → 410 `LINK_REVOKED`; audit ghi người thu hồi

### S-020 Đoán token khách
- Given cùng một IP gửi 10 token sai trong 1 phút
- When gửi token thứ 11
- Then HTTP 429 `RATE_LIMITED`; không phân biệt "token không tồn tại" với "token sai" trong thông điệp

### S-021 Danh sách rỗng
- Given An chưa có phiếu nào ở trạng thái `issued`
- When mở "Kỳ thu"
- Then hiện trạng thái rỗng "Chưa có kỳ thu nào được phát hành" và không hiện lỗi

### S-022 Tiếp cận
- Given trang "Kỳ thu", "Chi tiết phiếu", "Yêu cầu", "Thanh toán"
- When chạy axe (Playwright) và điều hướng chỉ bằng bàn phím
- Then 0 vi phạm WCAG 2.2 AA mức serious/critical; mọi nút có tên truy cập; vùng chạm ≥ 44 × 44 CSS px

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Chưa có phiếu; hợp đồng chưa có công tơ; yêu cầu không mô tả | Trạng thái rỗng có hướng dẫn; mô tả rỗng → 422 `VALIDATION_FAILED` | S-021 |
| Cực đại/độ dài | Mô tả yêu cầu > 2.000 ký tự (đề xuất); ảnh vượt số lượng/dung lượng/MIME cho phép (giới hạn theo SPEC-housekeeping-maintenance) | 422 `VALIDATION_FAILED` / 413 `FILE_TOO_LARGE` / 415 `FILE_TYPE_NOT_ALLOWED`; danh sách phiếu phân trang keyset 20/trang | S-008 |
| Trùng lặp/idempotency | Gửi lại yêu cầu sửa chữa/báo chuyển cùng key | Không tạo bản ghi thứ hai; khác thân → 409 | S-011 |
| Song song | Hai tab đổi ngữ cảnh; nhân viên xác nhận thanh toán khi người thuê đang xem | 409 `CONTEXT_CHANGED`; số dư lấy mới khi mở lại, không cache | S-013 |
| Mất mạng giữa chừng | Mất mạng khi bấm "Tôi đã chuyển"/gửi yêu cầu | Không báo thành công; khi có mạng truy vấn `command_id` trước khi cho gửi lại (SPEC-pwa S-010) | S-011 |
| Thời gian/múi giờ | Hạn phiếu, thời điểm cập nhật yêu cầu, `expires_at` liên kết | Lưu UTC, hiển thị theo `properties.timezone`; hết hạn so với thời gian server | S-009, S-017 |
| Quyền | Người thuê khác, tổ chức khác, gọi API nhân viên, quyền đã thu hồi, token khách sai lượt ở | 404 cho tài nguyên không thuộc mình hoặc quyền portal đã thu hồi; 403 cho hành động không được phép; không lộ dữ liệu | S-003–S-005, S-015, S-018 |
| Tiền/đơn vị | Số tiền báo chuyển khác số dư; số âm; 0 | VND số nguyên > 0; khác số dư vẫn ghi nhận báo chuyển (nhân viên xử lý); số dư hiển thị từ sổ, không tính ở client | S-010 |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `memberships` (có sẵn) | `role='tenant'`, `person_id`, `valid_until` | | Một person ↔ nhiều membership ở nhiều tổ chức | Quản lý ghi; người thuê đọc của mình |
| `guest_access_links` (**mới**) | `organization_id`, `property_id`, `stay_id`/`reservation_id`, `token_hash`, `expires_at`, `revoked_at`, `created_by`, `last_used_at` | token ≥ 128 bit ngẫu nhiên, chỉ lưu hash | `expires_at NOT NULL`; unique `token_hash` | Lễ tân ghi; server đọc |
| `payment_claims` (**mới**, "báo đã chuyển") | `organization_id`, `invoice_id`, `person_id`, `amount bigint`, `reference_code`, `proof_file_id` (tuỳ chọn), `status` (`submitted → matched` \| `rejected`), `command_id` | | `amount > 0`; **không** sinh `payments`/bút toán | Người thuê ghi; nhân viên có quyền thu đọc/xử lý |
| Phiếu việc (bảng do SPEC-housekeeping-maintenance định nghĩa) | `source='portal'`, `reporter_person_id` | | Trạng thái theo DOMAIN-MODEL §4 | Người thuê tạo/đọc của mình |

- Phạm vi đọc của người thuê: `leases` mà `person_id` là người thuê đứng hợp đồng (Q-05) → `invoices` có người trả là person đó → `deposits`, `meter_readings` đã duyệt của phòng trong thời gian hợp đồng. Kiểm ở `packages/app` **và** RLS (policy riêng cho vai trò `tenant`).
- Hai thực thể `guest_access_links`, `payment_claims` đã có trong DOMAIN-MODEL §7 (v1.2; Q-06 đã đóng); tên ở đó là chuẩn.
- Thay đổi schema: migration ở task T044 (rollback được).

## 5. Giao diện / API
| Loại | Tên | Mô tả |
|---|---|---|
| Query | `portal.listContexts` | Danh sách ngữ cảnh (tổ chức, vai trò) của người dùng |
| Command | `portal.switchContext` | Đổi ngữ cảnh phiên; trả `context_id` mới |
| Query | `portal.listMyInvoices` | Phiếu `issued`/`locked` của mình, lọc trạng thái nợ |
| Query | `portal.getMyInvoice` | Dòng phiếu + phân bổ |
| Query | `portal.getMyLease` | Hợp đồng, phiên bản có hiệu lực, cọc |
| Query | `portal.listMyMeterReadings` | Chỉ số đã duyệt |
| Command | `portal.createRequest` | Tạo phiếu việc (gọi API công khai của module Housekeeping & Maintenance) |
| Query | `portal.listMyRequests` | Phiếu việc của mình + lịch sử trạng thái |
| Query | `portal.getPaymentInstructions` | QR + mã tham chiếu cho một phiếu |
| Command | `portal.submitPaymentClaim` | "Tôi đã chuyển" |
| Command | `portal.inviteTenant` / `portal.revokeTenantAccess` | Nhân viên mời/thu hồi |
| Command | `portal.createGuestLink` / `portal.revokeGuestLink` | Lễ tân tạo/thu hồi |
| Query | `portal.guestGetStay` / `portal.guestGetFolio` | Khách xem bằng token |

- Hợp đồng API: `openapi.yaml#/paths/~1api~1v1~1portal` (duyệt trước khi chia việc).
- Điều hướng portal (mobile, đề xuất): Kỳ thu · Hợp đồng · Yêu cầu · Tài khoản. Header luôn có tên cơ sở + vai trò.
- Trạng thái UI:

| Màn | Đang tải | Rỗng | Lỗi | Thành công |
|---|---|---|---|---|
| Kỳ thu | khung xương 3 thẻ | "Chưa có kỳ thu nào được phát hành" | thông điệp theo mã + nút "Thử lại" | thẻ phiếu: kỳ, tổng, còn nợ, hạn |
| Yêu cầu | khung xương | "Bạn chưa gửi yêu cầu nào" + nút "Gửi yêu cầu" | như trên | danh sách có nhãn trạng thái chữ + icon |
| Thanh toán | khung QR mờ | — | `OFFLINE`: "Không có mạng, chưa gửi được" | "Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền" (không dùng chữ "Đã thanh toán") |
| Liên kết khách | spinner + "Đang kiểm tra liên kết" | — | `LINK_EXPIRED`/`LINK_REVOKED` trang riêng | lượt ở + folio |

- Tiếp cận: label cho mọi trường; số tiền đọc được bởi trình đọc màn hình ("một triệu năm trăm tám mươi nghìn đồng" qua `aria-label`); trạng thái không chỉ bằng màu; focus rõ; lỗi gắn `aria-describedby` có hướng sửa; ảnh QR có văn bản thay thế gồm số tài khoản nhận, số tiền, nội dung chuyển khoản để chép tay.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| `UNAUTHENTICATED` | Chưa đăng nhập / phiên hết hạn | 401 | Phiên đăng nhập đã hết. Vui lòng đăng nhập lại. | — |
| `FORBIDDEN` | Vai trò không được phép trên tài nguyên đọc được | 403 | Bạn không có quyền thực hiện thao tác này. | S-005 |
| `NOT_FOUND` | Tài nguyên không tồn tại **hoặc** không thuộc phạm vi, kể cả membership `tenant` đã bị thu hồi/hết hạn xem lại | 404 | Không tìm thấy dữ liệu. | S-003, S-004, S-015, S-018 |
| `VALIDATION_FAILED` | Thiếu/sai trường | 422 | Thông tin chưa hợp lệ: {trường}. | S-008 |
| `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` | Ảnh vượt giới hạn / sai loại | 413 / 415 | Ảnh quá lớn / Chỉ nhận ảnh JPEG, PNG, WebP. | — |
| `IDEMPOTENCY_CONFLICT` | Cùng key, khác thân | 409 | Yêu cầu bị trùng mã thao tác. Vui lòng tải lại. | S-011 |
| `CONTEXT_CHANGED` | Ngữ cảnh tổ chức đã đổi ở tab khác | 409 | Bạn vừa chuyển sang cơ sở khác. Tải lại để tiếp tục. | S-013 |
| `LINK_EXPIRED` | Liên kết khách quá `expires_at` | 410 | Liên kết đã hết hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới. | S-017 |
| `LINK_REVOKED` | Liên kết đã bị thu hồi | 410 | Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân. | S-019 |
| `RATE_LIMITED` | Vượt ngưỡng thử token/OTP | 429 | Bạn thử quá nhiều lần. Vui lòng đợi ít phút. | S-020 |
| `OFFLINE` | Client phát hiện mất mạng trước khi gửi | — (client) | Không có kết nối mạng. Thao tác chưa được gửi. | — |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng API | p95 < 800 ms cho query portal | PROJECT §5, kế hoạch §17 | k6 |
| LCP | p75 < 2,5 s trên điện thoại mục tiêu | PROJECT §5 | Lighthouse CI + RUM |
| Cách ly | 0 rò rỉ ở test chéo người thuê/tổ chức/token | kế hoạch §16 | test tích hợp + E2E S-003, S-004, S-018 |
| Bộ nhớ đệm | Phản hồi portal có `Cache-Control: no-store`; SW không cache | kế hoạch §10 | test header + SPEC-pwa S-005 |
| Tiếp cận | WCAG 2.2 AA, vùng chạm ≥ 44 px | kế hoạch §09 | axe + kiểm tay |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `portal.invoice_viewed`, `portal.request_created`, `portal.payment_claim_submitted`, `portal.guest_link_opened`, `portal.access_denied` (schema: `analytics/events.schema.json`, không chứa PII) → hỗ trợ M-01 (người thuê tự xem thay vì hỏi) và M-05 (dùng hằng tuần).

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 Người thuê đăng nhập bằng gì: OTP email, OTP SĐT hay mật khẩu? — **[chặn]** — hỏi: PO + Tech Lead — **đề xuất mặc định:** OTP qua email (plugin `emailOTP` của Better Auth, bản ≥ 1.7.9 — đã sau advisory GHSA-qq9h-g4jm-xgf3; ADR-0002) (không cần nhà cung cấp SMS, không có chi phí theo tin); OTP SĐT xem lại sau pilot nếu tỷ lệ người thuê có email thấp (đo ở T001).
- [ ] Q-02 Xác thực liên kết khách: chỉ token, hay token + yếu tố thứ hai? — **[chặn]** — hỏi: PO + Tech Lead — **đề xuất:** token ngẫu nhiên ≥ 128 bit gửi tới SĐT/email người đặt + nhập 4 số cuối SĐT đặt phòng, giới hạn 5 lần sai/liên kết rồi khoá.
- [ ] Q-03 Thời hạn liên kết khách — [không chặn, có cấu hình] — hỏi: PO — **đề xuất:** đến giờ trả phòng dự kiến + 48 giờ, cấu hình theo cơ sở; tạo lại được.
- [ ] Q-04 Người thuê còn xem được bao lâu sau khi hợp đồng `closed`? — [không chặn] — hỏi: PO + pháp lý — **đề xuất:** đến khi quyết toán xong + 30 ngày, chỉ đọc.
- [ ] Q-05 Người ở cùng có tài khoản portal và thấy khoản tiền không? — [không chặn] — hỏi: PO — **đề xuất:** pilot chỉ người đứng hợp đồng và người trả tiền được mời; người ở cùng không xem tiền.
- [x] Q-06 Bổ sung `guest_access_links`, `payment_claims` vào DOMAIN-MODEL — đã đóng: có ở DOMAIN-MODEL §7 (v1.2). Thống nhất với SPEC-ledger-payments: S-008 của ledger nay quy định "khách báo đã chuyển" chỉ tạo `payment_claims`, **không** tạo `payments`/bút toán (INV-F3).
- [ ] Q-07 Có cho đính kèm ảnh chuyển khoản vào báo chuyển không? — [không chặn] — hỏi: PO — **đề xuất:** có, tuỳ chọn, lưu riêng tư; ảnh không đủ để xác nhận thu (INV-F3).
- [ ] Q-08 Portal có hiển thị giấy tờ của chính người thuê không (ma trận SPEC-access-and-property cho phép "Mình")? — [không chặn] — hỏi: PO + pháp lý — **đề xuất:** không trong pilot (giảm bề mặt lộ dữ liệu nhạy cảm); xem lại sau DPIA.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · SPEC-access-and-property có ma trận `tenant`/`guest` · đủ nhỏ cho một PR · mỗi task có Gate.
- DoD: mọi S-NNN có test xanh (S-003/S-004/S-018 là test tích hợp trên Postgres thật có RLS) · ca biên có test · cổng commit/merge xanh · OpenAPI cập nhật · sự kiện có schema · blueprint tick có bằng chứng.

## 12. Truy vết
| Task | PR | Bằng chứng (CI/evidence) |
|---|---|---|
| T044 (portal người thuê) | — | — |
| T045 (phần tạo yêu cầu từ portal) | — | — |
| T048 (QA PWA gồm portal) | — | — |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-008 | (chưa) |
| 2 | 2026-10-15 | sửa theo review độc lập: S-015 membership bị thu hồi → 404 `NOT_FOUND`; fixture S-001 sửa (kỳ thu `draft` chưa có phiếu, lọc theo trạng thái kỳ thu); đóng Q-06 (bảng đã có ở DOMAIN-MODEL §7, ledger S-008 đã thống nhất); đảo thứ tự Q-07/Q-08 | review O6, G7, G5 | (chưa) |
