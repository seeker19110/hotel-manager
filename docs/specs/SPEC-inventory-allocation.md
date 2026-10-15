# SPEC-inventory-allocation — Lịch tài nguyên, allocation, hold, block và trạng thái phòng

| Trường | Giá trị |
|---|---|
| ID tính năng | F-002 (luồng: R-002, R-003, R-004) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 1 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch §07, §13, §17; DOMAIN-MODEL §3, §4; ADR-0001; backlog T018–T022, T024 |

## 1. User story
- Là **lễ tân**, tôi muốn giữ một phòng cụ thể trong một khoảng thời gian và được hệ thống từ chối ngay nếu phòng đã bị chiếm, để không bao giờ bán trùng.
- Là **quản lý**, tôi muốn thấy trên một lịch chung mọi hold, lượt ở, hợp đồng và block của từng phòng cùng trạng thái vệ sinh và khả dụng, để điều phối và xử lý ngoại lệ.
- Là **kỹ thuật**, tôi muốn đề xuất khoá phòng để sửa chữa, để không ai bán phòng hỏng.

Ngoài phạm vi: bán theo loại phòng chưa gán phòng (capacity bucket — kế hoạch §13, V1+), giá giờ (F-013), offline (F-014). Module khác (Reservation, Lease) gọi command ở mục 5; không tự ghi `allocations`.

## 2. Tiêu chí chấp nhận (Given/When/Then)
Fixture chung: tổ chức A, cơ sở P1 (`timezone=Asia/Ho_Chi_Minh`), phòng `101`, `102` cùng loại; thời điểm viết dạng giờ địa phương, lưu UTC.

### S-001 Tạo hold thành công
- Given phòng `101` không có allocation `active` trong khoảng
- When lễ tân gọi `inventory.createHold` {unit `101`, [15/10 14:00, 17/10 12:00)}
- Then `201`; một allocation `kind='hold'`, `active=true`, `during` = `[2026-10-15 07:00Z, 2026-10-17 05:00Z)`, `expires_at` = thời điểm commit + TTL mặc định (Q-01); trả `allocation_id`, `expires_at`

### S-002 Chồng lấn bị DB từ chối (INV-I1)
- Given `101` có allocation `active` [15/10 14:00, 17/10 12:00)
- When `inventory.createHold` `101` [16/10 14:00, 18/10 12:00)
- Then `409 ROOM_UNAVAILABLE` (dịch từ SQLSTATE `23P01`, không trả lỗi SQL thô), kèm `alternatives` = phòng cùng loại còn trống trong khoảng (ví dụ `102`); không có hàng mới

### S-003 Giáp mốc được phép (INV-I2)
- Given `101` có allocation [15/10 14:00, 17/10 12:00)
- When `inventory.createHold` `101` [17/10 12:00, 18/10 12:00)
- Then `201`; hai allocation cùng `active`, không bị coi là chồng

### S-004 Khoảng không hợp lệ
- Given bất kỳ
- When `start >= end`, hoặc thiếu `start`, hoặc `end` null với `kind='hold'`
- Then `422 VALIDATION_FAILED`; chỉ `kind='lease'` được `end` null (khoảng mở)

### S-005 100 yêu cầu tranh phòng cuối (T024, R-004)
- Given `101` trống [20/10 14:00, 21/10 12:00)
- When 100 lệnh `inventory.createHold` song song, 100 `Idempotency-Key` khác nhau, cùng phòng, cùng khoảng
- Then đúng 1 phản hồi `201`, 99 phản hồi `409 ROOM_UNAVAILABLE`; `SELECT count(*) FROM allocations WHERE unit=101 AND active AND during && …` = 1. Chạy trên Postgres thật (Testcontainers)

### S-006 Cùng lệnh gửi 100 lần (INV-G5)
- Given phòng trống
- When 100 lệnh song song cùng `Idempotency-Key=k1`, cùng body
- Then mọi phản hồi thành công trả **cùng** `allocation_id`; có đúng 1 allocation, 1 `audit_events`, 1 `outbox`

### S-007 Worker nhả hold hết hạn đúng một lần (INV-I3)
- Given hold `h1` có `expires_at` = 10:00; đồng hồ test = 10:00:01
- When 2 tiến trình worker `inventory.expireHolds` chạy đồng thời
- Then `h1.active=false`; đúng 1 `audit_events` `allocation.hold_expired`; booking nguồn chuyển `held → expired` đúng một lần

