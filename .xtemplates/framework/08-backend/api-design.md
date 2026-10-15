---
title: Thiết kế API: REST/GraphQL/gRPC, lỗi RFC 9457, phân trang, versioning, OpenAPI
kind: module
prefix: BE-API
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Thiết kế API: REST/GraphQL/gRPC, lỗi RFC 9457, phân trang, versioning, OpenAPI

> Quy ước để một API **đoán được, kiểm được bằng máy và không gãy client khi tiến hoá**: chọn kiểu API theo
> điều kiện, lỗi theo RFC 9457, phân trang cursor, versioning có kế hoạch, hợp đồng OpenAPI là nguồn sự thật,
> validate tại biên. Áp dụng cho mọi dịch vụ có HTTP/gRPC endpoint, bất kể stack.

## Nguyên tắc

1. **Hợp đồng trước, code sau.** Spec (OpenAPI/`.proto`/SDL) là nguồn sự thật duy nhất (P5); client, test
   contract và tài liệu đều sinh từ nó — hoặc spec sinh từ code kèm test so khớp, không viết tay hai nơi.
2. **Không tin đầu vào (P6).** Mọi body/query/path/header được validate lúc chạy bằng schema; lỗi validate trả
   4xx có cấu trúc, không bao giờ 500.
3. **Lỗi là một phần của API.** Mọi lỗi có cùng một hình dạng máy đọc được (RFC 9457), có `type` ổn định để
   client rẽ nhánh, không lộ stack trace.
4. **Thay đổi tương thích ngược là mặc định.** Thêm trường/endpoint mới thì không cần version; đổi nghĩa hay bỏ
   trường mới cần phiên bản mới kèm thời hạn ngừng hỗ trợ.
5. **Idempotent ở nơi có retry.** PUT/DELETE idempotent theo RFC 9110; POST tạo tài nguyên cần `Idempotency-Key`
   khi client có thể gửi lại (thanh toán, đặt hàng).

## Quyết định

| Nhu cầu | Chọn | Khi nào KHÔNG dùng |
|---|---|---|
| API công khai / cho nhiều client khác nhau, cache HTTP quan trọng | **REST + JSON + OpenAPI** (mặc định) | Client cần gộp nhiều tài nguyên theo hình dạng tuỳ ý trong một round-trip |
| Frontend nhiều màn hình với nhu cầu dữ liệu khác nhau, một đội kiểm soát cả client lẫn server | **GraphQL** (persisted documents cho client first-party) | API mở cho bên thứ ba không kiểm soát được (chi phí truy vấn khó chặn); cần cache CDN theo URL |
| Service-to-service nội bộ, streaming hai chiều, hiệu năng/độ trễ quan trọng, đa ngôn ngữ | **gRPC** (protobuf, deadline bắt buộc) | Client là trình duyệt (cần gRPC-Web/proxy); API công khai cần debug bằng curl |
| Thao tác không ánh xạ sang tài nguyên (tính toán, lệnh) | REST với endpoint động từ (`POST /orders/{id}:cancel`) hoặc RPC rõ ràng | Giả tạo "tài nguyên" để ép REST thuần |
| Phân trang | **Cursor/keyset** (token mờ, ổn định khi dữ liệu đổi) | Chỉ dùng offset khi tập dữ liệu nhỏ, tĩnh, cần nhảy trang tuỳ ý |
| Versioning | **Không version khi chỉ thêm**; khi phá vỡ: version theo URL (`/v2/`) hoặc header ngày (`API-Version: 2026-10-13`) có bảng thời hạn | Version theo query string (khó cache, dễ quên) |
| Spec ↔ code | **Spec-first** khi nhiều đội/ngôn ngữ cùng dùng; **code-first có sinh spec + test so khớp** khi một đội TS/Python | Viết spec tay rời code, không có cổng so khớp |

Mặc định khuyến nghị: REST + OpenAPI **3.1.x** + validate bằng schema của ngôn ngữ (zod / pydantic / validator); OpenAPI 3.2.x chỉ khi toàn chuỗi tool (lint → codegen → mock) đã kiểm — xem bẫy ở [`../04-standards/api-and-web-standards.md`](../04-standards/api-and-web-standards.md).
Chỉ đổi khi có điều kiện ở cột "Chọn" rõ ràng và ghi ADR ([`../05-architecture/decision-records.md`](../05-architecture/decision-records.md)).

## Checklist

