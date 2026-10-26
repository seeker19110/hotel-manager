# PROGRESS.md — Hotel Manager
## Đang làm
- Lịch sử đợt cũ: `docs/autopilot/archive/PROGRESS-history.md`.
- 2026-10-26 đợt 23 lát E (D-128…D-132, nhánh `claude/exciting-gauss-5yuqhd`, người merge): T-2313 nhật ký `/nhat-ky` (lọc, xuất) + truy cập hỗ trợ CHỈ ĐỌC có lý do/TTL/xác thực lại (0072, không impersonation); T-2314 hạn mức gói `pilot` + fair-share `outbox_claim` (0073); review chéo họ: 🟠/🟡 đã sửa. Lát C (#137) và D (#138) đã merge. T-2315: tick 11 MUST (MUST đạt 368 · mở 74), 7 mục còn lại ghi ở `BLUEPRINT-GAPS.md` (đợt 23 lát F).
- Sổ kiểm toán: AUD-SEC-005 🟠 (X-Forwarded-For không có trustedProxies) còn mở — người kiểm Caddy.
- Cần xác minh khi triển khai: role owner chạy migration phải bỏ qua RLS (superuser/BYPASSRLS), nếu không mọi hàm dọn SECURITY DEFINER (0056/0066/0067) lỗi trên bảng FORCE RLS — gắn với ⑩ `MIGRATION_DATABASE_URL`.
- Đợt mới: `loop resume` nếu còn `.autopilot/state.json`; container mới không có state ⇒ PLAN mới + `loop init` (FB-149).
- Phát hành v0.2.0 (#88). D-091 (2026-10-22): pha harden, 26 cổng hoãn đã khôi phục — `main.json` 28 context, strict bật (đã import 2026-10-23). `release-please` đỏ — xem *Tiếp theo* 3.

## Tiếp theo
0. **Người: rà + merge PR lát E** (ngoại lệ cứng auth/dữ liệu). Sau merge: duyệt mặc định đợt 23 (HUONG-DAN B2: văn bản đồng ý, hạn DSAR VN, gói, bật purge production).
1. Người — **hướng dẫn từng bước: `docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md`** (74 MUST mở, 5 bước): ② nhãn `major`, Dependabot, quyết D-060 ③ BASE-REPO-006 cần tag annotated (release-please tạo tag thường) — quyết bước tạo tag; tag mồ côi `v2.0.0` đã xoá 2026-10-23 ④ VPS/domain/staging/secret store ⑤ sao lưu khác máy + Prometheus/Alertmanager + RPO/RTO ⑥ pháp lý DPIA/DPO/DPA ⑦ LICENSE + SECURITY.md + PVR ⑧ kiểm tay thiết bị/a11y ⑨ duyệt mặc định B2 (đồng ý, DSAR, gói, hỗ trợ) ⑩ duyệt `WORKER_DATABASE_URL`/`MIGRATION_DATABASE_URL` ⑪ SMTP, ClamAV ⑫ quyết 18 đề xuất "Khi chạy thật" (GO-NO-GO 4b).
2. **Grype:** caddy/seaweedfs tự dựng (D-110, ADR-0006) — gỡ 24 luật; còn 5 luật High (npm trong image node, zod 3 của lighthouse) hạn 2026-11-01/11-08. Duyệt/gia hạn `@img/sharp-libvips-linux-x64` LGPL (2026-12-31), `parse-cache-control` BSD (2027-04-18).
3. **Người — `release-please` đỏ trên `main` từ #93** (`Error adding to tree`, chạy lại 1 lần vẫn đỏ): token đọc được nhưng không ghi được ⇒ nhiều khả năng secret `RELEASE_PLEASE_TOKEN` thiếu **Contents: Read and write** (README, mục Phát hành). Sửa quyền hoặc xoá secret, rồi chạy lại workflow `Release`; xoá nhánh mồ côi `release-please--branches--main--components--hotel-manager` nếu không cần.
4. Người: chạy `perf-nightly` (`workflow_dispatch`) một lần khi có staging (QA-PERF-002); chờ hạ tầng: CMP-PRIV-008, XC-GREEN-002, PRF-WEB-005; XC-I18N-001 đạt (#131 đã merge).
5. Sau khi người xử lý: `python3 .xtemplates/scripts/xt.py loop resume --reason "..."`.

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
- 2026-10-22 `main` = `eaab1f8` (sau #130); PR #131 đợt 22; nhánh `claude/admiring-pasteur-qi1dn0` (đợt 17–18, tick lại D-095). Thiếu ruleset tag, nhãn `major`, LICENSE.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh && bash scripts/dev-env-setup.sh --only gitleaks` rồi `pnpm install --frozen-lockfile`; semgrep: `python3 -m venv <thư mục tạm>/sg && <…>/sg/bin/pip install --require-hashes -r security/semgrep/requirements.txt` rồi đưa `<…>/sg/bin` vào PATH (thiếu gitleaks/semgrep ⇒ `loop verify` đỏ exit 127 ở WF-GIT-010/T-1101). Không chạy E2E song song với `loop verify` (T-402 đỏ do tranh CPU).
- Đang chặn: chờ người (mục *Tiếp theo* 1–3; xác nhận việc viết lại lịch sử `main` có chủ ý — ruleset nay chặn force-push). Autopilot: `done-pending-human` (một phiên).
