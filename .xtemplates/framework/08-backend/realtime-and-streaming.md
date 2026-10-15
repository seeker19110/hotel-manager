---
title: Realtime: WebSocket, SSE, pub/sub, streaming
kind: module
prefix: BE-RT
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Realtime: WebSocket, SSE, pub/sub, streaming

> Kênh sống lâu (WebSocket, SSE, streaming LLM) đảo ngược giả định của HTTP request/response: kết nối tồn tại
> hàng giờ, server giữ trạng thái, client rớt mạng và quay lại, một client chậm có thể làm đầy bộ nhớ server.
> Module này chuẩn hoá: chọn SSE hay WebSocket, xác thực trên kết nối, backpressure, reconnect có `Last-Event-ID`,
> giới hạn kích thước/tốc độ thông điệp, pub/sub để scale ngang.

## Nguyên tắc

1. **Mặc định SSE; WebSocket khi thật sự hai chiều.** SSE là HTTP thuần: đi qua proxy/CDN/auth hiện có, tự
   reconnect, dễ debug. WebSocket cho chat/game/cộng tác có client gửi liên tục.
2. **Kết nối là một phiên có xác thực và hết hạn.** Xác thực tại handshake *và* kiểm lại khi token hết hạn;
   kiểm `Origin` để chống cross-site WebSocket hijacking.
3. **Backpressure là bắt buộc.** Theo dõi `bufferedAmount`/hàng đợi gửi mỗi kết nối; vượt ngưỡng → bỏ bớt (coalesce)
   hoặc đóng kết nối, không để RAM phình.
4. **Thông điệp là đầu vào không tin cậy (P6):** schema, giới hạn kích thước, giới hạn tốc độ theo kết nối.
5. **Server stateless về kết nối ở mức logic:** trạng thái cần sống qua reconnect/redeploy nằm ở store/pub-sub,
   không trong RAM một instance; client tự khôi phục bằng ID sự kiện cuối.

## Quyết định

| Nhu cầu | Chọn | Khi nào không |
|---|---|---|
| Server đẩy cập nhật một chiều (thông báo, tiến độ, token LLM) | **SSE** (`text/event-stream`, `id:`/`retry:`, `Last-Event-ID`) qua HTTP/2 | Client cần gửi nhiều thông điệp/giây lên server |
| Hai chiều độ trễ thấp (chat, cộng tác, game, terminal) | **WebSocket** (RFC 6455), thư viện có ping/pong + giới hạn frame | Chỉ cần một chiều — SSE rẻ hơn |
| Streaming phản hồi LLM tới trình duyệt | SSE (hoặc fetch streaming body) với sự kiện có `id`; huỷ qua `AbortController` → huỷ gọi model | WebSocket chỉ để stream một chiều |
| Service-to-service streaming | gRPC streaming có deadline | — |
| Nhiều instance server, client ở instance khác nhau | **Pub/sub** (Redis Pub/Sub hoặc Streams, NATS, Kafka) fan-out; instance chỉ giữ map kết nối cục bộ | Sticky session làm "giải pháp" scale (gãy khi deploy) |
| Phải không mất sự kiện khi client rớt mạng | Lưu sự kiện có ID tăng dần (Redis Streams/DB) + replay từ `Last-Event-ID` trong cửa sổ retention | Pub/sub thuần (fire-and-forget) |
| Polling vẫn đủ? | Long-polling/polling 5–30 s khi cập nhật thưa và đơn giản hoá hạ tầng | Hàng nghìn client poll mỗi giây |

Mặc định: SSE + pub/sub + sự kiện có ID. WebSocket chỉ sau khi ghi ADR nêu nhu cầu hai chiều.

## Checklist

