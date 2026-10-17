# GO/NO-GO — Hotel Manager · ứng viên 0.1.0 (pilot) · 2026-10-17 (rà đợt 7, T-609)

> Commit: `main` `8a6996e` (sau PR #22 đợt 7 phần 1: T-601/602/603/610) + PR đang mở: #24 (T-607/T-608, CI 6/6 xanh), #26 (T-604), T-605 và T-606 (nhánh riêng, cổng xanh cục bộ, chờ review) · Blueprint: `xt.py blueprint-status BLUEPRINT.md --strict` trên `main` → MUST đạt 266 · miễn 55 · **mở 175** (174 `loop defer` chờ người; PR #24 tick thêm 7 mục khi merge) · 55 miễn trừ MUST thiếu `Duyệt:` của chủ dự án (LOOP-STOP-024) · CI: PR #10…#22 đã merge, mỗi PR 6/6 job xanh.
> Người kiểm: phiên autopilot (report-only, không deploy) · Phạm vi: web/PWA + worker + CSDL; không có mobile native.

## 1. Đếm
| Mức | PASS | FAIL | N/A |
|---|---|---|---|
| BLOCKER | 8 | 7 | 0 |
| SHOULD | 2 | 2 | 0 |
| NICE | 0 | 1 | 0 |

(Bản trước đếm BLOCKER 5/9 — lệch so với bảng; đã đếm lại theo bảng danh mục: 15 mục BLOCKER.)

## 2. Danh mục kiểm
| # | Mức | Mục | Kết quả | Bằng chứng |
|---|---|---|---|---|
| 1 | BLOCKER | Build tái lập, không lỗi type/lint, không cờ giấu lỗi | PASS | job `quality` (build · typecheck · lint · test) xanh trên PR #10…#20 (đã merge) và PR #21 `4f15b27`; cổng `dev-task.sh gate` xanh ở mọi commit đợt 6 (hook PreToolUse); không `ignoreBuildErrors`/`continue-on-error` (`xt.py ci-check .github/workflows` ✓ 3 workflow) |
| 2 | BLOCKER | Toàn bộ test xanh (unit/integration/E2E luồng chính) | PASS | CI: 6/6 job xanh (gồm `quality`, `e2e`) trên mọi PR đã merge (#10…#22) và PR #24; cổng `pnpm test` xanh trước mọi commit đợt 7 (hook PreToolUse). Số liệu đợt 6: Chạy lại 2026-10-17 trên `wip/w6h` (`f6ef72a`): `pnpm test` exit 0 — 170 file / **2.346 test** (unit 80 file / 1.450 + `pnpm test:db` 90 file / **896**, Postgres 17 thật); E2E `playwright test` (`E2E_PORT=3258`) exit 0 — **59/59** |
| 3 | BLOCKER | Blueprint: 0 MUST mở; miễn trừ có lý do | FAIL | 175 MUST mở trên `main`, toàn bộ đã `loop defer` chờ người (hạ tầng/pháp lý/CI/ruleset/thiết bị thật — `docs/autopilot/BLUEPRINT-GAPS.md` mục 'Kết quả đợt 7'); 55 miễn trừ MUST chưa có `Duyệt:` của chủ dự án; `check-blueprint-evidence.py` 266 mục `[x]` · 0 lỗi |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | PASS | job `ci:gitleaks` xanh trên PR #10…#20 và PR #21 `4f15b27` (quét toàn lịch sử; gitleaks không cài trong container nên không chạy cục bộ) |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng cao; license trong allowlist | PASS | `pnpm audit --prod` → "No known vulnerabilities found" (chạy lại 2026-10-17); `pnpm licenses:check` → Apache-2.0, BSD-3-Clause, ISC, MIT, MIT OR Apache-2.0, MPL-2.0; job `dep-audit` xanh trên PR #21 |
| 6 | BLOCKER | Kiểm quyền phía server; test vượt quyền xanh | PASS | `packages/app/src/http/authz-matrix.db.test.ts` (api1-bola / api5-bfla sinh từ registry, 24 test, chạy lại 2026-10-17), RLS mọi bảng `organization_id` (`tenancy.db.test.ts`) |
| 7 | BLOCKER | Threat model: mọi mối đe doạ Cao có biện pháp + bằng chứng | PASS | `docs/design/THREAT-MODEL.md` v2: TM-01…TM-24 đều mitigate/accept/transfer kèm test; phần hạ tầng `transfer` cho người |
| 8 | BLOCKER | Migration có đường lùi; rollback đã diễn tập | FAIL | Down/up được test (`tenancy.db.test.ts`), lệnh rollback trong `docs/ops/runbooks/deploy-rollback.md` chạy thử trên cluster tạm; FK `RESTRICT` (0051) có `down` hoàn nguyên đúng danh sách FK; **chưa diễn tập trên môi trường thật** (chưa có VPS) |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | FAIL | Diễn tập PITR trên CI (`ci:backup-restore`, dữ liệu giả); chưa có kho sao lưu khác máy và chưa khôi phục thử từ backup thật |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt tới kênh trực | FAIL | `deploy/prometheus/alerts.yml` + `/api/metrics` có test; chưa có Prometheus/Alertmanager/kênh trực thật |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA, đồng ý, chính sách riêng tư | FAIL | `docs/privacy/data-map.yaml`, ROPA khung; DPIA + pháp lý chưa có (chờ người, D-023) |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ đo thật | FAIL | Chưa có Lighthouse CI/k6 (cần đổi CI — đã defer); đợt 6 chỉ thêm bằng chứng EXPLAIN truy vấn nóng (`docs/db/explain/*.txt` khớp `db-perf.db.test.ts`, không Seq Scan trên bảng lớn) — không thay cho đo tải/Web Vitals |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe AA) luồng chính | PASS | E2E 59/59 (2026-10-17) gọi `expectAccessible` (axe 0 serious/critical) ở mọi màn chính; `ux-guards.spec.ts` 320 px 33 route, bàn phím |
| 14 | SHOULD | Release notes + CHANGELOG | PASS | `CHANGELOG.md` `[Unreleased]` đợt 1–6 |
| 15 | SHOULD | Runbook được người không viết chạy thử | FAIL | Runbook đủ (`docs/RUNBOOK.md`, `docs/ops/runbooks/*`), `last_drilled` trống — cần người |
| 16 | SHOULD | Sự kiện đo cho tính năng mới có schema, baseline | FAIL | Chủ dự án chưa quyết analytics (PM-METRIC-003, defer) |
| 17 | SHOULD | Tài liệu khớp code | PASS | Rào máy: `scripts/process-docs.test.mjs`, `repo-hygiene.test.mjs`, `ops-docs.test.mjs` (ROUTES ↔ app, domains ↔ packages/app, OpenAPI ↔ registry, link) |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" đã được chủ dự án quyết | FAIL | `rg -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → 8 đề xuất (ClamAV, khoá PII, SMTP relay ×2, phí trả sớm, cơ sở pháp lý email, chặn /api/metrics, số ngày giữ bảng sự kiện theo DPIA — D-039) chưa có quyết định |
| 19 | NICE | Dead code/dependency thừa đã rà | FAIL | Chưa chạy knip/depcheck |
| 20 | BLOCKER | (fintech) Bất biến tiền/tồn trên Postgres thật | PASS | test `INV-*` trên Postgres 17 (ledger, payments, deposits, inventory, reconciliation) trong `pnpm test:db` 896 test xanh, `rounding-arch.test.ts`, `units-guards.test.ts`; đợt 6 thêm rào schema (`schema-guards.db.test.ts`: timestamptz, tiền bigint, FK RESTRICT/index, `organization_id` NOT NULL) |

## 3. Bảng FAIL
| # | Mức | Mục | Cách sửa đề xuất | Ai |
|---|---|---|---|---|
| 3 | BLOCKER | 175 MUST mở + 55 miễn trừ chưa duyệt | Merge PR đợt 7 (#24, #26, T-605, T-606 — chạm auth/tồn → người merge); quyết từng mục `loop defer` (hạ tầng, pháp lý, CI); ghi `Duyệt:` cho miễn trừ MUST; kiểm tay SPEC-pwa S-002/S-003/S-016 trên thiết bị thật | Chủ dự án |
| 8–10 | BLOCKER | Rollback, backup, cảnh báo thật | Mua VPS tại VN + kho sao lưu khác máy, dựng Prometheus/Alertmanager, diễn tập | Chủ dự án |
| 11 | BLOCKER | DPIA, pháp lý | DPIA, đối chiếu NĐ 13/2023, Luật BVDLCN 2025, NĐ 356/2025, TT 50/17/2024 (thông báo lưu trú) | Chủ dự án + pháp lý |
| 12 | BLOCKER | Hiệu năng đo thật | Duyệt thêm job Lighthouse CI + k6 (T-608 chuẩn bị script/baseline trong repo; job CI cần duyệt) | Chủ dự án duyệt CI |
| 18 | BLOCKER | Đề xuất "Khi chạy thật" | Quyết từng mục trong DECISIONS.md (8 mục) | Chủ dự án |
| — | (quy trình) | Merge PR đợt 7; bật auto-merge | PR #24 CI 6/6 xanh, `merge-check` HUMAN (auth, ADR-0019); PR #26 chạm tồn; bật *Allow auto-merge* để L3 chạy; import ruleset để `e2e`/`quality` thành required (QA-E2E-001) | Chủ dự án |
| 15, 16, 19 | SHOULD/NICE | Diễn tập runbook, analytics, knip | Sau khi có môi trường staging | Người |

## 4. Kết luận
**NO-GO** — 7 BLOCKER FAIL (blueprint 175 MUST mở + 55 miễn trừ chưa duyệt, rollback/backup/cảnh báo thật, DPIA + pháp lý, hiệu năng đo thật, quyết định "Khi chạy thật"), tất cả cần người: hạ tầng thật, pháp lý, duyệt CI, merge PR đợt 7. Mã nguồn qua cổng: mọi PR đã merge CI 6/6; PR #24 6/6; chưa phát hành được.
Rủi ro còn lại được chấp nhận: TM-12 (hỗ trợ truy cập tạm thời — chờ F-015) — chưa có người ký.

## 5. Ký (con người, không phải agent)
| Vai trò | Tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ sản phẩm | | GO / NO-GO | |
| Kỹ thuật / vận hành | | | |
| Bảo mật / pháp lý | | | |
