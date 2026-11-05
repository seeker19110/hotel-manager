---
name: gate
description: Chạy cổng chất lượng đầy đủ (build · typecheck · lint · test, lint nên gồm kiểm format; qua dev-task.sh của khung — `.xtemplates/scripts/` ở dự án đích, `scripts/` ở repo khung) trước khi đẩy/mở PR (có CI: `gate-fast`, CI là cổng đầy đủ) và xuất Báo cáo xác thực; có mục ❌ thì KHÔNG đẩy/merge. Cổng commit do hook tự chạy (`gate-fast`). Dùng trước khi đẩy/mở PR, khi người dùng gõ /gate, "kiểm tra trước khi đẩy".
---

# /gate — cổng máy trước, người sau

`<DT>` = `.xtemplates/scripts/dev-task.sh` ở dự án đích (ưu tiên, như hook), `scripts/dev-task.sh` ở repo khung. Lệnh thật của dự án nằm ở `xt.yaml` (ưu tiên) → `.claude/project-commands.sh` → tự dò (package.json/pyproject/go.mod/Cargo.toml/Makefile). **Không suy diễn lệnh từ văn xuôi**; nếu `xt.yaml` thiếu khoá, đề xuất thêm.

## Cổng commit (hook tự chạy — không gọi `/gate` trước mỗi commit)
1. Hook PreToolUse chạy `<DT> gate-fast` (hoặc `gate` theo `commit_gate` trong `xt.yaml`) trước `git commit`; đỏ thì commit không chạy — sửa rồi commit lại.
2. Tự review diff: đúng mục tiêu, không sửa nhầm, không console.log/code chết, không bí mật (`git diff --cached | grep -iE "api[_-]?key|secret|password|token"`), input đã validate, nhánh lỗi đã xử lý.
3. Commit message conventional (`feat|fix|refactor|docs|test|chore|perf|ci|build(scope): ...`), ≤ 100 ký tự dòng đầu.

## Trước khi đẩy/mở PR (`/gate`)
4. Có CI chạy đúng các khoá `xt.yaml` và merge đòi CI xanh: đẩy ngay — mỗi commit đã qua `gate-fast` (format · lint · typecheck · test liên quan file đổi, hook cổng commit); **CI là cổng đầy đủ** (song song, nhanh hơn chạy nối tiếp ở máy; lọt lỗi chỉ tốn một lượt CI — ADR-0056). Không có CI, lần đẩy cuối trước cắt bản, hoặc người dùng gõ `/gate`: `<DT> gate` (build → typecheck → lint → test; đỏ một cái là dừng), đọc output thật. Nhánh cập nhật/xung đột/CI do `xt.py merge-check` quyết sau khi mở PR.
5. Đối chiếu tiêu chí chấp nhận trong SPEC + mục blueprint liên quan (tick kèm bằng chứng).
6. Nếu đổi schema: migration có phiên bản + đường lùi. Nếu đổi API: hợp đồng + CHANGELOG.
7. Rà bảo mật nhanh: quyền kiểm ở server, không lộ dữ liệu, không nới cấu hình cổng.
8. Sau khi mở PR: `xt.py pr next --pr <N>` quyết bước kế (CI, review khi máy đòi — `LOOP-STOP-022`, pha build hoãn review trừ rủi ro cao — ADR-0062).

## Báo cáo xác thực (xuất nguyên dạng khi người dùng gọi `/gate`; trong autopilot chỉ cần exit code)
```
Build ✅/❌ | Type ✅/❌ (lỗi: ..) | Lint (gồm kiểm format) ✅/❌ (cảnh báo: ..) | Test ✅/❌ (X/Y)
Tự review diff ✅ | Không bí mật/rác ✅ | Tiêu chí chấp nhận ✅ | Blueprint liên quan ✅
Rủi ro/ảnh hưởng: .. | Góp ý: ..
KẾT LUẬN: Sẵn sàng  /  Cần xử lý: [..]
```
Bất kỳ ❌ → sửa, chạy lại toàn bộ, không đẩy/merge. Không skip/disable test, không hạ ngưỡng coverage/lint để xanh.
