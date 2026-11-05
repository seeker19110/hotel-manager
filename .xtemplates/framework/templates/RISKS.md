---
title: Mẫu sổ rủi ro
kind: template
updated: 2026-11-02
---

# Mẫu docs/RISKS.md

> **Ai viết:** quản lý dự án (hay phiên chính khi chạy autopilot); mọi người thêm dòng khi thấy. **Giai đoạn:** G1 (bản
> đầu), rà lại mỗi mốc và trước G7. **Cổng dùng:** `PM-RISK-001`, `PM-RISK-006`, `PM-RISK-010`
> ([`../17-product-project/risk-and-assumptions.md`](../17-product-project/risk-and-assumptions.md)).
> **Luật:** mỗi rủi ro có chủ, biện pháp và dấu hiệu kích hoạt; "ngày rà" cũ hơn một mốc là sổ chết; rủi ro đã xảy ra
> chuyển thành sự cố/task, không xoá dòng.

````markdown
# Sổ rủi ro — <Tên dự án> · rà gần nhất <YYYY-MM-DD>

Thang: khả năng 1–5 × tác động 1–5 = điểm; ≥ 15 rà mỗi tuần, ≥ 8 rà mỗi mốc.

| ID (`RK-NNN`) | Rủi ro (nếu … thì …) | Loại | Khả năng | Tác động | Điểm | Chủ | Biện pháp (giảm/chuyển/chấp nhận) | Dấu hiệu kích hoạt | Ngày rà | Trạng thái |
|---|---|---|---|---|---|---|---|---|---|---|
| RK-001 | <Nếu nhà cung cấp SMS đổi giá thì chi phí OTP vượt ngân sách> | phụ thuộc bên thứ ba | 3 | 4 | 12 | <tên> | <có nhà cung cấp dự phòng, giới hạn gửi/phút> | <hoá đơn tháng > X> | <YYYY-MM-DD> | mở |
| RK-002 | <Nếu chỉ một người hiểu module thanh toán thì nghỉ phép làm dừng sửa lỗi> | con người (bus factor) | 4 | 4 | 16 | <tên> | <pair, RUNBOOK, người thứ hai review> | <PR thanh toán chỉ một người duyệt> | <YYYY-MM-DD> | mở |

## Phụ thuộc bên thứ ba quan trọng (`PM-RISK-006`)
| Dịch vụ | Dùng cho | Hợp đồng/SLA | Phương án khi ngừng | Dữ liệu xuất ra được? |
|---|---|---|---|---|
| <…> | <…> | <…> | <…> | <có/không — cách> |
````
