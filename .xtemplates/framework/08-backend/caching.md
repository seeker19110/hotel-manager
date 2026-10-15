---
title: Cache: tầng, key, TTL, vô hiệu hoá, stampede
kind: module
prefix: BE-CACHE
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Cache: tầng, key, TTL, vô hiệu hoá, stampede

> Cache là tối ưu có chủ đích, không phải mặc định: mỗi cache có **key có quy ước, TTL có lý do, cách vô hiệu
> hoá rõ, chống stampede và không bao giờ trộn dữ liệu giữa người dùng**. Bao gồm cache HTTP (RFC 9111), cache
> ứng dụng (Redis/in-memory) và CDN. Hiệu năng tổng thể ở [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md).

## Nguyên tắc

1. **Đo trước, cache sau.** Cache chỉ thêm khi có số đo (p95, tải DB) và mục tiêu; không cache "cho chắc".
2. **Đúng › nhanh (P3).** Dữ liệu người dùng, phân quyền, giá, số dư: hoặc không cache, hoặc cache theo khoá chứa
   `user_id`/`tenant_id` và vô hiệu hoá khi đổi. Lộ dữ liệu chéo người dùng là sự cố bảo mật, không phải bug hiệu năng.
3. **Mọi cache có TTL.** Không có entry sống vĩnh viễn; TTL là hàng rào cuối khi vô hiệu hoá sai.
4. **Vô hiệu hoá là thiết kế, không phải vá.** Chọn một trong: TTL ngắn, xoá theo sự kiện (event-driven), hoặc
   key có phiên bản (`v{n}`/hash nội dung). Viết ra ở ADR/spec.
5. **Thất bại mềm.** Cache hỏng → ứng dụng vẫn chạy (chậm hơn), không 500; có circuit breaker cho cache ngoài.

## Quyết định

| Nhu cầu | Chọn | Khi nào không |
|---|---|---|
| Tài nguyên tĩnh (JS/CSS/ảnh có hash tên file) | HTTP `Cache-Control: public, max-age=31536000, immutable` qua CDN | File không có hash trong tên |
| Trang/API công khai thay đổi theo phút | `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` + `ETag` | Nội dung theo người dùng |
| Phản hồi theo người dùng | `Cache-Control: private, no-store` (hoặc `private, max-age` ngắn) + `Vary` đúng; không cache CDN | — |
| Kết quả truy vấn DB nặng dùng chung | Cache ứng dụng (Redis) key theo tham số + phiên bản schema, TTL theo độ "tươi" chấp nhận | Truy vấn rẻ hơn chi phí mạng tới Redis |
| Dữ liệu nhỏ, đọc cực nhiều, chấp nhận lệch giữa instance | In-memory per-process (LRU có kích thước) + TTL ngắn | Cần nhất quán giữa instance ngay lập tức |
| Nhiều request cùng miss một key nóng | **Single-flight** (gộp request cùng key trong process) + khoá/lease ở Redis + serve-stale | — |
| Vô hiệu hoá | Key có phiên bản/hash (rẻ, không cần xoá) › xoá theo sự kiện (chính xác) › TTL ngắn (đơn giản) | Xoá bằng `KEYS pattern` trong Redis production |
| Session/giỏ hàng | Store có persistence (Redis AOF/DB), không phải "cache" có thể mất | Coi cache là nơi lưu dữ liệu nghiệp vụ |

Mặc định: bắt đầu bằng cache HTTP đúng header (miễn phí, chuẩn), rồi mới cache ứng dụng khi đo thấy cần.

## Checklist

