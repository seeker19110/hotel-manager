# SPEC-housekeeping-maintenance — Buồng phòng và phiếu sự cố/sửa chữa tối thiểu

| Trường | Giá trị |
|---|---|
| ID tính năng | F-007 (luồng: R-003 bước "dọn và kiểm tra") |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch §03, §06, §07, §09, §10, §12, §16; DOMAIN-MODEL §3, §4, §6, §7; backlog T045, T055 |

## 1. User story
- Là **nhân viên buồng phòng**, tôi muốn xem việc dọn theo tầng và ưu tiên, nhận việc, báo tiến độ và báo hỏng có ảnh trên điện thoại, để phòng sẵn sàng đúng lúc khách đến.
- Là **quản lý**, tôi muốn nghiệm thu phòng đã dọn và duyệt đề xuất khoá phòng của kỹ thuật, để chỉ phòng đạt mới được nhận khách và phòng hỏng không bị bán.
- Là **kỹ thuật**, tôi muốn nhận phiếu sự cố, cập nhật xử lý và đề xuất block, để sửa chữa có dấu vết.

Ngoài phạm vi: nháp offline (F-014, tuần 17–18), tài sản/lịch bảo trì định kỳ (T066), vật tư. Pilot chỉ chạy online; mất mạng thì app shell báo rõ và không ghi nhận thao tác (kế hoạch §10, T048).

## 2. Tiêu chí chấp nhận (Given/When/Then)
Fixture chung: cơ sở P1, tầng 2 có phòng `201`, `202`; manager M, buồng phòng H1, H2, kỹ thuật K (phạm vi P1); lễ tân L.
Ánh xạ trạng thái việc dọn → chiều vệ sinh của phòng (DOMAIN-MODEL §3, §4):

| `tasks.status` | `open` | `assigned` | `in_progress` | `done` | `verified` | `cancelled` |
|---|---|---|---|---|---|---|
| `units.housekeeping_status` | `dirty` | `assigned` | `cleaning` | `clean` | `inspected` | giữ trạng thái trước |

### S-001 Check-out tạo việc dọn
- Given stay `in_house` trên `201`
- When `stay.checkOut` thành công (SPEC-reservation-stay S-020)
- Then cùng transaction: 1 `tasks` loại `cleaning`, `open`, gắn `201`, nguồn = stay; `201.housekeeping_status='dirty'`; chuyển phòng (SPEC-inventory-allocation S-015) cũng tạo việc cho phòng cũ

### S-002 Không tạo việc trùng cho một phòng
- Given `201` đã có việc `cleaning` chưa kết thúc (`open`/`assigned`/`in_progress`)
- When có thêm sự kiện tạo việc dọn cho `201`
- Then không tạo việc mới (unique việc dọn đang mở theo phòng); việc hiện có được ghi thêm nguồn; nếu việc cũ đã `done`/`verified` thì tạo việc mới và phòng về `dirty`

### S-003 Danh sách việc theo tầng và ưu tiên
- Given P1 có 5 việc mở, `202` có khách đến hôm nay
- When H1 gọi `housekeeping.listTasks` {P1, tầng 2}
- Then chỉ trả việc tầng 2 của P1; `202` xếp trước (ưu tiên = có khách đến hôm nay, rồi theo thời gian tạo — Q-04); mỗi dòng chỉ gồm: mã phòng, tầng, loại việc, trạng thái, ưu tiên, người nhận, ghi chú vận hành, giờ khách đến dự kiến; **không** có tên/SĐT khách, giấy tờ, số tiền

### S-004 Giao việc và tự nhận việc
- Given việc `t1` của `201` đang `open`
- When M `housekeeping.assignTask` `t1` cho H1; (trường hợp khác) H1 và H2 cùng `housekeeping.claimTask` `t1` song song
- Then giao: `t1.assigned`, `assignee=H1`, `201.assigned`; tự nhận: đúng 1 người thành công, người kia `409 INVALID_TRANSITION` (Q-02 về việc cho tự nhận)

