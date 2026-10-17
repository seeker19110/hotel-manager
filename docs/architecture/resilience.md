# Retry, timeout và trạng thái (ARC-RES-002, ARC-RES-005)

> Ghi hiện trạng đã đọc từ mã ngày 2026-10-16. Chỉ tài liệu và test khớp hằng số; không đổi hành vi gửi email hay retry nào. `scripts/process-docs.test.mjs` so các hằng số dưới đây với mã nguồn.

## 1. Chính sách retry hiện có
Retry chỉ cho lỗi có thể qua (mạng, hết giờ, 5xx, 408/429) và chỉ cho thao tác idempotent; 4xx khác không thử lại.

| Nơi | Lỗi được thử lại | Lịch | Jitter | Trần | Mã nguồn / test |
|---|---|---|---|---|---|
| Kho file S3 (`aws4fetch`) | mạng, hết giờ, 5xx, 408, 429 (tôn trọng `Retry-After`); chỉ GET/HEAD/PUT/DELETE, POST gọi đúng một lần | lùi mũ từ `baseDelayMs` = 200 ms | có: nhân hệ số ∈ [0,5; 1] | `maxRetries` = 3; một lần chờ ≤ `maxDelayMs` = 5.000 ms; mỗi lần thử `timeoutMs` = 15.000 ms | `packages/app/src/files/storage.ts`, `storage-resilience.test.ts` |
| Email (`notification_deliveries`) | lỗi tạm của nhà cung cấp (`PROVIDER_TEMPORARY`); lỗi vĩnh viễn (`RECIPIENT_INVALID`…) không thử lại | cố định theo phút: `RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 360]` | **không** | `MAX_ATTEMPTS` = 6 lượt gửi rồi trạng thái `dead` | `packages/app/src/notifications/send.ts`, `notifications.db.test.ts` |
| Job pg-boss (relay outbox → handler) | handler ném lỗi | `retryLimit` = 5, `retryDelay` = 5 giây, `retryBackoff` bật | do pg-boss | quá giới hạn → hàng đợi dead letter | `apps/worker/src/relay.ts` (`DEFAULT_QUEUE_POLICY`) |
| Transaction lệnh (pipeline) | `40001` (serialization failure), `40P01` (deadlock) | thử lại ngay | không | `MAX_ATTEMPTS` = 3 | `packages/app/src/pipeline/command.ts` |
| Webhook vào | server không thử lại; bên gửi gửi lại; trùng sự kiện → 200 không tạo hiệu lực mới (`inbox` unique) | — | — | — | `docs/design/API-CONTRACT.md` §3 |

## 2. ARC-RES-002 — helper retry dùng chung: còn thiếu
Mã hiện có hai cơ chế tự viết (S3 và email) cộng cơ chế của pg-boss. Email dùng lịch cố định không jitter nên nhiều lượt gửi lỗi cùng lúc (nhà cung cấp lỗi diện rộng) sẽ thử lại cùng một thời điểm. Đề xuất, **chưa làm** vì đổi hành vi gửi email:
- Tách hàm thuần `backoffDelay({ attempt, baseMs, maxMs, retryAfterMs, random })` dùng chung, S3 và email cùng gọi; email giữ lịch phút hiện tại làm `baseMs`/`maxMs` và thêm jitter ∈ [0,5; 1] như S3.
- Test: 4xx không retry, 503 retry đúng số lần, `Retry-After` được tôn trọng, `random` được tiêm để test ổn định.
- Việc này là một task riêng có test CSDL cho email (đổi lịch ảnh hưởng `next_attempt_at`); không nằm trong T-412.

## 3. ARC-RES-005 — tiến trình không giữ trạng thái
Nguồn sự thật nằm ngoài tiến trình web/worker, nên chạy ≥ 2 bản sao không đổi hành vi:

| Trạng thái | Nơi giữ |
|---|---|
| Phiên đăng nhập, 2FA, OTP | bảng Better Auth trong Postgres |
| Rate limit đăng nhập | `rateLimit.storage = "database"` (`packages/app/src/auth/auth.ts`) |
| Idempotency, kết quả lệnh, audit, outbox | Postgres (`idempotency_keys`, `audit_events`, `outbox`) |
| Hàng đợi job | schema `pgboss` trong Postgres |
| File, tệp xuất | SeaweedFS (S3); staging có trạng thái ở CSDL (`packages/app/src/files/staging.ts`) |
| Cache trong bộ nhớ | chỉ tài nguyên tái dùng (pool kết nối, cấu hình, ngữ cảnh server `packages/app/src/server/context.ts`); không là nguồn sự thật |

Ghi file ra đĩa: mã sản phẩm không ghi file; ngoại lệ duy nhất là hộp thư giả `fake://file?path=…` của dev/E2E (`packages/app/src/auth/otp-mail.ts`), bị đặt tay bằng `SMTP_URL`.

Còn thiếu (chưa làm): E2E chạy hai bản sao web sau proxy luân phiên, tắt sticky session — cần cấu hình Playwright/e2e server khởi hai instance (đụng `playwright.config.ts`, ngoài phạm vi T-412). Cho tới khi có, khẳng định "scale ≥ 2 bản sao" dựa trên rà soát ở bảng trên, chưa có bằng chứng chạy.
