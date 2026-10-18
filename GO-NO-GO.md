# GO/NO-GO — Hotel Manager · ứng viên 0.1.0 (pilot) · 2026-10-18 (rà đợt 10, T-909)

> Đợt 10 (T-901…T-909): PR #59 · #62 · #63 · #64 · #65 · #66 · #67 · #68 · #70 đã merge. Blueprint: MUST đạt 341 · miễn 55 · **mở 105** (chi tiết: `docs/autopilot/BLUEPRINT-GAPS.md` "Kết quả đợt 10"). `loop verify`: xem PROGRESS.md.
> Bản đợt 9 — Commit: `main` `79afb9d` (đợt 3–9 đã merge; đợt 9: PR #39 T-807 · #41 T-801 · #42 T-802 · #43 T-803 · #44 T-806 · #45 T-805 · #46 T-804 · #47 T-808; sửa sau verify: #48 T-707 · #50 T-207 · #51 T-226/T-801; #49 khung 3.0.0) · Blueprint `xt.py blueprint-status BLUEPRINT.md --strict` → MUST đạt 337 · miễn 54 · **mở 105** (đầu đợt 9: đạt 282 · mở 159) · miễn trừ MUST có `Duyệt:` của chủ dự án (PR #38, 2026-10-17; SEC-SUPPLY-009 hết miễn ở #49) · `loop verify` trên `main` 79afb9d: XANH (71 Gate + 1 lệnh kiểm blueprint, 2026-10-18).
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
| 3 | BLOCKER | Blueprint: 0 MUST mở; miễn trừ có lý do | FAIL | 105 MUST mở: 95 cần người/hạ tầng/pháp lý/GitHub/quyết định (13 nhóm hành động) + 10 còn làm được trong repo (đề xuất đợt 10) — `docs/autopilot/BLUEPRINT-GAPS.md` mục 'Kết quả đợt 9'; 55 miễn trừ đã được chủ dự án duyệt (PR #38) |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | PASS | job `ci:gitleaks` xanh trên PR #10…#20 và PR #21 `4f15b27` (quét toàn lịch sử; gitleaks không cài trong container nên không chạy cục bộ) |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng cao; license trong allowlist | PASS | `pnpm audit --prod` → "No known vulnerabilities found" (chạy lại 2026-10-17); `pnpm licenses:check` → Apache-2.0, BSD-3-Clause, ISC, MIT, MIT OR Apache-2.0, MPL-2.0; job `dep-audit` xanh trên PR #21; đợt 9: job `sbom` (CycloneDX) + `image-scan` (grype chặn high/critical có bản sửa, 4 image) + `new-deps` xanh trên PR #42; ngoại lệ có hạn: `@img/sharp-libvips-linux-x64` LGPL (hết hạn 2026-12-31), `parse-cache-control` BSD (2027-04-18), `.grype.yaml` (hạn **2026-10-25** critical / 2026-11-01 high) — chờ chủ dự án duyệt/gia hạn |
| 6 | BLOCKER | Kiểm quyền phía server; test vượt quyền xanh | PASS | `packages/app/src/http/authz-matrix.db.test.ts` (api1-bola / api5-bfla sinh từ registry, 24 test, chạy lại 2026-10-17), RLS mọi bảng `organization_id` (`tenancy.db.test.ts`) |
| 7 | BLOCKER | Threat model: mọi mối đe doạ Cao có biện pháp + bằng chứng | PASS | `docs/design/THREAT-MODEL.md` v2: TM-01…TM-24 đều mitigate/accept/transfer kèm test; phần hạ tầng `transfer` cho người |
| 8 | BLOCKER | Migration có đường lùi; rollback đã diễn tập | FAIL | Down/up được test (`tenancy.db.test.ts`), lệnh rollback trong `docs/ops/runbooks/deploy-rollback.md` chạy thử trên cluster tạm; FK `RESTRICT` (0051) có `down` hoàn nguyên đúng danh sách FK; **chưa diễn tập trên môi trường thật** (chưa có VPS) |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | FAIL | Diễn tập PITR trên CI (`ci:backup-restore`, dữ liệu giả); chưa có kho sao lưu khác máy và chưa khôi phục thử từ backup thật |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt tới kênh trực | FAIL | `deploy/prometheus/alerts.yml` + `/api/metrics` có test; chưa có Prometheus/Alertmanager/kênh trực thật |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA, đồng ý, chính sách riêng tư | FAIL | `docs/privacy/data-map.yaml`, ROPA khung; DPIA + pháp lý chưa có (chờ người, D-023) |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ đo thật | FAIL | Đợt 9 (T-804) có job `lighthouse` (Lighthouse CI mobile, 3 URL, Performance ≥ 0,9, chạy mọi PR) và `bundle-size`; k6 nightly chưa có (cần staging) và chưa có số field/RUM; trước đó, đợt 6 chỉ thêm bằng chứng EXPLAIN truy vấn nóng (`docs/db/explain/*.txt` khớp `db-perf.db.test.ts`, không Seq Scan trên bảng lớn) — không thay cho đo tải/Web Vitals · T-608: script k6 (`perf/k6/`), `lighthouserc.json`, ngân sách trang `perf/budgets.json` (chặn trong E2E) và baseline cục bộ `docs/perf/baseline-web-2026-10-17.json` đã có — k6/Lighthouse **chưa đo** (không có công cụ), nên mục vẫn FAIL; xem mục "Số đo hiệu năng" |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe AA) luồng chính | PASS | E2E 59/59 (2026-10-17) gọi `expectAccessible` (axe 0 serious/critical) ở mọi màn chính; `ux-guards.spec.ts` 320 px 33 route, bàn phím |
| 14 | SHOULD | Release notes + CHANGELOG | PASS | `CHANGELOG.md` `[Unreleased]` đợt 1–6 |
| 15 | SHOULD | Runbook được người không viết chạy thử | FAIL | Runbook đủ (`docs/RUNBOOK.md`, `docs/ops/runbooks/*`), `last_drilled` trống — cần người |
| 16 | SHOULD | Sự kiện đo cho tính năng mới có schema, baseline | FAIL | Chủ dự án chưa quyết analytics (PM-METRIC-003, defer) |
| 17 | SHOULD | Tài liệu khớp code | PASS | Rào máy: `scripts/process-docs.test.mjs`, `repo-hygiene.test.mjs`, `ops-docs.test.mjs` (ROUTES ↔ app, domains ↔ packages/app, OpenAPI ↔ registry, link) |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" đã được chủ dự án quyết | FAIL | `rg -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → 18 đề xuất chưa có quyết định: 10 cũ (ClamAV, khoá PII, SMTP relay ×2, phí trả sớm, cơ sở pháp lý email, chặn /api/metrics, số ngày giữ theo DPIA, mức rate limit đăng ký, trần email D-058) + 8 của đợt 9 (D-061…D-068, mục 3b) |
| 19 | NICE | Dead code/dependency thừa đã rà | FAIL | Chưa chạy knip/depcheck |
| 20 | BLOCKER | (fintech) Bất biến tiền/tồn trên Postgres thật | PASS | test `INV-*` trên Postgres 17 (ledger, payments, deposits, inventory, reconciliation) trong `pnpm test:db` 896 test xanh, `rounding-arch.test.ts`, `units-guards.test.ts`; đợt 6 thêm rào schema (`schema-guards.db.test.ts`: timestamptz, tiền bigint, FK RESTRICT/index, `organization_id` NOT NULL) |

## 2b. Số đo hiệu năng (QA-PERF-006)
Mọi số đo kèm đủ 5 trường: commit, môi trường, thiết bị/mạng mô phỏng, VU/thời lượng, ngày. Số **chưa đo** ghi rõ — không điền số ước lượng.
| Số đo | Kết quả | Commit | Môi trường | Thiết bị/mạng | VU/thời lượng | Ngày |
|---|---|---|---|---|---|---|
| Độ trễ `GET /api/v1/today/getSummary` (1.000 mẫu) | p50 19,7 ms · p95 31,7 ms · p99 44,1 ms, 0 lỗi | `95bbecb` | `next start` production + Postgres 17 tạm cùng máy (4 lõi, 15,7 GB), không CDN | Chromium Pixel 7 qua loopback, không throttle | 1 VU tuần tự, 20,7 s | 2026-10-17 |
| Trọng lượng trang 8 màn (phòng, buồng phòng, sự cố, thông báo, đăng nhập…) | 145,6–191,2 KB truyền tải, 8–12 request | `95bbecb` | như trên | Chromium Pixel 7, không cache, không throttle | 3 lần/trang, trung vị | 2026-10-17 |
| CPU/RSS backend theo 1.000 yêu cầu | 9,85 s CPU · RSS 408 MB; kWh chưa đo | `95bbecb` | như trên | — | 1 VU, 1.000 yêu cầu | 2026-10-17 |
| k6 tải (p95/p99, 200 phiên) | **chưa đo** — không có k6 | — | cần staging | — | — | — |
| Lighthouse mobile (Performance, LCP, CLS, TBT) | **chưa đo** — không có lhci | — | cần build production + Chromium | mobile throttle mặc định | 3 lần, median | — |

Chi tiết và cách tạo lại: `docs/perf/README.md`, `docs/perf/baseline-*.json`. Số cục bộ chỉ so tương đối giữa các lần chạy cùng môi trường, không thay k6/Lighthouse trên staging.

## 3. Bảng FAIL
| # | Mức | Mục | Cách sửa đề xuất | Ai |
|---|---|---|---|---|
| 3 | BLOCKER | 105 MUST mở | 95 mục chờ người, theo 13 nhóm hành động ở `BLUEPRINT-GAPS.md` 'Kết quả đợt 9' (ruleset, nhãn/quyền GitHub, secret `RELEASE_PLEASE_TOKEN` + Actions tạo PR, VPS/staging, sao lưu khác máy + Prometheus, pháp lý DPIA/DPO/điều khoản, LICENSE/SECURITY, thiết bị thật, quyết định sản phẩm IND-SAAS-009/CMP-RIGHTS-001, biến môi trường, hook); 10 mục làm trong repo ở đợt 10 | Chủ dự án (+ phiên chính cho 10 mục) |
| 8–10 | BLOCKER | Rollback, backup, cảnh báo thật | Mua VPS tại VN + kho sao lưu khác máy, dựng Prometheus/Alertmanager, diễn tập | Chủ dự án |
| 11 | BLOCKER | DPIA, pháp lý | DPIA, đối chiếu NĐ 13/2023, Luật BVDLCN 2025, NĐ 356/2025, TT 50/17/2024 (thông báo lưu trú) | Chủ dự án + pháp lý |
| 12 | BLOCKER | Hiệu năng đo thật | Có `lighthouse` + `bundle-size` trên PR (T-804); còn k6 nightly (QA-PERF-002/007, làm được trong repo), ≥ 5 URL (PRF-WEB-005), RUM/CrUX 28 ngày (FE-PERF-001, cần production) | Phiên chính (k6, URL) · chủ dự án (production) |
| 18 | BLOCKER | Đề xuất "Khi chạy thật" | Quyết từng mục trong DECISIONS.md (18 mục; 8 của đợt 9 ở mục 4b) | Chủ dự án |
| — | (quy trình) | Import ruleset | Import `.github/rulesets/main.json` (28 required check) sau khi mọi job xanh ít nhất một lần (D-065); import `tags.json`; tắt merge commit; bật *Allow auto-merge*; **gia hạn `.grype.yaml` trước 2026-10-25** (quá hạn → `image-scan` đỏ, khi đã required sẽ chặn mọi merge) | Chủ dự án |
| 15, 16, 19 | SHOULD/NICE | Diễn tập runbook, analytics, knip | Sau khi có môi trường staging | Người |

## 4. Kết luận
**NO-GO** — 7 BLOCKER FAIL (#3 blueprint 105 MUST mở · #8 rollback · #9 backup · #10 cảnh báo · #11 DPIA/pháp lý · #12 hiệu năng đo thật · #18 quyết định "Khi chạy thật"), gần hết cần người: hạ tầng thật, pháp lý, import ruleset, duyệt ngoại lệ có hạn, quyết định sản phẩm. Mã nguồn qua cổng: mọi PR đợt 9 đã merge với job CI xanh; chưa phát hành được. Đợt 10 còn 10 mục làm được trong repo (BLUEPRINT-GAPS) — không đủ để đổi kết luận.

### 4b. Đề xuất "Khi chạy thật" của đợt 9 (D-059…D-068) cần chủ dự án quyết
| D | Đề xuất |
|---|---|
| D-059 | Không có (phạm vi đợt 9 do chủ dự án duyệt) |
| D-060 | Quyết thêm `.github/*`, `.claude/*`, `.githooks/*` vào `merge_risk_paths` (mọi PR CI/công cụ do người merge) hay giữ CODEOWNERS — WF-REVIEW-007 |
| D-061 | Quyết ngoại lệ LGPL-3.0 của `@img/sharp-libvips-linux-x64` (hết hạn 2026-12-31) |
| D-062 | Cân nhắc thay script kiểm liên kết/OpenAPI bằng lychee/oasdiff bản ghim checksum khi CI ra mạng được |
| D-063 | Thêm CODEOWNERS cho file cấu hình cổng và bật required review ở ruleset |
| D-064 | Xác minh otelcol-contrib bằng chữ ký cosign (hoặc build từ nguồn) trước khi dùng thật |
| D-065 | Import `.github/rulesets/main.json` sau khi mọi job mới xanh ít nhất một lần |
| D-066 | Quyết MIT-0 nếu muốn jsdom thay happy-dom |
| D-067 | Theo dõi bảng 'Theo dõi' của `VULN-SLA.md`; cân nhắc image dẫn xuất nếu thượng nguồn chậm quá hạn (`.grype.yaml` hạn 2026-10-25 / 2026-11-01) |
| D-068 | Xác nhận ngoại lệ BSD của `parse-cache-control` (hạn 2027-04-18) khi rà giấy phép trước phát hành |
| D-071 | Không có (phạm vi đợt 10 do chủ dự án duyệt: "làm theo đề xuất") |
| D-072 | Khi có staging: đặt `BASE_URL` của workflow k6 (và quét log PII) tới staging bằng biến môi trường repo, không phải domain production |
| D-073 | Không có (i18n: hạ tầng + ratchet; chuyển dần chuỗi còn lại) |

Rủi ro còn lại được chấp nhận: TM-12 (hỗ trợ truy cập tạm thời — chờ F-015) — chưa có người ký.

## 5. Ký (con người, không phải agent)
| Vai trò | Tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ sản phẩm | | GO / NO-GO | |
| Kỹ thuật / vận hành | | | |
| Bảo mật / pháp lý | | | |