### S-005 Cập nhật tiến độ
- Given `t1` `assigned` cho H1
- When H1 `housekeeping.startTask` rồi `housekeeping.completeTask` {ghi chú}
- Then `in_progress` (phòng `cleaning`) rồi `done` (phòng `clean`); mỗi bước có `audit_events` người + thời điểm (UTC)

### S-006 Chỉ người được giao cập nhật
- Given `t1` giao cho H1
- When H2 gọi `housekeeping.startTask` `t1`
- Then `403 FORBIDDEN`; trạng thái không đổi

### S-007 Nghiệm thu phòng (T055)
- Given `t1` `done`
- When M `housekeeping.verifyTask` `t1` {đạt}
- Then `t1.verified`, `201.housekeeping_status='inspected'`, `verified_by=M`, audit "xác nhận sẵn sàng"; `inventory.getUnitStatus` `201` → `ready_for_arrival=true` nếu trống và `active`
- And nếu M chọn {không đạt, lý do}: `t1` về `assigned` cho cùng người, phòng `assigned` (Q-05)

### S-008 Tách quyền: người làm không tự nghiệm thu
- Given cơ sở bật tách quyền; H1 là người làm `t1` và (trong fixture này) có quyền nghiệm thu
- When H1 `housekeeping.verifyTask` `t1`
- Then `403 SELF_APPROVAL_FORBIDDEN` (DOMAIN-MODEL §4); `t1` vẫn `done`

### S-009 Chuyển trạng thái không hợp lệ (Scenario Outline)
- Given việc ở `<từ>`
- When gọi lệnh dẫn tới `<đến>`
- Then `409 INVALID_TRANSITION`, ghi audit lần từ chối
- Examples: | từ | đến |
  | `open` | `done` |
  | `open` | `verified` |
  | `verified` | `in_progress` |
  | `cancelled` | `assigned` |
  | `done` | `in_progress` |

### S-010 "Sạch" không có nghĩa là "trống"
- Given `202` `inspected` nhưng có stay `in_house`
- When lễ tân tìm phòng trống hôm nay
- Then `202` không có trong `inventory.searchAvailability`; thẻ phòng hiển thị cả "Có khách" và "Đã kiểm" bằng chữ + icon

### S-011 Idempotency khi bấm hai lần
- Given `t1` `in_progress`
- When H1 gửi `housekeeping.completeTask` hai lần cùng `Idempotency-Key`
- Then 1 chuyển trạng thái, 1 audit, hai phản hồi giống nhau

### S-012 Tạo phiếu sự cố có ảnh (T045)
- Given H1 thấy vòi sen `201` hỏng
- When H1 `files.requestUpload` {image/jpeg, 2,4 MB} → tải lên URL ký → `maintenance.createWorkOrder` {`201`, mô tả, mức độ, file_ids}
- Then `work_orders` `open` với người tạo H1; file ở trạng thái `pending_scan`, chỉ gắn hiển thị khi `ready`; thông báo cho M và K (F-011)

### S-013 Từ chối loại file không cho phép
- Given giới hạn MIME (Q-06)
- When tải lên `image/svg+xml`, `application/pdf`, hoặc file đặt tên `.jpg` nhưng magic bytes là PDF
- Then `415 FILE_TYPE_NOT_ALLOWED`; loại kiểm bằng nội dung, không tin `Content-Type`/đuôi file client gửi

### S-014 Vượt dung lượng/số ảnh
- Given giới hạn mỗi ảnh và số ảnh mỗi phiếu (Q-06)
- When tải ảnh vượt dung lượng; hoặc gắn quá số ảnh tối đa
- Then `413 FILE_TOO_LARGE`; `422 VALIDATION_FAILED` (`file_ids` vượt giới hạn)

### S-015 Quét mã độc
- Given file tải lên bị trình quét đánh dấu nhiễm (dùng chuỗi kiểm thử EICAR trong test)
- When worker quét xong
- Then file `rejected`, không bao giờ cấp URL đọc, không gắn vào phiếu; audit `file.rejected`; phiếu sự cố vẫn tồn tại, người tạo nhận thông báo tải lại

