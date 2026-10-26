# DOMAIN-MODEL — từ điển, thực thể, trạng thái và bất biến (G4)

> Phiên bản 1.3 · 2026-10-15 (1.2: sửa sau review độc lập; 1.3: thêm `receiving_accounts` — tài khoản nhận tiền của cơ sở, khoá của INV-F4b) · Trạng thái: Draft, chờ duyệt.
> Nguồn: kế hoạch gốc §05–§08, §12–§13.
> Mọi SPEC dùng **đúng tên** ở đây; đổi tên phải sửa file này trước. Schema SQL chi tiết viết ở T-003 trở đi, theo đúng tài liệu này.

## 1. Từ điển (Ubiquitous language)

| Thuật ngữ | Bảng | Định nghĩa | Không nhầm với |
|---|---|---|---|
| Tổ chức | `organizations` | Khách hàng SaaS (chủ kinh doanh), là ranh giới tenant | Người thuê phòng |
| Cơ sở | `properties` | Một địa điểm kinh doanh, có múi giờ, giờ chốt ngày, mẫu (Trọ/Khách sạn/Hỗn hợp) | Toà nhà/tầng |
| Phòng | `units` | Đơn vị bán/cho thuê nguyên căn. V1 không bán theo giường | Loại phòng |
| Loại phòng | `room_types` | Nhóm phòng cùng sức chứa và bảng giá (khách sạn) | |
| Thành viên | `memberships` | Quan hệ người dùng ↔ tổ chức kèm vai trò, phạm vi cơ sở, thời hạn | Tài khoản đăng nhập (`auth_user_id`) |
| Cá nhân | `persons` | Người thật được ghi nhận: người thuê, người ở, khách, người trả tiền | Thành viên nhân viên |
| Phân bổ phòng | `allocations` | Khoảng `[start,end)` một phòng bị chiếm bởi hold, hợp đồng, lượt ở hoặc block | Phân bổ tiền |
| Giữ chỗ | `allocations.kind='hold'` | Allocation có `expires_at`, chưa phải cam kết | |
| Block | `blocks` + allocation | Khoá phòng vì bảo trì/ngừng khai thác, có lý do và người duyệt | Trạng thái vệ sinh |
| Hợp đồng thuê | `leases` + `lease_versions` | Cam kết thuê dài hạn; điều khoản, giá, dịch vụ theo **phiên bản có hiệu lực** | Booking |
| Bàn giao | `handovers` | Biên bản nhận/trả phòng: chỉ số công tơ, tài sản, chìa khoá, ảnh, xác nhận | Check-in khách sạn |
| Booking | `reservations` + `reservation_items` | Đặt phòng ngắn hạn, có thể nhiều dòng phòng | Lượt ở |
| Lượt ở | `stays` | Khách thực ở một phòng cụ thể (check-in → check-out) | Booking |
| Người ở theo hợp đồng | `lease_occupants` | Người ở thực tế của hợp đồng (khác người ký/người trả) | Người thuê ký |
| Giấy tờ nhận dạng | `identity_documents` | Số/ảnh CCCD, hộ chiếu (dữ liệu nhạy cảm): số mã hoá tầng app + blind index (D-004), chỉ hiển thị 4 số cuối; file riêng tư; retention riêng | |
| Folio | (khung nhìn trên `charges` + `payment_allocations` theo `stay`/`reservation`) | Tổng hợp các khoản phải thu và đã trả của một lượt ở | Hoá đơn thuế |
| Công tơ | `meters` | Đồng hồ điện/nước gắn với phòng; thay công tơ tạo sự kiện reset | |
| Chỉ số | `meter_readings` | Giá trị đọc tại một thời điểm, có ảnh và trạng thái nháp/đã duyệt | |
| Kỳ thu | `billing_periods` | Một đợt tính tiền của cơ sở (thường theo tháng): Nháp → Duyệt → Phát hành → Khoá | |
| Khoản phí | `charges` | Một dòng phải thu, có snapshot giá, lượng, đơn giá, quy tắc làm tròn, nguồn (kỳ thu/folio) | |
| Phiếu tính tiền | `invoices` + `invoice_lines` | Chứng từ nghiệp vụ gom các khoản phí gửi cho người trả. **Không phải hoá đơn điện tử** | HĐĐT |
| Thanh toán | `payments` | Tiền thực nhận hoặc chi ra (tiền mặt, chuyển khoản), có chứng cứ; Chờ xác nhận → Đã xác nhận | Phân bổ |
| Phân bổ tiền | `payment_allocations` | Nối một thanh toán với một hay nhiều phiếu | Phân bổ phòng |
| Cọc | `deposits` | Nghĩa vụ phải hoàn cho khách; **không phải doanh thu** | Ứng trước |
| Ứng trước | `payments` chưa phân bổ / số dư khách | Tiền khách trả trước, sẽ được phân bổ vào phiếu | Cọc |
| Bút toán | `journal_entries` + `journal_lines` | Ghi sổ phụ cân bằng (Σ Nợ = Σ Có), append-only | |
| Chốt kỳ / chốt ca | `period_locks`, `shifts` | Sau khi khoá, mọi thay đổi tiền phải đi qua điều chỉnh/đảo có duyệt. Pilot có **ca quầy tối thiểu**: mở ca (tiền đầu ca), đóng ca (đếm tiền, chênh lệch, người giao/nhận xác nhận) | |
| Giao dịch ngân hàng | `bank_transactions` | Một khoản tiền vào tài khoản nhận, định danh bằng `(receiving_account_id, bank_txn_ref)`; mọi nguồn (webhook, sao kê, nhập tay kèm sao kê) quy về đây | Inbox (sự kiện của từng nguồn) |
| Ngày kinh doanh | (cột `business_date` trên chứng từ, không phải bảng) | Ngày địa phương của cơ sở, tính theo giờ chốt ngày (không phải ngày UTC) | |
| Lệnh | `idempotency_keys` | Một thao tác ghi có `command_id`; replay trả cùng kết quả | |

