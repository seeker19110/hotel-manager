# SPEC-audit-reporting — Nhật ký audit, màn "Hôm nay", báo cáo và xuất dữ liệu

| Trường | Giá trị |
|---|---|
| ID tính năng | F-012 (yêu cầu gốc: R-001 "công nợ cập nhật", R-005 "đối chiếu tổng"; kế hoạch §08, §09, §16, §17; backlog T014, T039, T085 phần cơ bản) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 2 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) ngày (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Ngày | 2026-10-15 |
| Phụ thuộc | DOMAIN-MODEL INV-G4, INV-G6, §5 (sổ phụ), §6 (vai trò); SPEC-access-and-property (MFA, xác thực lại), SPEC-ledger-payments, SPEC-inventory-allocation, SPEC-notifications (`export_ready`) |

## 1. User story
- Là **chủ cơ sở**, tôi muốn biết ai đã đổi tiền, phòng, hợp đồng, lúc nào, trước/sau ra sao và vì sao, để phát hiện sai sót hoặc gian lận.
- Là **quản lý/lễ tân**, tôi muốn mở "Hôm nay" thấy ngay khách đến/đi, nợ đến hạn, kỳ thu cần duyệt, phòng cần dọn và sự cố, để làm đúng việc trong ca.
- Là **kế toán/chủ**, tôi muốn báo cáo công nợ, tiền đã thu theo phương thức/ca, cọc đang giữ và công suất cơ bản có tổng khớp chi tiết, rồi xuất CSV/XLSX an toàn, để đối chiếu với sổ cũ và chuyển cho kế toán.

Ngoài phạm vi pilot: báo cáo doanh thu ghi nhận (chờ kế toán — PROJECT §10), ADR/RevPAR (T063), tổng hợp nhiều cơ sở có drill-down (T068), xuất dữ liệu đầy đủ kèm file ảnh (T085 bản đủ).

## 2. Tiêu chí chấp nhận (Given/When/Then)
Dữ liệu mẫu (DOMAIN-MODEL §5): tổ chức B có cơ sở `HS1` (trọ) và `HS2` (khách sạn). Phiếu phòng 101 `HS1`: tổng 3.580.000, đã phân bổ 2.000.000 (chuyển khoản), còn **1.580.000**, hạn 2026-10-10; cọc **3.000.000**. Folio phòng 203 `HS2`: tổng 1.430.000, ứng trước 500.000 (tiền mặt) đã phân bổ, còn **930.000**.

### S-001 Audit ghi cùng transaction
- Given kế toán xác nhận thanh toán 2.000.000 với lý do "Sao kê VCB 10/10"
- When command commit
- Then có đúng 1 `audit_events` `payment.confirmed` với `actor_person_id`, `occurred_at` (UTC), `before.status=pending`, `after.status=confirmed`, `reason`, `correlation_id` trùng header `X-Correlation-Id` của request, `command_id`; nếu transaction rollback thì không có audit

### S-002 Audit không chứa secret và CCCD nguyên vẹn
- Given lễ tân cập nhật hồ sơ khách có số CCCD `012345678901` và đổi mật khẩu của chính mình
- When đọc `audit_events` tương ứng
- Then trường CCCD lưu `********8901`; không có mật khẩu, token, OTP, khoá API (giá trị `[REDACTED]`); test quét toàn bảng sau bộ E2E không tìm thấy chuỗi `012345678901`

### S-003 Audit là append-only
- Given một `audit_events` đã ghi
- When role `app_runtime` chạy `UPDATE` hoặc `DELETE` trên bảng
- Then DB từ chối (trigger/quyền); test trên Postgres thật

### S-004 Xem nhật ký theo quyền
- Examples:

| Vai trò (phạm vi) | Gọi `audit.listEvents` | Kết quả |
|---|---|---|
| `owner` | toàn tổ chức | 200, mọi sự kiện của B |
| `manager` (chỉ `HS1`) | không lọc | 200, chỉ sự kiện `property_id=HS1` hoặc cấp tổ chức được phép |
| `manager` (chỉ `HS1`) | `property_id=HS2` (cơ sở ngoài phạm vi) | 404 `NOT_FOUND` (quy ước SPEC-access-and-property mục 2), không lộ việc `HS2` tồn tại |
| `accountant` | không lọc | 200, chỉ nhóm sự kiện tiền (payment, invoice, deposit, period_lock) |
| `housekeeping`, `tenant` | bất kỳ | 403 `FORBIDDEN` |

### S-005 Lọc nhật ký theo `correlation_id`
- Given một request tạo 3 sự kiện (giữ phòng, cọc, outbox) cùng `correlation_id=c-9`
- When owner lọc `correlation_id=c-9`
- Then trả đúng 3 sự kiện, sắp theo `occurred_at`, hiển thị giờ theo múi giờ cơ sở

### S-006 Màn "Hôm nay" cho quản lý
- Given `HS1`/`HS2`, ngày kinh doanh 2026-10-15 (giờ chốt ngày theo cấu hình cơ sở): 3 khách đến, 2 khách đi, 1 phiếu quá hạn (101), 1 kỳ thu `reviewing`, 4 phòng `dirty`, 2 phiếu việc `open`
- When quản lý phạm vi `HS1`+`HS2` mở "Hôm nay"
- Then các thẻ hiện đúng số: Khách đến 3 · Khách đi 2 · Nợ đến hạn/quá hạn 1 · Kỳ thu cần duyệt 1 · Phòng cần dọn 4 · Sự cố 2; bấm thẻ mở danh sách chi tiết có đúng số dòng đó

### S-007 "Hôm nay" theo vai trò
- Given như S-006
- When `housekeeping` mở "Hôm nay"
- Then chỉ thấy "Phòng cần dọn" và "Sự cố"; không có thẻ hay số tiền nào; API `today.getSummary` không trả trường tiền cho vai trò này

### S-008 "Hôm nay" theo ngày kinh doanh
- Given cơ sở có giờ chốt ngày 04:00 (giá trị test), hiện là 01:30 ngày 2026-10-16 giờ cơ sở
- When mở "Hôm nay"
- Then ngày kinh doanh hiển thị là 15/10/2026 (INV-G2)

### S-009 Báo cáo công nợ — tổng khớp chi tiết và sổ
- Given dữ liệu mẫu, ngày chốt 2026-10-15
- When owner chạy `reports.receivables` cho cả tổ chức
- Then chi tiết: phiếu 101 = 1.580.000 (quá hạn 5 ngày), folio 203 = 930.000; tổng = **2.510.000** = Σ chi tiết = số dư tài khoản `AR` trên sổ phụ tại ngày chốt; cọc **không** bị trừ vào nợ

### S-010 Báo cáo thu tiền theo phương thức/ca
- Given hai thanh toán `confirmed` ngày 2026-10-10…15: 2.000.000 chuyển khoản (`HS1`), 500.000 tiền mặt (`HS2`); một thanh toán `pending` 1.580.000
- When chạy `reports.collections` từ 2026-10-10 đến 2026-10-15, nhóm theo phương thức
- Then Chuyển khoản 2.000.000 · Tiền mặt 500.000 · Tổng **2.500.000**; khoản `pending` không được tính; báo cáo ghi rõ "Tiền đã thu — không phải doanh thu"; khi có `shifts` (F-013) thì nhóm thêm theo ca, pilot nhóm theo ngày kinh doanh + người xác nhận

### S-011 Báo cáo cọc đang giữ
- Given cọc 3.000.000 của hợp đồng phòng 101, chưa hoàn/khấu trừ
- When chạy `reports.depositsHeld`
- Then 1 dòng 3.000.000; tổng = số dư `DEPOSIT_LIAB` trên sổ phụ; sau khi hoàn 1.000.000 (có duyệt) thì còn 2.000.000

### S-012 Công suất cơ bản
- Given `HS1` có 10 phòng, ngày 2026-10-15: 7 phòng có allocation `lease`/`stay`, 1 phòng `blocked`
- When chạy `reports.occupancy` ngày đó
- Then phòng đang ở 7, phòng khả dụng 9 (trừ block — theo đề xuất Q-04), công suất **77,8%**; hold không tính là đang ở

### S-013 Xuất CSV cần quyền riêng
- Given `manager` (ma trận SPEC-access-and-property: không có quyền xuất dữ liệu)
- When gọi `exports.request`
- Then 403 `FORBIDDEN`; nút "Xuất" không hiện trong UI

### S-014 Xuất cần xác thực lại
- Given owner có quyền, lần xác thực gần nhất cách đây > 5 phút (đề xuất Q-06)
- When gọi `exports.request`
- Then 401 `REAUTH_REQUIRED`; sau khi nhập lại mật khẩu/MFA thì gọi lại thành công 202 kèm `export_id`, trạng thái `queued`

### S-015 Xuất chạy job và link có hạn
- Given `export_id` đã tạo
- When worker hoàn tất
- Then `export_jobs.status=ready`, file nằm ở bucket riêng tư; người yêu cầu nhận thông báo `export_ready`; `exports.download` trả URL ký hết hạn sau 15 phút (đề xuất Q-06); chỉ người yêu cầu tải được; tải sau hạn → 410 `LINK_EXPIRED`; audit có `export.requested`, `export.completed`, `export.downloaded`

### S-016 Chống CSV formula injection
- Given tên người trả là `=HYPERLINK("http://x","bấm")` và ghi chú bắt đầu bằng `+`, `-`, `@`, tab, CR
- When xuất CSV và XLSX
- Then ô tương ứng bắt đầu bằng `'` (CSV) hoặc được ghi kiểu chuỗi (XLSX); mở bằng trình đọc bảng tính không thực thi công thức; số tiền vẫn là số nguyên (không bị thêm `'`)

### S-017 Xuất không vượt phạm vi
- Given `accountant` phạm vi chỉ `HS1`, có quyền xuất nhóm tiền (ma trận SPEC-access-and-property)
- When accountant xuất công nợ không lọc, rồi xuất với `property_id=HS2`
- Then lần 1 file chỉ có dòng `HS1`; lần 2 (cơ sở ngoài phạm vi) → 404 `NOT_FOUND`, không tạo `export_jobs`; job worker chạy với `app.org_id` và phạm vi của người yêu cầu tại thời điểm chạy (thu hồi quyền trước khi job chạy → job `failed` lý do `FORBIDDEN`)

### S-018 Xuất toàn bộ dữ liệu tổ chức (cơ bản)
- Given owner đã xác thực lại
- When gọi `exports.requestOrgExport`
- Then job tạo ZIP gồm CSV UTF-8 cho các thực thể nghiệp vụ của tổ chức B (không có dữ liệu tổ chức khác); không gồm file ảnh và số giấy tờ (Q-05); link có hạn; audit đủ như S-015

### S-019 Phân trang và giới hạn khoảng thời gian
- Given nhật ký có 50.000 sự kiện
- When owner xem nhật ký hoặc báo cáo khoảng > 366 ngày (đề xuất)
- Then nhật ký phân trang keyset 50 dòng/trang; báo cáo khoảng quá lớn → 422 `REPORT_RANGE_TOO_LARGE` "Khoảng thời gian quá dài. Hãy chọn ngắn hơn hoặc dùng Xuất dữ liệu."

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Không có dữ liệu trong khoảng; `reason` rỗng ở hành động bắt buộc lý do | Báo cáo trả dòng tổng = 0 và trạng thái rỗng; thiếu lý do → 422 `VALIDATION_FAILED` ở command gốc | S-009 |
| Cực đại/độ dài | 50.000 sự kiện; xuất lớn; `before/after` jsonb lớn | Phân trang keyset; xuất luôn qua job; `before/after` chỉ lưu trường thay đổi | S-015, S-019 |
| Trùng lặp/idempotency | Bấm xuất hai lần; job xuất chạy lại | Cùng `Idempotency-Key` → cùng `export_id`; job chạy lại ghi đè cùng file, không tạo export thứ hai | S-015 |
| Song song | Thanh toán được xác nhận khi báo cáo đang chạy | Báo cáo đọc trong một snapshot (`REPEATABLE READ`), ghi "số liệu tại {thời điểm}" | S-009 |
| Mất mạng giữa chừng | Mất mạng khi đang tải file | Tải lại bằng link còn hạn; hết hạn → yêu cầu link mới (xác thực lại nếu quá hạn) | S-015 |
| Thời gian/múi giờ | Ranh giới ngày kinh doanh, giờ chốt, báo cáo theo ngày địa phương | Lọc theo `business_date`/ngày địa phương của cơ sở; lưu UTC | S-008, S-010 |
| Quyền | Vai trò không có quyền, phạm vi cơ sở, quyền bị thu hồi giữa chừng, tenant | 403 (vai trò không có quyền); 404 (cơ sở ngoài phạm vi); xuất không vượt phạm vi; job kiểm quyền lại khi chạy | S-004, S-013, S-017 |
| Tiền/đơn vị | Tổng phải khớp chi tiết và sổ; tách tiền thu/cọc/doanh thu | VND số nguyên; tổng tính ở DB; test so với số dư `AR`, `DEPOSIT_LIAB` | S-009–S-011 |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `audit_events` (có sẵn, INV-G6) | `id`, `organization_id`, `property_id` (null nếu cấp tổ chức), `occurred_at timestamptz`, `actor_type` (`user`/`worker`/`platform_support`), `actor_person_id`, `action` (dạng `payment.confirmed`), `entity_type`, `entity_id`, `before jsonb`, `after jsonb`, `reason`, `correlation_id`, `command_id` | | Append-only (trigger); trường nhạy cảm che/loại ở `packages/app` trước khi ghi | Command ghi cùng transaction; owner/manager/accountant đọc theo S-004 |
| `export_jobs` (**mới**) | `id`, `organization_id`, `requested_by`, `kind` (`receivables`/`collections`/`deposits`/`occupancy`/`audit`/`org_full`), `format` (`csv`/`xlsx`/`zip`), `filters jsonb`, `scope_snapshot jsonb`, `status` (`queued → running → ready`; `failed`; `expired`), `file_key`, `expires_at`, `row_count` | | `expires_at NOT NULL` khi `ready` | Người yêu cầu đọc; worker ghi |
| Báo cáo | Không có bảng riêng; truy vấn từ `journal_lines`, `invoices`, `payments`, `payment_allocations`, `deposits`, `allocations` | | Tổng tính bằng SQL, không cộng ở client | — |

- Danh sách trường bị che/loại khỏi audit (đề xuất, chốt ở T014): số CCCD/hộ chiếu (giữ 4 số cuối), mật khẩu, token phiên, OTP, secret, URL ký. `export_jobs` đã có ở DOMAIN-MODEL §7 (Q-07); danh sách trường `audit_events` chốt ở T014. Migration ở T014/T039 (rollback được).

## 5. Giao diện / API
| Loại | Tên | Mô tả |
|---|---|---|
| Query | `audit.listEvents` / `audit.getEvent` | Lọc thời gian, cơ sở, người, `entity`, `action`, `correlation_id`; keyset |
| Query | `today.getSummary` / `today.listItems` | Thẻ và danh sách theo vai trò, cơ sở, ngày kinh doanh |
| Query | `reports.receivables` | Công nợ theo phiếu/người trả/cơ sở, số ngày quá hạn, ngày chốt |
| Query | `reports.collections` | Tiền đã thu (`confirmed`) theo phương thức, ngày, người xác nhận, ca (khi có) |
| Query | `reports.depositsHeld` | Cọc đang giữ theo hợp đồng/lượt ở |
| Query | `reports.occupancy` | Công suất cơ bản theo ngày/cơ sở |
| Command | `exports.request` / `exports.requestOrgExport` | Cần quyền xuất (owner; accountant cho nhóm tiền — ma trận SPEC-access-and-property) + xác thực lại; `requestOrgExport` chỉ owner; trả 202 + `export_id` |
| Query | `exports.getStatus` / `exports.listMine` | |
| Command | `exports.download` | Tạo URL ký ngắn hạn; ghi audit |

- Trạng thái UI:

| Màn | Đang tải | Rỗng | Lỗi | Thành công |
|---|---|---|---|---|
| Hôm nay | khung xương 6 thẻ | thẻ hiện "0" kèm "Không có việc" | thông điệp theo mã + "Thử lại" | thẻ số + danh sách |
| Báo cáo | khung xương bảng | "Không có dữ liệu trong khoảng đã chọn" + dòng tổng 0 | như trên | bảng + dòng tổng + "Số liệu tại {giờ}" |
| Nhật ký | khung xương | "Chưa có sự kiện phù hợp bộ lọc" | như trên | dòng: thời điểm, người, hành động, đối tượng; mở rộng để xem trước/sau |
| Xuất | "Đang chuẩn bị file…" (`queued`/`running`) | — | `failed` có lý do; `REAUTH_REQUIRED` mở hộp xác thực | "File đã sẵn sàng — tải trong 15 phút" |

- Tiếp cận: bảng báo cáo dùng `<table>` có `<caption>`, `<th scope>`; số tiền căn phải, đọc được bằng trình đọc màn hình; thẻ "Hôm nay" là liên kết có tên đầy đủ ("Khách đến hôm nay: 3"); trạng thái có chữ + icon; vùng chạm ≥ 44 px; trên mobile bảng chuyển thành danh sách thẻ, không cuộn ngang bắt buộc.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| `FORBIDDEN` | Vai trò không có quyền xem/xuất trên tài nguyên đọc được | 403 | Bạn không có quyền thực hiện thao tác này. | S-004, S-013 |
| `NOT_FOUND` | `export_id`/sự kiện không thuộc người dùng; cơ sở ngoài phạm vi của actor (quy ước SPEC-access-and-property mục 2) | 404 | Không tìm thấy dữ liệu. | S-004, S-017 |
| `VALIDATION_FAILED` | Bộ lọc sai (ngày kết thúc < bắt đầu) | 422 | Thông tin chưa hợp lệ: {trường}. | — |
| `REPORT_RANGE_TOO_LARGE` | Khoảng quá dài cho xem trực tiếp | 422 | Khoảng thời gian quá dài. Hãy chọn ngắn hơn hoặc dùng Xuất dữ liệu. | S-019 |
| `REAUTH_REQUIRED` | Xuất khi chưa xác thực lại gần đây | 401 | Vui lòng xác thực lại để xuất dữ liệu. | S-014 |
| `EXPORT_NOT_READY` | Tải khi job chưa xong | 409 | File đang được chuẩn bị. Vui lòng đợi. | — |
| `LINK_EXPIRED` | Link tải quá hạn / export `expired` | 410 | Liên kết tải đã hết hạn. Hãy tạo yêu cầu xuất mới. | S-015 |
| `IDEMPOTENCY_CONFLICT` | Cùng key khác bộ lọc | 409 | Yêu cầu bị trùng mã thao tác. Vui lòng tải lại. | — |
| `RATE_LIMITED` | Quá số yêu cầu xuất (đề xuất 10/giờ/người) | 429 | Bạn đã yêu cầu xuất quá nhiều lần. Vui lòng thử lại sau. | — |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng | p95 < 800 ms cho "Hôm nay" và báo cáo trong giới hạn xem trực tiếp; xuất lớn chạy job | PROJECT §5, kế hoạch §17 | k6 trên bộ 100 tổ chức/5.000 phòng |
| Đúng số | Tổng = Σ chi tiết = số dư sổ phụ tương ứng; 0 sai lệch không giải thích (M-04) | kế hoạch §08, T039 | test tích hợp + property test |
| Cách ly | Báo cáo/xuất/job không trả dữ liệu tổ chức hoặc cơ sở khác | kế hoạch §16 | test chéo tenant trên API, file, worker |
| Bảo vệ audit | Append-only; không secret/CCCD nguyên vẹn | T014, kế hoạch §16 | S-002, S-003 |
| Xuất | Quyền riêng, xác thực lại, link có hạn, audit, chống formula injection | kế hoạch §16 | S-013–S-017 |

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `today.viewed`, `report.viewed` (thuộc tính `kind`), `export.requested`, `export.downloaded`, `audit.viewed` (không PII) → M-04 (sai lệch tiền/tồn), M-05 (dùng hằng tuần theo `property_id`); dùng `reconciliation_break` cho M-04.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 Bộ báo cáo **bắt buộc** cho pilot (tuần 12) và cột tối thiểu mỗi báo cáo — **[chặn]** — hỏi: PO + đại diện pilot + kế toán — **đề xuất mặc định:** 4 báo cáo ở S-009–S-012 + nhật ký; cột theo mục 5; đối chiếu với sổ Excel của 2 cơ sở pilot ở T078.
- [ ] Q-02 Báo cáo thu theo "ca" khi F-013 (ca quầy) là Should — [không chặn] — hỏi: PO — **đề xuất:** pilot nhóm theo ngày kinh doanh + người xác nhận; thêm nhóm theo ca khi T065 xong.
- [ ] Q-03 Nhóm tuổi nợ (0–30/31–60/>60 ngày) có cần không? — [không chặn] — hỏi: kế toán — **đề xuất:** pilot chỉ "số ngày quá hạn" từng phiếu.
- [ ] Q-04 Mẫu số công suất: trừ phòng `blocked`/`out_of_service` hay không — [không chặn pilot; chặn T063] — hỏi: PO — **đề xuất:** phòng khả dụng = phòng `active` không bị block trong ngày; ghi công thức trên báo cáo.
- [ ] Q-05 Xuất toàn bộ có gồm số giấy tờ/ảnh không (quyền mang dữ liệu vs dữ liệu nhạy cảm) — [không chặn bản cơ bản] — hỏi: pháp lý — **đề xuất:** bản cơ bản loại trừ; bản đủ (T085) chờ DPIA.
- [ ] Q-06 Cửa sổ xác thực lại và thời hạn link tải — [không chặn] — hỏi: Tech Lead + PO — **đề xuất:** xác thực lại trong 5 phút trước khi xuất; link 15 phút; file xoá sau 24 giờ.
- [x] Q-07 Bổ sung `export_jobs` vào DOMAIN-MODEL — đã đóng: có ở DOMAIN-MODEL §7 (v1.2). Danh sách trường `audit_events` còn chốt ở T014 (không chặn).
- [ ] Q-08 Thư viện ghi XLSX — [không chặn] — hỏi: Tech Lead — **đề xuất:** chọn ở T039 qua `/research` (giấy phép OSI, đang bảo trì, ghim phiên bản), ghi vào ADR mới; nếu chưa có thì pilot chỉ xuất CSV UTF-8 có BOM.
- [ ] Q-09 Thời gian giữ `audit_events` — [không chặn] — hỏi: pháp lý — **đề xuất:** theo lịch retention ở DPIA (kế hoạch §16 "Vòng đời dữ liệu"); chưa xoá trong pilot.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · sổ phụ và phân bổ (F-005) có API query công khai · mỗi task có Gate.
- DoD: mọi S-NNN có test xanh (S-001–S-003, S-009–S-012, S-017 chạy trên Postgres thật) · ca biên có test · cổng commit/merge xanh · OpenAPI cập nhật · sự kiện có schema · blueprint tick có bằng chứng.

## 12. Truy vết
| Task | PR | Bằng chứng (CI/evidence) |
|---|---|---|
| T014 (audit log, mã tương quan) | — | — |
| T039 (báo cáo thu chi, nợ, cọc, export) | — | — |
| T085 (phần cơ bản: xuất toàn bộ tổ chức) | — | — |

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-012 | (chưa) |
| 2 | 2026-10-15 | sửa theo review độc lập: S-004, S-017 cơ sở ngoài phạm vi trả 404 `NOT_FOUND` theo quy ước access (không 403), cập nhật bảng lỗi mục 6; đóng Q-07 | review O6, G5 | (chưa) |
