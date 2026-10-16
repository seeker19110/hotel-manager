# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5→G6 (autopilot đợt 3 đã xong mã, chờ merge từng lát) · Cập nhật: 2026-10-16 · Nhánh: lát 3 `claude/gallant-shannon-2uccvp` (PR #10); lát 4–6 cục bộ `wip/portal` → `wip/slice5` → `wip/slice6`

## Đang làm
- Autopilot đợt 3 (`docs/autopilot/PLAN.md`, T-201…T-226): **đủ 26 task có bằng chứng** (`.autopilot/evidence/`). Lát 1–2 đã merge (PR #9); lát 3 = PR #10 (CI xanh, review 3 vòng hết 🔴/🟠, `merge-check` HUMAN — chờ chủ dự án merge).
- Lát 4 portal (T-216…T-219) `wip/portal`; lát 5 audit/báo cáo/xuất (T-220…T-222) `wip/slice5` (đã sửa review lát 5: công nợ theo sổ phụ gồm điều chỉnh giảm, job xuất không kẹt, ngày ở ZIP); lát 6 (T-223…T-226) `wip/slice6` — chưa push vì mỗi lát một PR, xếp sau PR #10.
- Blueprint (T-226): MUST đạt 135 · miễn 54 · mở 307 (46 cần người đã `loop defer`, 261 thiếu trong repo → `docs/autopilot/BLUEPRINT-GAPS.md`, đề xuất PLAN đợt 4).

## Tiếp theo
1. Sau khi PR #10 merge: đưa lát 4 lên nhánh PR → review lát 4 (đang chạy lại) → PR; rồi lát 5, lát 6 tương tự (mỗi lát merge main, CI, review, merge-check).
2. GO-NO-GO (`GO-NO-GO.md`): NO-GO phát hành — còn MUST mở và các đề xuất "Khi chạy thật" chưa được chủ dự án quyết.
3. Chờ người (không chặn vòng): SMTP thật (D-010 MIT-0), import ruleset `.github/rulesets/main.json`, VPS VN + kho sao lưu khác máy, ClamAV, DPIA + pháp lý đối chiếu bản gốc, giấy phép mã nguồn, kênh báo lỗ hổng (SECURITY.md), xác nhận miễn trừ blueprint (32 đợt 2 + 18 đợt 3), FB-009…021 về khung.

## Quyết định
- 2026-10-15 Repo sản phẩm + khung X-Templates ở `.xtemplates/`; tự host toàn bộ (ADR-0002); blueprint web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm).
- 2026-10-15 Đợt 1 (PR #4) và đợt 2 (PR #5): chi tiết ở git log, `docs/autopilot/archive/`. Quy ước đã chốt: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; hàm SECURITY DEFINER phạm vi hẹp cho worker; pool ≤ 20 + `max_connections=100`; Serwist không cache điều hướng; cookie `__Host-hm_org` chỉ để chọn, mọi request `resolveActor`; E2E Chromium có sẵn (`/opt/pw-browsers`).
- 2026-10-15 Đợt 2: lễ tân đọc ca/thanh toán trong phạm vi, chỉ ghi của mình; kế toán không mở ca, không duyệt; hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ chỉ check-out; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt; làm tròn chỉ trong `money`; import qua hàm module sở hữu, XLSX tự viết.
- 2026-10-16 Đợt 3 tự duyệt (`docs/autopilot/DECISIONS.md`): D-001 xếp chồng trên PR #5 · D-002 câu [chặn] đợt 3 theo đề xuất SPEC, tham số hoá · D-003 quét file qua clamd (ClamAV) + bản giả · D-004 số giấy tờ AES-256-GCM tầng app + blind index · D-005 người thuê đăng nhập OTP email · D-006 liên kết khách token 256 bit + 4 số cuối SĐT · D-007 phụ lục hợp đồng không thời hạn qua `superseded_on` · D-008 giá dịch vụ chỉ owner (theo ma trận) · D-009 duyệt PLAN đợt 3.
- 2026-10-16 Chủ dự án quyết: merge từng lát — PR mỗi lát, phiên chính merge khi CI xanh + review hết 🔴/🟠 + nhánh cập nhật với main (PR #5 merge trước). D-013 trả sớm huỷ đêm chưa ở.
- Bài học: luôn `set -o pipefail` với `loop record`; lọc test DB bằng `pnpm vitest run --project db <mẫu>` (`pnpm test:db -- x` chạy toàn bộ).
- Nợ kỹ thuật chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — phải đối chiếu văn bản gốc trước khi dùng dữ liệu thật.

## Bàn giao phiên
- Nhánh chính: `67f1990`+PR #9 (đợt 2 PR #5, đợt 3 lát 1–2 PR #9 đã merge). Đợt 3 tiếp: nhánh này (đã merge main).
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` rồi `pnpm install --frozen-lockfile`.
- Đang chặn: không. Autopilot: bật (một phiên).
- Việc dở chưa commit: không (worktree: `../hm-pr10` lát 3, `../hm-s5` lát 5, `../hm-slice5` lát 6, `../hm-ui` UI T-223 đã gộp vào lát 6).
