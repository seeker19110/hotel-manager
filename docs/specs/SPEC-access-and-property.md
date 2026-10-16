# SPEC-access-and-property — Tổ chức, cơ sở, phòng, thành viên và quyền

| Trường | Giá trị |
|---|---|
| ID tính năng | F-001 (luồng liên quan: R-001…R-005 đều phụ thuộc) |
| Trạng thái | Approved — câu [chặn] chốt theo PLAN đợt 3 (tham số hoá, D-002) |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Nguồn | Kế hoạch §03, §09, §11, §12, §16; DOMAIN-MODEL §1, §2, §4–§7; ADR-0001, ADR-0002; backlog T002, T005, T010–T013, T017 |

## 1. User story
- Là **chủ sở hữu**, tôi muốn tạo tổ chức, cơ sở và danh mục phòng rồi mời nhân viên với vai trò, phạm vi cơ sở và hạn mức tiền, để mỗi người chỉ làm đúng việc của mình.
- Là **nhân viên thuộc nhiều tổ chức**, tôi muốn luôn thấy rõ mình đang thao tác ở tổ chức/cơ sở nào, để không ghi nhầm dữ liệu.
- Là **chủ sở hữu**, tôi muốn thu hồi quyền/phiên của nhân viên nghỉ việc và có hiệu lực ngay, để không mất kiểm soát tiền và dữ liệu khách.

## 2. Tiêu chí chấp nhận (Given/When/Then)
Quy ước chung cho mọi scenario (kế hoạch §16; DOMAIN-MODEL INV-G1):
- Tài nguyên mà actor **không có quyền đọc** (tổ chức khác, cơ sở ngoài phạm vi, bảng vai trò không được đọc) → `404 NOT_FOUND`, không lộ việc tồn tại.
- Hành động không được phép trên tài nguyên actor **đọc được** → `403 FORBIDDEN`.
- Lỗi trả `application/problem+json` có `code` (mục 6) và `correlation_id`.

### S-001 Tạo tổ chức và cơ sở đầu tiên với mặc định đúng
- Given người dùng đã đăng nhập, chưa thuộc tổ chức nào
- When gọi `org.create` {tên tổ chức} rồi `property.create` {tên, mẫu=`rental`} không gửi múi giờ/tiền tệ
- Then có `organizations` mới, người tạo có `memberships` vai trò `owner`; cơ sở có `timezone='Asia/Ho_Chi_Minh'`, `currency='VND'`, `business_day_cutoff` = giá trị mặc định đã chốt (Q-01); sự kiện `organization.created`, `property.created` có trong `audit_events` và `outbox`

### S-002 Múi giờ/giờ chốt ngày không hợp lệ
- Given owner của tổ chức A
- When `property.create` với `timezone='GMT+7'` (không phải tên IANA) hoặc `business_day_cutoff='25:00'`
- Then `422 VALIDATION_FAILED`, `errors[].field` chỉ đúng trường sai; không tạo bản ghi

### S-003 Mẫu Hỗn hợp chưa được bật
- Given cờ `mixed_template_enabled=false` (kế hoạch §01: chỉ bật sau khi lịch tài nguyên vượt kiểm thử xung đột)
- When `property.create` với mẫu `mixed`
- Then `409 FEATURE_DISABLED`; mẫu `rental`/`hotel` vẫn tạo được

### S-004 Mã phòng duy nhất theo cơ sở (T017)
- Given cơ sở P1 có phòng mã `101`; cơ sở P2 cùng tổ chức chưa có
- When tạo phòng `101` ở P1 lần nữa; rồi tạo `101` ở P2
- Then lần 1 → `409 UNIT_CODE_TAKEN`; lần 2 → `201`. So sánh mã không phân biệt hoa/thường và bỏ khoảng trắng đầu/cuối

### S-005 Không bán theo giường ở V1 (T002)
- Given owner
- When `unit.create` với `kind='bed'` hoặc `parent_unit_id` khác null
- Then `422 VALIDATION_FAILED` (`kind` chỉ nhận `whole`); schema vẫn giữ cột để mở rộng sau V1

### S-006 Lưu trữ phòng (soft delete danh mục — INV-G7)
- Given phòng `102` có allocation `active` kết thúc sau thời điểm hiện tại
- When `unit.archive` phòng `102`
- Then `409 UNIT_IN_USE`. Khi không còn allocation tương lai: `archived_at` được đặt, phòng biến khỏi lịch bán nhưng vẫn hiện trong lịch sử/chứng từ cũ; không có lệnh DELETE vật lý

### S-007 Mời thành viên và chấp nhận
- Given owner tổ chức A, cơ sở P1
- When `member.invite` {email, vai trò=`front_desk`, phạm vi=[P1], hạn mức giảm giá=100.000} rồi người được mời mở link và đăng nhập đúng email đó
- Then `memberships` mới `status='active'`, vai trò/phạm vi/hạn mức đúng như lời mời; lời mời chuyển `accepted` và không dùng lại được

### S-008 Lời mời hết hạn, đã dùng hoặc sai email
- Given lời mời đã `accepted`, hoặc quá hạn (Q-05), hoặc người mở đăng nhập bằng email khác
- When `member.acceptInvitation`
- Then `410 INVITATION_INVALID`; không tạo membership

