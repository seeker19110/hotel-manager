---
title: Mẫu AUDIT-STATUS
kind: template
updated: 2026-10-14
---

# Mẫu AUDIT-STATUS.md — sổ audit máy đọc được

> **Ai viết:** phiên chạy `/audit` (người hoặc AI), cập nhật sau mỗi lần quét/sửa. **Giai đoạn:** G0 brownfield, G7, định kỳ.
> **Cổng dùng:** `xt.py audit check docs/ops/AUDIT-STATUS.md` (schema) · `--strict` = Definition of Complete
> ([`../00-method/audit.md`](../00-method/audit.md) §7). `xt.py audit plan --status …` đọc cột SHA để biết nhóm cần quét lại.
> **Luật bảng** (máy kiểm): giữ đúng tiêu đề cột; ký tự `|` trong ô viết `\|`; ID `AUD-<MÃ>-NNN` không tái sử dụng;
> Bằng chứng mở đầu `đo được:` / `suy luận:` / `chưa biết:`; 🔴/🟠 chưa `bác bỏ` phải có Gate (lệnh trong backtick hoặc `tay: <bước>`);
> `đã sửa` ghi PR/SHA ở Ghi chú; `chấp nhận` ghi `chủ: <ai>` và `hạn: YYYY-MM-DD`; `bác bỏ`/`N/A` ghi lý do.

```markdown
# AUDIT-STATUS — <Tên dự án>

> Cập nhật: <YYYY-MM-DD> · Báo cáo gần nhất: `docs/ops/AUDIT-REPORT-<YYYY-MM-DD>.md`

## Nhóm

| # | Mã | Nhóm | Trạng thái | SHA | Ngày | Ghi chú |
|---|---|---|---|---|---|---|
| 1 | ARCH | Kiến trúc & ranh giới | chưa quét | | | |
| 2 | SEC | Bảo mật | chưa quét | | | |
| 3 | CODE | Chất lượng mã | chưa quét | | | |
| 4 | TEST | Kiểm thử | chưa quét | | | |
| 5 | PERF | Hiệu năng | chưa quét | | | |
| 6 | A11Y | A11y & UX | chưa quét | | | |
| 7 | DEP | Phụ thuộc | chưa quét | | | |
| 8 | CI | CI/CD | chưa quét | | | |
| 9 | DOC | Tài liệu | chưa quét | | | |
| 10 | DATA | Dữ liệu | chưa quét | | | |
| 11 | CFG | Cấu hình & bí mật | chưa quét | | | |
| 12 | XFEAT | Thống nhất chéo tính năng | chưa quét | | | |
| 13 | HAR | Harness & quy trình agent | chưa quét | | | |

## Phát hiện

| ID | Mức | Trạng thái | Tóm tắt | Bằng chứng | Gate | Ghi chú |
|---|---|---|---|---|---|---|
| AUD-SEC-001 | 🔴 | mở | <một câu: lỗi gì, hậu quả gì> | đo được: `<lệnh>` → <kết quả>; <file:dòng> | `<lệnh đỏ trước, xanh sau khi sửa>` | |
```

Trạng thái nhóm: `chưa quét` · `đã quét` · `rút gọn` (chỉ quét phần có thật — ghi phần nào) · `N/A` (ghi lý do kiểm được).
Trạng thái phát hiện: `mở` · `đã sửa` · `chấp nhận` · `bác bỏ`. Chi tiết dài (output lệnh, đường tái hiện từng bước)
để ở `AUDIT-REPORT-<ngày>.md` theo [`AUDIT-REPORT.md`](AUDIT-REPORT.md), không nhồi vào ô bảng.
