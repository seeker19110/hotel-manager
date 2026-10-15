---
title: Vòng lặp tự động (autopilot)
kind: index
updated: 2026-10-14
---

# 11 — Vòng lặp tự động (autopilot)

> Mảng này mô tả cách một agent **chạy tự động đến khi xong mà vẫn dừng đúng chỗ**: lập kế hoạch một lần, MỘT cổng
> duyệt, rồi vòng lặp mà mỗi vòng kết thúc bằng **bằng chứng máy** (`xt.py loop record`) và Stop hook đọc bằng chứng
> đó để quyết cho dừng hay làm tiếp. Mọi lệnh ở đây là lệnh thật trong `scripts/xt.py` và harness `.claude/`; hệ
> agentic **làm sản phẩm** (đa agent chạy runtime) ở [`../13-ai-engineering/agentic-systems.md`](../13-ai-engineering/agentic-systems.md).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`loop-design.md`](loop-design.md) | Thiết kế vòng lặp: 4 con số, tiêu chí dừng máy kiểm, bằng chứng | Trước khi bật autopilot lần đầu; khi chọn tầng vòng lặp (hook/`/loop`/headless) |
| [`harness-files.md`](harness-files.md) | File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state | Khi viết PLAN.md, PROGRESS.md; khi hỏi "file nào commit, file nào không" |
| [`stop-points-and-escalation.md`](stop-points-and-escalation.md) | Điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang | Khi quyết hành động nào agent được tự làm; khi cấu hình allow/ask/deny |
| [`orchestration-and-subagents.md`](orchestration-and-subagents.md) | Điều phối: subagent, worktree, song song, không lồng | Khi tách việc cho `researcher`/`executor`/`reviewer`; khi muốn chạy song song |
| [`self-healing-ci.md`](self-healing-ci.md) | Agent tự sửa CI/review: giới hạn, cấm, bằng chứng | Khi CI đỏ trong autopilot; khi cấu hình workflow có agent là tác giả |
| [`context-and-token-budget.md`](context-and-token-budget.md) | Ngân sách context/token, compaction, bàn giao phiên | Khi phiên dài, gần hết ngân sách; khi viết bàn giao |

## Giao thức autopilot (AGENTS.md trỏ tới đây)

`<XT>` = `python3 .xtemplates/scripts/xt.py` trong dự án đích (hoặc `python3 scripts/xt.py` trong repo khung). Skill
`/autopilot` (`.claude/skills/autopilot/SKILL.md`) là bản rút gọn của giao thức này.

**Pha 1 — lập kế hoạch, không code**

1. **Nhận yêu cầu, đọc repo trước**: dò stack/CI/test từ file thật (`package.json`, `pyproject`, workflow); không hỏi điều đã có trong code.
2. **G0 Frame** → `PROJECT.md`: vấn đề, người dùng, ≥ 1 chỉ số đo được, "không làm".
3. **G1 Classify** → chọn hồ sơ/ngành/quy mô (`<XT> list profiles`, `<XT> list industries`) rồi ghép
   `<XT> compose --profile <p> [--industry <i>] --scale <S|M|L> [--add <module>] --out BLUEPRINT.md`
   (`--add` để ghép module ngoài hồ sơ, vd web app có tính năng LLM thêm `13-ai-engineering/llm-app-foundations`).
4. **G2 Research** → `researcher` xác minh phiên bản/chuẩn/luật từ nguồn sống, ghi ngày; ADR chọn stack.
5. **G3 Specify** → `SPEC-*.md` cho từng tính năng (Given/When/Then + ca biên); spec hở → dừng hỏi.
6. **G4 Design** → sơ đồ, schema, `API-CONTRACT.md`, `THREAT-MODEL.md` (≥ M).
7. **Viết `docs/autopilot/PLAN.md`** theo [`../templates/PLAN.md`](../templates/PLAN.md): mỗi task một dòng
   `- [ ] \`T-NNN\` <việc> — Gate: \`<lệnh>\`` (regex thật: `TASK_RE`/`GATE_RE` trong xt.py), ≤ 1 ngày/task; 4 con số
   theo [`LOOP-DESIGN-001`](loop-design.md) (trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót); danh sách điểm dừng dự kiến.
8. **MỘT cổng duyệt**: tóm tắt ≤ 30 dòng (MUST/SHOULD của blueprint, stack + phiên bản, task, rủi ro, điểm dừng) → chờ người. Sau duyệt không hỏi lại trừ điểm dừng bắt buộc.

**Pha 2 — vòng lặp có bằng chứng**

9. `<XT> loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --max-iterations <N> --hours <H>` → tạo
   `.autopilot/state.json` (gitignore; `max_same_failure: 3`).
