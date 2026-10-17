---
title: Vòng lặp tự động (autopilot)
kind: index
updated: 2026-10-16
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
| [`context-and-token-budget.md`](context-and-token-budget.md) | Ngân sách context/token, compaction, bàn giao phiên | Khi phiên dài, gần hết ngân sách; khi viết bàn giao |
| [`framework-feedback.md`](framework-feedback.md) | Phản hồi lỗi do khung + cách khắc phục từ dự án đích (`xt.py feedback`), khung kéo về và gộp | Khi sửa xong một lỗi do khung; trước bàn giao/phát hành; khi bảo trì repo khung |

## Giao thức autopilot (AGENTS.md trỏ tới đây)

`<XT>` = `python3 .xtemplates/scripts/xt.py` trong dự án đích (hoặc `python3 scripts/xt.py` trong repo khung). Skill
`/autopilot` (`.claude/skills/autopilot/SKILL.md`) là bản rút gọn của giao thức này.

**Pha 0 — audit khung trước khi làm** (`LOOP-HARNESS-020`)

0. `<XT> doctor --fix` là việc **đầu tiên** của mỗi lần `/autopilot`: kiểm khung đã cài (runtime, hook + file hook + cú pháp,
   skill/subagent, `AGENTS.md`/`CLAUDE.md`, `xt.yaml`, `.gitignore`, state, khung hợp lệ, `PROGRESS.md`) và sửa phần an toàn,
   đảo ngược được. Còn ✗ (hook/settings/khung cài lệch) → báo người lệnh `install.py` một lần — đổi hook là điểm dừng;
   `loop init` cũng chạy phần nhanh của audit và cảnh báo trên stderr khi còn lỗi (không chặn, ADR-0002 fail-open về luồng).

**Pha 1 — lập kế hoạch, không code**

1. **Nhận yêu cầu, đọc repo trước**: dò stack/CI/test từ file thật (`package.json`, `pyproject`, workflow); không hỏi điều đã có trong code.
2. **G0 Frame** → `PROJECT.md`: vấn đề, người dùng, ≥ 1 chỉ số đo được, "không làm".
3. **G1 Classify** → chọn hồ sơ/ngành/quy mô (`<XT> list profiles`, `<XT> list industries`) rồi ghép
   `<XT> compose --profile <p> [--industry <i>] --scale <S|M|L> [--add <module>] --out BLUEPRINT.md`
   (`--add` để ghép module ngoài hồ sơ, vd web app có tính năng LLM thêm `13-ai-engineering/llm-app-foundations`).
4. **G2 Research** → `researcher` xác minh phiên bản/chuẩn/luật từ nguồn sống, ghi ngày; ADR chọn stack.
5. **G3 Specify** → `SPEC-*.md` cho từng tính năng (Given/When/Then + ca biên); spec hở → phiên chính quyết tường minh (`<XT> loop decide`, D-NNN).
   **Mọi điểm quyết định** (cách hiểu spec, công nghệ, thiết kế, bảo mật/pháp lý mơ hồ) đi theo tiêu chí chất lượng cuối ở
   [`stop-points-and-escalation.md`](stop-points-and-escalation.md) — tự duyệt, ghi lại, không chờ người.
6. **G4 Design** → sơ đồ, schema, `API-CONTRACT.md`, `THREAT-MODEL.md` (≥ M).
7. **Viết `docs/autopilot/PLAN.md`** theo [`../templates/PLAN.md`](../templates/PLAN.md): mỗi task một dòng
   `- [ ] \`T-NNN\` <việc> — Gate: \`<lệnh>\`` (regex thật: `TASK_RE`/`GATE_RE` trong xt.py), ≤ 1 ngày/task; 4 con số
   theo [`LOOP-DESIGN-001`](loop-design.md) (trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót); danh sách điểm dừng dự kiến.
8. **MỘT cổng duyệt — phiên chính tự duyệt**: tóm tắt ≤ 30 dòng (MUST/SHOULD của blueprint, stack + phiên bản, task, rủi ro, điểm dừng)
   ghi vào đầu PLAN; soát theo tiêu chí chất lượng cuối, ghi `<XT> loop decide --question "Duyệt PLAN …"`, báo người tóm tắt rồi
   **làm tiếp không chờ** (người can thiệp lúc nào cũng được). Sau đó không hỏi lại trừ điểm dừng bắt buộc về hành động.

**Pha 2 — vòng lặp có bằng chứng**