### S-009 Thu hồi thành viên có hiệu lực ở request kế tiếp
- Given lễ tân L có membership active ở A và đang có phiên hợp lệ
- When owner gọi `member.revoke` L; sau đó L gửi `inventory.createHold`
- Then request của L → `404 NOT_FOUND` (không còn đọc được tổ chức A); quyền được tra từ `memberships` theo phiên Better Auth ở mỗi request (ADR-0002), không lưu quyền trong token phía client

### S-010 Thu hồi phiên
- Given L có 2 phiên trên 2 thiết bị
- When owner (hoặc chính L) gọi `session.revokeAll` cho L
- Then mọi request tiếp theo dùng phiên cũ → `401 SESSION_REVOKED`; đăng nhập lại tạo phiên mới hoạt động bình thường; có `audit_events` `session.revoked`

### S-011 MFA bắt buộc cho owner/manager/accountant
- Given manager M chưa bật MFA (hoặc phiên hiện tại chưa xác minh MFA)
- When M gọi bất kỳ command ghi nào trừ `auth.enrollMfa`/`auth.verifyMfa`
- Then `403 MFA_REQUIRED`; sau khi xác minh TOTP thành công, cùng command trả `2xx`. `front_desk` không bị chặn bởi luật này (xem Q-06)

### S-012 Giới hạn thử sai đăng nhập/MFA (T010)
- Given tài khoản U
- When nhập sai mật khẩu hoặc mã TOTP vượt ngưỡng trong cửa sổ thời gian (Q-07)
- Then lần vượt ngưỡng → `429 RATE_LIMITED` có `Retry-After`; không tiết lộ tài khoản có tồn tại hay không

### S-013 Chéo tenant qua API, RLS và job (T011)
- Given U thuộc tổ chức A; phòng `u_B` thuộc tổ chức B
- When (a) U gọi `unit.get` `u_B`; (b) truy vấn SQL dưới role `app_runtime` với `app.org_id=A` đọc `units`; (c) INSERT `units` có `organization_id=B` khi `app.org_id=A`; (d) job worker mang payload tổ chức A
- Then (a) `404 NOT_FOUND`; (b) 0 hàng của B; (c) bị RLS từ chối; (d) job chỉ đọc/ghi hàng có `organization_id=A`. Lặp cho tìm kiếm, xuất dữ liệu, file và báo cáo (kế hoạch §16)

### S-014 Không tin `organization_id` client gửi (INV-G1)
- Given U đang ở ngữ cảnh tổ chức A
- When gửi `unit.create` có `organization_id=B` trong body
- Then trường bị bỏ qua; nếu khác ngữ cảnh → `403 FORBIDDEN`, không ghi gì; FK ghép `(organization_id, id)` chặn con trỏ sang cha thuộc tổ chức khác ở DB

### S-015 Vượt phạm vi cơ sở (T012)
- Given lễ tân L có phạm vi [P1]; P2 cùng tổ chức
- When L gọi `inventory.getCalendar` P2 hoặc đổi `property_id` trong request `inventory.createHold` từ P1 sang P2
- Then `404 NOT_FOUND`; không có allocation nào được tạo

### S-016 Ma trận quyền (Scenario Outline)
- Given actor có vai trò `<vai_trò>`, phạm vi chứa cơ sở đích, đã xác minh MFA nếu bắt buộc
- When thực hiện `<hành_động>`
- Then kết quả đúng ô tương ứng ở mục 5.3: `Có`/`Mình` → `2xx`; `—` → `403 FORBIDDEN` (hoặc `404` nếu không đọc được tài nguyên); `HM` vượt hạn mức → `403 APPROVAL_LIMIT_EXCEEDED`
- Examples: sinh tự động từ **toàn bộ** bảng 5.3 (mỗi ô một test, chạy cả ở server và RLS)

### S-017 Hạn mức tiền và yêu cầu duyệt
- Given lễ tân L có hạn mức giảm giá 100.000 đ (giá trị fixture)
- When L áp giảm giá 150.000 đ cho booking
- Then `403 APPROVAL_LIMIT_EXCEEDED`, tạo bản ghi `approval_requests` trạng thái `pending` kèm số tiền, lý do; khi owner duyệt, thao tác được thực hiện đúng một lần, audit ghi người đề xuất và người duyệt

### S-018 Không tự nâng quyền
- Given manager M phạm vi [P1]
- When M gọi `member.updateRole` cho chính mình thành `owner`, hoặc mở rộng phạm vi của mình sang P2, hoặc mời người với vai trò `accountant`/`manager`/`owner`
- Then `403 FORBIDDEN`; `audit_events` ghi lần thử bị từ chối

### S-019 Không thu hồi owner cuối cùng
- Given tổ chức A chỉ có 1 owner active
- When owner đó tự `member.revoke` hoặc hạ vai trò của mình
- Then `409 LAST_OWNER`; membership giữ nguyên

### S-020 Một người thuộc nhiều tổ chức — chọn ngữ cảnh
- Given P là `manager` ở A và `tenant` ở B
- When P đăng nhập và gọi command nghiệp vụ chưa chọn ngữ cảnh; rồi `session.switchOrganization` B
- Then lần đầu → `409 ORG_CONTEXT_REQUIRED` kèm danh sách tổ chức P thuộc về; sau khi chọn B: P chỉ thấy portal người thuê của B, mọi query trả dữ liệu B; phản hồi luôn kèm `context` {tổ chức, cơ sở, vai trò} để UI hiển thị; client nhận tín hiệu xoá cache/hàng chờ theo kế hoạch §10