- [ ] `BE-CACHE-001` **MUST** Phản hồi chứa dữ liệu theo người dùng/phiên có `Cache-Control: private` hoặc `no-store` và không được cache ở CDN/proxy/cache ứng dụng theo key không chứa định danh người dùng. → Kiểm: test E2E đăng nhập 2 user, gọi cùng URL → không nhận dữ liệu của nhau; header kiểm bằng test. · Nguồn: RFC 9111 §5.2.2.5, §5.2.2.7; catalog 09 §1.4
- [ ] `BE-CACHE-002` **MUST** Mọi entry cache ứng dụng có TTL hữu hạn; không `SET` không có `EX`/`PX` ngoài allowlist có lý do. → Kiểm: grep/lint wrapper cache bắt buộc tham số TTL; `redis-cli --scan` + `TTL` ngẫu nhiên không trả `-1` ngoài allowlist. · Nguồn: P7
- [ ] `BE-CACHE-003` **MUST@L** Key có quy ước đặt tên tập trung (`{app}:{entity}:{version}:{id}` hoặc tương đương), có tiền tố phiên bản để đổi hình dạng dữ liệu không phải xoá cache. → Kiểm: hàm sinh key duy nhất trong code; test đổi version → key khác. · Nguồn: P5
- [ ] `BE-CACHE-004` **MUST@L** Chống stampede cho key nóng: single-flight trong process (singleflight/`p-memoize`/`async.memoize`) và/hoặc khoá ngắn ở Redis khi tính lại; cho phép serve-stale trong lúc tính lại. → Kiểm: test 100 request đồng thời cùng key miss → nguồn gốc được gọi 1 lần. · Nguồn: RFC 5861 (stale-while-revalidate), golang.org/x/sync/singleflight
- [ ] `BE-CACHE-005` **MUST** Cache hỏng/không kết nối được → ứng dụng fallback về nguồn (có giới hạn/circuit breaker), không 500; timeout gọi cache ngắn (vd ≤ 50–100 ms). → Kiểm: test tắt Redis → endpoint vẫn 200; timeout cấu hình rõ. · Nguồn: [`reliability-and-errors.md`](reliability-and-errors.md)
- [ ] `BE-CACHE-006` **MUST@L** Tài nguyên tĩnh có hash nội dung trong tên file và `Cache-Control: public, max-age=31536000, immutable`; HTML/entry point không cache dài. → Kiểm: test header của asset build; `index.html` có `no-cache`/`max-age` ngắn. · Nguồn: RFC 9111 §5.2.2
- [ ] `BE-CACHE-007` **MUST** Chiến lược vô hiệu hoá được ghi cho từng loại cache (TTL / sự kiện / phiên bản) và có test: cập nhật dữ liệu → đọc sau đó không nhận bản cũ quá ngưỡng cho phép. → Kiểm: test cập nhật rồi đọc trong cùng test; tài liệu trong spec/ADR. · Nguồn: P5
- [ ] `BE-CACHE-008` **MUST@L** `Vary` khai báo đúng header ảnh hưởng phản hồi (`Accept-Encoding`, `Accept-Language`, `Authorization`); không `Vary: *`; không `Vary` theo `Cookie`/`User-Agent` tràn lan. → Kiểm: test header; review số biến thể. · Nguồn: RFC 9111 §4.1, MDN Vary
- [ ] `BE-CACHE-009` **MUST@L** Metric cache: hit ratio, latency, số key, bộ nhớ, eviction; cảnh báo khi hit ratio tụt đột ngột hoặc eviction tăng (dấu hiệu stampede/thiếu RAM). → Kiểm: dashboard có metric; rule cảnh báo. · Nguồn: P10
- [ ] `BE-CACHE-010` **MUST@L** Redis/Memcached dùng chung có `maxmemory` + policy eviction rõ (`allkeys-lru` cho cache thuần; `noeviction` cho dữ liệu không được mất) và tách instance cache khỏi instance hàng đợi/phiên. → Kiểm: `CONFIG GET maxmemory-policy`; hai instance/DB index riêng. · Nguồn: Redis docs
- [ ] `BE-CACHE-011` **MUST@L** Không cache phản hồi lỗi 5xx; 404 cache ngắn có chủ đích; cache negative (không tồn tại) có TTL ngắn hơn cache positive. → Kiểm: test 500 → không có entry; 404 TTL ≤ cấu hình. · Nguồn: RFC 9111 §3
- [ ] `BE-CACHE-012` **SHOULD** Dùng `ETag`/`Last-Modified` + `If-None-Match` → 304 cho API đọc nhiều; ETag tính từ nội dung hoặc `updated_at` + version. → Kiểm: test gọi lần hai với ETag → 304 không body. · Nguồn: RFC 9110 §13
- [ ] `BE-CACHE-013` **SHOULD** `stale-while-revalidate` / `stale-if-error` cho nội dung công khai chấp nhận cũ vài phút để giảm tail latency và chịu lỗi nguồn. → Kiểm: header có directive; test nguồn trả 503 → CDN vẫn 200 bản cũ. · Nguồn: RFC 5861
- [ ] `BE-CACHE-014` **SHOULD** TTL có jitter (±10–20%) để các key nạp cùng lúc không hết hạn cùng lúc. → Kiểm: hàm tính TTL có jitter, có unit test.
- [ ] `BE-CACHE-015` **SHOULD** In-memory cache có giới hạn kích thước (LRU/LFU) và không giữ tham chiếu tới object lớn; dọn khi deploy. → Kiểm: cấu hình `max` entries; test bộ nhớ không tăng vô hạn.
- [ ] `BE-CACHE-016` **SHOULD** Prewarm cache cho key nóng khi deploy/khởi động hoặc dùng rolling deploy để tránh "cold start storm". → Kiểm: script warm-up hoặc tài liệu chiến lược deploy ([`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)).
- [ ] `BE-CACHE-017` **SHOULD** Không lưu bí mật/PII thô trong cache; nếu buộc phải, mã hoá và TTL ngắn, tuân [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md). → Kiểm: review key/value mẫu; quét dump cache test không chứa PII.
- [ ] `BE-CACHE-018` **MAY** Cache theo tầng (in-memory L1 + Redis L2) với TTL L1 ngắn hơn L2; đồng bộ vô hiệu hoá bằng pub/sub. → Kiểm: test vô hiệu hoá L2 → L1 ở instance khác hết hạn ≤ TTL L1.
- [ ] `BE-CACHE-019` **MAY** Cache kết quả LLM/embedding theo hash prompt + model + tham số; không cache khi prompt chứa dữ liệu nhạy cảm theo người dùng. → Kiểm: key có `model`+`hash(prompt)`; xem [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md).
- [ ] `BE-CACHE-020` **MAY** Test tải cho tỉ lệ hit/miss mục tiêu trước khi ra mắt. → Kiểm: báo cáo trong [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md).

## Bẫy thường gặp

- **Cache theo URL mà quên người dùng.** `/api/me` cache ở CDN → người này thấy hồ sơ người kia. Route theo user không được cache tĩnh (catalog 09 §1.4); `private`/`no-store` + key có `user_id`.
- **Cache vĩnh viễn "vì sẽ xoá khi cập nhật".** Một đường cập nhật bị quên → dữ liệu cũ mãi. TTL luôn có.
- **Thundering herd khi key nóng hết hạn.** 1.000 request cùng miss → 1.000 truy vấn DB. Single-flight + serve-stale + jitter TTL.
- **Xoá cache bằng `KEYS *pattern*`.** Chặn Redis production. Dùng key có phiên bản, hoặc `SCAN` theo lô, hoặc tag set.
- **Dùng Redis cache làm nơi lưu phiên/giỏ hàng không persistence.** Eviction/restart = người dùng mất giỏ. Tách store có persistence.
- **`Vary: Cookie`/`User-Agent`.** Hit ratio ~0, cache vô dụng mà vẫn tốn RAM.
- **Cache phản hồi lỗi.** Nguồn hỏng 1 giây, cache 500 trong 10 phút. Không cache 5xx.
- **Cache che lỗi N+1.** Hit ratio cao ở test, prod miss → DB sập. Sửa truy vấn trước ([`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md)), cache sau.
- **Serialize object ngôn ngữ (pickle/Java serialization) vào cache.** Đổi class → lỗi deserialize, và là vector RCE. Dùng JSON/protobuf + version.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Test cách ly người dùng | E2E/integration: 2 user gọi cùng endpoint → body khác nhau, header `Cache-Control` đúng | CI `quality` | 0 fail; mọi endpoint có dữ liệu user nằm trong danh sách test |
| Lint TTL | wrapper cache bắt buộc TTL; ESLint/ruff rule cấm gọi client Redis `set` trực tiếp ngoài wrapper | pre-commit + CI | 0 vi phạm |
| Header check | test tích hợp assert `Cache-Control`/`Vary`/`ETag` cho nhóm route (static, public, private) | CI | 100% nhóm route |
| Stampede test | test 100 request đồng thời cùng key → đếm gọi nguồn | CI | = 1 |
| Redis config | script đọc `CONFIG GET maxmemory maxmemory-policy appendonly` so với mong đợi theo vai (cache/queue/session) | CI deploy / IaC test | Khớp |
| Thư viện (xác minh 2026-10-13) | golang.org/x/sync v0.24.0 (singleflight) · Redis 8.10.2 | code | Xác minh lại trước khi dùng |

