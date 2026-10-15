---
title: Tích hợp: đồng bộ/bất đồng bộ, idempotency, outbox, saga, webhook
kind: module
prefix: ARC-INT
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Tích hợp: đồng bộ/bất đồng bộ, idempotency, outbox, saga, webhook

> Các mẫu để hai thành phần (module, dịch vụ, hệ bên thứ ba, agent) trao đổi **mà không mất, không nhân đôi, không
> nửa vời**: idempotency key, transactional outbox, saga, hợp đồng sự kiện có phiên bản, webhook có chữ ký + chống
> replay. Module này giữ **ngữ nghĩa mẫu**; cách nối một nhà cung cấp cụ thể (SDK, hạn mức, khoá API) ở
> [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md); hàng đợi/DLQ/lịch ở
> [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md).

## Nguyên tắc

1. **Mạng có thể hỏng sau khi phía kia đã làm.** Timeout không có nghĩa thất bại. Mọi thao tác ghi qua ranh giới
   phải **idempotent** (lặp lại cùng khoá → cùng kết quả) hoặc có cách **đối chiếu** (reconcile) bằng đọc lại.
2. **At-least-once + khử trùng** là mặc định của hệ phân tán; exactly-once chỉ tồn tại ở mức ngữ nghĩa nhờ
   idempotency ở consumer.
3. **Ghi CSDL và phát sự kiện phải nguyên tử** → transactional outbox; không gửi message trong transaction, không
   gửi sau commit mà không có bản ghi.
4. **Nhiều dịch vụ, một giao dịch nghiệp vụ** → saga với bù trừ (compensation) tường minh, không 2PC.
5. **Hợp đồng (API/sự kiện/webhook) là code có phiên bản**, thay đổi tương thích ngược theo mặc định; phá vỡ → phiên
   bản mới + thời hạn ngừng.
6. **Webhook là input không tin cậy** (P6): kiểm chữ ký, dấu thời gian, id; xử lý idempotent; trả 2xx nhanh rồi
   xử lý nền.
7. **Tác động đối ngoại của agent** (đăng bài, gửi tiền, gọi API ghi) đi qua outbox có lease + fencing token; kết quả
   không rõ (`outcome_unknown`) thì đối chiếu, không retry mù (catalog 21 §8, 23 §4.5).

## Quyết định

| Nhu cầu | Mẫu | Không dùng khi |
|---|---|---|
| Cần câu trả lời ngay để tiếp tục (đọc, kiểm quyền, tính giá) | **Gọi đồng bộ** (REST/gRPC) có timeout + retry theo [`resilience-and-scalability.md`](resilience-and-scalability.md) | Phía gọi có thể chờ; phía được gọi chậm/không ổn định |
| Tác động phụ sau một thay đổi dữ liệu (gửi mail, cập nhật index, thông báo dịch vụ khác) | **Outbox** + relay → hàng đợi/broker | Cùng tiến trình và cùng transaction làm được |
| Relay outbox | **Polling publisher** (đơn giản, mọi CSDL) mặc định · **CDC/log tailing** (Debezium 3.7, outbox event router) khi khối lượng lớn hoặc cần độ trễ thấp | CDC khi đội chưa vận hành Kafka/Connect |
| Giao dịch xuyên ≥ 2 dịch vụ | **Saga orchestration** (một bộ điều phối, dễ theo dõi) mặc định · **choreography** khi ≤ 3 bước và không có vòng | Có thể gộp về một dịch vụ sở hữu dữ liệu (ưu tiên) |
| Luồng chạy dài, chờ người duyệt, phải sống qua crash | **Durable execution** (Temporal CLI 1.9.1 MIT; Restate/Inngest/DBOS — phiên bản chưa xác minh) thay vì tự viết state machine | Luồng < vài giây, không cần sống qua restart |
| Nhận sự kiện từ bên ngoài | **Webhook theo Standard Webhooks 1.0.0** (HMAC-SHA256, `webhook-id/-timestamp/-signature`) hoặc polling khi đối tác không ký | Đối tác không hỗ trợ chữ ký và dữ liệu nhạy cảm → polling có xác thực |
| Gửi sự kiện cho bên ngoài | Webhook đi theo cùng chuẩn, lịch retry backoff + jitter nhiều ngày | Đối tác cần batch → file/API batch |
| Nhiều consumer, replay lịch sử | **Event stream** (log có offset) | Chỉ một consumer, không cần replay → hàng đợi thường |

Khoá idempotency: header `Idempotency-Key` theo Internet-Draft `draft-ietf-httpapi-idempotency-key-header-07`
(**đã expired** 2025-10/2026-04, chưa là RFC — dùng như quy ước de-facto, ghi rõ trong hợp đồng API).