### S-016 Bỏ EXIF
- Given ảnh JPEG có thẻ EXIF GPS, model máy, thời điểm chụp
- When file qua xử lý thành `ready`
- Then bản được phục vụ không còn khối EXIF/GPS (kiểm bằng trình đọc EXIF trong test); ảnh vẫn hiển thị đúng chiều; bản gốc chưa xử lý không được lưu lại sau xử lý

### S-017 File riêng tư, URL ngắn hạn (kế hoạch §16)
- Given ảnh `f1` thuộc phiếu của tổ chức A
- When người trong phạm vi xin URL đọc; dùng URL sau khi hết hạn (Q-07); người tổ chức B xin URL cho `f1`
- Then URL ký có hạn; hết hạn → bucket từ chối; người B → `404 NOT_FOUND`; bucket không có quyền đọc công khai

### S-018 Kỹ thuật đề xuất block
- Given phiếu `w1` của `201` đã `assigned` cho K
- When K `maintenance.proposeBlock` {w1, 22/10 08:00 → 24/10 17:00, lý do}; rồi K tự gọi `inventory.approveBlock`
- Then tạo `blocks` `requested` liên kết `w1` (SPEC-inventory-allocation S-011); K duyệt → `403 FORBIDDEN`; chỉ owner/manager duyệt

### S-019 Hoàn tất sửa chữa và mở lại phòng cần thẩm quyền
- Given `w1` `in_progress`, `201` đang block
- When K `maintenance.completeWorkOrder` {ghi chú, ảnh sau sửa}; K gọi `inventory.endBlock`; rồi M `maintenance.verifyWorkOrder` + `inventory.endBlock`
- Then `w1.done`; K kết thúc block → `403 FORBIDDEN`; M nghiệm thu → `w1.verified`, block `ended`, `201` khả dụng `active` và có việc dọn `open` (Q-08)

### S-020 Buồng phòng không thấy CCCD và tiền (kế hoạch §03, §16; DOMAIN-MODEL §6)
- Given H1 thuộc P1; stay `s1` của `201` có `identity_documents` `d1` và folio
- When H1 gọi `stay.getFolio s1`, `identity.get d1`, xin URL file của `d1`, tìm kiếm theo SĐT khách, hoặc đọc chi tiết `t1`/`w1`
- Then 3 lệnh đầu → `404 NOT_FOUND`; tìm kiếm trả rỗng; chi tiết việc/phiếu không chứa trường tiền, tên, SĐT, giấy tờ (test so khớp danh sách trường cho phép); kiểm cả ở RLS

### S-021 Người thuê gửi yêu cầu sửa chữa (T045, F-008)
- Given người thuê T có hợp đồng `active` trên `305`
- When T tạo phiếu cho `305`; rồi cho `306`
- Then phiếu `305` `open`, nguồn `tenant`; `306` → `404 NOT_FOUND`; T chỉ xem phiếu do mình tạo

### S-022 Chéo tenant (INV-G1)
- Given việc `t_B` của tổ chức B
- When người tổ chức A gọi `housekeeping.getTask t_B` hoặc `maintenance.listWorkOrders` có `property_id` của B
- Then `404 NOT_FOUND`; danh sách không có hàng của B

### S-023 Audit + outbox (INV-G6)
- Given mọi command ghi của mục 5
- When commit
- Then 1 `audit_events` (chủ thể, trước/sau) và `outbox` (nếu có thông báo) cùng transaction; lỗi → không có hàng nào

### S-024 Mất mạng ở pilot
- Given H1 đang mở danh sách việc, thiết bị mất mạng
- When H1 bấm "Hoàn tất"
- Then UI báo "Mất kết nối — chưa ghi nhận", không hiển thị thành công, không tạo hàng chờ offline; có mạng lại thì tải lại trạng thái từ máy chủ trước khi cho bấm lại

