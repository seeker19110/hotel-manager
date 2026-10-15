---
title: Độ tin cậy: timeout, retry, graceful shutdown, health, rate limit
kind: module
prefix: BE-REL
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Độ tin cậy: timeout, retry, graceful shutdown, health, rate limit

> Dịch vụ phải **hỏng có kiểm soát**: mọi I/O có timeout, retry có ngân sách, tắt êm không mất request, health/
> readiness tách biệt, rate limit và giới hạn body/đồng thời để một client xấu không kéo sập tất cả. Mẫu kiến
> trúc (circuit breaker, bulkhead) ở [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md);
> SLO/cảnh báo ở [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md).

## Nguyên tắc

1. **Mọi I/O có timeout** (HTTP, DB, cache, hàng đợi, DNS, file mạng) — kể cả gọi nội bộ cùng máy. Không có
   timeout là không có độ tin cậy, chỉ có hy vọng.
2. **Retry là "ích kỷ".** Retry tiêu thêm công suất của hệ đang quá tải. Chỉ retry thao tác idempotent, có
   backoff + jitter, trần số lần, ngân sách retry, và chỉ ở một tầng.
3. **Thất bại đóng ở cổng bảo mật, thất bại mềm ở tính năng phụ (P7).** Cache/analytics hỏng → vẫn phục vụ;
   authz/payment hỏng → từ chối.
4. **Shed load trước khi sập.** Giới hạn đồng thời, hàng đợi có trần, 429/503 + `Retry-After` sớm thay vì để
   latency tăng tới timeout của mọi client.
5. **Tắt êm là một tính năng.** Deploy xảy ra hàng ngày; mỗi lần deploy làm rơi request là lỗi lặp lại.

## Quyết định

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Chọn giá trị timeout gọi xuôi dòng | Theo phân vị latency thật của dịch vụ đó (vd p99.9) + đệm, chấp nhận ~0,1% timeout giả | Không đặt 30 s "cho chắc"; timeout dài = hàng đợi dài |
| Retry hay không | Idempotent + lỗi tạm (timeout kết nối, 503, 429 theo `Retry-After`) → retry; 4xx nghiệp vụ, timeout sau khi đã gửi body POST không idempotent → không | 504/timeout = *có thể đã chạy* |
| Ở tầng nào retry | Tầng ngay trên tầng trả lỗi (một tầng); tầng trên không retry tiếp | Retry lồng N tầng = tải × k^N |
| Rate limit thuật toán | **Token bucket** (cho burst có trần) theo khoá `user_id`/API key, fallback IP | Fixed window cho phép burst gấp đôi ở biên cửa sổ |
| Nơi đặt rate limit | Gateway/proxy cho giới hạn thô; ứng dụng cho giới hạn theo nghiệp vụ (vd 30 lượt AI/ngày) | Chỉ ở gateway thì không biết nghiệp vụ |
| Health vs readiness | `/healthz` (liveness: tiến trình sống, rẻ, không gọi DB) tách `/readyz` (readiness: DB/cache/hàng đợi sẵn sàng) | Liveness gọi DB → DB chập chờn làm restart toàn bộ pod |
| Circuit breaker hay retry budget | Retry budget (token bucket) mặc định; circuit breaker khi dịch vụ xuôi dòng hỏng lâu và cần fail-fast | Breaker thêm trạng thái mode, hồi chậm |

## Checklist

