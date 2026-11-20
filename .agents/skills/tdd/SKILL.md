---
name: tdd
description: Phát triển hướng test theo lát dọc — viết một test hành vi, XEM nó đỏ vì đúng lý do, viết code tối thiểu cho xanh, refactor khi xanh; lặp từng hành vi. Dùng khi làm logic nghiệp vụ, parser, tính tiền/quyền, API mới, sửa bug có thể tái hiện bằng test, khi task có Given/When/Then, khi người dùng nói "viết test trước", "TDD", hoặc gõ /tdd.
argument-hint: "<task T-NNN | hành vi cần làm>"
---

# /tdd — đỏ thật, xanh tối thiểu, refactor khi xanh

`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. Mục kiểm thử: `<FW>/14-testing-quality/` (biên `QA-UNIT-001…006`,
mutation `QA-COV-005/006`, không nới coverage `QA-COV-008`). Lệnh test thật ở `xt.yaml`; không suy diễn.

## Vòng cho mỗi hành vi (một lát dọc: một đường đi xuyên các tầng, không làm cả tầng một lúc)
1. **Chọn hành vi kế tiếp** từ Given/When/Then của task, nhỏ nhất còn có giá trị cho người dùng. Ghi một dòng.
2. **Đỏ:** viết một test gọi code như người dùng của nó gọi (API công khai, không hàm nội bộ) và kiểm kết quả họ thấy.
   Chạy, **đọc thông báo đỏ**: phải đỏ vì thiếu hành vi, không vì lỗi cú pháp/import/fixture. Test xanh ngay = test sai hoặc hành vi đã có.
3. **Xanh:** viết code ít nhất để test xanh. Không thêm nhánh/tuỳ chọn chưa có test đòi.
4. **Refactor** khi mọi test xanh: bỏ trùng lặp, đặt tên, tách hàm; chạy lại test sau mỗi bước. Không đổi hành vi trong bước này.
5. Thêm ca biên theo `QA-UNIT-001…006` (rỗng, một phần tử, null vs 0, off-by-one, tiền không float, chia 0, UTC) — mỗi ca một vòng đỏ → xanh.

## Luật
- Test phải **fail được**: nếu xoá thân hàm mà test vẫn xanh, test vô dụng — viết lại. Vùng tiền/quyền/parser: chạy mutation (`QA-COV-005`).
- Code viết trước khi có test đỏ cho nó: bỏ đi và đi lại vòng, không "test sau cho có".
- Test tất định: đồng hồ giả, seed cố định, không mạng thật (`BASE-GATE-005`).
- Mock chỉ ở ranh giới hệ thống (mạng, thời gian, dịch vụ ngoài); logic trong cùng repo chạy thật.
- Không tick task khi chưa `xt.py loop record` với lệnh test xanh (`LOOP-ORCH-004`).

## Kết thúc
Báo cáo: danh sách hành vi đã phủ · lệnh test + exit code · ca biên đã thêm · phần cố ý chưa phủ và lý do.
