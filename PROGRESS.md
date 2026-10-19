# PROGRESS.md — Hotel Manager
## Đang làm
- Đợt 12 xong (D-075/D-076, 2026-10-19), đã merge: #76 Semgrep chặn `JSON.stringify(<người>)`/`log.child({ user })` · #77 server E2E log đủ dòng cuối · #78 ratchet i18n bắt `{n} phòng` + 26 đoạn sang `t()` (người merge) · #79 test rate-limit vắt ranh giới phút · #82 fingerprint gitleaks sau khi viết lại `main`. Chủ dự án nâng khung 3.5.1 (#84), 3.6.0 (#85).
- #86 T-1107 steward chỉ `--apply` khi nhánh đích có required check (FB-134). Chủ dự án import ruleset `main` (29 check); #88 phát hành **v0.2.0** (Release + SBOM + SHA256SUMS). T-1108 tick 10 MUST bằng `scripts/check-github-live.mjs` (D-077).
- Trước đó: đợt 10–11 xong (#59…#75). `blueprint-status --strict`: MUST đạt 351 · miễn/không áp dụng 59 · **mở 91** — đều cần người (BLUEPRINT-GAPS 'Kết quả đợt 9 (a)'). GO-NO-GO: NO-GO (7 BLOCKER). Autopilot `done-pending-human`.

## Tiếp theo
1. Người (theo nhóm, từng bước ở BLUEPRINT-GAPS): ① import `.github/rulesets/tags.json` (cấm xoá/dời tag `v*`, WF-REL-003) ② nhãn `major`, Dependabot, quyết D-060 ③ BASE-REPO-006 cần tag annotated (release-please tạo tag thường) — quyết bước tạo tag; xoá tag mồ côi `v2.0.0` ④ VPS/domain/staging/secret store ⑤ sao lưu khác máy + Prometheus/Alertmanager + RPO/RTO ⑥ pháp lý DPIA/DPO/DPA ⑦ LICENSE + SECURITY.md + PVR ⑧ kiểm tay thiết bị/a11y ⑨ quyết IND-SAAS-009, CMP-RIGHTS-001, PM-METRIC-003 ⑩ duyệt `WORKER_DATABASE_URL`/`MIGRATION_DATABASE_URL` ⑪ SMTP, ClamAV ⑫ quyết 18 đề xuất "Khi chạy thật" (GO-NO-GO 4b).
2. **Hạn gấp:** `.grype.yaml` 4 luật hết hạn 2026-10-25 (21 luật 2026-11-01) — quá hạn thì `image-scan` đỏ mọi PR. Rà 2026-10-19: digest đang ghim caddy 2.11.7-alpine và seaweedfs 4.48 vẫn là bản mới nhất (chưa có Go 1.26.9) ⇒ chưa gỡ được; đã hẹn tự kiểm lại 2026-10-24 (gỡ luật nếu có image vá, không thì gia hạn ≤ 7 ngày). Duyệt/gia hạn `@img/sharp-libvips-linux-x64` LGPL (2026-12-31), `parse-cache-control` BSD (2027-04-18).
3. Người xác nhận: lịch sử `main` trên GitHub đã bị viết lại (bản clone mới thấy `forced update`, `origin/main` còn 54 commit, các SHA cũ như 54005de không còn) — nếu không chủ ý thì kiểm tra; ruleset cấm force-push (nhóm ①) chặn việc này về sau.
4. Người: sau merge #67 chạy `perf-nightly` bằng `workflow_dispatch` một lần (bằng chứng QA-PERF-002 khi có staging); 5 mục đợt 10 chờ hạ tầng: CMP-PRIV-008/QA-PERF-002 (staging), XC-GREEN-002, PRF-WEB-005, XC-I18N-001 (chuyển dần 2321 chuỗi).
5. Sau khi người xử lý: `python3 .xtemplates/scripts/xt.py loop resume --reason "..."`.

## Quyết định
- 2026-10-15 Repo + khung `.xtemplates/`; tự host (ADR-0002); web-app + saas-multitenant + fintech, quy mô M; stack ADR-0001 (Node 24 · Next 16.4 · PG 17 · Kysely · pg-boss · Better Auth · Serwist · Vitest/Playwright · Biome · pnpm). Quy ước: import đuôi `.ts`; commit qua `scripts/commit-gated.sh`; quyền/tiền kiểm ở CSDL (RLS, EXCLUDE, trigger) + app; pool ≤ 20; cookie `__Host-hm_org` chỉ để chọn; Serwist không cache điều hướng; E2E Chromium sẵn (`/opt/pw-browsers`).
- 2026-10-15…16 Đợt 2–3 (D-001…D-009): ClamAV qua clamd + bản giả · số giấy tờ AES-256-GCM + blind index · người thuê OTP email · liên kết khách token 256 bit · phụ lục hợp đồng `superseded_on` · giá dịch vụ chỉ owner. Hạn mức mặc định quản lý 5.000.000 đ, lễ tân 2.000.000 đ; `bank_auto` chỉ worker ghi; khoá kỳ theo `business_date`; điều chỉnh chỉ giảm qua duyệt.
- 2026-10-16 Chủ dự án: merge từng lát, PR mỗi lát. 2026-10-17 merge L3 (AGENTS §7): nhánh riêng, merge khi CI xanh + review hết 🔴/🟠; PR ngoại lệ cứng (auth/tiền/tồn, `merge-check` HUMAN) do người merge (ADR-0019).
- 2026-10-17 Đợt 4–8 (D-023…D-058): worker runtime, Argon2id, 422 idempotency, FK RESTRICT, rate limit, miễn Storybook; S-025 409, `allocation.held`, EXIF Orientation, migration 0061/0062; D-053 phạm vi · D-054 một theme · D-055 rào test thay lint · D-056 `quality` = clean clone · D-057 `license-policy.json` · D-058 ngân sách email UTC.
- 2026-10-17 Chủ dự án duyệt: "Duyệt tất cả 55 miễn trừ" (PR #38); "Duyệt CI + công cụ" (đợt 9).
- 2026-10-18 D-059 phạm vi đợt 9 (67 mục MUST, 7 lát; bỏ 4 mục biến môi trường và 19 mục pháp lý).
- D-060 WF-REVIEW-007: giữ CODEOWNERS, không thêm `.github/*` vào `merge_risk_paths` — chờ chủ dự án.
- D-061 chuỗi cung ứng: grype only-fixed + SBOM CycloneDX tự sinh + syft; new-deps chỉ phụ thuộc trực tiếp.
- D-062 liên kết ngoài/OpenAPI breaking: script Node tự viết (không lychee/oasdiff); breaking phải bump MAJOR.
- D-063 cấu hình cổng (vitest/playwright/biome/tsconfig/xt.yaml…) vào `merge_risk_paths` + job coverage-ratchet.
- D-064 otelcol-contrib ghim SHA-256 tự đo; `schema-compat` chạy mỗi PR.
- D-065 required check đợt 9 gom một lần ở T-808 (`main.json` 28 context); import là việc người.
- D-066 FE-TEST-001 chỉ test Testing Library; giữ `skipLibCheck` có lý do; bỏ husky, một hook `.githooks`.
- D-067 ngoại lệ grype CÓ HẠN (critical ≤ 7 ngày, high ≤ 30 ngày) + VULN-SLA; kiểm hạn ở job, không ở unit test.
- D-075 đợt 12 chỉ gia cố rào đã ghi treo; D-076 bộ đếm i18n chặt hơn ⇒ chuyển chuỗi chứ không nới baseline.
- D-068 ngoại lệ giấy phép `parse-cache-control` BSD (hạn 2027-04-18); giữ MỘT lockfile pnpm.
- Nợ chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- Bài học: `set -o pipefail` với `loop record`; test DB `pnpm vitest run --project db <mẫu>`; sau mỗi merge `main` chạy lại `pnpm test` (rào mới đụng nhau); `merge-check` có thể báo xanh khi job chính chưa có check run (FB-096); E2E đăng nhập qua `signInClick`; `page.route` cần `serviceWorkers: "block"`; mốc `delete_after` theo ngày UTC; migration mới đánh số sau bản cuối trên `main`; job có tên chứa dấu cách (ma trận) cần `while read` khi duyệt context.

- Bài học đợt 5–8: Better Auth `/sign-in/email` 20 lần/phút theo IP; `<dialog>` phát `close` sau một task (`onClose` chỉ xoá trạng thái khi hộp thật sự đóng); chạy lại job CI dùng payload sự kiện cũ (cần push mới); test giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối (so tương đối); hai lát song song có thể đụng nhau qua rào mới.

## Bàn giao phiên
- `main` = `0e54ae6` (v0.2.0). PR mở: #90 (T-1108), #89 Release PR 0.3.0 (release-please, người quyết phát hành), #91 khung 3.7.0 (phiên khác).
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh && bash scripts/dev-env-setup.sh --only gitleaks` rồi `pnpm install --frozen-lockfile`; semgrep: `python3 -m venv <thư mục tạm>/sg && <…>/sg/bin/pip install --require-hashes -r security/semgrep/requirements.txt` rồi đưa `<…>/sg/bin` vào PATH (thiếu gitleaks/semgrep ⇒ `loop verify` đỏ exit 127 ở WF-GIT-010/T-1101). Không chạy E2E song song với `loop verify` (T-402 đỏ do tranh CPU).
- Đang chặn: chờ người (mục *Tiếp theo* 1–2). Autopilot: `done-pending-human` (một phiên).