- [ ] `BE-REL-001` **MUST** Mọi client HTTP/DB/cache/queue có timeout kết nối và timeout request cấu hình rõ, không dùng mặc định vô hạn của thư viện. → Kiểm: lint/grep client tạo không có timeout = 0 (vd `fetch` không `AbortSignal.timeout`, `requests.get` không `timeout=`, `http.Client{}` không `Timeout`, pool DB không `connect_timeout`/`statement_timeout`). · Nguồn: AWS Builders' Library Timeouts, retries and backoff with jitter
- [ ] `BE-REL-002` **MUST@L** Server có timeout đọc header/body, timeout ghi, idle timeout và giới hạn kích thước body (mặc định vd 1–2 MB, nâng riêng cho endpoint upload). → Kiểm: cấu hình server có các giá trị; test body vượt giới hạn → 413 trước khi đọc hết. · Nguồn: OWASP REST Security Cheat Sheet; catalog 23 §8.1 (giới hạn body 2 MB, 8 request đồng thời)
- [ ] `BE-REL-003` **MUST** Chính sách retry phía dịch vụ: **mặc định 3 lần** mỗi request, trần tổng thời gian, tôn trọng `Retry-After`; POST không idempotent timeout → không retry tự động. Nguyên tắc (chỉ lỗi tạm, chỉ thao tác idempotent, backoff mũ + jitter): xem [`ARC-RES-002`](../05-architecture/resilience-and-scalability.md). → Kiểm: unit test chính sách retry; test lỗi 400/409 → không retry; test POST không idempotent timeout → không retry tự động. · Nguồn: RFC 9110 §9.2.2, Google SRE Handling Overload (3 lần/request)
- [ ] `BE-REL-004` **MUST** Tắt êm: nhận SIGTERM → readiness trả lỗi/ngừng nhận kết nối mới → chờ request đang chạy xong (trần < grace period của nền tảng, vd 30 s) → đóng pool DB/queue → thoát 0; không `process.exit()` tức thì. → Kiểm: test gửi SIGTERM khi có request chậm đang chạy → request hoàn tất 200, tiến trình thoát trong grace. · Nguồn: Kubernetes Pod lifecycle (SIGTERM → grace 30 s → SIGKILL)
- [ ] `BE-REL-005` **MUST@L** Tách liveness (`/healthz`: không phụ thuộc ngoài) và readiness (`/readyz`: kiểm phụ thuộc bắt buộc); readiness trả 503 khi chưa sẵn sàng hoặc đang tắt; endpoint không cần auth nhưng không lộ chi tiết cấu hình ra ngoài mạng nội bộ. → Kiểm: test tắt DB → `/readyz` 503, `/healthz` 200; cấu hình probe trỏ đúng endpoint. · Nguồn: Kubernetes probes (liveness/readiness/startup)
- [ ] `BE-REL-006` **MUST** Giới hạn tốc độ trên endpoint công khai, xác thực, gửi OTP/email và endpoint đắt: token bucket theo `user_id`/API key, fallback IP; trả 429 + `Retry-After` (+ `RateLimit`/`RateLimit-Policy` nếu dùng); đếm ở store dùng chung khi nhiều instance. → Kiểm: test vượt ngưỡng → 429 có `Retry-After`; test 2 instance chia sẻ bộ đếm. · Nguồn: RFC 6585 §4, draft-ietf-httpapi-ratelimit-headers-11
- [ ] `BE-REL-007` **MUST@L** Giới hạn đồng thời (bulkhead) cho tài nguyên hữu hạn: pool DB có kích thước và hàng đợi chờ có trần + timeout lấy kết nối; số request đồng thời tới dịch vụ ngoài có trần; vượt → từ chối nhanh (503), không xếp hàng vô hạn. → Kiểm: cấu hình pool `max`/`acquireTimeout`; test bơm quá trần → 503 nhanh thay vì timeout dài. · Nguồn: Google SRE Handling Overload
- [ ] `BE-REL-008` **MUST@L** Lỗi không bắt được (uncaught exception/unhandled rejection/panic) được ghi log có cấu trúc rồi tiến trình thoát để được khởi động lại; không nuốt lỗi và chạy tiếp ở trạng thái hỏng. → Kiểm: handler toàn cục tồn tại; test ném lỗi ngoài request → log + exit ≠ 0. · Nguồn: [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)
- [ ] `BE-REL-009` **MUST@L** Timeout của chuỗi gọi lan truyền (deadline/`context` còn lại truyền xuống), tầng dưới không chờ lâu hơn tầng trên; gRPC deadline propagation bật. → Kiểm: test request với deadline 1 s gọi 3 tầng → huỷ toàn chuỗi ≤ 1 s. · Nguồn: grpc.io Deadlines
- [ ] `BE-REL-010` **MUST@L** Ngân sách retry toàn client (vd ≤ 10% request là retry) hoặc circuit breaker cho dịch vụ xuôi dòng hay hỏng; khi vượt ngân sách → fail-fast. → Kiểm: metric `retries/requests`; test mô phỏng xuôi dòng hỏng → tải gửi đi không vượt 1,1×. · Nguồn: Google SRE Handling Overload (per-client retry budget 10%)
- [ ] `BE-REL-011` **MUST@L** Phụ thuộc không bắt buộc (cache, analytics, gợi ý, email tức thời) hỏng → tính năng chính vẫn chạy (degrade), có test; phụ thuộc bắt buộc hỏng → lỗi rõ ràng, không treo. → Kiểm: test tắt từng phụ thuộc → endpoint chính 200 hoặc lỗi có cấu trúc ≤ timeout. · Nguồn: P7
- [ ] `BE-REL-012` **MUST@L** Startup kiểm cấu hình/secrets bắt buộc và kết nối phụ thuộc trước khi báo ready (fail-fast khi thiếu env); dùng startup probe cho app khởi động chậm. → Kiểm: khởi động thiếu biến bắt buộc → thoát ≠ 0 với thông báo rõ; xem [`../01-baseline/configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md).
- [ ] `BE-REL-013` **MUST@L** Load shedding theo mức ưu tiên request (critical vs sheddable) khi utilization vượt ngưỡng; request bị shed trả 503 + `Retry-After` rẻ nhất có thể. → Kiểm: test tải vượt công suất → request ưu tiên thấp bị từ chối trước, p99 request ưu tiên cao giữ trong SLO. · Nguồn: Google SRE Handling Overload (criticality)
- [ ] `BE-REL-014` **SHOULD** Pool kết nối DB có `max` phù hợp (theo CPU DB và số instance), `idleTimeout`, kiểm kết nối trước dùng; `statement_timeout`/`lock_timeout` ở DB cho truy vấn web. → Kiểm: cấu hình có giá trị; xem [`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md).
- [ ] `BE-REL-015` **SHOULD** Hedged/parallel request chỉ cho đọc idempotent có p99 cao, có trần tỉ lệ (vd ≤ 5%). → Kiểm: cấu hình trần; metric hedge ratio.
- [ ] `BE-REL-016` **SHOULD** Dependency gọi ra ngoài có metric latency/lỗi/timeout theo đích và cảnh báo; log lỗi kèm `trace_id`. → Kiểm: dashboard theo dependency ([`../15-operations/observability.md`](../15-operations/observability.md)).
- [ ] `BE-REL-017` **SHOULD** Diễn tập hỏng (chaos nhẹ) định kỳ ở staging: tắt DB/cache/dịch vụ ngoài, tăng latency, SIGTERM giữa tải; ghi kết quả. → Kiểm: báo cáo diễn tập trong `docs/ops/` có ngày.
- [ ] `BE-REL-018` **SHOULD** Rate limit riêng chặt hơn cho endpoint xác thực, quên mật khẩu, gửi OTP/SMS (chống brute-force và tốn tiền). → Kiểm: cấu hình ngưỡng theo route; xem [`authn-authz.md`](authn-authz.md).
- [ ] `BE-REL-019` **MAY** Idle connection reuse (keep-alive) + giới hạn kết nối tới mỗi host; DNS cache có TTL. → Kiểm: client dùng agent/pool keep-alive.
- [ ] `BE-REL-020` **MAY** Phản hồi `RateLimit`/`RateLimit-Policy` theo draft IETF để client tự điều tiết. → Kiểm: header có mặt trên route có rate limit. · Nguồn: draft-ietf-httpapi-ratelimit-headers-11