- [ ] `BE-RT-001` **MUST** Xác thực tại handshake (cookie phiên hoặc token ngắn hạn qua header/subprotocol — không qua query string lọt log) và phân quyền theo kênh/room theo [`authn-authz.md`](authn-authz.md); kết nối không hợp lệ bị đóng trước khi nhận thông điệp. → Kiểm: test kết nối không token → 401/đóng; test subscribe room của tenant khác → từ chối. · Nguồn: RFC 6455 §10.5, ASVS 5.0 V4
- [ ] `BE-RT-002` **MUST** WebSocket: kiểm `Origin` tại handshake theo allowlist (chống CSWSH); SSE/WebSocket chỉ qua TLS (`wss://`/`https://`). → Kiểm: test handshake với `Origin` lạ → 403; cấu hình không nhận `ws://` ngoài dev. · Nguồn: RFC 6455 §10.2
- [ ] `BE-RT-003` **MUST** Mọi thông điệp vào có schema + giới hạn kích thước (`maxPayload`, vd 64 KB–1 MB theo nhu cầu) + giới hạn tốc độ theo kết nối; vượt → đóng với mã 1008/1009. → Kiểm: test gửi frame vượt `maxPayload` → đóng 1009; test 1000 msg/giây → bị giới hạn. · Nguồn: RFC 6455 §7.4.1, P6
- [ ] `BE-RT-004` **MUST** Backpressure phía gửi: theo dõi `bufferedAmount`/hàng đợi mỗi kết nối; vượt ngưỡng → coalesce/bỏ sự kiện không quan trọng hoặc đóng kết nối chậm; không `send` vô điều kiện. → Kiểm: test client không đọc → server đóng kết nối sau ngưỡng, RSS không tăng tuyến tính. · Nguồn: WHATWG WebSockets (`bufferedAmount`)
- [ ] `BE-RT-005` **MUST@L** Heartbeat: server ping/pong (WebSocket) hoặc comment `: ping` (SSE) theo chu kỳ (vd 20–30 s) ngắn hơn idle timeout của proxy/LB; kết nối không phản hồi N lần → đóng và dọn tài nguyên. → Kiểm: test client im lặng → bị đóng sau N×interval; cấu hình LB idle timeout > interval. · Nguồn: RFC 6455 §5.5.2–5.5.3
- [ ] `BE-RT-006` **MUST@L** SSE: `Content-Type: text/event-stream`, `Cache-Control: no-store`, không nén buffer (tắt buffering ở proxy, `X-Accel-Buffering: no` với nginx), mỗi sự kiện có `id:`; client gửi `Last-Event-ID` khi reconnect và server replay phần thiếu trong cửa sổ retention. → Kiểm: test ngắt kết nối giữa chừng → reconnect nhận đủ sự kiện còn thiếu, không trùng. · Nguồn: WHATWG HTML Server-sent events
- [ ] `BE-RT-007` **MUST@L** Tắt êm: khi SIGTERM, ngừng nhận kết nối mới, gửi thông điệp/close frame (1001 Going Away) để client reconnect sang instance khác, rồi thoát trong grace period. → Kiểm: test deploy rolling → client reconnect thành công, không mất sự kiện (nhờ `Last-Event-ID`). · Nguồn: [`reliability-and-errors.md`](reliability-and-errors.md), RFC 6455 §7.4.1
- [ ] `BE-RT-008` **MUST@L** Client reconnect có backoff mũ + jitter + trần; không reconnect ngay lập tức vô hạn; SSE dùng `retry:` do server đặt. → Kiểm: unit test client backoff; test server tắt → số kết nối thử/giây giảm dần. · Nguồn: AWS Builders' Library (jitter)
- [ ] `BE-RT-009` **MUST@L** Scale ngang qua pub/sub: instance chỉ giữ kết nối cục bộ, sự kiện phát qua broker; không sticky session làm cơ chế đúng đắn; giới hạn số kết nối/instance và cảnh báo. → Kiểm: test 2 instance, client A ở instance 1 nhận sự kiện publish từ instance 2; metric `connections_per_instance`. · Nguồn: P5
- [ ] `BE-RT-010` **MUST@L** Giới hạn số kết nối đồng thời theo người dùng/IP (vd ≤ 5–10/user) và tổng theo instance; vượt → từ chối handshake (429/503). → Kiểm: test mở 20 kết nối cùng user → kết nối thứ N+1 bị từ chối. · Nguồn: RFC 6585 §4
- [ ] `BE-RT-011` **MUST@L** Token hết hạn trong lúc kết nối sống: server kiểm lại định kỳ hoặc client gửi token mới qua thông điệp xác thực lại; thu hồi phiên → đóng kết nối trong ≤ 1 phút. → Kiểm: test revoke phiên → kết nối đóng; test token hết hạn → yêu cầu re-auth. · Nguồn: OWASP Session Management Cheat Sheet
- [ ] `BE-RT-012` **MUST@L** Metric: kết nối đang mở, tốc độ thông điệp vào/ra, kích thước hàng đợi gửi, số đóng theo mã, độ trễ publish→deliver; cảnh báo theo SLO. → Kiểm: dashboard + rule; xem [`../15-operations/observability.md`](../15-operations/observability.md).
- [ ] `BE-RT-013` **MUST@L** Streaming LLM/tác vụ dài: huỷ phía client (`AbortController`/đóng kết nối) lan truyền thành huỷ gọi model/job để không đốt tiền; sự kiện cuối có marker `done` và lỗi có cấu trúc. → Kiểm: test đóng kết nối giữa stream → gọi model bị huỷ (mock đếm); xem [`../13-ai-engineering/llm-app-foundations.md`](../13-ai-engineering/llm-app-foundations.md).
- [ ] `BE-RT-014` **SHOULD** Thông điệp có `type` + `version` + `id`; client bỏ qua type lạ; thay đổi tương thích ngược theo [`api-design.md`](api-design.md). → Kiểm: test client nhận type lạ → không crash.
- [ ] `BE-RT-015` **SHOULD** Nén WebSocket (`permessage-deflate`) chỉ bật có chủ đích với `no_context_takeover`/`max_window_bits` để giới hạn RAM mỗi kết nối. → Kiểm: cấu hình thư viện; đo RSS với 10k kết nối. · Nguồn: RFC 7692 §7.1
- [ ] `BE-RT-016` **SHOULD** SSE qua HTTP/2 (hoặc giới hạn 1 EventSource/tab + SharedWorker) để tránh trần kết nối HTTP/1.1 mỗi origin của trình duyệt. → Kiểm: server/CDN bật HTTP/2; tài liệu client. · Nguồn: WHATWG HTML Server-sent events (ghi chú giới hạn kết nối)
- [ ] `BE-RT-017` **SHOULD** Thứ tự và khử trùng: sự kiện có số thứ tự tăng dần theo kênh; client bỏ qua ID đã thấy; server không bảo đảm đúng-một-lần nên handler idempotent. → Kiểm: test replay trùng ID → không xử lý lại.
- [ ] `BE-RT-018` **SHOULD** Test tải kết nối sống (k6 WebSocket/SSE): N kết nối × tốc độ thông điệp mục tiêu, đo RAM/CPU/latency trước khi ra mắt. → Kiểm: báo cáo trong [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md).
- [ ] `BE-RT-019` **MAY** Dùng dịch vụ realtime quản lý (Ably/Pusher/Supabase Realtime/Socket.IO Cloud) khi đội nhỏ; vẫn áp các mục xác thực/kích thước/backpressure ở lớp ứng dụng. → Kiểm: ADR ghi lý do; adapter theo [`integrations-and-webhooks.md`](integrations-and-webhooks.md).
- [ ] `BE-RT-020` **MAY** Presence (ai đang online) dùng TTL key trong Redis + heartbeat; không dựa vào sự kiện disconnect (có thể không tới). → Kiểm: test kill client → presence hết sau TTL.

