---
title: Tích hợp bên thứ ba, webhook vào/ra, chữ ký, replay
kind: module
prefix: BE-INT
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Tích hợp bên thứ ba, webhook vào/ra, chữ ký, replay

> Mọi ranh giới với hệ ngoài (thanh toán, SMS, email, CRM, LLM API, webhook vào/ra) là nơi **mất tiền, mất dữ
> liệu và bị giả mạo** nhiều nhất. Module này chuẩn hoá: adapter cô lập, chữ ký HMAC + timestamp chống replay,
> receiver idempotent, receipt cho side effect, và quy tắc "504 = có thể đã chạy". **Ngữ nghĩa** (idempotency, outbox,
> webhook vào/ra, intent + `outcome_unknown`) là nhà của [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md),
> retry là nhà của [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md);
> ở đây chỉ giữ **số vận hành, header, cấu hình vendor**. Timeout/retry phía dịch vụ ở [`reliability-and-errors.md`](reliability-and-errors.md).

## Nguyên tắc

1. **Mọi hệ ngoài nằm sau một adapter** có interface của mình, có bản giả (fake) để test, có thể thay nhà cung cấp
   mà không chạm nghiệp vụ. Không gọi SDK vendor rải rác trong handler.
2. **Webhook vào là đầu vào không tin cậy (P6):** xác minh chữ ký trên *raw body*, kiểm timestamp, khử trùng theo
   ID, validate schema, rồi mới xử lý — và xử lý bất đồng bộ sau khi đã trả 2xx.
3. **Side effect ra ngoài phải có receipt.** "Đã gửi" chỉ đúng khi đọc lại được từ bên kia (ID giao dịch, trạng
   thái); timeout không phải thất bại mà là *không biết* → reconcile.
4. **Hợp đồng với bên ngoài được ghim:** phiên bản API/SDK ghim, schema sự kiện validate, thay đổi của vendor
   được theo dõi (changelog/deprecation) như một phụ thuộc.
5. **Không bí mật trong code; mỗi tích hợp một credential có scope hẹp, xoay được** —
   [`../12-security/secrets-management.md`](../12-security/secrets-management.md).

## Quyết định

