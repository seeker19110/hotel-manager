---
title: Job nền, hàng đợi, lịch, idempotency, retry, DLQ
kind: module
prefix: BE-JOB
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Job nền, hàng đợi, lịch, idempotency, retry, DLQ

> Mọi việc không cần trả lời ngay (gửi email, xử lý ảnh, đồng bộ bên thứ ba, báo cáo) đi qua hàng đợi với
> giao hàng **at-least-once**; vì thế job phải **idempotent**, retry có backoff + jitter, thất bại vĩnh viễn vào
> DLQ có người xem, lịch cron có jitter và khoá chống chạy trùng. Outbox cho side effect có ở
> [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md).

## Nguyên tắc

1. **Giả định job chạy ≥ 2 lần.** Broker giao at-least-once; worker crash sau khi làm xong nhưng trước khi ack.
   Mọi job có khoá idempotency hoặc thao tác tự nhiên idempotent (upsert, SET thay vì INCR).
2. **Không mất job.** Ghi job trong cùng transaction với dữ liệu nghiệp vụ (outbox) hoặc enqueue sau commit;
   không enqueue trong transaction chưa commit rồi tin rằng nó sẽ commit.
3. **Thất bại có nơi đến.** Retry hữu hạn với backoff mũ + jitter; hết lượt → DLQ kèm payload và lỗi; DLQ có
   cảnh báo và quy trình redrive.
4. **Job nhỏ, có hạn.** Mỗi job một việc, timeout rõ, payload là ID (không nhúng cả object), ưu tiên tách job
   dài thành bước có checkpoint.
5. **Quan sát được (P10).** Mỗi job có `job_id`, `attempt`, `enqueued_at`, `started_at`, thời gian chạy,
   kết quả; metric độ sâu hàng đợi, tuổi job cũ nhất, tỉ lệ fail.

## Quyết định

| Nhu cầu | Chọn | Khi nào không |
|---|---|---|
| App đã có Postgres, lưu lượng vừa, muốn giao dịch chung với dữ liệu | **Hàng đợi trên Postgres** (`SELECT … FOR UPDATE SKIP LOCKED`; River cho Go, pg-boss/Graphile Worker cho Node, Procrastinate cho Python) | > vài nghìn job/giây hoặc cần fan-out pub/sub lớn |
| Node/TS, cần ưu tiên, trì hoãn, rate limit theo hàng đợi | **BullMQ** trên Redis (Redis cần persistence AOF) | Không chấp nhận mất job khi Redis mất dữ liệu |
| Python | **Celery** (mạnh, nhiều broker) hoặc **arq/dramatiq** (gọn hơn) | — |
| Go | **River** (Postgres) hoặc asynq (Redis) | — |
| Java/Spring | Spring Batch/Quartz cho lịch; JMS/Kafka cho hàng đợi | — |
| Luồng sự kiện nhiều consumer, replay, khối lượng lớn | **Kafka/NATS JetStream/Redpanda** (log, không phải hàng đợi job) | Chỉ cần job nền đơn giản — quá nặng |
| Workflow nhiều bước kéo dài ngày, chờ người duyệt, cần replay chính xác | **Durable execution** (Temporal, Restate, DBOS, Inngest) — xem research mục 21 §5 | Job ngắn, độc lập |
| Lịch định kỳ | Cron trong scheduler của hệ (hoặc hệ thống job) + khoá phân tán + jitter | Nhiều instance cùng cron không khoá → chạy trùng |

Mặc định: hàng đợi trên DB chính khi quy mô S/M (ít phụ thuộc, giao dịch chung); chuyển Redis/Kafka khi đo được
nghẽn. Mọi lựa chọn ghi ADR.

## Checklist

