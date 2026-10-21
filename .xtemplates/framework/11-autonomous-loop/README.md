---
title: Vòng lặp tự động (autopilot)
kind: index
updated: 2026-10-20
---

# 11 — Vòng lặp tự động (autopilot)

> Mảng này mô tả cách một agent **chạy tự động đến khi xong mà vẫn dừng đúng chỗ**: lập kế hoạch một lần, MỘT cổng
> duyệt (phiên chính tự duyệt theo tiêu chí chất lượng cuối, ADR-0008), rồi vòng lặp mà mỗi vòng kết thúc bằng **bằng chứng máy** (`xt.py loop record`) và Stop hook đọc bằng chứng
> đó để quyết cho dừng hay làm tiếp. Mọi lệnh ở đây là lệnh thật trong `scripts/xt.py` và harness `.claude/`; hệ
> agentic **làm sản phẩm** (đa agent chạy runtime) ở [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`loop-design.md`](loop-design.md) | Thiết kế vòng lặp: 4 con số, tiêu chí dừng máy kiểm, bằng chứng; vòng bảo trì kích hoạt theo ngưỡng | Trước khi bật autopilot lần đầu; khi chọn tầng vòng lặp (hook/`/loop`/headless/ngưỡng) |
| [`harness-files.md`](harness-files.md) | File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state | Khi viết PLAN.md, PROGRESS.md; khi hỏi "file nào commit, file nào không" |
| [`stop-points-and-escalation.md`](stop-points-and-escalation.md) | Điểm quyết định tự duyệt (tiêu chí chất lượng cuối), điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang | Khi cần quyết định; khi quyết hành động nào agent được tự làm; khi cấu hình allow/ask/deny |
| [`orchestration-and-subagents.md`](orchestration-and-subagents.md) | Điều phối: subagent, worktree, song song, không lồng | Khi tách việc cho `researcher`/`executor`/`reviewer`; khi muốn chạy song song |
| [`self-healing-ci.md`](self-healing-ci.md) | Agent tự sửa CI/review: giới hạn, cấm (kể cả làm yếu test, tự gắn `@flaky`), bằng chứng | Khi CI đỏ trong autopilot; khi cấu hình workflow có agent là tác giả |
| [`optimization-loop.md`](optimization-loop.md) | Vòng tối ưu hiệu năng: bộ đo khoá, profile, một thay đổi, máy quyết giữ/hoàn tác, chống gian lận số đo; `xt.py perf` | Khi PLAN có task tối ưu hiệu năng; trước G7 |
| [`context-and-token-budget.md`](context-and-token-budget.md) | Ngân sách context/token, compaction, bàn giao phiên | Khi phiên dài, gần hết ngân sách; khi viết bàn giao |
| [`framework-feedback.md`](framework-feedback.md) | Phản hồi lỗi do khung + cách khắc phục từ dự án đích (`xt.py feedback`), khung kéo về và gộp | Khi sửa xong một lỗi do khung; trước bàn giao/phát hành; khi bảo trì repo khung |

## Chính sách tự chủ: một nhà

Nhà duy nhất của chính sách tự chủ — mức L0–L4 và điều kiện lên mức, vị từ "làn nhanh", điểm quyết định tự duyệt,
điểm dừng bắt buộc, ngoại lệ cứng — là [`stop-points-and-escalation.md`](stop-points-and-escalation.md). README, skill,
template và `AGENTS.md` chỉ tóm tắt và liên kết, không chép bảng/ngưỡng; số đếm lấy từ `xt.py stats`. Test
`autonomy_policy_single_home` giữ điều này.

## Giao thức autopilot (AGENTS.md trỏ tới đây)

`<XT>` = `python3 .xtemplates/scripts/xt.py` trong dự án đích (`python3 scripts/xt.py` trong repo khung). Skill
`/autopilot` (`.claude/skills/autopilot/SKILL.md`) là checklist của giao thức này. Máy in sẵn bước kế ở mỗi lệnh (`doctor`,
`loop init`, `loop status`, `pr next`, Stop hook) — tài liệu không chép lại output đó; agent làm theo output.

**Pha 0 — chuẩn bị** ([`LOOP-HARNESS-020`](harness-files.md), [`LOOP-HARNESS-028`](harness-files.md))

