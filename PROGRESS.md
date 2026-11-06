# PROGRESS.md — Hotel Manager
## Đang làm
- 2026-11-06 đợt 28 (autopilot harden, PLAN-harden-2026-11-06, D-162…D-163): trả hết nợ 🟢 #149 (T-2604/2606/2607/2608/2611–2614, 60ffb0c); audit delta 4 nhóm (reviewer-alt) → 4 🟠 + 20 🟢 vào sổ; T-2616 sửa xuất kẹt khi phiên > 5 phút (d1cc928). Còn: T-2615 (MFA reset đích support), T-2617 (RLS lớp 2 support, migration mới), T-2618 (CLI chặn down qua 0072). Chờ người: T-2605, T-2609, T-2610.
- 2026-11-06 đợt 27 (pha harden, khung 3.30.1, D-157…D-161): merge #148 (digest base trixie lấy apt 3.0.4, CVE-2026-109518), #147 (nâng khung, người merge), #149 (agent merge làn chuẩn: CI chạy sau merge của steward D-158; ghép BLUEPRINT theo 3.30 và rà 22 mục đổi chữ; kiểm anchor link ngoài D-159; SEC-AI-002 Không áp dụng khoá bằng scripts/no-ai-agent.test.mjs D-160; WF-GIT-002 theo D-161).
- Blueprint sau ghép: MUST 364 đạt · 58 miễn/KAD · 79 chưa (thêm MUST mới của khung; BASE-CFG-003, BASE-SEC-005, BASE-SEC-010, WF-CI-001, OPS-OBS-008 mở theo chữ mới).
- release-check 2026-11-05 (cục bộ, đúng môi trường): perf k6 xanh (0% lỗi, p95 ≤ 210 ms), attack ZAP 0 FAIL (1 Low X-Content-Type-Options ×10). 13 lệnh `— Kiểm:` đỏ là do máy phiên (Node 22, thiếu DB/trình duyệt) — chạy lại xanh. Còn NO-GO vì: MUST mở, AUD-HAR-001 🟠, review_debt, migration_check/acceptance/rollback chưa khai.
- Nợ review #149 ghi ở sổ audit: AUD-HAR-005…007, AUD-CI-003/004, AUD-DOC-005, AUD-CODE-001/002, AUD-TEST-001 (`nợ-review: #149`, 🟢).
- Trước đó (đợt 25–26, D-139…D-156): migration 0076–0079 DSAR/retention, config runtime/edge/build, công cụ vận hành backup/promote/rollback, chặn source map qua Caddy, so tên biến cấu hình giữa môi trường — đã merge (#140…#146).

## Tiếp theo
0. Chủ dự án quyết (ghi ở #149): (a) AGENTS §7/xt.yaml còn ghi "mở PR là bật auto-merge" trong khi guard 3.30 chặn agent bật auto-merge; (b) WF-CI-001 đòi đúng 2 required check, ruleset có 28 — gom vào `quality` (admin) hay duyệt miễn; (c) sửa `.env.example`/`deploy/*.example` bỏ giá trị mẫu dùng được (BASE-SEC-005/CFG-003, guard chặn agent sửa `.env*`); (d) AGENTS §7 "reviewer model khác" vs LOOP-ORCH-005 (cùng họ, effort cao hơn); (e) ký lý do "chưa có staging" cho migration_check/acceptance/rollback trong GO-NO-GO.
1. Vòng autopilot đang bật (PLAN-harden-2026-11-06): T-2615, T-2617, T-2618 (🟠, chạm access/CSDL ⇒ người merge); rồi 🟢 sổ audit và MUST mã: BASE-SEC-010, OPS-OBS-008, MUST mới của khung 3.30. ARCH/DOC/HAR chưa audit delta (SHA cũ).
2. `.grype.yaml` luật cuối (GHSA-mrhx-c7xc-m3w5, zod 3 qua @lhci) hết hạn 2026-11-08 ⇒ image-scan đỏ theo thiết kế: rà lại trước hạn, không gia hạn mặc định.
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
