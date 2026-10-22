---
name: autopilot
description: Chạy tự động từ yêu cầu đến khi hoàn thành theo khung X-Templates — lập kế hoạch (G0–G4), MỘT cổng duyệt do phiên chính tự duyệt theo tiêu chí chất lượng cuối, rồi vòng lặp có bằng chứng máy (xt.py loop) chạy trong MỘT phiên tới khi done/done-pending-human/blocked/budget. Dùng khi người dùng mô tả dự án mới, muốn "làm tự động đến khi xong", hoặc gõ /autopilot.
argument-hint: "[mô tả yêu cầu hoặc đường dẫn PROJECT.md]"
---

# /autopilot — tự động đến khi hoàn thành, dừng đúng chỗ

Giao thức đầy đủ: `<FW>/11-autonomous-loop/README.md` (đọc một lần khi bắt đầu autopilot); file này là checklist. `<FW>` = `.xtemplates/framework` (dự án đích) hoặc `framework` (repo khung); `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`). Máy in sẵn bước kế ở mỗi lệnh (`doctor`, `loop status`, `pr next`, Stop hook) — làm theo output, không đoán. Mục tiêu: xong trong **một phiên** (ADR-0009); việc cần người không chặn cả vòng.

## Bước 0 — chuẩn bị
1. Tên phiên `<Tên repo> — <tên nhánh>` (SessionStart in sẵn; ở nhánh chính thì tạo nhánh `<type>/<mô-tả>` trước).
2. `<XT> doctor --fix` — đọc output: ✗ còn lại (hook/settings/khung cài lệch) → báo người **một lần** lệnh `install.py`, làm tiếp, ghi vào việc chờ người ở báo cáo cuối; ⚠ là việc của phiên (vd `xt.yaml` trống → task đầu PLAN điền lệnh thật theo stack).
3. Chế độ quyền Auto (Stop hook nhắc nếu không).

## Pha 1 — lập kế hoạch (G0–G4), không code
Theo README bước 1–8: đọc repo trước (không hỏi điều đã có trong code) → `PROJECT.md` → `<XT> compose … --out BLUEPRINT.md` → `researcher` xác minh stack/chuẩn/luật từ nguồn sống, ADR chọn stack → `SPEC-*.md` (Given/When/Then + ca biên; spec hở → tự quyết) → thiết kế (≥ M: C4, schema, `API-CONTRACT.md`, `THREAT-MODEL.md`; build: chỉ phần code cần — ADR-0041) → `docs/autopilot/PLAN.md` theo mẫu `<FW>/templates/PLAN.md` (task ≤ 1 ngày, mỗi task một Gate máy kiểm, `(sau: …; files: …)`, mục Ủy quyền production nếu cần) → **tự duyệt PLAN**: tóm tắt ≤ 30 dòng đầu PLAN, `<XT> loop decide --question "Duyệt PLAN …" …`, báo người rồi làm tiếp không chờ.
Mọi điểm quyết định (spec hở, công nghệ, thiết kế, phạm vi, bảo mật/pháp lý mơ hồ): tự duyệt theo tiêu chí chất lượng cuối (AGENTS.md §Điểm quyết định), ghi `<XT> loop decide …` → D-NNN; mặc định tự host.

## Pha 2 — vòng lặp có bằng chứng (G5–G7)
4. `<XT> loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --single-session [--hours <H>]` (exit 2 "đang có vòng" → `<XT> loop resume`, không tự `--force`).
5. Mỗi vòng: `<XT> loop status --json` → làm đúng `task` (giao subagent theo trường `executor`; `milestone_audit: now` → audit delta `<XT> audit plan --status docs/ops/AUDIT-STATUS.md` trước, 🔴/🟠 thành task; `g7` → làm tiếp) → Gate chạy **y nguyên** qua `<XT> loop record --task T-NNN [--executor <agent>] -- '<Gate>'` (MỘT đối số, bọc nháy đơn; mỗi `'` trong Gate viết `'\''`) → exit 0: máy tự tick `[x]`, commit nhỏ (hook chạy cổng commit); exit ≠ 0: sửa — cùng lỗi lần 2 → đổi cách (ghi D-NNN), máy tự chuyển cấp `executor-deep` sau 2 lần đỏ, BLOCKED sau 3. Không skip test, không nới cổng.
6. Lát xong → một PR (harden ≤ 150 dòng, vượt → tách lát): `PROGRESS.md` (≤ 8 KB) vào commit cuối → harden: `dev-task.sh gate` **một lần** (build: CI là cổng); pha harden: diff ngoại lệ cứng → `reviewer-alt` rà **trước** khi mở PR → đẩy **một lần**, `<XT> pr title-check '<tiêu đề>'`, mở PR → `<XT> pr next --pr <N>` → làm đúng `do` → `<XT> merge-watch --pr <N>` nền (`run_in_background`), làm lát kế ngay, không chờ merge; PR đổi (push, CI, review) → lại `pr next`. Giao reviewer **chỉ khi** `pr next` trả `review` (khác **họ** model người viết; ghi `pr reviewed` theo lệnh máy in; không kết luận được → `--inconclusive`). Cần push thêm: gói sửa vào **một** commit, qua cổng. Không `sleep`. Pha build không giao reviewer (ADR-0037).
7. Blueprint: tick `[x]` kèm `— Kiểm: `<lệnh>`` chạy lại được (không có lệnh: `— Bằng chứng: <file|URL>`); `[~] — Không áp dụng: <điều kiện>`; MUST muốn miễn → `loop defer` (người duyệt). Task tối ưu hiệu năng → `optimization-loop.md` (`perf guard`/`perf compare`).
8. Việc cần người (điểm dừng về hành động — AGENTS.md §Điểm dừng): `<XT> loop defer --task <ID> --reason "…"` rồi làm tiếp; mọi việc còn lại phụ thuộc → `<XT> loop block --reason "…"`. Việc production ngoài sandbox: `<XT> grant-check <nhóm> khoá=giá trị` exit 0 mới làm.
9. Context đầy → compaction (checkpoint tự ghi), không bàn giao; ≥ 80 % trần vòng/giờ/tiền → Bàn giao vào PROGRESS, commit + push.

## Kết thúc
- Stop hook quyết: `continue`/`verify` → làm theo lý do nó in (kể cả `<XT> loop verify --all`); `done`/`done-pending-human`/`blocked`/`budget` → dừng.
- Trước G7 ở pha build: PR đặt `delivery_phase: harden` → audit delta → `<XT> release-check` (hàng `phase`, `review_debt` PASS).
- `done`: `<XT> release-check` không NO-GO → `GO-NO-GO.md` (PR lát cuối); `<XT> loop stats`, `<XT> feedback collect` (+ `feedback add` cho lỗi do khung đã sửa) → báo cáo ≤ 20 dòng: đã làm · bằng chứng · D-NNN (+ đề xuất "Khi chạy thật") · còn treo (việc chờ người kèm cách làm) · đề xuất. `blocked`/`budget`: lý do + bước kế, không khai "xong".
