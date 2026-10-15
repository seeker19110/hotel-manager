# API-CONTRACT — Hotel Manager API · v1 · hợp đồng phiên bản 1 · 2026-10-15

> Draft, chờ duyệt. Tài liệu này là quy ước chung cho mọi command/query. Danh sách command của từng tính năng nằm ở mục 5 trong mỗi SPEC (`docs/specs/`).
> File máy đọc `apps/web/openapi.yaml` sinh từ schema Zod ở T-0xx và được lint trong CI.
> Base URL: `/api/v1` (cùng origin với web). Xác thực: cookie phiên HttpOnly + Secure + SameSite=Lax, do Better Auth cấp (ADR-0002). Portal khách dùng link ký có hạn.

## 1. Nguyên tắc chung
- **Kiểu RPC theo command.** Ghi: `POST /api/v1/<module>/<command>`, ví dụ `POST /api/v1/inventory/createHold`. Đọc: `GET /api/v1/<module>/<query>?...`. Chọn RPC thay vì CRUD REST vì nghiệp vụ là chuyển trạng thái có quy tắc, không phải sửa trường tự do.
- **Định dạng:** JSON UTF-8. Thời điểm là ISO 8601 UTC. Ngày địa phương là `YYYY-MM-DD` kèm `property_id`. Khoảng thời gian dùng `{ "start": ..., "end": ... }` theo `[start, end)`.
- **Tiền:** `{ "amount": 3580000, "currency": "VND" }` với `amount` là số nguyên đồng. Server từ chối số thập phân bằng `VALIDATION_FAILED`.
- **ID:** UUID v7. Mã hiển thị (số phiếu, số hợp đồng) là trường riêng, cấp theo cơ sở.
- **Ngữ cảnh tổ chức:** header `X-Org-Id` chỉ để **chọn** tổ chức trong số tổ chức người dùng đã có membership. Server luôn đối chiếu với membership và không tin ID do client gửi.
- **Idempotency:** mọi `POST` ghi bắt buộc có `Idempotency-Key: <uuid>`. Thiếu key thì trả 400 `MALFORMED_REQUEST`. Key lặp, cùng payload → trả kết quả cũ với cùng status. Key lặp, khác payload → 409 `IDEMPOTENCY_CONFLICT`. Key được lưu 7 ngày.
- **Kết quả command:** `{ "command_id": "...", "status": "committed", "data": {...} }`. Tra lại bằng `GET /api/v1/commands/{command_id}` khi client bị timeout. Trạng thái chỉ gồm: `committed` (kèm `data`) · `in_progress` (đang chạy, client chờ rồi hỏi lại) · `failed` (kèm `problem`). Không tồn tại hoặc không phải của người hỏi → 404 `COMMAND_NOT_FOUND` — client mới được phép gửi lại với **cùng** `Idempotency-Key`.
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
| `VALIDATION_FAILED` | 422 | Schema/nghiệp vụ đầu vào sai: tiền không nguyên, khoảng `end ≤ start`, thiếu trường (JSON không parse được → 400 `MALFORMED_REQUEST`) |
| `MALFORMED_REQUEST` | 400 | Body không phải JSON hợp lệ, thiếu `Idempotency-Key` |
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
| `FILE_TOO_LARGE` | 413 | File vượt giới hạn |
| `FILE_TYPE_NOT_ALLOWED` | 415 | MIME/magic bytes không trong allowlist |
| `APPROVAL_LIMIT_EXCEEDED` | 403 | Số tiền vượt hạn mức duyệt của vai trò |
| `SELF_APPROVAL_FORBIDDEN` | 403 | Tự duyệt chứng từ hoặc tự nghiệm thu việc của mình |
| `DOCUMENT_IMMUTABLE` | 409 | Sửa chứng từ/điều khoản đã phát hành hoặc ký (INV-G4); phải dùng điều chỉnh/đảo |
| `CONTEXT_CHANGED` | 409 | Tổ chức/cơ sở đang chọn đã đổi giữa lúc thao tác |
| `METER_READING_DECREASED` | 422 | Chỉ số nhỏ hơn lần trước mà không qua luồng thay công tơ |
| `HOLD_EXPIRED` | 409 | Xác nhận giữ chỗ đã hết hạn |
| `ROOM_OCCUPIED` | 409 | Phòng đang thực tế có người ở (chưa trả) |
| `UNIT_OUT_OF_SERVICE` | 409 | Phòng đang block/ngừng khai thác |
| `COMMAND_NOT_FOUND` | 404 | Tra kết quả command không tồn tại/không thuộc người hỏi |
| `RATE_LIMITED` | 429 | Vượt rate limit |
| `INTERNAL` | 500 | Lỗi không dự kiến. Chỉ trả `correlation_id`, không trả stack trace |

