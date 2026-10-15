---
title: Mẫu RELEASE-NOTES
kind: template
updated: 2026-10-13
---

# Mẫu RELEASE-NOTES.md — ghi chú phát hành cho người dùng

> **Ai viết:** người chủ sản phẩm/người viết nội dung, từ CHANGELOG kỹ thuật (sinh bởi conventional commits) — **viết cho người dùng**, không phải cho lập trình viên. **Giai đoạn:** G7, mỗi phát hành.
> **Cổng dùng:** GO/NO-GO mục SHOULD "release notes", `PM-HANDOVER-012`, `WF-REL-*` ở [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md).
> **Quy ước:** phiên bản SemVer 2.0.0; ngày ISO 8601 `YYYY-MM-DD`; nhóm theo loại thay đổi của Keep a Changelog 1.1.0 (Added/Changed/Deprecated/Removed/Fixed/Security) dịch cho người dùng; mục "Bạn cần làm gì" đặt đầu nếu có thay đổi phá vỡ. Không nhắc tên nhánh, SHA, thư viện nội bộ.

```markdown
# <Tên sản phẩm> <phiên bản> — <YYYY-MM-DD>

> Tóm tắt một câu: <điều đáng giá nhất cho người dùng trong bản này>.

## ⚠ Bạn cần làm gì (chỉ khi có thay đổi phá vỡ / cần hành động)
- <vd: Đăng nhập lại sau khi cập nhật vì phiên cũ hết hiệu lực.>
- <vd: Tính năng X sẽ ngừng hoạt động từ <ngày>; cách chuyển sang Y: <link>.>

## Mới (Added)
- **<Tên tính năng>** — <người dùng làm được gì, ở đâu trong sản phẩm>. <link hướng dẫn>

## Thay đổi (Changed)
- <hành vi cũ> → <hành vi mới>, vì <lý do ngắn, hướng tới người dùng>.

## Sửa lỗi (Fixed)
- <Triệu chứng người dùng từng thấy> — đã sửa. (mã tham chiếu nội bộ: #<n>)

## Bảo mật (Security)
- <Mô tả mức ảnh hưởng và việc người dùng nên làm, không nêu chi tiết khai thác>. 

## Ngừng hỗ trợ / sẽ gỡ (Deprecated / Removed)
- <Tính năng> — ngừng từ <ngày>; thay thế: <...>.

## Lỗi đã biết
- <mô tả> — cách tạm: <...> — dự kiến sửa: <phiên bản/ngày>.

## Góp ý & báo lỗi
<kênh: email/form/trang trạng thái> · Chính sách riêng tư: <link> · Điều khoản: <link>
```
