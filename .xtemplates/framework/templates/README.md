---
title: Mẫu tài liệu
kind: index
updated: 2026-10-21
---

# Mẫu tài liệu

> Mỗi mẫu gồm hướng dẫn ngắn (ai viết, giai đoạn G0–G8 nào theo [`../00-method/lifecycle.md`](../00-method/lifecycle.md),
> cổng nào dùng) rồi phần mẫu trong một khối ```` ```markdown ```` để chép nguyên vào dự án và điền chỗ `<...>`.
> Không có gì để điền thì ghi "không áp dụng — lý do", không xoá mục. Bốn file `AGENTS.md`, `CLAUDE.md`, `PROGRESS.md`, `xt.yaml` là
> mẫu harness do `scripts/install.py` copy vào dự án đích (copy-if-absent), có chỗ `[ĐIỀN]` thay vì `<...>`; `PULL-REQUEST.md`,
> `dependabot.yml`, `ci.yml`, `secret-scan.yml`, `ruleset-main.json` là mẫu `.github/` do `install.py --with-github` copy.

| File | Dùng cho | Giai đoạn · cổng |
|---|---|---|
| [`PROJECT.md`](PROJECT.md) | `PROJECT.md` — vấn đề, người dùng (JTBD), chỉ số thành công có baseline, MVP MoSCoW, "không làm", dữ liệu & pháp lý, giả định, các bên | G0–G2 · cổng G0/G1; `PM-REQ-*`, `PM-PRIO-*` |
| [`PLAN.md`](PLAN.md) | `docs/autopilot/PLAN.md` — task `T-NNN` ≤1 ngày có `Gate:` máy kiểm (đúng regex `xt.py`), điểm dừng bắt buộc, ngân sách 4 con số, hạn thật | G4–G6 · `xt.py loop init/status`; `PM-PLAN-*` |
| [`PROGRESS.md`](PROGRESS.md) | `PROGRESS.md` — ≤ 8 KB, 4 mục (Đang làm / Tiếp theo / Quyết định / Bàn giao phiên + SHA tổ tiên HEAD) | Mọi phiên · hook SessionStart; `LOOP-HARNESS-004`/`005` |
| [`SPEC.md`](SPEC.md) | `docs/specs/SPEC-<slug>.md` — user story, scenario `S-NNN` Given/When/Then, 8 nhóm ca biên, dữ liệu, lỗi, DoR/DoD, truy vết | G3 · cổng G3; `PM-SPEC-*` |
| [`ADR.md`](ADR.md) | `docs/adr/NNNN-<slug>.md` — MADR 4.0.0 + hai cột Status / Implementation status; không sửa ADR cũ | G2, G4 · `/adr`; `ARC-ADR-*` |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | `docs/THREAT-MODEL.md` — tài sản, ranh giới tin cậy, luồng dữ liệu, bảng STRIDE theo luồng → mức → biện pháp → bằng chứng | G4 · cổng G4, GO/NO-GO; `SEC-TM-*` |
| [`RUNBOOK.md`](RUNBOOK.md) | `RUNBOOK.md` — lệnh chép-chạy (deploy/rollback/restore/xoay secret), cảnh báo → playbook, việc định kỳ, liên hệ & leo thang, mức hỗ trợ | G5–G8 · cổng G8; `PM-HANDOVER-003` |
| [`POST-MORTEM.md`](POST-MORTEM.md) | `docs/ops/POST-MORTEM-<ngày>-<slug>.md` — không đổ lỗi, dòng thời gian từ nguồn máy, 5 whys, hành động có chủ + hạn, hàng rào mới | G8 · sau SEV1/SEV2; `OPS-IR-*` |
| [`DPIA.md`](DPIA.md) | `docs/DPIA.md` — hồ sơ đánh giá tác động xử lý dữ liệu cá nhân theo Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP (Điều 19–20) và GDPR Art. 35/WP248 | G2–G4 · `PM-RISK-007`, GO/NO-GO; `CMP-*` |
| [`AUDIT-STATUS.md`](AUDIT-STATUS.md) | `docs/ops/AUDIT-STATUS.md` — sổ audit máy đọc: 13 nhóm (trạng thái + SHA quét), bảng phát hiện `AUD-<MÃ>-NNN` có mức, bằng chứng, Gate | G0 brownfield, G7, định kỳ · `xt.py audit check [--strict]`; [`audit.md`](../00-method/audit.md) |
| [`AUDIT-REPORT.md`](AUDIT-REPORT.md) | `docs/ops/AUDIT-REPORT-<ngày>.md` — báo cáo một lần audit: lệnh đã chạy, phát hiện có đường tái hiện + xác minh đối kháng, kế hoạch sửa theo đợt do phiên chính tự duyệt (ADR-0008) | Như trên · `/audit` bước 6 |
| [`GO-NO-GO.md`](GO-NO-GO.md) | `docs/GO-NO-GO-<v>.md` — BLOCKER/SHOULD/NICE, mỗi mục PASS/FAIL/N/A + bằng chứng file:dòng, "Evidence or FAIL", con người ký | G7 · cổng G7; `PM-HANDOVER-006` |
| [`RELEASE-NOTES.md`](RELEASE-NOTES.md) | `docs/RELEASE-NOTES-<v>.md` — cho người dùng: cần làm gì, mới/thay đổi/sửa/bảo mật/ngừng hỗ trợ, lỗi đã biết | G7 · mỗi phát hành; `WF-REL-*` |
| [`API-CONTRACT.md`](API-CONTRACT.md) | `docs/api/API-CONTRACT-<slug>.md` — endpoint, schema, lỗi RFC 9457, versioning (`Deprecation`/`Sunset`), phân trang, idempotency, ví dụ chạy được | G3–G4 · trước khi chia việc; `PM-SPEC-005`, `BE-API-*` |
| [`ui-gates/`](ui-gates/README.md) | `scripts/verify-render.mjs` của dự án web — cổng đo bản render (axe, tràn ngang 320/280 px, tương phản theo trạng thái) | G6–G7 · `UX-A11Y-028/029` |
| [`AGENTS.md`](AGENTS.md) | `AGENTS.md` của dự án đích — luật vận hành cho mọi AI agent (Claude Code, Codex, Gemini CLI, Cursor…); `install.py` copy-if-absent | G5 · dựng nền harness |
| [`CLAUDE.md`](CLAUDE.md) | `CLAUDE.md` của dự án đích — chỉ import `AGENTS.md` + phần riêng cho Claude Code (hook, skill) | G5 · dựng nền harness |
| [`PULL-REQUEST.md`](PULL-REQUEST.md) | `.github/pull_request_template.md` của dự án đích — mục tiêu + link, bằng chứng exit code, rủi ro/đường lùi, nhãn `risk:`, migration, phụ thuộc mới, hỗ trợ AI; `install.py --with-github` copy-if-absent | Mọi PR · `WF-GIT-014`, `WF-REVIEW-002` |
| [`ruleset-main.json`](ruleset-main.json) | `.github/rulesets/main.json` của dự án đích (import ở Settings → Rules → Rulesets) — tối thiểu (D-116, D-117, ADR-0039): cấm xoá/force-push, PR squash + resolve thread, đúng 2 required check mà workflow mẫu cung cấp (`quality`, `gitleaks`; `protection-guard` là job con của `quality`; D-122 bỏ `merge-gate` — `install.py --with-github` vẫn phát `merge-gate.yml` dạng stub luôn xanh để giữ context cũ tới khi dự án gỡ khỏi ruleset sống), **không** đòi "up to date" (PR merge song song; lớp đỡ: CI chạy lại trên push `main`), `bypass_actors: []`; `install.py --with-github` copy-if-absent | G5 · `WF-GIT-002`, `WF-CI-001`, `BASE-GATE-007` |
| [`dependabot.yml`](dependabot.yml) | `.github/dependabot.yml` của dự án đích — chỉ hệ `github-actions` (thêm hệ theo manifest thật), gom nhóm, cooldown 14 ngày; `install.py --with-github` copy-if-absent | G5 · `BASE-DEP-007` |
| [`ci.yml`](ci.yml) | `.github/workflows/ci.yml` của dự án đích — không phụ thuộc stack, tối thiểu số job, song song tối đa trong job (ADR-0039, D-127, D-128): `gate` (`dev-task.sh gate-par`: typecheck ∥ lint ∥ build → test, rồi doctor · ci-check · tiêu đề PR) · `e2e` (matrix 1 shard, tăng khi đo chậm) · `quality` gom + bước protection-guard; `gate` và `e2e` chạy cùng lúc; `install.py --with-github` copy-if-absent | G5 · `WF-CI-001`, `WF-CI-024`, `WF-CI-025` |
| [`secret-scan.yml`](secret-scan.yml) | `.github/workflows/secret-scan.yml` của dự án đích — job `gitleaks` (required check của ruleset mẫu), quét toàn lịch sử; `install.py --with-github` copy-if-absent | G5 · `WF-CI-001`, `BASE-SEC-002` |
| [`xt.yaml`](xt.yaml) | `xt.yaml` — lệnh chuẩn của dự án cho hook và agent; YAML phẳng, không suy diễn từ văn xuôi. `dev-task.sh` chỉ chạy `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test) và `format_check · test_fast` (`gate-fast`, cổng commit khi `commit_gate: fast`); CI mẫu gọi thêm `e2e`/`e2e_setup` (`dev-task.sh e2e`); khoá khác (`install`, `dev`, `migrate`, `init`, `smoke`, `audit`…) agent đọc và chạy trực tiếp | G5 · `dev-task.sh gate`; `LOOP-HARNESS-008` |
