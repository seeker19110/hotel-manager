# docs/autopilot/PLAN.md — Hotel Manager · Đợt 3: khách sạn, buồng phòng, portal, thông báo, báo cáo + vận hành

> **Cổng duyệt: phiên chính tự duyệt 2026-10-16** (AGENTS §5, D-009 ở `docs/autopilot/DECISIONS.md`). Chủ dự án xem lại/đổi ý lúc nào cũng được.
> Nền: nhánh xếp chồng trên PR #5 (đợt 2, CI xanh, chờ merge — D-001). Kế hoạch đợt 1–2 lưu ở `archive/`.
> Kiến trúc: ADR-0001 + ADR-0002. Spec: `SPEC-reservation-stay` (F-006), `SPEC-housekeeping-maintenance` (F-007), `SPEC-portal` (F-008), `SPEC-notifications` (F-011), `SPEC-audit-reporting` (F-012), phần còn lại của `SPEC-inventory-allocation`. Thuật ngữ và tên bảng: DOMAIN-MODEL + ERD.

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** đủ mọi tính năng Must của pilot (PROJECT §3): F-006, F-007, F-008, F-011, F-012 trên lõi đợt 1–2; trả các việc treo của đợt 2; dựng phần quan sát/vận hành chạy được trong repo; rà blueprint có bằng chứng.
- **Blueprint:** trước đợt 3 MUST 87 đạt · 36 miễn · 373 mở; SHOULD 0/1.284. Đợt 3 đóng mọi MUST làm được trong repo (có bằng chứng máy); MUST cần người/production → `loop defer`, gom ở báo cáo cuối.
- **Stack:** giữ nguyên (Node 24.22 · Next 16.4.1 · PG 17 · Kysely 0.29.6 · pg-boss 12.38 · Better Auth 1.7.9 · Zod 4.6.7 · Vitest 5 · Playwright 1.64 · Biome 2.5). Phụ thuộc mới duy nhất có thể có: thư viện SMTP (xác minh ở `/research` trước T-213).
- **Tự host (D-003…D-006):** quét file qua clamd (ClamAV) + bản giả; email qua SMTP relay + `FakeEmailSender`; OTP email cho người thuê; mã hoá số giấy tờ AES-256-GCM tầng app.
- **Task:** 26 (T-201…T-226), 7 lát. Mỗi task một Gate máy kiểm; bất biến tiền/tồn có test trên Postgres thật.
- **Rủi ro chính:** (R1) check-out gộp nhiều luồng tiền (folio, tiền mặt ca đêm, cho nợ, hoàn cọc) — đường găng, tách 2 task + review lát; (R2) rò dữ liệu portal/khách — RLS riêng vai trò `tenant`/token khách, test chéo; (R3) thông báo gửi trùng/sai người — dedupe ở CSDL, adapter nhận `idempotency_key`; (R4) phình phạm vi blueprint — chỉ MUST, SHOULD để đợt 4.
- **Điểm dừng:** mục "Điểm dừng bắt buộc" dưới; mặc định `loop defer`, không chặn cả vòng.
- **Ngân sách:** 130 vòng · ≤ 320 USD · 1800 s/lệnh · 120 giờ.

## Mục tiêu của kế hoạch này
Khi xong đợt này, một khách sạn nhỏ (dữ liệu giả) chạy trọn R-003/R-004: báo giá → giữ phòng có hạn → xác nhận kèm ứng trước/cọc → check-in (hoặc walk-in) → ghi dịch vụ → check-out (thu tiền mặt ca đêm/cho nợ có duyệt/hoàn cọc theo hạn mức) → việc dọn → nghiệm thu → phòng sẵn sàng; báo hỏng có ảnh đã quét → block có duyệt → sửa xong mở lại. Người thuê trọ xem kỳ thu/hợp đồng/chỉ số trên portal, báo đã chuyển, gửi yêu cầu sửa; khách lưu trú xem folio qua liên kết có hạn. Thông báo trong app + email (bản giả) có dedupe/retry/opt-out; nhắc quá hạn, hết hạn hợp đồng, hạn thông báo lưu trú. Màn "Hôm nay", nhật ký audit, báo cáo công nợ/thu tiền/cọc/công suất và xuất CSV/XLSX an toàn. Ví dụ bắt buộc khớp từng đồng:
- folio 1.430.000 đ, ứng trước 500.000 đ, còn 930.000 đ (S-017); tiền mặt ca đêm 930.000 đ → folio 0 (S-026);
- báo giá 2 đêm 1.200.000 đ; cuối tuần 2.000.000 đ / 1.900.000 đ theo tham số (S-001, S-002);
- portal: phiếu 3.580.000 đ, đã trả 2.000.000 đ, còn 1.580.000 đ (portal S-001).

