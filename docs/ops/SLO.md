---
title: SLI/SLO — Hotel Manager
kind: slo
updated: 2026-10-16
owner: (chưa gán — Tech Lead)
---

# SLI/SLO

> Nguồn ngưỡng: `PROJECT.md` §5 (kế hoạch §17). **SLO nội bộ, chưa phải SLA** cam kết với khách hàng. Chưa có production: số liệu thật chưa đo; ngưỡng chỉnh lại sau pilot.
> **Metric HTTP (T-406):** ứng dụng web đo ở lớp handler (`packages/app/src/observability/http-metrics.ts`) và xuất ở `/api/metrics`: `hm_http_requests_total{route,method,status}` (counter) và `hm_http_request_duration_seconds{route,method,status}` (histogram, có bucket `le="0.8"` cho SLO 800 ms). `route` là **mẫu route** (`/api/v1/payment/confirm`, `/api/v1/commands/{id}`), không bao giờ chứa id; số chuỗi có trần cứng 1000 (+ 6 chuỗi tràn `route="other"`) nên không phình nhãn (OPS-OBS-003). Số liệu nằm **trong bộ nhớ từng bản web** (mất khi khởi động lại — Prometheus xử lý counter reset bằng `rate`) và vẫn xuất được khi CSDL chết (`hm_metrics_db_ok 0`). Worker không phục vụ HTTP nên không có metric này. SLI khả dụng và độ trễ dưới đây **tính được** từ Prometheus; cảnh báo burn rate nằm ở `deploy/prometheus/alerts.yml` nhóm `hotel-manager.slo`.
> **Loại metric:** `notification_dead_total` là **gauge** (số hàng `notification_deliveries.status = 'dead'` tại lúc đọc, `app.metrics_snapshot`), không phải counter dù tên có `_total`; `metrics.ts` khai `# TYPE gauge`. Rule cảnh báo dùng `delta()` thay `increase()` vì gửi lại làm số này giảm. `hm_jobs_failed`, `hm_holds_active`, `hm_outbox_*` cũng là gauge.

## 1. SLI và SLO
Dạng tốt/tổng. "Luồng lõi" = API `/api/v1/*` (lệnh/truy vấn) và `/api/ready`; không tính 4xx do người dùng (trừ 429 do hệ thống giới hạn quá tay).

| ID | SLI (tốt / tổng) | SLO | Cửa sổ | Cần có để đo |
|---|---|---|---|---|
| SLO-AVAIL | yêu cầu luồng lõi không phải 5xx / tổng yêu cầu luồng lõi | **99,9%** | 30 ngày | **đã có** `hm_http_requests_total{route,method,status}` |
| SLO-LAT | yêu cầu API thường có độ trễ ≤ 800 ms / tổng (đại diện p95 < 800 ms) | **95%** ≤ 800 ms | 30 ngày | **đã có** `hm_http_request_duration_seconds` (histogram, bucket 0,8) |
| SLO-HOLD | yêu cầu tạo giữ phòng ≤ 1,5 s / tổng (p95 < 1,5 s ở tải kiểm thử) | **95%** ≤ 1,5 s | 30 ngày | **đã có** histogram theo `route="/api/v1/…"` của lệnh giữ phòng (bucket `le="1.5"`); đo trước bằng k6 (`PROJECT.md` §5) |
| SLO-OUTBOX | thời gian từ ghi outbox tới phát ≤ 5 phút | **99%** thời điểm lấy mẫu | 30 ngày | **đã có** `hm_outbox_oldest_unpublished_age_seconds` |
| SLO-WORKER | worker có nhịp ≤ 120 giây | **99,5%** thời gian | 30 ngày | **đã có** `hm_worker_heartbeat_age_seconds` |
| SLO-PITR | RPO CSDL ≤ 15 phút, RTO ≤ 4 giờ | chỉ công bố sau diễn tập | mỗi quý | diễn tập restore ([restore](runbooks/restore.md)) |

Truy vấn PromQL (luồng lõi = `/api/v1/*` và `/api/ready`; lỗi = 5xx):
```promql
# SLO-AVAIL: tỷ lệ lỗi 5xx trong cửa sổ W (thay W = 5m, 30m, 1h, 6h, 3d)
sum(rate(hm_http_requests_total{route=~"/api/v1/.*|/api/ready",status=~"5.."}[W])) / sum(rate(hm_http_requests_total{route=~"/api/v1/.*|/api/ready"}[W]))
# SLO-LAT: tỷ lệ yêu cầu API chậm hơn 0,8 giây
1 - sum(rate(hm_http_request_duration_seconds_bucket{route=~"/api/v1/.*",le="0.8"}[W])) / sum(rate(hm_http_request_duration_seconds_count{route=~"/api/v1/.*"}[W]))
# p95 (báo cáo, không làm cổng): histogram_quantile gộp theo le
histogram_quantile(0.95, sum by (le) (rate(hm_http_request_duration_seconds_bucket{route=~"/api/v1/.*"}[5m])))
```
> SLO-OUTBOX đo theo hàng cũ nhất toàn hệ; fair-share theo tổ chức (D-130, migration 0073) giữ cho backlog của một tổ chức không làm trễ tổ chức khác: relay claim vòng tròn ưu tiên ≤ `RELAY_PER_ORG` (10) sự kiện/tổ chức/lượt rồi lấp đủ lô theo thứ tự cũ (D-132: tổ chức đơn lẻ vẫn xả đủ lô 100/lượt), consumer chạy tuần tự mỗi queue mỗi tiến trình worker để giữ thứ tự sự kiện trong tổ chức (`apps/worker/src/relay.ts`; đo ở `relay-fair-share.db.test.ts`: B có mặt ngay lượt claim đầu khi A dồn 10.000 sự kiện; một tổ chức 1.000 sự kiện ⇒ lượt đầu đủ 100, đúng thứ tự).

