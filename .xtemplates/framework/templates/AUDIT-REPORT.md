---
title: Mẫu AUDIT-REPORT
kind: template
updated: 2026-10-14
---

# Mẫu AUDIT-REPORT.md — báo cáo một lần audit

> **Ai viết:** phiên chạy `/audit`, sau khi quét xong và **trước** khi sửa. **Giai đoạn:** G0 brownfield, G7, định kỳ.
> **Cổng dùng:** người duyệt kế hoạch sửa ở §5 (skill `/audit` bước dừng chờ duyệt); sổ máy đọc là
> [`AUDIT-STATUS.md`](AUDIT-STATUS.md). Phương pháp: [`../00-method/audit.md`](../00-method/audit.md).
> **Luật:** mỗi phát hiện ở đây trùng ID với `AUDIT-STATUS.md`; 🔴/🟠 có đường tái hiện từng bước và đã qua xác minh đối kháng;
> không liệt kê "best practice" chung chung không trỏ được file:dòng hay lệnh.

```markdown
# AUDIT-REPORT — <Tên dự án> · <YYYY-MM-DD>

> Commit: `<SHA>` · Phạm vi: <toàn bộ | nhóm …> · Người quét: <tên/agent> · Xác minh đối kháng: <reviewer/model>
> `xt.py audit check docs/ops/AUDIT-STATUS.md` → exit <0/1>

## 1. Tóm tắt
| Mức | Mở | Đã sửa | Chấp nhận | Bác bỏ |
|---|---|---|---|---|
| 🔴 | <n> | | | |
| 🟠 | | | | |
| 🟢 | | | | |
Kết luận một câu: <có chặn phát hành không, vì sao>.

## 2. Phạm vi và tín hiệu
Output rút gọn của `xt.py audit plan`: stack dò được, nhóm áp dụng / rút gọn / N/A (lý do), công cụ thiếu (→ `chưa biết`).

## 3. Lệnh đã chạy
| Nhóm | Lệnh | Exit | Kết quả chính |
|---|---|---|---|

## 4. Phát hiện chi tiết
### AUD-<MÃ>-NNN 🔴 <tóm tắt>
- **Bằng chứng:** đo được / suy luận / chưa biết — <lệnh + output rút gọn, file:dòng>
- **Tái hiện:** 1. … 2. … → <kết quả sai>
- **Xác minh đối kháng:** <ai, tái hiện được hay không>
- **Đề xuất sửa:** <nhỏ nhất đủ đúng> · **Gate:** `<lệnh>`

## 5. Kế hoạch sửa theo đợt (chờ duyệt)
| Đợt | Phát hiện | PR dự kiến | Gate của đợt |
|---|---|---|---|
| 1 | <ID…> (🔴 trước) | <tiêu đề conventional> | `<lệnh>` |

## 6. Nợ 🟢 giữ lại
| ID | Chủ | Hạn | Lý do chưa sửa |
|---|---|---|---|
```
