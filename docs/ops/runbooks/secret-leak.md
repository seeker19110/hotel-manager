---
title: Runbook — lộ bí mật
kind: runbook
updated: 2026-10-16
last_drilled: chưa diễn tập
owner: (chưa gán — Tech Lead)
---

# Lộ bí mật

> Lộ bí mật ở production = SEV1 ([INCIDENT-RESPONSE](../INCIDENT-RESPONSE.md) §6). Các lệnh dưới **chưa chạy trên production** (chưa có). Không dán giá trị bí mật vào dòng lệnh, ticket hoặc chat: nạp từ kho bí mật/tệp 0600. Khoá xoay sai có thể khoá chính mình ra khỏi dữ liệu — các bước có chữ **không đảo ngược** cần người duyệt (AGENTS §6).

## Khi nào dùng
Bí mật xuất hiện trong repo/lịch sử git, log, ảnh chụp màn hình, bundle client, email, máy nhân viên bị mất, hoặc gitleaks báo. Có nghi ngờ cũng xoay. Danh sách biến theo `.env.example` và `packages/app/src/config/schema.ts` (`SECRET_KEYS`).

## Các bước
1. Xác định **loại bí mật** và **khoảng thời gian lộ** (commit đầu tiên chứa nó, log đầu tiên).
2. **Bảo toàn chứng cứ** (INCIDENT-RESPONSE §6) rồi **thu hồi/xoay** theo bảng dưới — thu hồi trước, xoay xong mới triển khai lại.
3. **Rà log trong khoảng lộ** tìm sử dụng trái phép: đăng nhập lạ và `audit_events` theo thời gian, lượt gọi `/api/metrics` (401 lặp), yêu cầu webhook mô phỏng bị từ chối, truy cập kho S3 (log SeaweedFS), kết nối Postgres từ IP lạ (`log_connections`), nhật ký pgBackRest.
4. Nếu có dấu hiệu bí mật đã bị dùng để đọc dữ liệu cá nhân → chạy [data-breach](data-breach.md).
5. Loại bí mật khỏi nơi lộ: lịch sử git (viết lại lịch sử chỉ khi chủ dự án duyệt; bí mật đã lộ coi như hỏng dù xoá), log, tệp. Thêm quy tắc ngăn tái diễn (gitleaks, test) — mỗi lỗi lặp một hàng rào mới.
6. Hậu kiểm theo mẫu post-mortem ([`.xtemplates/framework/templates/POST-MORTEM.md`](../../../.xtemplates/framework/templates/POST-MORTEM.md)).

## Từng loại bí mật
Sinh giá trị mới: `openssl rand -base64 32` (ghi `-base64 48` cho khoá repo). "Triển khai lại" = khởi động lại web + worker với môi trường mới.

