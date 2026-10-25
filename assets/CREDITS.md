# Nguồn và quyền sử dụng tài sản hình/phông

> Mọi tệp tĩnh phục vụ người dùng (ảnh, icon, phông) phải có một dòng ở bảng dưới; `scripts/assets-credits.test.mjs`
> (chạy trong `pnpm test`) so khớp hai chiều — tệp thiếu dòng hoặc dòng không có tệp → đỏ (UX-VISUAL-007).
> Cột "AI tạo" ghi `có` nếu ảnh do AI sinh (phải gắn nhãn ở nơi hiển thị); hiện không có ảnh nào như vậy.

## Tệp trong `apps/web/public`

| Tệp | Nguồn | Giấy phép / quyền | AI tạo |
|---|---|---|---|
| `apps/web/public/icons/icon-192.png` | Tự sinh bằng `apps/web/scripts/gen-icons.mjs` (hình ngôi nhà vẽ bằng mã, màu từ token `--c-brand`) | Thuộc dự án; không chứa tài sản bên thứ ba | không |
| `apps/web/public/icons/icon-512.png` | như trên | như trên | không |
| `apps/web/public/icons/maskable-512.png` | như trên (vùng an toàn cho icon maskable) | như trên | không |
| `apps/web/public/icons/apple-touch-icon.png` | như trên (180 × 180 cho iOS) | như trên | không |
| `apps/web/public/.well-known/security.txt` | Viết tay (RFC 9116, kênh báo lỗ hổng — SECURITY.md, D-112) | Thuộc dự án | không |

## Phông chữ

Không nhúng phông nào: giao diện dùng phông hệ thống (`--font: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans",
sans-serif` ở `apps/web/app/globals.css`), nên không có tệp phông để ghi nguồn và không cần `unicode-range`. Các phông
hệ thống đều hiển thị đủ dấu tiếng Việt; E2E `ux-guards` kiểm chuỗi có dấu hiển thị đúng (không ô vuông).

## Icon giao diện (SVG)

Icon trong ứng dụng là SVG vẽ tay trong mã (`apps/web/components/ui/icon.tsx`), không phải tệp ảnh và không lấy từ bộ
icon bên thứ ba; thuộc dự án.
