# Lịch sử PROGRESS.md

> Mục đã xong chuyển khỏi `PROGRESS.md` để giữ trần 8 KB (`xt.py progress-check`).

## Đang làm (đã xong)
- 2026-10-22 đợt 17 (D-093…D-095): luật grype critical gia hạn tới 2026-10-29 (chưa có image vá); 8 MUST D-095 tick lại sau khi import ruleset (2026-10-23), MUST mở 90.
- 2026-10-24 đợt 21 (D-101, D-102): `MessagesProvider` (client context, khoá `common.`) cho hạ tầng client; phần đuôi ngoài `merge_risk_paths` sang `t()`/`tm()`, baseline 1717 → 1552; bundle 278,11 kB. Còn ngoài risk: chỉ `lib/format.ts`.
- 2026-10-24 đợt 22 (D-103…D-105, "hoàn thiện dự án"): XC-I18N-001 ĐẠT (D-103…D-108): 1552 → 0 chuỗi viết thẳng, 3 catalog + 2 catalog con client, 70 tệp ngoại lệ vận hành/migration có lý do + max; PR #131 người merge. MUST mở 89.

## Bài học (cũ)
- Bài học đợt 5–8: Better Auth `/sign-in/email` 20 lần/phút theo IP; `<dialog>` phát `close` sau một task (`onClose` chỉ xoá trạng thái khi hộp thật sự đóng); chạy lại job CI dùng payload sự kiện cũ (cần push mới); test giá trị ngẫu nhiên phải loại ca biên (IP octet 0); không so thời gian tuyệt đối (so tương đối); hai lát song song có thể đụng nhau qua rào mới.