## Ngân sách (4 con số)
- Số vòng tối đa: **130** (`--max-iterations 130`)
- Ngân sách: **≤ 320 USD** token cho đợt này. Hết ngân sách thì bàn giao và dừng.
- Timeout mỗi lệnh Gate: **1800 s** (`XT_RECORD_TIMEOUT`, mặc định)
- Hạn chót: **120 giờ** kể từ `loop init` (`--hours 120`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | tuần 12 kể từ ngày đội khởi động (pilot) | trễ pilot | cắt theo PROJECT §3: F-007, F-008, F-011 xuống tối thiểu trước; không cắt test tiền/tồn |

## Quyết định mặc định cho câu hỏi [chặn] của đợt 3 (D-002 — tham số hoá; chứng từ lưu quy tắc đã dùng, INV-G3)
| Câu hỏi | Mặc định áp dụng | Tham số |
|---|---|---|
| reservation Q-01 giờ nhận/trả, giờ chốt ngày | nhận 14:00, trả 12:00 khi cơ sở chưa đặt; giờ chốt ngày theo `properties.business_day_cutoff` (đã có) | `properties.check_in_time`/`check_out_time` |
| Q-02 "giá ngày/đêm" | một đơn vị "đêm" theo giờ nhận/trả; giá giờ/qua đêm để F-013 | — |
| Q-03 đêm cuối tuần | đêm thứ Sáu + thứ Bảy theo `business_date` | `properties.settings.weekend_nights` = mảng thứ (ISO 1–7) |
| Q-04 chính sách huỷ | không phạt tự động; phí huỷ nhập tay trong hạn mức, có lý do; ứng trước/cọc không tự thành doanh thu | `reservations.policy_snapshot` |
| Q-05 xác nhận không kèm tiền | cho phép | `properties.settings.confirm_without_payment` (mặc định true) |
| Q-06 đổi ngày | đêm cũ giữ giá snapshot, đêm mới giá hiện hành, xem trước chênh lệch | — |
| Q-07 mốc no-show | sau giờ chốt ngày của ngày đến, thao tác tay | — |
| Q-08 trường khách bắt buộc | họ tên, SĐT, loại + số giấy tờ (mã hoá, che khi hiển thị — D-004); **không** lưu ảnh giấy tờ; khách nước ngoài thêm quốc tịch + hộ chiếu | `properties.settings.required_guest_fields` |
| Q-10 số đêm tối đa | 30 | `properties.settings.max_nights` |
| Q-11 thời điểm ghi phí phòng | mọi đêm ghi lúc check-in, điều chỉnh khi đổi ngày; phát hành folio lúc check-out | — |
| Q-12 thuế ở giá phòng | giá niêm yết là giá cuối, không cộng thuế tự động; `charges.tax_profile_id` vẫn lưu | — |
| Q-13 thông báo lưu trú | **không** đặt hạn/mẫu mặc định; cơ sở tự cấu hình (nguồn pháp lý [T] chưa đối chiếu); chưa cấu hình → `NOTICE_TEMPLATE_MISSING`, không nhắc, có cảnh báo cấu hình | `notification_settings` |
| Q-14/Q-15 hoàn cọc lúc check-out, tiền mặt ca đêm | như bảng hạn mức đợt 2 (lễ tân ≤ 2.000.000 đ chỉ khi check-out; khấu trừ luôn cần người khác duyệt; lễ tân tự xác nhận tiền mặt mình nhận trong ca đang mở) | `organizations.settings.role_limits` |
| housekeeping Q-01 ai nghiệm thu | owner/manager; lễ tân khi cơ sở bật | `properties.settings.front_desk_can_inspect` |
| Q-02 tự nhận việc · Q-03 tách quyền · Q-04 ưu tiên · Q-05 không đạt | có · bật · khách đến hôm nay → vừa trả → thời gian tạo · về `assigned` cùng người | `properties.settings.segregate_inspection` |
| Q-06 giới hạn file | JPEG/PNG/WebP; ≤ 10 MB/ảnh; ≤ 5 ảnh/phiếu (HEIC chưa xác minh trên thiết bị thật) | hằng số cấu hình |
| Q-08 sau sửa chữa | bắt buộc việc dọn trước khi bán lại | — |
| Q-10 quét mã độc | clamd + bản giả (D-003) | `CLAMD_HOST`/`CLAMD_PORT` |
| portal Q-01 đăng nhập người thuê | OTP email (D-005) | — |
| Q-02 liên kết khách | token 256 bit + 4 số cuối SĐT, 5 lần sai khoá (D-006) | `properties.settings.guest_link_second_factor` |
| Q-03 hạn liên kết · Q-04 xem lại sau `closed` · Q-05 người ở cùng · Q-07 ảnh báo chuyển · Q-08 giấy tờ trên portal | giờ trả dự kiến + 48 giờ · quyết toán xong + 30 ngày · không xem tiền · có, tuỳ chọn · không hiển thị | `properties.settings.*` |
| audit-reporting Q-01…Q-09 | 4 báo cáo S-009–S-012 + nhật ký; nhóm theo ngày + phương thức + người xác nhận + ca; chỉ số ngày quá hạn; phòng khả dụng = `active` không block; xuất cơ bản không số giấy tờ/ảnh; xác thực lại 5 phút, link 15 phút, xoá file sau 24 giờ; XLSX tự viết (T-115); audit chưa xoá ở pilot | — |
| inventory Q-01 TTL hold · access Q-01/Q-03 | 15 phút (`properties.hold_ttl_minutes`) · giờ chốt 00:00 · nhận/trả theo reservation Q-01 | cột `properties` đã có |
| notifications Q-03 số tiền trong email · Q-04 lịch nhắc · Q-05 retry · Q-06 mốc hết hạn | không ghi số tiền · +1/+3/+7 ngày · 5 lần (1 ph, 5 ph, 30 ph, 2 giờ, 6 giờ), 10 email/giây/tổ chức · 30 và 7 ngày | `notification_settings` |

## Điểm dừng bắt buộc (mặc định `loop defer`; `loop block` chỉ khi mọi việc còn lại phụ thuộc)
- Tiền thật, tài khoản ngân hàng/cổng thanh toán thật; SMTP/ClamAV/VPS thật, tên miền, secret thật; deploy staging/production; gửi email/SMS/Zalo ra ngoài.
- Dữ liệu thật của người dùng; nộp thông báo lưu trú cho cơ quan nhà nước (hệ thống không bao giờ tự nộp).
- Đổi quyền, ruleset, required checks, cấu hình cổng/CI/hook (test mới chạy trong 6 job sẵn có).
- Thay đổi phá vỡ migration đã có (chỉ thêm migration mới 0023+).
- Câu hỏi [chặn] ngoài bảng trên không tự quyết được theo AGENTS §5; cùng lỗi Gate lần 3 (máy tự BLOCKED).

## Thứ tự và lý do
1. **Lát 0 — chốt quyết định + nền dùng chung** (T-201…T-203): quyết định vào SPEC trước khi code; số giấy tờ mã hoá và quét file là tiền đề của check-in và phiếu sự cố.
2. **Lát 1 — khách sạn** (T-204…T-210): đường găng tiền R1; check-out tách hai task.
3. **Lát 2 — buồng phòng + sự cố** (T-211, T-212): check-out tạo việc dọn; sự cố dùng block của đợt 1.
4. **Lát 3 — thông báo** (T-213…T-215): portal mời người thuê và nhắc đều cần kênh gửi.
5. **Lát 4 — portal** (T-216…T-219).
6. **Lát 5 — audit, "Hôm nay", báo cáo, xuất** (T-220…T-222).
7. **Lát 6 — UI khách sạn + E2E, việc treo đợt 2, vận hành/quan sát, rà blueprint** (T-223…T-226).
Sau mỗi lát: review độc lập (`reviewer`), sửa hết 🔴/🟠 kèm test hồi quy trước lát kế.

## Task

> Gate chạy bằng `set -o pipefail; python3 .xtemplates/scripts/xt.py loop record --task T-xxx -- <Gate>`. Lọc test DB: `pnpm vitest run --project db <mẫu tên file>` (không dùng `pnpm test:db -- x` — chạy toàn bộ). Ví dụ số tiền bắt buộc phải có test khớp từng đồng.

### Lát 0 — Chốt quyết định và nền dùng chung
- [x] `T-201` Ghi bảng quyết định trên vào mục 10 của 5 SPEC (tick "quyết theo PLAN đợt 3, ngày, tham số"), SPEC-metering theo D-008, SPEC-lease theo D-007; DOMAIN-MODEL/ERD bổ sung cột mới (`lease_versions.superseded_on`, `identity_documents` mã hoá); mở rộng `scripts/check-blocking-questions.py` cho 5 SPEC — Gate: `python3 scripts/check-blocking-questions.py reservation-stay housekeeping-maintenance portal notifications audit-reporting && python3 -m unittest discover -s scripts -p "test_*.py"`
- [x] `T-202` Mã hoá số giấy tờ (D-004): `packages/app/src/crypto/pii.ts` AES-256-GCM có `key_id` + blind index HMAC; schema env `HM_PII_KEY`/`HM_PII_KEY_ID` (bắt buộc ở production, dev có khoá giả); migration 0023 thêm cột `doc_number_enc`, `doc_number_hash`, `doc_number_last4`, chuyển dữ liệu cũ, bỏ cột rõ; `identity.get` che số; test: DB không chứa số rõ, sai khoá → lỗi, xoay khoá đọc được bản cũ — Gate: `pnpm vitest run packages/app/src/crypto && pnpm vitest run --project db identity`
- [x] `T-203` Quét mã độc (D-003): `ClamdScanner` (INSTREAM, timeout, giới hạn kích thước, lỗi kết nối → không `ready`) + contract test với clamd giả (TCP) gồm EICAR/OK/ERROR; chọn scanner theo env (production thiếu `CLAMD_HOST` → khởi động lỗi; dev/CI dùng bản giả); housekeeping S-013…S-017 có test bảo mật riêng — Gate: `pnpm vitest run packages/app/src/files && pnpm vitest run --project db files`

### Lát 1 — Khách sạn (F-006)
- [x] `T-204` Loại phòng + bảng giá + báo giá: `roomType.create/update`, `rate.set` (migration `rate_plans`), `reservation.quote` theo `business_date` từng đêm và tham số cuối tuần; `RATE_NOT_CONFIGURED`, `CAPACITY_EXCEEDED`, giới hạn số đêm (S-001, S-002, S-014, S-021 phần báo giá) — Gate: `pnpm vitest run packages/domain/src/stay && pnpm vitest run --project db rates`
- [x] `T-205` Booking: `reservations`, `reservation_items` (snapshot giá từng đêm, `policy_snapshot`), `stays` `expected`; `reservation.create/hold/confirm` (ứng trước → `CUSTOMER_CREDIT`, cọc → `DEPOSIT_LIAB`, chứng cứ INV-F3, một giao dịch ngân hàng một payment INV-F4b), hold hết hạn `HOLD_EXPIRED` đúng một lần, `reservation.cancel` (không `REV_*`; phí huỷ trong hạn mức), `reservation.markNoShow`; RLS + FK ghép (S-003…S-007, S-009…S-011, S-025) — Gate: `pnpm vitest run --project db reservations`
- [x] `T-206` Đổi ngày nguyên tử + danh sách: `reservation.changeDates` (xem trước chênh lệch, đêm cũ snapshot, đêm mới giá hiện hành, allocation cùng transaction, bận → không đổi gì), `reservation.list/get` theo quyền; job nhả hold booking (S-008, S-021) — Gate: `pnpm vitest run --project db reservation-dates`
- [x] `T-207` Check-in + walk-in: `stay.checkIn` (phòng `inspected` khi cơ sở yêu cầu, `ROOM_NOT_READY`/`ROOM_OCCUPIED`, khách bắt buộc, giấy tờ mã hoá), `stay.walkIn` một command thẳng `in_house`, phí phòng mỗi đêm unique (stay, `business_date`), `residence_notices` `pending` cùng transaction (`due_at` theo cấu hình, `is_foreign`), sự kiện M-03 (S-012…S-016) — Gate: `pnpm vitest run --project db stays`
- [x] `T-208` Folio + dịch vụ: `stay.postCharge`/`stay.voidCharge` (idempotency, `PERIOD_LOCKED`, hạn mức giảm giá), `stay.getFolio` (phí, thanh toán, phân bổ, số dư; cọc tách riêng), housekeeping/khác tổ chức → 404 (S-017 phần folio, S-018, S-022, S-024, S-025) — Gate: `pnpm vitest run --project db folio`
- [x] `T-209` Check-out: phát hành folio (Nợ AR / Có REV_ROOM/REV_SERVICE/REV_FEE), phân bổ ứng trước, thu tiền mặt ca đêm lễ tân tự xác nhận trong ca mở, cho nợ cần duyệt + người nợ + hạn, hoàn cọc trong hạn mức hoặc tạo yêu cầu duyệt, khấu trừ cọc cấm tự duyệt; allocation kết thúc lúc trả thực, phòng `dirty` + việc dọn cùng transaction (S-017, S-019, S-020, S-023, S-026, S-027; ví dụ 1.430.000/930.000) — Gate: `pnpm vitest run --project db checkout`
- [x] `T-210` Thông báo lưu trú: mẫu theo cơ sở (trường cho phép, CSV/XLSX), `stay.exportResidenceNotice` (file riêng tư, chỉ trường mẫu yêu cầu, `NOTICE_TEMPLATE_MISSING`, thiếu trường → 422 kèm danh sách), `stay.markNoticeSubmitted`, `stay.listNotices` (quá hạn lên đầu); không gửi gì ra ngoài (S-028…S-030) — Gate: `pnpm vitest run --project db residence-notices`

### Lát 2 — Buồng phòng và sự cố (F-007)
- [x] `T-211` Việc dọn: `tasks` (unique việc dọn mở theo phòng), ánh xạ trạng thái việc → `units.housekeeping_status`, `housekeeping.createTask/assign/claim/start/complete/verify/cancel/list/get` (ưu tiên khách đến hôm nay, danh sách trường cho phép theo vai trò, tách quyền nghiệm thu), check-out/chuyển phòng tạo việc; `inventory.getUnitStatus` `ready_for_arrival` (S-001…S-011, S-020, S-022, S-023) — Gate: `pnpm vitest run --project db housekeeping`
- [x] `T-212` Phiếu sự cố: `work_orders` (ảnh qua file đã quét, ≤ 5 ảnh), `maintenance.create/assign/start/complete/verify/cancel/list`, `maintenance.proposeBlock` → block `requested`, kỹ thuật không duyệt/kết thúc block, nghiệm thu mở lại phòng + việc dọn; người thuê tạo/xem phiếu của mình (S-012, S-014, S-015, S-018, S-019, S-021) — Gate: `pnpm vitest run --project db maintenance`

### Lát 3 — Thông báo (F-011)
- [x] `T-213` Thông báo + gửi: `notifications`, `notification_deliveries` (dedupe unique), handler outbox → `notify.dispatch` → `notify.sendEmail`; `EmailSender` (`FakeEmailSender` + adapter SMTP tự host) phân loại lỗi tạm/vĩnh viễn, retry backoff 5 lần → `dead` + metric, `sending` quá hạn khoá → `retrying`; mẫu email/in-app không PII nhạy cảm, log che email (S-001…S-006, S-012) — Gate: `pnpm vitest run packages/app/src/notifications && pnpm vitest run --project db notifications`
- [x] `T-214` Tuỳ chọn và lịch sử: `notification_preferences` (loại bắt buộc `PREFERENCE_REQUIRED`), `notifications.unsubscribe` (token ký có hạn, `LINK_EXPIRED`), `listMine/markRead/markAllRead`, `listDeliveries` theo quyền, `retryDelivery` (`DELIVERY_NOT_RETRYABLE`), `notification_settings` + `updateSettings` (S-009…S-011, S-017…S-019) — Gate: `pnpm vitest run --project db notification-preferences`
- [ ] `T-215` Nhắc theo lịch: `reminder.scanOverdue` (theo ngày địa phương, đọc lại số dư khi gửi → `suppressed SETTLED`), `reminder.scanLeaseExpiry` (30/7 ngày, bỏ khi đã gia hạn), `reminder.scanStayNotice` (hạn theo cấu hình 23:00/08:00 và số giờ khách nước ngoài, nhắc khẩn 30 phút, quá hạn 1 lần/ngày, chưa cấu hình → cảnh báo cấu hình); job quét theo từng tổ chức (S-007, S-008, S-013…S-016, S-020, S-021) — Gate: `pnpm vitest run --project db reminders`

### Lát 4 — Portal (F-008)
- [ ] `T-216` Người thuê vào portal: `portal.inviteTenant/revokeTenantAccess` (membership `tenant` gắn `person_id`, không tính quota nhân viên), đăng nhập OTP email (Better Auth `emailOTP`, có hạn, giới hạn thử), `portal.listContexts/switchContext`, `CONTEXT_CHANGED` giữa hai tab, thu hồi/hết hạn xem lại → 404; RLS riêng vai trò `tenant` (portal S-005, S-012…S-015) — Gate: `pnpm vitest run --project db portal-access`
- [ ] `T-217` Portal người thuê: `portal.listMyInvoices/getMyInvoice` (chỉ kỳ `issued`/`locked`), `getMyLease` (cọc tách nhãn), `listMyMeterReadings` (chỉ đã duyệt), `createRequest/listMyRequests` (nhãn trạng thái, không tên nhân viên), `getPaymentInstructions` + `submitPaymentClaim` (`payment_claims`, không payment/bút toán) + hàng chờ báo chuyển cho nhân viên; chéo người thuê/tổ chức → 404 + audit `portal.access_denied` (S-001…S-011, S-021) — Gate: `pnpm vitest run --project db portal`
- [ ] `T-218` Liên kết khách: `guest_access_links` (token 256 bit chỉ lưu hash, yếu tố 4 số cuối SĐT, sai 5 lần khoá), `portal.createGuestLink/revokeGuestLink`, `guestGetStay/guestGetFolio`, `LINK_EXPIRED`/`LINK_REVOKED` 410, sai lượt ở 404, giới hạn theo IP 429 không phân biệt lý do (S-016…S-020) — Gate: `pnpm vitest run --project db guest-links`
- [ ] `T-219` UI portal (mobile): Kỳ thu · Chi tiết phiếu · Hợp đồng · Điện nước · Yêu cầu · Thanh toán QR + "Tôi đã chuyển" · trang liên kết khách · trang `/huy-dang-ky` (nút xác nhận → POST `/api/v1/notifications/unsubscribe`, T-214); `/app/*` chuyển về `/portal` với `tenant`; E2E người thuê OTP email (bản giả) + axe 0 serious/critical (S-022) — Gate: `pnpm --filter @hm/web exec playwright test portal`

### Lát 5 — Audit, "Hôm nay", báo cáo, xuất (F-012)
- [ ] `T-220` Nhật ký audit + "Hôm nay": `audit.list` (lọc thực thể/người/thời gian/`correlation_id`, theo quyền, phân trang keyset, không secret/CCCD), append-only có test; `today.get` theo vai trò và `business_date` (khách đến/đi không đếm `no_show`/`cancelled`, phòng chưa sẵn sàng, nợ đến hạn, kỳ thu chờ duyệt, việc dọn, sự cố, thông báo lưu trú sắp/quá hạn) (audit-reporting S-001…S-008) — Gate: `pnpm vitest run --project db audit-today`
- [ ] `T-221` Báo cáo: công nợ (tổng = chi tiết = sổ phụ AR), thu tiền theo phương thức/ca, cọc đang giữ (= `DEPOSIT_LIAB`), công suất cơ bản; giới hạn khoảng thời gian (S-009…S-012, S-019) — Gate: `pnpm vitest run --project db reports`
- [ ] `T-222` Xuất dữ liệu: `export_jobs` chạy ở worker, quyền xuất riêng, xác thực lại (step-up) trước khi xuất, file riêng tư + link ký có hạn, chống formula injection CSV/XLSX, không vượt phạm vi cơ sở, xuất toàn bộ tổ chức (bản cơ bản, không ảnh), thông báo `export_ready` (S-013…S-018) — Gate: `pnpm vitest run --project db exports`

### Lát 6 — UI khách sạn, việc treo, vận hành, rà blueprint
- [ ] `T-223` UI khách sạn + vận hành: "Hôm nay", lịch phòng, booking (báo giá → giữ → xác nhận), check-in/walk-in, folio + dịch vụ, check-out, thông báo lưu trú, buồng phòng (mobile, nút ≥ 44 px), sự cố có ảnh, chuông thông báo; E2E R-003 (booking → check-in → check-out tiền mặt → dọn → nghiệm thu) + axe — Gate: `pnpm --filter @hm/web exec playwright test hotel`
- [ ] `T-224` Việc treo đợt 2: job hạn giữ import (xoá object theo `files.delete_after`, làm rỗng `import_rows.raw/data` sau 30 ngày) + route `import.upload` multipart; phụ lục hợp đồng không thời hạn qua `superseded_on` (D-007); lưu cơ sở đang chọn của `session.switchOrganization` — Gate: `pnpm vitest run --project db import-retention lease-supersede org-context`
- [ ] `T-225` Quan sát/vận hành: `/api/metrics` (Prometheus text, chỉ nội bộ — token hoặc mạng nội bộ), metric outbox lag, `notification_dead_total`, job lỗi, hold hết hạn; `/api/ready` (CSDL + storage + scanner); worker health; `docs/RUNBOOK.md` (sự cố, khôi phục, xoay khoá PII, dead letter) — Gate: `pnpm vitest run packages/app/src/observability && pnpm vitest run --project db observability`
- [ ] `T-226` Rà blueprint đợt 3: tick MUST đạt kèm `Bằng chứng:`; miễn có lý do; MUST cần người/production → `loop defer` + danh sách cho GO-NO-GO; cập nhật PROGRESS — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 -m unittest discover -s scripts -p "test_*.py"`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Mẫu thông báo lưu trú, hạn | pháp lý đối chiếu văn bản gốc | cấu hình theo cơ sở, không mặc định cứng (Q-13) |
| SMTP relay, ClamAV thật | chủ dự án chọn/cài trên VPS | `FakeEmailSender`, clamd giả trong dev/CI; contract test |
| Môi trường agent | kho PGDG, GitHub releases | `scripts/dev-env-setup.sh` |

## Ước lượng (agent + review người)
| Task | P50 | P90 |
|---|---|---|
| T-201, T-203, T-206, T-210, T-214, T-218, T-224, T-226 | 0,5 ngày mỗi task | 1 ngày |
| T-202, T-204, T-205, T-207, T-208, T-211, T-212, T-213, T-215, T-216, T-220, T-221, T-222, T-225 | 1 ngày | 1,5 ngày |
| T-209, T-217, T-219, T-223 | 1,5 ngày | 2,5 ngày |
Tổng P50 khoảng 24 ngày, P85 khoảng 34 ngày. Không dùng con số P50 làm ngày hứa.
