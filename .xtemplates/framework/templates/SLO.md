---
title: Mẫu SLO
kind: template
updated: 2026-11-02
---

# Mẫu docs/ops/SLO.md

> **Ai viết:** chủ dịch vụ + người trực; chủ sản phẩm duyệt mục tiêu. **Giai đoạn:** G4 (bản đầu, trước khi có người dùng
> thật), G8 (đối chiếu số thật). **Cổng dùng:** `OPS-SLO-001`, `OPS-SLO-010` ([`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md)),
> `IND-SAAS-013` khi công bố SLO theo gói.
> **Luật:** SLI là tỷ lệ *tốt/tổng* có query chạy được, không phải câu mô tả; mỗi SLO có cửa sổ, ngân sách lỗi và cảnh
> báo theo tốc độ đốt; con số là quyết định của đội — số trong mẫu chỉ để minh hoạ cách viết.

````markdown
# SLO — <Tên dịch vụ> · cập nhật <YYYY-MM-DD> · chủ: <tên>

## 1. SLI và mục tiêu
| Dịch vụ / hành trình | SLI (tốt / tổng) | Query (nguồn số) | Mục tiêu | Cửa sổ | Ngân sách lỗi |
|---|---|---|---|---|---|
| <API công khai> | availability: phản hồi không 5xx / mọi phản hồi | `<PromQL/SQL — dán nguyên văn>` | <99,9 %> | 28 ngày lăn | <0,1 % ≈ 40 phút> |
| <API công khai> | latency: phản hồi < <300> ms / mọi phản hồi | `<query>` | <99 %> | 28 ngày lăn | <1 %> |
| <Thanh toán> | correctness: giao dịch đối soát khớp / mọi giao dịch | `<query>` | <99,99 %> | 28 ngày lăn | <…> |

## 2. Cảnh báo theo tốc độ đốt ngân sách
| SLO | Tốc độ đốt | Cửa sổ dài / ngắn | Mức | Playbook |
|---|---|---|---|---|
| <availability> | <14,4×> | <1 h / 5 phút> | page | `RUNBOOK.md#<mục>` |
| <availability> | <6×> | <6 h / 30 phút> | ticket | `RUNBOOK.md#<mục>` |

## 3. Chính sách khi hết ngân sách
- <Ví dụ: dừng phát hành tính năng, chỉ nhận bản vá độ tin cậy, tới khi ngân sách hồi lại> — ai quyết: <tên/vai trò>.

## 4. Đo thật (cập nhật mỗi kỳ)
| Kỳ | SLI đạt | Ngân sách đã dùng | Sự cố liên quan | Ghi chú |
|---|---|---|---|---|
| <YYYY-MM> | <…> | <…> | <POST-MORTEM-…> | <…> |
````