## Bẫy thường gặp

- **Không timeout → pool cạn → toàn hệ treo.** Một dịch vụ ngoài chậm chiếm hết worker; mọi endpoint khác chết theo. Timeout + bulkhead.
- **Retry ở mọi tầng.** Client 3 × gateway 3 × service 3 = 27 lần; hệ đang hỏng nhận tải gấp 27. Một tầng + ngân sách.
- **Retry POST không idempotent sau timeout.** Tạo trùng đơn/thanh toán. Dùng khoá idempotency ([`ARC-INT-001`](../05-architecture/integration-patterns.md); hợp đồng header ở [`api-design.md`](api-design.md) `BE-API-008`) hoặc reconcile.
- **Liveness probe gọi DB.** DB chậm 10 giây → Kubernetes restart toàn bộ pod → sập hẳn. Liveness chỉ kiểm tiến trình.
- **Readiness luôn 200.** Pod chưa nạp xong vẫn nhận traffic; khi tắt vẫn nhận request mới rồi rơi. Readiness phản ánh thật, trả 503 khi tắt.
- **`process.exit()` ngay khi SIGTERM.** Request đang xử lý rơi, kết nối DB không đóng. Drain rồi mới thoát.
- **Rate limit chỉ theo IP.** NAT văn phòng/di động bị khoá oan; kẻ tấn công xoay IP. Theo danh tính trước, IP là fallback.
- **Fixed window rate limit.** 100/phút cho phép 200 request trong 2 giây quanh ranh giới phút. Token bucket/sliding window.
- **Bộ đếm rate limit trong RAM mỗi instance.** 5 instance = giới hạn ×5. Store dùng chung (Redis) hoặc gateway.
- **Mâu thuẫn nguồn:** AWS Builders' Library ưu tiên *retry budget* thay circuit breaker (breaker thêm "mode" và hồi chậm); nhiều tài liệu kiến trúc ưu tiên breaker. Khung chọn **retry budget mặc định, breaker khi cần fail-fast lâu** — ghi lý do ở ADR nếu làm khác.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Lint timeout | Semgrep rule tự viết: `fetch()` không `signal`, `requests.*` không `timeout`, `http.Client{}` không `Timeout`, `axios.create` không `timeout` | pre-commit + CI | 0 finding |
| Test tắt êm | test tích hợp: start server → request chậm → SIGTERM → assert 200 + exit 0 trong grace | CI `quality` | Pass |
| Test probe | test `/healthz` không phụ thuộc; `/readyz` 503 khi tắt phụ thuộc | CI | Pass |
| Test rate limit | test tích hợp vượt ngưỡng → 429 + `Retry-After`; 2 instance chia bộ đếm | CI | Pass |
| Load test | k6/Locust: tải vượt công suất → 503 nhanh, p99 request ưu tiên giữ SLO; xem [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md) | CI nightly/staging | Theo SLO |
| Thư viện (xác minh 2026-10-13, xác minh lại trước khi dùng) | @fastify/rate-limit 11.2.1 · helmet 8.3.0 · Fastify 5.12.6 · NestJS 12.1.3 · FastAPI 0.143.0 · Django 6.1.2 · Spring Boot 4.1.1 · Go 1.27.2 | code | — |