## 3. Ca biên
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Không có việc; phiếu không ảnh; mô tả rỗng | Danh sách rỗng "Không có phòng cần dọn"; phiếu không ảnh hợp lệ; mô tả rỗng → `422` | S-003, S-012 |
| Cực đại/độ dài | Ảnh vượt dung lượng; quá số ảnh; mô tả > 2.000 ký tự | `413`; `422` | S-014 |
| Trùng lặp/idempotency | Bấm hoàn tất 2 lần; 2 sự kiện tạo việc cho 1 phòng | 1 hiệu lực; 1 việc mở/phòng | S-002, S-011 |
| Song song | 2 người cùng nhận việc; nghiệm thu và huỷ cùng lúc | Khoá hàng `tasks`; lệnh sau `409 INVALID_TRANSITION` | S-004 |
| Mất mạng giữa chừng | Mất mạng khi bấm; tải ảnh đứt giữa chừng | Không báo thành công; file dở không `ready`, dọn theo vòng đời file | S-024, S-012 |
| Thời gian/múi giờ | Ưu tiên "khách đến hôm nay" theo `business_date` cơ sở; URL hết hạn đúng mốc | Ngày theo `properties.timezone`; so hạn UTC | S-003, S-017 |
| Quyền | Buồng phòng xem tiền/CCCD; người khác cập nhật việc; kỹ thuật tự duyệt block; người thuê phòng khác; khác tổ chức | 404/403 theo quy ước SPEC-access-and-property mục 2 | S-006, S-018–S-022 |
| Tiền/đơn vị | Không có số tiền trong F-007; chi phí sửa chữa để T066 | Không trường tiền nào trả cho `housekeeping` | S-020 |

## 4. Dữ liệu
| Thực thể | Trường chính | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `tasks` ¹ | organization_id, property_id, unit_id, id, kind (`cleaning`\|`inspection`), status, priority, assignee_membership_id, source_type, source_id, done_by, verified_by, due_at | | trạng thái theo DOMAIN-MODEL §4; unique (unit_id) where kind=`cleaning` and status in (`open`,`assigned`,`in_progress`) | ma trận F-001 |
| `work_orders` ¹ | organization_id, property_id, unit_id, id, title, description, severity, status, reporter (membership hoặc person), assignee_membership_id, block_id? | | cùng vòng đời phiếu việc | ma trận F-001; người thuê chỉ của mình |
| `files` ¹ | organization_id, id, owner_type, owner_id, mime, size_bytes, sha256, status (`pending_scan`→`ready`\|`rejected`), storage_key, exif_stripped | `bigint` size | chỉ `ready` được cấp URL; bucket private | hệ thống ghi; đọc theo quyền của đối tượng chủ |
| `units` | housekeeping_status | | chỉ đổi qua command F-007 hoặc check-out/chuyển phòng | |

¹ Tên từ kế hoạch §12; `tasks`, `work_orders`, `files` đã có trong DOMAIN-MODEL §7 (v1.2). Migration có `down`; RLS + FK ghép theo INV-G1.

## 5. Giao diện / API
Hợp đồng chi tiết: `docs/design/API-CONTRACT.md`. Mọi command nhận `Idempotency-Key`.

