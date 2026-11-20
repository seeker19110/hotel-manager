---
name: debug
description: Gỡ lỗi có hệ thống — chưa có lệnh tái hiện ĐỎ thì chưa sửa; lập 3–5 giả thuyết bác bỏ được, khoanh vùng (bisect, log, nhị phân hoá đầu vào) tới nguyên nhân gốc, sửa kèm test hồi quy, 3 lần sửa hỏng thì xem lại thiết kế. Dùng khi test/CI đỏ không rõ vì sao, bug người dùng báo, lỗi chập chờn, hồi quy sau một commit, "sao cái này hỏng", "fix bug", hoặc gõ /debug.
argument-hint: "<mô tả lỗi | lệnh đang đỏ | link issue>"
---

# /debug — nguyên nhân gốc trước, bản sửa sau

`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. Chữ ký lỗi lặp 3 lần → `xt.py loop defer` theo
`<FW>/11-autonomous-loop/self-healing-ci.md`; không vá cho xanh (`LOOP-CI-001`: không skip/disable test, không hạ ngưỡng).

## Pha 1 — Tái hiện (cổng: có lệnh ĐỎ)
1. Viết **một lệnh** cho ra lỗi trên máy (test mới, script nhỏ, `curl`, lệnh CI chép về). Chạy, ghi exit code và dòng lỗi.
2. Lỗi chập chờn: chạy ≥ 10 lần (`for i in $(seq 10)`), ghi tỉ lệ; khoá nguồn bất định (thời gian, seed, thứ tự, mạng) trước khi đoán.
3. **Chưa có lệnh đỏ thì không sang pha 2.** Không tái hiện được sau khi thử hết → ghi điều đã thử, `loop defer` kèm lệnh và log.

## Pha 2 — Khoanh vùng
4. Đọc lỗi đầy đủ (stack, log liền trước) và diff gần nhất chạm vùng đó (`git log -p -- <file>`).
5. Lập **3–5 giả thuyết bác bỏ được**, mỗi cái kèm một phép thử rẻ cho kết quả khác nhau nếu giả thuyết sai.
6. Thử rẻ trước: hồi quy → `git bisect start <bad> <good> && git bisect run <lệnh đỏ>` (lệnh thoát 125 = bỏ qua commit); dữ liệu → thu nhỏ đầu vào tới ca nhỏ nhất còn đỏ; tích hợp → gọi thẳng từng tầng.
   Thêm log tạm có tiền tố `DEBUG:` một dòng, xoá trước commit.
7. Ghi giả thuyết đã loại và bằng chứng; dừng khi **một** giả thuyết giải thích hết triệu chứng (kể cả vì sao trước đây không lỗi).

## Pha 3 — Sửa
8. Lệnh đỏ ở pha 1 thành **test hồi quy** ở tầng thấp nhất bắt được lỗi (`FE-TEST-006` cho UI); xem nó đỏ vì đúng lý do.
9. Sửa **nguyên nhân gốc**, không chặn triệu chứng (try/except nuốt lỗi, `if x is None: return` không lý do, tăng timeout). Diff nhỏ nhất.
10. Chạy lại lệnh pha 1, test hồi quy, rồi cổng (`/gate`); tìm cùng mẫu lỗi chỗ khác (`grep`) và sửa hoặc ghi task.
11. **Ba lần sửa không xanh** → dừng vá: giả định kiến trúc sai; ghi `xt.py loop decide` (≥ 2 phương án) hoặc giao `executor-deep`.

## Ghi lại
Commit `fix(<scope>): …` nêu nguyên nhân gốc một câu. Báo cáo: lệnh tái hiện · giả thuyết đã loại · nguyên nhân · test hồi quy ·
exit code trước/sau. Lỗi do môi trường/công cụ → thêm dòng `TRAPS.md`.
