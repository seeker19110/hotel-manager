# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Autopilot đợt 2 (PLAN duyệt) — Pha 2: T-101…T-113 xong có bằng chứng (`.autopilot/evidence/`). T-113 xong. Kế tiếp **T-114** vòng đời kỳ thu. Ghi nhớ cho T-114: `lease.prepareSettlement` phải chặn khi kỳ thu cuối (prorata đến `moved_out_on`) chưa phát hành. PR nháp #5.

## Tiếp theo
0. [Câu hỏi cho chủ dự án, không chặn] Hợp đồng KHÔNG thời hạn đã ký thì không đổi giá được: phụ lục chồng hiệu lực với phiên bản 1 (mở cuối, bất biến) ⇒ LEASE_VERSION_OVERLAP. Đề xuất: phụ lục được phép "đóng" ngày hết hạn của phiên bản mở cuối ngay trước nó (chỉ NULL → ngày trước hiệu lực phụ lục, ghi audit; điều khoản đã ký không đổi). Cần duyệt vì chạm bất biến INV-G4.
1. Chủ repo import ruleset `.github/rulesets/main.json` (Settings → Rules → Rulesets → Import) — agent không có API để bật.
2. Lập PLAN đợt 2: luồng R-001…R-005 (đặt/nhận/trả phòng, hợp đồng, kỳ thu, thanh toán) trên lõi đợt 1; trả lời câu hỏi [chặn] đợt 2 trong SPEC trước. Kèm: chọn máy quét mã độc thật, quyết mã hoá cột số giấy tờ, lưu cơ sở đang chọn (`property_id` của switchOrganization mới chỉ kiểm + trả về), route `GET /api/v1/commands/{id}`.
3. Người làm song song: quan sát 6–10 cơ sở + baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc; mua VPS tại VN + kho sao lưu khác máy; chọn SMTP relay; giấy phép mã nguồn.