### S-021 Idempotency của command quản trị (INV-G5)
- Given owner gửi `member.invite` với `Idempotency-Key=k1`
- When gửi lại đúng body với `k1`; rồi gửi body khác (email khác) với `k1`
- Then lần 2 trả **cùng** `invitation_id`, tổng số lời mời = 1; lần 3 → `409 IDEMPOTENCY_CONFLICT`

### S-022 Audit và outbox cùng transaction (INV-G6)
- Given owner đổi vai trò của L từ `front_desk` sang `manager`
- When command commit; và trong lần chạy thử, transaction bị lỗi sau khi ghi `memberships` (tiêm lỗi trong test)
- Then khi commit: có đúng 1 `audit_events` (trước/sau, lý do, `correlation_id`) và 1 `outbox`; khi lỗi: không có membership đổi, không audit, không outbox

### S-023 Đổi múi giờ/giờ chốt ngày khi cơ sở đã có dữ liệu (INV-G2)
- Given cơ sở P1 đã có allocation hoặc chứng từ
- When owner đổi `timezone` hoặc `business_day_cutoff`
- Then `409 PROPERTY_IN_USE` (mặc định đề xuất Q-02); dấu thời gian đã lưu (UTC) không bị đổi

### S-024 Buồng phòng không đọc giấy tờ nhận dạng (kế hoạch §16)
- Given nhân viên `housekeeping` H thuộc P1; `identity_documents` id `d1` của khách ở P1
- When H gọi `identity.get d1`, hoặc xin URL ký cho file của `d1`, hoặc đoán đường dẫn object storage
- Then `404 NOT_FOUND`; không cấp URL ký; truy cập bị từ chối ghi vào audit

### S-025 Lễ tân xác nhận tiền mặt do chính mình nhận trong ca đang mở (INV-F3b, đề xuất chờ PO)
- Given lễ tân L có ca `shifts` đang mở; L ghi nhận `payment.record` tiền mặt 500.000 (method `cash`); lễ tân L2 khác cũng có ca mở và ghi nhận tiền mặt 300.000
- When L gọi `payment.confirm` cho khoản 500.000; rồi L gọi `payment.confirm` cho khoản 300.000 của L2; rồi L (đã đóng ca) xác nhận một khoản tiền mặt mới
- Then lần 1 → `payment` `confirmed`, hệ thống sinh biên nhận, khoản vào đối chiếu đóng ca của L; lần 2 → `403 FORBIDDEN` (không phải tiền do L nhận); lần 3 → `403 FORBIDDEN` (không có ca đang mở); mỗi lần ghi `audit_events`

### S-026 Hạn mức hoàn/khấu trừ cọc theo vai trò (đề xuất chờ PO)
- Given hạn mức mặc định: lễ tân 2.000.000 đ/lần (chỉ khi check-out), quản lý 5.000.000 đ/lần, owner không giới hạn, kế toán chỉ lập đề nghị; cọc khách sạn 3.000.000 đ
- When (a) lễ tân hoàn 2.000.000 lúc check-out; (b) lễ tân hoàn 2.000.001; (c) quản lý duyệt 5.000.000; (d) quản lý duyệt 5.000.001; (e) kế toán gọi `deposit.approveRefund`; (f) người lập đề nghị tự duyệt
- Then (a) thực hiện; (b), (d) → `403 APPROVAL_LIMIT_EXCEEDED` + `approval_requests` `pending`; (c) thực hiện; (e) `403 FORBIDDEN`; (f) `403 SELF_APPROVAL_FORBIDDEN`; owner duyệt được mọi mức

## 3. Ca biên
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Tạo cơ sở không gửi múi giờ/tiền tệ; lời mời không có phạm vi cơ sở | Dùng mặc định `Asia/Ho_Chi_Minh`/VND; vai trò cấp cơ sở mà phạm vi rỗng → `422 VALIDATION_FAILED` (chỉ `owner`/`accountant` được phạm vi "mọi cơ sở") | S-001, S-007 |
| Cực đại/độ dài | Tên cơ sở > 200 ký tự; mã phòng > 20 ký tự; 1 tổ chức 5 cơ sở × 100 phòng | `422`; danh mục phân trang, không quét không giới hạn | S-002, S-004 |
| Trùng lặp/idempotency | Bấm "Mời" 2 lần; mã phòng trùng khác hoa/thường | 1 lời mời; `409 UNIT_CODE_TAKEN` | S-021, S-004 |
| Song song | Hai owner cùng thu hồi nhau khi chỉ còn 2 owner | Khoá hàng `memberships` của tổ chức theo thứ tự id; đúng một lệnh thành công, lệnh sau `409 LAST_OWNER` | S-019 |
| Mất mạng giữa chừng | Timeout sau commit khi mời/thu hồi | Client gọi `GET /api/v1/commands/{command_id}`, không gửi lệnh mới | S-021 |
| Thời gian/múi giờ | Giờ chốt ngày ≠ 00:00; đổi múi giờ khi có dữ liệu; lời mời hết hạn đúng mốc | `business_date` theo giờ chốt; đổi bị chặn; so hạn bằng UTC | S-001, S-023, S-008 |
| Quyền | Khác tổ chức, khác cơ sở, tự nâng quyền, người bị thu hồi, `housekeeping` đọc CCCD, `platform_support` không có cấp tạm thời; lễ tân xác nhận tiền mặt người khác/ngoài ca; kế toán duyệt hoàn | 404/403 theo quy ước mục 2; `platform_support` mặc định không đọc gì (F-015) | S-009, S-013–S-016, S-018, S-024–S-026 |
| Tiền/đơn vị | Hạn mức là `bigint` đồng; hạn mức 0; giá trị âm; đúng bằng/vượt 1 đồng so với hạn mức hoàn cọc | 0 = mọi khoản cần duyệt; âm → `422`; bằng hạn mức được, vượt 1 đ → `APPROVAL_LIMIT_EXCEEDED` | S-017, S-026 |

