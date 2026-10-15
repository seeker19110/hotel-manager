# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5 Dựng nền (autopilot đợt 1) · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Autopilot đợt 1 — xong T-001…T-008 (bằng chứng `.autopilot/evidence/`, CI PR #4). Đang làm `T-009` inventory (allocations EXCLUDE, hold, block, chuyển phòng, 100 lệnh tranh phòng).

## Tiếp theo
1. `T-010` lõi sổ tiền; `T-011` file riêng tư SeaweedFS; `T-012` PITR pgBackRest + compose; `T-013` PWA shell; `T-014` E2E smoke.
2. Người làm song song: quan sát 6–10 cơ sở + baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc; mua VPS tại VN + kho sao lưu; chọn SMTP relay; giấy phép mã nguồn.

## Quyết định
- 2026-10-15 Repo hotel-manager chuyển thành repo sản phẩm; khung X-Templates 2.0.0 cài ở `.xtemplates/` (người dùng chọn).
- 2026-10-15 Đợt tự động đầu chỉ lập kế hoạch G0–G4, chưa viết code (người dùng chọn).
- 2026-10-15 Tự host toàn bộ (người dùng chọn): Postgres 17 + pgBackRest, Better Auth, SeaweedFS, Caddy, SMTP relay — ADR-0002. Dev/CI không mua dịch vụ.
- 2026-10-15 Blueprint: web-app + saas-multitenant + fintech, quy mô M (4 miễn đã duyệt: IND-FIN-009/010, IND-SAAS-005/012). Khung chưa có gói ngành lưu trú.
- 2026-10-15 Stack đề xuất ở ADR-0001 (proposed): Node 24 · Next 16.4 · PostgreSQL 17 · Kysely · pg-boss · Serwist (auth/storage/sao lưu: ADR-0002) · Vitest/Playwright/Testcontainers · Biome · pnpm.
- 2026-10-15 Review độc lập bộ kế hoạch: 6 🔴 · 21 🟠 · 19 🟢 — đã sửa trong DOMAIN-MODEL 1.2, SPEC v2, API-CONTRACT, THREAT-MODEL 1.1, PLAN (14 task).
- 2026-10-15 Chủ dự án duyệt PLAN đợt 1 (PR #3 merge): pilot theo backlog; mặc định tham số hoá cho câu hỏi [chặn] đợt 1; 4 miễn blueprint; 70 vòng / 48 giờ / 1800 s / ≤ 150 USD.
- 2026-10-15 Import trong workspace dùng đuôi `.ts` (`allowImportingTsExtensions`) để Turbopack, Vitest, tsc, Node cùng hiểu.
- 2026-10-15 Hook cổng commit không chạy được vì phiên mở ở `/home/user` (không thấy `xt.yaml`) → mọi commit qua `scripts/commit-gated.sh` (exit code thật).
- 2026-10-15 Relay outbox và liệt kê tổ chức đi qua hàm SECURITY DEFINER phạm vi hẹp; không mở BYPASSRLS/policy rộng cho worker.
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `502819e7b8bc837f7d51478d90e837c31767efd8` · CI: workflow của khung đã gỡ; CI sản phẩm thêm ở T-002.
- Lệnh kiểm nhanh: chưa có (xt.yaml trống tới T-002).
- Đang chặn: không.
- Việc dở chưa commit: không.
- Câu hỏi cần người: câu hỏi [chặn] đợt 2–3 trong SPEC (PO).