### S-008 Lệnh mới dọn hold hết hạn trước khi insert (INV-I3)
- Given hold `h1` trên `101` đã quá `expires_at` nhưng worker chưa chạy (`active=true`)
- When lễ tân khác `inventory.createHold` `101` cùng khoảng
- Then trong cùng transaction: khoá phòng (`SELECT … FOR UPDATE` trên `units`), đặt `h1.active=false` (audit 1 lần), insert hold mới → `201`. Worker chạy sau đó không ghi thêm audit cho `h1`

### S-009 Xác nhận hold đã hết hạn
- Given hold `h1` quá `expires_at`, chưa được nhả
- When `inventory.confirmHold` `h1`
- Then `409 HOLD_EXPIRED`; `h1` được nhả; người dùng phải giữ lại (có thể nhận `ROOM_UNAVAILABLE` nếu đã có người khác giữ)

### S-010 Không dùng `now()` trong index/constraint
- Given schema sau migration
- When test đọc `pg_indexes`/`pg_constraint` của `allocations`
- Then không vị từ nào chứa `now()`/`current_timestamp`; EXCLUDE có `WHERE (active)` đúng DOMAIN-MODEL §3

### S-011 Đề xuất và duyệt block (T021)
- Given kỹ thuật K phạm vi P1; `102` trống [22/10 08:00, 24/10 17:00)
- When K gọi `inventory.requestBlock` {`102`, khoảng trên, lý do "Thay bình nóng lạnh"}; rồi manager gọi `inventory.approveBlock`
- Then sau bước 1: `blocks.status='requested'`, **chưa** có allocation, phòng vẫn bán được; sau bước 2: allocation `kind='block'` active, `blocks.approved_by` = manager, chiều khả dụng của `102` trong khoảng = `blocked`; `inventory.createHold` chồng khoảng → `409 ROOM_UNAVAILABLE`

### S-012 Block đụng khách đã xác nhận
- Given `102` có lượt ở `expected` [23/10 14:00, 24/10 12:00)
- When manager `inventory.approveBlock` block [22/10 08:00, 24/10 17:00)
- Then `409 BLOCK_CONFLICT` kèm danh sách allocation xung đột (kind, nguồn, khoảng); không insert một phần; block vẫn `requested`

### S-013 Sự cố bất ngờ trên phòng có khách sắp đến (kế hoạch §07)
- Given `102` có lượt ở `expected` bắt đầu hôm nay 14:00
- When manager `inventory.setUnitAvailability` {`102`, `out_of_service`, lý do}
- Then chiều khả dụng = `out_of_service`; mọi `createHold`/check-in mới vào `102` → `409 UNIT_OUT_OF_SERVICE`; booking **không** bị xoá hay huỷ; tạo một `exception` loại `RELOCATION_REQUIRED` cho mỗi allocation tương lai bị ảnh hưởng; audit có trước/sau

### S-014 Ba chiều trạng thái độc lập (Scenario Outline, T019)
- Given phòng có `<chiếm dụng>`, `<vệ sinh>`, `<khả dụng>`
- When gọi `inventory.getUnitStatus` tại thời điểm T
- Then `sellable` và `ready_for_arrival` đúng bảng
- Examples:

| chiếm dụng tại T | vệ sinh | khả dụng | sellable (còn bán được khoảng tới) | ready_for_arrival |
|---|---|---|---|---|
| trống | `inspected` | `active` | có | có |
| trống | `dirty` | `active` | có | không |
| trống | `clean` | `active` | có | có (hoặc không nếu cơ sở bắt buộc `inspected`) |
| có khách (`stay` in_house) | `inspected` | `active` | không | không |
| trống | `inspected` | `blocked` | không | không |
| trống | `clean` | `out_of_service` | không | không |

### S-015 Chuyển phòng nguyên tử (T022)
- Given lượt ở `s1` trên `101` [15/10 14:00, 18/10 12:00), folio có 2 khoản phí; `102` trống
- When `inventory.moveAllocation` {allocation của `s1`, đến `102`, hiệu lực 16/10 10:00, lý do}
- Then trong một transaction: allocation cũ `during` = [15/10 14:00, 16/10 10:00); allocation mới `102` = [16/10 10:00, 18/10 12:00), cùng `source_id`; phí và công nợ giữ nguyên trên `s1`; `101` chuyển vệ sinh `dirty` và có việc dọn mới (F-007); audit một sự kiện `allocation.moved` có trước/sau

