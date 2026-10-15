---
title: Bền vững: tài nguyên, chi phí năng lượng, tối ưu mã nguồn không đổi hành vi
kind: module
prefix: XC-GREEN
applies_to: [all]
updated: 2026-10-14
---

# Bền vững: tài nguyên, chi phí năng lượng, tối ưu mã nguồn không đổi hành vi

> Phần mềm dùng ít tài nguyên hơn cho cùng kết quả: đo năng lượng/carbon (SCI), đúng cỡ hạ tầng, giảm dữ liệu truyền
> và lưu, chạy việc nền ở nơi/lúc điện sạch, CI không chạy thừa, và **tối ưu mã nguồn có kỷ luật** (gỡ rác, giảm trùng
> lặp, tỉa phụ thuộc) mà không đổi hành vi. Chi phí tiền là nhà của [`../15-operations/cost-management.md`](../15-operations/cost-management.md);
> hiệu năng người dùng cảm nhận ở [`performance-engineering.md`](performance-engineering.md); công cụ dead code/trùng lặp
> làm cổng ở [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md);
> chi phí token AI ở [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md).

## Nguyên tắc

- **Ít hơn là tốt hơn** (P3): byte không gửi, truy vấn không chạy, phụ thuộc không cài, job CI không khởi động — là
  tối ưu sạch nhất.
- **Đo trước khi tuyên bố "xanh"**: SCI = ((E × I) + M) / R; không bù trừ (offset) vào điểm.
- **Phần lớn năng lượng web nằm ở thiết bị người dùng** (SWDM v4: 54 % thiết bị, 24 % mạng, 22 % trung tâm dữ liệu) →
  giảm JS/ảnh/video có tác động lớn hơn đổi nhà cung cấp hosting.
- **Tối ưu mã nguồn không đổi hành vi**: có test bảo vệ, bước nhỏ, đo trước–sau, PR `refactor:` riêng.
- **Bền vững và chi phí thường cùng chiều**: đúng cỡ, scale-to-zero, retention — tiết kiệm cả tiền lẫn điện.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Đo gì, bằng gì? | Web: trọng lượng trang/lượt xem + SWDM v4 (gCO2e/GB) · Backend/batch: kWh từ metric hạ tầng (cloud carbon export, Cloud Carbon Footprint — Apache-2.0) · Mã/ML: CodeCarbon 3.3.x (MIT, RAPL/NVML + cường độ carbon theo vùng) · Điểm chuẩn: SCI 1.1.0 (ISO/IEC 21031:2024 theo GSF). | Chỉ số do vendor tự công bố không có phương pháp; offset/REC làm "xanh". |
| Khi nào tối ưu mã nguồn? | Cuối mỗi mảng/tính năng (trước khi coi là xong), khi áp khung lên dự án có sẵn (đo baseline, "đụng đâu dọn đó"), định kỳ ở G8. | Sát ngày phát hành; vùng chưa có test bảo vệ; tối ưu non chỗ chưa đo. |
| Trùng lặp bao nhiêu thì tách? | Lặp ≥ 3 lần **và** cùng ngữ nghĩa → tách dùng chung; chỉ "trông giống" → để yên (trừu tượng hoá sai đắt hơn trùng lặp). | — |
| Hạ tầng | Đúng cỡ theo p95 thật + autoscale; scale-to-zero cho môi trường dev/preview; vùng cloud có cường độ carbon thấp khi không ràng buộc dữ liệu (xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)). | Chạy prod ở vùng xa người dùng chỉ vì "xanh" → latency tệ, vi phạm residency. |
| CI | Cache theo lockfile, bỏ job khi đường dẫn không liên quan (nhưng job gate vẫn báo cáo), cron có jitter và không chạy khi không có thay đổi, huỷ run cũ khi push mới (`concurrency`). | Matrix 12 OS × 5 runtime cho mỗi PR khi sản phẩm chỉ chạy trên một. |

## Checklist

