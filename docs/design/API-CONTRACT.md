# API-CONTRACT — Hotel Manager API · v1 · hợp đồng phiên bản 1 · 2026-10-15

> Draft, chờ duyệt. Tài liệu này là quy ước chung cho mọi command/query. Danh sách command của từng tính năng nằm ở mục 5 trong mỗi SPEC (`docs/specs/`).
> File máy đọc: [`apps/web/openapi.json`](../../apps/web/openapi.json) (OpenAPI 3.1) **sinh** từ registry command/query và schema Zod bằng `pnpm openapi` — không sửa tay;
> `pnpm openapi --check` và `packages/app/src/http/openapi.test.ts` (chạy trong `pnpm test`) đỏ khi file lệch nguồn. Chưa có bước lint OpenAPI riêng hay so breaking-change trong CI (STD-PROC-003, còn mở).
> Bảng mã lỗi dùng chung ở mục 2 viết tay nhưng được kiểm hai chiều với `ERROR_CODES` (`packages/app/src/errors.ts`) bởi `errors.test.ts` và `scripts/process-docs.test.mjs`.
> Base URL: `/api/v1` (cùng origin với web). Xác thực: cookie phiên HttpOnly + Secure + SameSite=Lax, do Better Auth cấp (ADR-0002). Portal khách dùng link ký có hạn.

