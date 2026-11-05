---
name: autopilot
description: Chạy tự động pha BUILD theo khung X-Templates — kế hoạch gọn (G0–G4 mức S), phiên chính tự duyệt mọi điểm quyết định, vòng lặp có bằng chứng máy (xt.py loop) trong MỘT phiên: build đợt → audit delta → sửa/đợt kế, lặp tới khi hết việc rồi /complete phát hành; không hỏi người (việc cần người: loop defer). Dùng khi người dùng mô tả dự án/tính năng mới, muốn "làm tự động đến khi xong", hoặc gõ /autopilot.
argument-hint: "[mô tả yêu cầu hoặc đường dẫn PROJECT.md]"
---

# /autopilot — pha build: nhanh nhất trên sàn máy, lặp build → audit → build tới khi hết việc

Giao thức đầy đủ: `<FW>/11-autonomous-loop/README.md`; file này là checklist pha build (ADR-0046). `<FW>` = `.xtemplates/framework` (dự án đích) hoặc `framework` (repo khung); `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`). Máy in sẵn bước kế. Một phiên tới khi hết việc (ADR-0009).
**Sàn không bỏ** (`stop-points-and-escalation.md` §Điểm dừng): guard chặn không đảo ngược/đối ngoại/bí mật; điểm dừng tiền/dữ liệu/khoá thật (`loop defer`); Gate máy mỗi task; cổng commit; CI xanh để merge; `verify --all` trước khi dừng. Bị chặn là kết luận.

## Bước 0 — chuẩn bị
1. Tên phiên `<Tên repo> — <tên nhánh>` (SessionStart in sẵn; nhánh chính → tạo `<type>/<mô-tả>`).
2. `<XT> doctor --fix` — ✗ còn → báo lệnh `install.py` **một lần**, làm tiếp; ⚠ là việc của phiên.
3. Chế độ quyền Auto. `delivery_phase` (`xt.yaml`): `build` → checklist này; `harden` → thêm luật PR `/complete` bước 4; **không tự đổi pha** (ADR-0037).

## Pha 1 — kế hoạch gọn (G0–G4 mức S, `lifecycle.md` quy tắc 6), không code
Đọc repo (stack/CI/test từ file thật) → `<XT> compose … --out BLUEPRINT.md` (không tick) → `docs/autopilot/PLAN.md` (đợt sau: `PLAN-<đợt>.md`) theo mẫu `<FW>/templates/PLAN.md`: 4 dòng Khung đầu PLAN (vấn đề · người dùng · 1 chỉ số · không làm) khi chưa có `PROJECT.md`; task ≤ 1 ngày, mỗi task một Gate máy kiểm + Given/When/Then và ca biên ngắn trong dòng task, `(sau: …; files: …)`, `(topo: parallel; exec: deep)` cho việc khó; T-001 dựng nền (xt.yaml lệnh thật, CI, MUST sàn bảo mật/cấu hình/dữ liệu); Ủy quyền production nếu cần. `researcher` + ADR chỉ khi **thêm** phụ thuộc/dịch vụ/luật ngành; SPEC riêng chỉ cho nghiệp vụ không tầm thường (tiền, quyền, trạng thái); thiết kế chỉ phần code cần (ADR-0041). **Tự duyệt PLAN**: tóm tắt ≤ 30 dòng đầu PLAN, `<XT> loop decide --question "Duyệt PLAN …" …`, làm tiếp không chờ.
Điểm quyết định: tự duyệt (AGENTS.md §4), `<XT> loop decide …` → D-NNN; mặc định tự host. Có sổ giai đoạn: PLAN khai `Giai đoạn sản phẩm: N (C-NNN)` (`<XT> stage status`, ADR-0058).

## Pha 2 — vòng lặp có bằng chứng (G5–G6)
4. `<XT> loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --single-session [--hours <H>]` (exit 2 "đang có vòng" → `<XT> loop attach`, không tự `--force`).
5. Mỗi vòng: `<XT> loop status --json` → làm đúng `task` theo `topology` (thiếu=`self`; `review`: `reviewer-alt` rà trước PR; `audit`: `/audit`; `parallel`: giao `executor` — `LOOP-ORCH-024`); `milestone_audit: g7` → làm tiếp; `now` → audit delta trước, 🔴/🟠 thành task) → Gate chạy **y nguyên** qua `<XT> loop record --task T-NNN [--executor <agent>] -- '<Gate>'` → exit 0: máy tự tick `[x]`, commit nhỏ; exit ≠ 0: sửa — lần 2 cùng lỗi → đổi cách (D-NNN), máy chuyển cấp sau 2 lần đỏ, BLOCKED sau 3. Không nới cổng.
6. Lát xong → một PR: `PROGRESS.md` (≤ 8 KB) vào commit cuối → đẩy **một lần** (CI là cổng — ADR-0041), mở PR (tiêu đề: guard kiểm) → `<XT> pr next --pr <N>` → làm đúng `do` (build: merge ghim head, nợ review trừ rủi ro cao, ADR-0062) → `<XT> merge-watch --pr <N>` nền, làm lát kế ngay; PR đổi → lại `pr next`. Push thêm: gói sửa vào **một** commit.
7. Blueprint: tick `[x]` mục task vừa chứng minh kèm `— Kiểm: `<lệnh>`` chạy lại được (không có lệnh: `— Bằng chứng: <file|URL>`); `[~] — Không áp dụng: <điều kiện>`; MUST muốn miễn → `loop defer`. MUST mở không chặn `done` ở build (đợt kế/`/complete`).
8. Việc cần người (AGENTS.md §Điểm dừng): `<XT> loop defer --task <ID> --reason "…"` rồi làm tiếp; mọi việc còn lại phụ thuộc → `<XT> loop block --reason "…"`. Việc production: `<XT> grant-check <nhóm> khoá=giá trị` exit 0 mới làm.
9. ≥ 80 % trần vòng/giờ/tiền → Bàn giao vào PROGRESS, commit + push.

## Kết thúc đợt → audit → đợt kế (không dừng — ADR-0047)
- Stop hook quyết: `continue`/`verify` → làm theo lý do nó in; `blocked`/`budget` → dừng, báo lý do + bước kế, không khai "xong".
- `done`/`done-pending-human` = đợt build xong → `<XT> loop stats`, báo cáo ≤ 20 dòng (làm · bằng chứng · D-NNN · nợ · chờ người) → **không dừng**: `<XT> loop next-step --prs <JSON pr next của đợt>` → làm đúng `action`: `pr` → bước 6; `audit` → `/audit delta` (lần đầu `full`; 🔴/🟠 → task); `replan` → `PLAN-<đợt>.md` kế từ 🔴/🟠 + MUST mở (chờ người: chép nguyên dòng), tự duyệt, `loop init --plan …` → bước 5; `verify` → `loop verify --all`; `blocked`/`budget` → dừng, báo; `stage-submit`/`wait-approval`/`stage-reopen` → làm đúng `reason` (trình · chờ · mở lại), báo người, dừng — smoke đỏ → như `replan`; `ready-for-complete` → `<XT> feedback collect`, **đề xuất** `/complete`, dừng.
