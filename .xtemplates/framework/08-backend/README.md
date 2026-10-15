---
title: Backend
kind: index
updated: 2026-10-13
---

# 08 — Backend

> Yêu cầu cho mọi thành phần chạy ở server: API, xác thực/phân quyền, job nền, cache, tích hợp ngoài, độ tin
> cậy, file và realtime. Đa stack (NestJS/Fastify/Hono, FastAPI/Django, Go, Spring); công cụ chỉ là ví dụ, mục
> checklist là bắt buộc. `authn-authz.md` là **nhà duy nhất** của xác thực/phân quyền trong khung. Ghép vào
> blueprint qua hồ sơ có server (`08-backend/*`).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`api-design.md`](api-design.md) | REST/GraphQL/gRPC khi nào; lỗi RFC 9457; phân trang cursor; versioning; OpenAPI là nguồn sự thật; validate biên; `Idempotency-Key` | G3–G4 khi viết hợp đồng API; trước khi thêm endpoint mới |
| [`authn-authz.md`](authn-authz.md) | Session vs JWT, OAuth 2.1/OIDC, passkey, Argon2id, MFA, RBAC/ABAC, IDOR, kiểm quyền server cho mọi hành động | G4 thiết kế auth; mọi PR chạm đăng nhập/quyền/token; audit bảo mật |
| [`background-jobs-and-queues.md`](background-jobs-and-queues.md) | At-least-once, idempotency, retry backoff+jitter, DLQ, cron có khoá + jitter, outbox, worker tắt êm | Khi thêm job/cron/queue; khi thấy gửi trùng email/thanh toán |
| [`caching.md`](caching.md) | Cache HTTP (RFC 9111), cache ứng dụng, key/TTL/vô hiệu hoá, stampede (single-flight), không trộn dữ liệu người dùng | Khi đo thấy p95/tải DB cần cache; review mọi `Cache-Control` |
| [`integrations-and-webhooks.md`](integrations-and-webhooks.md) | Adapter cho hệ ngoài, webhook HMAC + timestamp, receiver idempotent, receipt, "504 = có thể đã chạy", SSRF | Khi nối thanh toán/SMS/CRM/LLM API; khi nhận hoặc phát webhook |
| [`reliability-and-errors.md`](reliability-and-errors.md) | Timeout mọi I/O, retry budget, tắt êm, liveness/readiness, rate limit token bucket, body/concurrency limit, load shedding | G5 dựng nền; trước khi lên production; sau mỗi sự cố quá tải |
| [`files-and-media.md`](files-and-media.md) | Presigned upload, magic bytes + allowlist, giới hạn kích thước, quét malware, strip EXIF, object storage private, xoá theo quyền | Khi có upload/tải xuống; khi xử lý ảnh/video/tài liệu |
| [`realtime-and-streaming.md`](realtime-and-streaming.md) | SSE vs WebSocket, auth trên kết nối, `Origin`, backpressure, heartbeat, `Last-Event-ID`, pub/sub scale ngang, stream LLM huỷ được | Khi cần đẩy dữ liệu sống/stream; trước khi chọn WebSocket |

Liên quan: kiến trúc và resilience → [`../05-architecture/`](../05-architecture/README.md); CSDL → [`../09-database/`](../09-database/README.md);
bảo mật → [`../12-security/`](../12-security/README.md); vận hành/SLO → [`../15-operations/`](../15-operations/README.md).
