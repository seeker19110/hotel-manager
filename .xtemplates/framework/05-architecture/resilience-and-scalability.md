---
title: Độ bền và mở rộng: timeout, retry, circuit breaker, stateless, cache, hàng đợi
kind: module
prefix: ARC-RES
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Độ bền và mở rộng: timeout, retry, circuit breaker, stateless, cache, hàng đợi

> Luật thiết kế để hệ **không sập dây chuyền** khi một phụ thuộc chậm/hỏng, và **mở rộng theo chiều ngang** mà
> không đổi code: timeout ở mọi lời gọi, retry có ngân sách + jitter, circuit breaker, bulkhead, backpressure,
> tiến trình stateless, cache theo tầng. Module này là **mẫu kiến trúc**; tham số triển khai ở backend xem
> [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md) (graceful shutdown, health,
> rate limit) và [`../08-backend/caching.md`](../08-backend/caching.md) (key, TTL, stampede); đo tải ở
> [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md).

## Nguyên tắc

1. **Mọi lời gọi ra ngoài tiến trình có timeout** (kết nối + yêu cầu), kể cả tới dịch vụ cùng máy; giá trị đặt theo
   phân vị độ trễ của phía được gọi, không theo cảm giác.
2. **Retry là "ích kỷ"**: tốn thêm tài nguyên phía đang yếu. Chỉ retry lỗi có thể qua (5xx, timeout, kết nối),
   chỉ với thao tác idempotent, có **backoff mũ có trần + jitter + ngân sách retry** (token bucket), và **ở một tầng**
   của ngăn xếp (5 tầng × 3 lần = 243× tải — AWS Builders' Library).
3. **Circuit breaker cho lỗi không thoáng qua**: đóng/mở/nửa mở; mở thì thất bại nhanh hoặc trả fallback, không xếp
   hàng chờ timeout. Retry và breaker kết hợp: retry phải dừng khi breaker báo mở.
4. **Bulkhead**: pool kết nối/luồng/hàng đợi tách riêng theo phụ thuộc, để một phụ thuộc chết không cạn tài nguyên
   của cả tiến trình.
5. **Backpressure thay vì hàng đợi vô hạn**: hàng đợi có giới hạn, quá tải → từ chối sớm (429/503 + `Retry-After`),
   không nuốt vào bộ nhớ.
6. **Stateless để mở rộng ngang**: tiến trình không giữ phiên/tệp/khoá; trạng thái ở CSDL/cache/hàng đợi
   (12-factor VI, VIII, IX).
7. **Cache là tầng tối ưu, không phải nguồn sự thật**: mất cache hệ vẫn đúng, chỉ chậm; mỗi tầng có TTL và cách vô
   hiệu hoá.
8. **Suy giảm có kiểm soát** (graceful degradation): tính năng phụ tắt được bằng cờ khi phụ thuộc hỏng; tính năng lõi
   không phụ thuộc tính năng phụ.

## Quyết định

| Tình huống | Mẫu | Không dùng khi |
|---|---|---|
| Lỗi thoáng qua, thao tác idempotent | **Retry** backoff mũ + jitter, trần số lần, ngân sách | Thao tác không idempotent (xem [`integration-patterns.md`](integration-patterns.md)); lỗi 4xx |
| Phụ thuộc hỏng lâu, nhiều phút | **Circuit breaker** + fallback/cache cũ | Tài nguyên trong tiến trình; hệ message-driven đã có DLQ |
| Một phụ thuộc chậm kéo sập các luồng khác | **Bulkhead** (pool riêng, semaphore) | Chi phí cô lập không chấp nhận được, hệ rất nhỏ |
| Tải vào vượt năng lực xử lý | **Backpressure + load shedding** (hàng đợi giới hạn, 429/503, ưu tiên theo loại yêu cầu) | Không bao giờ dùng hàng đợi không giới hạn |
| Cần mở rộng ngang | **Stateless + autoscale theo metric** (CPU/độ trễ/độ dài hàng đợi) | Thành phần có trạng thái → tách ra backing service trước |
| Đọc nhiều, ghi ít, chịu được trễ | **Cache tầng**: CDN/edge → cache ứng dụng (in-process) → cache phân tán (Valkey 9.1.2 BSD-3 / Redis 8.10.2 tri-license AGPLv3·RSALv2·SSPLv1) → CSDL | Dữ liệu cần nhất quán tức thì (số dư, quyền) |
| Việc nặng/không cần trả lời ngay | **Hàng đợi + worker** (xem [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)) | Người dùng chờ kết quả trong cùng request |
| Thư viện resilience | JS/TS: cockatiel 4.0.0 (MIT), p-retry 8.0.1 (MIT) · Python: tenacity 9.2.1 (Apache-2.0) · Java: resilience4j 2.4.0 (Apache-2.0) · .NET: Polly 8.8.0 (BSD-3 — chưa xác minh giấy phép) | Đã có service mesh/gateway làm retry+breaker → không lặp ở app (chọn một tầng) |

Redis giấy phép: 7.2 trở về trước BSD-3; 7.4–7.8 RSALv2/SSPLv1; **8.0+ thêm lựa chọn AGPLv3** (OSI). Valkey (fork,
Linux Foundation) BSD-3-Clause. Chọn Valkey khi cần OSI-permissive; xem
[`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md).

## Checklist

- [ ] `ARC-RES-001` **MUST** Mọi client HTTP/gRPC/CSDL/hàng đợi cấu hình timeout kết nối và timeout yêu cầu tường minh; không dùng mặc định vô hạn. → Kiểm: grep cấu hình client (`timeout`, `connect_timeout`, `statement_timeout`) ≠ 0/none; test mock phụ thuộc treo → lỗi timeout trong ngưỡng. · Nguồn: AWS Builders' Library (timeouts) · PostgreSQL `statement_timeout`
- [ ] `ARC-RES-002` **MUST** Retry chỉ cho lỗi có thể qua (timeout, kết nối, 5xx, 429 có `Retry-After`) và chỉ cho thao tác idempotent; có backoff mũ, trần thời gian chờ, trần số lần, jitter. → Kiểm: cấu hình thư viện resilience có `maxAttempts`, `backoff`, `jitter`; test 4xx không retry, test 503 retry đúng số lần. · Nguồn: AWS Builders' Library (backoff + jitter)
- [ ] `ARC-RES-003` **MUST@L** Retry đặt ở đúng một tầng cho mỗi lời gọi (client lib **hoặc** sidecar/mesh **hoặc** gateway), có ghi ở ADR/tài liệu; tổng số lần thử xuyên tầng ≤ cấu hình đã khai. → Kiểm: bảng "tầng retry" trong `docs/architecture/`; test chèn lỗi đếm số request đến phụ thuộc ≤ trần. · Nguồn: AWS Builders' Library (retry storm 243×)
- [ ] `ARC-RES-004` **MUST@L** Hệ trả lỗi quá tải sớm: hàng đợi/pool có giới hạn, vượt → 429/503 với `Retry-After`, không chờ đến timeout. → Kiểm: test tải vượt công suất → phản hồi 429/503 trong < 1 s thay vì timeout; cấu hình `maxQueue`/`pool_size` hữu hạn. · Nguồn: Azure Circuit Breaker (429/503 + delay) · 12-factor VIII
- [ ] `ARC-RES-005` **MUST** Tiến trình phục vụ không giữ trạng thái giữa request (phiên, upload tạm, khoá, cache "nguồn sự thật"); scale ≥ 2 bản sao không đổi hành vi. → Kiểm: E2E luồng chính với 2 bản sao và sticky session tắt (ARC-STYLE-004); không ghi file ngoài thư mục tạm. · Nguồn: 12-factor VI
- [ ] `ARC-RES-006` **MUST@L** Mỗi tầng cache có TTL và cách vô hiệu hoá có chủ đích; xoá toàn bộ cache hệ vẫn trả kết quả đúng. → Kiểm: test "flush cache rồi chạy luồng" xanh; mọi `set` cache có TTL (lint/grep). · Nguồn: [`../08-backend/caching.md`](../08-backend/caching.md)
- [ ] `ARC-RES-007` **MUST@L** Phụ thuộc ngoài quan trọng (thanh toán, email, LLM, API đối tác) được bọc circuit breaker có ngưỡng lỗi/thời gian mở cấu hình, trạng thái breaker xuất ra metric và cảnh báo. → Kiểm: metric `circuit_state{dependency}`; test chèn lỗi liên tiếp → breaker mở → yêu cầu kế tiếp thất bại nhanh (< timeout). · Nguồn: Azure Circuit Breaker pattern
- [ ] `ARC-RES-008` **MUST@L** Pool kết nối/luồng tách riêng theo phụ thuộc (bulkhead); một phụ thuộc treo không làm cạn pool của phụ thuộc khác. → Kiểm: test treo phụ thuộc A (toxiproxy) → endpoint chỉ dùng B vẫn đạt SLO. · Nguồn: Azure Bulkhead pattern
- [ ] `ARC-RES-009` **MUST@M** Tiến trình tắt êm: nhận SIGTERM → ngừng nhận request mới → hoàn tất request/job đang chạy trong thời hạn → thoát; không mất job giữa chừng. → Kiểm: test gửi SIGTERM khi đang xử lý → request hoàn tất, job trả lại hàng đợi; cấu hình grace period của orchestrator ≥ thời hạn. · Nguồn: 12-factor IX · [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md)
- [ ] `ARC-RES-010` **MUST@L** Có ngân sách retry toàn cục (token bucket) hoặc tỉ lệ retry/tổng tối đa, đo bằng metric. → Kiểm: metric `retries_total`/`requests_total` có cảnh báo khi vượt tỉ lệ đã khai trong tài liệu. · Nguồn: AWS Builders' Library (retry budget)
- [ ] `ARC-RES-011` **MUST@L** Hệ tiếp tục phục vụ tính năng lõi khi tính năng phụ (gợi ý, thống kê, AI) hỏng; cờ tắt tính năng phụ có sẵn và thử được. → Kiểm: test tắt phụ thuộc phụ → luồng lõi xanh; cờ tính năng trong cấu hình (xem [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)). · Nguồn: Azure Circuit Breaker (graceful degradation)
- [ ] `ARC-RES-012` **SHOULD** Timeout đặt theo số đo: p99/p99.9 độ trễ phụ thuộc + đệm mạng, ghi nguồn số đo trong cấu hình/ADR. → Kiểm: comment/tài liệu cạnh giá trị timeout dẫn tới dashboard/báo cáo đo. · Nguồn: AWS Builders' Library
- [ ] `ARC-RES-013` **SHOULD** Lời gọi theo lô/song song có giới hạn đồng thời (semaphore) tới mỗi phụ thuộc; không `Promise.all` không giới hạn trên danh sách lớn. → Kiểm: lint/grep pattern fan-out không giới hạn; cấu hình `concurrency` cho worker/HTTP client. · Nguồn: Azure Bulkhead
- [ ] `ARC-RES-014` **SHOULD** Job định kỳ có jitter/độ lệch theo host để tránh "đồng hồ cùng kêu" tạo đỉnh tải. → Kiểm: cấu hình cron có jitter hoặc phân phối phút; dashboard không thấy đỉnh đồng bộ. · Nguồn: AWS Builders' Library (jitter cho timer)
- [ ] `ARC-RES-015` **SHOULD** Cache phân tán và hàng đợi là backing service gắn qua URL cấu hình, thay được không sửa code. → Kiểm: client khởi tạo từ `REDIS_URL`/`QUEUE_URL`; test chạy với Valkey và Redis cùng xanh (nếu cần tránh khoá giấy phép). · Nguồn: 12-factor IV
- [ ] `ARC-RES-016` **SHOULD** Hệ có kiểm thử chèn lỗi (fault injection) cho ≥ 3 kiểu: độ trễ, mất kết nối, lỗi 5xx — chạy định kỳ hoặc trước phát hành lớn. → Kiểm: kịch bản toxiproxy/chaos trong `tests/resilience/`, kết quả lưu. · Nguồn: catalog 09 §1 (production-readiness)
- [ ] `ARC-RES-017` **SHOULD** Tải vào từ client có rate limit theo chủ thể và được hàng đợi/worker tiêu thụ theo năng lực đã đo; năng lực ghi trong tài liệu kèm ngày đo. → Kiểm: báo cáo k6/Locust (xem [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md)) nêu RPS tối đa; cấu hình autoscale dựa trên số đó. · Nguồn: 12-factor VIII
- [ ] `ARC-RES-018` **MAY** Fallback trả dữ liệu cũ (stale-while-revalidate) khi phụ thuộc mở breaker, có nhãn "dữ liệu lúc …" cho người dùng. → Kiểm: test breaker mở → phản hồi có `stale: true`/header tương ứng.
- [ ] `ARC-RES-019` **MAY** Dùng service mesh/gateway để chuẩn hoá retry/breaker/timeout xuyên dịch vụ ở quy mô L, và gỡ cấu hình trùng ở app. → Kiểm: ADR chọn tầng; app không còn cấu hình retry cho cùng lời gọi.
- [ ] `ARC-RES-020` **MAY** Thử nghiệm tải "nhiều hơn dự kiến" (×2–×3) để biết hành vi suy giảm (từ chối sớm hay sập) trước khi ra mắt. → Kiểm: báo cáo tải ghi điểm gãy và hành vi.

## Bẫy thường gặp

- **Retry ở mọi tầng** (SDK + app + gateway + mesh) → bão retry nhân tải lên phụ thuộc đang yếu. Tránh: ARC-RES-003.
- **Không timeout** (mặc định thư viện = vô hạn) → luồng treo, pool cạn, sập dây chuyền. Tránh: ARC-RES-001.
- **Retry thao tác không idempotent** → nhân đôi tác động (xem [`integration-patterns.md`](integration-patterns.md)).
- **Hàng đợi trong bộ nhớ không giới hạn** → OOM khi phụ thuộc chậm. Tránh: ARC-RES-004.
- **Cache làm nguồn sự thật** (ghi cache, "sẽ" ghi CSDL sau) → mất dữ liệu khi cache bay. Tránh: ARC-RES-006.
- **Một breaker cho nhiều shard/nhà cung cấp** → một shard lỗi chặn tất cả. Tránh: breaker theo từng tài nguyên độc lập (Azure "resource differentiation").
- **Timeout phụ thuộc dài hơn timeout của chính mình** → client đã bỏ đi, server vẫn làm. Tránh: timeout giảm dần theo chiều sâu gọi.
- **Agent gọi tool lỗi 400 lần trong 5 phút** (catalog 21) — vòng lặp không có breaker/ngân sách. Tránh: ARC-RES-010 + [`../11-autonomous-loop/loop-design.md`](../11-autonomous-loop/loop-design.md).
- **Đổi Redis sang bản 7.4+ mà không đọc giấy phép** (RSALv2/SSPLv1) khi cung cấp dịch vụ quản lý. Tránh: bảng giấy phép ở Quyết định.

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Timeout/retry có cấu hình | lint tự viết (grep client khởi tạo không `timeout`) hoặc rule semgrep | `semgrep --config .semgrep/resilience.yml` | pre-commit + CI | 0 client thiếu timeout |
| Chèn lỗi độ trễ/mất kết nối | toxiproxy 2.12.0 · MIT | `toxiproxy-cli toxic add -t latency -a latency=2000 dep` + test | CI nightly / trước release | SLO luồng lõi vẫn đạt; breaker mở đúng |
| Breaker/bulkhead hoạt động | thư viện resilience (cockatiel 4.0.0 / tenacity 9.2.1 / resilience4j 2.4.0 / Polly 8.8.0) + unit test | test state machine | CI | test xanh |
| Backpressure | k6/Locust (xem [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md)) | tải ×2 công suất | CI nightly | 429/503 < 1 s, không OOM |
| Stateless | `docker compose up --scale app=2` + E2E | như ARC-STYLE | CI | E2E xanh |
| Graceful shutdown | test gửi SIGTERM trong lúc xử lý | script test | CI | 0 request/job mất |
| Metric breaker/retry/queue | OTel metrics + cảnh báo (xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)) | — | production | cảnh báo đã thử kích hoạt (G8) |

## Nguồn

- AWS Builders' Library — Timeouts, retries, and backoff with jitter (timeout theo p99.9, backoff có trần, jitter, retry budget/token bucket, retry storm 243×, idempotency): <https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter> — xác minh 2026-10-13.
- Azure Architecture Center — Circuit Breaker (closed/open/half-open, 429/503, manual override) ms.date 2025-02-05: <https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker>; Bulkhead ms.date 2026-03-19: <https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead> — xác minh 2026-10-13.
- The Twelve-Factor App IV, VI, VIII, IX: <https://12factor.net/> — xác minh 2026-10-13.
- Redis licenses (7.2 BSD-3 → 7.4 RSALv2/SSPLv1 → 8.0 + AGPLv3): <https://redis.io/legal/licenses/>; Redis 8.10.2: <https://endoflife.date/api/redis.json>; Valkey 9.1.2 BSD-3-Clause: <https://endoflife.date/api/valkey.json>, <https://raw.githubusercontent.com/valkey-io/valkey/unstable/COPYING> — xác minh 2026-10-13.
- Thư viện: cockatiel 4.0.0 MIT, p-retry 8.0.1 MIT (npm); tenacity 9.2.1 Apache-2.0 (PyPI); resilience4j-core 2.4.0 (Maven Central, 2026-03-14); Polly 8.8.0 (NuGet, giấy phép **chưa xác minh** từ registry); toxiproxy 2.12.0 MIT (brew) — xác minh 2026-10-13.
- PostgreSQL 18 `statement_timeout`/`lock_timeout`: <https://www.postgresql.org/docs/current/runtime-config-client.html> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 21 (runaway loop 400 lần/5 phút, spend circuit breaker), 09 §1 (production-readiness), đọc 2026-10-13.