### S-016 Chuyển sang phòng bận thì rollback
- Given như S-015 nhưng `102` có allocation chồng [17/10 14:00, 19/10 12:00)
- When `inventory.moveAllocation`
- Then `409 ROOM_UNAVAILABLE`; allocation cũ không đổi `during`; không có việc dọn hay audit di chuyển

### S-017 Quá hạn chưa trả phòng (INV-I4)
- Given lượt ở `s1` `in_house` trên `101`, kết thúc dự kiến 17/10 12:00; đồng hồ test = 17/10 13:00
- When worker `inventory.detectOverdue` chạy; sau đó lễ tân check-in booking khác vào `101`
- Then allocation `s1` **không** tự kết thúc (không đặt `active=false`); tạo 1 `exception` loại `STAY_OVERSTAY` (chạy lại không tạo thêm); lịch hiển thị `101` "Quá hạn trả"; check-in mới → `409 ROOM_OCCUPIED`; booking đã xác nhận kế tiếp trên `101` có `exception` `RELOCATION_REQUIRED`

### S-018 Gia hạn đụng booking đã xác nhận (INV-I4)
- Given `s1` trên `101` đến 17/10 12:00; booking `r2` đã `confirmed` trên `101` từ 17/10 14:00
- When `inventory.resizeAllocation` `s1` đến 18/10 12:00
- Then `409 ROOM_UNAVAILABLE` kèm `exception_id` loại `EXTENSION_CONFLICT` (ghi ở transaction riêng sau rollback); `s1` giữ nguyên; `r2` không đổi; không bỏ/hoãn constraint

### S-019 Hợp đồng không thời hạn (khoảng mở)
- Given hợp đồng trên `103` có allocation `kind='lease'` [01/11 00:00, ∞)
- When `inventory.createHold` `103` [10/03/2027 14:00, 11/03/2027 12:00); sau đó F-003 ghi báo trả, gọi `inventory.resizeAllocation` đặt `end` = 31/12 24:00
- Then lần giữ đầu → `409 ROOM_UNAVAILABLE`; sau khi có `end`, giữ từ 01/01/2027 trở đi → `201`

### S-020 Hợp đồng hết hạn nhưng chưa bàn giao trả (kế hoạch §07)
- Given allocation `lease` của `103` kết thúc 31/12 24:00, chưa có `handovers` trả phòng; đồng hồ test = 01/01 09:00
- When job `lease.detectOverstay` (SPEC-lease) chạy
- Then tạo 1 `exception` loại `LEASE_OVERSTAY`; phòng không thành trống; khi ngoại lệ còn `open`: `searchAvailability` loại `103`, `createHold`/check-in/bàn giao vào `103` có `start` trước thời điểm giải quyết → `409 ROOM_OCCUPIED`; mỗi booking đã xác nhận bị đụng có thêm `exception` `RELOCATION_REQUIRED` (Q-09)

### S-021 Lịch phòng theo cơ sở/tầng/loại (T020)
- Given P1 có 2 tầng, 3 loại phòng, các allocation hold/stay/lease/block
- When `inventory.getCalendar` {P1, từ 15/10, đến 21/10, tầng=2}
- Then chỉ trả phòng tầng 2; mỗi phòng có các đoạn {kind, nguồn, trạng thái nguồn, khoảng theo giờ địa phương}, trạng thái vệ sinh và khả dụng mới nhất; vai trò `housekeeping` nhận cùng lịch nhưng **không** có tên khách và số tiền

### S-022 Chéo tenant (INV-G1)
- Given phòng `u_B` thuộc tổ chức B
- When người dùng tổ chức A gọi `inventory.createHold` hoặc `inventory.getCalendar` trên `u_B`/cơ sở của B
- Then `404 NOT_FOUND`; không allocation nào được tạo

### S-023 Audit + outbox cùng transaction (INV-G6)
- Given mọi command ghi ở mục 5
- When command commit hoặc bị lỗi constraint
- Then commit: đúng 1 `audit_events` + 1 `outbox` cùng `correlation_id`; lỗi: không hàng nào trong 3 bảng

