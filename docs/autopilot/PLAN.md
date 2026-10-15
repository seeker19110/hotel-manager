# docs/autopilot/PLAN.md — Hotel Manager · Đợt 2: nhà trọ (hợp đồng, công tơ/kỳ thu, thu tiền/cọc, import)

> **Duyệt bởi chủ dự án ngày 2026-10-15** (gọi `/autopilot` sau cổng duyệt đợt 2; trước đó đã giao quyền quyết "chất lượng cao nhất"): chấp nhận 18 task, bảng mặc định cho câu hỏi [chặn], ngân sách 90 vòng · ≤ 220 USD · 1800 s · 72 giờ. Đợt 1 đã xong và merge (PR #4, `main` `07ba2a8`); kế hoạch đợt 1 lưu ở `archive/PLAN-dot-1.md`.
> Kiến trúc: ADR-0001 + ADR-0002. Spec: `SPEC-lease` (F-003), `SPEC-metering-billing` (F-004), `SPEC-ledger-payments` (F-005), `SPEC-import` (F-010), phần access/MFA còn chặn pilot. Thuật ngữ và tên bảng: DOMAIN-MODEL v1.3 + ERD.
> Lõi dùng lại của đợt 1: command pipeline (idempotency, audit, outbox, `onRollback`), RLS + phạm vi cơ sở, allocation/hold, sổ phụ cân bằng, inbox ngân hàng, file riêng tư, PWA shell, E2E server.

## Mục tiêu của kế hoạch này
Khi xong đợt này, một chủ trọ (dữ liệu giả) đi trọn vòng tháng: import dữ liệu đang chạy → ký hợp đồng có giữ chỗ và cọc → bàn giao → chốt chỉ số → phát hành kỳ thu → thu tiền mặt/chuyển khoản, đối soát sao kê → thanh lý và hoàn cọc có duyệt. Mỗi bước có test chứng minh bất biến tiền:
- ví dụ bắt buộc của SPEC khớp từng đồng (kỳ thu 3.580.000 đ; thu một phần 1.580.000 đ);
- phân bổ không vượt tiền thu, không vượt số còn của phiếu, kể cả hai người cùng lúc (INV-F2);
- một giao dịch ngân hàng = một khoản thu dù đến từ webhook, sao kê và nhập tay (INV-F4/F4b);
- cọc không tự trừ, khấu trừ/hoàn cần người thứ hai và trong hạn mức (INV-F5);
- import lại cùng file không nhân đôi; số dư đầu kỳ không bịa doanh thu.

Tương ứng mốc "Tuần 5–8" của kế hoạch gốc (mảng trọ). Khách sạn/vận hành là đợt 3.

## Ngân sách (4 con số) — đề xuất, người chốt khi duyệt
- Số vòng tối đa: **90** (`--max-iterations 90`)
- Ngân sách: **≤ 220 USD** token cho đợt này. Hết ngân sách thì bàn giao và dừng.
- Timeout mỗi lệnh Gate: **1800 s** (`XT_RECORD_TIMEOUT`, mặc định)
- Ngày hết hạn: **72 giờ** kể từ `loop init` (`--hours 72`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | tuần 8 kể từ ngày đội khởi động | trễ mốc pilot tuần 12 | cắt T-115 (import) và T-117 (UI) sang đợt 3; không hạ cổng |

## Quyết định mặc định cho câu hỏi [chặn] của đợt 2 — **duyệt PLAN = chấp nhận** (tham số hoá theo cơ sở, đổi giá trị không cần migration; mỗi chứng từ lưu quy tắc đã dùng — INV-G3)
| Câu hỏi | Mặc định áp dụng | Tham số |
|---|---|---|
| Prorata kỳ đầu/cuối lẻ (metering Q) | `giá × số ngày tính tiền / số ngày thực của tháng`; trọn tháng = giá tháng; ngày đầu và ngày cuối đều tính | `properties.settings.prorata` = `actual_days` \| `fixed_30` |
| Làm tròn (metering/ledger Q) | `HALF_UP_1` từng dòng; tổng phiếu = Σ dòng, không làm tròn lại | `properties.settings.rounding` = `HALF_UP_1` \| `HALF_UP_1000` |
| Kỳ thu, thu trước/sau (metering Q) | Tháng dương lịch của cơ sở; tiền thuê và điện nước cùng tháng, phát hành cuối kỳ (thu sau) | `rent_timing` = `arrears` \| `advance` |
| Tiền thuê kỳ cuối khi trả sớm (lease Q) | Tính đến `moved_out_on` theo prorata; không tự tính phạt, nhân viên thêm phí một lần có lý do | — |
| Mốc giờ allocation hợp đồng (lease Q) | Bắt đầu 00:00 giờ cơ sở của ngày bàn giao (trước bàn giao: ngày hiệu lực); kết thúc 00:00 giờ cơ sở của `moved_out_on + 1` | — |
| Hạn mức duyệt hoàn/khấu trừ (ledger Q, access Q-11) | `front_desk` ≤ 2.000.000 đ/lần, chỉ cọc khách sạn lúc check-out; `manager` ≤ 5.000.000 đ; `owner` không giới hạn; `accountant` chỉ lập đề nghị; cấm tự duyệt | mặc định theo vai trò ở `organizations.settings.role_limits`, ghi đè ở `memberships.limits` (ERD 7.1 #9) |
| Lễ tân tự hoàn nguyên số cọc khách sạn lúc check-out (ledger Q) | Được, một bước, trong hạn mức; khấu trừ/hoàn vượt hạn mức luôn cần người thứ hai | — |
| Chứng cứ tiền mặt (INV-F3b) | Mọi tiền mặt, kể cả cọc, đi qua `payments` `pending → confirmed`; lễ tân xác nhận tiền mặt do chính mình nhận trong ca đang mở; biên nhận do hệ thống sinh; chênh lệch xử lý khi đóng ca | — |
| Hoàn `CUSTOMER_CREDIT` (ledger Q, chặn pilot) | Không buộc bù trừ nếu không còn nợ; còn nợ thì gợi ý bù trừ trước; hoàn qua `credit.requestRefund`/`credit.approveRefund` cùng hạn mức trên | — |
| TTL giữ chỗ hợp đồng (access Q-12) | 48 giờ; owner/manager/lễ tân được giữ | `properties.lease_hold_ttl_hours` (đã có) |
| Khôi phục MFA (access Q-08, chặn pilot) | Owner khác reset MFA, bắt xác thực lại, có audit; owner duy nhất → hỗ trợ nền tảng (ngoài đợt này) | — |
| `approval_requests` cột loại (ERD 7.1 #1) | `kind` (theo ERD); sửa SPEC-access §4 | — |
| Khấu trừ cọc/điều chỉnh giảm AR (ERD 7.3 #1) | Khấu trừ cọc ghi `payment_allocations` có `deposit_id` (cùng hàng rào INV-F2); điều chỉnh là chứng từ điều chỉnh có bút toán Nợ `DISCOUNT` / Có `AR` | — |
| Webhook tự phân bổ (ledger Q, không chặn) | Có, khi mã tham chiếu khớp và số tiền ≤ số còn; thừa → `CUSTOMER_CREDIT`; không khớp → hàng chờ | — |
| CSV sao kê (ledger Q, không chặn) | Ánh xạ cột cấu hình theo tài khoản nhận; có sẵn 2 mẫu giả | — |

## Điểm dừng bắt buộc (`python3 .xtemplates/scripts/xt.py loop block --reason "..."`)
- Tiền thật hoặc tài khoản ngân hàng thật; kết nối API ngân hàng/cổng thanh toán thật (đợt này chỉ webhook **mô phỏng** + CSV giả).
- Mua VPS/tên miền, SMTP, secret thật, deploy staging/production, gửi email/SMS/Zalo ra ngoài.
- Dữ liệu thật của người dùng (kể cả file sao kê hay danh sách người thuê chưa ẩn danh).
- Đổi quyền, ruleset, required checks, cấu hình cổng/CI/hook (CI đợt này giữ nguyên 6 job; thêm test mới chạy trong job sẵn có).
- Câu hỏi [chặn] **ngoài** bảng trên, hoặc SPEC mâu thuẫn nhau/với DOMAIN-MODEL mà bảng trên chưa giải.
- Thay đổi phá vỡ migration đã có trên `main` (chỉ thêm migration mới).
- Hai lần cùng lỗi Gate với hai cách tiếp cận khác nhau (máy tự BLOCKED ở lần 3).

## Thứ tự và lý do
1. **Lát 0 — chốt quyết định + nền dùng chung** (T-101…T-103): quyết định vào SPEC trước khi code (một chỗ quyết); duyệt/hạn mức và ca quầy là tiền đề của mọi luồng tiền; API command thống nhất để UI và E2E gọi.
2. **Lát 1 — tiền** (T-104…T-108): rủi ro R03 (ghi tiền sai/trùng) là đường găng; hợp đồng và kỳ thu đều phát sinh chứng từ tiền nên lõi thu/phân bổ/cọc phải có trước.
3. **Lát 2 — hợp đồng** (T-109…T-111).
4. **Lát 3 — công tơ và kỳ thu** (T-112…T-114): engine tính tiền thuần (property test) tách khỏi vòng đời kỳ.
5. **Lát 4 — import, khôi phục MFA, UI + E2E vòng tháng, rà blueprint** (T-115…T-118).

## Task

> Gate là lệnh máy kiểm, chạy bằng `python3 .xtemplates/scripts/xt.py loop record --task T-xxx -- <Gate>`. Mọi bất biến tiền/tồn có test trên Postgres thật (`*.db.test.ts`). Ví dụ số tiền bắt buộc của SPEC phải có test khớp từng đồng.

### Lát 0 — Chốt quyết định và nền dùng chung
- [x] `T-101` Ghi các quyết định ở bảng trên vào SPEC (mục 10: tick kèm "quyết theo PLAN đợt 2, ngày, tham số"), DOMAIN-MODEL/ERD (7.1 #1, #9; 7.3 #1, #5); thêm `scripts/check-blocking-questions.py` (exit ≠ 0 nếu SPEC được nêu còn câu `[chặn]` chưa tick) + test — Gate: `python3 scripts/check-blocking-questions.py lease metering-billing ledger-payments import && python3 -m unittest discover -s scripts -p "test_*.py"`
- [x] `T-102` Duyệt và hạn mức: bảng `approval_requests` (`kind`, số tiền, người lập/duyệt, trạng thái), `organizations.settings.role_limits` + ghi đè `memberships.limits`; `approval.request/approve/reject` dùng `authorize()` (`APPROVAL_LIMIT_EXCEEDED`, `SELF_APPROVAL_FORBIDDEN`), thực thi đúng một lần sau duyệt (ledger S-014, S-033; access S-017) — Gate: `pnpm test:db -- approvals`
- [x] `T-103` API command thống nhất: `POST /api/v1/<module>/<command>` (Zod, `Idempotency-Key`, ngữ cảnh tổ chức, problem+json, `correlation_id`), `GET /api/v1/commands/{id}` (SPEC-pwa S-010…S-012, S-019); danh mục mã lỗi `packages/app/src/errors.ts` + test khớp bảng API-CONTRACT §2 — Gate: `pnpm vitest run packages/app/src/http apps/web/app/api`

### Lát 1 — Tiền: thu, phân bổ, cọc, ca, đối soát (F-005)
- [x] `T-104` Ca quầy: `shifts`, `shift_discrepancies`; mở/đóng ca có chênh lệch, bàn giao ca xác nhận hai bên; tiền mặt chỉ xác nhận trong ca đang mở của chính người nhận (ledger S-027, S-028, S-034, S-035) — Gate: `pnpm test:db -- shifts`
- [x] `T-105` Thanh toán: `payments` `pending → confirmed → reversed`, chứng cứ theo INV-F3/F3b, biên nhận đánh số theo cơ sở; `payment_allocations` không vượt tiền thu/số còn kể cả 2 người đồng thời; trả thừa → `CUSTOMER_CREDIT`; đảo thanh toán đã phân bổ (ledger S-001, S-003…S-010, S-025, S-026; ví dụ 1.580.000 đ) — Gate: `pnpm test:db -- payments`
- [ ] `T-106` Cọc và số dư khách: `deposits` (nhận qua `payments`, `DEPOSIT_LIAB`), khấu trừ = `payment_allocations` có `deposit_id` cần duyệt, hoàn trong hạn mức, không vượt số còn; hoàn `CUSTOMER_CREDIT` qua duyệt (ledger S-011…S-014, S-031, S-033) — Gate: `pnpm test:db -- deposits`
- [ ] `T-107` QR và đối soát: thông tin VietQR theo tài khoản nhận (chỉ hiển thị, S-015); import CSV sao kê có ánh xạ cột, chống nhập trùng, ghép theo mã tham chiếu, hàng chờ `reconciliation_breaks`, xác nhận từ sao kê, người khác trả hộ; webhook/sao kê/nhập tay cùng giao dịch = 1 payment; tự phân bổ khi khớp (S-016…S-021, S-029, S-030) — Gate: `pnpm test:db -- reconciliation`
- [ ] `T-108` Chốt kỳ sổ: `period_locks` (INV-F6), điều chỉnh sau khoá bằng chứng từ kỳ mở, mở khoá chỉ owner; báo cáo tách tiền thu / doanh thu / cọc / công nợ khớp sổ phụ (S-022…S-024, S-032) — Gate: `pnpm test:db -- period-close`

### Lát 2 — Hợp đồng và bàn giao (F-003)
- [ ] `T-109` Schema + soạn/ký: `leases`, `lease_versions` (điều khoản bất biến sau ký), `lease_occupants` (PII tối thiểu, SĐT bắt buộc với người thuê); `lease.hold` (TTL theo cơ sở, cọc giữ chỗ), `lease.sign` chuyển hold → allocation `lease` không khoảng trống; quyền đọc theo vai trò/người thuê (lease S-001…S-004, S-008…S-010, S-020, S-022…S-024) — Gate: `pnpm test:db -- lease`
- [ ] `T-110` Bàn giao + phụ lục: `handovers` (mục bắt buộc, ảnh qua file riêng tư, chỉ số đầu), kích hoạt chỉ sau bàn giao; phụ lục gia hạn/đổi giá theo ngày hiệu lực, chặn chồng hiệu lực; nhắc hết hạn không lặp (`outbox.dedupe_key`); quá hạn chưa trả → cảnh báo chiếm dụng (S-005…S-007, S-011…S-015) — Gate: `pnpm test:db -- lease-handover`
- [ ] `T-111` Báo trả + thanh lý: `lease_settlements`; phí hư hỏng thành phiếu trước, khấu trừ ≤ AR còn mở của phiếu liên kết, hoàn phần còn lại qua duyệt, người lập không tự duyệt; tiền thuê kỳ cuối prorata đến `moved_out_on`; allocation kết thúc `moved_out_on + 1` (S-016…S-019, S-021, S-025) — Gate: `pnpm test:db -- lease-settlement`

### Lát 3 — Công tơ và kỳ thu (F-004)
- [ ] `T-112` Dịch vụ và công tơ: `services`, `service_prices` (hiệu lực), `meters`, `meter_readings` (không giảm, `METER_READING_DECREASED`), `meter_events` (thay công tơ có quyền); cảnh báo bất thường; thiếu chỉ số; thứ tự chốt theo tuyến tầng (metering S-005…S-010, S-017) — Gate: `pnpm test:db -- meters`
- [ ] `T-113` Engine tính tiền thuần (`packages/domain/src/billing`): tiền thuê prorata theo tham số, dòng theo chỉ số, phí theo người/một lần, đổi giá giữa kỳ tách hai đoạn, làm tròn qua đúng một hàm; property test (Σ dòng = tổng, không âm, prorata trọn tháng = giá tháng); ví dụ 3.580.000 đ (S-001, S-016, S-018…S-021) — Gate: `pnpm vitest run packages/domain/src/billing`
- [ ] `T-114` Vòng đời kỳ thu: job tạo kỳ theo ngày địa phương, chạy lại không trùng; xem trước có hash (cũ thì không phát hành); duyệt; phát hành → `invoices`/`invoice_lines`/`charges` snapshot + bút toán AR/REV (INV-F1, INV-G3/G4); không sửa sau phát hành; khoá/mở khoá kỳ; phát hành lặp = 1 (S-002…S-004, S-011…S-015) — Gate: `pnpm test:db -- billing`

### Lát 4 — Import, khôi phục MFA, UI và E2E vòng tháng
- [ ] `T-115` Import (F-010): mẫu file, xem trước lỗi từng dòng, commit nguyên khối, `external_id` chống nhân đôi/khác nội dung, hợp đồng đang chạy + người ở + bàn giao chuyển đổi, chỉ số đầu, nợ/cọc đầu kỳ qua `OPENING_BALANCE`, đối chiếu tổng với số nguồn, người phụ trách xác nhận, chống CSV formula injection (import S-001…S-020; lease S-026) — Gate: `pnpm test:db -- import`
- [ ] `T-116` Khôi phục MFA: owner khác reset MFA của thành viên (bắt xác thực lại, thu hồi phiên, audit); không tự reset của mình; owner duy nhất → thông báo liên hệ hỗ trợ (access Q-08) — Gate: `pnpm test:db -- mfa-recovery`
- [ ] `T-117` UI trọ tối thiểu theo design system (hợp đồng: danh sách/chi tiết/ký/bàn giao; chốt chỉ số theo tầng; kỳ thu: xem trước/phát hành; thu tiền + phân bổ; cọc/thanh lý; hàng chờ đối soát) + E2E vòng tháng với dữ liệu giả, kiểm axe và vùng chạm, timeout/`GET /commands` (SPEC-pwa S-006, S-010, S-011) — Gate: `pnpm --filter web exec playwright test rental`

- [ ] `T-118` Rà blueprint (thiếu của đợt 1: 0/492 MUST được tick dù nhiều mục đã có bằng chứng): tick `[x]` mục MUST/SHOULD đã đạt ở đợt 1–2 kèm `Bằng chứng: <file test/CI job/script>`; `scripts/check-blueprint-evidence.py` (exit ≠ 0 nếu mục `[x]` thiếu bằng chứng hoặc đường dẫn không tồn tại) + test; ghi danh sách MUST còn mở theo đợt 3–4 vào PROGRESS — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 -m unittest discover -s scripts -p "test_*.py"`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Định dạng sao kê ngân hàng pilot | đại diện pilot | 2 mẫu CSV giả + ánh xạ cột cấu hình; thêm mẫu thật khi có (đã ẩn danh) |
| VietQR | chuẩn NAPAS (chỉ sinh chuỗi hiển thị) | không gọi API ngoài; test theo ví dụ chuẩn đã xác minh ở `/research` trước T-107 |
| Môi trường agent | kho PGDG, GitHub releases | `scripts/dev-env-setup.sh` như đợt 1 |

## Ước lượng (agent + review người)
| Task | P50 | P90 |
|---|---|---|
| T-101, T-103, T-104, T-116, T-118 | 0,5 ngày mỗi task | 1 ngày |
| T-102, T-106, T-108, T-110, T-112 | 1 ngày | 1,5 ngày |
| T-105, T-107, T-109, T-111, T-113, T-114, T-115, T-117 | 1 ngày | 2 ngày |
Tổng P50 khoảng 15,5 ngày, P85 khoảng 23 ngày. Không dùng con số P50 làm ngày hứa.