Bảng trên là **mã dùng chung**. Mã chỉ một tính năng dùng thì định nghĩa (HTTP, thông điệp) ở mục 6 của SPEC tương ứng; chỉ mục dưới đây để tránh trùng nghĩa. Thêm mã mới thì cập nhật chỉ mục này. Mã dùng ở ≥ 2 SPEC phải chuyển lên bảng chung. Khi code có, danh mục sinh từ `packages/app/src/errors.ts` và CI kiểm khớp.

| SPEC | Mã riêng |
|---|---|
| `SPEC-audit-reporting.md` | `EXPORT_NOT_READY` · `REPORT_RANGE_TOO_LARGE` |
| `SPEC-import.md` | `CONFLICT_AT_COMMIT` · `DUPLICATE_IN_FILE` · `IMPORT_CONFIRMATION_REQUIRED` · `IMPORT_EXTERNAL_ID_CONFLICT` · `IMPORT_HAS_ERRORS` · `IMPORT_TOTALS_MISMATCH` · `NOT_INTEGER_VND` · `OUT_OF_RANGE` · `REFERENCE_NOT_FOUND` · `TOO_LONG` |
| `SPEC-inventory-allocation.md` | `EXTENSION_CONFLICT` |
| `SPEC-lease.md` | `HANDOVER_REQUIRED` · `LEASE_TERMS_IMMUTABLE` · `LEASE_VERSION_OVERLAP` · `SETTLEMENT_REQUIRED` |
| `SPEC-ledger-payments.md` | `EVIDENCE_REQUIRED` · `HASH_MISMATCH` · `INBOX_HASH_MISMATCH` · `LEDGER_UNBALANCED` · `REFUND_EXCEEDS_BALANCE` · `THIRD_PARTY_PAYER` · `WEBHOOK_SIGNATURE_INVALID` · `WRONG_REFERENCE` |
| `SPEC-metering-billing.md` | `BILLING_PREVIEW_STALE` · `PERIOD_ISSUED` · `READINGS_INCOMPLETE` · `UNRESOLVED_ANOMALIES` |
| `SPEC-notifications.md` | `DELIVERY_NOT_RETRYABLE` · `NO_ADDRESS` · `OPTED_OUT` · `PREFERENCE_REQUIRED` · `PROVIDER_TEMPORARY` · `RECIPIENT_INVALID` · `TEMPLATE_ERROR` |
| `SPEC-portal.md` | `LINK_REVOKED` |
| `SPEC-pwa.md` | `CLIENT_OUTDATED` · `COMMAND_NOT_FOUND` · `NETWORK_TIMEOUT` · `RESULT_UNKNOWN` |

## 3. Webhook vào (`POST /api/v1/webhooks/{provider}/{account}`)
- Xác minh chữ ký/HMAC và timestamp theo nhà cung cấp, kiểm tài khoản nhận, ghi `inbox` với khoá unique `(provider, account, provider_event_id)`, rồi trả 2xx ngay. Xử lý thật diễn ra trong worker.
- Chữ ký sai → 401, không ghi `inbox` nhưng có log cảnh báo. Event trùng → 200 mà không tạo hiệu lực mới.
- Mọi nguồn (webhook, sao kê CSV, nhập tay kèm sao kê) quy về `bank_transactions` (INV-F4b) nên cùng một giao dịch ngân hàng chỉ tạo một payment.
- V1 chỉ có adapter **mô phỏng** (`provider = sim`) để test. Adapter thật chờ hợp đồng ngân hàng (F-016).

## 4. Endpoint hệ thống
| Method | Path | Mục đích |
|---|---|---|
| GET | `/api/health` | DB + hàng đợi; không cần phiên; không lộ phiên bản |
| GET | `/api/v1/me` | Người dùng, danh sách tổ chức/vai trò, tổ chức đang chọn |
| GET | `/api/v1/commands/{command_id}` | Kết quả một command (chỉ người tạo hoặc quản lý xem được) |
