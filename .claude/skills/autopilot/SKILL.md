---
name: autopilot
description: Chạy tự động từ yêu cầu đến khi hoàn thành theo khung X-Templates — lập kế hoạch (G0–G4), MỘT cổng duyệt do phiên chính tự duyệt theo tiêu chí chất lượng cuối, rồi vòng lặp có bằng chứng máy (xt.py loop) chạy trong MỘT phiên tới khi done/done-pending-human/blocked/budget. Dùng khi người dùng mô tả dự án mới, muốn "làm tự động đến khi xong", hoặc gõ /autopilot.
argument-hint: "[mô tả yêu cầu hoặc đường dẫn PROJECT.md]"
---

# /autopilot — tự động đến khi hoàn thành, dừng đúng chỗ

Đọc trước: `AGENTS.md` (gốc dự án) và `<FW>/11-autonomous-loop/README.md` (giao thức đầy đủ).
`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).

**Mục tiêu: xong trong MỘT phiên** (ADR-0009) — không bàn giao vì context, việc cần người không chặn cả vòng.

## Bước 0 — Audit khung + sửa, rồi kiểm điều kiện chạy một phiên

- **Việc đầu tiên, trước mọi việc khác**: `<XT> doctor --fix` (audit khung đã cài: Python/git/bash, hook trong `.claude/settings.json` + file hook và file chúng nạp + cú pháp, skill/subagent, `*.xtemplates-new` chưa gộp, `AGENTS.md`/`CLAUDE.md` có `@AGENTS.md`, `xt.yaml` đủ khoá, `.autopilot/` trong `.gitignore`, state hỏng/BLOCKED, khung `validate` xanh, `PROGRESS.md`). `--fix` chỉ sửa phần an toàn, đảo ngược được (tạo file thiếu từ mẫu, thêm dòng `@AGENTS.md`/`.gitignore`, đổi tên tệp lệnh của bản ≤ 2.x sang `xt.yaml`, chuyển state hỏng sang bản sao lưu) — **không** đụng hook/settings.
  - Exit 0 → làm tiếp; cảnh báo ⚠ là việc của phiên (vd `xt.yaml` trống → task đầu PLAN điền lệnh thật theo stack; PROGRESS sai luật → sửa tay).
  - Exit 1 → lỗi ✗ còn lại cần người (thiếu/hỏng hook, settings, khung cài lệch): báo người **một lần** lệnh sửa (`install.py`, gộp `*.xtemplates-new`) — đổi hook là điểm dừng, không tự sửa; vẫn làm Pha 1. Trước `loop init` chạy lại `<XT> doctor`; còn ✗ về hook → `loop init` vẫn chạy (cảnh báo trên stderr) nhưng ghi rõ trong báo cáo cuối rằng vòng thiếu máy kiểm, và gom vào việc chờ người.
- **Chế độ quyền**: phiên phải chạy không hỏi quyền — `claude --permission-mode auto` (container dùng một lần: `bypassPermissions`; headless: `dontAsk`). Settings dự án không đặt được. Đang ở chế độ hỏi (`default`/`plan`/`acceptEdits`) thì báo người một lần câu lệnh mở lại phiên, rồi vẫn làm; Stop hook nhắc lại mỗi vòng (`permission_mode` ghi ở `.autopilot/state.json`).
- **Hook**: `.claude/settings.json` có `PreCompact` (checkpoint trước nén), `SessionStart`, `Stop`. Thiếu → báo người chạy lại `install.py` (đổi hook là điểm dừng).

## Pha 1 — Lập kế hoạch (G0–G4), KHÔNG code

1. **Đọc repo trước, hỏi sau.** Dự án có sẵn: tự dò stack/CI/test từ file thật; không hỏi điều đã có trong code.
2. **G0 Frame** → viết/cập nhật `PROJECT.md` (mẫu `<FW>/templates/PROJECT.md`): vấn đề, người dùng, ≥1 chỉ số đo được, phạm vi "không làm".
3. **G1 Classify** → chọn hồ sơ (`<XT> list profiles`), gói ngành (`<XT> list industries`), quy mô S/M/L (bảng ở `<FW>/00-method/composition.md`), rồi
   `<XT> compose --profile <p> [--industry <i>] --scale <S|M|L> [--add <module>] --out BLUEPRINT.md`.
4. **G2 Research** → giao subagent `researcher` xác minh phiên bản/chuẩn/luật từ nguồn sống (ghi ngày); viết ADR chọn stack (mẫu `<FW>/templates/ADR.md`).
5. **G3 Specify** → `SPEC-<tính-năng>.md` cho từng tính năng MVP: Given/When/Then + ca biên. Spec hở → **quyết tường minh**, không lấp ngầm (bước 5b).
5b. **Mọi điểm quyết định** (cách hiểu spec, công nghệ, thiết kế, phạm vi, bảo mật/pháp lý mơ hồ): phiên chính tự duyệt theo tiêu chí chất lượng cuối — (1) đúng và an toàn, cách hiểu chặt hơn · (2) giữ đường lùi · (3) bền lâu, đơn giản, theo chuẩn · (4) trải nghiệm cuối · (5) tốc độ/chi phí chỉ phá hoà. **Mặc định tự host** khi phương án cần tài khoản/khoá/thông tin chỉ chủ dự án có. Ghi `<XT> loop decide --question … --option … --option … --choice N --why … --revert … [--prod "<dịch vụ khi chạy thật>"]` rồi làm tiếp; không hỏi, không block. Chi tiết: `<FW>/11-autonomous-loop/stop-points-and-escalation.md`.
6. **G4 Design** → sơ đồ C4 mức 1–2, schema, `API-CONTRACT.md`, `THREAT-MODEL.md` (mức ≥ M).
7. **PLAN.md** (mẫu `<FW>/templates/PLAN.md`): task `T-001…` ≤ 1 ngày/task, mỗi task một **Gate** là lệnh máy kiểm; 4 con số theo `<FW>/11-autonomous-loop/loop-design.md` (`LOOP-DESIGN-001`: trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót); danh sách **điểm dừng bắt buộc**.
8. **MỘT cổng duyệt — phiên chính tự duyệt**: tóm tắt ≤ 30 dòng (blueprint: số MUST/SHOULD; stack + phiên bản; task; rủi ro; điểm dừng) ghi đầu PLAN, soát theo tiêu chí chất lượng cuối, ghi `<XT> loop decide --question "Duyệt PLAN …"`, báo người tóm tắt rồi **làm tiếp không chờ** (người can thiệp lúc nào cũng được). **Sau đó không hỏi lại trừ điểm dừng bắt buộc về hành động.**

## Pha 2 — Vòng lặp có bằng chứng (G5–G7)

9. `<XT> loop init --plan docs/autopilot/PLAN.md --blueprint BLUEPRINT.md --single-session [--hours <H>]` (trần vòng tự tính `max(20, 4 × task chưa làm)`; ghi đè bằng `--max-iterations`).
10. Mỗi vòng: `<XT> loop status` → làm đúng task mà `loop status` trả về (task `[ ]` đầu tiên chưa `defer`) → chạy Gate qua `<XT> loop record --task T-xxx -- <lệnh Gate y nguyên>` → xanh thì tick `[x]` trong PLAN, commit (`feat/fix/...: ...`, nhỏ, qua cổng commit) + push nhánh làm việc → cập nhật `PROGRESS.md` (≤ 8 KB). **Lát xong → một PR, mở xong bật auto-merge ngay khi `merge_autonomy: L3`** (`gh pr merge <N> --auto --squash` hoặc MCP `enable_pr_auto_merge`; ADR-0015; `merge-check` có `hard` — tiền/dữ liệu thật/auth/mật mã/bí mật — thì không bật, `loop defer` cho người merge, ADR-0016) (nhánh riêng từ nhánh đích mới nhất, chồng lên nhánh của PR chưa merge nếu phụ thuộc; `LOOP-DESIGN-020`, ADR-0014) rồi `merge-check` như bước 13; không dồn "PR cuối". PR chồng: PR đáy merge xong → đổi đích về nhánh mặc định, `git merge origin/<mặc định>` vào nhánh chồng, push, chạy lại `merge-check` (`wait` khi còn nhắm nhánh khác).
11. Gate đỏ: sửa; cùng một lỗi **lần 2 → đổi cách tiếp cận** (ghi vào PROGRESS), **lần 3 → máy tự BLOCKED** (dừng để người xem). Không skip/disable test, không nới cấu hình cổng để xanh (hook sẽ hỏi).
12. Blueprint: tick `[x]` **chỉ khi có bằng chứng** (CI/test/scan/file) ghi ở PR; mục không áp dụng → `[~] — Không áp dụng: <điều kiện>`; mục có áp dụng mà muốn bỏ/hoãn → `loop defer` để người quyết (MUST `Miễn` cần `Duyệt: "<lời chủ dự án>" <ngày>` — không tự viết "chủ dự án duyệt", `LOOP-STOP-024`). Mọi task xanh → `<XT> loop verify` (chạy lại mọi Gate trên cây cuối; Stop hook đòi trước khi cho dừng, `LOOP-DESIGN-022`).
13. Giao việc: `executor` cho task rõ phạm vi; `reviewer` (model khác) review diff trước khi merge PR; PR đã mở → `<XT> merge-check --pr <N>` quyết thời điểm merge và làm đúng `next` (`merge` → chạy y nguyên lệnh có `--match-head-commit`, phiên chặn GraphQL thì `next_rest` (`gh api -X PUT repos/{owner}/{repo}/pulls/<N>/merge -f sha=<head> -f merge_method=squash`) hoặc tool MCP `merge_pull_request` với `expectedHeadSha` — dưới L3 không bật auto-merge của GitHub; `wait` → làm task khác rồi kiểm lại mỗi vòng; `update`/`fix` → làm; `human` → `loop defer` + ghi vào báo cáo, không tự merge — `LOOP-STOP-022`); phiên chính điều phối, **subagent không lồng subagent**.
14. **Điểm dừng bắt buộc về hành động** — mặc định **không chặn cả vòng**: `<XT> loop defer --task <T-NNN|ID blueprint> --reason "<cần người làm gì>"` rồi làm việc khác; chỉ `<XT> loop block --reason "..."` khi mọi việc còn lại phụ thuộc nó. Người xử lý xong chạy `<XT> loop resume --reason "..."`. Gồm: thao tác không đảo ngược (xoá dữ liệu, drop/alter phá vỡ), tiền thật/thanh toán, dữ liệu người dùng thật, publish/deploy production/gửi email-thông báo ra ngoài, đăng ký dịch vụ trả phí/nhập khoá thật, đổi quyền hoặc cấu hình cổng. Mâu thuẫn spec, bảo mật/pháp lý mơ hồ **không** dừng — tự quyết theo bước 5b.
15. **Context đầy → không bàn giao**: để compaction tự nén; PreCompact ghi checkpoint, sau nén SessionStart in lại `loop status` (task đang làm, lệnh kiểm cuối, file chưa commit) — đọc rồi làm tiếp. Chỉ khi gần **trần máy** (≥ 80% vòng/giờ/tiền): ghi **Bàn giao phiên** vào PROGRESS.md (việc dở, bước kế tiếp, SHA), commit + push, để Stop hook kết thúc.

## Kết thúc

- `done`: mọi task có bằng chứng xanh + `<XT> blueprint-status BLUEPRINT.md --strict` = 0 MUST mở → viết `GO-NO-GO.md` (PR của lát cuối; PR đã merge, PR `merge-check` = `human` — làn chuẩn dưới L3, ngoại lệ cứng ở mọi mức — liệt kê chờ người), báo cáo ≤ 20 dòng (đã làm / bằng chứng / quyết định tự duyệt D-NNN + đề xuất "Khi chạy thật" / còn treo / đề xuất).
- Trước báo cáo cuối (mọi kết cục): `<XT> feedback collect`; lỗi do khung đã sửa trong phiên → `<XT> feedback add` (`<FW>/11-autonomous-loop/framework-feedback.md`).
- `done-pending-human`: như `done` cho phần tự làm được, kèm **danh sách việc chờ người** (ID, lý do, cách làm từng bước) — người làm một lần rồi `<XT> loop resume`.
- `blocked`/`budget`: báo rõ lý do + bước kế tiếp; không tự khai "xong".
- Không bao giờ: force-push, rewrite history nhánh người khác, empty commit để kích CI, merge khi CI đỏ.
