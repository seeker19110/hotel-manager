# PROGRESS.md — Hotel Manager
## Đang làm
- 2026-11-06 đợt 28 (autopilot harden, PLAN-harden-2026-11-06, D-162…D-166): trả hết nợ 🟢 #149 (60ffb0c); audit delta 4 nhóm → 4 🟠 + 20 🟢; T-2616 xuất kẹt khi phiên > 5 phút (d1cc928, 03977b3). #152 thêm vá image GO-2026-6865 (compress 1.20.2) + GO-2026-6888 (brotli 1.2.7, KEV) do DB grype 2026-11-06.
- Đợt 28 chưa commit (chờ #152 merge, chia 2 PR): **ngoại lệ cứng (người merge)** T-2615 MFA/phiên chỉ đích STAFF, T-2617 migration 0080 RLS lớp 2 support, T-2618 guard down 0072 + MIGRATION_FAILED chi tiết, T-2629 (owner tự reset MFA bằng UUID viết HOA, runbook guard 0072 vĩnh viễn) — review reviewer-alt APPROVE (0 🔴); **thường** T-2619…T-2628 (🟢 sổ audit, BASE-SEC-010 port publish, OPS-OBS-008 Collector che PII + canary e2e), T-2630 LOOP-OPT-005 [~] D-165, T-2631 FE-BUILD-005 D-166, T-2632 RPO-RTO.md đề xuất.
- MUST: 75 mục còn mở đều `loop defer` (người/hạ tầng, lý do từng mục); loop `done-pending-human`.
- 2026-11-06 đợt 27 (pha harden, khung 3.30.1, D-157…D-161): merge #148 (digest base trixie lấy apt 3.0.4, CVE-2026-109518), #147 (nâng khung, người merge), #149 (agent merge làn chuẩn: CI chạy sau merge của steward D-158; ghép BLUEPRINT theo 3.30 và rà 22 mục đổi chữ; kiểm anchor link ngoài D-159; SEC-AI-002 Không áp dụng khoá bằng scripts/no-ai-agent.test.mjs D-160; WF-GIT-002 theo D-161).
- Blueprint sau ghép: MUST 364 đạt · 58 miễn/KAD · 79 chưa (thêm MUST mới của khung; BASE-CFG-003, BASE-SEC-005, BASE-SEC-010, WF-CI-001, OPS-OBS-008 mở theo chữ mới).
- release-check 2026-11-05 (cục bộ, đúng môi trường): perf k6 xanh (0% lỗi, p95 ≤ 210 ms), attack ZAP 0 FAIL (1 Low X-Content-Type-Options ×10). 13 lệnh `— Kiểm:` đỏ là do máy phiên (Node 22, thiếu DB/trình duyệt) — chạy lại xanh. Còn NO-GO vì: MUST mở, AUD-HAR-001 🟠, review_debt, migration_check/acceptance/rollback chưa khai.
- Nợ review #149 ghi ở sổ audit: AUD-HAR-005…007, AUD-CI-003/004, AUD-DOC-005, AUD-CODE-001/002, AUD-TEST-001 (`nợ-review: #149`, 🟢).
- Trước đó (đợt 25–26, D-139…D-156): migration 0076–0079 DSAR/retention, config runtime/edge/build, công cụ vận hành backup/promote/rollback, chặn source map qua Caddy, so tên biến cấu hình giữa môi trường — đã merge (#140…#146).

## Tiếp theo
0. Chủ dự án quyết (ghi ở #149): (a) AGENTS §7/xt.yaml còn ghi "mở PR là bật auto-merge" trong khi guard 3.30 chặn agent bật auto-merge; (b) WF-CI-001 đòi đúng 2 required check, ruleset có 28 — gom vào `quality` (admin) hay duyệt miễn; (c) sửa `.env.example`/`deploy/*.example` bỏ giá trị mẫu dùng được (BASE-SEC-005/CFG-003, guard chặn agent sửa `.env*`); (d) AGENTS §7 "reviewer model khác" vs LOOP-ORCH-005 (cùng họ, effort cao hơn); (e) ký lý do "chưa có staging" cho migration_check/acceptance/rollback trong GO-NO-GO.
1. Merge #152 → reset nhánh về main → mở 2 PR đợt 28 (trên). Nợ review ghi sổ: #152 🟠 thiếu test nhánh giữ key khi `uncertain`, 🟢 setCommandId sau key mới, 🟢 `/api/v1/messages` khớp LLM_HOSTS, 🟢 assert ghim Dockerfile lỏng, 🟢 VULN-SLA thiếu dòng 2026-11-06; lô hỗ trợ 🟢 replay bootstrap 500 sau hết hạn, 🟢 grep rào `'user'` actor_type. ARCH/DOC/HAR chưa audit delta (SHA cũ). Thêm vào (e): ký RPO/RTO ở docs/ops/RPO-RTO.md; DPO/pháp lý; kiểm tay thiết bị thật.
2. `.grype.yaml` luật cuối (GHSA-mrhx-c7xc-m3w5, zod 3 qua @lhci) gia hạn tới 2026-11-16 theo D-167: ngày đó nâng `@lhci/cli` 0.16.0 (đủ 2 tuần; chromium-bidi 157 dùng zod 4 đã vá) rồi GỠ luật — không gia hạn tiếp.
3. Khi có hạ tầng: docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md (pháp lý, kho log/offsite/DR, thiết bị thật, chứng cứ triển khai). Không bật production purge (D-125). Migration owner BYPASSRLS/ownership/CREATE, SET ROLE app_worker; runtime/worker không BYPASSRLS.
4. Theo dõi zod3/Lighthouse hạn 11-08, compiler native 7.0.2, LGPL sharp hạn 12-31, parse-cache-control 2027-04-18; không mặc định gia hạn. Release-please từng lỗi token từ #93.

## Quyết định
- ADR-0001/0002: modular monolith TypeScript/Postgres17, tự host; quyền/tiền kiểm ở DB và app; không thêm dịch vụ trả phí. Lịch sử D-001…D-161 ở docs/autopilot/DECISIONS.md, archive/PROGRESS-dot-24.md.
- D-157: đổi digest base sang bản upstream dựng lại có bản vá, không thêm ngoại lệ grype. D-158: ci.yml workflow_dispatch + steward actions: write. D-159: kiểm anchor link ngoài trong script hiện có. D-160: SEC-AI-002 Không áp dụng có điều kiện máy khoá. D-161: strict: true là nhánh (a) của BASE-GATE-007.
- Không force-push/rewrite main, không tự merge ngoại lệ cứng (merge-check quyết làn), không hạ ngưỡng/skip test. Bằng chứng khớp cây cuối.

## Bàn giao phiên
- Mốc main `1ca16f7` (#149). Phiên cloud dùng nhánh `claude/fervent-hamilton-n8e6jm` (reset về main sau mỗi PR merge).
- Môi trường cục bộ giống CI: Node 24.22.2 (lấy từ image node đã ghim), Postgres 17 container + binary PGDG (`bash scripts/dev-env-setup.sh --only postgres`), SeaweedFS 4.48 trên PATH, Chromium /opt/pw-browsers, dockerd tự khởi động. Cổng: scripts/commit-gated.sh (đặt TEST_DATABASE_URL, I18N_REQUIRE_BASE=1). Không chạy E2E/DAST/perf song song (cùng cổng 3100, cùng build).
- Guard 3.30 chặn lệnh Bash gộp ghi-tệp-rồi-chạy và `$(…)` dựng lệnh: ghi script bằng Write, chạy ở lệnh riêng.
- Review: reviewer-alt nay là Opus effort max (cùng họ người viết, effort cao hơn — LOOP-ORCH-005); ghi `pr reviewed --reviewer-effort max --author-effort <x>`.
