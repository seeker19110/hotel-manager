# Retry, timeout và trạng thái (ARC-RES-002, ARC-RES-005)

> Cập nhật 2026-10-17 (T-502): vòng retry dùng chung một helper. `scripts/process-docs.test.mjs` so các hằng số dưới đây với mã nguồn.

## 1. Chính sách retry hiện có
Retry chỉ cho lỗi có thể qua (mạng, hết giờ, 5xx, 408/429) và chỉ cho thao tác idempotent; 4xx khác không thử lại.

| Nơi | Lỗi được thử lại | Lịch | Jitter | Trần | Mã nguồn / test |
|---|---|---|---|---|---|
| Kho file S3 (`aws4fetch`) | mạng, hết giờ, 5xx, 408, 429 (tôn trọng `Retry-After`); chỉ GET/HEAD/PUT/DELETE, POST gọi đúng một lần | lùi mũ từ `baseDelayMs` = 200 ms (helper `retryAsync`) | có: nhân hệ số ∈ [0,5; 1] | `maxRetries` = 3; một lần chờ ≤ `maxDelayMs` = 5.000 ms; mỗi lần thử `timeoutMs` = 15.000 ms; tổng ≤ `totalTimeoutMs` | `packages/app/src/files/storage.ts`, `storage-resilience.test.ts` |
| Email (`notification_deliveries`) | lỗi tạm của nhà cung cấp (`PROVIDER_TEMPORARY`); lỗi vĩnh viễn (`RECIPIENT_INVALID`…) không thử lại | mốc theo phút: `RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 360]` | có, cộng thêm: mốc · (1 + `RETRY_JITTER_RATIO` · random), `RETRY_JITTER_RATIO` = 0.2 — không bao giờ sớm hơn mốc (`spreadDelayMs`) | `MAX_ATTEMPTS` = 6 lượt gửi rồi trạng thái `dead` | `packages/app/src/notifications/send.ts`, `notifications.db.test.ts` |
| Job pg-boss (relay outbox → handler) | handler ném lỗi | `retryLimit` = 5, `retryDelay` = 5 giây, `retryBackoff` bật | do pg-boss | quá giới hạn → hàng đợi dead letter | `apps/worker/src/relay.ts` (`DEFAULT_QUEUE_POLICY`) |
| Transaction lệnh (pipeline) | `40001` (serialization failure), `40P01` (deadlock) | lùi mũ từ 25 ms, một lần chờ ≤ 250 ms (`REQUEST_TX_RETRY`) | full jitter ∈ [0, trần] | `maxAttempts` = 3; tổng ≤ 3.000 ms | `packages/app/src/pipeline/command.ts`, `packages/db/src/retry.ts` |
| Transaction worker/job (`withTenantRetry`) | `40001`, `40P01` | lùi mũ từ 50 ms, một lần chờ ≤ 2.000 ms (`WORKER_TX_RETRY`) | full jitter | `maxAttempts` = 5; tổng ≤ 15.000 ms | `packages/db/src/tenant.ts`, `packages/db/src/retry.ts` |
| Webhook vào | server không thử lại; bên gửi gửi lại; trùng sự kiện → 200 không tạo hiệu lực mới (`inbox` unique) | — | — | — | `docs/design/API-CONTRACT.md` §3 |

## 2. ARC-RES-002 — helper retry dùng chung
`packages/db/src/retry.ts`: `retryAsync` (số lần tối đa, lùi mũ + jitter, trần một lần chờ, trần tổng thời gian, chỉ thử lại lỗi mà `classify` coi là tạm thời, tôn trọng gợi ý `Retry-After`), `backoffDelayMs` (full jitter, `minJitterRatio` tuỳ chọn), `spreadDelayMs` (jitter cộng lên cho lịch cố định), `isTransientTxError` (SQLSTATE `40001`/`40P01`). Nguồn ngẫu nhiên, đồng hồ và hàm chờ tiêm được nên test xác định (`retry.test.ts`).
- Dùng bởi: kho S3 (`resilientSend`), pipeline lệnh (`executeCommand`), `withTenantRetry` (mọi job worker), lịch gửi lại email (`spreadDelayMs`).
- Rào `packages/app/src/tx-guards.test.ts`: không có vòng lùi mũ tự viết (`2 **`) ngoài helper, SQLSTATE `40001`/`40P01` chỉ được phân loại ở helper, mức cô lập chỉ đặt qua `withTenantRetry`.
- Còn lại ngoài helper (có chủ đích): retry của pg-boss cho job (cấu hình `DEFAULT_QUEUE_POLICY`), lùi lượt `claim_due_deliveries` của lượt `sending` quá hạn khoá (SQL cố định 1 phút, không jitter).

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
