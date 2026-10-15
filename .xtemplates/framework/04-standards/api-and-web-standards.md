---
title: Chuẩn API & web (OpenAPI 3.1, RFC 9457, OAuth 2.1, OIDC, JSON Schema, HTTP)
kind: standard
prefix: STD-API
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, cli-tool, library-sdk]
updated: 2026-10-14
---

# Chuẩn API & web (OpenAPI 3.1, RFC 9457, OAuth 2.1, OIDC, JSON Schema, HTTP)

> Phiên bản hiện hành của các chuẩn mô tả API, lỗi, HTTP, xác thực và schema; chọn chuẩn nào cho loại API nào; và
> cách chứng minh tuân thủ bằng lint/contract test. Thiết kế API ở [`../08-backend/api-design.md`](../08-backend/api-design.md);
> xác thực/phiên ở [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md).

## Nguyên tắc

- **Hợp đồng là file, không phải tài liệu.** OpenAPI/JSON Schema/AsyncAPI nằm trong repo, lint trong CI, sinh client/test từ đó (P5 — một nguồn sự thật).
- **Dùng RFC đã công bố làm căn cứ pháp lý; dùng draft làm hướng đi.** OAuth 2.1 vẫn là Internet-Draft (draft-16, 2026-09) — áp dụng các yêu cầu của nó (PKCE bắt buộc, bỏ implicit/ROPC) nhưng viện dẫn RFC 6749/7636 trong hợp đồng.
- **Lỗi có cấu trúc chuẩn.** Mọi lỗi HTTP trả `application/problem+json` (RFC 9457); client không phải đoán.
- **Ngữ nghĩa HTTP không thương lượng.** GET an toàn, PUT/DELETE idempotent, mã trạng thái đúng (RFC 9110). Bẻ cong ngữ nghĩa là bug.

## Quyết định

| Loại API / nhu cầu | Chuẩn mô tả | Chuẩn lỗi | Xác thực | Ghi chú |
|---|---|---|---|---|
| REST/HTTP JSON (mặc định) | OpenAPI **3.1.x** (mặc định an toàn vì tooling rộng); **3.2.x** khi tooling đã hỗ trợ (kiểm `spectral`/`redocly`/codegen đang dùng) | RFC 9457 | OAuth 2.0 + PKCE (theo yêu cầu OAuth 2.1), OIDC Core 1.0 cho đăng nhập | JSON Schema 2020-12 cho schema |
| Sự kiện/async (Kafka, MQTT, WebSocket) | AsyncAPI (phiên bản **chưa xác minh**) | Envelope lỗi tự định nghĩa theo mẫu Problem Details | mTLS/OAuth client credentials | Xem [`../08-backend/realtime-and-streaming.md`](../08-backend/realtime-and-streaming.md) |
| gRPC nội bộ | Protobuf IDL | `google.rpc.Status` | mTLS | Không cần OpenAPI; sinh REST gateway nếu công khai |
| GraphQL | GraphQL schema SDL | `errors[]` + `extensions.code` | như REST | Vẫn áp RFC 9110 cho lớp HTTP |
| Webhook gửi đi | OpenAPI `callbacks`/`webhooks` (3.1+) | — | Chữ ký HMAC trên payload canonical (RFC 8785) | Xem [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md) |
| SDK/CLI gọi API | Sinh từ OpenAPI | map Problem Details → exception có kiểu | — | Không viết client tay |

Mặc định: **OpenAPI 3.1.x + RFC 9457 + JSON Schema 2020-12 + OAuth 2.0/PKCE + OIDC Core**. Không dùng OpenAPI 2.0 (Swagger) cho dự án mới; 3.0.x chỉ khi tooling bắt buộc (ghi ADR).

## Bảng phiên bản hiện hành (xác minh 2026-10-13)

| Chuẩn | Phiên bản | Phát hành | URL | Áp dụng khi | Chứng minh tuân thủ |
|---|---|---|---|---|---|
| OpenAPI Specification | **3.2.1** (mới nhất); 3.1.x vẫn hợp lệ | 2026-09-10 | <https://spec.openapis.org/oas/latest.html> | Mọi HTTP API | `openapi:` trong file + lint 0 lỗi + contract test |
| RFC 9457 Problem Details for HTTP APIs | Proposed Standard (thay RFC 7807) | 2023-07 | <https://www.rfc-editor.org/rfc/rfc9457> | Mọi phản hồi lỗi | Test content-type `application/problem+json` + 5 trường chuẩn |
| RFC 9110 HTTP Semantics (STD 97) + 9111 Caching, 9112 HTTP/1.1, 9113 HTTP/2, 9114 HTTP/3 | Internet Standard | 2022-06 | <https://www.rfc-editor.org/rfc/rfc9110> | Mọi HTTP | Lint rule (GET không body), test idempotency, `curl --http2` |
| OAuth 2.1 | **draft-ietf-oauth-v2-1-16** (Internet-Draft, chưa RFC; WG dự kiến nộp IESG 12/2026) | 2026-09-03 | <https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/> | Mọi uỷ quyền | Test: PKCE bắt buộc, `response_type=token` bị từ chối |
| OpenID Connect Core 1.0 | incorporating errata set 2 | 2023-12-15 | <https://openid.net/specs/openid-connect-core-1_0.html> | Đăng nhập SSO | Test validate ID token (iss, aud, exp, nonce, chữ ký) |
| JSON Schema | **2020-12** (hiện hành) | 2020-12 | <https://json-schema.org/specification> | Schema dữ liệu, OpenAPI 3.1+ | `$schema` đúng dialect; validator chạy trong test |
| RFC 8785 JSON Canonicalization Scheme | Informational | 2020-06 | <https://www.rfc-editor.org/rfc/rfc8785> | Ký/hash JSON (webhook, audit) | Test vector canonical hoá |