9. `<XT> loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --single-session [--hours <H>]` → tạo
   `.autopilot/state.json` (gitignore; `max_same_failure: 3`; trần vòng tự tính `max(20, 4 × task chưa làm)`, hoặc
   `--max-iterations <N>`). **Một phiên đến khi xong** (ADR-0009): phiên mở bằng `claude --permission-mode auto`
   (settings dự án không đặt được; Stop hook cảnh báo nếu phiên đang ở chế độ hỏi quyền).
10. **Mỗi vòng**: `<XT> loop status --json` → verdict `continue` kèm task do máy chọn (task `[ ]` đầu tiên chưa `defer`) → làm task → chạy Gate
    **y nguyên** qua `<XT> loop record --task T-NNN -- <lệnh Gate>` (ghi `.autopilot/evidence/T-NNN.json`:
    `exit_code`, `cmd`, `head`, 40 dòng cuối).
11. Exit 0 → tick `[x]` trong PLAN, commit nhỏ (conventional) qua cổng commit, push nhánh làm việc, cập nhật
    `PROGRESS.md` (≤ 8 KB). **Lát xong** (task hoặc nhóm task chạy được) → mở PR của lát (nhánh riêng từ nhánh đích mới
    nhất; phụ thuộc PR chưa merge thì chồng lên nhánh đó — `LOOP-DESIGN-020`, ADR-0014) → ở `merge_autonomy: L3` bật auto-merge ngay
    (`gh pr merge <N> --auto --squash` / MCP `enable_pr_auto_merge`, ADR-0015) trừ PR `merge-check` báo `hard` (ngoại lệ
    cứng, ADR-0016 → `loop defer`); dưới L3 `<XT> merge-check --pr <N>` →
    làm đúng `next` (`merge` = lệnh merge ghim head; `human` = `loop defer`); vòng sau chạy lại `merge-check` cho PR còn
    mở, theo FIFO; PR chồng chỉ merge sau khi đổi đích về nhánh mặc định và merge nhánh đó vào (`LOOP-DESIGN-020`). Exit ≠ 0 → sửa; cùng chữ ký lỗi lần 2 → đổi cách tiếp cận (ghi PROGRESS); lần 3 → máy đặt
    `blocked`. Không skip test, không nới cổng (hook `pre-edit-guard.sh` sẽ hỏi).
12. **Stop hook quyết**: `stop-guard.sh` gọi `<XT> loop hook-stop`; verdict `continue`/`verify` → trả
    `{"decision":"block","reason":"[autopilot vòng i/N] …"}` và tăng `iterations` (agent làm tiếp); `done`/`blocked`/
    `budget` → `active=false`, cho dừng. `verify` nghĩa là có task tick mà thiếu/khác bằng chứng — chạy lại `loop record`;
    đủ bằng chứng mà chưa kiểm lại cuối → chạy `<XT> loop verify` (mọi Gate trên cây hiện tại, `LOOP-DESIGN-022`).
13. **Việc cần người không chặn cả vòng**: `<XT> loop defer --task <T-NNN|ID blueprint> --reason "..."` rồi làm việc
    độc lập khác; hết việc tự làm được → verdict `done-pending-human` (Stop hook cho dừng một lần, gom mọi việc cho người).
    **Điểm dừng bắt buộc về hành động** (thao tác không đảo ngược, tiền thật, dữ liệu người dùng thật, đổi quyền/cấu hình cổng,
    hành động đối ngoại; mâu thuẫn spec **không** còn là điểm dừng — tự quyết, ghi D-NNN): `<XT> loop block --reason "..."` rồi dừng — chỉ khi **mọi** việc còn lại phụ thuộc nó (còn việc khác thì `defer`); hook `pre-bash-guard.sh`/
    `pre-edit-guard.sh` deny/ask là lưới thứ hai. Người đọc lý do, xử lý, rồi `loop resume --reason "..."` để tiếp (giữ số vòng và bằng chứng; `loop init` lại chỉ khi đổi PLAN/ngân sách).
14. **Context đầy** → compaction tự nén, không bàn giao: hook PreCompact ghi checkpoint (`<XT> loop checkpoint`), SessionStart(compact) in lại
    `loop status` (task đang làm, lệnh kiểm cuối, file chưa commit, việc chờ người). **Gần hết trần máy** (≥ 80% vòng/giờ/tiền):
    ghi "Bàn giao phiên" vào PROGRESS (chỗ dở, bước kế tiếp, SHA), commit + push, để Stop hook kết thúc (`/handover`).
