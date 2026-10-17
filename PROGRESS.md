# PROGRESS.md — Hotel Manager
## Đang làm
- Đợt 8 xong và đã merge vào `main` (PR #32–#36): T-701…T-710 có bằng chứng; 10 mục MUST làm trọn trong repo (D-053…D-058). Autopilot `blocked` — phần còn lại cần người.
- Blueprint (`xt.py blueprint-status --strict`): MUST đạt 282 · miễn 55 · mở 159 — 90 làm được một phần nhưng cần duyệt đổi CI/file cổng/phụ thuộc/biến môi trường/pháp lý, 67 cần người/hạ tầng/GitHub, IND-SAAS-009 + CMP-RIGHTS-001 chờ quyết (`docs/autopilot/BLUEPRINT-GAPS.md` mục 'Kết quả đợt 8'). 55 miễn trừ MUST thiếu `Duyệt:` (LOOP-STOP-024). GO-NO-GO: NO-GO.

## Tiếp theo
1. Chủ dự án: ghi `Duyệt:` hoặc bỏ 55 miễn trừ MUST; duyệt đổi CI/file cổng (53 mục) và phụ thuộc công cụ (14 mục) để mở đợt 9; quyết F-015 (IND-SAAS-009), danh mục mục đích đồng ý (CMP-RIGHTS-001); import ruleset `.github/rulesets/main.json`.
2. Chờ người (không chặn vòng): `.env.example` thêm `WORKER_DATABASE_URL`; DPIA + pháp lý; VPS tại VN + sao lưu khác máy + Prometheus/Alertmanager; SMTP relay (D-010); ClamAV; job CI Lighthouse/k6; kiểm tay SPEC-pwa S-002/S-003/S-016; quyết 10 đề xuất "Khi chạy thật" (DECISIONS.md, gồm D-052, D-058 trần email); phản hồi khung FB-009…096.
3. Sau khi người xử lý: `python3 .xtemplates/scripts/xt.py loop resume --reason "..."`.

## Quyết định
- 2026-10-15 Repo sản phẩm + khung X-Templates ở `.xtemplates/`; tự host toàn bộ (ADR-0002); blueprint web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm).
- 2026-10-15 Đợt 1 (PR #4) và đợt 2 (PR #5): chi tiết ở git log, `docs/autopilot/archive/`. Quy ước đã chốt: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; hàm SECURITY DEFINER phạm vi hẹp cho worker; pool ≤ 20 + `max_connections=100`; Serwist không cache điều hướng; cookie `__Host-hm_org` chỉ để chọn, mọi request `resolveActor`; E2E Chromium có sẵn (`/opt/pw-browsers`).
- 2026-10-15 Đợt 2: lễ tân đọc ca/thanh toán trong phạm vi, chỉ ghi của mình; kế toán không mở ca, không duyệt; hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ chỉ check-out; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt; làm tròn chỉ trong `money`; import qua hàm module sở hữu, XLSX tự viết.
- 2026-10-16 Đợt 3 tự duyệt (`docs/autopilot/DECISIONS.md`): D-001 xếp chồng trên PR #5 · D-002 câu [chặn] đợt 3 theo đề xuất SPEC, tham số hoá · D-003 quét file qua clamd (ClamAV) + bản giả · D-004 số giấy tờ AES-256-GCM tầng app + blind index · D-005 người thuê đăng nhập OTP email · D-006 liên kết khách token 256 bit + 4 số cuối SĐT · D-007 phụ lục hợp đồng không thời hạn qua `superseded_on` · D-008 giá dịch vụ chỉ owner (theo ma trận) · D-009 duyệt PLAN đợt 3.
- 2026-10-16 Chủ dự án quyết: merge từng lát — PR mỗi lát, phiên chính merge khi CI xanh + review hết 🔴/🟠 + nhánh cập nhật với main (PR #5 merge trước). D-013 trả sớm huỷ đêm chưa ở.
- Bài học: luôn `set -o pipefail` với `loop record`; lọc test DB bằng `pnpm vitest run --project db <mẫu>` (`pnpm test:db -- x` chạy toàn bộ).
- Nợ kỹ thuật chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- 2026-10-17 Merge L3 (AGENTS §7): mỗi lát một PR trên nhánh riêng `claude/gallant-shannon-2uccvp-<task>`; phiên tự merge làn nhanh/chuẩn khi CI xanh; PR ngoại lệ cứng (auth/tiền/tồn — `merge-check` HUMAN) do người merge (guard ADR-0019).
- 2026-10-17 Đợt 4–8 tự duyệt: D-023…D-058 (đợt 8: D-053 phạm vi 10 mục · D-054 một theme · D-055 rào test thay lint · D-056 job quality = clean clone · D-057 license-policy.json · D-058 ngân sách email UTC trần cứng); trước đó (thêm D-045…D-052: S-025 409, allocation.held, resize nội bộ, 404 ngoài phạm vi, EXIF Orientation, refresh khi có mạng, đổi số migration 0061/0062, hạn mức org.create) (worker runtime, staging file ngoài transaction, Argon2id, 422 idempotency, FK RESTRICT, rate limit, hạn giữ, miễn Storybook có điều kiện).
- Bài học đợt 8: hai lát song song có thể đụng nhau qua rào mới (rào test-assertions bắt test schema-drift chỉ có snapshot; rào schema-drift đòi sinh lại ảnh chụp khi có migration) — sau mỗi lần merge `main` vào lát chạy lại toàn bộ `pnpm test`; `merge-check` có thể báo 'CI xanh' khi job chính chưa tạo check run (FB-096) — kiểm đủ check trước merge; repo đã bật auto-merge.
- Bài học đợt 7: Better Auth `/sign-in/email` 20 lần/phút theo IP (cửa sổ đặt lại sau 60 s yên) — E2E đăng nhập qua `e2e/sign-in.ts` `signInClick` (có rào); `<dialog>` phát `close` sau một task — `onClose` chỉ xoá trạng thái khi hộp thật sự đóng; migration mới luôn đánh số sau bản cuối trên `main` (Kysely từ chối chèn trước); chạy lại job CI dùng payload sự kiện cũ (tiêu đề PR cũ) — cần push mới.
- Bài học đợt 5–6: E2E dùng `page.route` phải `test.use({ serviceWorkers: "block" })`; mốc `delete_after` theo ngày UTC ở mọi chỗ ghi/so; test có giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối trong test (so tương đối).

## Bàn giao phiên
- `main` = `d9dbbbe` (đợt 3–8 đã merge). Worktree đợt 7–8 (`../hm-w7*`, `../hm-w8*`) không còn việc dở.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` rồi `pnpm install --frozen-lockfile`.
- Đang chặn: chờ người (mục *Tiếp theo* 1–2). Autopilot: `blocked` (một phiên).
