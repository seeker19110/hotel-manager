---
title: Hiệu năng & tải: k6/Locust, ngưỡng p95, Lighthouse, ngân sách
kind: module
prefix: QA-PERF
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Hiệu năng & tải: k6/Locust, ngưỡng p95, Lighthouse, ngân sách

> **Cách đo và chặn** hiệu năng bằng test: load test backend (k6/Locust) với ngưỡng p95/lỗi, benchmark cho thư viện/CLI,
> số đo hiệu năng trong GO/NO-GO, và vận hành công cụ Lighthouse CI. Phương pháp (chỉ số, baseline, ngân sách) ở
> [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md); **ngưỡng và cổng hiệu năng web**
> (Lighthouse trên PR, ngân sách bundle, RUM/CWV) là nhà của [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md).

## Nguyên tắc

- **Ngân sách trước, đo sau, cổng cuối.** Ngưỡng (p95, error rate, LCP, kích thước bundle, thời gian chạy) ghi trong `PROJECT.md` trước khi code; test chỉ so với ngưỡng đó.
- **Số đo phải kèm điều kiện đo.** Thiết bị/mạng mô phỏng, số VU, thời lượng, dữ liệu, commit — không có điều kiện thì không so sánh được (P1).
- **Đo nhiều lần, lấy trung vị.** Lighthouse và benchmark dao động; `numberOfRuns ≥ 3`, aggregation `median`.
- **Load test không chạy trên production** trừ khi có kế hoạch và cảnh báo (game day). PR chạy smoke nhẹ; nightly chạy tải thật trên staging.
- **Cổng tương đương theo hồ sơ**: web = CWV; backend = p95 + error rate; CLI/thư viện = thời gian chạy/kích thước; mobile = thời gian khởi động/kích thước app; embedded = RAM/flash/latency vòng lặp.

## Quyết định

| Hồ sơ / mục tiêu | Công cụ mặc định (xác minh 2026-10-13) | Thay thế + điều kiện | Ngưỡng mặc định (đổi theo `PROJECT.md`) |
|---|---|---|---|
| Backend HTTP/gRPC/WebSocket | k6 2.3.0 (AGPL-3.0; script JS, CI tốt) | Locust 2.46.7 (MIT, Python, phân tán dễ); Gatling/Artillery khi đội quen | p95 ≤ 300 ms API nội bộ / ≤ 500 ms công khai; `http_req_failed` < 1% |
| Web (trang) | Lighthouse CI `@lhci/cli` 0.15.1 (Apache-2.0; **repo đứng yên từ 2025-06-26** — vẫn chạy với Lighthouse 13.5.0) | `lighthouse` CLI + script tự assert; Unlighthouse; WebPageTest API | Performance ≥ 0.9; LCP ≤ 2,5 s; INP ≤ 200 ms; CLS ≤ 0,1 (p75 trên dữ liệu thật) |
| Bundle JS | `size-limit`/`bundlesize` (phiên bản **chưa xác minh**) | Next/Vite analyzer thủ công | Ngân sách KB theo route, ghi trong repo |
| Thư viện/CLI | Benchmark trong test: Vitest `bench`, `pytest-benchmark`, Go `testing.B` + `benchstat`, JMH | hyperfine cho CLI | Không chậm hơn > 10% so với baseline |
| Mobile | Thời gian khởi động lạnh, kích thước app, jank (Android Macrobenchmark, Xcode Instruments) | Firebase Performance | Cold start ≤ 2 s; kích thước theo ngân sách |
| Data/ML, LLM app | Latency p95 theo request, token/giây, chi phí/request; eval throughput | k6 với script gọi API model | p95 và chi phí ghi trong `PROJECT.md` |
| Embedded | Latency vòng lặp, RAM/flash tĩnh (`size`), HIL timing | — | theo spec phần cứng |

## Checklist

