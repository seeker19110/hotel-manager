---
title: Kiểm thử & chất lượng
kind: index
updated: 2026-10-13
---

# 14 — Kiểm thử & chất lượng

> Mảng này biến "đã test" thành **bằng chứng máy**: chiến lược theo hồ sơ, test từng tầng (unit/ca biên → integration/
> contract → E2E + a11y → tải/hiệu năng), phân tích tĩnh và tối ưu mã nguồn, dữ liệu test an toàn, và coverage/mutation
> làm cổng. Mọi công cụ ghi phiên bản xác minh 2026-10-13 từ registry (npm/PyPI/GitHub); xác minh lại khi ghim. Đọc
> `test-strategy.md` trước để chọn tầng, rồi mở module của tầng đó; các luật nghiệp vụ (tiền/thời gian, API, a11y,
> quyền riêng tư) sống ở mảng khác — ở đây chỉ có **cách test** chúng.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`test-strategy.md`](test-strategy.md) | Bảng tầng test theo 12 hồ sơ, luật tất định/cách ly/flaky, nhãn bằng chứng, cổng required | G1–G2 khi viết mục "Kiểm thử" của `PROJECT.md`; G5 dựng CI; khi suite chậm/flaky |
| [`unit-and-logic-edge-cases.md`](unit-and-logic-edge-cases.md) | Bảng ca biên bắt buộc có test (rỗng/1/nhiều, null vs 0, off-by-one, tiền, chia 0, UTC/DST, race, idempotency, stale, all-or-nothing), property-based | G6 khi viết/review mọi logic nghiệp vụ; khi sửa bug logic |
| [`integration-and-contract.md`](integration-and-contract.md) | DB thật bằng testcontainers, migration từ rỗng, test theo OpenAPI/operationId, authz BOLA/BFLA qua HTTP, Pact/oasdiff, webhook/queue, record/replay | G5–G6 cho backend/API; khi thêm dịch vụ ngoài; trước khi đổi hợp đồng |
| [`e2e-and-accessibility.md`](e2e-and-accessibility.md) | Playwright desktop+mobile, axe `wcag22aa` trong mọi smoke, `forbidOnly/retries/trace`, flaky có hạn, mobile native | G6 khi có UI; G7 trước phát hành; khi E2E flaky |
| [`performance-and-load.md`](performance-and-load.md) | Ngân sách theo hồ sơ (p95/CWV/thời gian chạy/kích thước), k6/Locust thresholds, Lighthouse CI (đứng yên 06/2025), RUM p75, benchmark ratchet | G2 đặt ngân sách; G7 báo cáo; nightly/soak/spike |
| [`static-analysis-and-code-quality.md`](static-analysis-and-code-quality.md) | Lint/format/type strict, knip/jscpd/dependency-cruiser/import-linter, độ phức tạp, **tối ưu mã nguồn không đổi hành vi**, baseline ratchet cho dự án có sẵn | G5 dựng cổng; trước khi đóng một mảng; khi áp khung lên repo có sẵn |
| [`test-data-and-fixtures.md`](test-data-and-fixtures.md) | Factory/seed tất định, cấm dump production, quét PII trong fixture, cassette lọc secret, dữ liệu tiếng Việt/Unicode, golden dataset eval | G5 khi dựng seed; khi cần dữ liệu "giống thật"; khi ghi cassette |
| [`coverage-and-mutation.md`](coverage-and-mutation.md) | Branch coverage ratchet (chỉ tăng), loại trừ có lý do, mutation ≥ 70% vùng logic (Stryker/mutmut/PIT), test có assert, agent không xoá test | G5 đặt baseline; mỗi PR chạm vùng critical; nightly |