- [ ] `XC-GREEN-001` **MUST** Có **baseline tài nguyên** đo được cho sản phẩm: web — trọng lượng trang (KB) và số request các màn chính; backend — CPU/RAM/kWh (hoặc chi phí) theo 1.000 yêu cầu; batch/ML — thời gian × tài nguyên mỗi lần chạy; ghi kèm ngày và commit. → Kiểm: `docs/perf/baseline-*.json` hoặc dashboard có các số trên; blueprint tick trỏ file. · Nguồn: P1; SCI spec (R = đơn vị chức năng)
- [ ] `XC-GREEN-002` **MUST** Mọi tài nguyên có **ngân sách**: trọng lượng trang/bundle, kích thước image container, thời gian và số job CI mỗi PR, chi phí/kWh mỗi đơn vị chức năng; vượt = đỏ hoặc issue tự mở. → Kiểm: `size-limit`/`lighthouserc` `budgets`; script kiểm kích thước image (`docker image inspect --format '{{.Size}}'`) trong CI; alert chi phí (xem [`../15-operations/cost-management.md`](../15-operations/cost-management.md)). · Nguồn: web.dev Performance budgets; W3C WSG (Web Development)
- [ ] `XC-GREEN-003` **MUST@L** **Dead code** được gỡ: hàm/biến/export/file không dùng, nhánh không bao giờ chạy, feature flag đã chết, `console.log`/debug, code bị comment "để phòng khi"; công cụ chạy trong CI ở chế độ ratchet. → Kiểm: `knip` (JS/TS), `vulture`/`deptry` (Python), `deadcode`/`staticcheck -checks U1000` (Go), `cargo udeps`/`clippy dead_code` = 0 mới so baseline. · Nguồn: khung cũ N2 §9; W3C WSG (remove unused code)
- [ ] `XC-GREEN-004` **MUST@L** **Phụ thuộc thừa** được tỉa: gói không dùng, gói nặng cho một việc nhỏ (cả `lodash` cho `debounce`), hai gói cùng vai; import lẻ thay vì cả thư viện; kích thước bundle/binary đo trước–sau. → Kiểm: `knip`/`depcheck`/`deptry`/`go mod tidy`/`cargo machete` = 0 thừa; `size-limit` hoặc `du` binary không tăng so baseline. · Nguồn: khung cũ N2 §9; [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md) BASE-DEP-010
- [ ] `XC-GREEN-005` **MUST** Refactor/tối ưu mã nguồn **không đổi hành vi**: có test phủ vùng sửa trước (characterization test nếu chưa có), bước nhỏ và xanh liên tục, PR `refactor:`/`perf:` riêng không trộn tính năng, đo số liệu trước–sau (dòng, bundle, complexity, dependency). → Kiểm: PR refactor có bảng trước/sau; test suite xanh không đổi số test (trừ test mới thêm); diff không chạm hành vi public (snapshot/contract test xanh). · Nguồn: khung cũ `quality-supplements.md` N2 §9; P8
- [ ] `XC-GREEN-006` **MUST@L** Dữ liệu truyền tới người dùng được **tối thiểu**: nén (Brotli/gzip), ảnh định dạng hiện đại đúng kích thước (AVIF/WebP, `srcset`), video không autoplay, font subset, JS tách và lazy-load phần ít dùng, cache HTTP đúng (`Cache-Control`, ETag). → Kiểm: Lighthouse "uses-text-compression", "modern-image-formats", "unused-javascript" đạt; trọng lượng trang ≤ ngân sách; chi tiết [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md). · Nguồn: W3C WSG (Web Development); SWDM v4 (54 % năng lượng ở thiết bị)
- [ ] `XC-GREEN-007` **MUST@M** Dữ liệu lưu trữ có **chính sách retention**: log, backup, artefact CI, bản nháp, bảng sự kiện có TTL/lifecycle rule; không lưu vô hạn "phòng khi". → Kiểm: cấu hình lifecycle (S3/GCS/R2 rule, `logrotate`, retention của log backend, `actions/upload-artifact retention-days`) tồn tại; bảng sự kiện có job dọn; khớp với yêu cầu pháp lý ở [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md). · Nguồn: W3C WSG (Hosting/Infrastructure); Green Software Patterns
- [ ] `XC-GREEN-008` **MUST@L** Hạ tầng **đúng cỡ** và **co giãn**: kích thước instance theo p95 sử dụng thật (không > 2× đỉnh), autoscale có sàn/trần, môi trường dev/preview scale-to-zero hoặc tắt ngoài giờ. → Kiểm: metric CPU/RAM trung bình 30 ngày trong khoảng mục tiêu (vd 40–70 %); preview env tự huỷ sau N ngày; hoá đơn dev giảm ngoài giờ. · Nguồn: Green Software Patterns (right-size, scale down); [`../15-operations/cost-management.md`](../15-operations/cost-management.md)
- [ ] `XC-GREEN-009` **SHOULD** CI **không chạy thừa**: cache phụ thuộc/build theo hash lockfile, `concurrency` huỷ run cũ, job theo đường dẫn thay đổi (job gate vẫn luôn báo cáo), cron có jitter và bỏ qua khi không có commit mới, matrix tối thiểu cần. → Kiểm: workflow có `concurrency: { group, cancel-in-progress: true }`, `cache`; tổng phút CI/PR theo dõi và giảm hoặc ổn định. · Nguồn: catalog 23 §2.5 (cron có jitter; concurrency theo SHA)
- [ ] `XC-GREEN-010` **SHOULD** Việc nền không khẩn (báo cáo, huấn luyện, index, backup) chạy **theo lịch có thể dời** và ở vùng/lúc cường độ carbon thấp khi residency cho phép; batch thay vì polling; webhook thay vì poll định kỳ. → Kiểm: job nền có cửa sổ chạy cấu hình được; không có polling < 1 phút cho việc không cần realtime. · Nguồn: Green Software Patterns (time/region shifting); SCI (I theo vùng)
- [ ] `XC-GREEN-011` **SHOULD** Đo **năng lượng/carbon** ít nhất một thành phần có ý nghĩa (pipeline ML bằng CodeCarbon; cloud bằng carbon export/Cloud Carbon Footprint; web bằng SWDM) và tính SCI theo đơn vị chức năng (R = mỗi người dùng/yêu cầu/lần chạy); theo dõi xu hướng theo bản phát hành. → Kiểm: báo cáo SCI có E, I, M, R và nguồn hệ số; biểu đồ theo release. · Nguồn: SCI Specification 1.1.0; SWDM v4; CodeCarbon
- [ ] `XC-GREEN-012` **SHOULD** Độ phức tạp mã có ngưỡng (cyclomatic/cognitive) và trùng lặp có ngưỡng (jscpd); vượt → tách hàm/early return/gom tham số, không vì "đẹp" mà vì sửa rẻ hơn. → Kiểm: `jscpd --threshold 3` (% trùng), ESLint `complexity`/`sonarjs/cognitive-complexity`, ruff `C901`, `gocyclo` trong CI ở chế độ ratchet. · Nguồn: khung cũ N2 §9; [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md)
- [ ] `XC-GREEN-013` **SHOULD** Với LLM/AI: dùng model nhỏ nhất qua được eval, cache prompt/prefix, giới hạn vòng lặp và token, batch yêu cầu offline; chi phí/năng lượng mỗi tác vụ đo và có ngân sách (circuit breaker 80/90/100 %). → Kiểm: bảng chọn model theo eval; `gen_ai.usage.*` trong trace; ngân sách token ở cấu hình vòng lặp (xem [`../11-autonomous-loop/context-and-token-budget.md`](../11-autonomous-loop/context-and-token-budget.md)). · Nguồn: catalog 21 §8, 03 §4 (150k → 2k token); [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md)
- [ ] `XC-GREEN-014` **SHOULD** Image container tối thiểu: multi-stage build, base image slim/distroless, không công cụ build trong runtime, `.dockerignore`; kích thước có ngân sách. → Kiểm: `docker image inspect` ≤ ngân sách (vd ≤ 200 MB cho dịch vụ Node/Python thường); `dive` hoặc script kiểm layer. · Nguồn: Green Software Patterns (containers); [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md)
- [ ] `XC-GREEN-015` **MAY** Hosting dùng điện tái tạo/cường độ thấp được xác minh (Green Web Foundation dataset) và ghi trong tài liệu kiến trúc; không dùng để thay cho giảm tiêu thụ. → Kiểm: `curl https://api.thegreenwebfoundation.org/greencheck/<host>` ghi kết quả + ngày. · Nguồn: SWDM v4 (Green Hosting Factor)
- [ ] `XC-GREEN-016` **MAY** Thiết kế UX bền vững: không autoplay, không infinite scroll mặc định, dark mode thật (OLED), tuỳ chọn "tiết kiệm dữ liệu" (`Save-Data` header/`prefers-reduced-data`). → Kiểm: Lighthouse/axe + kiểm `Save-Data` trong test. · Nguồn: W3C WSG (User Experience Design)
- [ ] `XC-GREEN-017` **MAY** Mục "Bền vững" trong GO/NO-GO và post-mortem: tăng tài nguyên bất thường sau phát hành là tín hiệu regression (rò rỉ, N+1, polling). → Kiểm: mẫu [`../templates/GO-NO-GO.md`](../templates/GO-NO-GO.md) có mục; alert chi phí/CPU tăng > 20 % sau deploy. · Nguồn: P12