## 1. Nguyên tắc chung
- **Kiểu RPC theo command.** Ghi: `POST /api/v1/<module>/<command>`, ví dụ `POST /api/v1/inventory/createHold`. Đọc: `GET /api/v1/<module>/<query>?...`. Chọn RPC thay vì CRUD REST vì nghiệp vụ là chuyển trạng thái có quy tắc, không phải sửa trường tự do.
- **Định dạng:** JSON UTF-8. Thời điểm là RFC 3339 và **bắt buộc có offset** (`2026-10-13T07:14:05.123Z` hoặc `+07:00`); chuỗi không có `Z`/`±hh:mm` (kể cả `2026-10-13T07:14:05`) bị từ chối `422 VALIDATION_FAILED` (XC-UNITS-001). Server trả thời điểm ở UTC (`Z`). Ngày địa phương là `YYYY-MM-DD` kèm `property_id`. Khoảng thời gian dùng `{ "start": ..., "end": ... }` theo `[start, end)`.
- **Tiền:** `{ "amount": 3580000, "currency": "VND" }` với `amount` là số nguyên đồng. Server từ chối số thập phân bằng `VALIDATION_FAILED`.
- **ID:** UUID v7. Mã hiển thị (số phiếu, số hợp đồng) là trường riêng, cấp theo cơ sở.
- **Ngữ cảnh tổ chức:** header `X-Org-Id` chỉ để **chọn** tổ chức trong số tổ chức người dùng đã có membership. Server luôn đối chiếu với membership và không tin ID do client gửi. Trang web gửi kèm `X-Org-Context` = tổ chức trang đang hiển thị; khác tổ chức của request (tab khác đã chuyển) ⇒ `409 CONTEXT_CHANGED`, không ghi gì (SPEC-portal S-013).
- **Idempotency:** mọi `POST` ghi bắt buộc có `Idempotency-Key: <uuid>`. Thiếu key thì trả 400 `MALFORMED_REQUEST`. Key lặp, cùng payload → trả kết quả cũ với cùng status. Key lặp, khác payload → 422 `IDEMPOTENCY_CONFLICT` (theo draft IETF httpapi-idempotency-key-header, D-034; client xử lý theo `code`, không theo status). Key lặp khi lần đầu còn đang xử lý (chưa commit) → 409 `IDEMPOTENCY_IN_PROGRESS` ngay, kèm `Retry-After: 1` (D-043; không giữ kết nối chờ) — client đợi rồi tra `GET /api/v1/commands/{key}`, không gửi payload mới. Key được lưu 7 ngày.
- **Kết quả command:** `{ "command_id": "...", "status": "committed", "data": {...} }`. Tra lại bằng `GET /api/v1/commands/{command_id}` khi client bị timeout. Trạng thái chỉ gồm: `committed` (kèm `data`) · `in_progress` (đang chạy, client chờ rồi hỏi lại) · `failed` (kèm `problem`). Không tồn tại hoặc không phải của người hỏi → 404 `COMMAND_NOT_FOUND` — client mới được phép gửi lại với **cùng** `Idempotency-Key`.
- **Phân trang:** `?cursor=<opaque>&limit=<n>`, mặc định 50, tối đa 200. Phản hồi `{ "data": [...], "next_cursor": "..." | null }`.
- **Rate limit:** theo người dùng và theo IP. Đăng nhập và link khách có giới hạn chặt hơn. Vượt giới hạn trả 429 kèm `Retry-After` (số giây, MỌI 429 của app — kể cả của Better Auth, khoá tài khoản — đều có; thân problem có thêm `retry_after`). Hạn mức lệnh ghi theo TỔ CHỨC (IND-SAAS-008): tối đa `COMMAND_QUOTA_PER_MINUTE` (600) lệnh mới/phút/tổ chức, vượt ⇒ 429 `RATE_LIMITED` và KHÔNG lưu kết quả (gửi lại cùng `Idempotency-Key` sau `Retry-After` chạy bình thường; replay key đã có không tốn hạn mức). Route không đi qua pipeline lệnh có hạn mức riêng bằng bộ đếm trong Postgres (dùng chung mọi instance, `app.rate_limit_hit`, BE-REL-006): tải file `files/upload` 30/phút/thành viên và 120/phút/tổ chức; `import/upload` 10 và 30; webhook ngân hàng đã xác thực chữ ký 600/phút/tài khoản; chữ ký webhook SAI 300/phút/nhà cung cấp (vượt ⇒ 429 thay cho 401, không ảnh hưởng webhook hợp lệ). Vượt ⇒ 429 `RATE_LIMITED` + `Retry-After` = số giây tới hết cửa sổ 60 giây.
- **Trace (W3C Trace Context level 1):** mọi phản hồi của `/api/*` có header `traceparent` (`00-<trace-id>-<span-id>-<flags>`). Request đến có `traceparent` đúng chuẩn (chữ hex thường, version ≠ `ff`, id không toàn 0) thì server giữ `trace-id` và dùng `span-id` MỚI của mình; thiếu/sai ⇒ server sinh trace mới (không báo lỗi). `trace_id`/`span_id` được ghi vào mọi dòng log của request đó và của job worker sinh từ nó (`outbox.traceparent`). `tracestate` không dùng. `X-Correlation-Id` vẫn là mã tra cứu cho người dùng/hỗ trợ.
- **Phiên bản client (SPEC-pwa S-009):** client web gửi `X-App-Version: <semver build>` kèm mỗi command (lấy từ `<meta name="hm-app-version">` của trang). Thấp hơn mức tối thiểu của server (`apps/web/package.json` → `hm.minClientVersion`, đọc được ở `GET /api/version`) hoặc không đúng semver ⇒ `426 CLIENT_OUTDATED`, kiểm TRƯỚC phiên/idempotency và không ghi gì. Không gửi header (script/API client) ⇒ không kiểm.
- **Versioning:** tiền tố `/v1`. Thêm trường tuỳ chọn không đổi version. Thay đổi phá vỡ tạo `/v2` và gửi header `Deprecation` + `Sunset`.
- **CSRF:** ghi bằng cookie phiên phải kiểm `Origin` và dùng SameSite=Lax. Không có endpoint ghi nào nhận `GET`.

## 2. Lỗi — `application/problem+json` (RFC 9457)