| Bí mật | Dùng để | Xoay thế nào | Ảnh hưởng khi xoay |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | ký phiên/cookie Better Auth; HKDF ra token `/api/metrics` (`hm-metrics-v1`) và khoá HMAC liên kết huỷ đăng ký (`hm-unsubscribe-v1`) | Sinh mới ≥ 32 ký tự, đặt vào môi trường, triển khai lại; lấy token metrics mới bằng `node scripts/metrics-token.mjs` và cập nhật Prometheus | Mọi phiên đăng nhập mất hiệu lực; token metrics đổi; liên kết huỷ đăng ký đã gửi trong email hết hiệu lực. Better Auth cũng dùng bí mật này mã hoá dữ liệu của nó (có thể gồm bí mật TOTP) — (chưa xác minh trên mã này): thử trên staging trước, nếu TOTP không đọc được thì dùng `member.resetMfa` cho người bị ảnh hưởng |
| `DATABASE_URL` (mật khẩu role `app_runtime`, `app_worker`; mật khẩu `postgres` ở `deploy/secrets/postgres_password`) | kết nối CSDL | Không downtime: luân phiên login `<base>_a`/`<base>_b` theo [`db-password-rotation.md`](db-password-rotation.md) (lộ thật: tắt login lộ ngay ở bước 4 rồi dọn phiên, chấp nhận gián đoạn ngắn). Cách cũ đổi tại chỗ: `ALTER ROLE app_runtime PASSWORD '<mới>'` (và `app_worker`), cập nhật `DATABASE_URL`/worker, triển khai lại; mật khẩu `postgres`: `ALTER ROLE postgres PASSWORD …` rồi cập nhật tệp bí mật compose. Kết nối đang mở: `select pg_terminate_backend(pid) from pg_stat_activity where usename in ('app_runtime','app_worker')` (sau khi đã triển khai bản mới) | Gián đoạn ngắn lúc đổi; không mất dữ liệu |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ứng dụng ghi/đọc bucket file riêng tư SeaweedFS | Sinh cặp khoá mới trong `deploy/secrets/s3.json` (mẫu `deploy/s3.json.example`), khởi động lại `seaweedfs`, cập nhật môi trường ứng dụng, triển khai lại; xoá cặp cũ khỏi `s3.json` | URL ký đã cấp (≤ 5 phút) hỏng; file không mất. Nếu nghi đã đọc file: coi ảnh giấy tờ đã lộ → data-breach |
| `SMTP_URL` | gửi email qua SMTP relay | Thu hồi/đổi thông tin xác thực tại nhà cung cấp relay (chưa chọn), cập nhật `SMTP_URL`, triển khai lại. Sự cố gửi nhầm: đặt tạm `fake://local` | Email chờ gửi → retry theo lịch (1/5/30/120/360 phút) hoặc `dead`; gửi lại bằng `notifications.retryDelivery` |
| `PGBACKREST_REPO_CIPHER_PASS` | mã hoá repo sao lưu pgBackRest | **Không đảo ngược, cần người duyệt.** Không thể đổi mật khẩu repo có sẵn: tạo repo mới với khoá mới (`stanza-create` trên repo mới), chạy `backup --type=full`, kiểm `pgbackrest verify`, rồi mới huỷ repo cũ. Giữ khoá cũ tới khi repo cũ bị xoá | Mất khoá = mất toàn bộ bản sao lưu cũ. Trong lúc chuyển, chỉ có bản sao lưu ở repo còn dùng được — giữ cả hai repo tới khi repo mới có full backup đã verify |
| `SIM_WEBHOOK_SECRET` | HMAC webhook ngân hàng **mô phỏng** | Xoay không gián đoạn: đặt `SIM_WEBHOOK_SECRET=khoá_mới,khoá_cũ` (danh sách phân tách dấu phẩy, tối đa 3 khoá, mỗi khoá ≥ 32 ký tự), triển khai lại, đổi bên gửi sang khoá mới, rồi bỏ khoá cũ và triển khai lại. Khi LỘ khoá thì bỏ khoá lộ ngay (chỉ đặt khoá mới; webhook đang bay bị từ chối); để trống = tắt adapter (`/api/v1/webhooks/sim/*` trả 404) | Webhook đang bay bị từ chối 401 (không ghi tiền); bên gửi gửi lại. Rà `bank_transactions`/`inbox` trong khoảng lộ tìm giao dịch lạ |
| `HM_PII_KEYS`, `HM_PII_KEY_ID` | khoá mã hoá số giấy tờ (AES-256-GCM, mỗi bản mã mang `key_id`) | Theo [RUNBOOK §5](../../RUNBOOK.md): thêm khoá mới giữ khoá cũ (`1:<cũ>,2:<mới>`), `HM_PII_KEY_ID=2`, triển khai lại, mã hoá lại bằng `reencryptIdentityDocuments`, bỏ khoá cũ khi `keyIdOf` không còn dùng. **Bỏ khoá cũ là không đảo ngược** | Dữ liệu cũ vẫn đọc được tới khi bỏ khoá cũ. Khoá bị lộ + dữ liệu cũng bị lộ ⇒ giấy tờ đã lộ → data-breach |
| `HM_PII_INDEX_KEY` | blind index tìm theo số giấy tờ | **Không xoay cùng lúc** với `HM_PII_KEYS`: đổi khoá = tính lại toàn bộ index (cần job riêng, chưa có) | Tìm theo số giấy tờ hỏng tới khi tính lại. Lộ khoá này cho phép dò ngược số giấy tờ đã biết → coi như lộ một phần |
| `CLAMD_HOST`/`CLAMD_PORT` (không phải bí mật, ghi để đủ danh sách) | địa chỉ máy quét | Không cần xoay | — |
| `deploy/secrets/*` (`postgres_password`, `pgbackrest.conf`, `s3.json`) | bí mật triển khai (bị `.gitignore`) | Như từng dòng ở trên; tệp 0600, chủ là người vận hành | — |
| Khoá SSH VPS / tài khoản nhà cung cấp VPS, kho sao lưu | quản trị hạ tầng | Thu hồi khoá/token ở nhà cung cấp, tạo khoá mới | (chưa có VPS) |

## Xác minh
- Bí mật cũ **không còn dùng được**: thử đăng nhập/gọi bằng giá trị cũ → 401/lỗi xác thực (ví dụ `curl -H "Authorization: Bearer <token cũ>" …/api/metrics` → 401).
- Ứng dụng khởi động được (schema env hợp lệ), `GET /api/ready` → 200 với `database`, `storage`, `scanner` đều `ok`.
- `pgbackrest --stanza=hm check` và `verify` thành công nếu đã đổi khoá repo.
- gitleaks (`.github/workflows/secret-scan.yml`) xanh sau khi loại bí mật khỏi nơi lộ.
- Dòng thời gian ghi giờ lộ → giờ thu hồi.

## Liên hệ và leo thang
IC và Tech Lead: (chưa gán). Chủ dự án duyệt thao tác không đảo ngược: (chưa gán). Pháp lý (khi có dữ liệu cá nhân bị ảnh hưởng): xem [data-breach](data-breach.md). Danh sách đầy đủ: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).