## Bẫy thường gặp

- **Token trong query string `?token=`.** Lọt access log/proxy/Referer. Cookie, header handshake, hoặc thông điệp auth đầu tiên có timeout.
- **Không kiểm `Origin`.** Trang độc hại mở WebSocket tới app với cookie người dùng (CSWSH). Allowlist Origin.
- **`send()` không nhìn `bufferedAmount`.** Một client 3G làm server OOM. Backpressure + đóng kết nối chậm.
- **Proxy/LB idle timeout 60 s nhưng không heartbeat.** Kết nối "sống" nhưng đã chết; client không nhận gì. Ping < idle timeout.
- **Buffering ở nginx/CDN cho SSE.** Sự kiện đến theo lô sau 30 giây. Tắt buffering, `Cache-Control: no-store`.
- **Sticky session làm cơ chế đúng đắn.** Deploy/scale-down → mất trạng thái. Pub/sub + sự kiện có ID.
- **Reconnect ngay lập tức không backoff.** Server vừa hồi bị 10k client "đập cửa" cùng lúc. Backoff + jitter.
- **Stream LLM không huỷ khi client rời.** Tiếp tục trả tiền token cho người đã đóng tab. Lan truyền huỷ.
- **Trạng thái presence dựa vào disconnect event.** Rớt mạng không gửi close frame → "online" mãi. TTL + heartbeat.
- **gorilla/websocket chưa có bản mới từ 2024** (v1.5.3, 14/06/2024, xác minh 2026-10-13): vẫn dùng được nhưng chọn coder/websocket (v1.8.15) cho dự án Go mới; ghi ADR.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Test handshake | test: không auth → đóng; Origin lạ → 403; room tenant khác → từ chối | CI `quality` | 0 fail |
| Test giới hạn | frame > `maxPayload` → 1009; msg/giây vượt → đóng; 20 kết nối/user → từ chối | CI | Pass |
| Test backpressure | client không đọc → kết nối đóng, RSS ổn định | CI | Pass |
| Test reconnect | ngắt giữa chừng → `Last-Event-ID` replay đủ, không trùng | CI | Pass |
| Load test | k6 `ws`/SSE scenario N kết nối | CI nightly/staging | Theo SLO |
| Thư viện (xác minh 2026-10-13, xác minh lại trước khi dùng) | ws 8.22.0 (MIT) · socket.io 4.8.4 (MIT) · coder/websocket v1.8.15 (ISC) · gorilla/websocket v1.5.3 (BSD-2, cũ) | code | — |

