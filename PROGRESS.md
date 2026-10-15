# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Autopilot đợt 2 (PLAN duyệt) — Pha 2: T-101…T-118 xong có bằng chứng (`.autopilot/evidence/`). Đang sửa theo review lát 4 (0 🔴 · 3 🟠 · 6 🟢), rồi báo cáo cuối + chuyển PR #5 sẵn review. PR nháp #5.

## Tiếp theo
0a. [Chặn trước khi nhập dữ liệu thật] Job hạn giữ: xoá object file nguồn theo `files.delete_after` + làm rỗng `import_rows.raw/data` sau commit/huỷ 30 ngày (review lát 4 🟠3) — cần worker nối object storage + policy worker cho `files`/`import_rows`; route `import.upload` multipart làm cùng lúc.
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
- 2026-10-15 Đợt 2 (theo SPEC khi ERD/ma trận lệch): lễ tân đọc ca/thanh toán trong phạm vi, chỉ ghi của mình; kế toán đóng/đối chiếu ca, không mở ca, không duyệt; hạn mức phân bổ mặc định quản lý 5.000.000 đ. Gate `pnpm test:db -- x` chạy toàn bộ test DB. Bài học: luôn `set -o pipefail` với `loop record`.
- 2026-10-15 T-107: thanh toán hệ thống `source='bank_auto'` chỉ worker ghi, chỉ khi webhook đã xác minh và khớp đúng 1 phiếu; còn lại vào `reconciliation_breaks`. Dấu vân tay giao dịch = mã + số tiền. VietQR theo chuỗi mẫu tự khớp CRC — văn bản NAPAS gốc (chưa xác minh), kiểm lại trước G7.
- 2026-10-15 T-108: khoá kỳ theo `business_date` (chỉ ngày đã qua, chỉ tiến); trigger PERIOD_LOCKED trên sổ/thanh toán/charges. Điều chỉnh chỉ GIẢM, qua duyệt người khác; tăng tiền = phiếu phí mới; số còn phải thu = `invoices.open_amount`.
- 2026-10-15 T-109: lỗi theo trường `errors[]{path, field, code}`; giữ chỗ hợp đồng khoá phòng + EXCLUDE (không khoá `leases`).
- 2026-10-15 Review lát tiền/hợp đồng/kỳ thu: đã sửa đủ 🔴/🟠 kèm test hồi quy (chi tiết trong git log).
- 2026-10-15 T-110…T-113: công tơ/`billing_periods` tạo sớm khi bàn giao/chỉ số cần; bàn giao trả chuyển `settling`; khấu trừ mặc định = min(cọc, AR + phí), duyệt kiểm lại cọc/AR dưới khoá; bất thường = > 2 × TB 3 kỳ; dòng tiền thuê lưu quantity = số ngày, unit_price = giá tháng, denominator; làm tròn chỉ trong `money` (test kiến trúc).
- 2026-10-15 T-114: phát hành khoá chỉ số nháp của kỳ rồi chỉ duyệt đúng các chỉ số đó; kế toán được duyệt (không sửa) chỉ số — policy + trigger; quyết toán bị chặn `FINAL_PERIOD_NOT_ISSUED` khi cơ sở dùng kỳ thu mà kỳ chứa ngày trả chưa phát hành; factory test dùng `app.business_date` (trước dùng `current_date` UTC → lệch sau 17:00Z).
- 2026-10-15 Hỏi chủ dự án: 🟠6 quản lý có được đặt giá dịch vụ (SPEC-metering nói có, ma trận nói không — code chỉ owner); dịch vụ cố định theo phiên bản hiệu lực ngày cuối kỳ.
- 2026-10-15 T-115: import qua đúng hàm module sở hữu, commit nguyên khối (lỗi dòng ⇒ lô về `validated` + CONFLICT_AT_COMMIT ở transaction lưu lỗi); `external_id` theo cơ sở; XLSX đọc/ghi tự viết (zlib, giới hạn chống zip bomb, không tính công thức) — không thêm thư viện; S-009 (booking) và route upload multipart chờ đợt 3/web nối storage.
- 2026-10-15 T-117: UI trọ (hợp đồng, kỳ thu, chỉ số theo tầng, thu tiền, cọc, đối soát) gọi command qua `useCommand` (offline/timeout/`GET /commands`/gửi lại cùng key); lệnh gộp `payment.collectCash`; E2E chủ trọ đăng nhập TOTP thật; hàng rào `erasableSyntaxOnly` (Node strip-only không chạy parameter property).
- 2026-10-15 T-118: blueprint MUST 87 đạt (bằng chứng máy, `scripts/check-blueprint-evidence.py`) · 36 miễn (32 mới: AI/realtime/cache/tìm kiếm/OAuth… không có trong sản phẩm — chờ chủ dự án xác nhận) · 373 mở: BASE 52, OPS 29, WF 27, XC 26, FE 25, CMP 25, UX 22, BE 22, DB 21, PM 19, SEC 18, QA 18, ARC 17, IND 17, STD 15, LOOP 11, PRF 9 → đợt 3 (khách sạn + vận hành/OPS/quan sát) và đợt 4 (G7 phát hành). Hỏi chủ dự án: miễn XC-OSS-001/007 (không mở mã?), IND-FIN-008 (TT 50/17/2024).
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `07ba2a8639c13db751773a98da3ae6114cfad249` (đợt 1, PR #4, CI xanh 6/6).
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` trước.
- Đang chặn: không. Autopilot: tắt.
- Việc dở chưa commit: không.
- Câu hỏi cần người: mục *Tiếp theo* 1–3.