```json
{ "type": "https://hotel-manager.invalid/errors/ROOM_UNAVAILABLE",
  "title": "Phòng đã có người đặt trong khoảng thời gian này",
  "status": 409, "code": "ROOM_UNAVAILABLE",
  "detail": "Phòng 203 bận từ 2026-11-02 14:00 đến 2026-11-03 12:00",
  "correlation_id": "…", "errors": [ { "path": "during.end", "field": "during.end", "code": "BEFORE_START" } ] }
```

Trường tuỳ chọn theo mã (không có thì bỏ hẳn, không gửi `null`): `retry_after` (giây, mọi 429 và 409 `IDEMPOTENCY_IN_PROGRESS`) · `alternatives` (`[{unit_id, code}]` — phòng cùng loại còn trống khi `ROOM_UNAVAILABLE` ở `allocation.createHold` và `reservation.hold`, SPEC-inventory-allocation S-002) · `items` (danh sách bản ghi liên quan: allocation xung đột khi `BLOCK_CONFLICT`, gợi ý phòng ở `reservation.hold` — cùng nội dung `alternatives`, giữ cho tương thích, D-040) · `exception_id` (id ngoại lệ `EXTENSION_CONFLICT` khi `ROOM_UNAVAILABLE` ở lệnh nghiệp vụ gia hạn/đổi khoảng allocation (qua `resizeAllocation` nội bộ, D-047), ghi ở transaction riêng sau rollback — SPEC-inventory-allocation S-018) · `errors` (lỗi theo trường, 422).

| Mã | HTTP | Khi nào |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Schema/nghiệp vụ đầu vào sai: tiền không nguyên, khoảng `end ≤ start`, thiếu trường (JSON không parse được → 400 `MALFORMED_REQUEST`) |
| `MALFORMED_REQUEST` | 400 | Body không phải JSON hợp lệ, thiếu `Idempotency-Key` |
| `UNAUTHENTICATED` | 401 | Thiếu phiên hoặc phiên hết hạn |
| `SESSION_REVOKED` | 401 | Phiên đã bị thu hồi (`session.revokeAll`, đặt lại MFA…): request mang cookie phiên đó nhận mã này thay vì `UNAUTHENTICATED`; đăng nhập lại tạo phiên mới bình thường (SPEC-access S-010) |
| `REAUTH_REQUIRED` | 401 | Thao tác nhạy cảm (xuất dữ liệu, hoàn tiền vượt ngưỡng) cần xác thực lại hoặc MFA |
| `FORBIDDEN` | 403 | Có membership nhưng không đủ quyền hoặc vượt hạn mức |
| `NOT_FOUND` | 404 | Không tồn tại **hoặc** thuộc tổ chức/cơ sở khác (không phân biệt hai trường hợp, để không lộ thông tin) |
| `IDEMPOTENCY_CONFLICT` | 422 | Key trùng, payload khác |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Key trùng, lần đầu còn đang xử lý (chưa commit); kèm `Retry-After: 1` |
| `ROOM_UNAVAILABLE` | 409 | Vi phạm INV-I1 |
| `INVALID_TRANSITION` | 409 | Chuyển trạng thái ngoài bảng |
| `VERSION_CONFLICT` | 409 | `base_version` cũ (optimistic lock) |
| `OVER_ALLOCATION` | 409 | Vi phạm INV-F2 |
| `PERIOD_LOCKED` | 409 | Ghi vào kỳ/ca đã khoá |
| `APPROVAL_NOT_EXECUTABLE` | 409 | Duyệt yêu cầu mà loại yêu cầu chưa có bộ thực hiện; không ghi gì |
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
| `SERVICE_UNAVAILABLE` | 503 | Dịch vụ phụ thuộc tự host (quét mã độc, lưu trữ file) tạm không dùng được; không ghi gì, thử lại sau (D-003) |

Bảng trên là **mã dùng chung**. Mã chỉ một tính năng dùng thì định nghĩa (HTTP, thông điệp) ở mục 6 của SPEC tương ứng; chỉ mục dưới đây để tránh trùng nghĩa. Thêm mã mới thì cập nhật chỉ mục này. Mã dùng ở ≥ 2 SPEC phải chuyển lên bảng chung. Khi code có, danh mục sinh từ `packages/app/src/errors.ts` và CI kiểm khớp.