## Bẫy thường gặp

- **"Xanh" bằng offset/REC** mà không giảm tiêu thụ. SCI không cho tính offset; đo và giảm E, M.
- **Đổi hosting "xanh" nhưng gửi 5 MB JS** cho mỗi lượt xem — 54 % năng lượng ở thiết bị người dùng. Giảm byte trước.
- **Refactor trộn tính năng trong một PR** → không review được, lỗi hồi quy không biết do đâu. `refactor:` riêng.
- **Trừu tượng hoá sai**: gom hai thứ "trông giống" thành một hàm, sau phải thêm cờ `if (mode === …)` — đắt hơn trùng lặp. Chỉ gom cùng ngữ nghĩa.
- **Tối ưu non** cho chỗ chưa đo; "dọn cả repo một lần" trên dự án có sẵn → PR 10.000 dòng không ai duyệt. Đụng đâu dọn đó, đo baseline.
- **Log/backup/artefact lưu vĩnh viễn** → chi phí và dữ liệu cá nhân tồn tại quá hạn pháp lý. Retention là cấu hình, không là ý định.
- **Preview environment không bao giờ tắt**; cron chạy mỗi 5 phút để "kiểm xem có gì mới". Scale-to-zero; webhook.
- **Matrix CI 60 job cho mỗi PR** khi sản phẩm chạy trên một runtime. Matrix tối thiểu; đầy đủ chỉ ở nightly.
- **Model lớn nhất cho mọi tác vụ** "cho chắc". Model nhỏ nhất qua eval; cache prefix.
- **Dùng số liệu vendor "giảm 70 % năng lượng"** làm bằng chứng. Tự đo trên hệ của mình.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Dead code / dep thừa | knip 6.41.0 (ISC) · vulture (MIT) · deptry (MIT) · `staticcheck` (MIT) · cargo-machete/udeps (MIT/Apache) | `knip --reporter json` | CI (ratchet) | 0 mới so baseline |
| Trùng lặp / phức tạp | jscpd 5.4.1 (MIT) · ESLint `complexity`/`eslint-plugin-sonarjs` (LGPL-3.0) · ruff `C901` · gocyclo (BSD-3) | `jscpd --threshold 3 src` | CI | ≤ 3 % trùng; complexity ≤ ngưỡng repo |
| Trọng lượng web | size-limit (MIT) · Lighthouse CI (Apache-2.0, đứng yên 2025-06 — theo dõi) | `size-limit` · `lhci autorun` | CI PR | ≤ ngân sách |
| Image | script `docker image inspect` · dive (MIT) | `docker image inspect --format '{{.Size}}'` | CI build | ≤ ngân sách |
| CI thừa | actionlint v1.7.12 + script kiểm `concurrency`/`cache` | `check:ci-efficiency` | CI | có `concurrency`, cache |
| Năng lượng/carbon | CodeCarbon 3.3.1 (MIT) · Cloud Carbon Footprint (Apache-2.0) · cloud carbon export · SWDM v4 (co2.js, Apache-2.0) | `codecarbon monitor`/decorator | pipeline ML, cron tháng | báo cáo SCI theo release |
| Retention | script kiểm lifecycle rule/`retention-days` | `check:retention` | CI | mọi bucket/log có rule |
| Đúng cỡ | metric cloud + alert | — | prod | CPU/RAM 30 ngày trong khoảng mục tiêu |