## 3. Ca biên
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | `end` null cho hold; lịch không có phòng; cơ sở chưa có tầng | `422`; lịch rỗng có trạng thái "Chưa có phòng — thêm phòng" | S-004, S-021 |
| Cực đại/độ dài | Lịch 31 ngày × 100 phòng; hold 365 đêm; khoảng mở vô hạn | Lịch phân trang theo phòng, tối đa 62 ngày/lần (đề xuất Q-05); hold dài vẫn kiểm chồng bình thường | S-019, S-021 |
| Trùng lặp/idempotency | Cùng key 100 lần; worker nhả hold 2 lần | 1 hiệu lực; 1 audit | S-006, S-007 |
| Song song | 100 lệnh tranh phòng; huỷ và gia hạn cùng lúc; chuyển phòng đồng thời vào cùng phòng đích | Tối đa 1 allocation hợp lệ; lệnh sau nhận `409`; khoá `units` theo thứ tự id tăng dần khi chạm 2 phòng | S-005, S-015, S-016 |
| Mất mạng giữa chừng | Timeout sau commit `createHold` | Client gọi `GET /api/v1/commands/{command_id}`; không gửi hold mới; UI chỉ báo thành công sau phản hồi máy chủ | S-006 |
| Thời gian/múi giờ | Giáp mốc `[start,end)`; `expires_at` đúng bằng `now` (coi là hết hạn); qua 00:00; hiển thị theo `properties.timezone` | Lưu UTC; so sánh `expires_at <= now()` = hết hạn | S-003, S-007, S-001 |
| Quyền | Khác tổ chức; khác cơ sở; `maintenance` tự duyệt block; `housekeeping` xem tên khách | 404; 403 `FORBIDDEN`; lịch đã lọc trường | S-011, S-021, S-022 |
| Tiền/đơn vị | Chuyển phòng không làm mất/nhân đôi phí; lịch không hiển thị số tiền cho vai trò không được xem | Phí gắn `stay`/`lease`, không gắn phòng | S-015, S-021 |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `allocations` | organization_id, property_id, unit_id, id, kind, source_id, during, active, expires_at, created_by | `tstzrange`, `timestamptz` | EXCLUDE GiST (organization_id =, unit_id =, during &&) WHERE active; `expires_at` NOT NULL ⇔ kind=`hold`; `upper(during)` NULL chỉ khi kind=`lease` | chỉ qua command `inventory.*` |
| `blocks` | organization_id, property_id, unit_id, id, period (`tstzrange`), reason, requested_by, approved_by, status (`requested→approved→ended`; `rejected`), work_order_id? | | `approved_by` ≠ null khi `approved`; có allocation `kind='block'` khi `approved` | đề xuất: xem ma trận F-001; duyệt: owner/manager |
| `units` (thêm) | housekeeping_status, availability, availability_reason | `dirty\|assigned\|cleaning\|clean\|inspected`; `active\|blocked\|out_of_service` | `blocked` suy ra từ block đang hiệu lực, không ghi tay | ghi qua F-007 (vệ sinh) và `inventory.*` |
| `exception` ¹ | organization_id, property_id, id, kind (`STAY_OVERSTAY`, `EXTENSION_CONFLICT`, `LEASE_OVERSTAY` (tạo bởi F-003), `RELOCATION_REQUIRED`), allocation_id, status (`open→resolved`), resolution, resolved_by | | unique (allocation_id, kind) where status=`open` | owner/manager |

Ánh xạ nguồn (DOMAIN-MODEL §3): `hold` → `reservation_items` (hoặc lease nháp, F-003); `stay` → `stays` (tạo khi booking `confirmed`, trạng thái `expected`); `lease` → `leases`; `block` → `blocks`.
¹ DOMAIN-MODEL INV-I4 nhắc `exception` nhưng chưa định nghĩa bảng/tên số nhiều — cần chốt (Q-06).
Migration: cần extension `btree_gist` (ADR-0001); có `down`.

## 5. Giao diện / API
Hợp đồng chi tiết: `docs/design/API-CONTRACT.md`. Mọi command nhận `Idempotency-Key`.

