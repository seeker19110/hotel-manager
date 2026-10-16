# SECURE-DEFAULTS — mặc định an toàn của phần mềm

> Phiên bản 1 · 2026-10-16 · BASE-CFG-007, BASE-SEC-004, BASE-SEC-010. Khi **không đặt biến tuỳ chọn nào**, cấu hình hiệu lực phải
> đúng bảng dưới. `packages/app/src/config/secure-defaults.test.ts` đọc bảng này và so với cấu hình thật (`loadConfig`), với dòng
> `config.effective` mà `apps/web/instrumentation.ts` in lúc khởi động (đã che bí mật), với `apps/web/package.json` và mã nguồn.
> Sửa mặc định ⇒ sửa cả bảng này (test đỏ nếu lệch).

## 1. Biến môi trường tuỳ chọn (không đặt ⇒ giá trị sau)
| Khoá | Mặc định hiệu lực | Vì sao an toàn |
|---|---|---|
| `NODE_ENV` | `development` | `next start` luôn chạy `production`; mọi kiểm bắt buộc chỉ ở production (https, khoá PII, ClamAV) nới có chủ đích cho dev/CI, không bao giờ nới ở production. |
| `LOG_LEVEL` | `info` | không ghi `debug` (có thể nhiều chi tiết) khi chạy thật; log luôn che bí mật/PII. |
| `SMTP_URL` | `fake://local` | không gửi thư ra ngoài khi chưa cấu hình; production chỉ nhận `smtps://` hoặc `smtp://…?requireTLS=true`. |
| `S3_REGION` | `vn-local` | vùng giả cho kho tự host; không trỏ vào dịch vụ đám mây ngoài. |
| `CLAMD_PORT` | `3310` | cổng chuẩn của clamd; `CLAMD_HOST` không đặt ⇒ không quét thật (dev dùng bản giả), production **bắt buộc** đặt. |
| `PGBACKREST_REPO_CIPHER_PASS` | không đặt | không có mật khẩu mặc định; bản sao lưu không chạy nếu thiếu. |
| `SIM_WEBHOOK_SECRET` | không đặt | webhook ngân hàng mô phỏng tắt (`/api/v1/webhooks/sim/*` trả 404). |
| `HM_PII_KEYS` | không đặt | dev/test dùng khoá dẫn xuất công khai (không bao giờ dùng được cho dữ liệu thật); production bắt buộc đặt. |
| `HM_PII_KEY_ID` | không đặt | như trên. |
| `HM_PII_INDEX_KEY` | không đặt | như trên. |
| `CLAMD_HOST` | không đặt | như `CLAMD_PORT`. |

## 2. Tuỳ chọn mạng/bảo mật khác
| Khoá | Mặc định hiệu lực | Nơi quyết định · cách kiểm |
|---|---|---|
| `bind` | `127.0.0.1` | script `dev`/`start` của `apps/web/package.json` (`-H ${HOST:-127.0.0.1}`); chỉ bind rộng hơn khi người vận hành đặt `HOST` (container sau Caddy). Compose không publish cổng Postgres/SeaweedFS. |
| `DEBUG` | `tắt` | không có biến/cờ debug; lỗi 5xx chỉ trả `correlation_id`, stack chỉ vào log. |
| `TLS verify` | `bật` | mã nguồn không có `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`; production bắt `https://` cho `APP_BASE_URL`, `S3_ENDPOINT` (loopback được miễn). |
| `CORS` | `đóng` | không có `Access-Control-Allow-*`; request ghi khác origin bị `proxy.ts` trả 403. |
| `khoá mặc định` | `không có` | mọi bí mật bắt buộc không có giá trị mặc định (thiếu ⇒ tiến trình không lên); `.env.example` chỉ chứa chỗ trống. |
| `biến công khai` | `không có` | không biến nào có tiền tố `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`/`EXPO_PUBLIC_`; bundle client không chứa tên/mẫu giá trị bí mật. |
| `cookie phiên` | `HttpOnly`, `SameSite=Lax`, `Path=/`; https → thêm `Secure` và tiền tố `__Host-hm.` | `packages/app/src/auth/auth.ts` (`advanced.cookiePrefix`/`defaultCookieAttributes`); trình duyệt buộc `__Host-` = Secure, Path=/, không Domain. Test: `packages/app/src/auth/secure-defaults-cookie.db.test.ts`. |