| SPEC | Mã riêng |
|---|---|
| `SPEC-access-and-property.md` | `FEATURE_DISABLED` · `INVITATION_INVALID` · `LAST_OWNER` · `MFA_REQUIRED` · `ORG_CONTEXT_REQUIRED` · `PROPERTY_IN_USE` · `UNIT_CODE_TAKEN` · `UNIT_IN_USE` |
| `SPEC-audit-reporting.md` | `EXPORT_NOT_READY` · `REPORT_RANGE_TOO_LARGE` |
| `SPEC-import.md` | `IMPORT_CONFIRMATION_REQUIRED` · `IMPORT_HAS_ERRORS` · `IMPORT_TOTALS_MISMATCH` |
| `SPEC-inventory-allocation.md` | `BLOCK_CONFLICT` |
| `SPEC-lease.md` | `FINAL_PERIOD_NOT_ISSUED` · `HANDOVER_REQUIRED` · `LEASE_VERSION_OVERLAP` · `SETTLEMENT_REQUIRED` |
| `SPEC-ledger-payments.md` | `BANK_TRANSACTION_ALREADY_USED` · `EVIDENCE_REQUIRED` · `INBOX_HASH_MISMATCH` · `LEDGER_UNBALANCED` · `REFUND_EXCEEDS_BALANCE` · `SHIFT_ALREADY_OPEN` · `SHIFT_HAS_PENDING_PAYMENTS` · `SHIFT_NOT_OPEN` · `WEBHOOK_SIGNATURE_INVALID` |
| `SPEC-metering-billing.md` | `BILLING_PREVIEW_STALE` · `PERIOD_ISSUED` · `READINGS_INCOMPLETE` · `UNRESOLVED_ANOMALIES` |
| `SPEC-notifications.md` | `DELIVERY_NOT_RETRYABLE` · `PREFERENCE_REQUIRED` |
| `SPEC-portal.md` | `LINK_REVOKED` |
| `SPEC-reservation-stay.md` | `CAPACITY_EXCEEDED` · `NOTICE_TEMPLATE_MISSING` · `OUTSTANDING_BALANCE` · `RATE_NOT_CONFIGURED` · `ROOM_NOT_READY` |
| `SPEC-pwa.md` | `CLIENT_OUTDATED` · `NETWORK_TIMEOUT` · `RESULT_UNKNOWN` |

Lý do break đối soát (`HASH_MISMATCH`, `THIRD_PARTY_PAYER`, `WRONG_REFERENCE`…) và loại ngoại lệ (`LEASE_OVERSTAY`, `STAY_OVERSTAY`, `RELOCATION_REQUIRED`, `EXTENSION_CONFLICT`) là **giá trị dữ liệu**, không phải mã lỗi API; tương tự mã lỗi từng dòng import (`DUPLICATE_IN_FILE`, `NOT_INTEGER_VND`, `OUT_OF_RANGE`, `TOO_LONG`, `REFERENCE_NOT_FOUND`, `IMPORT_EXTERNAL_ID_CONFLICT`, `CONFLICT_AT_COMMIT`, `ALREADY_EXISTS`, `INVALID_FORMAT` — trả trong danh sách lỗi của batch) và lý do gửi thông báo (`NO_ADDRESS`, `OPTED_OUT`, `PROVIDER_TEMPORARY`, `RECIPIENT_INVALID`, `TEMPLATE_ERROR` — lưu ở `notification_deliveries`).

