---
name: gate
description: Chạy cổng chất lượng trước commit/merge (build · typecheck · lint · test, trong đó lint nên gồm kiểm format; qua dev-task.sh của khung — `.xtemplates/scripts/` ở dự án đích, `scripts/` ở repo khung) và xuất Báo cáo xác thực; có mục ❌ thì KHÔNG commit/merge. Dùng trước khi commit, trước khi mở/merge PR, hoặc khi người dùng gõ /gate, "kiểm tra trước khi commit".
argument-hint: "[commit|merge]"
---

# /gate — cổng máy trước, người sau

`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).

`<DT>` = `.xtemplates/scripts/dev-task.sh` ở dự án đích (ưu tiên, như hook), `scripts/dev-task.sh` ở repo khung. Lệnh thật của dự án nằm ở `xt.yaml` (ưu tiên) → `.claude/project-commands.sh` → tự dò (package.json/pyproject/go.mod/Cargo.toml/Makefile). **Không suy diễn lệnh từ văn xuôi**; nếu `xt.yaml` thiếu khoá, đề xuất thêm.

## Cổng commit
1. `<DT> gate` (build → typecheck → lint → test; `lint` nên gồm kiểm format, format không phải bước riêng; đỏ một cái là dừng). Đọc output thật.
2. Tự review diff: đúng mục tiêu, không sửa nhầm, không console.log/code chết, không bí mật (`git diff --cached | grep -iE "api[_-]?key|secret|password|token"`), input đã validate, nhánh lỗi đã xử lý.
3. Commit message conventional (`feat|fix|refactor|docs|test|chore|perf|ci|build(scope): ...`), ≤ 72 ký tự dòng đầu.

## Cổng merge (thêm)
4. Toàn bộ test xanh (không chỉ test liên quan); nhánh đã cập nhật với nhánh chính; không xung đột.
5. Đối chiếu tiêu chí chấp nhận trong SPEC + mục blueprint liên quan (tick kèm bằng chứng).
6. Nếu đổi schema: migration có phiên bản + đường lùi. Nếu đổi API: hợp đồng + CHANGELOG.
7. Rà bảo mật nhanh: quyền kiểm ở server, không lộ dữ liệu, không nới cấu hình cổng.
8. CI xanh trên head hiện tại; PR làn chuẩn: review (người hoặc `reviewer` model khác) sạch ở head hiện tại (làn nhanh không chờ review — `LOOP-STOP-022`).

## Báo cáo xác thực (xuất nguyên dạng)
```
Build ✅/❌ | Type ✅/❌ (lỗi: ..) | Lint (gồm kiểm format) ✅/❌ (cảnh báo: ..) | Test ✅/❌ (X/Y)
Tự review diff ✅ | Không bí mật/rác ✅ | Tiêu chí chấp nhận ✅ | Blueprint liên quan ✅
Rủi ro/ảnh hưởng: .. | Góp ý: ..
KẾT LUẬN: Sẵn sàng  /  Cần xử lý: [..]
```
Bất kỳ ❌ → sửa, chạy lại toàn bộ, không commit/merge. Không skip/disable test, không hạ ngưỡng coverage/lint để xanh.
