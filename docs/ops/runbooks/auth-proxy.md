# Ranh giới địa chỉ IP cho xác thực

Kiểm ngày 2026-10-26 (T-2405, D-134). Triển khai chuẩn là client → Caddy → web; `deploy/compose.yaml` chỉ publish cổng Caddy, web nằm trong mạng backend. Better Auth 1.7.9 mặc định chỉ đọc `X-Forwarded-For` (`@better-auth/core/dist/utils/ip.mjs`); không đọc `X-Real-IP`.

Caddy mặc định thay giá trị `X-Forwarded-For` do client gửi bằng địa chỉ kết nối khi không cấu hình trusted proxy. Nguồn chính thức: [reverse_proxy, Defaults](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults), kiểm ngày 2026-10-26. Caddyfile của dự án không khai `trusted_proxies` hoặc ghi đè header này.

## Bằng chứng cục bộ

Đã chạy image Caddy `2.11.7-alpine` (cùng phiên bản mã nguồn với image tự dựng), proxy HTTP loopback tới máy chủ echo riêng, lần lượt gửi:

1. Không có header địa chỉ.
2. `X-Forwarded-For: 198.51.100.20`.
3. `X-Forwarded-For: 203.0.113.4, 198.51.100.20` và `X-Real-IP: 198.51.100.50`.

Cả ba lần upstream nhận `X-Forwarded-For: 127.0.0.1` (địa chỉ thật của client thử nghiệm). `X-Real-IP` còn nguyên ở ca 3 nhưng Better Auth không dùng nó. Kết quả máy: [`auth-proxy-2026-10-26.json`](../evidence/auth-proxy-2026-10-26.json). Không có dữ liệu người dùng thật.

Kết quả này xác nhận hành vi proxy với cấu hình mặc định; chưa là bằng chứng cấu hình VPS production. Khi thêm CDN/load balancer hoặc publish cổng web, phải kiểm lại toàn bộ đường đi trước khi cho truy cập thật. Chỉ tin dải IP proxy thực tế, không khai toàn bộ Internet là trusted proxy.

## Giới hạn tần suất và Retry-After

Better Auth dùng CSDL cho bộ đếm. Bản 1.7.9 có thể trả `X-Retry-After` rất lớn do `lastRequest` kiểu chuỗi từ bigint PostgreSQL bị nối chuỗi khi cộng cửa sổ. Adapter của ứng dụng bỏ giá trị vượt cửa sổ và trả thời gian dự phòng của đường gọi: 10 giây cho `/two-factor/*`, 60 giây cho các đường khác. Header chuẩn `Retry-After` hợp lệ tới một ngày, gồm khoá tài khoản (ví dụ 900 giây), vẫn giữ nguyên; giá trị vượt trần dùng thời gian dự phòng.

Kiểm hồi quy: `pnpm vitest run --project unit retry-after` (bao gồm route thật của Next và payload lỗi gốc); không cần sửa dependency hoặc giảm giới hạn bảo vệ.
