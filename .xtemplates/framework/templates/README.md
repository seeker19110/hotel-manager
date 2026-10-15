---
title: Mẫu tài liệu
kind: index
updated: 2026-10-14
---

# Mẫu tài liệu

> Mỗi mẫu gồm hướng dẫn ngắn (ai viết, giai đoạn G0–G8 nào theo [`../00-method/lifecycle.md`](../00-method/lifecycle.md),
> cổng nào dùng) rồi phần mẫu trong một khối ```` ```markdown ```` để chép nguyên vào dự án và điền chỗ `<...>`.
> Không có gì để điền thì ghi "không áp dụng — lý do", không xoá mục. Bốn file `AGENTS.md`, `CLAUDE.md`, `PROGRESS.md`, `xt.yaml` là
> mẫu harness do `scripts/install.py` copy vào dự án đích (copy-if-absent), có chỗ `[ĐIỀN]` thay vì `<...>`.

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
| [`AUDIT-REPORT.md`](AUDIT-REPORT.md) | `docs/ops/AUDIT-REPORT-<ngày>.md` — báo cáo một lần audit: lệnh đã chạy, phát hiện có đường tái hiện + xác minh đối kháng, kế hoạch sửa theo đợt chờ duyệt | Như trên · `/audit` bước dừng chờ duyệt |
| [`GO-NO-GO.md`](GO-NO-GO.md) | `docs/GO-NO-GO-<v>.md` — BLOCKER/SHOULD/NICE, mỗi mục PASS/FAIL/N/A + bằng chứng file:dòng, "Evidence or FAIL", con người ký | G7 · cổng G7; `PM-HANDOVER-006` |
| [`RELEASE-NOTES.md`](RELEASE-NOTES.md) | `docs/RELEASE-NOTES-<v>.md` — cho người dùng: cần làm gì, mới/thay đổi/sửa/bảo mật/ngừng hỗ trợ, lỗi đã biết | G7 · mỗi phát hành; `WF-REL-*` |
| [`API-CONTRACT.md`](API-CONTRACT.md) | `docs/api/API-CONTRACT-<slug>.md` — endpoint, schema, lỗi RFC 9457, versioning (`Deprecation`/`Sunset`), phân trang, idempotency, ví dụ chạy được | G3–G4 · trước khi chia việc; `PM-SPEC-005`, `BE-API-*` |
| [`AGENTS.md`](AGENTS.md) | `AGENTS.md` của dự án đích — luật vận hành cho mọi AI agent (Claude Code, Codex, Gemini CLI, Cursor…); `install.py` copy-if-absent | G5 · dựng nền harness |
| [`CLAUDE.md`](CLAUDE.md) | `CLAUDE.md` của dự án đích — chỉ import `AGENTS.md` + phần riêng cho Claude Code (hook, skill) | G5 · dựng nền harness |
| [`xt.yaml`](xt.yaml) | `xt.yaml` — lệnh chuẩn của dự án cho hook và agent; YAML phẳng, không suy diễn từ văn xuôi. `dev-task.sh` chỉ chạy `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test); khoá khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`, `audit`…) agent đọc và chạy trực tiếp | G5 · `dev-task.sh gate`; `LOOP-HARNESS-008` |