## 2. Quy tắc dữ liệu chung (bất biến toàn hệ)

- **INV-G1 Tenant:** mọi bảng nghiệp vụ có `organization_id NOT NULL`. Bảng thuộc cơ sở có thêm `property_id`. Foreign key ghép `(organization_id, id)` để con không trỏ sang tổ chức khác. RLS lọc theo `current_setting('app.org_id')`; runtime role `app_runtime` không phải owner và không có BYPASSRLS. Server lấy `organization_id` từ membership, **không tin giá trị client gửi**.
- **INV-G2 Thời gian:** `timestamptz` lưu UTC; `properties.timezone` (IANA, mặc định `Asia/Ho_Chi_Minh`). Ngày thuê, kỳ thu và `business_date` là kiểu `date` địa phương.
- **INV-G3 Tiền:** VND là `bigint` đồng, không dùng float ở DB, API hay UI. Lượng và đơn giá phân số dùng `numeric`. Mỗi chứng từ lưu `currency`, `tax_profile_id`, `rounding_rule`, `formula_version`. Chỉ có một hàm làm tròn dùng chung (`packages/domain/money`).
- **INV-G4 Bất biến chứng từ:** chứng từ đã phát hành hoặc ghi sổ không bị UPDATE/DELETE nội dung tiền (trigger chặn). Sửa bằng chứng từ đảo/điều chỉnh tham chiếu bản gốc, có lý do và người duyệt. Ngoại lệ có kiểm soát duy nhất: `lease_versions.superseded_on` đặt một lần (NULL → ngày) khi phụ lục thay phiên bản không thời hạn — điều khoản và băm không đổi (D-007).
- **INV-G5 Idempotency:** mọi command ghi nhận `Idempotency-Key`, lưu `(organization_id, key)` unique cùng `request_hash`, kết quả và hạn. Cùng key + cùng hash → trả kết quả cũ. Cùng key + khác hash → 409.
- **INV-G6 Audit + outbox cùng transaction:** command ghi dữ liệu nghiệp vụ, `audit_events` (chủ thể, trước/sau, lý do, `correlation_id`) và `outbox` trong **một** transaction. Gửi ra ngoài làm sau khi commit.
- **INV-G7 Xoá:** soft delete chỉ áp cho danh mục. Dữ liệu nhận dạng có retention riêng; xoá hoặc ẩn danh kèm tombstone.

