---
title: SLI/SLO — Hotel Manager
kind: slo
updated: 2026-10-16
owner: (chưa gán — Tech Lead)
---

# SLI/SLO

> Nguồn ngưỡng: `PROJECT.md` §5 (kế hoạch §17). **SLO nội bộ, chưa phải SLA** cam kết với khách hàng. Chưa có production: số liệu thật chưa đo; ngưỡng chỉnh lại sau pilot.
> **Giới hạn hiện tại (cần biết):** ứng dụng mới xuất số liệu vận hành ở `packages/app/src/observability/metrics.ts` (outbox, thông báo, xuất, hold, job, nhịp worker). **Chưa có metric HTTP** (số yêu cầu theo mã trạng thái, histogram độ trễ) nên SLI khả dụng và độ trễ dưới đây **chưa tính được từ Prometheus**; truy vấn PromQL ghi sẵn để kích hoạt khi có metric (bảng "Cần có"). Trong lúc đó, `deploy/prometheus/alerts.yml` chỉ có cảnh báo trên metric hiện hữu — **không có cảnh báo burn rate** vì không có SLI để tính; không giả lập bằng `up` hay `hm_up`.

## 1. SLI và SLO
Dạng tốt/tổng. "Luồng lõi" = API `/api/v1/*` (lệnh/truy vấn) và `/api/ready`; không tính 4xx do người dùng (trừ 429 do hệ thống giới hạn quá tay).

| ID | SLI (tốt / tổng) | SLO | Cửa sổ | Cần có để đo |
|---|---|---|---|---|
| SLO-AVAIL | yêu cầu luồng lõi không phải 5xx / tổng yêu cầu luồng lõi | **99,9%** | 30 ngày | `hm_http_requests_total{route,code}` (counter) — chưa có |
| SLO-LAT | yêu cầu API thường có độ trễ ≤ 800 ms / tổng (đại diện p95 < 800 ms) | **95%** ≤ 800 ms | 30 ngày | `hm_http_request_duration_seconds` (histogram, bucket 0,8) — chưa có |
| SLO-HOLD | yêu cầu tạo giữ phòng ≤ 1,5 s / tổng (p95 < 1,5 s ở tải kiểm thử) | **95%** ≤ 1,5 s | 30 ngày | histogram theo `route="inventory.hold"` — chưa có; đo trước bằng k6 (`PROJECT.md` §5) |
| SLO-OUTBOX | thời gian từ ghi outbox tới phát ≤ 5 phút | **99%** thời điểm lấy mẫu | 30 ngày | **đã có** `hm_outbox_oldest_unpublished_age_seconds` |
| SLO-WORKER | worker có nhịp ≤ 120 giây | **99,5%** thời gian | 30 ngày | **đã có** `hm_worker_heartbeat_age_seconds` |
| SLO-PITR | RPO CSDL ≤ 15 phút, RTO ≤ 4 giờ | chỉ công bố sau diễn tập | mỗi quý | diễn tập restore ([restore](runbooks/restore.md)) |

Truy vấn PromQL (kích hoạt khi có metric HTTP):
```promql
# SLO-AVAIL: tỷ lệ lỗi 5xx trong cửa sổ W (thay W = 5m, 30m, 1h, 6h, 3d)
sum(rate(hm_http_requests_total{code=~"5.."}[W])) / sum(rate(hm_http_requests_total[W]))
# SLO-LAT: tỷ lệ yêu cầu chậm hơn 0,8 giây
1 - (sum(rate(hm_http_request_duration_seconds_bucket{le="0.8"}[W])) / sum(rate(hm_http_request_duration_seconds_count[W])))
```
Truy vấn đo được ngay (SLO-OUTBOX, SLO-WORKER):
```promql
avg_over_time((hm_outbox_oldest_unpublished_age_seconds <= bool 300)[30d:1m])
avg_over_time((max(hm_worker_heartbeat_age_seconds) <= bool 120)[30d:1m])
```

## 2. Ngân sách lỗi (error budget)
SLO 99,9%/30 ngày ⇒ ngân sách lỗi **0,1%** ≈ **43 phút** không khả dụng tương đương mỗi 30 ngày (30 × 24 × 60 × 0,001 = 43,2). Với SLO-LAT 95%: 5% yêu cầu được phép chậm.
- Mức tiêu thụ (burn rate) = tỷ lệ lỗi thực / ngân sách (0,001). Burn 1× = hết đúng ngân sách vào cuối kỳ.
- Cảnh báo burn rate nhiều cửa sổ (khi có SLI HTTP, theo SRE Workbook, cho 99,9%): **page** 14,4× trên cửa sổ dài 1 giờ **và** ngắn 5 phút; **page** 6× trên 6 giờ **và** 30 phút; **ticket** 1× trên 3 ngày **và** 6 giờ. Cả hai cửa sổ phải vượt mới báo (tránh báo lúc sự cố đã hết). Viết vào `deploy/prometheus/alerts.yml` cùng lúc thêm metric HTTP (task đề xuất: "OPS-OBS-003 metric HTTP + burn rate").

## 3. Chính sách khi cạn ngân sách
| Đã dùng trong kỳ | Hành động |
|---|---|
| < 50% | Phát hành bình thường |
| 50–100% | Chỉ phát hành sửa lỗi và việc độ tin cậy; mọi PR chạm tiền/tồn/CSDL phải nêu đường lùi và có người thứ hai xem |
| ≥ 100% (cạn) | **Đóng băng tính năng mới** tới khi ngân sách phục hồi (cửa sổ trượt) hoặc chủ dự án ghi quyết định ngoại lệ; mọi việc dồn vào nguyên nhân gốc; hậu kiểm bắt buộc cho từng sự cố đã tiêu ngân sách |
| Một sự cố đơn lẻ tiêu > 20% | Hậu kiểm không đổ lỗi trong 5 ngày làm việc ([INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) §3.6) |

Thời gian bảo trì có báo trước không tính vào ngân sách khi đã thông báo người dùng ≥ 48 giờ (đề xuất; chủ dự án duyệt).

## 4. Cảnh báo hiện có và vai trò
Mọi rule ở [`deploy/prometheus/alerts.yml`](../../deploy/prometheus/alerts.yml) có `severity` (`page` hoặc `ticket`), `owner` và `runbook_url` trỏ tệp có thật; `scripts/ops-docs.test.mjs` kiểm cấu trúc đó và kiểm mọi metric trong biểu thức có trong `metrics.ts`. Ngưỡng tĩnh nhưng gắn với **hệ quả nghiệp vụ** (webhook thanh toán không ghi, email không đi, worker chết), không phải CPU/RAM. Chưa thử kích hoạt tới kênh thật (cần Prometheus/Alertmanager trên môi trường thật — `OPS-SLO-006`, ghi `docs/ops/alert-drills.md` khi diễn tập).

## 5. Rà soát
Sau pilot 4 tuần: đo thực tế, chỉnh SLO/ngưỡng, ghi vào mục này kèm ngày. Mỗi quý: xem lại mức tiêu thụ và các sự cố.