0. Tên phiên `<Tên repo> — <tên nhánh>` (hook SessionStart in gợi ý). `<XT> doctor --fix` là việc **đầu tiên**: kiểm khung
   đã cài (runtime, hook + file hook + cú pháp, skill/subagent, `AGENTS.md`/`CLAUDE.md`, `xt.yaml`, `.gitignore`, state,
   khung hợp lệ, `PROGRESS.md`), sửa phần an toàn, đảo ngược được. Còn ✗ (hook/settings/khung cài lệch) → báo người lệnh
   `install.py` một lần, vẫn làm tiếp — vòng thiếu máy kiểm: báo cáo cuối ghi rõ, gom vào việc chờ người; `loop init` cảnh
   báo lại trên stderr (không chặn, ADR-0002 fail-open về luồng).
   Phiên ở chế độ quyền Auto (`claude --permission-mode auto`; phiên cloud chọn Auto ở bộ chọn chế độ quyền).

**Pha 1 — lập kế hoạch, không code** (đầu ra từng giai đoạn: [`../00-method/lifecycle.md`](../00-method/lifecycle.md))

1. **Đọc repo trước**: dò stack/CI/test từ file thật (`package.json`, `pyproject`, workflow); không hỏi điều đã có trong code.
2. **G0 Frame** → `PROJECT.md`: vấn đề, người dùng, ≥ 1 chỉ số đo được, "không làm".
3. **G1 Classify** → `<XT> compose --profile <p> [--industry <i>] --scale <S|M|L> [--add <module>] --out BLUEPRINT.md`
   (`<XT> list profiles`, `<XT> list industries`; `--add` ghép module ngoài hồ sơ).
4. **G2 Research** → `researcher` xác minh phiên bản/chuẩn/luật từ nguồn sống, ghi ngày; ADR chọn stack.
5. **G3 Specify** → `SPEC-*.md` (Given/When/Then + ca biên); spec hở → phiên chính quyết tường minh (`<XT> loop decide`,
   D-NNN) theo tiêu chí chất lượng cuối ở [`stop-points-and-escalation.md`](stop-points-and-escalation.md) — tự duyệt, không chờ người.
6. **G4 Design** → sơ đồ, schema, `API-CONTRACT.md`, `THREAT-MODEL.md` (≥ M).
7. **`docs/autopilot/PLAN.md`** theo [`../templates/PLAN.md`](../templates/PLAN.md): mỗi task một dòng
   `- [ ] \`T-NNN\` <việc> — Gate: \`<lệnh>\`` (regex thật: `TASK_RE`/`GATE_RE` trong xt.py), ≤ 1 ngày/task,
   `(sau: …; files: …)`; số cho cờ `loop init` theo [`LOOP-DESIGN-001`](loop-design.md); mục Ủy quyền production nếu cần (ADR-0022).
8. **MỘT cổng duyệt — phiên chính tự duyệt**: tóm tắt ≤ 30 dòng (MUST/SHOULD của blueprint, stack + phiên bản, task, rủi ro)
   ở đầu PLAN; `<XT> loop decide --question "Duyệt PLAN …"`; báo người tóm tắt rồi **làm tiếp không chờ**.

**Pha 2 — vòng lặp có bằng chứng**

9. `<XT> loop init --plan docs/autopilot/PLAN.md [--blueprint B] --single-session [--hours H]` → `.autopilot/state.json`
   (gitignore; trần vòng tự tính, `max_same_failure: 3`). **Một phiên đến khi xong** (ADR-0009).
10. **Mỗi vòng**: `<XT> loop status --json` → `continue` kèm `task`, `executor` (tầng giao việc, ADR-0029; `escalated` =
    chuyển cấp kèm diff + evidence lỗi + giả thuyết đã loại), `milestone_done` + `milestone_audit` (`now` → audit delta theo
    [`../00-method/audit.md`](../00-method/audit.md) §1 trước task kế, 🔴/🟠 thành task mới; `g7` ở pha build → làm tiếp —
    ADR-0033) → làm task → Gate **y nguyên** qua `<XT> loop record --task T-NNN [--executor <agent>] -- '<Gate>'` (Gate là MỘT đối số
    bọc nháy đơn — mỗi `'` trong Gate viết `'\''`; ghi `.autopilot/evidence/T-NNN.json`: `exit_code`, `cmd`, `head`, 40 dòng cuối).
