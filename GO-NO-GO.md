# GO/NO-GO — Hotel Manager · ứng viên 0.1.0 (pilot) · 2026-10-17

> Commit: nhánh `wip/wave5-final` (xếp chồng sau PR #10 lát 3; chưa lên CI vì các lát 4–12 chưa có PR) · Blueprint: `xt.py blueprint-status BLUEPRINT.md --strict` → MUST đạt 246 · miễn 54 · **mở 196** (156 chờ người đã `loop defer`, 40 thiếu trong repo) · CI: PR #10 6/6 xanh trên `0d029f8`; các nhánh sau chưa chạy CI.
> Người kiểm: phiên autopilot (report-only, không deploy) · Phạm vi: web/PWA + worker + CSDL; không có mobile native.

## 1. Đếm
| Mức | PASS | FAIL | N/A |
|---|---|---|---|
| BLOCKER | 5 | 9 | 0 |
| SHOULD | 2 | 2 | 0 |
| NICE | 0 | 1 | 0 |

## 2. Danh mục kiểm
| # | Mức | Mục | Kết quả | Bằng chứng |
|---|---|---|---|---|
| 1 | BLOCKER | Build tái lập, không lỗi type/lint, không cờ giấu lỗi | PASS (cục bộ) | Cổng `dev-task.sh gate` (build · typecheck · lint · test) xanh ở mọi commit đợt 4–5 (hook PreToolUse); không `ignoreBuildErrors`/`continue-on-error` trong mã nguồn (`xt.py ci-check .github/workflows` ✓). CI chưa chạy trên các nhánh đợt 3 lát 4 → đợt 5 |
| 2 | BLOCKER | Toàn bộ test xanh (unit/integration/E2E luồng chính) | FAIL | Cục bộ: `pnpm test` 143 file / ~1.960 test xanh, E2E 52/52 (`E2E_PORT=3220`) trên `d6b0b28`; nhưng chưa có CI cho các lát chưa có PR ⇒ chưa đạt "Evidence or FAIL" ở mức phát hành |
| 3 | BLOCKER | Blueprint: 0 MUST mở; miễn trừ có lý do | FAIL | 196 MUST mở (156 chờ người — `.autopilot/state.json` `deferred`; 40 thiếu, liệt kê ở `docs/autopilot/BLUEPRINT-GAPS.md`) |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | PASS (đến PR #10) | job `ci:gitleaks` xanh trên PR #10; các nhánh sau chưa quét bằng CI (gitleaks không cài trong container) |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng cao; license trong allowlist | PASS | `pnpm audit --prod` → "No known vulnerabilities found" (2026-10-17); `pnpm licenses:check` → Apache-2.0, BSD-3-Clause, ISC, MIT, MPL-2.0 |
| 6 | BLOCKER | Kiểm quyền phía server; test vượt quyền xanh | PASS | `packages/app/src/http/authz-matrix.db.test.ts` (api1-bola / api5-bfla sinh từ registry, 23 test), RLS mọi bảng `organization_id` (`tenancy.db.test.ts`) |
| 7 | BLOCKER | Threat model: mọi mối đe doạ Cao có biện pháp + bằng chứng | PASS | `docs/design/THREAT-MODEL.md` v2: TM-01…TM-24 đều mitigate/accept/transfer kèm test; phần hạ tầng `transfer` cho người |
| 8 | BLOCKER | Migration có đường lùi; rollback đã diễn tập | FAIL | Down/up được test (`tenancy.db.test.ts`), lệnh rollback trong `docs/ops/runbooks/deploy-rollback.md` chạy thử trên cluster tạm; **chưa diễn tập trên môi trường thật** (chưa có VPS) |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | FAIL | Diễn tập PITR trên CI (`ci:backup-restore`, dữ liệu giả); chưa có kho sao lưu khác máy và chưa khôi phục thử từ backup thật |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt tới kênh trực | FAIL | `deploy/prometheus/alerts.yml` + `/api/metrics` có test; chưa có Prometheus/Alertmanager/kênh trực thật |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA, đồng ý, chính sách riêng tư | FAIL | `docs/privacy/data-map.yaml`, ROPA khung; DPIA + pháp lý chưa có (chờ người, D-023) |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ đo thật | FAIL | Chưa có Lighthouse CI/k6 (cần đổi CI — đã defer); chỉ có EXPLAIN truy vấn nóng (`db-perf.db.test.ts`) |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe AA) luồng chính | PASS | E2E gọi `expectAccessible` (axe 0 serious/critical) ở mọi màn chính; `ux-guards.spec.ts` 320 px 33 route, bàn phím |
| 14 | SHOULD | Release notes + CHANGELOG | PASS | `CHANGELOG.md` `[Unreleased]` đợt 1–5 |
| 15 | SHOULD | Runbook được người không viết chạy thử | FAIL | Runbook đủ (`docs/RUNBOOK.md`, `docs/ops/runbooks/*`), `last_drilled` trống — cần người |
| 16 | SHOULD | Sự kiện đo cho tính năng mới có schema, baseline | FAIL | Chủ dự án chưa quyết analytics (PM-METRIC-003, defer) |
| 17 | SHOULD | Tài liệu khớp code | PASS | Rào máy: `scripts/process-docs.test.mjs`, `repo-hygiene.test.mjs`, `ops-docs.test.mjs` (ROUTES ↔ app, domains ↔ packages/app, OpenAPI ↔ registry, link) |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" đã được chủ dự án quyết | FAIL | `rg -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → 7 đề xuất (ClamAV, khoá PII, SMTP relay ×2, phí trả sớm, cơ sở pháp lý email, chặn /api/metrics) chưa có quyết định |
| 19 | NICE | Dead code/dependency thừa đã rà | FAIL | Chưa chạy knip/depcheck |
| 20 | BLOCKER | (fintech) Bất biến tiền/tồn trên Postgres thật | PASS | test `INV-*` trên Postgres 17 (ledger, payments, deposits, inventory, reconciliation), `rounding-arch.test.ts`, `units-guards.test.ts` |

## 3. Bảng FAIL
| # | Mức | Mục | Cách sửa đề xuất | Ai |
|---|---|---|---|---|
| 2 | BLOCKER | CI cho lát 4 → 12 | Merge PR #10, rồi mở PR lần lượt từng lát (autopilot làm, người merge theo `merge-check`) | Chủ dự án merge |
| 3 | BLOCKER | 196 MUST mở | 156: quyết định/hạ tầng của người (danh sách `loop defer`); 40: đợt 6 trong repo | Người + autopilot |
| 8–10 | BLOCKER | Rollback, backup, cảnh báo thật | Mua VPS tại VN + kho sao lưu khác máy, dựng Prometheus/Alertmanager, diễn tập | Chủ dự án |
| 11 | BLOCKER | DPIA, pháp lý | DPIA, đối chiếu NĐ 13/2023, Luật BVDLCN 2025, NĐ 356/2025, TT 50/17/2024 (thông báo lưu trú) | Chủ dự án + pháp lý |
| 12 | BLOCKER | Hiệu năng đo thật | Duyệt thêm job Lighthouse CI + k6 (đề xuất trong BLUEPRINT-GAPS) | Chủ dự án duyệt CI |
| 18 | BLOCKER | Đề xuất "Khi chạy thật" | Quyết từng mục trong DECISIONS.md | Chủ dự án |
| 15, 16, 19 | SHOULD/NICE | Diễn tập runbook, analytics, knip | Sau khi có môi trường staging | Người |

## 4. Kết luận
**NO-GO** — 9 BLOCKER FAIL, chủ yếu cần người: hạ tầng thật, pháp lý, quyết định "Khi chạy thật", duyệt CI, merge PR. Mã nguồn đủ tính năng Must của pilot và qua cổng cục bộ; chưa phát hành được.
Rủi ro còn lại được chấp nhận: TM-12 (hỗ trợ truy cập tạm thời — chờ F-015) — chưa có người ký.

## 5. Ký (con người, không phải agent)
| Vai trò | Tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ sản phẩm | | GO / NO-GO | |
| Kỹ thuật / vận hành | | | |
| Bảo mật / pháp lý | | | |
