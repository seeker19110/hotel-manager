---
title: Kỹ thuật hiệu năng chung: đo trước, ngân sách, profiling, regression
kind: module
prefix: XC-PERF
applies_to: [all]
updated: 2026-10-14
---

# Kỹ thuật hiệu năng chung: đo trước, ngân sách, profiling, regression

> **Phương pháp** hiệu năng áp cho mọi loại phần mềm: định nghĩa chỉ số theo hồ sơ, đo baseline, đặt ngân sách trong
> repo, profiling trước khi sửa, cổng chống regression trong CI, đọc tail latency thay vì trung bình. Ngưỡng và công cụ
> **theo loại** là nhà khác: web → [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md);
> test tải/p95 backend → [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md);
> truy vấn/index → [`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md);
> SLO/alert → [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md).

## Nguyên tắc

- **Đo trước, sửa sau, đo lại**: không có số đo thì không có "tối ưu", chỉ có thay đổi.
- **Hiệu năng là yêu cầu có số**: mỗi hồ sơ có chỉ số chính (web: CWV; API: p95/p99 + throughput; CLI: thời gian khởi
  động + kích thước; lib: benchmark hàm; mobile: thời gian mở app, jank; data: thời gian pipeline/chi phí; AI: thời gian
  đến token đầu tiên, token/giây, chi phí/yêu cầu).
- **Tail, không trung bình**: p95/p99 và phân phối; trung bình che giấu 1 % người dùng chờ 5 giây.
- **Ngân sách sống trong repo và CI**: vượt ngân sách = đỏ, như test.
- **Tối ưu đúng chỗ**: profiling chỉ ra điểm nóng; đừng đoán. Tối ưu non là nợ (P3: đúng trước nhanh).
- **Benchmark trung thực**: cùng phần cứng, warm-up, nhiều lần chạy, báo phương sai; benchmark tự công bố không phải bằng chứng.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Chỉ số chính theo hồ sơ | `web-app`/`static-site`: LCP/INP/CLS (field + lab) · `api-service`: p95/p99 latency, RPS, error rate · `cli-tool`: wall time khởi động & lệnh chính, kích thước binary · `library-sdk`: micro-benchmark hàm nóng, kích thước bundle/alloc · `mobile-app`: cold start, frame drop, pin · `data-ml`: thời gian/chi phí pipeline, throughput training · `ai-agent`: TTFT, token/s, chi phí & số vòng/tác vụ · `game`: frame time p99 · `embedded-iot`: RAM/flash, latency ISR. | Không chọn chỉ số proxy (CPU %) làm mục tiêu nếu người dùng không cảm nhận. |
| Phương pháp chẩn đoán | **USE** (Utilization–Saturation–Errors) cho tài nguyên; **RED/bốn tín hiệu vàng** (Latency–Traffic–Errors–Saturation) cho dịch vụ; profiler (`perf`/pprof/py-spy/Chrome DevTools/async-profiler) cho mã. | Đoán từ kinh nghiệm hoặc "cảm giác chậm" không kèm số. |
| Loại ngân sách | Kết hợp **số lượng** (kích thước bundle/binary, số request, alloc) + **mốc thời gian** (LCP, p95) + **điểm theo rule** (Lighthouse). | Chỉ dùng điểm tổng hợp (Lighthouse score) làm cổng — dễ "chơi điểm". |
| Benchmark trong CI | Micro: `pytest-benchmark`, `criterion`, `go test -bench` + `benchstat`, JMH, BenchmarkDotNet; CLI: `hyperfine`; tải: k6. So với baseline lưu trong repo, ngưỡng regression tương đối (vd +10 %). | Runner CI chia sẻ nhiễu → chạy ≥ 5 lần, so trung vị, hoặc dùng runner cố định cho benchmark. |
| Cache | Chỉ sau khi đo; cache có TTL, key có phiên bản, invalidation có test; xem [`../08-backend/caching.md`](../08-backend/caching.md). | Cache để che truy vấn N+1 hoặc thuật toán sai. |

## Checklist

- [ ] `XC-PERF-001` **MUST** Mỗi dự án định nghĩa **chỉ số hiệu năng chính** theo hồ sơ (bảng Quyết định) với mục tiêu số, điều kiện đo (thiết bị/mạng/dữ liệu) và nơi đo (lab/field), ghi trong `PROJECT.md`/SPEC. → Kiểm: `PROJECT.md` có mục "Hiệu năng" với ≥ 1 chỉ số có số + điều kiện; blueprint tick trỏ file. · Nguồn: lifecycle.md G0 (chỉ số đo được); web.dev Performance budgets 101
- [ ] `XC-PERF-002` **MUST@L** Có **baseline đo được** trước khi tối ưu và sau mỗi bản phát hành lớn, lưu trong repo/artefact với ngày, commit, điều kiện đo. → Kiểm: `docs/perf/baseline-<date>.json` (hoặc artefact CI) chứa commit SHA, số đo, môi trường. · Nguồn: P1; khung cũ N2 §9 ("đo trước–sau")
- [ ] `XC-PERF-003` **MUST** **Ngân sách hiệu năng** sống trong repo dưới dạng cấu hình máy đọc (`lighthouserc.json` `budgets`, `size-limit`, `bundlesize`, k6 `thresholds`, `benchstat` delta) và CI đỏ khi vượt — ngưỡng và cổng cụ thể theo loại ở nhà riêng: web [`FE-PERF-002`/`FE-PERF-004`](../07-frontend/performance-web-vitals.md), backend [`QA-PERF-002`](../14-testing-quality/performance-and-load.md), thư viện/CLI `QA-PERF-008`. → Kiểm: file ngân sách tồn tại; job CI thất bại khi cố ý thêm 200 KB/làm chậm 2× (test cổng). · Nguồn: web.dev Performance budgets 101; k6 thresholds
- [ ] `XC-PERF-004` **MUST** Độ trễ báo cáo bằng **phân vị** (p50/p95/p99) và histogram, kèm số mẫu; không dùng trung bình làm mục tiêu hay cổng. → Kiểm: dashboard/báo cáo benchmark có p95/p99; k6 `http_req_duration: ['p(95)<…']`; không có `avg<` làm threshold duy nhất. · Nguồn: Google SRE Book, "Monitoring Distributed Systems" (tail latency)
- [ ] `XC-PERF-005` **MUST@L** Tối ưu chỉ sau **profiling** chỉ ra điểm nóng (flamegraph/trace/EXPLAIN); PR tối ưu đính kèm số đo trước–sau cùng điều kiện và profile. → Kiểm: PR có nhãn `perf` kèm bảng trước/sau + link artefact profile; không có PR "perf" thiếu số. · Nguồn: Brendan Gregg USE Method; P1
- [ ] `XC-PERF-006` **MUST** Mọi thao tác I/O có **timeout và giới hạn** (kích thước, số phần tử, độ sâu, số trang) để một yêu cầu không chiếm tài nguyên vô hạn; phân trang bắt buộc cho danh sách. → Kiểm: API list có `limit` mặc định và tối đa (vd 100/1000); test yêu cầu 10⁶ phần tử bị từ chối hoặc phân trang; chi tiết [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md) BASE-ERR-004. · Nguồn: catalog 23 §4.4 (limit 2000, cap 500)
- [ ] `XC-PERF-007` **MUST@L** Chỉ số hiệu năng **field** (người dùng thật) được thu thập liên tục (RUM/CWV cho web theo [`FE-PERF-003`](../07-frontend/performance-web-vitals.md), OTel metrics p95 cho API, crash/ANR cho mobile) và có cảnh báo khi vượt SLO. → Kiểm: dashboard field tồn tại với dữ liệu 7 ngày; alert rule cho p95/LCP; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: P10; Google SRE (bốn tín hiệu vàng)
- [ ] `XC-PERF-008` **MUST@L** Cổng **chống regression** chạy trong CI cho ít nhất một chỉ số chính mỗi PR (Lighthouse CI/`size-limit` cho web; benchmark + ngưỡng tương đối cho lib/CLI; k6 smoke với threshold cho API); kết quả so với baseline nhánh chính. → Kiểm: job `perf` required; log hiển thị delta so baseline; vượt ngưỡng = đỏ. · Nguồn: web.dev; catalog 23 §2.5 (Lighthouse ≥ 0.9 + LCP/CLS/TBT trên 5 URL)
- [ ] `XC-PERF-009` **SHOULD** Benchmark **tái lập được**: ghi phần cứng/OS/runtime, warm-up, ≥ 5 lần chạy, báo trung vị + độ lệch; so sánh bằng công cụ thống kê (`benchstat`, `hyperfine --export-json`, `pytest-benchmark --compare`); CI dùng runner cố định hoặc chấp nhận ngưỡng rộng hơn. → Kiểm: script benchmark xuất JSON có metadata môi trường; README perf ghi cách chạy. · Nguồn: evidence-and-sources.md luật 11 (benchmark tự công bố chưa phải bằng chứng)
- [ ] `XC-PERF-010` **SHOULD** Dùng **USE** cho tài nguyên (CPU, RAM, disk, mạng, pool kết nối, queue) và **RED** cho dịch vụ khi chẩn đoán; dashboard tối thiểu có bốn tín hiệu vàng cho mỗi dịch vụ. → Kiểm: dashboard có latency, traffic, errors, saturation; runbook có checklist USE. · Nguồn: Brendan Gregg USE; Google SRE Book
- [ ] `XC-PERF-011` **SHOULD** Thuật toán và cấu trúc dữ liệu đúng độ phức tạp cho kích thước thật: không O(n²) trên danh sách người dùng, không N+1 truy vấn, không tải toàn bộ bảng vào bộ nhớ; kích thước dữ liệu thật ghi trong spec. → Kiểm: test với dữ liệu kích thước prod (×10) trong giới hạn thời gian; lint N+1 (vd `nplusone`, log cảnh báo ORM); EXPLAIN cho truy vấn nóng. · Nguồn: [`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md)
- [ ] `XC-PERF-012` **SHOULD** Khởi động và đường nóng được đo riêng: cold start (serverless/CLI/mobile), thời gian build, thời gian test; ngân sách cho từng thứ (vd CLI `--help` < 100 ms, cold start < 1 s). → Kiểm: `hyperfine 'cli --help'` trong CI với `--export-json` so baseline. · Nguồn: clig.dev (responsiveness); hồ sơ `cli-tool`
- [ ] `XC-PERF-013` **SHOULD** Tài nguyên được **giải phóng**: không rò rỉ bộ nhớ/kết nối/file descriptor dưới tải kéo dài; pool có giới hạn; soak test ≥ 30 phút cho dịch vụ dài hạn. → Kiểm: soak test k6/Locust với metric RSS/fd ổn định (không tăng tuyến tính). · Nguồn: [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md)
- [ ] `XC-PERF-014` **SHOULD** Với hệ có LLM: đo TTFT, token/s, token vào/ra và chi phí mỗi tác vụ; ngân sách token/chi phí là cổng (circuit breaker 80/90/100 %). → Kiểm: trace OTel GenAI có `gen_ai.usage.*`; alert chi phí; chi tiết [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md). · Nguồn: catalog 21 §8
- [ ] `XC-PERF-015` **SHOULD** Tối ưu không đổi hành vi (refactor hiệu năng) đi PR riêng, có test bảo vệ và số đo; tối ưu đổi hành vi (bỏ tính năng, giảm độ chính xác) là quyết định sản phẩm có ADR. → Kiểm: PR `perf:` không chứa thay đổi tính năng; ADR khi đổi hành vi. · Nguồn: khung cũ N2 §9; Conventional Commits (`perf`)
- [ ] `XC-PERF-016` **MAY** Fuzz/benchmark hướng kẻ xấu: input tệ nhất (regex catastrophic backtracking, zip bomb, JSON sâu) nằm trong bộ benchmark để hiệu năng không thành lỗ hổng DoS. → Kiểm: test ReDoS (`safe-regex`/`recheck`); giới hạn độ sâu parser. · Nguồn: [`../01-baseline/security-minimum.md`](../01-baseline/security-minimum.md) BASE-SEC-016
- [ ] `XC-PERF-017` **MAY** Continuous profiling trên production (Pyroscope/Parca, OTel profiles) để điểm nóng thật dẫn dắt backlog tối ưu. → Kiểm: profile prod 7 ngày có sẵn khi mở PR perf. · Nguồn: [`../15-operations/observability.md`](../15-operations/observability.md)