11. Exit 0 → máy tự tick `[x]` (lệnh khớp Gate; `--no-tick` để tự tay — T-1719), commit nhỏ (conventional) qua cổng commit (`commit_gate`, [`LOOP-HARNESS-008`](harness-files.md)).
    Exit ≠ 0 → sửa; cùng chữ ký lỗi lần 2 → đổi cách tiếp cận (ghi D-NNN); lần 3 → máy đặt `blocked`
    ([`LOOP-DESIGN-005`](loop-design.md)). Không skip test, không nới cổng ([`LOOP-CI-001`](self-healing-ci.md)).
12. **Lát xong → một PR** ([`LOOP-DESIGN-020`](loop-design.md), ADR-0014; nhánh riêng từ nhánh đích mới nhất, chồng lên PR
    chưa merge nếu phụ thuộc): `PROGRESS.md` (≤ 8 KB) vào commit cuối của lát → cổng đầy đủ `dev-task.sh gate` **một lần**
    (CI chạy đúng lệnh đó) → đẩy **một lần**, mở PR → `<XT> pr next --pr <N>`, làm đúng `do`; `<XT> merge-watch --pr <N>`
    chạy nền và khi thoát in sẵn kết quả `pr next`; mỗi khi PR đổi (push, CI, review) lại `pr next`. Reviewer **chỉ khi** `pr next` trả
    `review` — khác **họ** model với người viết ([`LOOP-ORCH-005`](orchestration-and-subagents.md); không kết luận được →
    `<XT> pr reviewed --inconclusive` rồi giao reviewer khác); ghi `<XT> pr reviewed` theo lệnh máy in (đăng lên PR để
    `pr-steward` làm thay khi không còn phiên — ADR-0027). Cần push thêm → tự tắt auto-merge trước, gói sửa vào một commit.
    Luật làn, ngoại lệ cứng, pha build: [`LOOP-STOP-022`](stop-points-and-escalation.md), ADR-0024/0025/0031/0033.
13. **Stop hook quyết** (`stop-guard.sh` → `<XT> loop hook-stop`): `continue`/`verify` → trả `block` kèm lý do, agent làm
    tiếp (`verify` = task tick mà thiếu/khác bằng chứng, hoặc chưa chạy `<XT> loop verify --all` trên cây cuối —
    [`LOOP-DESIGN-022`](loop-design.md)); `done`/`blocked`/`budget` → cho dừng.
14. **Việc cần người không chặn cả vòng**: `<XT> loop defer --task <ID> --reason "..."` rồi làm việc khác; mọi việc còn lại
    phụ thuộc → `<XT> loop block --reason "..."`. Nhóm máy chặn / cho chạy / cần người và điểm dừng bắt buộc:
    [`stop-points-and-escalation.md`](stop-points-and-escalation.md). Người xử lý rồi `<XT> loop resume`.
15. **Context đầy** → compaction tự nén (PreCompact ghi checkpoint, SessionStart in lại `loop status`); gần trần máy
    (≥ 80 % vòng/giờ/tiền) → Bàn giao vào PROGRESS, commit + push ([`context-and-token-budget.md`](context-and-token-budget.md)).
16. **Kết thúc**: `done` = mọi task có bằng chứng xanh + `<XT> release-check` không NO-GO (pha build: đặt `delivery_phase:
    harden`, audit delta trước — ADR-0031) → `GO-NO-GO.md` (PR lát cuối), `<XT> loop stats`, `<XT> feedback collect`,
    báo cáo ≤ 20 dòng (đã làm · bằng chứng · D-NNN · còn treo · đề xuất). `done-pending-human` → như `done` + danh sách việc
    chờ người (ID, lý do, cách làm). `blocked`/`budget` → lý do + bước kế tiếp, không khai "xong".

## Lệnh thật

Bảng mọi lệnh con của `scripts/xt.py`: README gốc của repo khung §Công cụ ([`../../README.md`](../../README.md) trong repo khung; dự án đích xem trên GitHub `seeker19110/X-Templates`) và `<XT> --help`.
Trần ngoài xt.py: Claude Code tự ngừng block Stop sau 8 lần liên tiếp không có tool call
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, không đặt `0`); headless thêm `--max-turns`, `--max-budget-usd`.