## 3. Lịch tài nguyên (Inventory)

```sql
-- phác thảo, không phải migration
allocations(organization_id, property_id, unit_id, id,
            kind  text check (kind in ('hold','lease','stay','block')),
            source_id uuid,            -- reservation_item / lease / stay / block
            during tstzrange not null, -- [start, end); end NULL = khoảng mở (hợp đồng không thời hạn)
            active boolean not null default true,
            expires_at timestamptz,    -- chỉ cho hold
            EXCLUDE USING gist (organization_id WITH =, unit_id WITH =, during WITH &&) WHERE (active))
```

- **INV-I1:** hai allocation `active` trên cùng phòng không được chồng thời gian. Kiểm ở DB trong cùng transaction. Lỗi `23P01` được dịch thành mã `ROOM_UNAVAILABLE`.
- **INV-I2:** khoảng là `[start,end)` nên `end` của khách trước được trùng `start` của khách sau. Thời gian dọn được thể hiện bằng buffer hoặc block, không cộng hai lần.
- **INV-I3:** hold hết hạn **không** được lọc bằng `now()` trong partial index. Có hai cách nhả: worker chuyển `active=false`, hoặc command mới khoá phòng rồi dọn hold hết hạn trước khi insert. Mỗi hold chỉ được nhả đúng một lần (audit một sự kiện).
- **INV-I4:** khách chưa trả phòng thì allocation không tự kết thúc. Kéo dài mà đụng booking đã xác nhận → tạo `exception` để quản lý tái bố trí. Không lưu âm thầm và không bỏ ràng buộc.
- **Ba chiều trạng thái độc lập của phòng:** chiếm dụng (tính từ allocation) · vệ sinh (`dirty → assigned → cleaning → clean → inspected`) · khả dụng (`active | blocked | out_of_service`). "Sạch" không có nghĩa là còn trống.

## 4. Vòng đời

| Thực thể | Trạng thái | Chuyển không hợp lệ |
|---|---|---|
| Booking | `draft → held → confirmed → in_house → checked_out`; nhánh `cancelled`, `no_show`; `held → expired`; walk-in: khởi tạo → `in_house` (một command) | nhảy từ `draft` sang `in_house`; huỷ sau `checked_out` |
| Lượt ở | `expected → in_house → checked_out`; `expected → cancelled`; `expected → no_show` (khi booking no-show); walk-in: khởi tạo → `in_house` | check-out khi chưa check-in |
| Hợp đồng | `draft → pending_signature → signed_awaiting_handover → active → notice_given → settling → closed`; `draft`/`pending_signature`/`signed_awaiting_handover` → `cancelled` | `active` khi chưa có bàn giao; `closed` khi chưa quyết toán |
| Kỳ thu | `draft → reviewing → issued → locked`; `reviewing → draft` (trả lại để sửa chỉ số); `locked → issued` chỉ owner, có lý do + audit (mở khoá **không** cho sửa chứng từ đã phát hành, chỉ cho thêm điều chỉnh/đảo ghi ngày trong kỳ). `billing_periods.status='locked'` ⇔ có `period_locks` hiệu lực cho kỳ đó (một cơ chế) | sửa số sau `issued` (phải dùng điều chỉnh) |
| Thanh toán | `pending → confirmed`; `confirmed → reversed` (bằng chứng từ đảo) | `pending → reversed`; xác nhận hai lần |
| Phiếu việc | `open → assigned → in_progress → done → verified`; `cancelled` | `verified` bởi chính người làm (khi bật tách quyền) → `SELF_APPROVAL_FORBIDDEN` |

