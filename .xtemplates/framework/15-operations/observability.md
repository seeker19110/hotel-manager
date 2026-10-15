---
title: Quan sát: log · metric · trace, OpenTelemetry, dashboard
kind: module
prefix: OPS-OBS
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Quan sát: log · metric · trace, OpenTelemetry, dashboard

> **Nền tảng** quan sát: thu thập log/metric/trace theo OpenTelemetry, correlation id xuyên suốt, metric RED/USE, dashboard tối thiểu,
> lưu trữ và chi phí. Cách ghi log trong ứng dụng là nhà của [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md);
> sự kiện bảo mật ở [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md); SLO và cảnh báo ở
> [`slo-and-alerting.md`](slo-and-alerting.md); trace/chi phí riêng cho LLM ở [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md).

## Nguyên tắc

- **Không đo được thì không vận hành được** (P10): trước khi lên production có ít nhất log có cấu trúc + metric RED + trace cho luồng chính + 1 dashboard.
- **Chuẩn mở, vendor-neutral**: instrument bằng OpenTelemetry (API/SDK + semantic conventions), xuất OTLP qua Collector; đổi backend không đổi code.
- **Một id nối ba tín hiệu**: `trace_id` (W3C Trace Context) xuất hiện trong log, trace và exemplar của metric; request id trả về client trong header để người dùng báo lỗi.
- **Metric theo RED cho dịch vụ** (Rate, Errors, Duration) và **USE cho tài nguyên** (Utilization, Saturation, Errors); dùng tên/attribute theo semconv (`http.server.request.duration`) thay vì tự đặt.
- **Cardinality là chi phí**: không đưa user id/email/URL đầy đủ vào label metric; dùng `http.route` không `url.path`.
- **Dữ liệu quan sát cũng là dữ liệu**: che PII/secret ở nguồn, retention có lý do, quyền truy cập theo vai (xem 12).

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Instrument | OpenTelemetry SDK + auto-instrumentation (Node `@opentelemetry/sdk-node` 0.223.0 / `@opentelemetry/api` 1.9.1; Python `opentelemetry-sdk` 1.45.1; Go/Java/.NET SDK chính thức) | SDK vendor chỉ khi đã mua và chấp nhận lock-in; vẫn xuất OTLP |
| Thu thập | **OTel Collector** (contrib) làm agent/gateway: nhận OTLP, xử lý (redact, sample, batch), xuất backend | Agent của vendor khi nền tảng quản lý hết (Vercel/Cloud Run…) và không cần xử lý |
| Backend tự host (S/M) | Prometheus (metric, Apache-2.0) + Loki (log, **AGPL-3.0**) + Tempo (trace, AGPL-3.0) + Grafana (**AGPL-3.0**); hoặc SigNoz/OpenObserve một khối | Managed (Grafana Cloud, Datadog, Honeycomb, cloud-native) khi không có người vận hành; AGPL ổn khi chỉ *dùng*, review nếu phân phối/sửa |
| Lỗi ứng dụng | Sentry (self-host hoặc SaaS; có che PII) hoặc trace-based error tracking | Chỉ log khi S; ≥ M cần grouping + alert theo lỗi mới |
| Sampling trace | Head sampling 100% ở S; ≥ M: tail sampling giữ 100% lỗi/chậm + x% bình thường | Không sample ở hệ thanh toán/pháp lý (lưu đủ, retention ngắn) |
| Log retention | Vận hành 14–30 ngày hot; bảo mật/audit theo [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md) | Dài hơn chỉ với lý do; archive lạnh (object storage) rẻ hơn kho hot |
| LLM/agent | OTel GenAI semconv (`invoke_agent`, `execute_tool`, `gen_ai.usage.*`), content capture off | Langfuse/Phoenix/OpenLLMetry xuất OTel — chi tiết ở 13 |

## Checklist