## Nguồn

- RFC 9111 HTTP Caching (STD 98; `max-age`, `s-maxage`, `no-store`, `private`, `must-revalidate`, `Vary`): <https://www.rfc-editor.org/rfc/rfc9111> — xác minh 2026-10-13
- RFC 5861 HTTP Cache-Control Extensions for Stale Content (`stale-while-revalidate`, `stale-if-error`): <https://www.rfc-editor.org/rfc/rfc5861> — xác minh 2026-10-13
- RFC 9110 §13 Conditional Requests (`ETag`, `If-None-Match`, `If-Match`/412): <https://www.rfc-editor.org/rfc/rfc9110> — xác minh 2026-10-13
- MDN `Vary` (`Vary: *` = không cache được): <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary> — xác minh 2026-10-13
- golang.org/x/sync/singleflight (v0.24.0): <https://pkg.go.dev/golang.org/x/sync/singleflight> — xác minh 2026-10-13
- Redis — Distributed Locks (khoá khi tính lại, fencing token): <https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/> — xác minh 2026-10-13; Redis 8.10.2 theo <https://endoflife.date/redis> — xác minh 2026-10-13
- (chưa xác minh) tài liệu Redis `maxmemory-policy` — không fetch ngày 2026-10-13; tên policy lấy theo kiến thức phổ biến, xác minh lại trước khi cấu hình.
- `research/2026-10-13-stored-catalog-extraction.md` §2.5 (route theo user không cache tĩnh); catalog `09-engineering-checklists` §1.4.