## 4. Dữ liệu
| Thực thể | Trường chính | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `organizations` | id, name, status, created_by | uuid, text | — | owner ghi; thành viên đọc |
| `properties` | organization_id, id, name, template, timezone, business_day_cutoff, currency, archived_at | text `rental\|hotel\|mixed`, text IANA, `time`, `char(3)` | timezone kiểm IANA; currency mặc định `VND` | owner ghi; thành viên trong phạm vi đọc |
| `floors` ¹ | organization_id, property_id, id, name, sort_order | | unique (property_id, name) | owner/manager |
| `units` | organization_id, property_id, floor_id, room_type_id, id, code, kind, archived_at | `kind` = `whole` | unique (property_id, lower(trim(code))) where archived_at is null | owner/manager ghi |
| `memberships` | organization_id, id, auth_user_id, person_id, role, status, valid_from, valid_to, limits (jsonb: discount, refund, price_override — `bigint` đồng) | | role thuộc 9 vai trò DOMAIN-MODEL §6 | owner ghi; manager ghi giới hạn (mục 5.3) |
| `property_scopes` ¹ | organization_id, membership_id, property_id | | unique (membership_id, property_id) | owner |
| `invitations` ² | organization_id, id, email, role, property_ids, limits, token_hash, expires_at, status | | token lưu hash; dùng một lần | owner/manager |
| `approval_requests` ² | organization_id, id, kind, amount, reason, requested_by, approved_by, status | | người duyệt ≠ người đề xuất | xem mục 5.3 |
| `audit_events`, `outbox`, `idempotency_keys` | theo DOMAIN-MODEL INV-G5, INV-G6 | | | hệ thống ghi |

¹ Tên lấy từ kế hoạch §12. ² Tên đề xuất khi viết spec. Cả bốn bảng (`floors`, `property_scopes`, `invitations`, `approval_requests`) đã có trong DOMAIN-MODEL §7 (v1.2) — tên ở đó là chuẩn.
- Mọi bảng trên có `organization_id NOT NULL`, RLS theo `app.org_id`, FK ghép `(organization_id, id)` (INV-G1). Migration: viết ở T-003+, có `down`.
- Phiên và MFA do Better Auth giữ trong cùng Postgres (ADR-0002, phiên lưu DB nên thu hồi có hiệu lực ngay); `persons`/`memberships` của mình chỉ tham chiếu `auth_user_id`.

## 5. Giao diện / API
Hợp đồng chi tiết: `docs/design/API-CONTRACT.md`. Mọi command nhận `Idempotency-Key`; mọi phản hồi có `context`.

### 5.1 Command
| Tên | Input chính | Output | Lỗi |
|---|---|---|---|
| `org.create` | name | organization_id, membership_id | VALIDATION_FAILED |
| `property.create` / `property.update` | name, template, timezone?, business_day_cutoff?, check_in_time?, check_out_time? | property_id | VALIDATION_FAILED, FEATURE_DISABLED, PROPERTY_IN_USE, FORBIDDEN |
| `floor.create` / `floor.update` | property_id, name, sort_order | floor_id | VALIDATION_FAILED |
| `unit.create` / `unit.update` / `unit.archive` | property_id, floor_id, code, room_type_id?, kind | unit_id | UNIT_CODE_TAKEN, UNIT_IN_USE, VALIDATION_FAILED |
| `member.invite` | email, role, property_ids, limits | invitation_id, expires_at | FORBIDDEN, VALIDATION_FAILED, IDEMPOTENCY_CONFLICT |
| `member.acceptInvitation` | token | membership_id | INVITATION_INVALID |
| `member.updateRole` / `member.updateScope` / `member.updateLimits` | membership_id, … , reason | membership | FORBIDDEN, LAST_OWNER |
| `member.revoke` | membership_id, reason | — | FORBIDDEN, LAST_OWNER |
| `session.revokeAll` | membership_id hoặc self | revoked_count | FORBIDDEN |
| `session.switchOrganization` | organization_id, property_id? | context | NOT_FOUND |
| `auth.enrollMfa` / `auth.verifyMfa` | (plugin `twoFactor` của Better Auth) | mfa_verified | RATE_LIMITED |
| `approval.decide` | approval_request_id, decision, note | status | FORBIDDEN, SELF_APPROVAL_FORBIDDEN, INVALID_TRANSITION |

### 5.2 Query
`org.listMine` (các tổ chức của người dùng) · `property.list` · `unit.list` {property_id, floor_id?, include_archived?} · `member.list` · `session.listMine` · `approval.listPending` · `context.get`.