- [ ] `OPS-OBS-001` **MUST** Pipeline log (agent/Collector) nhận log JSON của ứng dụng (định dạng theo `BASE-ERR-005/006` ở [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)), parse thành OTel Logs Data Model và gắn `Resource` (`service.name`, `service.version`, `deployment.environment`) ở Collector — không drop dòng không parse được (gắn nhãn `unparsed`). → Kiểm: cấu hình Collector `filelog`/`otlp` receiver + `resource` processor; test gửi dòng rác → vẫn lưu với nhãn; query theo `service.name` trả đúng. · Nguồn: OTel Logs Data Model (Stable); OTel resource semconv
- [ ] `OPS-OBS-002` **MUST@L** Correlation: mỗi request/job/run có `trace_id` theo W3C Trace Context lan truyền qua HTTP header, queue message, cron job, tool call của agent; id trả về client (`X-Request-Id`/`traceparent`). → Kiểm: test end-to-end: gọi API → log, trace, và response header cùng `trace_id`; message queue có `traceparent` trong header. · Nguồn: W3C Trace Context Level 1; MCP 2026-07-28 (`traceparent` trong `_meta`)
- [ ] `OPS-OBS-003` **MUST** Metric RED cho mọi dịch vụ HTTP/RPC: `http.server.request.duration` (histogram, s) với `http.request.method`, `http.route`, `http.response.status_code`; không label cardinality cao (user id, path đầy đủ). → Kiểm: `/metrics` hoặc OTLP có histogram tên chuẩn; script kiểm số series/label < ngưỡng (vd 10k). · Nguồn: OTel HTTP semconv (`http.server.request.duration` Stable)
- [ ] `OPS-OBS-004` **MUST@L** Metric USE cho tài nguyên: CPU/RAM/disk/FD của tiến trình và host; kích thước queue, connection pool, cache hit. → Kiểm: dashboard có panel USE; alert saturation (xem SLO). · Nguồn: Brendan Gregg USE method (chưa xác minh URL 2026-10-13); OTel system/runtime semconv
- [ ] `OPS-OBS-005` **MUST@L** Trace cho luồng chính (request → DB → gọi ngoài → queue) với span theo semconv (`db.*`, `http.client.*`, `messaging.*`); lỗi gắn `error.type` + status span. → Kiểm: trace mẫu trong backend có ≥ 3 tầng span; test span DB có `db.system`. · Nguồn: OTel trace semconv
- [ ] `OPS-OBS-006` **MUST** Health endpoints: `/healthz` (liveness, không gọi phụ thuộc) và `/readyz` (readiness, kiểm phụ thuộc chính có timeout); không lộ chi tiết nội bộ ra public. → Kiểm: test hai endpoint; readiness trả 503 khi DB down; endpoint sau auth hoặc chỉ nội bộ. · Nguồn: Kubernetes probes docs (chưa fetch lại 2026-10-13)
- [ ] `OPS-OBS-007` **MUST@L** Dashboard tối thiểu mỗi dịch vụ: RED (rate/error/p50-p95-p99), USE, phiên bản đang chạy, deploy marker; lưu dưới dạng code (JSON/Jsonnet/Terraform) trong repo. → Kiểm: file dashboard commit; CI validate JSON; ảnh dashboard trong GO/NO-GO. · Nguồn: P10; P5
- [ ] `OPS-OBS-008` **MUST** PII/secret được che ở SDK/Collector trước khi rời tiến trình (processor redact/attributes); nội dung prompt/completion không ghi mặc định. → Kiểm: cấu hình Collector `redaction`/`attributes` processor; test span chứa email → che. · Nguồn: [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md); OTel GenAI (content opt-in)
- [ ] `OPS-OBS-009` **MUST@L** Theo dõi lỗi có grouping + thông báo lỗi mới (Sentry hoặc tương đương) với source map/symbol, release tag, che PII. → Kiểm: lỗi thử nghiệm xuất hiện với stack đúng dòng; `send_default_pii=false`. · Nguồn: Sentry docs (chưa xác minh phiên bản)
- [ ] `OPS-OBS-010` **MUST@L** Retention và chi phí quan sát có ngân sách: log hot ≤ 30 ngày (trừ bảo mật/audit), sampling trace tail-based, giới hạn cardinality; chi phí observability theo dõi như một dòng ngân sách. → Kiểm: cấu hình retention trong IaC; dashboard chi phí/ingest GB/ngày; alert ingest tăng > 50% tuần. · Nguồn: [`cost-management.md`](cost-management.md)
- [ ] `OPS-OBS-011` **MUST@L** Synthetic/uptime check từ ngoài cho luồng chính (trang chủ, login, API health) mỗi ≤ 5 phút từ ≥ 2 vị trí; là nguồn SLI availability bên ngoài. → Kiểm: cấu hình checker (Blackbox exporter/Uptime Kuma/dịch vụ); alert khi 2 lần liên tiếp fail. · Nguồn: Google SRE Workbook (SLI từ góc nhìn người dùng)
- [ ] `OPS-OBS-012` **MUST@L** Frontend web/mobile: lỗi JS/crash client gửi về hệ quan sát với sampling, gắn `release`/phiên bản app, không PII; dữ liệu RUM đưa vào cùng backend quan sát để nối với trace server. Thu RUM Core Web Vitals web: xem [`FE-PERF-003`](../07-frontend/performance-web-vitals.md) (nhà, kèm ngưỡng). → Kiểm: cấu hình OTel browser/mobile SDK hoặc Sentry có `sampleRate` + scrub PII; lỗi thử trên staging xuất hiện trong backend; dashboard có panel lỗi client theo phiên bản. · Nguồn: OTel client SDK; [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)
- [ ] `OPS-OBS-013` **MUST@L** OTel Collector chạy HA (≥ 2 replica), có queue/retry, giới hạn bộ nhớ (`memory_limiter`), và metric của chính Collector được giám sát (drop, queue). → Kiểm: deployment ≥ 2; processor `memory_limiter` + `batch`; alert `otelcol_exporter_send_failed_*`. · Nguồn: OTel Collector docs (chưa fetch lại 2026-10-13)
- [ ] `OPS-OBS-014` **SHOULD** Deploy marker/annotation (phiên bản, commit, người/CI) được ghi vào hệ quan sát để nối thay đổi ↔ sự cố. → Kiểm: mỗi deploy tạo annotation/event; dashboard hiện vạch deploy. · Nguồn: DORA (change lead time/CFR); [`deployment-strategies.md`](deployment-strategies.md)
- [ ] `OPS-OBS-015` **SHOULD** Business metric tối thiểu (đăng ký, đơn hàng, thanh toán thành công, job hoàn tất) đo cạnh metric kỹ thuật để phát hiện "hệ thống xanh nhưng nghiệp vụ đỏ". → Kiểm: ≥ 3 business counter; alert "0 đơn trong X phút giờ cao điểm". · Nguồn: Google SRE Workbook (SLI theo người dùng)
- [ ] `OPS-OBS-016` **SHOULD** Pipeline quan sát không làm hại ứng dụng: exporter có queue + retry, `memory_limiter`, drop có metric; kho log/trace chậm hoặc chết không chặn request (fire-and-forget/async). → Kiểm: test tắt backend → app vẫn phục vụ, metric `otelcol_exporter_queue_size`/`send_failed` tăng và có alert. · Nguồn: OTel Collector docs (chưa fetch lại 2026-10-13); P7
- [ ] `OPS-OBS-017` **SHOULD** Agent/LLM: span `invoke_agent`/`execute_tool`/inference theo OTel GenAI semconv với `gen_ai.usage.input_tokens/output_tokens`, `gen_ai.provider.name`; chi phí tính từ token (chi tiết ở 13). → Kiểm: trace mẫu có các span/attribute trên. · Nguồn: OTel GenAI semconv (Development — tên có thể đổi)
- [ ] `OPS-OBS-018` **SHOULD** Exemplar nối metric → trace cho histogram latency để từ p99 nhảy sang trace chậm. → Kiểm: metric có exemplar `trace_id`; dashboard hỗ trợ. · Nguồn: OpenMetrics/OTel exemplars (chưa xác minh)
- [ ] `OPS-OBS-019` **MAY** Profiling liên tục (pprof/Pyroscope/eBPF) cho dịch vụ nhạy CPU/RAM. → Kiểm: profile mẫu trong backend. · Nguồn: [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md)
- [ ] `OPS-OBS-020` **MAY** Desktop/mobile/CLI offline: telemetry **opt-in** rõ ràng, có lệnh tắt, không gửi nội dung người dùng; crash log lưu local và gửi khi người dùng đồng ý. → Kiểm: màn hình/flag opt-in; mặc định off. · Nguồn: P11; catalog stored 11 §1c (telemetry mặc định)