- [ ] `BE-JOB-001` **MUST** Mọi job có **`job_key` duy nhất theo nghiệp vụ** (vd `send-invoice:{invoice_id}`) làm khoá idempotency khi enqueue và khi xử lý, hoặc thao tác tự nhiên idempotent; chạy lại không tạo trùng. Nguyên tắc: xem [`ARC-INT-001`](../05-architecture/integration-patterns.md). → Kiểm: test enqueue cùng job hai lần / chạy handler hai lần → một kết quả. · Nguồn: catalog 21 §8 (outbox/receipt)
- [ ] `BE-JOB-002` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`ARC-INT-003`](../05-architecture/integration-patterns.md): job sinh từ thay đổi dữ liệu ghi qua outbox trong cùng transaction; không enqueue trước commit, không gọi broker trong transaction.
- [ ] `BE-JOB-003` **MUST** Retry job hữu hạn: số lần cấu hình được, **mặc định 3–5**, backoff mũ có jitter và trần thời gian chờ; lỗi vĩnh viễn (4xx nghiệp vụ, validate) không retry mà vào **DLQ ngay**. Nguyên tắc retry: xem [`ARC-RES-002`](../05-architecture/resilience-and-scalability.md). → Kiểm: unit test hàm tính delay (tăng mũ, có jitter, có trần); test lỗi 4xx nghiệp vụ → không retry, có bản ghi DLQ. · Nguồn: AWS Builders' Library Timeouts, retries and backoff with jitter
- [ ] `BE-JOB-004` **MUST** Có dead-letter queue/bảng `failed_jobs` giữ payload + lỗi + số lần thử; retention DLQ dài hơn hàng đợi gốc; có cảnh báo khi DLQ > 0 trong N phút và quy trình redrive ghi trong runbook. → Kiểm: test job fail hết lượt xuất hiện trong DLQ; rule cảnh báo tồn tại ([`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)). · Nguồn: AWS SQS Dead-letter queues
- [ ] `BE-JOB-005` **MUST@L** Mỗi job có timeout thực thi; job quá hạn bị huỷ/đánh dấu và trả lại hàng đợi theo chính sách (visibility timeout/lease); timeout > thời gian chạy p99 thật. → Kiểm: test job treo → bị huỷ sau timeout, không chiếm worker vĩnh viễn. · Nguồn: AWS SQS visibility timeout
- [ ] `BE-JOB-006` **MUST@L** Worker tắt êm: ngừng nhận job mới khi nhận SIGTERM, hoàn tất hoặc trả lại job đang chạy trong thời gian ân hạn; không ack job chưa xong. → Kiểm: test gửi SIGTERM giữa job → job được chạy lại bởi worker khác, không mất. · Nguồn: Kubernetes Pod lifecycle (SIGTERM, grace 30 s)
- [ ] `BE-JOB-007` **MUST** Payload job chỉ chứa ID và tham số tối thiểu, validate bằng schema khi worker nhận; không chứa bí mật, không chứa object đã serialize dễ lệch phiên bản. → Kiểm: schema payload có test; grep payload không có `password`/`token`. · Nguồn: P6
- [ ] `BE-JOB-008` **MUST@L** Job định kỳ (cron) có khoá phân tán (`SET key NX PX` hoặc advisory lock DB) để nhiều instance không chạy trùng; lock có TTL > thời gian chạy và release chỉ khi đúng chủ (so khớp giá trị ngẫu nhiên / fencing token). → Kiểm: test 2 instance kích cùng lúc → 1 chạy; test release lock của người khác → không xoá. · Nguồn: Redis Distributed Locks (SET NX PX, DELEX/Lua, fencing token)
- [ ] `BE-JOB-009` **MUST@L** Lịch cron có jitter/offset (không đặt đúng `:00`/`:30`), chạy sớm/muộn vài phút chấp nhận được; job bỏ lỡ (instance tắt) được xử lý theo chính sách rõ (bù hay bỏ). → Kiểm: cấu hình cron không có phút `0`/`30` trừ khi có lý do; tài liệu chính sách catch-up. · Nguồn: GitHub Actions schedule (trễ ở đầu giờ), catalog 23 §2.5 (cron jitter)
- [ ] `BE-JOB-010` **MUST@L** Metric: độ sâu hàng đợi, tuổi job cũ nhất đang chờ, số job đang chạy, tỉ lệ fail, thời gian xử lý p50/p95 theo loại job; cảnh báo theo tuổi job (SLO) chứ không chỉ theo số lượng. → Kiểm: dashboard có các metric; rule cảnh báo tuổi job > ngưỡng. · Nguồn: P10, [`../15-operations/observability.md`](../15-operations/observability.md)
- [ ] `BE-JOB-011` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`ARC-INT-011`](../05-architecture/integration-patterns.md): side effect đối ngoại ghi intent trước khi gọi, lease + fencing token, `outcome_unknown` → reconcile, không retry mù (trạng thái ledger ở `BE-INT-008`).
- [ ] `BE-JOB-012` **MUST@L** Giới hạn đồng thời và tốc độ theo loại job (vd ≤ N job gọi API bên thứ ba/giây theo hạn mức của họ); job gọi API ngoài tôn trọng `Retry-After`/429. → Kiểm: cấu hình concurrency/rate limit per queue; test nhận 429 → trì hoãn đúng `Retry-After`. · Nguồn: RFC 6585 §4
- [ ] `BE-JOB-013` **SHOULD** Tách hàng đợi theo mức ưu tiên/độ trễ chấp nhận (vd `critical`, `default`, `bulk`) để job nặng không chặn job quan trọng; worker pool riêng cho job dài. → Kiểm: cấu hình ≥ 2 hàng đợi với worker riêng khi có job > 30 giây.
- [ ] `BE-JOB-014` **SHOULD** Job dài chia bước có checkpoint (tiến độ lưu DB) để chạy lại từ bước đã xong; job batch chia lô theo kích thước cố định. → Kiểm: test kill giữa chừng → chạy lại tiếp từ checkpoint.
- [ ] `BE-JOB-015` **SHOULD** Mọi job ghi log có cấu trúc với `job_id`, `job_type`, `attempt`, `duration_ms`, kết quả; `trace_id` lan truyền từ request sinh job. → Kiểm: log mẫu có đủ trường; xem [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md).
- [ ] `BE-JOB-016` **SHOULD** Phiên bản payload (`v`) và handler tương thích ngược khi deploy: worker mới xử lý được job cũ còn trong hàng đợi, và ngược lại trong thời gian rolling. → Kiểm: test handler với payload phiên bản trước.
- [ ] `BE-JOB-017` **SHOULD** Broker/DB hàng đợi có persistence và backup: Redis bật AOF (`appendfsync everysec` hoặc chặt hơn) khi là hàng đợi chính; hàng đợi DB nằm trong backup thường. → Kiểm: cấu hình Redis `appendonly yes`; xem [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md).
- [ ] `BE-JOB-018` **SHOULD** Có công cụ vận hành: xem DLQ, retry một/nhiều job, huỷ job, tạm dừng hàng đợi — có kiểm quyền và audit log. → Kiểm: lệnh/UI tồn tại; thao tác ghi log.
- [ ] `BE-JOB-019` **MAY** Dùng durable execution (Temporal/Restate/DBOS/Inngest) cho workflow nhiều bước, chờ người duyệt nhiều ngày, cần replay chính xác. → Kiểm: ADR ghi lý do và điều kiện chuyển. · Nguồn: catalog 21 §5
- [ ] `BE-JOB-020` **MAY** Test tải hàng đợi: bơm N job/giây theo mục tiêu, đo tuổi job và tỉ lệ fail trước khi ra mắt. → Kiểm: báo cáo k6/Locust trong [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md).

## Bẫy thường gặp

- **Retry vô hạn với delay cố định.** Dịch vụ xuôi dòng hỏng → "retry storm" đánh sập nó khi vừa hồi. Backoff mũ + jitter + trần số lần.
- **Enqueue trong transaction rồi rollback.** Job chạy nhưng dữ liệu không tồn tại (hoặc ngược lại). Outbox hoặc enqueue sau commit.
- **Job gửi email không idempotent.** Worker crash sau khi gửi, trước khi ack → gửi 2–3 lần. Ghi receipt provider trước ack; key idempotency theo `message_id`.
- **Cron trên nhiều replica không khoá.** Báo cáo chạy 3 lần, hoá đơn tạo trùng. Khoá phân tán có TTL + fencing.
- **Lock release bằng `DEL` thuần.** Worker chậm xoá nhầm lock của worker khác. Chỉ xoá khi giá trị khớp (`DELEX`/Lua).
- **Payload nhúng cả object.** Đổi schema → job cũ trong hàng đợi không parse được. Chỉ gửi ID, worker tải lại.
- **DLQ không ai xem.** Hàng nghìn job chết âm thầm. Cảnh báo DLQ > 0 và runbook redrive.
- **Redis không persistence làm hàng đợi chính.** Restart = mất toàn bộ job đang chờ. Bật AOF hoặc dùng hàng đợi DB.
- **Visibility timeout ngắn hơn thời gian xử lý.** Job bị giao cho worker thứ hai khi worker thứ nhất còn chạy → xử lý trùng. Timeout > p99 hoặc gia hạn lease định kỳ.
- **Timeout gọi bên thứ ba coi là thất bại rồi retry.** 504 = có thể đã chạy (catalog 23 §4.4). Reconcile trước, retry sau.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Test idempotency | test tích hợp chạy handler 2 lần cùng payload cho mọi job type | CI `quality` | 0 fail; job mới phải có test (lint danh sách job ↔ test) |
| Test backoff | unit test hàm delay: `delay(n) ≤ cap`, có jitter, tăng mũ | CI | 100% hàm retry có test |
| Cảnh báo DLQ / tuổi job | Prometheus rule `queue_oldest_job_age_seconds > SLO`, `dlq_size > 0` | prod | Theo SLO trong PROJECT.md |
| Cron lint | script kiểm cron expr không ở phút 0/30 (trừ allowlist) | CI | Diff rỗng |
| Thư viện (xác minh 2026-10-13, xác minh lại trước khi dùng) | BullMQ 6.3.13 (MIT) · Celery 5.6.3 (BSD) · River v0.49.0 (MPL-2.0) · arq 0.28.0 · dramatiq 2.2.1 · Redis 8.10.2 | code | — |
| Load test hàng đợi | `k6 run queue-load.js` | CI nightly/staging | Tuổi job p95 ≤ SLO |

## Nguồn

- AWS Builders' Library — Timeouts, retries, and backoff with jitter: <https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter> — xác minh 2026-10-13
- Amazon SQS — Using dead-letter queues (`maxReceiveCount`, retention DLQ dài hơn nguồn): <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html> — xác minh 2026-10-13
- Redis — Distributed Locks (SET NX PX, `DELEX` từ Redis 8.4, fencing token, cảnh báo clock): <https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/> — xác minh 2026-10-13
- Kubernetes — Pod Lifecycle (SIGTERM, `terminationGracePeriodSeconds` 30 s mặc định): <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/> — xác minh 2026-10-13
- GitHub Actions — Events that trigger workflows, `schedule` (trễ ở đầu giờ, tối thiểu 5 phút): <https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows> — xác minh 2026-10-13
- RFC 6585 §4 (429 + Retry-After): <https://www.rfc-editor.org/rfc/rfc6585> — xác minh 2026-10-13
- Phiên bản (registry, xác minh 2026-10-13): bullmq 6.3.13, celery 5.6.3, river v0.49.0, arq 0.28.0, dramatiq 2.2.1, Redis 8.10.2 (endoflife.date).
- (chưa xác minh) pg-boss, Graphile Worker, Procrastinate, asynq, Temporal/Restate/DBOS/Inngest phiên bản — không tra ngày 2026-10-13.
- `research/2026-10-13-stored-catalog-extraction.md` §2.10 (outbox, `outcome_unknown`, durable execution), §4 (cron jitter); catalog `21-autonomous-workflows` §5, §8; `23-own-repos-lessons` §4.4 ("504 = có thể đã chạy"), §4.5.