## Nguồn

- AWS Builders' Library — Timeouts, retries, and backoff with jitter (timeout theo p99.9; retry "ích kỷ"; retry budget token bucket; một tầng): <https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter> — xác minh 2026-10-13
- Google SRE Book ch. 21 Handling Overload (criticality, client-side throttling, retry 3 lần/request, ngân sách 10%/client, retry một tầng): <https://sre.google/sre-book/handling-overload/> — xác minh 2026-10-13
- Kubernetes — Pod Lifecycle (termination flow, grace 30 s, liveness/readiness/startup probes): <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/> — xác minh 2026-10-13
- RFC 6585 §4 429 Too Many Requests: <https://www.rfc-editor.org/rfc/rfc6585> — xác minh 2026-10-13
- RFC 9110 §9.2.2 Idempotent Methods, §10.2.3 Retry-After: <https://www.rfc-editor.org/rfc/rfc9110> — xác minh 2026-10-13
- draft-ietf-httpapi-ratelimit-headers-11 (23/05/2026, Internet-Draft, `RateLimit`/`RateLimit-Policy`): <https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/> — xác minh 2026-10-13
- draft-inadarei-api-health-check-06 — **Expired** (2021-10-16), không dùng làm chuẩn: <https://datatracker.ietf.org/doc/draft-inadarei-api-health-check/> — xác minh 2026-10-13
- gRPC Deadlines (propagation): <https://grpc.io/docs/guides/deadlines/> — xác minh 2026-10-13
- OWASP REST Security Cheat Sheet (giới hạn kích thước request 413): <https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html> — xác minh 2026-10-13
- Phiên bản framework (npm/PyPI/endoflife.date, xác minh 2026-10-13): @nestjs/core 12.1.3, fastify 5.12.6, express 5.3.0, hono 4.13.13, fastapi 0.143.0, django 6.1.2 (5.2 LTS EOL 2028-04-30), Spring Boot 4.1.1 (3.5 EOL 2026-06-30 đã qua), Go 1.27.2 (1.25 EOL 2026-08-19 đã qua), Node 24 LTS (active support tới 2026-10-20), Python: hồ sơ [`../02-profiles/api-service.md`](../02-profiles/api-service.md) khuyến nghị 3.14.x tới khi có 3.15.1 (3.15.0 ra 2026-10-09; 3.13 hết full support 2026-10-01).
- `research/2026-10-13-stored-catalog-extraction.md` §4 (body 2 MB, 8 đồng thời; cooldown gateway 401→300 s, 429→3600 s, `Retry-After` thắng); catalog `23-own-repos-lessons` §5, §8.1.