## 3. Webhook vào (`POST /api/v1/webhooks/{provider}/{account}`)
- Xác minh chữ ký/HMAC và timestamp theo nhà cung cấp, kiểm tài khoản nhận, ghi `inbox` với khoá unique `(provider, account, provider_event_id)`, rồi trả 2xx ngay. Xử lý thật diễn ra trong worker.
- Chữ ký sai → 401, không ghi `inbox` nhưng có log cảnh báo. Event trùng → 200 mà không tạo hiệu lực mới.
- Mọi nguồn (webhook, sao kê CSV, nhập tay kèm sao kê) quy về `bank_transactions` (INV-F4b) nên cùng một giao dịch ngân hàng chỉ tạo một payment.
- V1 chỉ có adapter **mô phỏng** (`provider = sim`) để test. Adapter thật chờ hợp đồng ngân hàng (F-016).
- Adapter `sim` (T-107): bật khi có `SIM_WEBHOOK_SECRET` (không thì 404); biến là DANH SÁCH khoá phân tách dấu phẩy (tối đa 3, mỗi khoá ≥ 32 ký tự) — nhận chữ ký của BẤT KỲ khoá nào để xoay khoá không gián đoạn (thử từng khoá, so sánh thời gian hằng). Header `x-hm-timestamp` (giây Unix, lệch ≤ 300 s) + `x-hm-signature` = hex HMAC-SHA256(secret, `${timestamp}.${account}.${body}`) (gắn tài khoản trong URL). Body JSON ≤ 64 KB: `{ event_id, bank_txn_ref, amount (đồng, nguyên dương), occurred_at (ISO có múi giờ), description?, balance_after? }`. Trả `200 { received: true, duplicate }` (`duplicate=true` khi event đã nhận hoặc giao dịch đã có từ nguồn khác); trùng mã khác nội dung → `409 INBOX_HASH_MISMATCH` + break `HASH_MISMATCH` giao owner.
- Worker nhận `bank_transaction.received` → khớp **đúng một** phiếu theo mã tham chiếu trong nội dung CK và không vượt số còn ⇒ thanh toán `confirmed` (`source = bank_auto`) + phân bổ; còn lại ⇒ break (`WRONG_REFERENCE`/`COMBINED`/`OVERPAID`/`UNMATCHED`) giao kế toán.
- Đường webhook miễn kiểm Origin (không dùng cookie; xác thực bằng chữ ký) — `requiresSameOrigin`.

## 4. Endpoint hệ thống
Danh sách đầy đủ command/query nằm ở `apps/web/openapi.json` (sinh từ registry); bảng dưới chỉ là route ngoài hoặc đặc biệt. Chế độ render/cache/quyền từng route: [`docs/ROUTES.md`](../ROUTES.md).