- [ ] `BE-API-001` **MUST** Có hợp đồng API máy đọc được (OpenAPI 3.1+/`.proto`/GraphQL SDL) commit trong repo, là nguồn sự thật duy nhất cho endpoint, kiểu dữ liệu, mã lỗi. → Kiểm: file spec tồn tại; CI chạy linter spec (`spectral lint`/`buf lint`) exit 0. · Nguồn: ASVS 5.0 V4
- [ ] `BE-API-002` **MUST@L** Spec và code không lệch nhau: hoặc sinh server/client từ spec, hoặc sinh spec từ code và test so khớp (`openapi diff`) chạy trong CI. → Kiểm: job CI đỏ khi sửa handler mà không cập nhật spec (hoặc ngược lại). · Nguồn: ASVS 5.0 V4
- [ ] `BE-API-003` **MUST** Mọi đầu vào (body, query, path, header, cookie) được validate lúc chạy bằng schema (zod / pydantic / go-playground validator / Bean Validation) trước khi vào logic nghiệp vụ. → Kiểm: test gửi body thiếu trường, sai kiểu, quá dài → 400/422 có cấu trúc, không 500. · Nguồn: ASVS 5.0 V2, OWASP REST Security Cheat Sheet
- [ ] `BE-API-004` **MUST@L** Lỗi trả về theo RFC 9457 (`application/problem+json` với `type`, `title`, `status`, `detail`, `instance`), `type` là URI ổn định; không lộ stack trace/SQL/đường dẫn nội bộ. → Kiểm: test lỗi 4xx/5xx assert `Content-Type` và các trường; grep response không chứa `at ` stack frame. · Nguồn: RFC 9457, OWASP REST Security Cheat Sheet
- [ ] `BE-API-005` **MUST@L** Validate `Content-Type` của request có body (415 nếu không hỗ trợ) và `Accept` (406); giới hạn kích thước body (413) ở mức cấu hình được. → Kiểm: test gửi `Content-Type: text/plain` vào endpoint JSON → 415; body vượt giới hạn → 413. · Nguồn: OWASP REST Security Cheat Sheet, RFC 9110
- [ ] `BE-API-006` **MUST@L** Endpoint danh sách có phân trang từ ngày đầu, token mờ (không phải offset lộ), có `page_size` tối đa và sắp xếp ổn định (khoá tie-break duy nhất). → Kiểm: test gọi không có `page_size` → mặc định; `page_size` vượt max → bị kẹp; chèn bản ghi giữa hai trang không trùng/mất phần tử. · Nguồn: Google AIP-158
- [ ] `BE-API-007` **MUST@L** Thay đổi phá vỡ (bỏ/đổi nghĩa trường, đổi mã lỗi) đi qua phiên bản mới kèm ngày ngừng hỗ trợ bản cũ ghi trong spec và CHANGELOG; không sửa tại chỗ bản đang dùng. → Kiểm: `openapi diff --fail-on-incompatible` trong CI đỏ khi diff breaking trên cùng version. · Nguồn: SemVer 2.0.0 §8
- [ ] `BE-API-008` **MUST** Hợp đồng HTTP của idempotency cho POST có thể bị gửi lại (thanh toán, đặt hàng, gửi tin): header `Idempotency-Key`; thiếu key ở endpoint bắt buộc → 400; cùng key + cùng payload → trả lại response cũ; cùng key + payload khác → 422; request cùng key đang xử lý → 409; key lưu ở store dùng chung **≥ 24 giờ**; ghi trong OpenAPI. Nguyên tắc: xem [`ARC-INT-001`](../05-architecture/integration-patterns.md) và `ARC-INT-002`. → Kiểm: test gửi 2 lần cùng key → 1 bản ghi, cùng response; payload khác → 422; gửi đồng thời → 409. · Nguồn: draft-ietf-httpapi-idempotency-key-header-07, Stripe Idempotent requests
- [ ] `BE-API-009` **MUST** Mọi endpoint không công khai kiểm xác thực + phân quyền ở server theo [`authn-authz.md`](authn-authz.md); endpoint công khai được liệt kê rõ trong spec (`security: []`). → Kiểm: test gọi không token → 401; token người khác → 403/404; script liệt kê route không có guard = danh sách công khai đã duyệt. · Nguồn: ASVS 5.0 V4, V8
- [ ] `BE-API-010` **MUST@L** Chỉ cho phép phương thức HTTP cần thiết trên mỗi route (405 cho phần còn lại); GET/HEAD không gây tác dụng phụ. → Kiểm: test `DELETE` lên route chỉ GET → 405; review không có GET làm thay đổi dữ liệu. · Nguồn: RFC 9110 §9.2.1, OWASP REST Security Cheat Sheet
- [ ] `BE-API-011` **MUST@L** Giới hạn tốc độ (429 + `Retry-After`) trên endpoint công khai và endpoint đắt; chi tiết ở [`reliability-and-errors.md`](reliability-and-errors.md). → Kiểm: test bắn vượt ngưỡng → 429 có `Retry-After`. · Nguồn: RFC 6585 §4
- [ ] `BE-API-012` **MUST@L** GraphQL: giới hạn độ sâu, độ phức tạp/chi phí, số operation trong batch, số alias; tắt introspection ngoài dev và che chi tiết lỗi; client first-party dùng persisted documents. → Kiểm: test truy vấn lồng vượt độ sâu → bị từ chối trước khi thực thi; `__schema` ở prod → lỗi. · Nguồn: graphql.org/learn/security
- [ ] `BE-API-013` **MUST@L** gRPC: mọi RPC client đặt deadline; server huỷ việc khi deadline qua; deadline lan truyền sang call xuôi dòng; có health service `grpc.health.v1`. → Kiểm: lint/grep client không có `WithTimeout`/deadline; test RPC chậm → `DEADLINE_EXCEEDED`. · Nguồn: grpc.io Deadlines, Health Checking
- [ ] `BE-API-014` **SHOULD** Tài nguyên có `ETag`; cập nhật dùng `If-Match` → 412 khi xung đột (chống lost update); GET có `If-None-Match` → 304. → Kiểm: test hai client cập nhật cùng bản ghi với ETag cũ → 412. · Nguồn: RFC 9110 §13, RFC 6585 §3
- [ ] `BE-API-015` **SHOULD** Đặt tên và hình dạng nhất quán: tài nguyên danh từ số nhiều, trường `snake_case` hoặc `camelCase` thống nhất toàn API, thời gian ISO 8601 UTC, tiền là chuỗi số nguyên đơn vị nhỏ nhất + mã tiền tệ (xem [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)). → Kiểm: rule Spectral tuỳ chỉnh về casing/format chạy trong CI.
- [ ] `BE-API-016` **SHOULD** Có test contract (consumer-driven hoặc so khớp spec) cho mỗi client nội bộ; chi tiết [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md). → Kiểm: job contract test trong CI.
- [ ] `BE-API-017` **SHOULD** Trường mở rộng/đầu vào không biết: server bỏ qua trường lạ có kiểm soát (hoặc từ chối rõ ràng) và ghi trong spec (`additionalProperties`); không cho phép mass assignment vào trường nhạy cảm (`role`, `is_admin`). → Kiểm: test gửi `is_admin: true` vào endpoint sửa hồ sơ → bị bỏ qua/400. · Nguồn: ASVS 5.0 V2
- [ ] `BE-API-018` **SHOULD** CORS: chỉ origin cụ thể, không `*` trên endpoint có xác thực; header bảo mật (`Cache-Control: no-store` cho dữ liệu người dùng, `X-Content-Type-Options: nosniff`). → Kiểm: test preflight từ origin lạ → không có `Access-Control-Allow-Origin`. · Nguồn: OWASP REST Security Cheat Sheet
- [ ] `BE-API-019` **SHOULD** Tài liệu API sinh từ spec (Redoc/Scalar/Swagger UI) và publish theo môi trường; ví dụ request/response trong spec chạy được. → Kiểm: job build docs từ spec; ví dụ validate qua `spectral`/`redocly lint`.
- [ ] `BE-API-020` **SHOULD** Lọc/sắp xếp có danh sách trường cho phép (allowlist), không nhận biểu thức tuỳ ý từ client. → Kiểm: test `sort=password` hoặc `filter=(evil)` → 400.
- [ ] `BE-API-021` **MAY** Endpoint batch (nhiều thao tác/một request) có giới hạn số phần tử và trả kết quả từng phần (207 hoặc mảng trạng thái). → Kiểm: test batch vượt giới hạn → 400.
- [ ] `BE-API-022` **MAY** Hỗ trợ `fields`/`expand` để client chọn trường, có allowlist. → Kiểm: test trường ngoài allowlist → bị bỏ qua hoặc 400.
- [ ] `BE-API-023` **MAY** Phát hành SDK client sinh tự động từ spec theo SemVer, đồng bộ CHANGELOG với API. → Kiểm: pipeline sinh SDK chạy từ spec, không sửa tay.

