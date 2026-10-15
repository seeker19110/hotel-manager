# PROGRESS.md — Khung X-Templates

> Giai đoạn hiện tại: G8 Vận hành & tiến hoá (khung v2 đã phát hành) · Cập nhật: 2026-10-15 · Nhánh: claude/serene-ride-3jvrfp

## Đang làm
- Audit delta sau #43 (`0d1b62c`, ADR-0007): 8 nhóm quét, 1 🔴 · 3 🟠 · 3 🟢 (`docs/ops/AUDIT-REPORT-2026-10-15.md` §10). Đợt 1 (duyệt 2026-10-15) sửa ở #1: 🔴 AUD-HAR-021 (hook lệch tên sau nâng cấp → guard fail-open; `_lib.sh` giữ bí danh + `_compat.sh`) và AUD-HAR-022 (`xs_py`, cảnh báo "HOOK còn tên cũ"). Còn đợt 2 (`docs:` AUD-DOC-023/024, AUD-SEC-015) và đợt 3 (🟢 AUD-HAR-023/024) chờ làm.

## Tiếp theo
1. Cần người chọn: một dự án sản phẩm thật (web/api, quy mô M) để thử khung, đo mục MUST hay bị miễn trừ.
2. Dự án đã cài khung (sau khi #1 merge; hook đã sửa tay → gộp `.xtemplates-new` theo cảnh báo "HOOK còn tên cũ"): chạy lại `install.py` từ X-Templates để chuyển `.xstored/`→`.xtemplates/`, `xs.yaml`→`xt.yaml` (ADR-0007) + nhận guard/hook mới (#35, #36) + `changelog-check` + `progress-check` xét `MERGE_HEAD` (#41).
3. Admin: tự kiểm Dependabot security updates (proxy chặn API); ô "extra approval for unattributed changes" của ruleset `main` còn bật — khác `.github/rulesets/main.json`, vô hại khi 0 approval.
4. Giới hạn đã biết, chưa sửa: guard không thấy lệnh trong `eval`/alias/biến chứa cờ (CHANGELOG); `xt.py` có thể lấy `$HOME` dotfiles (`.git`) làm gốc khi dự án chưa có dấu hiệu khung (README).
5. Giữ cổng: C901 ≤ 10, `mypy --strict`, coverage dòng + nhánh 100%, `changelog-check` — hàm mới vượt thì tách, không `noqa`/pragma.

## Quyết định
- 2026-10-13 Khung v2 = thư viện yêu cầu có ID + máy ghép blueprint + máy kiểm "xong" — ADR-0001.
- 2026-10-13 Harness: hook fail-open về luồng, fail-closed về hành động nguy hiểm; Stop hook đọc bằng chứng — ADR-0002.
- 2026-10-13 Quy mô S chỉ giữ MUST của baseline/hồ sơ/ngành — ADR-0003.
- 2026-10-13 Luật dữ liệu VN hiện hành: Luật 91/2025/QH15 + NĐ 356/2025 (thay NĐ 13/2023 từ 01/01/2026); Luật ANM 116/2025 (01/07/2026).
- 2026-10-14 OWASP LLM Top 10 ấn bản 2026 (04/08/2026); EU AI Act Đ.50 áp dụng 02/08/2026; bản đồ "một chủ đề một nhà" ghi vào conventions.
- 2026-10-14 Dogfood: compose giữ trạng thái theo ID; sàn Python 3.11; CI chạy đúng `dev-task.sh gate`; ruff + mypy ghim.
- 2026-10-14 Quy mô M: tối đa 4 MUST mỗi module/chuẩn, phần vượt `MUST@L`; web-app M 1.094 → 470 — ADR-0004.
- 2026-10-13 Mặc định OSI: OpenTofu (MPL-2.0) thay Terraform (BUSL-1.1), Valkey thay Redis 8; Lighthouse CI giữ có cảnh báo, ghi phương án thay.
- 2026-10-14 PROGRESS chỉ ghi SHA trên `main`: squash-merge làm SHA của nhánh PR không còn là tổ tiên HEAD — `xt.py progress-check` trong cổng `lint` sẽ đỏ.
- 2026-10-14 Audit có máy đỡ: sổ `docs/ops/AUDIT-STATUS.md` máy đọc, `audit check --strict` = Definition of Complete — ADR-0005.
- Nợ kỹ thuật chấp nhận: chọn 4 MUST/module là phán đoán, chờ dữ liệu miễn trừ từ dự án thật; số điều cụ thể của NĐ 356/2025 chưa đối chiếu bản gốc — trả khi audit dự án thật.
- 2026-10-14 Sửa audit 5 đợt (#20–#24): `dev-task.sh` lấy gốc dự án đúng ở `.xstored/`; hook phân tích lệnh bằng `guard.py` (shlex); install gộp hook + manifest hash; công cụ cổng khoá hash + `dep-audit`; WF-DOC-004 bỏ điều kiện "nhánh còn trên remote" (xung đột squash).
- 2026-10-14 9 mục trùng chủ đề chuyển `MAY` "gộp vào" nhà (ID giữ, CHANGELOG).
- 2026-10-14 Repo khung: cổng `typecheck` = `mypy --strict`; cổng `test` đòi coverage dòng + nhánh 100% (cả subprocess) — mã chết thì xoá, không dùng `pragma: no cover` trừ khi không thể chạy tới.
- 2026-10-14 Repo đổi tên X-stored → X-Templates; giữ `.xstored/`, `xs.py`, `XS_*` — ADR-0006 (bị thay bởi ADR-0007).
- 2026-10-15 Định danh kỹ thuật theo tên mới: `.xtemplates/`, `xt.py`, `xt.yaml`, `XT_*`; `install.py` tự chuyển bản ≤ 2.x, liệt kê file còn tên cũ; tài liệu lịch sử giữ tên cũ; bản kế tiếp 3.0.0 — ADR-0007.
- 2026-10-14 `LOOP-HARNESS-012` → 018: không biến tắt hook riêng; tắt có chủ đích qua `disableAllHooks` của Claude Code; test fail-open 5 hook.
- 2026-10-15 Commit/PR không ghi tên model hay URL phiên AI (giữ AGENTS.md §3; AUD-HAR-017).
- 2026-10-15 Tag phát hành tạo bằng workflow `release-tag.yml` (proxy chặn push tag từ phiên agent); `v2.0.0` → `55de4d1`.
- 2026-10-15 Guard hỏi khi mở phiên Claude bỏ qua hook (`--bare`, `--settings`, `disableAllHooks`…); cổng commit chạy trước khi hỏi người.
- 2026-10-15 `xt.py changelog-check` trong cổng `lint`; gốc dự án: `CLAUDE_PROJECT_DIR` → cha `.xtemplates` → dấu hiệu khung → `.git` → cwd.
- 2026-10-15 Bằng chứng blueprint trích máy kiểm/test, không trích file trạng thái viết lại mỗi phiên (PROGRESS.md, PLAN) — nếu không `audit plan` cờ cũ sau mọi phiên (AUD-HAR-019).

## Bàn giao phiên
- 2026-10-15 · Commit cuối trên `main`: `0d1b62c` (#43); tag `v2.0.0` → `55de4d1`; SHA quét audit `0d1b62c` (trừ DEP/CFG/PERF cũ hơn, không file đổi).
- Lệnh kiểm nhanh: `scripts/dev-task.sh gate` (đọc `xt.yaml`; `pip install --require-hashes -r requirements-dev.txt`, cần shellcheck).
- Autopilot: không chạy. Đang chặn: không. Đợt 2–3 audit §10 chưa làm (chờ lệnh).
- Câu hỏi cần người: Tiếp theo 1 (dự án thật để thử khung).
