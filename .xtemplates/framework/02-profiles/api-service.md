---
title: Backend / API / dịch vụ
kind: profile
slug: api-service
prefix: PRF-API
modules: [04-standards/*, 05-architecture/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Backend / API / dịch vụ

> Dịch vụ không có (hoặc chỉ có tối thiểu) giao diện người dùng: REST/GraphQL/gRPC, job nền, microservice, BFF.
> Cổng chất lượng xoay quanh **hợp đồng API ổn định, p95 latency, bảo mật xác thực/phân quyền, vận hành được
> trong container**. Thay thế trọn bộ cổng UI/web (CWV, a11y, theme) bằng cổng tương đương ở bảng cuối.

## Khi nào dùng

- Sản phẩm chính là API cho client khác (web, mobile, đối tác, agent) hoặc dịch vụ nội bộ trong hệ phân tán.
- Có UI nhưng UI là thành phần riêng → chọn `web-app`/`mobile-app` cho UI và ghép thêm blueprint `api-service` cho backend
  (hoặc hồ sơ `monorepo`).
- **Không** dùng cho: pipeline dữ liệu/ML (→ `data-ml`), agent LLM (→ `ai-agent`), công cụ chạy cục bộ (→ `cli-tool`).

## Kiến trúc tham chiếu

```text
[Client: web / mobile / đối tác / agent]
        │ HTTPS (OpenAPI 3.x hợp đồng) · auth (OIDC/JWT/API key) · rate limit
        ▼
[Edge: gateway / LB]  ── TLS, WAF, quota, request-id, traceparent
        ▼
[Service (stateless, container)] ── /healthz /readyz · graceful shutdown · 12-factor config
   │            │                │
   ▼            ▼                ▼
[PostgreSQL]  [Cache: Valkey/Redis]  [Queue/outbox → worker]  ── job nền, webhook, tích hợp
   │
[Observability: log JSON + metric + trace OTel] → [Alert theo SLO]
```

Nguyên tắc: service **stateless** (state ở DB/cache/queue), một hợp đồng API là nguồn sự thật (sinh client/SDK, test
contract, tài liệu từ cùng một file), mọi lỗi theo một định dạng, mọi cuộc gọi ra ngoài có timeout.

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** từ endoflife.date / PyPI / npm / GitHub Releases — **xác minh lại trước khi dùng**.
Quy tắc chọn phiên bản (né `x.0.0` mới ra, ưu tiên LTS): xem [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md).

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Ngôn ngữ/runtime | Python (đội data/AI) · Node.js LTS (đội JS) · Go (hiệu năng, binary tĩnh) | Python 3.14.8 (3.15.0 ra 2026-10-09 — khuyến nghị 3.14.x tới khi có 3.15.1); Node 24 LTS 24.21.0 (22 LTS tới 2027-04); Go 1.27.2 | Java/Spring Boot 4.1.1 khi doanh nghiệp đã chuẩn Java; .NET/Rust khi đội có sẵn |
| Khung API | FastAPI (Py) · NestJS hoặc Hono/Fastify (TS) · net/http + chi (Go) | fastapi 0.143.0 (2026-10-08) · `@nestjs/core` 12.1.3 · hono 4.13.13 · fastify 5.12.6 | Django 5.2 LTS (5.2.18) khi cần admin/ORM đầy đủ; Django 6.1.2 không LTS |
| Hợp đồng API | OpenAPI (sinh từ code có kiểm, hoặc contract-first) | OAS 3.2.1 (2026-09-10); tối thiểu 3.1 | gRPC/protobuf cho nội bộ hiệu năng cao; AsyncAPI cho event |
| Định dạng lỗi | RFC 9457 `application/problem+json` | RFC 9457 (obsoletes 7807) | — (bắt buộc) |
| CSDL | PostgreSQL | 18.6 (2026-08-11); 17.11 còn hỗ trợ tới 2029-11 | Xem [`../09-database/README.md`](../09-database/README.md) |
| Cache/KV | Valkey (BSD-3) | 9.1.2 (2026-08-31) | Redis 8.10.2 (2026-09-17) — **kiểm license** trước khi dùng (đa license, không thuần OSI) |
| Quản lý gói Python | uv + ruff | uv 0.13.0 · ruff 0.17.0 (2026-10-09; vẫn 0.x, ghim minor) | pip-tools/poetry nếu đã có |
| Lint OpenAPI | Spectral | `@stoplight/spectral-cli` 6.17.0 | Redocly CLI |
| Diff breaking API | oasdiff | v1.33.0 (2026-10-01) | — |
| Contract/property test | Schemathesis (từ OpenAPI) · Pact (consumer-driven) | schemathesis 4.31.0 (2026-10-12) · `@pact-foundation/pact` 17.1.4 | Dredd (ít bảo trì) |
| Integration test | Testcontainers (DB/queue thật) | testcontainers py 4.15.0 (2026-07-24) · node 12.2.0 | docker compose trong CI |
| Load test | k6 | v2.3.0 (2026-09-21) | Locust (Py), Gatling (JVM) |
| Container | Docker multi-stage, base image ghim digest, non-root | — | Distroless/Chainguard images |
| Observability | OpenTelemetry SDK + collector | xem [`../15-operations/observability.md`](../15-operations/observability.md) | — |

## Checklist

- [ ] `PRF-API-001` **MUST** Có một file OpenAPI (≥ 3.1) là nguồn sự thật của API: sinh từ code có kiểm hoặc contract-first; lint 0 lỗi; CI chặn breaking change chưa được duyệt. → Kiểm: job CI `spectral lint openapi.yaml` exit 0 + `oasdiff breaking base.yaml head.yaml` exit 0 (hoặc có nhãn `api-breaking-approved` trên PR). · Nguồn: OAS 3.2.1
- [ ] `PRF-API-002` **MUST** Mọi phản hồi lỗi 4xx/5xx theo RFC 9457 (`Content-Type: application/problem+json`, có `type`, `title`, `status`, `detail` không lộ stack/SQL). → Kiểm: contract test duyệt mọi endpoint, mọi mã lỗi: header đúng + schema Problem Details; test 500 giả lập không chứa stack trace. · Nguồn: RFC 9457 §3
- [ ] `PRF-API-003` **MUST** Mọi route deny-by-default: route không cần xác thực phải nằm trong allowlist công khai có chủ sở hữu; phân quyền theo [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md). → Kiểm: test "route-perms" liệt kê router lúc chạy, mọi route ngoài allowlist gọi không token → 401/403. · Nguồn: ASVS 5.0 V8 (Authorization)
- [ ] `PRF-API-004` **MUST** Rate limit + quota theo client/tenant/IP ở edge hoặc middleware; vượt → 429 kèm `Retry-After`. → Kiểm: test integration bắn N+1 request trong cửa sổ → 429 + header `Retry-After`; cấu hình ngưỡng nằm trong repo. · Nguồn: ASVS 5.0 V2 (Validation & Business Logic — anti-automation)
- [ ] `PRF-API-005` **MUST** Endpoint tạo side effect không lũy đẳng (thanh toán, tạo đơn, gửi tin) nhận `Idempotency-Key`; cùng key → cùng kết quả, một side effect. → Kiểm: test gửi 2 lần cùng key và body → 1 bản ghi, 2 phản hồi giống nhau; khác body cùng key → 422. · Nguồn: IETF draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15, draft đã hết hạn — chuẩn de facto, chưa là RFC)
- [ ] `PRF-API-006` **MUST@M** Tách `/healthz` (liveness: tiến trình sống) và `/readyz` (readiness: DB/cache/queue sẵn sàng); orchestrator chỉ route traffic khi ready. → Kiểm: test Testcontainers tắt DB → `/readyz` 503, `/healthz` 200; manifest K8s/compose trỏ đúng 2 probe.
- [ ] `PRF-API-007` **MUST** Graceful shutdown: nhận SIGTERM → ngừng nhận kết nối mới, đợi request đang chạy xong trong giới hạn, đóng pool DB, exit 0. → Kiểm: test gửi SIGTERM khi có request chậm đang chạy → request hoàn tất, exit code 0; `terminationGracePeriodSeconds` (hoặc tương đương) > timeout drain. · Nguồn: 12-factor IX (Disposability)
- [ ] `PRF-API-008` **MUST** Cấu hình chỉ từ biến môi trường, không nhánh code theo tên môi trường; biến bắt buộc được validate lúc khởi động (fail-fast, in tên biến thiếu, không in giá trị). → Kiểm: khởi động thiếu biến bắt buộc → exit ≠ 0 và stderr nêu tên biến; test đọc cấu hình bằng schema (pydantic-settings/zod/envconfig). · Nguồn: 12-factor III (Config)
- [ ] `PRF-API-009` **MUST** Image container: multi-stage, chạy user non-root, base image ghim digest, không chứa secret/ `.env`; quét lỗ hổng trước khi push. → Kiểm: `docker inspect` → `Config.User` ≠ root; Dockerfile `FROM ...@sha256:`; job scan image 0 CRITICAL (chi tiết → [`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
- [ ] `PRF-API-010` **MUST@M** Ngân sách p95 latency theo nhóm endpoint (đọc / ghi / tìm kiếm) ghi trong `PROJECT.md`, kiểm bằng load test có ngưỡng; thay cho Core Web Vitals của web. → Kiểm: `k6 run` với `thresholds: {http_req_duration: ['p(95)<NNN']}` chạy nightly/trước release, exit 0 (phương pháp → [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md)).
- [ ] `PRF-API-011` **MUST** Contract test chạy trong CI: Schemathesis từ OpenAPI (property-based) và/hoặc Pact với consumer thật; không merge khi hợp đồng vỡ. → Kiểm: job `schemathesis run openapi.yaml --checks all` 0 failure, hoặc `pact verify` xanh với broker.
- [ ] `PRF-API-012` **MUST** Validate mọi đầu vào ở biên bằng schema (body, query, path, header); giới hạn kích thước body; từ chối trường lạ ở endpoint nhạy cảm. → Kiểm: test gửi body vượt giới hạn → 413; trường sai kiểu → 422 theo RFC 9457; fuzz schema (Schemathesis) không gây 500. · Nguồn: ASVS 5.0 V2
- [ ] `PRF-API-013` **MUST** Log có cấu trúc (JSON) kèm `request_id` và `trace_id`; truyền `traceparent` (W3C) sang mọi downstream; không log secret/PII thô. → Kiểm: test một request end-to-end: log service A và B cùng `trace_id`; header `traceparent` xuất hiện ở request đi ra (chi tiết log → [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)). · Nguồn: W3C Trace Context (Recommendation)
- [ ] `PRF-API-014` **MUST** Mọi cuộc gọi ra ngoài (HTTP, DB, queue, cache) có timeout tường minh; retry có backoff + jitter và chỉ cho thao tác lũy đẳng; circuit breaker cho phụ thuộc hay lỗi. → Kiểm: lint/wrapper duy nhất cho HTTP client (cấm `requests.get` không `timeout`, `fetch` không `AbortSignal`); test fault-injection phụ thuộc treo → lỗi sau timeout, không treo worker (mẫu → [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md)).
- [ ] `PRF-API-015` **SHOULD** Chiến lược phiên bản API (đường dẫn `/v1` hoặc header) + chính sách ngừng hỗ trợ: phản hồi endpoint sắp bỏ có `Deprecation`/`Sunset`. → Kiểm: test endpoint đánh dấu deprecated trả header `Sunset` đúng ngày trong OpenAPI. · Nguồn: RFC 8594 (Sunset)
- [ ] `PRF-API-016` **SHOULD** Phân trang theo cursor cho tập lớn, có `page_size` tối đa; không cho phép `offset` tuỳ ý trên bảng lớn. → Kiểm: test `page_size` vượt tối đa → bị kẹp; cursor giả → 400.
- [ ] `PRF-API-017` **SHOULD** CORS allowlist origin cụ thể; không `*` khi có credential; preflight cache hợp lý. → Kiểm: test origin lạ không nhận `Access-Control-Allow-Origin`.
- [ ] `PRF-API-018` **SHOULD** Test integration chạy với DB/queue thật qua Testcontainers (không mock ORM); migration chạy trong test. → Kiểm: job CI integration có Docker; test khởi tạo schema bằng migration thật.
- [ ] `PRF-API-019` **SHOULD** Client/SDK sinh từ OpenAPI (không viết tay), phát hành cùng phiên bản API. → Kiểm: bước CI `openapi-generator`/`orval`/`oapi-codegen` + diff sạch so với client đã commit.
- [ ] `PRF-API-020` **MAY** gRPC/protobuf cho giao tiếp nội bộ; mTLS service-to-service; API gateway tập trung auth/quota. → Kiểm: ADR ghi lựa chọn và lý do.

## Cổng chất lượng tương đương

| Cổng chung (web) | Tương đương cho API/dịch vụ | Công cụ / lệnh |
|---|---|---|
| Core Web Vitals (LCP/INP/CLS) | p95 latency theo nhóm endpoint + error rate + throughput | k6 thresholds theo [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md); SLO ở [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md) |
| E2E trình duyệt | Contract test (Schemathesis/Pact) + integration Testcontainers | CI job `contract`, `integration` |
| A11y WCAG | Hợp đồng API rõ ràng, lỗi RFC 9457, tài liệu OpenAPI render được | Spectral lint, docs build |
| Theme / design tokens | Quy ước đặt tên tài nguyên, phiên bản, phân trang thống nhất | Spectral ruleset riêng của dự án |
| Bundle size | Kích thước image container, thời gian khởi động tới ready | `docker image ls`, đo `/readyz` sau start |
| Lighthouse CI | Load test nightly + so sánh baseline | k6 + lưu kết quả theo commit |

## Bẫy

1. **Mock ORM/DB trong test rồi tin là xong** — lỗi transaction, lock, migration chỉ lộ với DB thật. Dùng Testcontainers (PRF-API-018).
2. **Trả 200 kèm `{"error": ...}`** — client/agent không phân biệt được; mọi lỗi phải đúng mã HTTP + Problem Details.
3. **Retry mù thao tác không lũy đẳng** — tạo đơn/thanh toán gấp đôi; chỉ retry khi có idempotency key hoặc GET.
4. **Readiness = liveness** — pod "sống" nhưng DB chết vẫn nhận traffic; tách hai probe.
5. **Timeout mặc định vô hạn** của nhiều HTTP client (vd `requests`) — một downstream treo kéo sập worker pool.
6. **OpenAPI viết tay lệch code** — sinh từ code hoặc contract test bắt lệch; không có cả hai thì tài liệu là lời khai.
7. **Rate limit chỉ ở client/SDK** — kẻ lạm dụng không dùng SDK; giới hạn phải ở edge/server.
8. **Log request body để "dễ debug"** — rò PII/secret vào log; log có cấu trúc, redact theo danh sách trường.
9. **Image chạy root, base `latest`** — không tái lập, không quét được; ghim digest, non-root.
10. **Shutdown bằng `kill -9` trong deploy** — mất request đang chạy; cần SIGTERM + drain (PRF-API-007).

## Nguồn

- OpenAPI Specification 3.2.1 (2026-09-10): <https://spec.openapis.org/oas/latest.html> — xác minh 2026-10-13
- RFC 9457 Problem Details for HTTP APIs (obsoletes RFC 7807): <https://www.rfc-editor.org/rfc/rfc9457> — xác minh 2026-10-13
- RFC 8594 The Sunset HTTP Header Field (Informational, 05/2019): <https://www.rfc-editor.org/rfc/rfc8594> — xác minh 2026-10-13
- draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15; trạng thái Expired): <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/> — xác minh 2026-10-13
- The Twelve-Factor App (III Config, IX Disposability): <https://12factor.net/> — xác minh 2026-10-13
- OWASP ASVS 5.0 ("Bleeding Edge" 5.0.0, release GitHub 2026-09-03): <https://owasp.org/www-project-application-security-verification-standard/> — xác minh 2026-10-13
- W3C Trace Context (Recommendation, 2021-11-23): <https://www.w3.org/TR/trace-context/> — xác minh 2026-10-13
- Phiên bản runtime/CSDL: <https://endoflife.date/api/python.json>, `nodejs.json`, `go.json`, `postgresql.json`, `redis.json`, `valkey.json`, `spring-boot.json`, `django.json` — xác minh 2026-10-13
- Phiên bản gói: <https://pypi.org/project/fastapi/>, `uv`, `ruff`, `schemathesis`, `testcontainers`; <https://registry.npmjs.org/@nestjs/core/latest>, `hono`, `fastify`, `@stoplight/spectral-cli`, `@pact-foundation/pact`, `testcontainers`; <https://github.com/oasdiff/oasdiff/releases/latest>; <https://github.com/grafana/k6/releases/latest> — xác minh 2026-10-13 (GitHub không hiện năm; suy ra 2026 vì là bản "latest")
- Khung cũ X-stored `03-tech-selection-and-proactive-advice.md` PHẦN C4 (commit `1b80fe4`); `research/2026-10-13-stored-catalog-extraction.md` §2.5, §2.7.