Tự duyệt hoặc tự nghiệm thu khi quy tắc cấm luôn trả `SELF_APPROVAL_FORBIDDEN` (403), không dùng `INVALID_TRANSITION`.
Mọi chuyển trạng thái đi qua bảng chuyển khai báo trong `packages/domain`. Chuyển ngoài bảng bị từ chối với mã `INVALID_TRANSITION` và được ghi audit.

## 5. Tài chính — sổ phụ cân bằng

Tài khoản sổ phụ (V1, theo từng tổ chức; chưa phải hệ thống tài khoản pháp định):

| Mã | Tài khoản | Loại |
|---|---|---|
| `CASH` | Tiền mặt tại quầy (theo ca) | Tài sản |
| `BANK` | Tiền gửi ngân hàng (theo tài khoản nhận) | Tài sản |
| `AR` | Phải thu khách/người thuê | Tài sản |
| `DEPOSIT_LIAB` | Nghĩa vụ cọc phải hoàn | Nợ phải trả |
| `CUSTOMER_CREDIT` | Ứng trước, trả thừa chưa phân bổ | Nợ phải trả |
| `REV_ROOM` / `REV_UTIL` / `REV_SERVICE` / `REV_FEE` | Doanh thu phòng / điện nước / dịch vụ / phí khác | Doanh thu |
| `DISCOUNT` | Giảm trừ | Giảm doanh thu |
| `OPENING_BALANCE` | Đối ứng số dư đầu kỳ khi chuyển dữ liệu (nợ/cọc/ứng trước mở đầu); không phải doanh thu | Vốn/đối ứng |

| Sự kiện | Bút toán |
|---|---|
| Phát hành phiếu | Nợ `AR` / Có `REV_*` theo từng dòng |
| Nhận cọc | Nợ `CASH`/`BANK` / Có `DEPOSIT_LIAB` |
| Nhận thanh toán (chưa phân bổ) | Nợ `CASH`/`BANK` / Có `CUSTOMER_CREDIT` |
| Phân bổ vào phiếu | Nợ `CUSTOMER_CREDIT` / Có `AR` |
| Phát sinh phí khi thanh lý/check-out (hư hỏng, vệ sinh, phạt đã thoả thuận) | Tạo `charges`/phiếu **trước**: Nợ `AR` / Có `REV_FEE` |
| Khấu trừ cọc vào nợ (có duyệt) | Nợ `DEPOSIT_LIAB` / Có `AR` — chỉ tới số AR còn mở của các phiếu được liên kết (INV-F2) |
| Hoàn cọc | Nợ `DEPOSIT_LIAB` / Có `CASH`/`BANK` |
| Hoàn ứng trước / trả thừa (có duyệt) | Nợ `CUSTOMER_CREDIT` / Có `CASH`/`BANK` |
| Chênh lệch ca (thiếu/thừa tiền mặt) | Ghi `shift_discrepancy` có người chịu trách nhiệm; bút toán điều chỉnh do người có quyền duyệt, không tự sửa số dư |
| Đảo | Bút toán ngược, có `reverses_entry_id` |
| Số dư đầu kỳ (import) | Nợ `AR` / Có `OPENING_BALANCE` (nợ cũ); Nợ `OPENING_BALANCE` / Có `DEPOSIT_LIAB` (cọc đang giữ) |