## Checklist

- [ ] `STD-API-001` **MUST** Mọi HTTP API công khai/đối tác có file OpenAPI trong repo khai báo `openapi: 3.1.x` hoặc `3.2.x`. → Kiểm: `grep -E "^openapi: 3\.(1|2)\.[0-9]+" openapi.yaml`. · Nguồn: OAS 3.2.1 §4.1 (OpenAPI Object)
- [ ] `STD-API-002` **MUST@L** File OpenAPI lint trong CI với bộ rule `spectral:oas` (hoặc Redocly `recommended`) 0 lỗi. → Kiểm: job CI `spectral lint openapi.yaml --fail-severity=error` exit 0. · Nguồn: OAS 3.2.1
- [ ] `STD-API-003` **MUST@L** Mọi phản hồi lỗi (4xx/5xx) là `application/problem+json` với `type`, `title`, `status`, `detail`, `instance`; `status` trong body = mã HTTP. → Kiểm: contract test gọi 1 endpoint lỗi và assert content-type + 5 trường; schema `Problem` có trong OpenAPI. · Nguồn: RFC 9457 §3
- [ ] `STD-API-004` **MUST@L** Không endpoint GET/HEAD nào có `requestBody` hoặc gây tác dụng phụ; PUT/DELETE idempotent. → Kiểm: Spectral rule tuỳ chỉnh cấm `requestBody` dưới `get`; test gọi PUT 2 lần cho cùng trạng thái. · Nguồn: RFC 9110 §9.2.1, §9.2.2
- [ ] `STD-API-005` **MUST@M** Uỷ quyền OAuth: PKCE bắt buộc cho mọi client, không cấp implicit (`response_type=token`) và không ROPC (`grant_type=password`). → Kiểm: test tích hợp gửi `response_type=token` nhận lỗi; cấu hình authorization server `require_pkce: true`. · Nguồn: draft-ietf-oauth-v2-1-16 (PKCE, bỏ implicit/ROPC)
- [ ] `STD-API-006` **MUST@M** Đăng nhập OIDC validate ID token đầy đủ: chữ ký, `iss`, `aud`, `exp`, `nonce`. → Kiểm: unit test với token sửa từng trường đều bị từ chối. · Nguồn: OIDC Core 1.0 §3.1.3.7
- [ ] `STD-API-007` **MUST@L** Schema JSON độc lập dùng dialect 2020-12 (`"$schema": "https://json-schema.org/draft/2020-12/schema"`) và validator hỗ trợ 2020-12 chạy trong test. → Kiểm: `grep -rl "draft/2020-12" schemas/`; test validate mẫu hợp lệ/không hợp lệ. · Nguồn: JSON Schema 2020-12
- [ ] `STD-API-008` **MUST@M** Thay đổi phá vỡ hợp đồng (xoá field, đổi kiểu, bỏ endpoint) bị chặn ở PR trừ khi tăng major version. → Kiểm: job `oasdiff breaking base.yaml head.yaml` exit 0 hoặc PR có nhãn `breaking` + bump major. · Nguồn: SemVer 2.0.0 §8 (xem [`process-and-quality-standards.md`](process-and-quality-standards.md))
- [ ] `STD-API-009` **SHOULD** Payload được ký/hash (webhook, audit) canonical hoá theo RFC 8785 trước khi ký. → Kiểm: test với vector mẫu của RFC 8785 ra đúng chuỗi.
- [ ] `STD-API-010` **SHOULD** Header cache (`Cache-Control`, `ETag`/`Last-Modified`) theo RFC 9111 cho GET có thể cache; test 304. → Kiểm: test gửi `If-None-Match` nhận 304.
- [ ] `STD-API-011` **SHOULD** Biên (edge/LB) bật HTTP/2 hoặc HTTP/3. → Kiểm: `curl -sI --http2 https://<domain>` dòng đầu `HTTP/2`.
- [ ] `STD-API-012` **SHOULD** Tài liệu/hợp đồng viện dẫn RFC đã công bố (RFC 6749, 7636) và ghi rõ OAuth 2.1 là draft kèm số draft. → Kiểm: `grep -rn "OAuth 2.1" docs/ | grep -v draft` không khớp.
- [ ] `STD-API-013` **SHOULD** Fuzz API theo spec (Schemathesis) trong CI nightly, 0 lỗi 5xx. → Kiểm: `schemathesis run openapi.yaml --checks all` báo cáo 0 failure.
- [ ] `STD-API-014` **MAY** API sự kiện mô tả bằng AsyncAPI và lint tương tự OpenAPI.
- [ ] `STD-API-015` **MAY** Ký thông điệp HTTP theo RFC 9421 HTTP Message Signatures cho webhook/B2B (phiên bản **chưa xác minh** ngày 2026-10-13).