## Nguồn

- Software Carbon Intensity (SCI) Specification 1.1.0 — Green Software Foundation (SCI = ((E×I)+M)/R; không tính offset): <https://sci.greensoftware.foundation/> — xác minh 2026-10-13; SCI thành chuẩn ISO (thông báo 2024-04-25): <https://greensoftware.foundation/articles/sci-specification-achieves-iso-standard-status> — xác minh 2026-10-13; số hiệu ISO/IEC 21031:2024 **(chưa xác minh trực tiếp — iso.org 403 ngày 2026-10-13)**
- W3C Web Sustainability Guidelines (draft của Sustainable Web Interest Group; 4 nhóm: UX, Web Development, Hosting/Infrastructure, Business): <https://w3c.github.io/sustainableweb-wsg/> — xác minh 2026-10-13 (bản `/TR/wsg/` 404)
- Sustainable Web Design Model v4 (0.055/0.059/0.080 kWh/GB vận hành; 494 gCO2e/kWh mặc định; 22/24/54 %): <https://sustainablewebdesign.org/estimating-digital-emissions/> — xác minh 2026-10-13
- Green Software Patterns (GSF): <https://patterns.greensoftware.foundation/> — xác minh 2026-10-13
- Cloud Carbon Footprint (Apache-2.0): <https://github.com/cloud-carbon-footprint/cloud-carbon-footprint> — xác minh 2026-10-13; CodeCarbon 3.3.1 (PyPI) — xác minh 2026-10-13, tài liệu <https://docs.codecarbon.io/> chỉ trả trang chuyển hướng ngày 2026-10-13 **(chi tiết phương pháp chưa xác minh)**
- web.dev Performance budgets 101: <https://web.dev/articles/performance-budgets-101> — xác minh 2026-10-13
- knip 6.41.0, jscpd 5.4.1 (npm, xác minh 2026-10-13); actionlint v1.7.12 — xác minh 2026-10-13
- Khung cũ X-stored `quality-supplements.md` N2 §9 (tối ưu mã nguồn: nguyên tắc vàng, checklist, khi nào không refactor), `CLAUDE.md` §3.7, commit `1b80fe4`; catalog `seeker19110/stored` 03 §4 (code execution với MCP 150k → 2k token), 21 §8 (circuit breaker), 23 §2.5 (cron jitter, concurrency), đọc 2026-10-13.
