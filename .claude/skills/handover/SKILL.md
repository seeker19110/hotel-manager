---
name: handover
description: Bàn giao phiên khi gần hết trần vòng/giờ/tiền hoặc kết thúc ngày (autopilot một phiên không bàn giao vì context — compaction có checkpoint, ADR-0009) — cập nhật PROGRESS.md (≤ 8 KB, 4 mục), commit + push, để phiên sau chỉ cần nhắn "tiếp tục". Dùng khi người dùng nói "bàn giao", "dừng ở đây", "wind-down", hoặc gõ /handover.
---

# /handover — để phiên sau tiếp tục đúng chỗ

`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).

1. Hoàn tất việc đang dở ở **điểm an toàn gần nhất** (test xanh hoặc WIP rõ ràng) — không để file nửa chừng phá build; nếu bắt buộc, ghi rõ.
2. Cập nhật `PROGRESS.md` (mẫu `<FW>/templates/PROGRESS.md`), **≤ 8 KB**, đúng 4 mục:
   - **Đang làm:** task hiện tại, đã tới đâu, file nào đang sửa.
   - **Tiếp theo:** 1–5 bước kế tiếp cụ thể (lệnh/ file / tiêu chí xong).
   - **Quyết định:** quyết định mới trong phiên (trỏ ADR nếu lớn); giả định đang dùng.
   - **Bàn giao phiên:** ngày, SHA commit cuối **đã có trên nhánh chính** (squash-merge xoá SHA của nhánh PR; `xt.py progress-check` chặn), nhánh, trạng thái autopilot (`xt.py loop status`), điều cần người quyết.
3. Lịch sử dài → chuyển sang `CHANGELOG.md`/`docs/`, không giữ trong PROGRESS.
3b. Dự án đích: `<XT> feedback collect` (gom MUST bị miễn, lý do autopilot bị chặn); lỗi do khung đã sửa trong phiên mà chưa ghi → `<XT> feedback add …` (`<FW>/11-autonomous-loop/framework-feedback.md`, không dữ liệu/mã dự án).
4. `/gate` → commit `chore(progress): bàn giao <ngày>` → push nhánh làm việc. Nếu đang autopilot: để Stop hook kết thúc theo verdict máy, không tự khai done.
5. Trả lời người dùng ≤ 10 dòng: đã xong gì, dở ở đâu, câu hỏi cần họ quyết (nếu có).