- **INV-F1:** mỗi bút toán có Σ Nợ = Σ Có (constraint trigger deferred). Dòng bút toán là append-only.
- **INV-F2:** Σ phân bổ của một thanh toán ≤ số tiền thanh toán; Σ phân bổ vào một phiếu ≤ tổng phiếu. Kiểm trong transaction và khoá hàng `payments`/`invoices` theo thứ tự id tăng dần.
- **INV-F3b (tiền mặt, đề xuất chờ PO):** tiền mặt — kể cả nhận cọc — đi qua cùng luồng `payments` (`pending → confirmed`), không ghi thẳng `CASH`. Lễ tân được xác nhận tiền mặt **do chính mình nhận trong ca đang mở**, hệ thống sinh biên nhận; số này vào đối chiếu đóng ca.
- **INV-F3:** thanh toán chỉ chuyển sang `confirmed` khi có chứng cứ: người có quyền xác nhận kèm ảnh/sao kê, hoặc webhook đã xác minh chữ ký. Màn hình "khách bấm đã chuyển" hay ảnh chụp **không** đủ.
- **INV-F4:** mỗi nguồn ghi `inbox` với khoá unique `(provider, account, provider_event_id)`; trùng ID mà khác hash → báo động, không ghi tiền.
- **INV-F4b (chống trùng xuyên nguồn):** mọi khoản tiền ngân hàng quy về `bank_transactions` unique `(receiving_account_id, bank_txn_ref)`; `payments` loại chuyển khoản phải tham chiếu đúng một `bank_transaction_id` (unique) **khi chuyển sang `confirmed`**; lúc `pending` (vd tạo từ `payment_claims`) được để trống. Webhook + sao kê + nhập tay của cùng một giao dịch → **một** payment.
- **INV-F5:** cọc không tự trừ vào nợ. Khấu trừ cần lý do, **người duyệt khác người lập** và chứng từ liên kết. Ngoại lệ duy nhất (đề xuất, chờ PO): **hoàn nguyên số cọc khách sạn, không khấu trừ, lúc check-out, trong hạn mức lễ tân** là một bước do lễ tân thực hiện (không có quyết định nào để duyệt; tiền ra tính vào ca của người đó). Mọi khấu trừ, hoàn ứng trước và hoàn vượt hạn mức vẫn cần người thứ hai.
- **INV-F6:** sau `period_locks` hoặc chốt ca, chỉ được thêm chứng từ điều chỉnh/đảo, phải có quyền duyệt.
- **Ví dụ kiểm thử bắt buộc (từ kế hoạch):**
  - Trọ: 3.000.000 + (1.350 − 1.250) × 3.000 + 12 × 15.000 + 100.000 = **3.580.000**; đã phân bổ 2.000.000 → còn **1.580.000**. Cọc 3.000.000 theo dõi riêng.
  - Khách sạn: 2 × 600.000 + 80.000 + 150.000 = **1.430.000**; ứng trước 500.000 đã phân bổ → còn **930.000**.

## 6. Quyền (tóm tắt — ma trận đầy đủ ở SPEC-access-and-property)

Vai trò: `owner` · `manager` · `front_desk` · `accountant` · `housekeeping` · `maintenance` · `tenant` (portal) · `guest` (link có hạn) · `platform_support` (tách riêng, cấp tạm thời: owner cấp qua lời mời email kèm lý do, hạn ≤ 72 giờ, CHỈ ĐỌC, mọi truy cập ghi audit `support.accessed` — D-128, T-2313).
Quyền = (vai trò, hành động, phạm vi cơ sở, hạn mức tiền). Kiểm ở server (`packages/app`) **và** ở RLS. Giao diện chỉ ẩn/hiện để người dùng dễ hiểu.
`housekeeping` không đọc `identity_documents` và không xem số tiền.

## 7. Bảng bổ sung từ SPEC (v1.1, 2026-10-15)

Các bảng dưới đây xuất hiện khi viết SPEC. Tên ở đây là chuẩn; mọi bảng đều theo INV-G1 (có `organization_id`, FK ghép, RLS).