10. **Mỗi vòng**: `<XT> loop status --json` → verdict `continue` kèm task đầu tiên còn `[ ]` → làm task → chạy Gate
    **y nguyên** qua `<XT> loop record --task T-NNN -- <lệnh Gate>` (ghi `.autopilot/evidence/T-NNN.json`:
    `exit_code`, `cmd`, `head`, 40 dòng cuối).
11. Exit 0 → tick `[x]` trong PLAN, commit nhỏ (conventional) qua cổng commit, push nhánh làm việc, cập nhật
    `PROGRESS.md` (≤ 8 KB). Exit ≠ 0 → sửa; cùng chữ ký lỗi lần 2 → đổi cách tiếp cận (ghi PROGRESS); lần 3 → máy đặt
    `blocked`. Không skip test, không nới cổng (hook `pre-edit-guard.sh` sẽ hỏi).
12. **Stop hook quyết**: `stop-guard.sh` gọi `<XT> loop hook-stop`; verdict `continue`/`verify` → trả
    `{"decision":"block","reason":"[autopilot vòng i/N] …"}` và tăng `iterations` (agent làm tiếp); `done`/`blocked`/
    `budget` → `active=false`, cho dừng. `verify` nghĩa là có task tick mà thiếu/khác bằng chứng — chạy lại `loop record`.
13. **Điểm dừng bắt buộc** (thao tác không đảo ngược, tiền thật, dữ liệu người dùng thật, đổi quyền/cấu hình cổng,
    hành động đối ngoại, mâu thuẫn spec): `<XT> loop block --reason "..."` rồi dừng; hook `pre-bash-guard.sh`/
    `pre-edit-guard.sh` deny/ask là lưới thứ hai. Người đọc lý do, xử lý, rồi `loop resume --reason "..."` để tiếp (giữ số vòng và bằng chứng; `loop init` lại chỉ khi đổi PLAN/ngân sách).
14. **Gần hết ngân sách** (≥ 80% vòng/giờ hoặc context lớn): ghi mục "Bàn giao phiên" vào PROGRESS (chỗ dở, bước kế tiếp, SHA), commit + push, để Stop hook kết thúc (`/handover`).
15. **Kết thúc**: `done` = mọi task có bằng chứng xanh và `<XT> blueprint-status BLUEPRINT.md --strict` (cổng phát hành G7) không còn MUST mở
    → `GO-NO-GO.md`, PR cuối, báo cáo ≤ 20 dòng (đã làm · bằng chứng · còn treo · đề xuất). `blocked`/`budget` → báo lý do + bước kế tiếp, không khai "xong".

## Lệnh thật (`scripts/xt.py`)

| Lệnh | Làm gì |
|---|---|
| `loop init --plan P [--blueprint B] [--max-iterations 50] [--hours H]` | Tạo `.autopilot/state.json`, bật vòng |
| `loop status [--json]` | Verdict: `inactive` · `continue` · `verify` · `blocked` · `budget` · `done` |
| `loop record --task T-NNN -- <lệnh>` | Chạy lệnh (timeout `XT_RECORD_TIMEOUT`, mặc định 1800 s), ghi evidence, cập nhật chữ ký lỗi |
| `loop block --reason "..."` | Đặt `blocked=true` (điểm dừng bắt buộc) |
| `loop resume [--reason "..."]` | Sau khi người xử lý lý do `blocked`: bỏ chặn, giữ số vòng và bằng chứng, đặt lại đếm lỗi lặp (`loop init` lại chỉ khi đổi PLAN/ngân sách) |
| `loop stop` | Tắt vòng (`active=false`) |
| `loop hook-stop` | Dùng bởi Stop hook; đọc stdin JSON, quyết block/cho dừng; fail-open khi lỗi |
| `progress-check [file]` | Kiểm `PROGRESS.md`: ≤ 8192 byte, 4 mục, SHA ở Bàn giao là tổ tiên HEAD và của nhánh chính (luật: [`LOOP-HARNESS-004`/`005`](harness-files.md)) |
| `ci-check [dir]` | Fitness function cho workflow GitHub Actions (`permissions`, ghim SHA, `timeout-minutes`, không `continue-on-error`) |
| `audit plan [--blueprint B] [--status S] [--json]` | Lập kế hoạch audit 13 nhóm từ blueprint + `docs/ops/AUDIT-STATUS.md` (skill `/audit`) |
| `audit check [--strict] <AUDIT-STATUS.md>` | Kiểm sổ audit; `--strict` = 0 🔴/🟠 mở, mọi nhóm đã quét/N/A |

Trần ngoài xt.py: Claude Code tự ngừng block Stop sau 8 lần liên tiếp không có tool call
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, không đặt `0`); headless thêm `--max-turns`, `--max-budget-usd`.