## Bẫy thường gặp

- **Tối ưu non**: tuần đầu dự án đã viết cache và pool phức tạp cho đường chưa ai đi. Đo trước; đúng trước nhanh.
- **"Trung bình 100 ms"** nhưng 1 % người dùng chờ 5 s — chính là khách hàng lớn. Phân vị + histogram.
- **Benchmark trên laptop dev, kết luận cho prod.** Khác CPU, khác dữ liệu, khác cold cache. Ghi điều kiện; đo trên môi trường giống prod.
- **Benchmark 1 lần, không warm-up** → JIT/cache chưa nóng, kết quả nhiễu lớn hơn cải thiện. ≥ 5 lần, trung vị.
- **Lighthouse score 95 nhưng LCP field 4 s** vì lab dùng máy mạnh/mạng nhanh. Field là sự thật; lab là cảnh báo sớm.
- **Cache che N+1**: nhanh khi cache nóng, sập khi cache lạnh/invalidate. Sửa truy vấn trước.
- **Ngân sách chỉ trong tài liệu**, không trong CI → bundle tăng 30 % qua 20 PR, không ai thấy. Ngân sách là cổng.
- **Runner CI chia sẻ nhiễu**, benchmark đỏ ngẫu nhiên → đội tắt cổng. Ngưỡng tương đối + nhiều lần + runner cố định.
- **Tối ưu bằng cách bỏ tính năng** âm thầm ("bỏ validate cho nhanh"). Đó là quyết định sản phẩm, cần ADR.
- **Số liệu vendor "nhanh gấp 10"** chưa phải bằng chứng; aggregator từng sai 100 lần (catalog 19). Tự đo trên dữ liệu của mình.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| CLI/binary thời gian | hyperfine v2.0.0 (MIT/Apache-2.0) | `hyperfine --warmup 3 --runs 10 --export-json out.json 'cli …'` | CI (runner cố định) | trung vị ≤ baseline × 1.1 |
| Micro-benchmark | pytest-benchmark 5.3.0 (BSD-2) · `go test -bench` + benchstat (BSD-3) · criterion.rs (MIT/Apache) · JMH (GPL-2.0 + CPE) · BenchmarkDotNet (MIT) | `pytest --benchmark-compare=baseline --benchmark-compare-fail=mean:10%` | CI | regression ≤ 10 % |
| Tải/p95 API | k6 v2.3.0 (AGPL-3.0, chạy như công cụ) · Locust (MIT) | `k6 run --out json smoke.js` với `thresholds` | CI smoke + nightly | `p(95)<…`, `rate<0.01` |
| Web | Lighthouse CI (Apache-2.0; repo đứng yên từ 2025-06 — theo dõi) · size-limit (MIT) | `lhci autorun` · `size-limit` | CI PR | theo [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md) |
| Profiling | py-spy (MIT) · pprof (Apache-2.0) · perf · async-profiler (Apache-2.0) · Chrome DevTools | `py-spy record -o profile.svg -- python app.py` | khi mở PR perf | artefact profile đính kèm |
| Field | OpenTelemetry (Apache-2.0) metrics/histogram · web-vitals (Apache-2.0) | — | prod | alert p95/LCP theo SLO |
| ReDoS | `recheck`/`safe-regex` (MIT) | `lint` | CI | 0 regex nguy hiểm |

