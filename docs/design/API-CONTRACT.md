# API-CONTRACT — Hotel Manager API · v1 · hợp đồng phiên bản 1 · 2026-10-15

> Draft, chờ duyệt. Tài liệu này là quy ước chung cho mọi command/query. Danh sách command của từng tính năng nằm ở mục 5 trong mỗi SPEC (`docs/specs/`).
> File máy đọc `apps/web/openapi.yaml` sinh từ schema Zod ở T-0xx và được lint trong CI.
> Base URL: `/api/v1` (cùng origin với web). Xác thực: cookie phiên HttpOnly + Secure + SameSite=Lax, do server đổi từ token Supabase. Portal khách dùng link ký có hạn.

## 1. Nguyên tắc chung
- **Kiểu RPC theo command.** Ghi: `POST /api/v1/<module>/<command>`, ví dụ `POST /api/v1/inventory/createHold`. Đọc: `GET /api/v1/<module>/<query>?...`. Chọn RPC thay vì CRUD REST vì nghiệp vụ là chuyển trạng thái có quy tắc, không phải sửa trường tự do.
- **Định dạng:** JSON UTF-8. Thời điểm là ISO 8601 UTC. Ngày địa phương là `YYYY-MM-DD` kèm `property_id`. Khoảng thời gian dùng `{ "start": ..., "end": ... }` theo `[start, end)`.
- **Tiền:** `{ "amount": 3580000, "currency": "VND" }` với `amount` là số nguyên đồng. Server từ chối số thập phân bằng `VALIDATION_FAILED`.
- **ID:** UUID v7. Mã hiển thị (số phiếu, số hợp đồng) là trường riêng, cấp theo cơ sở.
- **Ngữ cảnh tổ chức:** header `X-Org-Id` chỉ để **chọn** tổ chức trong số tổ chức người dùng đã có membership. Server luôn đối chiếu với membership và không tin ID do client gửi.
- **Idempotency:** mọi `POST` ghi bắt buộc có `Idempotency-Key: <uuid>`. Thiếu key thì trả 400. Key lặp, cùng payload → trả kết quả cũ với cùng status. Key lặp, khác payload → 409 `IDEMPOTENCY_CONFLICT`. Key được lưu 7 ngày.
- **Kết quả command:** `{ "command_id": "...", "status": "committed", "data": {...} }`. Tra lại bằng `GET /api/v1/commands/{command_id}` khi client bị timeout.
- **Phân trang:** `?cursor=<opaque>&limit=<n>`, mặc định 50, tối đa 200. Phản hồi `{ "data": [...], "next_cursor": "..." | null }`.
- **Rate limit:** theo người dùng và theo IP. Đăng nhập và link khách có giới hạn chặt hơn. Vượt giới hạn trả 429 kèm `Retry-After`.
- **Versioning:** tiền tố `/v1`. Thêm trường tuỳ chọn không đổi version. Thay đổi phá vỡ tạo `/v2` và gửi header `Deprecation` + `Sunset`.
- **CSRF:** ghi bằng cookie phiên phải kiểm `Origin` và dùng SameSite=Lax. Không có endpoint ghi nào nhận `GET`.

## 2. Lỗi — `application/problem+json` (RFC 9457)

```json
{ "type": "https://hotel-manager.invalid/errors/ROOM_UNAVAILABLE",
  "title": "Phòng đã có người đặt trong khoảng thời gian này",
  "status": 409, "code": "ROOM_UNAVAILABLE",
  "detail": "Phòng 203 bận từ 2026-11-02 14:00 đến 2026-11-03 12:00",
  "correlation_id": "…", "errors": [ { "path": "during.end", "code": "BEFORE_START" } ] }
```

| Mã | HTTP | Khi nào |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Schema sai, tiền không nguyên, khoảng `end ≤ start` |
| `UNAUTHENTICATED` | 401 | Thiếu phiên hoặc phiên hết hạn |
| `REAUTH_REQUIRED` | 401 | Thao tác nhạy cảm (xuất dữ liệu, hoàn tiền vượt ngưỡng) cần xác thực lại hoặc MFA |
| `FORBIDDEN` | 403 | Có membership nhưng không đủ quyền hoặc vượt hạn mức |
| `NOT_FOUND` | 404 | Không tồn tại **hoặc** thuộc tổ chức/cơ sở khác (không phân biệt hai trường hợp, để không lộ thông tin) |
| `IDEMPOTENCY_CONFLICT` | 409 | Key trùng, payload khác |
| `ROOM_UNAVAILABLE` | 409 | Vi phạm INV-I1 |
| `INVALID_TRANSITION` | 409 | Chuyển trạng thái ngoài bảng |
| `VERSION_CONFLICT` | 409 | `base_version` cũ (optimistic lock) |
| `OVER_ALLOCATION` | 409 | Vi phạm INV-F2 |
| `PERIOD_LOCKED` | 409 | Ghi vào kỳ/ca đã khoá |
| `LINK_EXPIRED` | 410 | Link khách/xuất dữ liệu đã hết hạn |
| `PAYLOAD_TOO_LARGE` | 413 | File vượt giới hạn |
| `UNSUPPORTED_MEDIA` | 415 | MIME không cho phép |
| `RATE_LIMITED` | 429 | Vượt rate limit |
| `INTERNAL` | 500 | Lỗi không dự kiến. Chỉ trả `correlation_id`, không trả stack trace |

Mã riêng của từng tính năng ghi ở mục 6 trong SPEC tương ứng và dùng chung danh mục này. Thêm mã mới thì phải thêm vào bảng trên.

## 3. Webhook vào (`POST /api/v1/webhooks/{provider}`)
- Xác minh chữ ký/HMAC và timestamp theo nhà cung cấp, kiểm tài khoản nhận, ghi `inbox` với khoá unique `(provider, account, provider_event_id)`, rồi trả 2xx ngay. Xử lý thật diễn ra trong worker.
- Chữ ký sai → 401, không ghi `inbox` nhưng có log cảnh báo. Event trùng → 200 mà không tạo hiệu lực mới.
- V1 chỉ có adapter **mô phỏng** để test. Adapter thật chờ hợp đồng ngân hàng (F-016).

## 4. Endpoint hệ thống
| Method | Path | Mục đích |
|---|---|---|
| GET | `/api/health` | DB + hàng đợi; không cần phiên; không lộ phiên bản |
| GET | `/api/v1/me` | Người dùng, danh sách tổ chức/vai trò, tổ chức đang chọn |
| GET | `/api/v1/commands/{command_id}` | Kết quả một command (chỉ người tạo hoặc quản lý xem được) |
