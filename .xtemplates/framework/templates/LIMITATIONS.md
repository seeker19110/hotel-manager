---
title: Mẫu giới hạn đã biết
kind: template
updated: 2026-11-02
---

# Mẫu docs/limitations.md

> **Ai viết:** người xây, mỗi khi biết một việc sản phẩm không làm hoặc làm chưa đúng. **Giai đoạn:** G5–G7, cập nhật
> cùng PR gây ra hay phát hiện giới hạn. **Cổng dùng:** `BASE-DOC-018`
> ([`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md)); README trỏ tới file này.
> **Luật:** nói thẳng điều không làm được và số liệu thật; mỗi dòng có cách lách hoặc "không có"; giới hạn đã gỡ thì ghi
> phiên bản gỡ, không xoá dòng.

````markdown
# Giới hạn đã biết — <Tên sản phẩm> · cập nhật <YYYY-MM-DD>

| Giới hạn | Ảnh hưởng tới ai | Số đo / điều kiện | Cách lách | Kế hoạch | Từ / tới phiên bản |
|---|---|---|---|---|---|
| <Xuất báo cáo > 50.000 dòng bị cắt> | <kế toán> | <đo 2026-…: 50.000 dòng> | <lọc theo tháng rồi xuất nhiều lần> | <T-NNN, hạn …> | <1.2.0 → chưa gỡ> |
| <Chưa hỗ trợ trình đọc màn hình ở trang bản đồ> | <người dùng khiếm thị> | <axe: 3 lỗi critical> | <bảng dữ liệu thay thế ở /list> | <…> | <…> |
| <Không chạy ngoại tuyến> | <…> | <…> | không có | không làm (ngoài phạm vi) | — |
````