## Bẫy thường gặp

1. **Label metric có user id/email/URL đầy đủ** → hàng triệu series, kho metric sập, hoá đơn tăng. Tránh: `OPS-OBS-003`; dùng `http.route`.
2. **Log text tự do** `"user 123 failed"` → không query được, không correlation. Tránh: JSON + trường chuẩn (`OPS-OBS-001`).
3. **Trace ngắt ở queue/cron/agent** vì không lan truyền `traceparent` → nửa sau mù. Tránh: `OPS-OBS-002` với message header.
4. **Dashboard click-ops** không trong repo → mất khi đổi nền tảng, không review được. Tránh: dashboard-as-code (`OPS-OBS-007`).
5. **Readiness gọi mọi phụ thuộc không timeout** → một phụ thuộc phụ chậm làm pod bị rút khỏi LB, cascade. Tránh: readiness chỉ phụ thuộc *chính*, có timeout.
6. **Ghi prompt/completion đầy đủ vào trace** → PII/secret sang vendor thứ ba. Tránh: content capture off mặc định (`OPS-OBS-008`).
7. **Hệ thống xanh, nghiệp vụ đỏ** (0 đơn hàng vì nút thanh toán hỏng, nhưng 200 OK). Tránh: business metric + synthetic check luồng chính.
8. **Sample 1% ngay từ đầu** → mất trace của lỗi hiếm. Tránh: tail sampling giữ 100% lỗi/chậm.
9. **Retention mặc định của vendor** (vài ngày) → điều tra sự cố phát hiện muộn không còn log. Tránh: retention có lý do, audit riêng.
10. **Nhầm license Grafana/Loki/Tempo (AGPL-3.0)** khi nhúng vào sản phẩm phân phối cho khách. Chỉ dùng nội bộ thì không ảnh hưởng; ghi vào license review ([`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)).

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Schema log | JSON Schema + test | validate mẫu log mỗi dịch vụ | job test | thiếu trường = đỏ |
| Correlation e2e | test tích hợp | gọi API → so `trace_id` ở log/trace/header | CI (staging) | lệch = đỏ |
| Tên metric chuẩn | script so với semconv | `http.server.request.duration` tồn tại; label cấm (`user_id`, `email`, `url.path`) = 0 | CI | vi phạm = đỏ |
| Cardinality | query backend (`count(count by (__name__)({}))`) | ngưỡng series theo dịch vụ | lịch ngày | vượt = cảnh báo |
| Dashboard-as-code | `jq`/`jsonnet` + API import | validate + import khi merge | CI | JSON lỗi = đỏ |
| Collector | OTel Collector contrib (Apache-2.0) | `otelcol validate --config=…` | CI | lỗi = đỏ |
| Health | test `/healthz`, `/readyz` | DB down → readiness 503 | job test | sai = đỏ |
| Synthetic | Blackbox exporter / Uptime Kuma (MIT) / dịch vụ | ≤ 5 phút, ≥ 2 vị trí | runtime | 2 fail liên tiếp = alert |
| Redact | Collector `redaction` processor + test | span có email → che | job test | lộ = đỏ |
| Chi phí ingest | metric GB/ngày | alert tăng > 50%/tuần | runtime | cảnh báo |

## Nguồn

- OpenTelemetry Specification v1.61.0: <https://github.com/open-telemetry/opentelemetry-specification/releases/latest> — tag xác minh 2026-10-13 (trang không hiện năm); OTel Logs Data Model (Stable): <https://opentelemetry.io/docs/specs/otel/logs/data-model/> — xác minh 2026-10-13; HTTP metrics (`http.server.request.duration` Stable): <https://opentelemetry.io/docs/specs/semconv/http/http-metrics/> — xác minh 2026-10-13; Versioning and stability: <https://opentelemetry.io/docs/specs/otel/versioning-and-stability/> — xác minh 2026-10-13.
- SDK: `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.223.0 (npm), `opentelemetry-sdk` 1.45.1 (PyPI) — xác minh 2026-10-13.
- W3C Trace Context Level 1 (Recommendation 2021-11-23): <https://www.w3.org/TR/trace-context/> — xác minh 2026-10-13.
- OTel GenAI semconv (repo `open-telemetry/semantic-conventions-genai`, Development; content opt-in): theo `research/2026-10-13-ai-agent-research.md` §4.3 [F/S]; MCP 2026-07-28 `traceparent` trong `_meta` [F].
- Google SRE Workbook — Implementing SLOs (SLI theo người dùng): <https://sre.google/workbook/implementing-slos/> — xác minh 2026-10-13.
- Grafana AGPL-3.0: <https://github.com/grafana/grafana/blob/main/LICENSE> — xác minh 2026-10-13 (Loki/Tempo AGPL theo kiến thức nền — chưa fetch lại).
- (chưa xác minh 2026-10-13) Brendan Gregg USE method URL, Kubernetes probes docs, OTel Collector docs, Sentry, Uptime Kuma, OpenMetrics exemplars — xác minh trước khi dẫn.
- Catalog `seeker19110/stored` 13 §3 (Prometheus/Grafana/OTel/Loki), 07 (observability eval), 11 §1c (telemetry) — đọc 2026-10-13.