| Method | Path | Mục đích |
|---|---|---|
| GET | `/api/health` | Tiến trình còn sống (`{"status":"ok"}`); không cần phiên; không lộ phiên bản |
| GET | `/api/ready` | CSDL + kho file + máy quét; 200 sẵn sàng, 503 kèm thành phần lỗi (không chi tiết) |
| GET | `/api/metrics` | Prometheus text; `Authorization: Bearer <token dẫn xuất>`, chỉ nội bộ (RUNBOOK §1) |
| GET | `/api/version` | Phiên bản build + `min_client_version` (công khai, không dữ liệu người dùng; SPEC-pwa S-009) |
| GET | `/api/v1/me` | Người dùng, danh sách tổ chức/vai trò, tổ chức đang chọn |
| GET/POST | `/api/v1/me/consents` | Đồng ý theo mục đích của chính người đăng nhập (T-2310, D-122): GET trạng thái + lịch sử (`?download=1` tải JSON); POST `{purpose, granted, channel, policy_version?}` cho/rút cùng một bước — idempotent theo trạng thái (không cần `Idempotency-Key`), phiên bản văn bản cũ ⇒ 409 `VERSION_CONFLICT` |
| GET/POST | `/api/v1/me/data-requests` | Yêu cầu quyền chủ thể của chính người đăng nhập (T-2311, D-123): GET danh sách + `restricted_at`; POST `{type: access\|delete\|restrict, password?}` ⇒ 202 tạo mới / 200 đã có yêu cầu mở cùng loại (idempotent, không cần `Idempotency-Key`); xoá cần xác thực lại (phiên ≤ 5 phút hoặc `password`) ⇒ thiếu/sai 401 `REAUTH_REQUIRED` (`reason`), owner duy nhất 409 `LAST_OWNER`, quá hạn mức 429 |
| GET | `/api/v1/me/data-requests/{id}/download` | 303 tới URL ký ≤ 5 phút của gói JSON; chưa xong 409 `EXPORT_NOT_READY`, hết hạn 410 `LINK_EXPIRED`, không phải của mình 404 |
| GET/POST/DELETE | `/api/v1/organization/deletion` | Vòng đời xoá tổ chức đang chọn (T-2312, D-125; ngữ cảnh tổ chức như command, chạy được khi chờ xoá): GET trạng thái (mọi thành viên); POST `{password?}` chỉ owner, xác thực lại (phiên ≤ 5 phút hoặc `password`; 401 `REAUTH_REQUIRED`, 429 sau 5 lần/15 phút) ⇒ 202 mới / 200 đã chờ xoá; DELETE owner huỷ một bước ⇒ 200 `{cancelled}`; không phải owner 403. Khi tổ chức `pending_deletion`, MỌI thao tác có ngữ cảnh tổ chức khác trả **423 `ORG_PENDING_DELETION`** trừ `exports.requestOrgExport`, `exports.download`, `exports.getStatus`, `exports.listMine` và `GET /api/v1/commands/{id}` |
| GET | `/api/v1/commands/{command_id}` | Kết quả một command (chỉ người tạo hoặc quản lý xem được) |
| POST | `/api/v1/session/switchOrganization` | Đổi tổ chức/cơ sở đang chọn (cần `Idempotency-Key`) |
| POST | `/api/v1/files/upload` · `/api/v1/import/upload` | Tải file (thân là byte; quét mã độc, kiểm MIME bằng magic bytes) / tải file import |
| POST | `/api/v1/notifications/unsubscribe` | Huỷ đăng ký email bằng token ký, không phiên |
| GET | `/api/v1/portal/guest/stays/{id}` | Khách xem lượt ở bằng liên kết ký, không phiên |
| POST | `/api/v1/webhooks/{provider}/{account}` | Webhook vào (mục 3) |
| GET/POST | `/api/auth/*` | Better Auth: đăng nhập, phiên, 2FA (ADR-0002) |

**Nhật ký + truy cập hỗ trợ (T-2313, D-128).** `GET /api/v1/audit/listEvents` nhận thêm `actor_type` (`user`\|`worker`\|`platform_support`) cạnh `from`/`to`/`actor_person_id`/`action`/`entity_type`/`entity_id`/`correlation_id`/`cursor` (keyset)/`limit`; `exports.request` kind `audit` nhận thêm `filters.actor_person_id`/`action`/`entity_type` (cùng bộ lọc màn /nhat-ky). Truy cập hỗ trợ: `POST /api/v1/member/grantSupportAccess` `{email, reason (1–500), ttl_hours? (1–72, mặc định 24)}` ⇒ 201 `{invitationId, expiresAt}` (chỉ owner; 403 vai khác; 409 đã là thành viên/đang có lời mời); `POST /api/v1/member/revokeSupportAccess` `{invitation_id}` ⇒ 200 (chỉ owner, idempotent; 404 không có); `GET /api/v1/member/listSupportAccess` (owner/manager). Tài khoản vai `platform_support`: MỌI command có ngữ cảnh tổ chức + `files/upload`, `import/upload` ⇒ **403 `FORBIDDEN`** ngay sau xác định actor (trước Idempotency-Key/thân lệnh; không lưu idempotency); query ngoài danh sách chỉ đọc ⇒ 403/404 theo `authorize`; mỗi query/trang thành công để lại audit `support.accessed`. Hết hạn/thu hồi ⇒ 404 như không phải thành viên.