### 5.3 Ma trận quyền (vai trò × hành động)
Ký hiệu: **Có** = được trong phạm vi cơ sở · **HM** = trong hạn mức, vượt → tạo `approval_requests` · **Mình** = chỉ bản ghi của mình/được giao · **Đọc** = chỉ xem · **Đề nghị** = chỉ lập yêu cầu, không duyệt · **—** = không. `platform_support`: mặc định **—** toàn bộ; chỉ có quyền tạm thời theo F-015.

| Hành động | owner | manager | front_desk | accountant | housekeeping | maintenance | tenant | guest |
|---|---|---|---|---|---|---|---|---|
| Sửa tổ chức; tạo cơ sở; múi giờ/giờ chốt/mẫu | Có | — | — | — | — | — | — | — |
| Tầng, phòng (tạo/sửa/lưu trữ) | Có | Có | — | — | — | — | — | — |
| Loại phòng, bảng giá (F-006) | Có | — ³ | — | — | — | — | — | — |
| Mời/thu hồi `owner`/`manager`/`accountant` | Có | — | — | — | — | — | — | — |
| Mời/thu hồi `front_desk`/`housekeeping`/`maintenance` | Có | Có ³ | — | — | — | — | — | — |
| Đổi vai trò, phạm vi, hạn mức | Có | — | — | — | — | — | — | — |
| Thu hồi phiên người khác | Có | Có ³ | — | — | — | — | — | — |
| Xem lịch phòng (có tên khách) | Có | Có | Có | Đọc | — | — | — | — |
| Xem lịch phòng (chỉ số phòng, trống/có khách, vệ sinh) | Có | Có | Có | Có | Có | Có | — | — |
| Tạo hold/booking, đổi ngày, huỷ, check-in/out | Có | Có | Có | — | — | — | — | — |
| Thông báo lưu trú: xuất mẫu, đánh dấu đã thông báo (`stay.exportResidenceNotice`/`stay.markNoticeSubmitted`) | Có | Có | Có | — | — | — | — | — |
| Đổi giá/giảm giá trên booking | Có | HM | HM | — | — | — | — | — |
| Check-out còn công nợ | Có | Có | — (cần manager duyệt) | — | — | — | — | — |
| Chuyển phòng | Có | Có | Có | — | — | — | — | — |
| Đề xuất block | Có | Có | Có | — | — | Có | — | — |
| Duyệt/kết thúc block | Có | Có | — | — | — | — | — | — |
| Bật/tắt phòng ngừng khai thác (`inventory.setUnitAvailability`) | Có | Có | — | — | — | — | — | — |
| Xử lý ngoại lệ lịch (`inventory.resolveException`) | Có | Có | — | — | — | — | — | — |
| Ghi dịch vụ/phụ thu vào folio | Có | Có | Có | — | — | — | — | — |
| Xem số tiền, folio, công nợ | Có | Có | Có | Có | — | — | Mình | Mình |
| Ghi nhận thanh toán (F-005) | Có | Có | Có | Có | — | — | — | — |
| Xác nhận thanh toán chuyển khoản có chứng cứ (INV-F3) | Có | Có | — ³ | Có | — | — | — | — |
| Xác nhận tiền mặt (INV-F3b): `payment.confirm` method `cash` | Có | Có | Mình (tiền mặt do chính mình nhận, trong ca đang mở) ³ | Có | — | — | — | — |
| Nhận cọc (`deposit.receive`) | Có | Có | Có (kèm biên nhận; tiền mặt theo INV-F3b) | Có | — | — | — | — |
| Phân bổ tiền, điều chỉnh có lý do | Có | HM | — | Có | — | — | — | — |
| Hoàn/khấu trừ cọc (`deposit.requestRefund`/`approveRefund`, `requestDeduction`/`approveDeduction`; INV-F5) | Có (không giới hạn) | HM (≤ 5.000.000 đ/lần) ³ | HM (≤ 2.000.000 đ/lần, chỉ khi check-out) ³ | Đề nghị | — | — | — | — |
| Hoàn ứng trước (`credit.requestRefund`/`credit.approveRefund`) | Có (không giới hạn) | HM (≤ 5.000.000 đ/lần) ³ | HM (≤ 2.000.000 đ/lần, chỉ khi check-out) ³ | Đề nghị | — | — | — | — |
| Mở/đóng ca quầy (`shift.open`/`shift.close`) | Có | Có | Mình (ca của mình) | Có (đối chiếu) | — | — | — | — |
| Bàn giao ca (`shift.handover` — người nhận xác nhận, không tự nhận ca của mình) | Có | Có | Mình (giao/nhận ca của mình) | Có (đối chiếu, không nhận tiền) | — | — | — | — |
| Chốt kỳ (`billing.lockPeriod`/`ledger.lockPeriod`) | Có | Có | — | Có | — | — | — | — |
| Mở khoá kỳ (`ledger.unlockPeriod`, `locked → issued`; INV-F6) | Có (lý do + audit) | — | — | — | — | — | — | — |
| Lập hợp đồng, ký, kích hoạt (`lease.createDraft`/`updateDraft`/`submitForSignature`/`sign`/`activate`/`renew`/`giveNotice`) | Có | Có | — | — | — | — | — | — |
| Giữ chỗ hợp đồng (`lease.hold`, TTL 48 giờ cấu hình) | Có | Có | Có ³ | — | — | — | — | — |
| Bàn giao nhận/trả phòng (`lease.recordHandover`) | Có | Có | Có ³ | — | — | — | Xác nhận phần mình | — |
| Lập quyết toán/thanh lý (`lease.prepareSettlement`) | Có | Có | — | Đề nghị | — | — | — | — |
| Duyệt quyết toán/thanh lý (`lease.approveSettlement`, `lease.close`) | Có | HM (khoản hoàn/khấu trừ ≤ 5.000.000 đ/lần) ³ | — | — | — | — | — | — |
| Nhập chỉ số công tơ (`meter.recordReading`) | Có | Có | Có | — | — | Mình (nếu được giao) | — | — |
| Thay công tơ (`meter.replace`) | Có | Có | — | — | — | — | — | — |
| Tạo/xem trước/gửi duyệt kỳ thu (`billing.createPeriod`/`previewPeriod`/`submitForReview`/`returnToDraft`) | Có | Có | — | Có | — | — | — | — |
| Phát hành kỳ thu (`billing.issuePeriod`) | Có | Có | — | Có ³ | — | — | — | — |
| Chuẩn bị nhập liệu (`import.prepare`: upload/validate) | Có | Có | — | — | — | — | — | — |
| Xác nhận/commit nhập liệu có số dư tiền (`import.confirm`/`import.commit`) | Có | — | — | — | — | — | — | — |
| Mời người thuê vào portal | Có | Có | Có ³ | — | — | — | — | — |
| Tạo/thu hồi link khách (`portal.createGuestLink`/`revokeGuestLink`) | Có | Có | Có | — | — | — | — | — |
| Cấu hình thông báo (`notification_settings`) | Có | Có ³ | — | — | — | — | — | — |
| Đọc `identity_documents` | Có | Có | Có | — | — | — | Mình | — |
| Tạo/giao việc dọn | Có | Có | Có | — | Mình (nhận việc) | — | — | — |
| Cập nhật tiến độ việc dọn | Có | Có | — | — | Mình | — | — | — |
| Nghiệm thu (`verified`) việc dọn/sự cố | Có | Có | — | — | — | — | — | — |
| Tạo phiếu sự cố | Có | Có | Có | — | Có | Có | Mình (F-008) | — |
| Xử lý phiếu sự cố | Có | Có | — | — | — | Mình | — | — |
| Xem audit | Có | Có | — | Có (tiền) | — | — | — | — |
| Xuất dữ liệu (xác thực lại) | Có | — | — | Có (tiền) | — | — | — | — |