## Nguồn

- Google SRE Book — Monitoring Distributed Systems (bốn tín hiệu vàng; tail latency): <https://sre.google/sre-book/monitoring-distributed-systems/> — xác minh 2026-10-13
- Brendan Gregg — The USE Method: <https://www.brendangregg.com/usemethod.html> — xác minh 2026-10-13
- web.dev — Performance budgets 101 (loại ngân sách; mặc định TTI < 5 s, 170 KB critical-path 3G; cập nhật 2018-11-05): <https://web.dev/articles/performance-budgets-101> — xác minh 2026-10-13
- Grafana k6 — Thresholds (`p(95)<500`, exit code ≠ 0 khi fail, `abortOnFail`): <https://grafana.com/docs/k6/latest/using-k6/thresholds/> — xác minh 2026-10-13; k6 v2.3.0: <https://github.com/grafana/k6/releases/latest> — xác minh 2026-10-13
- hyperfine v2.0.0: <https://github.com/sharkdp/hyperfine/releases/latest> — xác minh 2026-10-13; pytest-benchmark 5.3.0 (PyPI) — xác minh 2026-10-13
- Command Line Interface Guidelines (responsiveness, output): <https://clig.dev/> — xác minh 2026-10-13
- Conventional Commits 1.0.0 (`perf` type): <https://www.conventionalcommits.org/en/v1.0.0/> — xác minh 2026-10-13
- Lighthouse CI đứng yên từ 2025-06-26 theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md) (catalog 13 §4c) — đọc 2026-10-13
- Khung cũ X-stored `quality-supplements.md` N2 §2 (ngân sách), §9 (đo trước–sau, tối ưu non), commit `1b80fe4`; catalog `seeker19110/stored` 19 (aggregator sai số ~100 lần), 21 §8 (circuit breaker 80/90/100 %), 23 §2.5/§4.4, đọc 2026-10-13.