## Bẫy thường gặp

- **Nhảy lên OpenAPI 3.2 khi tooling chưa theo.** Codegen/lint có thể từ chối hoặc bỏ qua tính năng mới. Cách tránh: chạy toàn bộ chuỗi (lint → codegen → mock) với 3.2 trong nhánh thử trước; ghi ADR.
- **3.0 `nullable: true` sang 3.1.** 3.1 dùng `type: [string, "null"]`; convert tự động hay sót. Cách tránh: lint + test schema với giá trị null.
- **`status` trong Problem Details khác mã HTTP** hoặc trả 200 kèm body lỗi. Cách tránh: STD-API-003 assert cả hai.
- **`type` của Problem Details là URL không giải quyết được.** RFC cho phép `about:blank`, nhưng URL "bịa" làm client tưởng có tài liệu. Cách tránh: `type` trỏ tới trang docs thật hoặc để `about:blank`.
- **GET có body / DELETE không idempotent** (xoá lần 2 trả 500). Cách tránh: STD-API-004; DELETE lần 2 trả 404 hoặc 204 theo quy ước ghi rõ.
- **Thư viện OAuth vẫn mặc định implicit/ROPC.** Cách tránh: tắt tường minh, test từ chối (STD-API-005).
- **Nhầm dialect JSON Schema.** draft-07 (`definitions`, `items` dạng mảng) vs 2020-12 (`$defs`, `prefixItems`). Cách tránh: `$schema` tường minh; một validator duy nhất.
- **Số nguyên 64-bit trong JSON.** JS mất chính xác > 2^53. Cách tránh: ID/số tiền lớn dạng chuỗi (`format: int64` + ghi chú), xem [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Spectral (Apache-2.0) | `spectral lint openapi.yaml --ruleset .spectral.yaml --fail-severity=error` | pre-commit + CI | 0 error |
| Redocly CLI (MIT) — thay thế | `redocly lint openapi.yaml` | CI | 0 error |
| oasdiff (Apache-2.0) | `oasdiff breaking origin/main:openapi.yaml openapi.yaml --fail-on ERR` | CI PR | 0 breaking (trừ PR major) |
| Schemathesis 4.31.0 (MIT) | `schemathesis run openapi.yaml --url https://staging… --checks all` | CI nightly | 0 failure |
| Contract test (Pact/Dredd hoặc test HTTP tự viết) | xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md) | CI | 100% endpoint trong spec có ≥ 1 test |
| ajv (MIT) / jsonschema (Python, MIT) | validate dialect 2020-12 trong unit test | CI | 0 lỗi |
| curl | `curl -sI --http2 https://<domain>` | smoke sau deploy | `HTTP/2` hoặc `HTTP/3` |

Phiên bản Spectral, Redocly, oasdiff: **chưa xác minh** ngày 2026-10-13 — tra registry trước khi ghim.

## Nguồn

- OpenAPI Specification 3.2.1 (2026-09-10): <https://spec.openapis.org/oas/latest.html> — xác minh 2026-10-13
- RFC 9457 Problem Details (07/2023, obsoletes RFC 7807): <https://www.rfc-editor.org/rfc/rfc9457> · <https://datatracker.ietf.org/doc/rfc9457/> — xác minh 2026-10-13
- RFC 9110 HTTP Semantics (STD 97, 06/2022): <https://www.rfc-editor.org/rfc/rfc9110> — xác minh 2026-10-13
- OAuth 2.1 draft-ietf-oauth-v2-1-16 (2026-09-03, I-D): <https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/> — xác minh 2026-10-13
- OpenID Connect Core 1.0 errata set 2 (2023-12-15): <https://openid.net/specs/openid-connect-core-1_0.html> — xác minh 2026-10-13
- JSON Schema 2020-12: <https://json-schema.org/specification> — xác minh 2026-10-13
- RFC 8785 JCS (06/2020, Informational): <https://www.rfc-editor.org/rfc/rfc8785> — xác minh 2026-10-13
- Schemathesis 4.31.0: <https://pypi.org/pypi/schemathesis/json> — xác minh 2026-10-13
- MCP 2026-07-28 yêu cầu JSON Schema 2020-12 đầy đủ cho `inputSchema/outputSchema` và validate `iss` theo RFC 9207: `research/2026-10-13-ai-agent-research.md` §2.1 (đọc 2026-10-13).