³ Đề xuất mặc định, chờ PO chốt (Q-04, Q-06, Q-11). Nguồn vai trò và giới hạn: kế hoạch §03, §16; DOMAIN-MODEL §6.

**Quy tắc hạn mức hoàn/khấu trừ (đề xuất, chờ PO — Q-11):** lễ tân ≤ 2.000.000 đ/lần và chỉ khi check-out; quản lý ≤ 5.000.000 đ/lần; owner không giới hạn; kế toán chỉ lập đề nghị, không duyệt; người lập không tự duyệt (`SELF_APPROVAL_FORBIDDEN`). Vượt hạn mức → `403 APPROVAL_LIMIT_EXCEEDED` và tạo `approval_requests`. Hạn mức lưu ở `memberships.limits` (jsonb, `bigint` đồng), các số trên là mặc định theo vai trò.
**Quy tắc tiền mặt (INV-F3b, đề xuất chờ PO):** lễ tân chỉ xác nhận tiền mặt **do chính mình nhận trong ca đang mở** (người nhận = người xác nhận = chủ ca); tiền mặt của người khác hoặc ngoài ca → `403 FORBIDDEN`. Quản lý/kế toán/owner xác nhận theo quyền, kèm chứng cứ.
**Mở khoá kỳ:** chỉ owner, có lý do và audit; mở khoá không cho sửa chứng từ đã phát hành, chỉ cho thêm điều chỉnh/đảo (DOMAIN-MODEL §4).