## Checklist

- [ ] `ARC-INT-001` **MUST** Mọi endpoint/handler tạo hoặc ghi có tác động (POST, lệnh, job) nhận khoá idempotency và trả cùng kết quả cho cùng khoá trong cửa sổ lưu. → Kiểm: test gửi 2 request cùng `Idempotency-Key` → 1 bản ghi/1 giao dịch, response thứ hai bằng response đầu; bảng/khoá lưu idempotency có TTL. · Nguồn: RFC 9110 §9.2.2 · draft-ietf-httpapi-idempotency-key-header-07
- [ ] `ARC-INT-002` **MUST@L** Khoá idempotency dẫn xuất từ id nghiệp vụ hoặc do client sinh (UUID), gắn với chủ thể (user/tenant); khoá khác payload → trả lỗi, không ghi đè (HTTP: 422; mã lỗi đầy đủ ở [`BE-API-008`](../08-backend/api-design.md)). → Kiểm: test cùng khoá + payload khác → lỗi; khoá của user A không dùng được cho user B. · Nguồn: khung cũ spec §C2-FR-05/§C3-FR-04 (`git show 1b80fe4:docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md`)
- [ ] `ARC-INT-003` **MUST** Thay đổi dữ liệu và việc phát sự kiện/tác động phụ được ghi trong **cùng một transaction** qua bảng outbox; không gọi broker/HTTP bên trong transaction. → Kiểm: grep không có client broker/HTTP trong khối transaction; test tắt broker → bản ghi outbox vẫn tạo và được gửi sau khi broker lên. · Nguồn: microservices.io Transactional outbox
- [ ] `ARC-INT-004` **MUST@L** Bảng outbox có tối thiểu `id` (UUID), `aggregate_type`, `aggregate_id`, `event_type`, `payload`, `created_at`, trạng thái/`published_at`; thứ tự phát theo `aggregate_id`. → Kiểm: migration tạo bảng với các cột đó; test hai sự kiện cùng aggregate đến consumer đúng thứ tự. · Nguồn: Debezium outbox event router (cột mặc định)
- [ ] `ARC-INT-005` **MUST** Consumer khử trùng theo `message_id`/`event_id` (bảng `processed_messages` hoặc khoá duy nhất) vì relay là at-least-once. → Kiểm: test phát cùng message 2 lần → tác động 1 lần; ràng buộc UNIQUE trên id đã xử lý. · Nguồn: microservices.io Transactional outbox (duplicate delivery)
- [ ] `ARC-INT-006` **MUST@L** Saga có bước bù trừ cho mỗi bước có thể hoàn tác, bù trừ idempotent và retry được; bước pivot (không hoàn tác) được đánh dấu. → Kiểm: tài liệu saga liệt kê bước → bù trừ → pivot; test chèn lỗi sau bước k → trạng thái cuối nhất quán (không nửa vời). · Nguồn: Azure Saga (compensable/pivot/retryable)
- [ ] `ARC-INT-007` **MUST@L** Không dùng giao dịch phân tán 2PC/XA giữa dịch vụ; nhất quán xuyên dịch vụ qua saga/outbox. → Kiểm: grep không có XA/`PREPARE TRANSACTION` xuyên dịch vụ; ADR nếu ngoại lệ. · Nguồn: microservices.io Saga
- [ ] `ARC-INT-008` **MUST** Webhook vào: xác minh chữ ký HMAC-SHA256 trên **payload thô** (không re-serialize), so sánh thời gian hằng, từ chối khi `timestamp` ngoài cửa sổ chấp nhận, khử trùng theo `webhook-id`. → Kiểm: test 4 ca: chữ ký sai → 401; timestamp cũ → 400; id lặp → 200 không xử lý lại; payload re-serialize → vẫn verify đúng vì dùng raw body. · Nguồn: Standard Webhooks 1.0.0 · catalog 23 §4.1 (SePay HMAC + idempotent)
- [ ] `ARC-INT-009` **MUST@L** Webhook vào trả 2xx ngay sau khi ghi nhận (persist) rồi xử lý nền; xử lý nền idempotent. → Kiểm: handler ghi vào bảng/hàng đợi rồi trả về trong < timeout nhà cung cấp; test xử lý lại cùng bản ghi → một tác động. · Nguồn: Standard Webhooks 1.0.0 (chỉ 2xx là thành công)
- [ ] `ARC-INT-010` **MUST@L** Webhook ra: ký theo cùng chuẩn (id, timestamp, signature; hỗ trợ ≥ 2 chữ ký để xoay bí mật), retry theo backoff mũ + jitter nhiều ngày, coi 3xx là thất bại, dừng khi 410, tôn trọng `Retry-After` với 429/502/504. → Kiểm: test lịch retry; test xoay secret không gián đoạn; endpoint nhận 410 bị vô hiệu. · Nguồn: Standard Webhooks 1.0.0
- [ ] `ARC-INT-011` **MUST@L** Tác động đối ngoại (gửi tiền, đăng bài, gọi API ghi của bên thứ ba) ghi **intent** trước khi gọi, có lease + fencing token, và trạng thái `outcome_unknown` được đối chiếu bằng đọc lại thay vì retry mù. → Kiểm: bảng intent có `lease_until`, `fencing_token`, `status`; test giết tiến trình giữa chừng → không gọi lại khi receipt đã tồn tại. · Nguồn: catalog 21 §8 · 23 §4.5 (Sales-Hunter ADR-0010)
- [ ] `ARC-INT-012` **MUST@L** Mỗi loại sự kiện/thông điệp có schema có phiên bản (JSON Schema/Avro/protobuf) lưu trong repo; thay đổi phá vỡ → tên/phiên bản mới, consumer cũ vẫn nhận phiên bản cũ đến hạn ngừng. → Kiểm: thư mục `contracts/events/*.v{n}.json`; contract test consumer chạy trong CI (xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md)). · Nguồn: P5 · [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `ARC-INT-013` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`OPS-OBS-002`](../15-operations/observability.md): mỗi thông điệp/sự kiện mang `traceparent` (W3C Trace Context) để truy vết xuyên producer → queue → consumer.
- [ ] `ARC-INT-014` **SHOULD** Outbox relay giám sát được: tuổi bản ghi chưa gửi lâu nhất và số bản ghi tồn là metric có cảnh báo. → Kiểm: metric `outbox_oldest_unpublished_seconds` tồn tại; cảnh báo cấu hình. · Nguồn: P10
- [ ] `ARC-INT-015` **SHOULD** Thông điệp không chứa dữ liệu nhạy cảm thô; chỉ id + trường tối thiểu, consumer tra cứu thêm khi cần. → Kiểm: schema sự kiện không có trường PII/bí mật (lint schema theo danh sách cấm). · Nguồn: [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md)
- [ ] `ARC-INT-016` **SHOULD** Luồng chạy dài/có chờ người dùng durable execution hoặc máy trạng thái bền (bảng + bước idempotent) thay vì giữ trạng thái trong bộ nhớ tiến trình. → Kiểm: test giết tiến trình giữa luồng → luồng tiếp tục đúng bước sau khi khởi động lại. · Nguồn: catalog 21 §5
- [ ] `ARC-INT-017` **SHOULD** Hợp đồng API đồng bộ có OpenAPI/proto commit trong repo, breaking change phát hiện bằng công cụ diff. → Kiểm: job CI chạy diff hợp đồng (vd `oasdiff`/`buf breaking` — phiên bản theo lockfile) và đỏ khi breaking không có phiên bản mới. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `ARC-INT-018` **SHOULD** Có runbook "đối chiếu" (reconcile) định kỳ giữa hệ mình và đối tác cho giao dịch tiền/đơn hàng; chênh lệch → cảnh báo. → Kiểm: job đối chiếu chạy theo lịch, báo cáo lưu; test giả lập lệch → cảnh báo. · Nguồn: catalog 21 §8
- [ ] `ARC-INT-019` **SHOULD** Thời hạn ngừng (deprecation) của phiên bản hợp đồng cũ công bố trong tài liệu + header `Deprecation`/`Sunset`; có metric lượng dùng phiên bản cũ. → Kiểm: tài liệu có bảng phiên bản + ngày; metric theo phiên bản. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `ARC-INT-020` **MAY** CDC (Debezium) cho outbox khi độ trễ polling không đạt; outbox vẫn là bảng, không tail log của bảng nghiệp vụ trực tiếp. → Kiểm: cấu hình connector dùng outbox event router; không có connector trên bảng nghiệp vụ.
- [ ] `ARC-INT-021` **MAY** Saga choreography chỉ khi ≤ 3 bước, không vòng, và có sơ đồ sự kiện trong `docs/architecture/`. → Kiểm: sơ đồ tồn tại; ARC-STYLE-008 không vi phạm.
- [ ] `ARC-INT-022` **MAY** Cung cấp endpoint/phương thức "trạng thái giao dịch" để client hỏi lại thay vì gửi lại. → Kiểm: hợp đồng API có `GET /…/{id}/status`; test client timeout → hỏi status → không tạo trùng.