| Command/Query | Input chính | Output | Lỗi |
|---|---|---|---|
| `housekeeping.createTask` (nội bộ + thủ công) | unit_id, kind, source, priority?, note? | task_id | VALIDATION_FAILED |
| `housekeeping.assignTask` / `housekeeping.claimTask` | task_id, assignee? | task | INVALID_TRANSITION, FORBIDDEN |
| `housekeeping.startTask` / `housekeeping.completeTask` | task_id, note? | task | INVALID_TRANSITION, FORBIDDEN |
| `housekeeping.verifyTask` | task_id, result (`pass`\|`fail`), reason? | task | INVALID_TRANSITION, FORBIDDEN, SELF_APPROVAL_FORBIDDEN |
| `housekeeping.cancelTask` | task_id, reason | task | INVALID_TRANSITION |
| `housekeeping.listTasks` / `housekeeping.getTask` (query) | property_id, floor_id?, status?, assignee? | việc (trường đã lọc theo vai trò) | NOT_FOUND |
| `files.requestUpload` | owner_type, mime, size_bytes | file_id, upload_url, expires_at | FILE_TYPE_NOT_ALLOWED, FILE_TOO_LARGE |
| `files.getReadUrl` (query) | file_id | url, expires_at | NOT_FOUND, FILE_NOT_READY |
| `maintenance.createWorkOrder` | unit_id, title, description, severity, file_ids[] | work_order_id | VALIDATION_FAILED, NOT_FOUND |
| `maintenance.assignWorkOrder` / `startWorkOrder` / `completeWorkOrder` / `verifyWorkOrder` / `cancelWorkOrder` | work_order_id, … | work_order | INVALID_TRANSITION, FORBIDDEN, SELF_APPROVAL_FORBIDDEN (khi `verifyWorkOrder` bởi chính người làm) |
| `maintenance.proposeBlock` | work_order_id, start, end, reason | block_id (gọi `inventory.requestBlock`) | VALIDATION_FAILED |
| `maintenance.listWorkOrders` (query) | property_id, status?, mine? | danh sách | NOT_FOUND |