### 5.4 Trạng thái UI
- Thanh ngữ cảnh luôn hiện tên tổ chức + cơ sở + vai trò (kế hoạch §09). Đổi ngữ cảnh có bước xác nhận.
- Danh sách thành viên: đang tải / rỗng ("Chưa có nhân viên — mời người đầu tiên") / lỗi có hướng sửa / thành công chỉ sau phản hồi máy chủ.
- Tiếp cận: vùng chạm ≥ 44 CSS px, label cho mọi trường, mã TOTP nhập bằng bàn phím số, lỗi đọc được bằng trình đọc màn hình (WCAG 2.2 AA).

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| UNAUTHENTICATED | Không có/hết phiên | 401 | Phiên đăng nhập đã hết. Vui lòng đăng nhập lại. | — |
| SESSION_REVOKED | Phiên đã bị thu hồi | 401 | Phiên này đã bị đăng xuất. Vui lòng đăng nhập lại. | S-010 |
| MFA_REQUIRED | Vai trò bắt buộc MFA chưa xác minh | 403 | Cần xác thực hai lớp trước khi tiếp tục. | S-011 |
| FORBIDDEN | Không có quyền trên tài nguyên đọc được | 403 | Bạn không có quyền thực hiện thao tác này. | S-014, S-016, S-018 |
| APPROVAL_LIMIT_EXCEEDED | Vượt hạn mức tiền | 403 | Số tiền vượt hạn mức của bạn. Đã gửi yêu cầu duyệt. | S-017 |
| SELF_APPROVAL_FORBIDDEN | Người đề xuất tự duyệt (dùng chung SPEC-ledger-payments) | 403 | Bạn không thể tự duyệt chứng từ mình lập. | S-017 |
| NOT_FOUND | Không tồn tại hoặc không được đọc | 404 | Không tìm thấy dữ liệu. | S-009, S-013, S-015, S-024 |
| INVITATION_INVALID | Lời mời hết hạn/đã dùng/sai email | 410 | Lời mời không còn hiệu lực. Hãy nhờ quản trị gửi lại. | S-008 |
| UNIT_CODE_TAKEN | Trùng mã phòng trong cơ sở | 409 | Mã phòng đã tồn tại trong cơ sở này. | S-004 |
| UNIT_IN_USE | Lưu trữ phòng còn lịch tương lai | 409 | Phòng còn lịch sử dụng sắp tới, chưa thể lưu trữ. | S-006 |
| PROPERTY_IN_USE | Đổi múi giờ/giờ chốt khi đã có dữ liệu | 409 | Cơ sở đã có giao dịch, không thể đổi múi giờ hoặc giờ chốt ngày. | S-023 |
| FEATURE_DISABLED | Mẫu `mixed` chưa bật | 409 | Mẫu Hỗn hợp chưa được mở. | S-003 |
| LAST_OWNER | Thu hồi/hạ owner cuối | 409 | Tổ chức phải còn ít nhất một chủ sở hữu. | S-019 |
| ORG_CONTEXT_REQUIRED | Thuộc nhiều tổ chức, chưa chọn | 409 | Hãy chọn tổ chức bạn đang làm việc. | S-020 |
| INVALID_TRANSITION | Duyệt yêu cầu đã xử lý | 409 | Yêu cầu này đã được xử lý. | — |
| IDEMPOTENCY_CONFLICT | Cùng key, khác nội dung | 409 | Thao tác trùng mã nhưng khác nội dung. Vui lòng tải lại. | S-021 |
| VALIDATION_FAILED | Dữ liệu không hợp lệ | 422 | Thông tin chưa hợp lệ, xem các trường được đánh dấu. | S-002, S-005 |
| RATE_LIMITED | Vượt ngưỡng thử | 429 | Bạn thử quá nhiều lần. Vui lòng đợi rồi thử lại. | S-012 |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Độ trễ API | p95 < 800 ms | PROJECT §5, kế hoạch §17 | k6, bộ 100 tổ chức/5.000 phòng/200 phiên |
| Hiệu lực thu hồi | Request kế tiếp sau commit bị chặn | kế hoạch §16 | test tích hợp S-009, S-010 |
| Cách ly | 0 hàng chéo tenant ở API, SQL, job, file, export, tìm kiếm | kế hoạch §16, INV-G1 | test chéo tenant trên Postgres thật |
| Bảo mật | ASVS 5.0 L2 cho xác thực/phiên/quyền | PROJECT §5 | CI + pentest tuần 21–22 |
| Tiếp cận | WCAG 2.2 AA; vùng chạm ≥ 44 CSS px | kế hoạch §09 | axe trong E2E |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `organization.created`, `property.created`, `member.invited`, `member.accepted`, `member.revoked`, `session.revoked`, `access.denied` (code, action) → hỗ trợ M-02 (hoàn thành thiết lập) và giám sát bảo mật; `property_id` trên mọi sự kiện cho M-05.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [x] Q-01 Giờ chốt ngày kinh doanh mặc định — [chặn] — hỏi: PO — đề xuất: 00:00 giờ địa phương cho mẫu `rental`; cấu hình được cho `hotel` với mặc định chờ quan sát T001 (PROJECT §10 đã ghi câu này là chặn F-006). — **Quyết 2026-10-16 (PLAN đợt 3, phiên chính tự duyệt — D-002):** 00:00 giờ địa phương (mặc định cột `properties.business_day_cutoff`), cấu hình theo cơ sở.
- [ ] Q-02 Có cho đổi múi giờ/giờ chốt khi đã có dữ liệu không — [không chặn] — hỏi: PO + Tech Lead — đề xuất: chặn (S-023); đổi giờ chốt chỉ áp từ `business_date` sau ngày khoá kỳ gần nhất, làm ở V1.
- [x] Q-03 Giờ nhận/trả phòng mặc định của cơ sở `hotel` — [chặn F-006] — hỏi: PO — xem SPEC-reservation-stay Q-01. — **Quyết 2026-10-16 (PLAN đợt 3, phiên chính tự duyệt — D-002):** theo SPEC-reservation-stay Q-01 (14:00/12:00 khi cơ sở chưa đặt).
- [ ] Q-04 Manager có được mời/thu hồi `front_desk`/`housekeeping`/`maintenance` và chỉnh bảng giá không — [không chặn] — hỏi: PO — đề xuất: được mời/thu hồi trong phạm vi; **không** chỉnh bảng giá (kế hoạch §03 giao "giá" cho owner).
- [ ] Q-05 Thời hạn lời mời — [không chặn] — hỏi: PO — đề xuất: 7 ngày, dùng một lần, gắn email.
- [x] Q-06 Lễ tân có hạn mức hoàn tiền/xác nhận tiền mặt có bắt buộc MFA không (kế hoạch §16 ghi "MFA chủ/quản lý/tiền") — [chặn] — hỏi: PO + Tech Lead — đề xuất: bắt buộc MFA cho mọi membership có hạn mức hoàn > 0 hoặc quyền xác nhận thanh toán. — **Quyết 2026-10-15 (PLAN đợt 1, chủ dự án duyệt):** bắt buộc MFA cho owner/manager/accountant/front_desk và mọi membership có hạn mức tiền > 0 (`requiresMfa`, T-006).
- [x] Q-07 Ngưỡng thử sai và thời gian hết phiên nhân viên — [chặn T010] — hỏi: Tech Lead — đề xuất: khoá tạm 15 phút sau 5 lần sai; phiên không hoạt động 12 giờ; xác thực lại cho xuất dữ liệu/đổi quyền. Cấu hình qua rate limit và `session.expiresIn`/`updateAge` của Better Auth (ADR-0002); kiểm bằng test ở T-004. — **Quyết 2026-10-15 (PLAN đợt 1, chủ dự án duyệt):** 5 lần sai → khoá 15 phút; phiên rảnh 12 giờ; là tham số (T-006).
- [x] Q-08 Quy trình khôi phục tài khoản khi mất thiết bị MFA (kế hoạch §16 "account recovery được kiểm tra") — [chặn pilot] — hỏi: PO + Tech Lead — đề xuất: owner khác reset MFA có audit; owner duy nhất → qua hỗ trợ nền tảng có xác minh danh tính (F-015). — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** owner khác reset MFA của thành viên (bắt xác thực lại, thu hồi phiên, audit); không tự reset; owner duy nhất → hỗ trợ nền tảng (F-015, ngoài đợt 2). Thực hiện ở PLAN đợt 2 T-116: command `member.resetMfa` (`membership_id`, lý do; quyền `member.change_role`) xoá TOTP + mã dự phòng, tắt cờ 2FA, thu hồi mọi phiên, audit `member.mfa_reset` + outbox; tự đặt lại → 403 kèm `items[{recovery: another_owner|platform_support}]`; tài khoản còn membership CHƯA THU HỒI ở tổ chức khác (kể cả tạm khoá — hàm `app.memberships_elsewhere`, migration 0022) → 403 `platform_support` (owner một tổ chức không hạ bảo mật tổ chức khác). Test: `packages/app/src/access/mfa-recovery.db.test.ts`.
- [ ] Q-09 `accountant` có phạm vi "mọi cơ sở" mặc định không — [không chặn] — hỏi: PO — đề xuất: có, owner thu hẹp được.
- [x] Q-10 Bổ sung vào DOMAIN-MODEL các bảng `floors`, `property_scopes`, `invitations`, `approval_requests` — đã đóng: có ở DOMAIN-MODEL §7 (v1.2).
- [x] Q-11 Hạn mức hoàn/khấu trừ cọc và hoàn ứng trước (lễ tân ≤ 2.000.000 đ/lần khi check-out, quản lý ≤ 5.000.000 đ/lần, owner không giới hạn, kế toán chỉ lập đề nghị) và quyền lễ tân xác nhận tiền mặt do mình nhận trong ca mở (INV-F3b) — [chặn pilot] — hỏi: PO + kế toán — đề xuất: như ma trận 5.3; hạn mức cấu hình được ở `memberships.limits`. — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** như đề xuất; số chốt một chỗ ở SPEC-ledger-payments mục 10.
- [x] Q-12 Giữ chỗ hợp đồng `lease.hold` — TTL 48 giờ (cấu hình theo cơ sở) và vai trò được giữ — [không chặn] — hỏi: PO — đề xuất: 48 giờ; owner/manager/lễ tân (khớp SPEC-lease, SPEC-inventory-allocation Q-01). — **Quyết 2026-10-15 (PLAN đợt 2, chủ dự án duyệt):** 48 giờ (`properties.lease_hold_ttl_hours`); owner/manager/lễ tân được giữ.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · DOMAIN-MODEL §7 đã có các bảng (Q-10 đã đóng) · mỗi task có Gate.
- DoD: mọi S-NNN có test xanh (S-013, S-016 chạy trên Postgres thật) · ma trận 5.3 sinh test tự động · cổng commit/merge xanh · API-CONTRACT cập nhật · sự kiện mục 9 có schema.

## 12. Truy vết
| Task | PR | Bằng chứng |
|---|---|---|
| T002, T005, T010, T011, T012, T013, T017 | — | .autopilot/evidence/<task>.json |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-001 | (chờ) |
| 2 | 2026-10-15 | sửa theo review độc lập: bổ sung ma trận 5.3 (hợp đồng, giữ chỗ, bàn giao, quyết toán, công tơ, kỳ thu, cọc, hoàn ứng trước, ca, import, mời người thuê, link khách, `setUnitAvailability`, `resolveException`, thông báo, thông báo lưu trú); hạn mức hoàn/khấu trừ và quyền xác nhận tiền mặt của lễ tân (S-025, S-026, Q-11, Q-12); S-009 theo phiên Better Auth (ADR-0002); đóng Q-10 | review O5, R4, O11, G5 | (chờ) |
