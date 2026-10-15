---
title: Vận hành
kind: index
updated: 2026-10-13
---

# 15 — Vận hành

> Tám module cho G5 (dựng nền) và G8 (vận hành): hạ tầng là code, quan sát được, SLO + cảnh báo theo triệu chứng, sự cố có quy trình
> và post-mortem không đổ lỗi, backup đã thử khôi phục, deploy lùi được < 15 phút, chi phí có ngân sách và circuit breaker, bảo trì
> có nhịp. Mọi mục "đã làm" cần bằng chứng diễn tập (alert đã nổ thử, restore đã chạy, rollback đã đo) — không phải cấu hình tồn tại.
> Bảo mật hạ tầng ở `12-security/infrastructure-and-network.md`; migration ở `09-database/migrations.md`; pipeline ở `10-workflow/ci-cd-pipeline.md`.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`infrastructure-as-code.md`](infrastructure-as-code.md) | IaC: OpenTofu/Terraform/Pulumi/compose, plan trong PR, state khoá, drift, policy-as-code | G5 dựng hạ tầng; mỗi PR hạ tầng; khi chọn tool IaC (license BUSL vs MPL) |
| [`observability.md`](observability.md) | Quan sát: OpenTelemetry, log JSON, correlation id, RED/USE, trace, dashboard, retention | G5 trước khi lên production; khi thêm dịch vụ/queue/agent mới |
| [`slo-and-alerting.md`](slo-and-alerting.md) | SLI/SLO, error budget, cảnh báo burn rate, on-call, giảm nhiễu | G7 trước phát hành (đặt SLO); G8 review tháng/quý; khi alert nhiễu |
| [`incident-response.md`](incident-response.md) | Sự cố: SEV1–4, vai trò, giảm thiệt hại trước, liên lạc, post-mortem ≤ 5 ngày, ≥ 1 hàng rào mới | Khi có sự cố; G8 diễn tập; sau mỗi SEV1/2 |
| [`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md) | 3-2-1, PITR, bất biến, RPO/RTO theo quy mô, diễn tập khôi phục, multi-region | G5 (backup trước dữ liệu thật); G7 cổng "đã thử khôi phục"; hàng quý |
| [`deployment-strategies.md`](deployment-strategies.md) | Rolling/canary/blue-green, feature flag (OpenFeature), rollback < 15 phút, expand/contract, smoke test, freeze, DORA | G5 thiết kế pipeline deploy; trước thay đổi lớn/major; khi đổi prompt/model |
| [`cost-management.md`](cost-management.md) | Ngân sách 80/90/100%, tag, unit cost, rightsizing, chi phí AI/token theo tenant, circuit breaker | G5 (budget trước khi tạo tài nguyên); hàng tháng; mọi tính năng gọi LLM |
| [`maintenance-and-lifecycle.md`](maintenance-and-lifecycle.md) | Dependabot/Renovate gom nhóm, EOL theo endoflife.date, nâng major có kế hoạch, nợ kỹ thuật có chủ, quét tuần | G8 liên tục; review bảo trì tháng; khi runtime/framework sắp EOL |
