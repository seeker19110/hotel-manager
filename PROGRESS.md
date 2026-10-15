# PROGRESS.md — <Tên dự án>

> Giai đoạn hiện tại: G<n> <tên> · Cập nhật: <YYYY-MM-DD hh:mm UTC> · Nhánh: <tên nhánh>

## Đang làm
- `T-<NNN>` <việc> — trạng thái: <đang code / chờ CI / chờ người quyết> — chỗ dừng: <file:dòng hoặc bước>
- (tối đa 2 dòng — WIP ≤ 2)

## Tiếp theo
1. `T-<NNN>` <việc> (Gate: `<lệnh>`)
2. `T-<NNN>` <việc>
3. Cổng sắp tới: G<n> — còn thiếu: <đầu ra nào>

## Quyết định
- <YYYY-MM-DD> <quyết định> — lý do: <...> — ADR: docs/adr/<NNNN>-<slug>.md (nếu có)
- <YYYY-MM-DD> Cắt <F-NNN> để giữ hạn thật <ngày> — quyết bởi <tên>
- Nợ kỹ thuật chấp nhận: <mục> — lý do — hạn trả: <ngày> (hoặc "không có")

## Bàn giao phiên
- Commit cuối trên nhánh chính: `<SHA đầy đủ>` (tổ tiên của HEAD; không ghi SHA của nhánh PR — squash-merge xoá nó) · CI: <xanh/đỏ — link>
- Lệnh kiểm nhanh: `<lệnh gate>` → exit <0/1> lúc <hh:mm>
- Đang chặn: <không | xt.py loop block: lý do>
- Việc dở chưa commit: <không | mô tả + file>
- Câu hỏi cần người: <không | câu hỏi — hỏi ai>
