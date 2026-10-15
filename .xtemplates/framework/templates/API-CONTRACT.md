---
title: Mẫu API-CONTRACT
kind: template
updated: 2026-10-14
---

# Mẫu API-CONTRACT.md — hợp đồng API trước khi chia việc

> **Ai viết:** người thiết kế API cùng hai bên tiêu thụ/cung cấp (front–back, service–service, agent–tool); duyệt **trước** khi hai bên làm song song. **Giai đoạn:** G3–G4.
> **Cổng dùng:** `PM-SPEC-005` (contract trước khi chia việc), `BE-API-*` ở [`../08-backend/api-design.md`](../08-backend/api-design.md), contract test ở [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md).
> **Nguồn sự thật là file máy đọc** (`openapi.yaml` theo OpenAPI **3.1.x** mặc định; 3.2.1 chỉ khi toàn chuỗi tool lint → codegen → mock đã kiểm — xem bẫy ở [`../04-standards/api-and-web-standards.md`](../04-standards/api-and-web-standards.md); schema JSON Schema 2020-12; gRPC `.proto`; sự kiện AsyncAPI); file Markdown này là bản tóm tắt + quyết định, trỏ tới file máy đọc. Lỗi theo **RFC 9457** (`application/problem+json`); ngừng hỗ trợ báo bằng header `Deprecation` (RFC 9745) và `Sunset` (RFC 8594).

````markdown
# API-CONTRACT — <Tên API> · phiên bản API v<N> · hợp đồng phiên bản <n> · <YYYY-MM-DD>

> Spec gốc: docs/specs/SPEC-<slug>.md (F-<NNN>) · File máy đọc: `api/openapi.yaml` (lint: `redocly lint`) · Duyệt: <bên A> + <bên B> ngày <...>
> Base URL: `https://api.<domain>/v<N>` · Xác thực: <Bearer JWT / session cookie / API key — nhà: 08-backend/authn-authz.md>

## 1. Nguyên tắc chung
- Định dạng: JSON UTF-8; thời gian ISO 8601 UTC (`2026-10-13T07:00:00Z`); tiền: số nguyên đơn vị nhỏ nhất + mã tiền tệ; ID: <UUID v7 / ULID / ...>
- Phân trang: `?cursor=<opaque>&limit=<n>` (mặc định <n>, tối đa <n>); phản hồi `{"data":[...],"next_cursor":"..."}`
- Idempotency: `Idempotency-Key: <uuid>` bắt buộc cho POST tạo tài nguyên có tác dụng phụ; lặp khoá → trả kết quả cũ (200/201), xung đột payload → 422
- Rate limit: <n>/phút theo <người dùng/khoá>; vượt → 429 + `Retry-After`
- Versioning: tiền tố `/v<N>`; thay đổi phá vỡ → tăng N; thay đổi tương thích (thêm trường tuỳ chọn) không đổi N; ngừng hỗ trợ: header `Deprecation: @<unix-time>` + `Sunset: <HTTP-date>` + `Link: <...>; rel="deprecation"`, thông báo trước ≥ <n> tháng

## 2. Endpoint
| Method | Path | Mục đích | Quyền | Request (schema) | Response thành công | Lỗi có thể |
|---|---|---|---|---|---|---|
| POST | `/v1/<resources>` | tạo <...> | <vai trò> | `#/components/schemas/<Resource>Create` | 201 `<Resource>` + `Location` | 400, 401, 403, 409, 422, 429 |
| GET | `/v1/<resources>/{id}` | đọc | chủ sở hữu hoặc admin | — | 200 `<Resource>` | 401, 403, 404 |
| GET | `/v1/<resources>` | danh sách | | `cursor`, `limit`, `filter[...]` | 200 danh sách phân trang | 400, 401 |
| PATCH | `/v1/<resources>/{id}` | sửa một phần | | `<Resource>Patch` | 200 | 400, 403, 404, 409, 422 |
| DELETE | `/v1/<resources>/{id}` | xoá (mềm/cứng?) | | — | 204 | 403, 404 |

## 3. Schema (tóm tắt — đầy đủ trong openapi.yaml / JSON Schema)
```yaml
<Resource>:
  type: object
  required: [id, <truong_bat_buoc>, created_at]
  properties:
    id: { type: string, format: uuid }
    <truong>: { type: string, maxLength: 200 }
    amount_minor: { type: integer, description: "đơn vị nhỏ nhất" }
    currency: { type: string, pattern: "^[A-Z]{3}$" }
    created_at: { type: string, format: date-time }
  additionalProperties: false
```

## 4. Lỗi (RFC 9457)
Mọi lỗi trả `Content-Type: application/problem+json`:
```json
{
  "type": "https://<domain>/problems/<ma-loi>",
  "title": "<Tóm tắt ngắn, cố định theo type>",
  "status": 422,
  "detail": "<Giải thích cho lần này, không lộ nội bộ>",
  "instance": "/v1/<resources>/<id>",
  "errors": [ { "field": "<truong>", "code": "<ma>", "message": "<...>" } ],
  "trace_id": "<id để tra log>"
}
```
| `type` (URI) | HTTP | Khi nào | Scenario |
|---|---|---|---|
| `.../problems/validation-failed` | 422 | payload sai schema/nghiệp vụ | S-<NNN> |
| `.../problems/not-found` | 404 | không có hoặc không có quyền thấy (không lộ tồn tại) | |
| `.../problems/conflict` | 409 | trùng khoá duy nhất / xung đột phiên bản | |
| `.../problems/rate-limited` | 429 | vượt hạn mức | |

## 5. Ví dụ (chạy được — dùng làm contract test)
```http
POST /v1/<resources> HTTP/1.1
Authorization: Bearer <token>
Idempotency-Key: 0f8c…
Content-Type: application/json

{ "<truong>": "…", "amount_minor": 150000, "currency": "VND" }
```
```http
HTTP/1.1 201 Created
Location: /v1/<resources>/<id>
Content-Type: application/json

{ "id": "<id>", "<truong>": "…", "amount_minor": 150000, "currency": "VND", "created_at": "2026-10-13T07:00:00Z" }
```

## 6. Sự kiện / webhook (nếu có)
| Sự kiện | Khi nào | Payload (schema) | Ký/xác thực | Thử lại |
|---|---|---|---|---|
| `<resource>.created` | sau commit | `<Resource>` | HMAC header `<tên>` | <n> lần, lùi theo cấp số nhân |

## 7. Kiểm & bằng chứng
- Lint: `npx @redocly/cli lint api/openapi.yaml` → 0 lỗi
- Contract test: `<schemathesis run api/openapi.yaml --base-url ...>` hoặc Pact → xanh trong CI
- Mock cho bên tiêu thụ: `<prism mock api/openapi.yaml>` — hai bên làm song song từ ngày <...>

## Thay đổi hợp đồng
| Phiên bản | Ngày | Thay đổi | Tương thích ngược? | Duyệt bởi |
|---|---|---|---|---|
| 1 | <ngày> | tạo | — | |
````