- UI điện thoại: danh sách việc theo tầng, một tác vụ mỗi màn, nút lớn (≥ 44 CSS px) "Nhận / Bắt đầu / Xong"; trạng thái có chữ + icon; ảnh chụp trực tiếp từ camera; hiển thị tiến độ quét ảnh ("Đang kiểm tra ảnh"). Trạng thái: đang tải / rỗng / lỗi có hướng sửa / thành công sau phản hồi máy chủ.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| INVALID_TRANSITION | Chuyển trạng thái sai, nhận việc đã có người nhận | 409 | Việc này đã thay đổi trạng thái. Vui lòng tải lại. | S-004, S-009 |
| SELF_APPROVAL_FORBIDDEN | Người làm tự nghiệm thu (`verified`) việc/phiếu của mình khi bật tách quyền (DOMAIN-MODEL §4); không dùng `INVALID_TRANSITION` | 403 | Bạn không thể tự nghiệm thu việc mình đã làm. | S-008 |
| FORBIDDEN | Cập nhật việc không được giao; kỹ thuật duyệt/kết thúc block | 403 | Bạn không có quyền thực hiện thao tác này. | S-006, S-018, S-019 |
| NOT_FOUND | Khác tổ chức/không được đọc (CCCD, folio, phòng khác) | 404 | Không tìm thấy dữ liệu. | S-017, S-020–S-022 |
| FILE_TYPE_NOT_ALLOWED | MIME/nội dung không cho phép | 415 | Chỉ nhận ảnh JPEG, PNG hoặc WebP. | S-013 |
| FILE_TOO_LARGE | Vượt dung lượng | 413 | Ảnh quá lớn. Vui lòng chọn ảnh nhỏ hơn. | S-014 |
| FILE_NOT_READY | File đang quét hoặc bị từ chối | 409 | Ảnh đang được kiểm tra hoặc không hợp lệ. | S-015 |
| IDEMPOTENCY_CONFLICT | Cùng key khác nội dung | 409 | Thao tác trùng mã nhưng khác nội dung. Vui lòng tải lại. | S-011 |
| VALIDATION_FAILED | Thiếu mô tả, quá số ảnh | 422 | Thông tin chưa hợp lệ, xem các trường được đánh dấu. | S-014 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Độ trễ | p95 < 800 ms cho danh sách/chuyển trạng thái | kế hoạch §17 | k6 |
| Bảo mật file | Bucket private, URL ngắn hạn, quét mã độc, giới hạn MIME/dung lượng, bỏ EXIF | kế hoạch §16 | S-013–S-017; pentest tuần 21–22 |
| Riêng tư | 0 trường tiền/giấy tờ trong phản hồi cho `housekeeping` | kế hoạch §03, §16 | S-020 (so khớp danh sách trường) |
| Tiếp cận | WCAG 2.2 AA, vùng chạm ≥ 44 CSS px, dùng được một tay | kế hoạch §09 | axe + thử thiết bị thật |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `housekeeping.task_created`, `housekeeping.task_done`, `housekeeping.task_verified` (thời gian từ `dirty` đến `inspected`), `work_order.created`, `work_order.verified`, `file.rejected` → M-05 (tác vụ lõi theo `property_id`), hỗ trợ M-03 (phòng sẵn sàng khi khách đến).

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 Ai được nghiệm thu phòng (manager, lễ tân, hay buồng phòng trưởng) — [chặn] — hỏi: PO — đề xuất: owner/manager; thêm lễ tân nếu cơ sở bật; chưa thêm vai trò mới.
- [ ] Q-02 Buồng phòng có được tự nhận việc chưa giao không — [không chặn] — hỏi: PO — đề xuất: có, trong phạm vi cơ sở.
- [ ] Q-03 Mặc định bật tách quyền "người làm không tự nghiệm thu" — [không chặn] — hỏi: PO — đề xuất: bật.
- [ ] Q-04 Quy tắc ưu tiên việc dọn — [không chặn] — hỏi: PO — đề xuất: phòng có khách đến hôm nay → phòng vừa trả → còn lại theo thời gian tạo.
- [ ] Q-05 Nghiệm thu không đạt quay về người cũ hay về `open` — [không chặn] — hỏi: PO — đề xuất: về `assigned` cho cùng người. Cần thêm chuyển `done → assigned` vào bảng chuyển DOMAIN-MODEL §4.
- [ ] Q-06 Giới hạn file — [chặn T045/T076] — hỏi: Tech Lead + PO — đề xuất: JPEG/PNG/WebP; ≤ 10 MB/ảnh; ≤ 5 ảnh/phiếu. Cần kiểm iPhone (HEIC) trên thiết bị thật trước khi chốt (chưa xác minh).
- [ ] Q-07 Thời hạn URL ký đọc/tải — [không chặn] — hỏi: Tech Lead — đề xuất: 5 phút cho ảnh vận hành; ảnh giấy tờ ngắn hơn theo DPIA.
- [ ] Q-08 Sau sửa chữa có bắt buộc tạo việc dọn trước khi bán lại không — [không chặn] — hỏi: PO — đề xuất: có (S-019).
- [x] Q-09 Bổ sung `tasks`, `work_orders`, `files` vào DOMAIN-MODEL; trạng thái `cancelled` cho phiếu sự cố — đã đóng: có ở DOMAIN-MODEL §7 và §4 (v1.2).
- [ ] Q-10 Công cụ quét mã độc và nơi chạy (worker gọi dịch vụ nào, chi phí) — [chặn T076] — hỏi: Tech Lead — đề xuất: chọn qua `/research` + ADR; chưa chọn thì file không bao giờ sang `ready`.
- [ ] Q-11 Thời hạn lưu ảnh sự cố/việc dọn — [không chặn pilot, chặn go-live] — hỏi: PO + pháp lý — đề xuất: theo lịch retention của DPIA (kế hoạch §16).

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · F-001, F-002 xong · bucket private + quét file sẵn sàng ở dev/CI.
- DoD: mọi S-NNN có test xanh (S-013–S-017, S-020 có test bảo mật riêng) · E2E bước "dọn và kiểm tra" của R-003 · API-CONTRACT cập nhật · sự kiện mục 9 có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T045, T055 | — | .autopilot/evidence/<task>.json |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-007 | (chờ) |
| 2 | 2026-10-15 | sửa theo review độc lập: bảng lỗi mục 6 và bảng lệnh dùng `SELF_APPROVAL_FORBIDDEN` (403) cho tự nghiệm thu, khớp S-008, tách khỏi `INVALID_TRANSITION`; đóng Q-09 | review G2, G5 | (chờ) |