15. **Kết thúc**: `done` = mọi task có bằng chứng xanh và `<XT> blueprint-status BLUEPRINT.md --strict` (cổng phát hành G7) không còn MUST mở
    → `GO-NO-GO.md` (PR của lát cuối; PR đã merge, PR `merge-check` = `human` liệt kê chờ người), báo cáo ≤ 20 dòng (đã làm · bằng chứng · quyết định tự duyệt D-NNN · còn treo · đề xuất). `done-pending-human` → báo cáo như `done` + danh sách việc chờ người (ID, lý do, cách làm),
    người xử lý rồi `loop resume`. `blocked`/`budget` → báo lý do + bước kế tiếp, không khai "xong".

## Lệnh thật (`scripts/xt.py`)

| Lệnh | Làm gì |
|---|---|
| `doctor [--fix] [--json]` | Audit khung đã cài trước autopilot; `--fix` sửa phần an toàn (không đụng hook/settings); exit 1 khi còn lỗi ✗ |
| `loop init --plan P [--blueprint B] [--max-iterations N] [--hours H] [--single-session]` | Tạo `.autopilot/state.json`, bật vòng; `--single-session`: trần vòng `max(20, 4 × task chưa làm)` (mặc định 50) |
| `loop status [--json]` | Verdict: `inactive` · `continue` · `verify` · `blocked` · `budget` · `done` · `done-pending-human`; kèm chế độ, việc chờ người, cảnh báo quyền, checkpoint |
| `loop defer --task ID --reason "..."` | Việc cần người (T-NNN hoặc ID blueprint): bỏ qua, làm việc khác; `loop resume` đưa lại hàng làm |
| `loop checkpoint` | Dùng bởi PreCompact hook: ghi vị trí làm việc vào state; luôn exit 0 (exit 2 sẽ chặn nén) |
| `loop record --task T-NNN -- <lệnh>` | Chạy lệnh (timeout `XT_RECORD_TIMEOUT`, mặc định 1800 s), ghi evidence, cập nhật chữ ký lỗi |
| `loop block --reason "..."` | Đặt `blocked=true` (điểm dừng bắt buộc về hành động) |
| `loop decide --question Q --option A --option B --choice N --why W --revert R [--prod P] [--log F]` | Phiên chính tự duyệt điểm quyết định: ghi `D-NNN` vào `docs/autopilot/DECISIONS.md` (≥ 2 phương án, lý do, đường lùi); không đổi state |
| `loop resume [--reason "..."]` | Sau khi người xử lý `blocked`/`done-pending-human`: bỏ chặn, đưa việc `defer` lại hàng làm, giữ số vòng và bằng chứng, đặt lại đếm lỗi lặp (`loop init` lại chỉ khi đổi PLAN/ngân sách) |
| `loop stop` | Tắt vòng (`active=false`) |
| `merge-check [--pr N] [--json]` | Quyết thời điểm merge PR đã mở (ADR-0013/0014): `merge` · `wait` · `update` · `fix` · `human` · `closed` kèm `next`; exit 0 chỉ khi `merge` |
| `loop hook-stop` | Dùng bởi Stop hook; đọc stdin JSON (ghi `permission_mode`, cảnh báo chế độ hỏi quyền), quyết block/cho dừng; fail-open khi lỗi |
| `progress-check [file]` | Kiểm `PROGRESS.md`: ≤ 8192 byte, 4 mục, SHA ở Bàn giao là tổ tiên HEAD và của nhánh chính (luật: [`LOOP-HARNESS-004`/`005`](harness-files.md)) |
| `ci-check [dir]` | Fitness function cho workflow GitHub Actions (`permissions`, ghim SHA, `timeout-minutes`, không `continue-on-error`, không secret ngoài `GITHUB_TOKEN` trong job chạy trên `pull_request`) |
| `audit plan [--blueprint B] [--status S] [--json]` | Lập kế hoạch audit 13 nhóm từ blueprint + `docs/ops/AUDIT-STATUS.md` (skill `/audit`) |
| `feedback add/collect/list/aggregate` | Phản hồi về khung (`docs/xtemplates-feedback/FB-NNN.md`) — luật ở [`framework-feedback.md`](framework-feedback.md) |
| `audit check [--strict] <AUDIT-STATUS.md>` | Kiểm sổ audit; `--strict` = 0 🔴/🟠 mở, mọi nhóm đã quét/N/A |

Trần ngoài xt.py: Claude Code tự ngừng block Stop sau 8 lần liên tiếp không có tool call
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, không đặt `0`); headless thêm `--max-turns`, `--max-budget-usd`.
