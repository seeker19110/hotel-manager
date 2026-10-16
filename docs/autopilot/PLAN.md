# docs/autopilot/PLAN.md — Hotel Manager · Đợt 3: khách sạn, buồng phòng/sự cố, portal, thông báo, báo cáo

> **Duyệt: D-004** (phiên chính tự duyệt theo ADR-0008, 2026-10-16, sau lệnh `/autopilot` của chủ dự án). Đợt 2 (PR #5) xanh nhưng chưa merge → đợt 3 xếp chồng lên PR #5 (D-001); kế hoạch đợt 1–2 ở `archive/`.
> Spec: `SPEC-reservation-stay` (F-006), `SPEC-housekeeping-maintenance` (F-007), `SPEC-portal` (F-008), `SPEC-notifications` (F-011), `SPEC-audit-reporting` (F-012), phần còn lại của `SPEC-inventory-allocation` (F-002). Thuật ngữ và tên bảng: DOMAIN-MODEL + ERD (§3.4 `rate_plans`…`guest_access_links`, `payment_claims`, `tasks`, `work_orders`, `notifications*`, `export_jobs`).
> Lõi dùng lại: command pipeline (idempotency, audit, outbox, `onRollback`), RLS + phạm vi cơ sở, allocation/hold (EXCLUDE), sổ phụ + `payments`/`deposits`/`charges`/`invoices` (`kind='folio'`), duyệt có hạn mức, ca quầy, file riêng tư (EXIF, URL ký), relay outbox + dead letter, `useCommand`, E2E server.

## Mục tiêu của kế hoạch này
Khi xong, một khách sạn nhỏ (dữ liệu giả) chạy trọn ngày: báo giá → giữ phòng có hạn → xác nhận kèm ứng trước có chứng cứ → check-in (kể cả walk-in) → ghi dịch vụ vào folio → check-out thu tiền/hoàn cọc theo hạn mức → tự tạo việc dọn → buồng phòng làm và quản lý nghiệm thu → phiếu sự cố có ảnh đã quét mã độc; người thuê trọ đăng nhập portal xem kỳ thu/hợp đồng/cọc và báo "đã chuyển"; khách có liên kết xem lượt ở; thông báo in-app/email qua outbox có dedupe; quản lý xem "Hôm nay", 4 báo cáo khớp sổ và xuất CSV an toàn. Đo được:
- ví dụ bắt buộc của SPEC khớp từng đồng (folio 1.430.000 đ / còn 930.000 đ);
- không bán trùng phòng kể cả 2 lễ tân cùng lúc (INV-I1, đã có ở DB — thêm luồng booking);
- ứng trước/cọc không thành doanh thu khi huỷ (INV-F5); folio đã phát hành bất biến (INV-G4);
- thông báo không gửi trùng khi worker xử lý lại (INV-G6), không chứa PII nhạy cảm;
- báo cáo công nợ/cọc/thu tiền khớp sổ phụ (Σ báo cáo = Σ sổ).

Tương ứng mốc "Tuần 9–12" của kế hoạch gốc (khách sạn + vận hành, trước pilot). Đợt 4: phát hành G7 (blueprint còn mở, GO-NO-GO, hạ tầng thật — cần người).

## Ngân sách (4 con số)
- Số vòng tối đa: **100** (`--max-iterations 100`; 22 task × ~4 vòng + dự phòng)
- Ngân sách: **≤ 280 USD** token cho đợt này. Hết thì bàn giao và dừng.
- Timeout mỗi lệnh Gate: **1800 s** (`XT_RECORD_TIMEOUT`, mặc định)
- Ngày hết hạn: **96 giờ** kể từ `loop init` (`--hours 96`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | tuần 12 kể từ ngày đội khởi động (pilot) | trễ mốc pilot | cắt theo PROJECT §5: F-007 → F-008 → F-011 xuống tối thiểu trước; không cắt test tiền/tồn, không hạ cổng |

## Quyết định mặc định cho câu hỏi [chặn] của đợt 3 — **D-002** (tham số hoá theo cơ sở; đổi giá trị không cần migration; chứng từ lưu quy tắc đã dùng — INV-G3)
| Câu hỏi | Mặc định áp dụng | Tham số |
|---|---|---|
| Giờ nhận/trả phòng (reservation Q-01, access Q-03) | nhận 14:00, trả 12:00 giờ cơ sở | `properties.settings.check_in_time` / `check_out_time` |
| Giờ chốt ngày kinh doanh (access Q-01, reservation Q-01) | `rental` 00:00; `hotel` 06:00 (khách nhận phòng 00:00–05:59 tính đêm hôm trước — tránh S-016 "qua 00:00 tạo sai một đêm") | `properties.settings.business_day_cutoff`; `app.business_date` đọc tham số |
| Đơn vị giá (reservation Q-02) | một đơn vị "đêm" theo ngày đến/ngày đi; giá giờ/qua đêm để F-013 | — |
| Đêm cuối tuần (reservation Q-03) | đêm thứ Sáu và thứ Bảy theo `business_date`; chưa hỗ trợ ngày lễ | `rate_plans.weekend_nights` (mặc định `[5,6]`) |
| Huỷ booking (reservation Q-04) | không phạt tự động; phí huỷ nhập tay có lý do, trong hạn mức; ứng trước/cọc giữ nguyên, hoàn qua duyệt (INV-F5) | — |
| Thông tin khách khi check-in (reservation Q-08) | bắt buộc: họ tên, SĐT người đặt; người lưu trú: loại + số giấy tờ (hiển thị che), khách nước ngoài thêm quốc tịch + hộ chiếu; **không lưu ảnh giấy tờ** mặc định | `properties.settings.store_id_images` = `false` |
| Thuế trong giá phòng (reservation Q-12) | giá niêm yết là giá cuối, không cộng thuế tự động; `charges.tax_profile_id` vẫn lưu | — |
| Hoàn/khấu trừ cọc lúc check-out; lễ tân tự xác nhận tiền mặt (reservation Q-14, Q-15) | **đã quyết ở đợt 2** (bảng PLAN đợt 2: lễ tân ≤ 2.000.000 đ chỉ khi check-out, hoàn nguyên số một bước; khấu trừ cần người thứ hai; tiền mặt xác nhận trong ca của chính mình) | `organizations.settings.role_limits` |
| TTL giữ phòng tại quầy (inventory Q-01) | 15 phút | `properties.settings.booking_hold_ttl_minutes` |
| Ai nghiệm thu phòng (housekeeping Q-01) | owner/manager; lễ tân nếu cơ sở bật; người làm không tự nghiệm thu | `properties.settings.front_desk_can_inspect` = `false` |
| Giới hạn ảnh phiếu sự cố (housekeeping Q-06) | JPEG/PNG/WebP; ≤ 10 MB/ảnh; ≤ 5 ảnh/phiếu; HEIC chưa nhận (chưa xác minh trên thiết bị thật) | `properties.settings.work_order_max_images` |
| Máy quét mã độc (housekeeping Q-10) | **D-003**: adapter `ClamdScanner` (giao thức `zINSTREAM` TCP) cho ClamAV tự host; dev/CI: `eicarOnlyScanner` + test hợp đồng với clamd giả trong test; chưa quét được → file không bao giờ `ready` | env `CLAMD_HOST`/`CLAMD_PORT` |
| Người thuê đăng nhập portal (portal Q-01) | OTP email (Better Auth `emailOTP`, bản 1.7.9 đã cài); gửi qua `EmailSender` (dev/CI `FakeEmailSender`, ADR-0002) | — |
| Liên kết khách (portal Q-02) | token ngẫu nhiên ≥ 128 bit (lưu hash) + nhập 4 số cuối SĐT người đặt; sai 5 lần khoá liên kết; hết hạn = giờ trả phòng + 24 h; một liên kết = một lượt ở | — |
| Bộ báo cáo pilot (audit Q-01) | 4 báo cáo S-009…S-012 (công nợ, thu tiền theo phương thức/ca, cọc đang giữ, công suất) + nhật ký audit; cột theo mục 5 của SPEC | — |

**Ngoài phạm vi đợt 3, chờ chủ dự án** (`loop defer` nếu chạm tới): mã hoá cột số giấy tờ (cần khoá bí mật thật + bỏ cột chữ rõ = migration phá vỡ); hợp đồng không thời hạn đổi giá (chạm INV-G4, câu hỏi ở PR #5); quản lý đặt giá dịch vụ (SPEC ↔ ma trận lệch, PR #5); chọn SMTP relay và gửi email thật; triển khai ClamAV thật (RAM ≥ 3 GiB, tải DB chữ ký từ CDN).

## Điểm dừng bắt buộc về hành động (`python3 .xtemplates/scripts/xt.py loop defer --task <ID> --reason "..."`; `loop block` chỉ khi mọi việc còn lại phụ thuộc)
- Tiền thật, tài khoản ngân hàng thật, cổng thanh toán thật (đợt này chỉ webhook mô phỏng như đợt 2).
- Gửi email/SMS/Zalo ra ngoài, đăng ký SMTP relay, mua VPS/tên miền, secret thật, deploy staging/production.
- Dữ liệu thật của người dùng/khách lưu trú (kể cả file thông báo lưu trú gửi cơ quan công an).
- Đổi quyền, ruleset, required checks, cấu hình cổng/CI/hook (CI giữ 6 job; test mới chạy trong job sẵn có — E2E mới tự vào job `e2e`).
- Migration phá vỡ/drop cột hay bảng đã có trên nhánh nền (chỉ thêm migration mới, mở rộng CHECK là thêm giá trị).
- Hai lần cùng lỗi Gate với hai cách tiếp cận khác nhau (máy tự BLOCKED ở lần 3).
- (Spec hở/mâu thuẫn, chọn thiết kế **không** dừng: tự quyết bằng `loop decide` → D-NNN.)

## Thứ tự và lý do
1. **Lát 0 — chốt quyết định + lịch phòng** (T-201, T-202): quyết định vào SPEC trước khi code; lệnh inventory chưa có HTTP mà UI khách sạn cần lịch phòng.
2. **Lát 1 — khách sạn** (T-203…T-208): đường găng tiền + tồn (R03 bán trùng/ghi tiền sai); giá thuần trước, booking → stay → folio/check-out.
3. **Lát 2 — buồng phòng/sự cố** (T-209, T-210): check-out đã phát sự kiện; quét mã độc thật thay EICAR-only.
4. **Lát 3 — thông báo** (T-211, T-212): portal OTP và nhắc hạn cần kênh email/in-app.
5. **Lát 4 — portal** (T-213…T-215).
6. **Lát 5 — báo cáo/audit/xuất** (T-216…T-218).
7. **Lát 6 — vận hành + việc treo + UI/E2E + blueprint** (T-219…T-222).

## Task

> Gate là lệnh máy kiểm, chạy bằng `python3 .xtemplates/scripts/xt.py loop record --task T-xxx -- <Gate>`. Bất biến tiền/tồn có test trên Postgres thật (`*.db.test.ts`); test nhắc ID kịch bản (`S-0xx`) của SPEC. Ví dụ số tiền bắt buộc phải có test khớp từng đồng. Mỗi lát có review độc lập (`reviewer`) trước khi sang lát sau; 🔴/🟠 sửa kèm test hồi quy.

### Lát 0 — Chốt quyết định và lịch phòng
- [ ] `T-201` Ghi bảng D-002/D-003 vào SPEC (mục câu hỏi: tick kèm "quyết theo PLAN đợt 3 — D-002, ngày, tham số"), DOMAIN-MODEL/ERD nếu đổi tên/tham số; `app.business_date` đọc `business_day_cutoff` (migration mới, giữ hành vi cũ khi thiếu tham số) — Gate: `python3 scripts/check-blocking-questions.py reservation-stay housekeeping-maintenance portal audit-reporting inventory-allocation access-and-property notifications && python3 -m unittest discover -s scripts -p "test_*.py" && pnpm test:db -- business-date`
- [ ] `T-202` Lịch phòng: đăng ký HTTP các lệnh inventory (`hold/release/confirm/move/proposeBlock/approveBlock/unitStatus`), query lịch theo cơ sở/tầng/loại/khoảng ngày có phân trang (inventory S-021), sự cố bất ngờ trên phòng có khách sắp đến → cảnh báo + đề xuất chuyển phòng (S-013) — Gate: `pnpm test:db -- inventory`

### Lát 1 — Khách sạn (F-006)
- [ ] `T-203` Giá: `rate_plans` (theo loại phòng, giá đêm thường/cuối tuần, hiệu lực); engine báo giá thuần `packages/domain/src/rates` (số đêm theo ngày kinh doanh, đổi bảng giá không ảnh hưởng booking đã giữ — snapshot); property test (Σ đêm = tổng, không âm, ngày đi > ngày đến) (reservation S-001, S-002, S-016, S-021) — Gate: `pnpm vitest run packages/domain/src/rates && pnpm test:db -- rates`
- [ ] `T-204` Booking: `reservations`, `reservation_items` (gán phòng ngay, allocation `hold` TTL 15 phút); xác nhận kèm ứng trước qua `payments`/`deposits` (FK `reservation_id`) có chứng cứ, "khách bấm đã chuyển" không đủ; xác nhận khi hold hết hạn; đổi ngày nguyên tử; huỷ không thành doanh thu; no-show; máy trạng thái chặn chuyển sai; gia hạn hợp đồng đụng booking đã xác nhận (reservation S-003…S-011; inventory S-018) — Gate: `pnpm test:db -- reservation`
- [ ] `T-205` Nhận phòng: `stays` (allocation `stay`), check-in booking có sẵn, chặn phòng chưa sạch/còn khách, sức chứa, walk-in một bước; người lưu trú PII tối thiểu + `identity_documents` (che khi hiển thị, không ảnh); quyền và tenant (S-012…S-015, S-025) — Gate: `pnpm test:db -- stay`
- [ ] `T-206` Folio và trả phòng: `charges` theo đêm/dịch vụ (`source_type='stay'`, không ghi hai lần), folio = `invoices kind='folio'` phát hành bất biến; ví dụ 1.430.000 đ / còn 930.000 đ; check-out còn nợ cần quản lý cho phép; hoàn cọc theo hạn mức lễ tân; lễ tân tự xác nhận tiền mặt trong ca; kỳ đã khoá; phân bổ không vượt; check-out phát sự kiện tạo việc dọn (S-016…S-020, S-022…S-024, S-026, S-027) — Gate: `pnpm test:db -- folio`
- [ ] `T-207` Thông báo lưu trú: `residence_notices` (hạn theo giờ đến, khách nước ngoài), xuất file theo mẫu (chỉ tải về, không gửi đi), đánh dấu đã thông báo, quá hạn (S-028…S-030) — Gate: `pnpm test:db -- residence`
- [ ] `T-208` Import booking đang có (import S-009): lô `kind='reservations'` qua hàm module đặt phòng, chống trùng `external_id`, phòng bận → lỗi dòng — Gate: `pnpm test:db -- import`

### Lát 2 — Buồng phòng và sự cố (F-007)
- [ ] `T-209` Việc buồng phòng: `tasks` (từ check-out, không trùng), danh sách theo tầng/ưu tiên, giao/tự nhận, tiến độ chỉ người được giao, nghiệm thu không tự nghiệm thu, chuyển trạng thái hợp lệ, "sạch" ≠ "trống", bấm hai lần; buồng phòng không thấy CCCD/tiền (housekeeping S-001…S-011, S-020) — Gate: `pnpm test:db -- housekeeping`
- [ ] `T-210` Phiếu sự cố: `work_orders` + ảnh (giới hạn D-002, bỏ EXIF, riêng tư, URL ngắn hạn), `ClamdScanner` (`zINSTREAM`, timeout, lỗi/không kết nối → không `ready`) + test hợp đồng với clamd giả; kỹ thuật đề xuất block, hoàn tất sửa mở lại phòng cần thẩm quyền, người thuê gửi yêu cầu; chéo tenant; audit + outbox (S-012…S-019, S-021…S-023) — Gate: `pnpm test:db -- work-orders`

### Lát 3 — Thông báo (F-011)
- [ ] `T-211` Thông báo: `notifications`, `notification_deliveries`, `notification_preferences`, `notification_settings`; in-app + email qua `EmailSender` (dev/CI `FakeEmailSender`); phát sau commit, dedupe, retry backoff → dead, lỗi vĩnh viễn không retry, UI không báo "đã gửi" khi mới xếp hàng, opt-out theo loại, huỷ đăng ký từ email (token ký), loại bắt buộc, không PII nhạy cảm, chỉ xem của mình, lịch sử theo quyền, gửi lại `dead` (notifications S-001…S-012, S-017…S-019) — Gate: `pnpm test:db -- notifications`
- [ ] `T-212` Nhắc hạn: quá hạn thanh toán (không nhắc phiếu đã tất toán), hợp đồng sắp hết hạn không lặp, hạn thông báo lưu trú (trước/sau 23 giờ, khách nước ngoài), dừng nhắc khi đã nộp, chưa cấu hình hạn, quá hạn chưa đánh dấu (S-007, S-008, S-013…S-016, S-020, S-021) — Gate: `pnpm test:db -- reminders`

### Lát 4 — Portal (F-008)
- [ ] `T-213` Portal người thuê: mời/thu hồi (`invitations`), đăng nhập OTP email, xem kỳ thu/phiếu/hợp đồng/cọc/chỉ số đã duyệt, chặn chéo cùng/khác tổ chức và API nhân viên, người dùng hai ngữ cảnh/hai tab, danh sách rỗng (portal S-001…S-007, S-012…S-015, S-021) — Gate: `pnpm test:db -- portal`
- [ ] `T-214` `payment_claims` "Tôi đã chuyển" (không phải chứng cứ — INV-F3, bấm hai lần = 1, vào hàng chờ đối soát) + QR; yêu cầu sửa chữa từ portal và theo dõi trạng thái (S-008…S-011) — Gate: `pnpm test:db -- portal-claims`
- [ ] `T-215` Liên kết khách: `guest_access_links` (hash token, 4 số cuối SĐT, khoá sau 5 lần sai, hết hạn, thu hồi, lượt ở khác bị từ chối, thời gian phản hồi không lộ token đúng/sai) (S-016…S-020) — Gate: `pnpm test:db -- guest-link`

### Lát 5 — Báo cáo, audit, xuất (F-012)
- [ ] `T-216` Màn "Hôm nay" theo vai trò và ngày kinh doanh (đến/đi/đang ở/việc dọn/nợ); xem nhật ký audit theo quyền, lọc `correlation_id` (audit S-004…S-008) — Gate: `pnpm test:db -- today`
- [ ] `T-217` 4 báo cáo pilot khớp sổ phụ: công nợ (chi tiết = tổng = sổ), thu tiền theo phương thức/ca, cọc đang giữ, công suất; phân trang, giới hạn khoảng thời gian (S-009…S-012, S-019) — Gate: `pnpm test:db -- reports`
- [ ] `T-218` Xuất CSV: `export_jobs` (quyền riêng, xác thực lại trong 5 phút, chạy job, link ký có hạn, chống formula injection dùng chung với import, không vượt phạm vi cơ sở, xuất toàn bộ dữ liệu tổ chức cho owner) (S-013…S-018) — Gate: `pnpm test:db -- export`

### Lát 6 — Vận hành, việc treo đợt 2, UI/E2E, blueprint
- [ ] `T-219` Hạn giữ dữ liệu (chặn trước dữ liệu thật, review đợt 2 🟠3): job xoá object theo `files.delete_after`, làm rỗng `import_rows.raw/data` sau commit/huỷ 30 ngày, chạy lại không lỗi; route `import.upload` multipart (giới hạn kích thước, loại file, quét) — Gate: `pnpm test:db -- retention`
- [ ] `T-220` Quan sát tối thiểu (ARCHITECTURE §quan sát): `/api/health` tách sống/sẵn sàng (DB + hàng đợi, không lộ chi tiết), `/metrics` dạng văn bản Prometheus tự viết, chỉ nội bộ (độ trễ outbox, số dead letter, số `reconciliation_breaks` mở, đếm lỗi theo mã), không thêm thư viện — Gate: `pnpm test:db -- observability`
- [ ] `T-221` UI khách sạn + buồng phòng + portal tối thiểu theo design system (lịch phòng, booking, check-in/out, folio, việc dọn, phiếu sự cố, portal người thuê, liên kết khách) + E2E vòng khách sạn và portal, kiểm axe và vùng chạm (portal S-022) — Gate: `pnpm --filter web exec playwright test hotel portal`
- [ ] `T-222` Rà blueprint đợt 3: tick `[x]` mục MUST/SHOULD đạt nhờ đợt 3 kèm `Bằng chứng:`; ghi MUST còn mở cho đợt 4 vào PROGRESS — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 -m unittest discover -s scripts -p "test_*.py"`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Mẫu file thông báo lưu trú | cơ quan công an/cổng dịch vụ công (chưa xác minh mẫu hiện hành) | mẫu CSV theo trường của SPEC, ghi "(chưa xác minh)"; đối chiếu trước G7 |
| ClamAV thật | Docker Hub `clamav/clamav:1.4.6` (LTS, EOL 2027-08-15), CDN chữ ký | dev/CI không cần; deploy compose thêm dịch vụ khi chủ dự án duyệt hạ tầng (RAM ≥ 3 GiB) |
| SMTP relay | nhà cung cấp do chủ dự án chọn (ADR-0002) | `FakeEmailSender`; OTP portal kiểm qua hộp thư giả trong test |
| Môi trường agent | kho PGDG, GitHub releases | `scripts/dev-env-setup.sh` như đợt 1–2 |

## Ước lượng (agent + review người)
| Task | P50 | P90 |
|---|---|---|
| T-201, T-207, T-208, T-212, T-216, T-219, T-220, T-222 | 0,5 ngày mỗi task | 1 ngày |
| T-202, T-203, T-205, T-209, T-214, T-215, T-217, T-218 | 1 ngày | 1,5 ngày |
| T-204, T-206, T-210, T-211, T-213, T-221 | 1 ngày | 2 ngày |
Tổng P50 khoảng 18 ngày, P85 khoảng 27 ngày. Không dùng con số P50 làm ngày hứa.
