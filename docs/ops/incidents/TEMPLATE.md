# Sự cố — <tiêu đề ngắn> · <YYYY-MM-DD>

> Chép tệp này thành `YYYY-MM-DD-<slug>.md`, thêm một dòng vào bảng của `README.md`. Không ghi dữ liệu cá nhân của người bị ảnh hưởng.

## Phát hiện
- Thời điểm phát hiện (UTC): <…> · Cách phát hiện (cảnh báo/người dùng/khác): <…> · Người phát hiện (vai trò): <…>

## Phân loại
- Mức: SEV<1/2/3> (`docs/ops/INCIDENT-RESPONSE.md` §1) · Vi phạm dữ liệu cá nhân: <có/không> · Loại dữ liệu, số chủ thể, tổ chức bị ảnh hưởng: <…>

## Thông báo
| Đối tượng | Hạn (data-breach.md) | Đã gửi lúc (UTC) | Biên nhận / người duyệt |
|---|---|---|---|
| Cơ quan có thẩm quyền | <…> | <…> | <…> |
| Chủ thể dữ liệu | <…> | <…> | <…> |
| Khách hàng (tổ chức) | <…> | <…> | <…> |

## Khắc phục
- Dòng thời gian (UTC): <phát hiện → khoanh vùng → khôi phục → đóng> · Đường rò đã chặn (bằng chứng): <…> · Bí mật đã xoay: <…>

## Post-mortem
- SEV1/SEV2: `docs/ops/POST-MORTEM-<ngày>-<slug>.md` theo mẫu khung (`.xtemplates/framework/templates/POST-MORTEM.md`) — liên kết: <…>

## Hành động
| Hành động | Chủ | Hạn | Issue/PR | Trạng thái |
|---|---|---|---|---|
| <hàng rào mới: test/lint/cảnh báo> | <…> | <…> | <…> | mở |