| Command | Input chính | Output | Lỗi |
|---|---|---|---|
| `inventory.createHold` | property_id, unit_id, start, end, source_type, source_id?, ttl_minutes? | allocation_id, expires_at | ROOM_UNAVAILABLE (+alternatives), UNIT_OUT_OF_SERVICE, VALIDATION_FAILED, NOT_FOUND, IDEMPOTENCY_CONFLICT |
| `inventory.releaseHold` | allocation_id, reason | — | INVALID_TRANSITION, NOT_FOUND |
| `inventory.confirmHold` | allocation_id, kind (`stay`\|`lease`), source_id | allocation_id | HOLD_EXPIRED, INVALID_TRANSITION |
| `inventory.resizeAllocation` | allocation_id, start?, end? | allocation | ROOM_UNAVAILABLE (+exception_id), VALIDATION_FAILED |
| `inventory.moveAllocation` | allocation_id, to_unit_id, effective_at, reason | old_allocation, new_allocation | ROOM_UNAVAILABLE, UNIT_OUT_OF_SERVICE, VALIDATION_FAILED |
| `inventory.endAllocation` | allocation_id, at | allocation | INVALID_TRANSITION |
| `inventory.cancelAllocation` | allocation_id, reason | — | INVALID_TRANSITION |
| `inventory.requestBlock` | unit_id, start, end, reason, work_order_id? | block_id | VALIDATION_FAILED |
| `inventory.approveBlock` / `inventory.rejectBlock` | block_id, note | allocation_id | BLOCK_CONFLICT, FORBIDDEN, INVALID_TRANSITION |
| `inventory.endBlock` | block_id, at, reason | — | FORBIDDEN, INVALID_TRANSITION |
| `inventory.setUnitAvailability` | unit_id, availability (`active`\|`out_of_service`), reason | exception_ids | FORBIDDEN |
| `inventory.resolveException` | exception_id, resolution, note | — | INVALID_TRANSITION |
| Job `inventory.expireHolds` / `inventory.detectOverdue` (lượt ở; hợp đồng do `lease.detectOverstay`) | (worker, theo tổ chức) | số bản ghi xử lý | — |

| Query | Input | Output |
|---|---|---|
| `inventory.getCalendar` | property_id, from, to, floor_id?, room_type_id? | phòng × đoạn {kind, nguồn, trạng thái, khoảng địa phương}, vệ sinh, khả dụng |
| `inventory.searchAvailability` | property_id, start, end, guests?, room_type_id? | danh sách phòng trống (đã trừ hold còn hạn, block, `out_of_service`) |
| `inventory.getUnitStatus` | unit_id, at? | 3 chiều + `sellable`, `ready_for_arrival` |
| `inventory.listExceptions` | property_id, status? | danh sách ngoại lệ |