## Bẫy thường gặp

- **Gửi message trong transaction** (hoặc ngay sau commit không qua outbox): broker nhận trước khi commit, hoặc crash
  giữa commit và gửi → mất/giả sự kiện. Tránh: ARC-INT-003.
- **Retry mù sau timeout** → tính tiền hai lần, đăng bài hai lần. Tránh: ARC-INT-001/011 (intent + đọc lại receipt).
- **Verify chữ ký trên JSON đã parse rồi stringify lại** → sai khoảng trắng/thứ tự khoá → lúc đúng lúc sai. Tránh:
  verify trên raw body (ARC-INT-008).
- **Xử lý webhook đồng bộ nặng** → nhà cung cấp timeout, retry dồn dập, xử lý trùng. Tránh: ARC-INT-009.
- **Saga không có bù trừ cho bước đã commit** → "đã trừ kho nhưng đơn hủy". Tránh: ARC-INT-006, bảng bước → bù trừ.
- **Consumer giả định exactly-once** vì "broker hỗ trợ". Tránh: ARC-INT-005 — khử trùng ở consumer luôn.
- **Hợp đồng sự kiện ngầm** (payload là dict tự do) → đổi tên trường, consumer vỡ im lặng. Tránh: ARC-INT-012.
- **"Đã đăng" vì gọi API không lỗi** — không có receipt đọc lại. Tránh: ARC-INT-011/018 (catalog 21 §8).
- **Dùng draft Idempotency-Key như RFC**: draft đã expired; ghi rõ trong tài liệu API rằng đây là quy ước.

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Idempotency endpoint | test tích hợp của dự án (vitest/pytest/go test) | gửi 2 request cùng khoá | CI | 1 tác động, response bằng nhau |
| Outbox nguyên tử | test với broker tắt (testcontainers/ toxiproxy 2.12.0 MIT) | `toxiproxy-cli toggle broker` rồi chạy luồng | CI | bản ghi outbox tồn tại, gửi sau khi bật |
| Khử trùng consumer | test phát trùng message | replay cùng `event_id` | CI | tác động = 1 |
| Chữ ký webhook | thư viện Standard Webhooks (Apache-2.0) + test 4 ca | `npm test`/`pytest` | CI | 4/4 xanh |
| Breaking change hợp đồng | `oasdiff` / `buf breaking` (phiên bản theo lockfile, chưa xác minh) | `oasdiff breaking old.yaml new.yaml` | CI (PR) | 0 breaking không phiên bản mới |
| Schema sự kiện hợp lệ | `ajv-cli`/`check-jsonschema` (phiên bản theo lockfile) | validate `contracts/events/*.json` | pre-commit + CI | 0 lỗi |
| Outbox tồn đọng | metric + cảnh báo (xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)) | `outbox_oldest_unpublished_seconds` | production | ngưỡng theo SLO của luồng |
| Chống retry đa tầng/timeout | xem [`resilience-and-scalability.md`](resilience-and-scalability.md) | — | — | — |

