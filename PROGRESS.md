# PROGRESS.md — Hotel Manager
## Đang làm
- 2026-10-26 đợt 24 (D-134): từ `main` `3e41782` (#137–#139 đã merge), sửa suspended vẫn dùng cookie cũ, MFA/Retry-After 429, race huỷ tổ chức khi worker xoá object và retention người ở kèm. PLAN đợt 23 lưu tại `docs/autopilot/archive/PLAN-dot-23.md`.
- Migration mới 0074 claim purge bền trước xoá object, lỗi kho giữ claim để retry; file đang tải lên hoãn purge, staging mới sau claim bị chặn; down từ chối khi còn claim. 0075 giữ khoá người ở kèm; đọc/tái dùng giấy tờ cũng giữ khoá người. Production purge tiếp tục TẮT (D-125).
- Các test hồi quy đã tái hiện đỏ trên bản cũ; bằng chứng cổng từng task ở `.autopilot/evidence/`. Kiểm cuối và PR: xem Bàn giao phiên.
- Lịch sử đợt cũ: `docs/autopilot/archive/PROGRESS-history.md`. MUST hiện đạt 367, miễn 59, mở 75; không tick thêm khi thiếu hạ tầng/pháp lý/thiết bị.

## Tiếp theo
1. Người review/merge PR đợt 24 (auth/dữ liệu, AGENTS §7). Khi triển khai 0074: không rollback lúc còn `purge_started_at`; hoàn tất purge trước. Chưa bật purge production.
2. Các bước còn lại: `docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md` (75 MUST); pháp lý/văn bản đồng ý/hạn DSAR, VPS/staging, backup/log giữ hạn, secret store, thiết bị thật.
3. `release-please` từng lỗi quyền ghi token từ #93: cần xác minh lại quyền hoặc dùng GITHUB_TOKEN theo README. Không đọc/ghi giá trị bí mật trong phiên này.
4. Theo dõi hạn ngoại lệ Grype 2026-11-01/11-08, giấy phép sharp 2026-12-31/parse-cache-control 2027-04-18. Dependency production: `pnpm audit --prod` ngày 2026-10-26 sạch.
5. Caddy mặc định đã kiểm chống X-Forwarded-For giả cục bộ: `docs/ops/runbooks/auth-proxy.md`; cấu hình production hoặc thêm CDN phải kiểm lại đường đi thực tế.

## Quyết định
- 2026-10-15 Repo + khung `.xtemplates/`; tự host (ADR-0002); web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm). Quy ước: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; pool ≤ 20; cookie `__Host-hm_org` chỉ để chọn; Serwist không cache điều hướng; E2E Chromium sẵn (`/opt/pw-browsers`).
- 2026-10-15…16 Đợt 2–3 (D-001…D-009): ClamAV qua clamd + bản giả · số giấy tờ AES-256-GCM + blind index · người thuê OTP email · liên kết khách token 256 bit · phụ lục hợp đồng `superseded_on` · giá dịch vụ chỉ owner. Hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt.
- 2026-10-16 Chủ dự án: merge từng lát, PR mỗi lát. 2026-10-17 merge L3 (AGENTS §7): nhánh riêng, merge khi CI xanh + review hết 🔴/🟠; PR ngoại lệ cứng (auth/tiền/tồn, `merge-check` HUMAN) do người merge (ADR-0019).
- 2026-10-17 Đợt 4–8 (D-023…D-058): worker runtime, Argon2id, 422 idempotency, FK RESTRICT, rate limit, miễn Storybook; S-025 409, `allocation.held`, EXIF Orientation, migration 0061/0062; D-053 phạm vi · D-054 một theme · D-055 rào test thay lint · D-056 `quality` = clean clone · D-057 `license-policy.json` · D-058 ngân sách email UTC.
- 2026-10-17 Chủ dự án duyệt: "Duyệt tất cả 55 miễn trừ" (PR #38); "Duyệt CI + công cụ" (đợt 9).
- D-060 WF-REVIEW-007: giữ CODEOWNERS, không thêm `.github/*` vào `merge_risk_paths` — chờ chủ dự án.
- D-061 grype only-fixed + SBOM CycloneDX + syft · D-062 link/OpenAPI breaking bằng script Node, breaking bump MAJOR.
- D-063 cấu hình cổng (vitest/playwright/biome/tsconfig/xt.yaml…) vào `merge_risk_paths` + job coverage-ratchet.
- D-064 otelcol-contrib ghim SHA-256; `schema-compat` mỗi PR · D-065 required check gom ở `main.json`, import là việc người.
- D-066 FE-TEST-001 chỉ test Testing Library; giữ `skipLibCheck` có lý do; bỏ husky, một hook `.githooks`.
- D-067 ngoại lệ grype CÓ HẠN (critical ≤ 7 ngày, high ≤ 30 ngày) + VULN-SLA; kiểm hạn ở job, không ở unit test.
- D-084…D-086 hoãn 26 cổng ở pha build; D-091 khôi phục khi harden (`DEFERRED_TO_HARDEN` rỗng); D-092 e2e timeout 40 → 15 để vừa trần 600 phút CI/PR.
- D-068 ngoại lệ giấy phép `parse-cache-control` BSD (hạn 2027-04-18); giữ MỘT lockfile pnpm.
- Nợ chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- Bài học: `set -o pipefail` với `loop record`; test DB `pnpm vitest run --project db <mẫu>`; sau mỗi merge `main` chạy lại `pnpm test` (rào mới đụng nhau); `merge-check` có thể báo xanh khi job chính chưa có check run (FB-096); E2E đăng nhập qua `signInClick`; `page.route` cần `serviceWorkers: "block"`; mốc `delete_after` theo ngày UTC; migration mới đánh số sau bản cuối trên `main`; job có tên chứa dấu cách (ma trận) cần `while read` khi duyệt context.

## Bàn giao phiên
- Checkout gốc `/home/liend/repos/hotel-manager` giữ nguyên nhánh audit và PROGRESS chưa commit của người dùng. Công việc mới ở worktree `/home/liend/repos/hotel-manager-autopilot`, nhánh `chore/autopilot-completion-2026-10-26` từ `3e41782`.
- Lệnh cổng: `.xtemplates/scripts/dev-task.sh gate`; PostgreSQL 17 của máy dev tại `/home/liend/.local/opt/pg17-embedded/node_modules/@embedded-postgres/linux-x64/native/bin` (`PG_BIN`). Không dùng dữ liệu thật.
- Trạng thái cuối cập nhật sau khi cổng tổng thể và review hoàn tất; không khai sẵn production GO. Khung doctor: 0 lỗi, cảnh báo phiên bản khung cũ; chưa nâng khung trong lát sửa lỗi này.