- UI: lịch dạng timeline trên desktop, danh sách theo ngày trên điện thoại; trạng thái luôn có chữ + icon, không chỉ màu; không kéo thả bắt buộc (kế hoạch §09). Trạng thái: đang tải / rỗng / lỗi / thành công sau phản hồi máy chủ. Hold hiển thị đếm ngược đến `expires_at`.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| ROOM_UNAVAILABLE | Chồng allocation (`23P01`) | 409 | Phòng đã có người giữ hoặc đang dùng trong thời gian này. Xem phòng gợi ý. | S-002, S-005, S-016, S-018, S-019 |
| HOLD_EXPIRED | Xác nhận hold đã quá hạn | 409 | Thời gian giữ phòng đã hết. Vui lòng giữ lại. | S-009 |
| BLOCK_CONFLICT | Duyệt block chồng khách đã có | 409 | Khoảng khoá trùng với khách đã xác nhận. Hãy chuyển khách trước. | S-012 |
| UNIT_OUT_OF_SERVICE | Giữ/chuyển vào phòng ngừng khai thác | 409 | Phòng đang ngừng khai thác. | S-013 |
| ROOM_OCCUPIED | Nhận khách vào phòng đang thực tế có người | 409 | Phòng vẫn còn khách chưa trả. | S-017, S-020 |
| INVALID_TRANSITION | Chuyển trạng thái ngoài bảng | 409 | Thao tác không hợp lệ với trạng thái hiện tại. | — |
| IDEMPOTENCY_CONFLICT | Cùng key khác nội dung | 409 | Thao tác trùng mã nhưng khác nội dung. Vui lòng tải lại. | S-006 |
| FORBIDDEN | Không đủ quyền (vd kỹ thuật duyệt block) | 403 | Bạn không có quyền thực hiện thao tác này. | S-011 |
| NOT_FOUND | Tài nguyên khác tổ chức/ngoài phạm vi | 404 | Không tìm thấy dữ liệu. | S-022 |
| VALIDATION_FAILED | Khoảng thời gian sai | 422 | Thời gian bắt đầu phải trước thời gian kết thúc. | S-004 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Độ trễ tạo hold | p95 < 1,5 s ở tải kiểm thử | kế hoạch §17 | k6: 100 tổ chức, 5.000 phòng, 200 phiên, spike 20 ghi/s × 15 phút |
| Độ trễ lịch | p95 < 800 ms cho 100 phòng × 31 ngày | kế hoạch §17 | k6 |
| Đồng thời | 100 lệnh tranh 1 phòng → ≤ 1 allocation; 100 lần cùng payload → 1 hiệu lực | kế hoạch §13 | S-005, S-006 trên Postgres thật |
| Độ trễ nhả hold | Worker quét định kỳ; đúng đắn không phụ thuộc worker (S-008) | kế hoạch §13 | test S-007/S-008; metric độ trễ job |
| Sai lệch tồn | 0 không giải thích được | M-04 | đối chiếu allocation ↔ stays/leases/blocks |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `allocation.hold_created`, `allocation.hold_expired`, `allocation.conflict_rejected` (nguồn: R-004), `allocation.moved`, `block.approved`, `exception.opened` / `exception.resolved` → M-04 (sai lệch tồn), M-05 (tác vụ lõi theo `property_id`).

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 TTL mặc định của hold — [chặn T050] — hỏi: PO — đề xuất: 15 phút cho booking tại quầy, cấu hình theo cơ sở; hold hợp đồng thuê (F-003) theo ngày, tối đa 3 ngày. Kế hoạch chỉ ghi "có hạn", chưa có số.
- [ ] Q-02 Buffer dọn phòng giữa hai khách: dùng giờ nhận/trả (khoảng 12:00→14:00 tự nhiên) hay block buffer riêng (INV-I2) — [không chặn] — hỏi: PO — đề xuất: V1 không tạo buffer tự động; khoảng trống nhận/trả đóng vai buffer, `ready_for_arrival` chặn check-in khi phòng chưa sạch.
- [ ] Q-03 Ngưỡng quá hạn trước khi tạo `STAY_OVERSTAY` — [không chặn] — hỏi: PO — đề xuất: 60 phút sau giờ trả dự kiến (cấu hình theo cơ sở).
- [ ] Q-04 Mốc giờ của allocation hợp đồng (ngày bắt đầu/kết thúc → `timestamptz`) — [không chặn F-002, chặn F-003] — hỏi: PO — đề xuất: 00:00 giờ địa phương của ngày bàn giao đến 00:00 ngày sau ngày trả.
- [ ] Q-05 Giới hạn khoảng truy vấn lịch — [không chặn] — hỏi: Tech Lead — đề xuất: tối đa 62 ngày/lần, phân trang theo phòng.
- [ ] Q-06 Tên bảng ngoại lệ (`exception` trong INV-I4) và có dùng chung cho F-003/F-005 không — [chặn migration] — hỏi: Tech Lead — đề xuất: bảng `exceptions` dùng chung, bổ sung DOMAIN-MODEL §1.
- [ ] Q-07 Cơ sở có bắt buộc `inspected` (không chấp nhận `clean`) trước khi nhận khách — [không chặn] — hỏi: PO — đề xuất: mặc định chấp nhận `clean` hoặc `inspected`, có cờ bắt buộc `inspected`.
- [ ] Q-08 Block đụng khách: ngoài "chuyển khách trước" có cho duyệt block một phần không — [không chặn] — hỏi: PO — đề xuất: không ở pilot; dùng `out_of_service` + exception (S-013).
- [ ] Q-09 Khi quá hạn (khách/hợp đồng) còn mở, có cho giữ phòng đó cho ngày tương lai xa không — [không chặn] — hỏi: PO — đề xuất: không cho mọi hold có `start` trước khi ngoại lệ được giải quyết; hold sau mốc kết thúc mới đã thoả thuận thì được.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · F-001 (tenant, quyền) xong · DOMAIN-MODEL chốt bảng ngoại lệ.
- DoD: mọi S-NNN có test xanh; S-002, S-005–S-010, S-015–S-020 chạy trên Postgres thật · cổng commit/merge xanh · API-CONTRACT cập nhật · sự kiện mục 9 có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T018, T019, T020, T021, T022, T024 | — | .autopilot/evidence/<task>.json |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-002 | (chờ) |