- [ ] `QA-PERF-001` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-PERF-001`](../18-cross-cutting/performance-engineering.md): `PROJECT.md` ghi chỉ số/ngân sách hiệu năng bằng số kèm điều kiện đo.
- [ ] `QA-PERF-002` **MUST@M** Backend có load test tự động (k6/Locust) với `thresholds` p95 và tỷ lệ lỗi; chạy ít nhất nightly trên staging, fail khi vượt. → Kiểm: script k6 có `thresholds: { http_req_duration: ['p(95)<…'], http_req_failed: ['rate<0.01'] }`; job nightly exit ≠ 0 khi vượt. · Nguồn: k6 docs thresholds
- [ ] `QA-PERF-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`FE-PERF-002`](../07-frontend/performance-web-vitals.md): Lighthouse CI mobile trên PR cho ≥ 3 URL chính, `numberOfRuns ≥ 3`, median, Performance ≥ 0,9 + LCP/CLS/TBT.
- [ ] `QA-PERF-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`FE-PERF-003`](../07-frontend/performance-web-vitals.md): RUM thu CWV người dùng thật, so p75 với ngưỡng `FE-PERF-001`; lab không thay RUM.
- [ ] `QA-PERF-005` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`FE-PERF-004`](../07-frontend/performance-web-vitals.md): ngân sách bundle theo route (`size-limit`) chặn ở PR.
- [ ] `QA-PERF-006` **MUST** Mọi số đo hiệu năng trong báo cáo GO/NO-GO kèm: commit, môi trường, thiết bị/mạng mô phỏng, VU/thời lượng, ngày. → Kiểm: `GO-NO-GO.md` mục hiệu năng có 5 trường; thiếu → NO-GO.
- [ ] `QA-PERF-007` **MUST@M** Load test không chạy vào production trừ game day có lịch và cảnh báo; cấu hình CI cấm target production. → Kiểm: script k6 lấy `BASE_URL` từ env; CI deny giá trị domain production (grep).
- [ ] `QA-PERF-008` **MUST@M** Thư viện/CLI: benchmark trong CI so với baseline đã commit; chậm hơn > 10% → đỏ (ngưỡng đổi được). → Kiểm: `benchstat`/`pytest-benchmark --benchmark-compare-fail=mean:10%`/Vitest `bench` với so sánh; file baseline trong repo.
- [ ] `QA-PERF-009` **MUST@L** Mobile: đo thời gian khởi động lạnh và kích thước app mỗi release, so với ngân sách. → Kiểm: job CI ghi `app-size` và `cold-start` vào artifact; ngưỡng trong `PROJECT.md`.
- [ ] `QA-PERF-010` **SHOULD** Load test có kịch bản theo luồng người dùng thật (không chỉ 1 endpoint), dùng dữ liệu seed đại diện (số hàng ≈ production). → Kiểm: script có ≥ 2 scenario và seed ≥ ngưỡng ghi trong `PROJECT.md`.
- [ ] `QA-PERF-011` **SHOULD** Có test "soak" (≥ 30 phút) hằng tuần để phát hiện rò rỉ bộ nhớ/kết nối. → Kiểm: job weekly `k6 run --duration 30m`; dashboard memory không tăng đơn điệu.
- [ ] `QA-PERF-012` **SHOULD** Có test "spike" (tăng VU đột ngột) xác nhận rate limit/autoscale/degrade có kiểm soát (không 5xx hàng loạt). → Kiểm: scenario `ramping-arrival-rate`; threshold `http_req_failed` giữ < ngưỡng; xem [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md).
- [ ] `QA-PERF-013` **SHOULD** Truy vấn nóng có test kế hoạch thực thi (không full scan) trên dữ liệu seed lớn. → Kiểm: test `EXPLAIN` (xem [`integration-and-contract.md`](integration-and-contract.md) QA-INT-014).
- [ ] `QA-PERF-014` **SHOULD** LLM app: đo p95 latency, token/request, chi phí/request trong eval và load test; ngưỡng ghi trong `PROJECT.md`. → Kiểm: báo cáo eval có 3 cột; xem [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md).
- [ ] `QA-PERF-015` **SHOULD** Lighthouse assertion mới đặt `warn` trước, siết lên `error` sau khi ổn định — không tắt cả cổng. → Kiểm: lịch sử `lighthouserc.json` không có xoá assertion; `warn` có ngày hết hạn trong comment/ticket.
- [ ] `QA-PERF-016` **MAY** Theo dõi phương án thay Lighthouse CI (repo đứng yên) — đánh giá lại mỗi 6 tháng, ghi ADR nếu đổi.
- [ ] `QA-PERF-017` **MAY** Embedded: HIL đo latency vòng lặp và dùng `size` chặn flash/RAM vượt ngân sách.

## Bẫy thường gặp

- **"Lighthouse 95 trên laptop" làm bằng chứng.** Không mô phỏng mobile/4G, một lần chạy. Cách tránh: LHCI mobile preset, `numberOfRuns ≥ 3`, median (FE-PERF-002); RUM p75 (FE-PERF-003).
- **Load test một endpoint GET cache được** → đẹp giả. Cách tránh: scenario theo luồng, có ghi (QA-PERF-010).
- **Ngưỡng p95 không có điều kiện** (bao nhiêu VU? dữ liệu bao nhiêu hàng?). Cách tránh: XC-PERF-001, QA-PERF-006.
- **Load test đánh vào production** gây sự cố thật. Cách tránh: QA-PERF-007 cấm ở CI.
- **Hạ ngưỡng cho xanh** thay vì sửa. Cách tránh: hook hỏi khi sửa `lighthouserc`/`thresholds`; QA-PERF-015 chỉ cho `warn` có hạn.
- **Benchmark trên runner chia sẻ** nhiễu lớn → đỏ/xanh ngẫu nhiên. Cách tránh: so tương đối với baseline chạy cùng runner, ngưỡng 10%, lặp nhiều lần; runner riêng cho benchmark quan trọng.
- **k6 là AGPL-3.0** — chỉ ảnh hưởng khi phân phối k6 sửa đổi; dùng để test không sao, nhưng ghi nhận trong kiểm kê license. Cách tránh: [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md).
- **Lighthouse CI đứng yên từ 06/2025** nhưng vẫn là cổng chặn merge của hai repo chủ kho. Cách tránh: ghim phiên bản, theo dõi thay thế (QA-PERF-016).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| k6 2.3.0 (AGPL-3.0) | `k6 run --env BASE_URL=$STAGING load/main.js` với `thresholds` + `abortOnFail` | CI nightly; smoke 1 phút ở PR | p95, `rate<0.01` theo script |
| Locust 2.46.7 (MIT) | `locust -f locustfile.py --headless -u 100 -r 10 -t 10m --exit-code-on-error 1` | CI nightly | như trên (assert trong script) |
| Lighthouse CI `@lhci/cli` 0.15.1 + Lighthouse 13.5.0 | `lhci autorun` (`collect.numberOfRuns: 3`, `assert.preset: lighthouse:recommended` tuỳ chỉnh) | CI PR | `categories:performance` ≥ 0.9 (`error`); LCP/CLS/TBT theo ngân sách |
| `size-limit` (phiên bản **chưa xác minh**) | `npx size-limit` | CI PR | ≤ ngân sách từng route |
| `pytest-benchmark` / `benchstat` / Vitest `bench` / JMH | `pytest --benchmark-only --benchmark-compare=baseline --benchmark-compare-fail=mean:10%` · `benchstat old.txt new.txt` | CI (thư viện/CLI) | ≤ +10% |
| RUM (web-vitals JS → backend/analytics) | `onLCP/onINP/onCLS` gửi về endpoint | production | p75 trong ngưỡng tốt |

## Nguồn

- Core Web Vitals (LCP ≤ 2,5 s; INP ≤ 200 ms; CLS ≤ 0,1; p75): <https://web.dev/articles/vitals> — xác minh 2026-10-13
- k6 thresholds (`p(95)<…`, `http_req_failed: ['rate<0.01']`, `abortOnFail`): <https://grafana.com/docs/k6/latest/using-k6/thresholds/> — xác minh 2026-10-13; k6 v2.3.0 (2026-09-21): <https://github.com/grafana/k6/releases>
- Lighthouse CI configuration (`numberOfRuns`, `aggregationMethod: median`, `categories:performance`): <https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md> — xác minh 2026-10-13; commit cuối 2025-06-26: <https://github.com/GoogleChrome/lighthouse-ci/commits/main>
- Phiên bản (registry, xác minh 2026-10-13): npm `@lhci/cli` 0.15.1, `lighthouse` 13.5.0; PyPI `locust` 2.46.7 (2026-10-04).
- Catalog `seeker19110/stored` 23 §2.5 (Lighthouse ≥ 0,9 + LCP/CLS/TBT trên 5 URL), 13 §4c (Lighthouse CI đứng yên) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 2 (ngân sách CWV, `numberOfRuns: 3`, `warn` trước `error`), commit `1b80fe4`.