| Nhu cầu | Chọn | Khi nào không |
|---|---|---|
| Nhận sự kiện từ vendor | **Webhook ký HMAC + timestamp** (Standard Webhooks / Stripe / GitHub kiểu) + hàng đợi xử lý | Vendor không ký → bọc bằng IP allowlist + token trong header riêng, vẫn validate schema; không tin chỉ URL bí mật |
| Gửi sự kiện ra cho khách hàng | Phát webhook theo **Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`), retry backoff nhiều ngày, bảng delivery có trạng thái | Chỉ có vài client nội bộ → gọi API/queue trực tiếp |
| Đồng bộ dữ liệu lớn/định kỳ | Pull theo lịch có cursor/`updated_since` + webhook để kích sớm | Chỉ dựa webhook (mất sự kiện khi downtime) |
| Gọi API vendor có phí/tác dụng phụ | Qua outbox + `Idempotency-Key` của vendor (nếu có) + receipt | Gọi trực tiếp trong request của người dùng rồi retry mù |
| Xác minh chữ ký | HMAC-SHA256 so sánh thời gian hằng, tolerance timestamp (5 phút là giá trị phổ biến) | Tự thiết kế scheme ký |
| Nhiều vendor cùng vai (SMS, email) | Interface chung + adapter mỗi vendor + fallback có chủ đích | Trừu tượng hoá quá sớm khi chỉ có một vendor |
| Test tích hợp | Fake adapter cho unit/CI; sandbox vendor cho staging; contract test ghi lại (record/replay) | Gọi vendor thật trong CI |

## Checklist

- [ ] `BE-INT-001` **MUST@L** Mỗi hệ ngoài có adapter riêng (interface + implementation + fake); nghiệp vụ không import SDK vendor trực tiếp. → Kiểm: lint import (dependency-cruiser/import-linter) chặn `stripe`/`twilio`/`openai`… ngoài thư mục adapter. · Nguồn: [`../05-architecture/boundaries-and-modularity.md`](../05-architecture/boundaries-and-modularity.md)
- [ ] `BE-INT-002` **MUST** Webhook vào — phần vận hành: secret ký theo từng vendor × môi trường, chấp nhận **≥ 2 secret cùng lúc** trong thời gian xoay (không downtime), chữ ký sai → 400/401. Nguyên tắc (HMAC trên raw body, so sánh hằng thời gian, timestamp, khử trùng): xem [`ARC-INT-008`](../05-architecture/integration-patterns.md). → Kiểm: test body sửa 1 byte → 400; test chữ ký với secret cũ trong thời gian xoay → 200. · Nguồn: Standard Webhooks v1.0.0, Stripe Webhooks, GitHub Validating webhook deliveries
- [ ] `BE-INT-003` **MUST@L** Webhook vào: tolerance timestamp mặc định **5 phút** (không bao giờ 0, không tắt) để chống replay; đồng hồ server đồng bộ NTP. Nguyên tắc: xem [`ARC-INT-008`](../05-architecture/integration-patterns.md). → Kiểm: test timestamp cũ 10 phút → từ chối. · Nguồn: Stripe Webhooks (tolerance 5 phút), Standard Webhooks
- [ ] `BE-INT-004` **MUST** Receiver webhook khử trùng theo đúng header ID của vendor (`webhook-id`/`X-GitHub-Delivery`/`event.id`), lưu ở store dùng chung với **TTL ≥ cửa sổ retry của vendor**; sự kiện trùng → 2xx không xử lý lại; không dựa vào thứ tự sự kiện. Nguyên tắc khử trùng consumer: xem [`ARC-INT-005`](../05-architecture/integration-patterns.md). → Kiểm: test gửi cùng sự kiện 2 lần → 1 side effect; test sự kiện đến sai thứ tự → trạng thái cuối đúng. · Nguồn: Stripe Webhooks (duplicate events, ordering), GitHub Best practices
- [ ] `BE-INT-005` **MUST@L** Handler webhook vào trả 2xx trong **< 5 s** (GitHub cắt ở 10 s; mục tiêu p95 < 1 s) sau khi xác minh + lưu/enqueue; xử lý nặng chạy trong job ([`background-jobs-and-queues.md`](background-jobs-and-queues.md)); route webhook miễn CSRF nhưng không miễn chữ ký. Nguyên tắc: xem [`ARC-INT-009`](../05-architecture/integration-patterns.md). → Kiểm: test handler trả 2xx trước khi job chạy; đo p95 handler < 1 s. · Nguồn: GitHub Best practices for webhooks (10 s), Stripe Webhooks
- [ ] `BE-INT-006` **MUST@L** Payload webhook được validate bằng schema của loại sự kiện (allowlist loại); sự kiện lạ → log + 2xx (không 5xx gây retry vô ích); không tin dữ liệu "thin" — đọc lại object từ API vendor khi quyết định quan trọng (tiền, quyền). → Kiểm: test payload thiếu trường → không xử lý, có log; test sự kiện `payment.succeeded` → có call đọc lại trước khi cấp quyền. · Nguồn: P6, Stripe thin events
- [ ] `BE-INT-007` **MUST** Gọi API vendor có tác dụng phụ gửi **`Idempotency-Key` của vendor** (Stripe…) khi vendor hỗ trợ, khoá dẫn xuất từ id intent để mọi lần thử lại/reconcile dùng cùng khoá; tôn trọng 429 `Retry-After` của vendor. Nguyên tắc retry: xem [`ARC-RES-002`](../05-architecture/resilience-and-scalability.md); timeout sau khi gửi = không biết → [`ARC-INT-011`](../05-architecture/integration-patterns.md). → Kiểm: test mô phỏng timeout sau khi vendor nhận → lần gọi lại cùng khoá, không tạo trùng; test 429 → chờ đúng `Retry-After`. · Nguồn: catalog 23 §4.4 ("504 = có thể đã chạy"), §4.5; RFC 6585
- [ ] `BE-INT-008` **MUST@L** Ledger side effect đối ngoại dùng trạng thái `pending → sent → confirmed | failed | unknown` và lưu receipt/ID giao dịch của vendor; chỉ chuyển `confirmed` khi có receipt. Nguyên tắc (intent trước khi gọi, lease + fencing token, reconcile `outcome_unknown`): xem [`ARC-INT-011`](../05-architecture/integration-patterns.md). → Kiểm: test crash giữa gọi và ghi → trạng thái `unknown` → reconcile job sửa đúng. · Nguồn: catalog 21 §8 mục 8 (outbox/lease/receipt)
- [ ] `BE-INT-009` **MUST@L** Credential tích hợp: mỗi vendor/môi trường một secret, scope tối thiểu, nạp từ secret store, không log; sandbox/test key ở non-prod. → Kiểm: grep repo không có `sk_live`/`whsec_`; cấu hình staging dùng key sandbox. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `BE-INT-010` **MUST** URL webhook ra do khách hàng cấu hình: chỉ `https://`, chặn SSRF (resolve DNS rồi từ chối IP private/loopback/link-local/metadata, không theo redirect), timeout 15–30 s, giới hạn kích thước phản hồi. → Kiểm: test đăng ký `http://169.254.169.254` hoặc hostname resolve về 10.x → bị từ chối. · Nguồn: Standard Webhooks (SSRF), OWASP SSRF Prevention
- [ ] `BE-INT-011` **MUST@L** Webhook ra — phần vận hành: header Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` = `v1,base64(HMAC-SHA256("id.ts.body"))`); bảng delivery có trạng thái và UI/API xem + gửi lại. Nguyên tắc (ký, retry backoff nhiều ngày, 3xx = thất bại, 410 = tắt endpoint): xem [`ARC-INT-010`](../05-architecture/integration-patterns.md). → Kiểm: test ký/xác minh bằng thư viện Standard Webhooks; test endpoint trả 500 → lịch retry đúng; API gửi lại một delivery hoạt động. · Nguồn: Standard Webhooks v1.0.0
- [ ] `BE-INT-012` **MUST@L** Giám sát tích hợp: metric số gọi/lỗi/latency theo vendor, tuổi delivery webhook chờ, DLQ tích hợp; cảnh báo khi tỉ lệ lỗi vendor vượt ngưỡng; kill switch tắt tích hợp theo cấu hình. → Kiểm: dashboard theo vendor; feature flag tắt được; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md).
- [ ] `BE-INT-013` **MUST@L** Reconcile định kỳ với nguồn sự thật của vendor (vd đối soát giao dịch thanh toán hằng ngày; đồng bộ lại trạng thái `unknown`), kết quả lệch sinh cảnh báo/ticket. → Kiểm: job reconcile có lịch; báo cáo lệch gần nhất. · Nguồn: catalog 21 §8
- [ ] `BE-INT-014` **MUST@L** Phiên bản API/SDK vendor được ghim (header version như `Stripe-Version`, lockfile); nâng cấp qua PR có test contract; theo dõi deprecation của vendor. → Kiểm: version header cố định trong cấu hình; lockfile ghim; xem [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md).
- [ ] `BE-INT-015` **SHOULD** Test: unit với fake adapter; contract test record/replay (VCR/nock/respx) cập nhật có chủ đích; smoke trên sandbox vendor ở staging; không gọi vendor thật trong CI. → Kiểm: CI không có network tới domain vendor (allowlist egress); cassette có ngày ghi.
- [ ] `BE-INT-016` **SHOULD** Xử lý sự kiện theo **trạng thái cuối** (so `updated_at`/version) thay vì theo thứ tự đến; sự kiện cũ hơn trạng thái hiện có → bỏ qua có log. → Kiểm: test sự kiện cũ đến sau → không ghi đè.
- [ ] `BE-INT-017` **SHOULD** Nhật ký tích hợp (request/response rút gọn, đã che PII/secret) lưu đủ để debug và đối soát, retention theo chính sách. → Kiểm: mẫu log có `vendor`, `operation`, `external_id`, `duration_ms`, không chứa token.
- [ ] `BE-INT-018` **SHOULD** Egress allowlist: dịch vụ chỉ được gọi ra các domain vendor đã khai báo; agent/LLM tool gọi ra ngoài đi qua gateway có allowlist. → Kiểm: cấu hình network policy/proxy; xem [`../12-security/infrastructure-and-network.md`](../12-security/infrastructure-and-network.md).
- [ ] `BE-INT-019` **MAY** Dùng RFC 9421 HTTP Message Signatures + `Content-Digest` (RFC 9530) khi cần chữ ký chuẩn IETF liên tổ chức thay vì scheme vendor. → Kiểm: thư viện hỗ trợ RFC 9421; test xác minh. · Nguồn: RFC 9421
- [ ] `BE-INT-020` **MAY** IP allowlist của vendor làm lớp bổ sung (không thay chữ ký); cập nhật tự động từ nguồn chính thức. → Kiểm: job cập nhật danh sách IP có lịch. · Nguồn: Stripe Webhooks (IP allowlisting + signature)

## Bẫy thường gặp

- **Xác minh chữ ký trên body đã parse rồi `JSON.stringify` lại.** Khoảng trắng/thứ tự khoá đổi → sai chữ ký ngẫu nhiên, rồi dev tắt xác minh. Dùng raw body.
- **So sánh chữ ký bằng `==`.** Timing attack. `crypto.timingSafeEqual`/`hmac.compare_digest`.
- **Tolerance timestamp = 0 hoặc không kiểm.** Replay sự kiện "đã thanh toán" cũ → cấp quyền lại. 5 phút + khử trùng ID.
- **Xử lý webhook đồng bộ trong handler.** Vendor timeout 10 s → retry bão → xử lý trùng. Trả 2xx rồi job.
- **Tin thứ tự sự kiện.** `invoice.paid` đến trước `invoice.created`. Dùng trạng thái cuối, đọc lại object.
- **Coi timeout là thất bại rồi gửi lại.** Gửi SMS/thanh toán 2 lần. 504 = không biết → reconcile.
- **URL bí mật làm "xác thực" webhook.** URL lọt log/proxy. Luôn chữ ký.
- **Nhận URL webhook từ khách hàng không chặn SSRF.** Gọi vào metadata endpoint cloud → lộ credential.
- **Một API key vendor dùng cho mọi môi trường.** Staging gửi email thật cho khách. Key sandbox cho non-prod.
- **Vendor đổi payload không báo.** Schema validate + contract test có cassette ngày ghi + theo dõi changelog vendor.
- **Mâu thuẫn nguồn:** Standard Webhooks không quy định tolerance cụ thể (chỉ "allowable tolerance"); Stripe mặc định 5 phút. Khung chọn **5 phút mặc định, cấu hình được, không 0**.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Lint ranh giới adapter | dependency-cruiser (MIT) / import-linter (BSD): cấm import SDK vendor ngoài `adapters/` | pre-commit + CI | 0 vi phạm |
| Test chữ ký/replay/idempotent | bộ test tích hợp cho mỗi webhook vào: sai chữ ký, timestamp cũ, trùng ID, sai thứ tự | CI `quality` | 0 fail; webhook mới phải có 4 test |
| Test SSRF | test đăng ký URL private/loopback/metadata → từ chối | CI | Pass |
| Secret scan | gitleaks v8.30.1 (MIT) với rule vendor key | pre-commit + CI | 0 leak |
| Egress | CI chạy không có network tới vendor (proxy allowlist rỗng) — gọi thật phải fail | CI | Không có call thật |
| Reconcile | job đối soát có lịch + cảnh báo lệch | prod | Lệch = 0 hoặc có ticket |
| Thư viện | Standard Webhooks SDK (Apache-2.0) · SDK vendor ghim phiên bản trong lockfile | code | Xác minh lại trước khi dùng |

## Nguồn

- Standard Webhooks Specification v1.0.0 (Apache-2.0; header, `v1,` HMAC-SHA256 base64 trên `id.ts.body`, secret `whsec_` 24–64 byte, retry tới ~75 giờ, 3xx = fail, 410 = tắt, timeout 15–30 s): <https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/main/spec/standard-webhooks.md> — xác minh 2026-10-13
- Stripe — Receive events in your webhook endpoint (tolerance 5 phút, raw body, 2xx nhanh, retry 3 ngày, không bảo đảm thứ tự, khử trùng theo event ID, xoay secret 24 giờ): <https://docs.stripe.com/webhooks> — xác minh 2026-10-13
- Stripe — Idempotent requests: <https://docs.stripe.com/api/idempotent_requests> — xác minh 2026-10-13
- GitHub — Validating webhook deliveries (`X-Hub-Signature-256`, so sánh thời gian hằng): <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> · Best practices (trả 2xx trong 10 s, `X-GitHub-Delivery`): <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks> — xác minh 2026-10-13
- RFC 9421 HTTP Message Signatures (+ RFC 9530 Content-Digest): <https://www.rfc-editor.org/rfc/rfc9421> — xác minh 2026-10-13
- RFC 6585 §4 (429/Retry-After): <https://www.rfc-editor.org/rfc/rfc6585> — xác minh 2026-10-13
- (chưa xác minh) OWASP SSRF Prevention Cheat Sheet — không fetch ngày 2026-10-13; quy tắc SSRF trong mục 010 theo Standard Webhooks + thực hành phổ biến.
- `research/2026-10-13-stored-catalog-extraction.md` §2.10 (outbox, `outcome_unknown`, receipt), §4 (cooldown gateway); catalog `21-autonomous-workflows` §8; `23-own-repos-lessons` §4.1 (SePay VietQR webhook HMAC + idempotent), §4.4, §4.5 (Sales-Hunter ADR-0010).
