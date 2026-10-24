# PROGRESS.md — Hotel Manager
## Đang làm
- 2026-10-22 đợt 17 (D-093, D-094): 4 luật grype critical gia hạn tới 2026-10-29 (chưa có image vá: Caddy v2.11.7 vẫn Go 1.26.8, SeaweedFS 4.48; GO-2026-6604 chỉ Windows); `/co-so`, `/thanh-vien` sang `t()` (−77 chuỗi, còn 2280). D-095: 8 MUST bỏ tick chờ import ruleset; 2026-10-23 chủ dự án import `main.json` ⇒ tick lại, MUST mở 90 (WF-REL-003 đạt sau import ruleset tag).
- 2026-10-23 đợt 20 (D-100): 14 tệp sang `t()`/`tm()`, baseline 1899 → 1717.
- 2026-10-24 đợt 21 (D-101, D-102): `MessagesProvider` (client context, khoá `common.`) cho hạ tầng client; phần đuôi ngoài `merge_risk_paths` sang `t()`/`tm()`, baseline 1717 → 1552; bundle 278,11 kB. Còn ngoài risk: chỉ `lib/format.ts`.
- Đợt mới: `loop resume` nếu còn `.autopilot/state.json`; container mới không có state ⇒ PLAN mới + `loop init` (FB-149).
- Phát hành v0.2.0 (#88). D-091 (2026-10-22): pha harden, 26 cổng hoãn đã khôi phục — `main.json` 28 context, strict bật (đã import 2026-10-23). `release-please` đỏ — xem *Tiếp theo* 3.

## Tiếp theo
1. Người (theo nhóm, từng bước ở BLUEPRINT-GAPS): ② nhãn `major`, Dependabot, quyết D-060 ③ BASE-REPO-006 cần tag annotated (release-please tạo tag thường) — quyết bước tạo tag; tag mồ côi `v2.0.0` đã xoá 2026-10-23 ④ VPS/domain/staging/secret store ⑤ sao lưu khác máy + Prometheus/Alertmanager + RPO/RTO ⑥ pháp lý DPIA/DPO/DPA ⑦ LICENSE + SECURITY.md + PVR ⑧ kiểm tay thiết bị/a11y ⑨ quyết IND-SAAS-009, CMP-RIGHTS-001, PM-METRIC-003 ⑩ duyệt `WORKER_DATABASE_URL`/`MIGRATION_DATABASE_URL` ⑪ SMTP, ClamAV ⑫ quyết 18 đề xuất "Khi chạy thật" (GO-NO-GO 4b).
2. **Hạn gấp:** `.grype.yaml` 4 luật critical hết hạn **2026-10-29** (21 luật 2026-11-01); rà 2026-10-23: SeaweedFS 4.49 đã gắn tag (x/net 0.61) chờ image, Caddy chưa có bản mới — rà lại: có image Caddy/SeaweedFS dựng bằng Go ≥ 1.26.9 → nâng digest, gỡ luật; không → gia hạn ≤ 7 ngày hoặc tự dựng image (D-094, bắt buộc trước production). Duyệt/gia hạn `@img/sharp-libvips-linux-x64` LGPL (2026-12-31), `parse-cache-control` BSD (2027-04-18).
3. **Người — `release-please` đỏ trên `main` từ #93** (`Error adding to tree`, chạy lại 1 lần vẫn đỏ): token đọc được nhưng không ghi được ⇒ nhiều khả năng secret `RELEASE_PLEASE_TOKEN` thiếu **Contents: Read and write** (README, mục Phát hành). Sửa quyền hoặc xoá secret, rồi chạy lại workflow `Release`; xoá nhánh mồ côi `release-please--branches--main--components--hotel-manager` nếu không cần.
4. Người: chạy `perf-nightly` (`workflow_dispatch`) một lần khi có staging (QA-PERF-002); chờ hạ tầng: CMP-PRIV-008, XC-GREEN-002, PRF-WEB-005; XC-I18N-001 còn ~1552 chuỗi: `apps/web/lib/format.ts` (cần tách nhãn khỏi client), màn `merge_risk_paths` (người merge), `packages/app` (quyết cách trả thông điệp lỗi — D-097).
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

- Bài học đợt 5–8: Better Auth `/sign-in/email` 20 lần/phút theo IP; `<dialog>` phát `close` sau một task (`onClose` chỉ xoá trạng thái khi hộp thật sự đóng); chạy lại job CI dùng payload sự kiện cũ (cần push mới); test giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối (so tương đối); hai lát song song có thể đụng nhau qua rào mới.

## Bàn giao phiên
- 2026-10-22 `main` = `e41d6f1` (sau #129); nhánh `claude/admiring-pasteur-qi1dn0` (đợt 17–18, tick lại D-095). Thiếu ruleset tag, nhãn `major`, LICENSE.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh && bash scripts/dev-env-setup.sh --only gitleaks` rồi `pnpm install --frozen-lockfile`; semgrep: `python3 -m venv <thư mục tạm>/sg && <…>/sg/bin/pip install --require-hashes -r security/semgrep/requirements.txt` rồi đưa `<…>/sg/bin` vào PATH (thiếu gitleaks/semgrep ⇒ `loop verify` đỏ exit 127 ở WF-GIT-010/T-1101). Không chạy E2E song song với `loop verify` (T-402 đỏ do tranh CPU).
- Đang chặn: chờ người (mục *Tiếp theo* 1–3; xác nhận việc viết lại lịch sử `main` có chủ ý — ruleset nay chặn force-push). Autopilot: `done-pending-human` (một phiên).
