---
name: Lỗi
about: Báo lỗi có thể tái hiện (không dán dữ liệu cá nhân thật, bí mật hay khoá)
labels: ["bug"]
---

## Hiện tượng
<!-- Điều xảy ra. Không dán dữ liệu thật: tên, SĐT, email, số giấy tờ, số tài khoản, token. -->

## Mong đợi
<!-- Điều đáng lẽ xảy ra; trỏ tiêu chí SPEC (S-NNN) nếu có. -->

## Cách tái hiện
1. …

## Môi trường
- Phiên bản/commit: …
- Thiết bị, trình duyệt: …
- `correlation_id` của lỗi (nếu có): …

## Mức ảnh hưởng
- [ ] Sai tiền hoặc tồn phòng (ưu tiên cao nhất)
- [ ] Lộ dữ liệu giữa tổ chức/người dùng — **không đăng công khai**, báo riêng cho chủ dự án
- [ ] Khác: …

## Definition of Ready
<!-- Gán nhãn `ready` (bắt đầu sửa) chỉ khi đủ các mục. Chưa đủ → hỏi thêm, chưa code (WF-TEAM-003). Workflow `dor-check.yml` gỡ nhãn `ready` nếu còn mục chưa tick. -->
- [ ] Tái hiện được theo các bước ở trên (hoặc có `correlation_id`/log đã che dữ liệu cá nhân)
- [ ] Hiện tượng và mong đợi đủ rõ để viết test đỏ trước (tiêu chí S-NNN nếu có)
- [ ] Mức ảnh hưởng đã chọn; lỗi sai tiền/tồn hoặc lộ dữ liệu đã báo chủ dự án và có người duyệt phạm vi sửa
- [ ] Không còn câu hỏi mở chặn việc; phụ thuộc (task/PR khác, quyền cần người duyệt) đã xác định

## Ghi chú
<!-- Việc sửa lỗi cần test tái hiện đỏ trước, xanh sau. -->
