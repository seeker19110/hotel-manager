# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 3) · Cập nhật: 2026-10-16 · Nhánh: claude/gallant-shannon-2uccvp (xếp chồng trên PR #5)

## Đang làm
- Autopilot đợt 3 (`docs/autopilot/PLAN.md`, 26 task T-201…T-226, tự duyệt D-009; 130 vòng / 120 giờ). Xong: T-201…T-212 (review lát khách sạn đang chạy).
- PR #5 (đợt 2, nhánh `claude/gifted-noether-iybenn`): CI xanh 6/6, mergeable — chờ chủ dự án merge; nhánh đợt 3 xếp chồng lên (D-001).

## Tiếp theo
1. Theo `loop status`: T-202 (mã hoá số giấy tờ) → T-203 (clamd) → lát khách sạn T-204…T-210.
2. Chờ người (không chặn vòng): merge PR #5; import ruleset `.github/rulesets/main.json`; quan sát 6–10 cơ sở + baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc (thông báo lưu trú, NĐ 356/2025, TT 50/17/2024); VPS tại VN + kho sao lưu khác máy; SMTP relay; ClamAV trên VPS; giấy phép mã nguồn; xác nhận 32 miễn trừ blueprint đợt 2.

## Quyết định
- 2026-10-15 Repo sản phẩm + khung X-Templates ở `.xtemplates/`; tự host toàn bộ (ADR-0002); blueprint web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm).
- 2026-10-15 Đợt 1 (PR #4) và đợt 2 (PR #5): chi tiết ở git log, `docs/autopilot/archive/`. Quy ước đã chốt: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; hàm SECURITY DEFINER phạm vi hẹp cho worker; pool ≤ 20 + `max_connections=100`; Serwist không cache điều hướng; cookie `__Host-hm_org` chỉ để chọn, mọi request `resolveActor`; E2E Chromium có sẵn (`/opt/pw-browsers`).
- 2026-10-15 Đợt 2: lễ tân đọc ca/thanh toán trong phạm vi, chỉ ghi của mình; kế toán không mở ca, không duyệt; hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ chỉ check-out; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt; làm tròn chỉ trong `money`; import qua hàm module sở hữu, XLSX tự viết.
- 2026-10-16 Đợt 3 tự duyệt (`docs/autopilot/DECISIONS.md`): D-001 xếp chồng trên PR #5 · D-002 câu [chặn] đợt 3 theo đề xuất SPEC, tham số hoá · D-003 quét file qua clamd (ClamAV) + bản giả · D-004 số giấy tờ AES-256-GCM tầng app + blind index · D-005 người thuê đăng nhập OTP email · D-006 liên kết khách token 256 bit + 4 số cuối SĐT · D-007 phụ lục hợp đồng không thời hạn qua `superseded_on` · D-008 giá dịch vụ chỉ owner (theo ma trận) · D-009 duyệt PLAN đợt 3.
- Bài học: luôn `set -o pipefail` với `loop record`; lọc test DB bằng `pnpm vitest run --project db <mẫu>` (`pnpm test:db -- x` chạy toàn bộ).
- Nợ kỹ thuật chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Nhánh chính: `da4a086` (PR #7). Đợt 2: PR #5 `a4c0a1d`. Đợt 3: nhánh này.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` rồi `pnpm install --frozen-lockfile`.
- Đang chặn: không. Autopilot: bật (một phiên).
- Việc dở chưa commit: không.