## Quyết định
- 2026-10-15 Repo hotel-manager chuyển thành repo sản phẩm; khung X-Templates 2.0.0 cài ở `.xtemplates/` (người dùng chọn).
- 2026-10-15 Đợt tự động đầu chỉ lập kế hoạch G0–G4, chưa viết code (người dùng chọn).
- 2026-10-15 Tự host toàn bộ (người dùng chọn): Postgres 17 + pgBackRest, Better Auth, SeaweedFS, Caddy, SMTP relay — ADR-0002. Dev/CI không mua dịch vụ.
- 2026-10-15 Blueprint: web-app + saas-multitenant + fintech, quy mô M (4 miễn đã duyệt: IND-FIN-009/010, IND-SAAS-005/012). Khung chưa có gói ngành lưu trú.
- 2026-10-15 Stack đề xuất ở ADR-0001 (proposed): Node 24 · Next 16.4 · PostgreSQL 17 · Kysely · pg-boss · Serwist (auth/storage/sao lưu: ADR-0002) · Vitest/Playwright/Testcontainers · Biome · pnpm.
- 2026-10-15 Review độc lập bộ kế hoạch: 6 🔴 · 21 🟠 · 19 🟢 — đã sửa trong DOMAIN-MODEL 1.2, SPEC v2, API-CONTRACT, THREAT-MODEL 1.1, PLAN (14 task).
- 2026-10-15 Chủ dự án duyệt PLAN đợt 1 (PR #3 merge): pilot theo backlog; mặc định tham số hoá cho câu hỏi [chặn] đợt 1; 4 miễn blueprint; 70 vòng / 48 giờ / 1800 s / ≤ 150 USD.
- 2026-10-15 Đợt 1 (chi tiết: git log/PR #4): import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; relay/liệt kê tổ chức qua hàm SECURITY DEFINER hẹp; pool ≤ 20 + `max_connections=100` như CI; Serwist Turbopack, không cache điều hướng; cookie `__Host-hm_org` chỉ để chọn, mọi request `resolveActor`; E2E Chromium có sẵn; review đợt 1 đã xử lý, chủ dự án cấp quyền sửa CI.
- 2026-10-15 Đợt 2, quyết trong lúc chạy (theo SPEC khi ERD/ma trận lệch): lễ tân ĐỌC ca/thanh toán trong phạm vi nhưng chỉ GHI cái của mình (để trả 403 đúng S-028/S-034); kế toán đóng/đối chiếu ca, không mở ca; kế toán thấy yêu cầu duyệt (403 khi duyệt, S-033); hạn mức phân bổ mặc định của quản lý = 5.000.000 đ (trước là 0 → quản lý không phân bổ được); tiền mặt dự kiến tính từ sổ phụ; đảo tiền mặt khi ca gốc đã chốt → dòng CASH vào ca đang mở của người đảo. Gate `pnpm test:db -- x` chạy toàn bộ test DB (pnpm không lọc). Bài học lặp: `loop record … | tail` nuốt exit code → luôn `set -o pipefail`.
- 2026-10-15 T-107: webhook không có người dùng ⇒ thanh toán hệ thống `source='bank_auto'` (`recorded_by`/`confirmed_by` NULL như `files.uploaded_by`), chỉ worker (`app_worker`, policy riêng) ghi, chỉ khi có webhook đã xác minh (trigger) và khớp đúng 1 phiếu không vượt số còn; còn lại vào `reconciliation_breaks`. Dấu vân tay giao dịch = mã + số tiền (bỏ thời điểm: sao kê chỉ có ngày). VietQR theo 3 chuỗi mẫu tự khớp CRC — văn bản NAPAS gốc (chưa xác minh), kiểm lại trước G7. Break do vai trò `payment.confirm_transfer` (owner/manager/accountant) xử lý; QR cho người thuê tự xem chờ cổng người thuê.
- 2026-10-15 T-108: khoá kỳ theo `business_date` cơ sở (chỉ ngày đã qua, chỉ tiến; mở khoá từ ngày X nhả mọi khoá ≥ X), trigger PERIOD_LOCKED trên `journal_entries`/`payments` (+`charges` ở T-113). Điều chỉnh chỉ GIẢM, luôn qua duyệt người khác (INV-G4), ghi kỳ mở bằng phiếu `adjustment` âm; số còn phải thu = cột sinh `invoices.open_amount`. Tăng tiền = phiếu phí mới. Báo cáo đọc từ sổ phụ; xuất CSV để SPEC-audit-reporting (job xuất).
- 2026-10-15 T-109: lỗi theo trường trả `errors[]{path, field, code}` (API-CONTRACT dùng `path`, SPEC dùng `field`). Giữ chỗ hợp đồng không khoá hàng `leases` (lễ tân không ghi được) — khoá phòng + EXCLUDE. `allocation.expired` → `allocation.hold_expired` theo SPEC.
- 2026-10-15 Review lát tiền: phân bổ kiểm số dư CUSTOMER_CREDIT thật (mutex `persons`, theo cơ sở); xác nhận thanh toán ghi sổ theo NGÀY XÁC NHẬN (kỳ cũ khoá vẫn xác nhận được); kiểm ca mở `FOR SHARE`; kế toán không duyệt loại nào (mục 10); chênh lệch ca bất biến, chỉ owner/manager sửa; cọc đặt phòng chưa khấu trừ được tới đợt 3; chữ ký `sim` gắn tài khoản; LEDGER_UNBALANCED = 500 giữ mã + cảnh báo.
- 2026-10-15 T-110…T-113: công tơ/`billing_periods` tạo sớm khi bàn giao/chỉ số cần; bàn giao trả chuyển `settling`; khấu trừ mặc định = min(cọc, AR + phí), duyệt kiểm lại cọc/AR dưới khoá; bất thường = > 2 × TB 3 kỳ; dòng tiền thuê lưu quantity = số ngày, unit_price = giá tháng, denominator; làm tròn chỉ trong `money` (test kiến trúc).
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `07ba2a8639c13db751773a98da3ae6114cfad249` (đợt 1, PR #4, CI xanh 6/6).
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` trước.
- Đang chặn: không. Autopilot: tắt.
- Việc dở chưa commit: không.
- Câu hỏi cần người: mục *Tiếp theo* 1–3.