## Nguồn

- Microservices.io — Transactional outbox (polling publisher / log tailing, at-least-once): <https://microservices.io/patterns/data/transactional-outbox.html>; Saga: <https://microservices.io/patterns/data/saga.html> — xác minh 2026-10-13.
- Azure Architecture Center — Saga (compensable/pivot/retryable, anomalies & countermeasures), ms.date 2025-02-25: <https://learn.microsoft.com/en-us/azure/architecture/patterns/saga> — xác minh 2026-10-13.
- Standard Webhooks spec v1.0.0 (headers, HMAC-SHA256 `v1`, timestamp tolerance, retry schedule, 410/429/`retry-after`): <https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md> — xác minh 2026-10-13.
- RFC 9110 §9.2.2 Idempotent Methods: <https://www.rfc-editor.org/rfc/rfc9110.html> — xác minh 2026-10-13.
- IETF Internet-Draft `draft-ietf-httpapi-idempotency-key-header-07` (expired; header `Idempotency-Key`): <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/> — xác minh 2026-10-13.
- Debezium 3.7 (stable) — Outbox Event Router: <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html> — xác minh 2026-10-13.
- Temporal CLI 1.9.1 MIT: <https://formulae.brew.sh/api/formula/temporal.json>; toxiproxy 2.12.0 MIT: <https://formulae.brew.sh/api/formula/toxiproxy.json> — xác minh 2026-10-13. Restate/Inngest/DBOS: phiên bản **(chưa xác minh)**.
- Catalog `seeker19110/stored` 21 §5 (durable execution), 21 §8 và 23 §4.5 (outbox/lease/fencing/`outcome_unknown`, Sales-Hunter ADR-0010), 23 §4.1 (SePay VietQR HMAC + idempotent), đọc 2026-10-13.
- Khung cũ spec `AI-HARNESS-AND-COMPANY-SPEC.md` §C2-FR-05, §C3-FR-04 (idempotency_key dẫn xuất `run_id + step_id`), commit `1b80fe4`.
