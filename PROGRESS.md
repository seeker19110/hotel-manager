# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G4 Thiết kế xong bản nháp → chờ cổng duyệt PLAN · Cập nhật: 2026-10-15 · Nhánh: claude/gifted-noether-iybenn

## Đang làm
- Cổng duyệt duy nhất (autopilot pha 1): người dùng duyệt `PROJECT.md`, `BLUEPRINT.md`, `docs/adr/0001-*`, `docs/specs/SPEC-*.md`, `docs/design/*`, `docs/autopilot/PLAN.md`. Trạng thái: chờ người quyết.

## Tiếp theo
1. Người dùng duyệt PLAN và 4 con số ngân sách. Sau đó `python3 .xtemplates/scripts/xt.py loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --max-iterations 60 --hours 48`.
2. `T-001` Dựng pnpm workspace + CI (Gate: `.xtemplates/scripts/dev-task.sh gate`).
3. PO trả lời các câu hỏi **[chặn]** trong SPEC (prorata, làm tròn, giờ nhận/trả, ghi nhận doanh thu…) trước đợt 2.
4. Người làm, song song: quan sát 6–10 cơ sở và đo baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc; chọn hosting; chọn giấy phép mã nguồn.

## Quyết định
- 2026-10-15 Repo hotel-manager chuyển thành repo sản phẩm; khung X-Templates 2.0.0 cài ở `.xtemplates/` (người dùng chọn).
- 2026-10-15 Đợt tự động đầu chỉ lập kế hoạch G0–G4, chưa viết code (người dùng chọn).
- 2026-10-15 Dev/CI dùng Postgres + Supabase cục bộ; chưa mua dịch vụ (người dùng chọn).
- 2026-10-15 Blueprint: web-app + saas-multitenant + fintech, quy mô M (494 MUST mở, 2 miễn: IND-FIN-009/010). Khung chưa có gói ngành lưu trú.
- 2026-10-15 Stack đề xuất ở ADR-0001 (proposed): Node 24 · Next 16.4 · PostgreSQL 17 · Kysely · pg-boss · Supabase Auth · Serwist · Vitest/Playwright/Testcontainers · Biome · pnpm.
- Nợ kỹ thuật chấp nhận: phần pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `f1cfba01a0f7cdefa4d09341758072f7c7d56329` · CI: workflow của khung đã gỡ; CI sản phẩm thêm ở T-001.
- Lệnh kiểm nhanh: chưa có (xt.yaml trống tới T-001).
- Đang chặn: chờ cổng duyệt PLAN.
- Việc dở chưa commit: không.
- Câu hỏi cần người: duyệt PLAN + câu hỏi [chặn] trong SPEC — hỏi chủ dự án/PO.