| Nhóm | Bảng | Mục đích | SPEC |
|---|---|---|---|
| Quyền | `floors`, `property_scopes`, `invitations` | Tầng; phạm vi cơ sở của membership; lời mời có hạn | access-and-property |
| Phê duyệt | `approval_requests` | Yêu cầu duyệt (hoàn, khấu trừ cọc, điều chỉnh, mở khoá kỳ) có hạn mức, cấm tự duyệt | ledger-payments, lease, access |
| Lịch | `exceptions` | Ngoại lệ cần quản lý xử lý: `LEASE_OVERSTAY`, `STAY_OVERSTAY`, `RELOCATION_REQUIRED`, `EXTENSION_CONFLICT` | inventory-allocation, reservation-stay |
| Khách sạn | `rate_plans` | Bảng giá theo loại phòng, ngày thường/cuối tuần, hiệu lực | reservation-stay |
| Vận hành | `tasks`, `work_orders`, `files`, `identity_documents`, `residence_notices` (xuất mẫu + đánh dấu đã thông báo lưu trú) | Việc buồng phòng; phiếu sự cố/sửa chữa; metadata file riêng tư | housekeeping-maintenance |
| Tính tiền | `services`, `service_prices`, `meter_events` | Danh mục dịch vụ; giá có hiệu lực; lắp/thay/reset công tơ | metering-billing |
| Hợp đồng | `lease_settlements`, `lease_occupants` (giữ chỗ hợp đồng = allocation `hold` có TTL riêng, xem SPEC-lease) | Quyết toán khi thanh lý (nợ, khấu trừ, hoàn) | lease |
| Tiền | `receiving_accounts`, `bank_transactions`, `reconciliation_breaks`, `payment_claims`, `shift_discrepancies` | Chênh lệch đối soát có chủ xử lý; "khách báo đã chuyển" (**không** tạo `payments`/bút toán) | ledger-payments, portal |
| Portal | `guest_access_links` | Link khách có token băm, hạn, thu hồi, phạm vi một lượt ở | portal |
| Import | `import_batches`, `import_rows`, `import_external_refs` | Lô import, dòng + lỗi, khoá chống import lặp | import |
| Thông báo | `notifications`, `notification_deliveries`, `notification_preferences`, `notification_settings` | Thông báo trong app; lần gửi theo kênh; opt-in/out; lịch nhắc theo cơ sở | notifications |
| Báo cáo | `export_jobs` | Xuất dữ liệu chạy nền, link có hạn, audit | audit-reporting |
| Quyền riêng tư | `consent_records` | Bằng chứng đồng ý theo mục đích của **tài khoản** (append-only: mỗi lần cho/rút một hàng; trạng thái = hàng mới nhất; phiên bản + băm văn bản đã hiển thị, kênh). Ngoại lệ INV-G1: không `organization_id`, RLS theo người dùng (`app.user_id`) | D-122 (CMP-RIGHTS-001/004, CMP-VN-001) |
| Quyền riêng tư | `dsar_requests` | Yêu cầu quyền chủ thể của **tài khoản**: truy cập (gói JSON), xoá (ẩn danh tài khoản, giữ phần nghĩa vụ pháp lý), hạn chế xử lý; hạn `due_at` theo vùng (`dsar_days`). Ngoại lệ INV-G1: không `organization_id`, RLS theo người dùng | D-123 (STD-PRIV-004, CMP-RIGHTS-007, CMP-VN-007) |
| Quyền riêng tư | `processing_restrictions` | Cờ hạn chế xử lý theo tài khoản (một hàng ⇔ đang hạn chế): xử lý không bắt buộc (analytics) từ chối. Ngoại lệ INV-G1, RLS theo người dùng | D-123 |
| Quyền riêng tư | `org_deletion_certificates` | Chứng nhận xoá **tổ chức** (mã tổ chức đã xoá, người yêu cầu, mốc, số hàng theo bảng, số tệp, digest SHA-256) — ghi khi purge, chỉ người yêu cầu đọc. Ngoại lệ INV-G1: không `organization_id` (tổ chức đã không còn), RLS theo người dùng | D-125 (IND-SAAS-006) |
| Đo lường | `product_events` | Sự kiện analytics sản phẩm (tên `doi_tuong.hanh_dong`, ID nội bộ/enum/số — không PII), ghi qua `track()` chỉ khi có đồng ý còn hiệu lực ở `consent_records`; giữ 13 tháng; `actor_user_id` gỡ liên kết khi xoá tài khoản | PROJECT §2 (M-01/M-03/M-05), D-118 |