## Bẫy thường gặp

- **Trả 200 kèm `{ "error": ... }`.** Client, proxy, cache, monitoring đều coi là thành công. Dùng mã trạng thái đúng + RFC 9457.
- **Offset pagination trên bảng lớn, dữ liệu thay đổi.** Trang trùng/mất phần tử, `OFFSET 1000000` quét toàn bảng. Dùng keyset theo `(created_at, id)`.
- **Validate ở frontend rồi tin ở backend.** Server Action/Route Handler là POST công khai (catalog 09 §1.4): validate lại ở server, luôn.
- **Dựa vào `Content-Type` client gửi để parse.** Phải validate và từ chối (415), không "đoán" JSON từ text.
- **Version "v2" cho mọi thay đổi nhỏ.** Chi phí duy trì N phiên bản; chỉ version khi phá vỡ, còn lại thêm trường tương thích.
- **Spec viết tay, không có cổng so khớp.** Sau 2 tháng spec và code lệch nhau; client sinh từ spec gọi sai. Phải có `openapi diff`/test contract trong CI.
- **GraphQL mở cho công chúng không giới hạn chi phí.** Một truy vấn lồng 10 tầng đánh sập DB. Giới hạn độ sâu/chi phí trước khi thực thi.
- **gRPC không deadline.** Mặc định gRPC không đặt deadline → client treo vô hạn khi server chậm.
- **Lộ ID tự tăng và không kiểm quyền theo object.** IDOR: `GET /invoices/1234` của người khác. Kiểm quyền từng object ([`authn-authz.md`](authn-authz.md)); UUID không thay thế kiểm quyền.
- **Idempotency-Key chỉ lưu trong RAM một instance.** Retry rơi vào instance khác → tạo trùng. Lưu key ở store dùng chung (DB/Redis) với TTL.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng / ghi chú |
|---|---|---|---|
| Spectral (Apache-2.0) | `spectral lint openapi.yaml --fail-severity=warn` | pre-commit + CI | 0 warning; ruleset `spectral:oas` + rule casing riêng |
| Redocly CLI (MIT) | `redocly lint openapi.yaml` · `redocly build-docs` | CI | Thay thế Spectral; sinh docs tĩnh |
| oasdiff (Apache-2.0) | `oasdiff breaking base.yaml head.yaml --fail-on ERR` | CI (PR) | Đỏ khi breaking trên cùng version |
| buf (Apache-2.0) | `buf lint` · `buf breaking --against '.git#branch=main'` | CI | gRPC/protobuf |
| Schema runtime | zod 4.6.7 · pydantic 2.14.1 · go-playground/validator v10.30.5 (xác minh 2026-10-13) | code + unit test | Test đầu vào xấu cho mỗi endpoint |
| Contract test | Pact / Schemathesis (`schemathesis run openapi.yaml`) | CI | Schemathesis fuzz theo spec, 0 lỗi 5xx |
| Route guard scan | script tự viết liệt kê route thiếu middleware auth (ý tưởng `check:route-perms`, catalog 23 §4.3) | CI | Danh sách = allowlist công khai đã duyệt |