Truy vấn đo được ngay (SLO-OUTBOX, SLO-WORKER):
```promql
avg_over_time((hm_outbox_oldest_unpublished_age_seconds <= bool 300)[30d:1m])
avg_over_time((max(hm_worker_heartbeat_age_seconds) <= bool 120)[30d:1m])
```

## 2. Ngân sách lỗi (error budget)
SLO 99,9%/30 ngày ⇒ ngân sách lỗi **0,1%** ≈ **43 phút** không khả dụng tương đương mỗi 30 ngày (30 × 24 × 60 × 0,001 = 43,2). Với SLO-LAT 95%: 5% yêu cầu được phép chậm.
- Mức tiêu thụ (burn rate) = tỷ lệ lỗi thực / ngân sách (0,001). Burn 1× = hết đúng ngân sách vào cuối kỳ.
- Cảnh báo burn rate nhiều cửa sổ (`deploy/prometheus/alerts.yml`, nhóm `hotel-manager.slo`; hệ số theo SRE Workbook, cho SLO 99,9% ngân sách 0,001 và SLO-LAT ngân sách 0,05). **Cả cửa sổ dài lẫn ngắn phải cùng vượt** mới báo (tránh báo lúc sự cố đã hết), và cửa sổ dài phải có ≥ 30 request (tránh báo vì vài request đêm khuya):

| Rule (khả dụng / độ trễ) | Hệ số đốt | Cửa sổ dài / ngắn | Mức | Ngưỡng tỷ lệ lỗi (khả dụng) | Ngưỡng tỷ lệ chậm (độ trễ) |
|---|---|---|---|---|---|
| `HmAvailabilityBurnFast` / `HmLatencyBurnFast` | 14,4× | 1 giờ / 5 phút | **page** | > 1,44% 5xx | > 72% chậm hơn 800 ms |
| `HmAvailabilityBurnMedium` / `HmLatencyBurnMedium` | 6× | 6 giờ / 30 phút | **ticket** (đề xuất của kế hoạch đợt 5; SRE Workbook xếp page — nâng lên khi có lịch trực) | > 0,6% | > 30% |
| `HmAvailabilityBurnSlow` / `HmLatencyBurnSlow` | 1× | 3 ngày / 6 giờ | **ticket** | > 0,1% | > 5% |

  Không có cảnh báo page kiểu ngưỡng tài nguyên (`cpu > 80%`). Chưa thử kích hoạt tới kênh thật (`OPS-SLO-006`); Cú pháp và hành vi rule được CI kiểm bằng `promtool check rules` + `promtool test rules deploy/prometheus/alerts.test.yml` (job `prometheus-rules`, ca báo lẫn không báo cho mọi cảnh báo `page`); truy vấn PromQL trong §1 được kiểm cú pháp bằng `node scripts/check-slo-promql.mjs`.
- Số mẫu tối thiểu và ngưỡng khởi điểm, chỉnh sau pilot 4 tuần.

## 3. Chính sách khi cạn ngân sách
| Đã dùng trong kỳ | Hành động |
|---|---|
| < 50% | Phát hành bình thường |
| 50–100% | Chỉ phát hành sửa lỗi và việc độ tin cậy; mọi PR chạm tiền/tồn/CSDL phải nêu đường lùi và có người thứ hai xem |
| ≥ 100% (cạn) | **Đóng băng tính năng mới** tới khi ngân sách phục hồi (cửa sổ trượt) hoặc chủ dự án ghi quyết định ngoại lệ; mọi việc dồn vào nguyên nhân gốc; hậu kiểm bắt buộc cho từng sự cố đã tiêu ngân sách |
| Một sự cố đơn lẻ tiêu > 20% | Hậu kiểm không đổ lỗi trong 5 ngày làm việc ([INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) §3.6) |

Thời gian bảo trì có báo trước không tính vào ngân sách khi đã thông báo người dùng ≥ 48 giờ (đề xuất; chủ dự án duyệt).

## 4. Cảnh báo hiện có và vai trò
Chênh lệch đối soát (IND-FIN-006): job worker hằng ngày `reconciliation.daily` ghi audit cho break mở quá SLA 48 giờ; số liệu `hm_reconciliation_breaks_open` / `hm_reconciliation_breaks_oldest_open_age_seconds` đọc trực tiếp từ CSDL khi scrape; rule ticket `HmReconciliationBreaksOverSla`.

Mọi rule ở [`deploy/prometheus/alerts.yml`](../../deploy/prometheus/alerts.yml) có `severity` (`page` hoặc `ticket`), `owner` và `runbook_url` trỏ tệp có thật; `scripts/ops-docs.test.mjs` kiểm cấu trúc đó và kiểm mọi metric trong biểu thức có trong `metrics.ts`. Ngưỡng tĩnh nhưng gắn với **hệ quả nghiệp vụ** (webhook thanh toán không ghi, email không đi, worker chết), không phải CPU/RAM. Chưa thử kích hoạt tới kênh thật (cần Prometheus/Alertmanager trên môi trường thật — `OPS-SLO-006`, ghi `docs/ops/alert-drills.md` khi diễn tập).

## 5. Rà soát
Sau pilot 4 tuần: đo thực tế, chỉnh SLO/ngưỡng, ghi vào mục này kèm ngày. Mỗi quý: xem lại mức tiêu thụ và các sự cố.
