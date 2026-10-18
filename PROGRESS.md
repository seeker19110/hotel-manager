# PROGRESS.md — Hotel Manager
## Đang làm
- Đợt 10 xong (T-901…T-909): PR #59 SBOM vào Release · #64 gitleaks ở pre-commit · #65 luật Semgrep + quét PII log E2E · #62 xoay mật khẩu role CSDL · #63 ngân sách image/thời gian CI · #66 i18n (`messages/vi.json`, `t()`, kiểm tệp dịch, ratchet). **Chờ người merge (CI xanh, review sạch):** #67 T-906/T-907 k6 nightly chặn production + Lighthouse 6 URL (`risk:auth`, `risk:gate`) · #68 T-904b login luân phiên chạy bằng role gốc, giữ chủ sở hữu bảng pg-boss (`risk:data`). `blueprint-status --strict` trên `main`: MUST đạt 340 · miễn 55 · **mở 106** (sau #67: 341 · 105) (BLUEPRINT-GAPS 'Kết quả đợt 10': tick 4, 6 mục làm xong phần repo nhưng cần staging/Release thật/ruleset). GO-NO-GO: NO-GO (7 BLOCKER, cần người). Autopilot `done-pending-human`.
- Trước đó: đợt 9 (T-801…T-808), `loop verify` XANH trên 79afb9d.

## Tiếp theo
1. Người (theo nhóm, từng bước ở BLUEPRINT-GAPS): ① import `.github/rulesets/main.json` (28 check) + `tags.json`, tắt merge commit, bật auto-merge ② nhãn `risk:*`/`major`, Dependabot, quyết D-060 ③ secret `RELEASE_PLEASE_TOKEN` + Actions tạo PR, merge Release PR ④ VPS/domain/staging/secret store ⑤ sao lưu khác máy + Prometheus/Alertmanager + RPO/RTO ⑥ pháp lý DPIA/DPO/DPA ⑦ LICENSE + SECURITY.md + PVR ⑧ kiểm tay thiết bị/a11y ⑨ quyết IND-SAAS-009, CMP-RIGHTS-001, PM-METRIC-003 ⑩ duyệt `WORKER_DATABASE_URL`/`MIGRATION_DATABASE_URL` ⑪ SMTP, ClamAV ⑫ quyết 18 đề xuất "Khi chạy thật" (GO-NO-GO 4b).
2. **Hạn gấp:** `.grype.yaml` 4 luật hết hạn 2026-10-25 (21 luật 2026-11-01) — quá hạn thì `image-scan` đỏ mọi PR; duyệt/gia hạn `@img/sharp-libvips-linux-x64` LGPL (2026-12-31), `parse-cache-control` BSD (2027-04-18).
3. Người: merge #67 và #68; sau merge #67 chạy `perf-nightly` bằng `workflow_dispatch` một lần (bằng chứng QA-PERF-002 khi có staging); 6 mục đợt 10 chờ hạ tầng: CMP-LIC-003 (Release thật), CMP-PRIV-008/QA-PERF-002 (staging), XC-GREEN-002 (ngân sách chi phí VPS), PRF-WEB-005 (required check + CWV thực địa), XC-I18N-001 (chuyển dần 2329 chuỗi).
4. Sau khi người xử lý: `python3 .xtemplates/scripts/xt.py loop resume --reason "..."`.

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
- D-068 ngoại lệ giấy phép `parse-cache-control` BSD (hạn 2027-04-18); giữ MỘT lockfile pnpm.
- Nợ chấp nhận: pháp lý trong `docs/research/` chỉ có nguồn thứ cấp — đối chiếu văn bản gốc trước khi dùng dữ liệu thật.
- Bài học: `set -o pipefail` với `loop record`; test DB `pnpm vitest run --project db <mẫu>`; sau mỗi merge `main` chạy lại `pnpm test` (rào mới đụng nhau); `merge-check` có thể báo xanh khi job chính chưa có check run (FB-096); E2E đăng nhập qua `signInClick`; `page.route` cần `serviceWorkers: "block"`; mốc `delete_after` theo ngày UTC; migration mới đánh số sau bản cuối trên `main`; job có tên chứa dấu cách (ma trận) cần `while read` khi duyệt context.

- Bài học đợt 5–8: Better Auth `/sign-in/email` 20 lần/phút theo IP; `<dialog>` phát `close` sau một task (`onClose` chỉ xoá trạng thái khi hộp thật sự đóng); chạy lại job CI dùng payload sự kiện cũ (cần push mới); test giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối (so tương đối); hai lát song song có thể đụng nhau qua rào mới.

## Bàn giao phiên
- `main` = `b2d992d` (đợt 3–9 đã merge); T-808 ở nhánh `wip/w9h`, chưa push. Worktree `../hm-w9*` không còn việc dở.
- Lệnh kiểm nhanh: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `E2E_PORT=<cổng riêng> pnpm --filter @hm/web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh` rồi `pnpm install --frozen-lockfile`.
- Đang chặn: chờ người (mục *Tiếp theo* 1–2). Autopilot: `blocked` (một phiên).
