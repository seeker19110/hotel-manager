# PROGRESS.md — Hotel Manager
## Đang làm
- Autopilot đợt 7 (`docs/autopilot/PLAN.md` T-601…T-610, D-042): tính năng spec Approved còn thiếu (org/property/member/session, tồn: availability/resize/search/calendar/overdue, PWA), 409 idempotency đồng thời (D-043), ảnh phí thanh lý, index FK nhóm A. Đợt 3–6 đã merge vào `main` (PR #10, #12, #13, #16–#21).
- Blueprint (`xt.py blueprint-status --strict`): MUST đạt 264 · miễn 55 · mở 177 — 172 chờ người (`loop defer`, xem `docs/autopilot/BLUEPRINT-GAPS.md`), còn lại trong đợt 7.

## Tiếp theo
1. Theo `loop status`: T-601…T-610, mỗi nhóm một PR, review độc lập, merge khi CI xanh.
2. Chờ người (không chặn vòng): `.env.example` thêm `WORKER_DATABASE_URL` (BASE-CFG-002); import ruleset `.github/rulesets/main.json`; DPIA + pháp lý (NĐ 13/2023, Luật BVDLCN 2025, NĐ 356/2025, TT 50/17/2024); VPS tại VN + kho sao lưu khác máy + Prometheus/Alertmanager; SMTP relay (D-010 MIT-0); ClamAV trên VPS; duyệt job CI Lighthouse/k6; quyết 7 đề xuất "Khi chạy thật" (DECISIONS.md); xác nhận miễn trừ blueprint; phản hồi khung FB-009…072.

## Quyết định
- 2026-10-15 Repo sản phẩm + khung X-Templates ở `.xtemplates/`; tự host toàn bộ (ADR-0002); blueprint web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm).
- 2026-10-15 Đợt 1 (PR #4) và đợt 2 (PR #5): chi tiết ở git log, `docs/autopilot/archive/`. Quy ước đã chốt: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; hàm SECURITY DEFINER phạm vi hẹp cho worker; pool ≤ 20 + `max_connections=100`; Serwist không cache điều hướng; cookie `__Host-hm_org` chỉ để chọn, mọi request `resolveActor`; E2E Chromium có sẵn (`/opt/pw-browsers`).
- 2026-10-15 Đợt 2: lễ tân đọc ca/thanh toán trong phạm vi, chỉ ghi của mình; kế toán không mở ca, không duyệt; hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ chỉ check-out; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt; làm tròn chỉ trong `money`; import qua hàm module sở hữu, XLSX tự viết.
- 2026-10-16 Đợt 3 tự duyệt (`docs/autopilot/DECISIONS.md`): D-001 xếp chồng trên PR #5 · D-002 câu [chặn] đợt 3 theo đề xuất SPEC, tham số hoá · D-003 quét file qua clamd (ClamAV) + bản giả · D-004 số giấy tờ AES-256-GCM tầng app + blind index · D-005 người thuê đăng nhập OTP email · D-006 liên kết khách token 256 bit + 4 số cuối SĐT · D-007 phụ lục hợp đồng không thời hạn qua `superseded_on` · D-008 giá dịch vụ chỉ owner (theo ma trận) · D-009 duyệt PLAN đợt 3.
- 2026-10-16 Chủ dự án quyết: merge từng lát — PR mỗi lát, phiên chính merge khi CI xanh + review hết 🔴/🟠 + nhánh cập nhật với main (PR #5 merge trước). D-013 trả sớm huỷ đêm chưa ở.
- Bài học: luôn `set -o pipefail` với `loop record`; lọc test DB bằng `pnpm vitest run --project db <mẫu>` (`pnpm test:db -- x` chạy toàn bộ).
- Nợ kỹ thuật chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- 2026-10-17 Chủ dự án cho phép phiên tự merge từng lát khi CI xanh + review độc lập hết 🔴/🟠 + nhánh cập nhật với `main`, kể cả khi `merge-check` trả HUMAN. Một nhánh push duy nhất `claude/gallant-shannon-2uccvp`: dựng lại từ `main` cho mỗi lát.
- 2026-10-17 Đợt 4–7 tự duyệt: D-023…D-044 (worker runtime, staging file ngoài transaction, Argon2id, 422 idempotency, FK RESTRICT, rate limit, hạn giữ, miễn Storybook có điều kiện).
- Bài học đợt 5–6: E2E dùng `page.route` phải `test.use({ serviceWorkers: "block" })`; mốc `delete_after` theo ngày UTC ở mọi chỗ ghi/so; test có giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối trong test (so tương đối).

## Bàn giao phiên
- `main` = `758c756` (đợt 3–6 đã merge). Đợt 7: nhánh tích hợp `wip/wave7` + nhánh task `wip/w7a…` (worktree `../hm-w7*`), lên PR qua `claude/gallant-shannon-2uccvp`.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` rồi `pnpm install --frozen-lockfile`.
- Đang chặn: không. Autopilot: bật (một phiên).