## Nguồn

- RFC 9457 Problem Details for HTTP APIs (obsoletes RFC 7807, Proposed Standard): <https://www.rfc-editor.org/rfc/rfc9457> — xác minh 2026-10-13
- RFC 9110 HTTP Semantics (STD 97; §9.2.1 safe, §9.2.2 idempotent, §13 conditional): <https://www.rfc-editor.org/rfc/rfc9110> — xác minh 2026-10-13
- RFC 6585 Additional HTTP Status Codes (428, 429, 431): <https://www.rfc-editor.org/rfc/rfc6585> — xác minh 2026-10-13
- OpenAPI Specification 3.2.1 (10/09/2026; có `query` method, sequential/streaming media types): <https://spec.openapis.org/oas/latest.html> — xác minh 2026-10-13
- GraphQL Specification bản September 2025 (03/09/2025), working draft 2026-09-28: <https://spec.graphql.org/> — xác minh 2026-10-13; bảo mật: <https://graphql.org/learn/security/> — xác minh 2026-10-13
- gRPC Deadlines: <https://grpc.io/docs/guides/deadlines/> · Health Checking: <https://grpc.io/docs/guides/health-checking/> — xác minh 2026-10-13
- Google AIP-158 Pagination (token mờ, `page_size`, hết hạn ~3 ngày): <https://google.aip.dev/158> — xác minh 2026-10-13
- draft-ietf-httpapi-idempotency-key-header-07 (**Expired** 2025-10-15, chưa là RFC): <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/> — xác minh 2026-10-13; thực hành tham chiếu: Stripe Idempotent requests (key ≤255 ký tự, lưu 24 giờ, khác payload → lỗi) <https://docs.stripe.com/api/idempotent_requests> — xác minh 2026-10-13
- OWASP REST Security Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 (V2 Validation, V4 API and Web Service, V8 Authorization): <https://owasp.org/www-project-application-security-verification-standard/> — xác minh 2026-10-13
- Phiên bản thư viện (registry, xác minh 2026-10-13): zod 4.6.7, pydantic 2.14.1, go-playground/validator v10.30.5, @stoplight/spectral-cli 6.17.0, @redocly/cli 2.62.1, openapi-typescript 7.13.0, @hono/zod-openapi 1.6.3 — **xác minh lại trước khi dùng**.
- (chưa xác minh) phiên bản oasdiff, buf, Schemathesis — không tra registry ngày 2026-10-13.
- `research/2026-10-13-stored-catalog-extraction.md` §2.5 (Server Action là POST công khai), §2.7 (cổng tĩnh route-perms); catalog `09-engineering-checklists` §1.4.