## Nguồn

- RFC 6455 The WebSocket Protocol (masking, ping/pong, close codes, §10.2 Origin): <https://www.rfc-editor.org/rfc/rfc6455> — xác minh 2026-10-13
- RFC 7692 Compression Extensions for WebSocket (`permessage-deflate`, context takeover và RAM): <https://www.rfc-editor.org/rfc/rfc7692> — xác minh 2026-10-13
- WHATWG HTML — Server-sent events (`text/event-stream`, `id`/`retry`, `Last-Event-ID`, 204 dừng reconnect, giới hạn kết nối mỗi server): <https://html.spec.whatwg.org/multipage/server-sent-events.html> — xác minh 2026-10-13
- WHATWG WebSockets Living Standard (15/03/2026; `bufferedAmount`): <https://websockets.spec.whatwg.org/> — xác minh 2026-10-13
- OWASP Session Management Cheat Sheet (hết hạn/thu hồi phiên): <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- AWS Builders' Library — backoff with jitter: <https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter> — xác minh 2026-10-13
- Phiên bản (registry, xác minh 2026-10-13): ws 8.22.0, socket.io 4.8.4, coder/websocket v1.8.15 (15/06/2026), gorilla/websocket v1.5.3 (14/06/2024).
- (chưa xác minh) OWASP WSTG-CLNT-10 Testing WebSockets — URL trả 404 ngày 2026-10-13; nội dung CSWSH lấy theo RFC 6455 §10.2.
- (chưa xác minh) giới hạn 6 kết nối HTTP/1.1 mỗi origin của trình duyệt — spec WHATWG chỉ nói "per-server connection limit", không nêu số.
- `research/2026-10-13-ai-agent-research.md` §2.3 (AG-UI streaming), §7 (UX streaming); catalog `23-own-repos-lessons` §4.4 (mô hình loopback, `Origin`/`Sec-Fetch-Site` → 403).
