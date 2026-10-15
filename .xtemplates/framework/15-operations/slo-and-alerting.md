---
title: SLO, error budget, cảnh báo có thể hành động, on-call
kind: module
prefix: OPS-SLO
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# SLO, error budget, cảnh báo có thể hành động, on-call

> Đặt SLI/SLO cho luồng người dùng chính, dùng error budget để quyết định tốc độ phát hành, cảnh báo **theo triệu chứng** bằng
> burn rate nhiều cửa sổ, và tổ chức on-call bền vững. Nguồn số liệu từ [`observability.md`](observability.md); khi cảnh báo nổ →
> [`incident-response.md`](incident-response.md).

## Nguyên tắc

- **SLI = tỷ lệ sự kiện tốt / tổng sự kiện**, đo từ góc nhìn người dùng (availability, latency, correctness, freshness) — không phải CPU.
- **100% là sai mục tiêu**: SLO để lại error budget; budget là tiền tệ chung giữa sản phẩm và vận hành để quyết định "phát hành tiếp hay ưu tiên ổn định".
- **Cảnh báo theo triệu chứng, không theo nguyên nhân**: page khi error budget đang cháy nhanh (burn rate), không page vì CPU 80%. Nguyên nhân để dashboard/runbook.
- **Mỗi alert page phải: khẩn, có thật, cần người, có runbook.** Thiếu một trong bốn → chuyển ticket hoặc xoá.
- **On-call là công việc có giới hạn**: lịch xoay, bù giờ, trần số lần page/ca, và thời gian được dành để giảm nhiễu.
- **SLO là tài liệu sống**: review hàng tháng lúc đầu, hàng quý khi ổn; đổi SLO qua PR như code.

## Quyết định

| Câu hỏi | Mặc định | Khi nào khác |
|---|---|---|
| SLI nào trước? | Availability (tỷ lệ request không 5xx) + latency (tỷ lệ request < ngưỡng, 2 ngưỡng vd 90% < 300 ms, 99% < 1 s) cho luồng chính | Pipeline/batch → freshness (dữ liệu mới trong X phút) + correctness; agent → tỷ lệ run hoàn tất đúng + chi phí/run |
| Mục tiêu bao nhiêu? | Bắt đầu từ số đo hiện tại làm tròn xuống (vd đo 99.3% → SLO 99%); nâng dần | Có SLA ký với khách → SLO chặt hơn SLA một bậc để còn đệm |
| Cửa sổ | Rolling 28/30 ngày | Lịch (tháng) khi gắn hợp đồng |
| Cảnh báo | Multiwindow multi-burn-rate (bảng SRE Workbook cho SLO 99.9%): page 14.4× (1h/5m), page 6× (6h/30m), ticket 1× (3d/6h) | SLO khác 99.9% → tính lại burn rate từ budget; lưu lượng thấp → gộp cửa sổ dài hơn hoặc synthetic traffic |
| Error budget hết | Chính sách viết sẵn: đóng băng tính năng, ưu tiên bug tin cậy, hoãn thay đổi rủi ro cho đến khi budget hồi | Ngoại lệ do lãnh đạo ký, ghi lại |
| On-call | ≥ 2 người xoay, ca ≤ 1 tuần, primary + secondary; dự án S: 1 người nhưng alert chỉ ticket | Đội 1 người → không page đêm; chọn kiến trúc tự hồi phục + SLO thấp hơn |
| Công cụ | Prometheus Alertmanager / Grafana alerting + PagerDuty/Opsgenie/Grafana OnCall; rule lưu trong repo | Dịch vụ cloud-native khi đã dùng managed monitoring |

## Checklist

- [ ] `OPS-SLO-001` **MUST** Mỗi dịch vụ hướng người dùng có ≥ 1 SLI availability và ≥ 1 SLI latency định nghĩa dạng tỷ lệ tốt/tổng, với query cụ thể, lưu `docs/ops/SLO.md` (hoặc file sloth/OpenSLO) trong repo. → Kiểm: file SLO có query PromQL/SQL chạy được; CI validate cú pháp (sloth/OpenSLO schema). · Nguồn: Google SRE Workbook — Implementing SLOs
- [ ] `OPS-SLO-002` **MUST@L** SLO có mục tiêu số, cửa sổ (28/30 ngày) và error budget tính được; mục tiêu không phải 100%. → Kiểm: dashboard hiện SLO, budget còn lại (%), burn rate; mục tiêu < 100%. · Nguồn: SRE Workbook (100% là sai mục tiêu)
- [ ] `OPS-SLO-003` **MUST@L** Chính sách error budget viết sẵn, được sản phẩm + kỹ thuật + vận hành duyệt: budget hết → đóng băng tính năng/ưu tiên tin cậy; có đường leo thang. → Kiểm: `docs/ops/ERROR-BUDGET-POLICY.md` có chữ ký ba bên (tên/ngày) và được nhắc trong GO/NO-GO. · Nguồn: SRE Workbook — error budget policy
- [ ] `OPS-SLO-004` **MUST** Cảnh báo page dựa trên burn rate nhiều cửa sổ (long + short) thay vì ngưỡng tĩnh; ít nhất 2 cặp (nhanh/chậm) + 1 ticket. → Kiểm: rule alert trong repo có biểu thức burn rate với 2 cửa sổ; không có alert page kiểu `cpu > 80%`. · Nguồn: SRE Workbook — Alerting on SLOs (14.4×/1h-5m, 6×/6h-30m, 1×/3d-6h cho 99.9%)
- [ ] `OPS-SLO-005` **MUST** Mỗi alert có: `severity` (page/ticket), `runbook_url` trỏ runbook có thật, chủ sở hữu, mô tả tác động người dùng; alert không có runbook không được bật. → Kiểm: script đọc rule files: 100% alert có `runbook_url` tồn tại (HTTP 200/file) và `severity`. · Nguồn: SRE Book — Monitoring (alert phải hành động được); [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md)
- [ ] `OPS-SLO-006` **MUST** Mọi alert được **thử kích hoạt** trước khi tin cậy (inject lỗi/giả metric) và sau mỗi thay đổi rule; ghi ngày diễn tập. → Kiểm: `docs/ops/alert-drills.md` có ngày + kết quả cho từng alert; lifecycle G8 yêu cầu "cảnh báo đã thử kích hoạt". · Nguồn: lifecycle G8; P1
- [ ] `OPS-SLO-007` **MUST@L** Alert rule, routing, lịch on-call là code trong repo (Alertmanager/Grafana/PagerDuty via Terraform), qua PR. → Kiểm: thư mục `alerts/` + `promtool check rules`/`amtool check-config` trong CI. · Nguồn: P5; P9
- [ ] `OPS-SLO-008` **MUST@L** Có người trực nhận page 24/7 cho SEV1 (hoặc tuyên bố rõ giờ hỗ trợ trong SLA) với primary + secondary và đường leo thang; thông tin liên hệ trong RUNBOOK. → Kiểm: lịch on-call tồn tại trong công cụ; test page tới primary → ack ≤ 15 phút (ghi ngày thử). · Nguồn: PagerDuty Incident Response (roles, on-call); SRE Book
- [ ] `OPS-SLO-009` **MUST@L** Giới hạn nhiễu: ≤ 2 page/ca (ngưỡng đội chọn, ghi rõ); vượt → tuần kế dành thời gian giảm nhiễu; alert không ai hành động trong 30 ngày bị xoá/hạ xuống ticket. → Kiểm: báo cáo tháng số page/ca, tỷ lệ alert có hành động; danh sách alert xoá. · Nguồn: SRE Book — Being On-Call (giới hạn page)
- [ ] `OPS-SLO-010` **MUST@L** Synthetic check và business metric tham gia SLI (hệ thống "xanh" nhưng không có giao dịch = vi phạm SLO). → Kiểm: SLI correctness/business trong `SLO.md`; alert "0 giao dịch trong X phút giờ cao điểm". · Nguồn: SRE Workbook (SLI theo người dùng)
- [ ] `OPS-SLO-011` **MUST@L** Review SLO hàng tháng (3 tháng đầu) rồi hàng quý: so budget đã dùng, số lần page, hành động; ghi biên bản. → Kiểm: `docs/ops/slo-reviews/` có file theo tháng/quý. · Nguồn: SRE Workbook (review frequency)
- [ ] `OPS-SLO-012` **MUST@L** SLO cho phụ thuộc nội bộ (DB, queue, dịch vụ nền) và hợp đồng SLO giữa đội; SLA với khách có SLO nội bộ chặt hơn và báo cáo tự động. → Kiểm: bảng SLO theo đội; báo cáo SLA sinh từ dữ liệu, không tay. · Nguồn: SRE Workbook
- [ ] `OPS-SLO-013` **SHOULD** Alert gom nhóm/ức chế (grouping, inhibition, silence có hạn) để một sự cố gốc không tạo 50 thông báo; silence quá hạn tự hết. → Kiểm: cấu hình `inhibit_rules`/`group_by`; silence có `ends_at`. · Nguồn: Alertmanager docs (chưa fetch lại 2026-10-13)
- [ ] `OPS-SLO-014` **SHOULD** Alert ticket (burn chậm, cert sắp hết hạn, disk 80%, dependency EOL) đi vào hàng đợi việc, không vào kênh page. → Kiểm: routing theo `severity`; kênh page chỉ có `severity=page`. · Nguồn: SRE Workbook — Alerting on SLOs (ticket vs page)
- [ ] `OPS-SLO-015` **SHOULD** Lưu lượng thấp: dùng cửa sổ dài hơn, gộp nhiều dịch vụ, hoặc synthetic traffic để burn rate có ý nghĩa; không page vì 1 request lỗi. → Kiểm: rule có `min_requests` hoặc cửa sổ ≥ 1 giờ cho dịch vụ < N req/phút. · Nguồn: SRE Workbook — low-traffic services
- [ ] `OPS-SLO-016` **SHOULD** Agent/LLM: SLI gồm tỷ lệ run hoàn tất đúng (có kiểm chứng ngoài), p95 thời gian run, chi phí/run; alert khi chi phí/run hoặc tỷ lệ bị guardrail chặn tăng bất thường. → Kiểm: metric + rule tồn tại; xem [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md). · Nguồn: catalog stored 21 §8 (observability cho loop)
- [ ] `OPS-SLO-017` **SHOULD** Trang trạng thái (status page) công khai/nội bộ cập nhật theo sự cố, có lịch sử; không tự động xanh khi monitoring hỏng. → Kiểm: status page tồn tại; sự cố SEV1/2 gần nhất có mục. · Nguồn: [`incident-response.md`](incident-response.md)
- [ ] `OPS-SLO-018` **MAY** Dùng công cụ sinh rule từ spec SLO (sloth, pyrra, OpenSLO) để tránh viết tay burn rate sai. → Kiểm: spec SLO → rule sinh commit cùng nhau. · Nguồn: OpenSLO/sloth (chưa xác minh phiên bản)
- [ ] `OPS-SLO-019` **MAY** Chaos/game day hàng quý: tắt một phụ thuộc trên staging, kiểm alert nổ đúng và runbook đủ. → Kiểm: biên bản game day. · Nguồn: SRE Book (disaster role-playing)

## Bẫy thường gặp

1. **Alert theo nguyên nhân** (CPU, memory, số pod) → page ban đêm vì CPU 85% trong khi người dùng không ảnh hưởng; ngược lại lỗi 500 không ai page. Tránh: burn rate (`OPS-SLO-004`), nguyên nhân để dashboard.
2. **SLO 99.99% ngay từ đầu** → budget 4 phút/tháng, mọi deploy đều "vi phạm", đội bỏ SLO. Tránh: bắt đầu từ số đo thật (`OPS-SLO-002`).
3. **Alert không có runbook** → người trực không biết làm gì, chỉ ack rồi ngủ tiếp. Tránh: `OPS-SLO-005`.
4. **Alert chưa bao giờ nổ thử** → sự cố thật mới biết rule sai label/cửa sổ. Tránh: `OPS-SLO-006`.
5. **Ngưỡng tĩnh cho latency trung bình** → p99 tệ mà trung bình đẹp. Dùng tỷ lệ request dưới ngưỡng (SLI phân phối).
6. **Silence vĩnh viễn** cho alert nhiễu thay vì sửa/xoá → alert thật bị chôn. Tránh: silence có hạn + review tháng (`OPS-SLO-009`).
7. **Một người on-call mãi mãi** → kiệt sức, nghỉ việc, không ai biết hệ thống. Tránh: xoay ≥ 2, giới hạn page, hoặc chấp nhận không page đêm cho dự án S.
8. **Monitoring hỏng = mọi thứ xanh**: không có alert "không có dữ liệu" (absent). Thêm `absent()`/heartbeat cho pipeline metric.
9. **Error budget chỉ để xem** không có chính sách → không ai đổi hành vi khi cháy. Tránh: `OPS-SLO-003` có chữ ký ba bên.
10. **Status page cập nhật tay sau khi hết sự cố** → mất lòng tin. Cập nhật trong 15 phút từ khi xác nhận SEV1/2 (`incident-response.md`).

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Rule hợp lệ | Prometheus `promtool` / Alertmanager `amtool` (Apache-2.0) | `promtool check rules alerts/*.yml`; `amtool check-config alertmanager.yml` | pre-commit + CI | lỗi = đỏ |
| Alert có runbook + severity | script đọc YAML | mọi rule có `annotations.runbook_url` (tồn tại) + `labels.severity` | CI | thiếu = đỏ |
| Burn rate đúng công thức | sloth/pyrra (Apache-2.0) sinh rule từ spec | `sloth generate -i slo.yml -o rules.yml` + `git diff --exit-code` | CI | lệch = đỏ |
| Unit test rule | `promtool test rules` | kịch bản series giả → alert nổ/không nổ | CI | sai = đỏ |
| Diễn tập alert | inject lỗi staging / `amtool alert add` | ghi `alert-drills.md` | trước release + sau đổi rule | chưa diễn tập = NO-GO |
| Page tới on-call | test gửi page | ack ≤ 15 phút | hàng quý | quá = sửa lịch |
| Dữ liệu vắng | rule `absent()`/heartbeat | mỗi dịch vụ | runtime | nổ = page |
| Báo cáo nhiễu | query số page/ca, % alert có hành động | hàng tháng | lịch | > ngưỡng = việc giảm nhiễu |

## Nguồn

- Google SRE Workbook — Alerting on SLOs (multiwindow multi-burn-rate: 14.4×/1h-5m 2% budget, 6×/6h-30m 5%, 1×/3d-6h 10% cho SLO 99.9%): <https://sre.google/workbook/alerting-on-slos/> — xác minh 2026-10-13.
- Google SRE Workbook — Implementing SLOs (SLI tỷ lệ tốt/tổng, 100% sai mục tiêu, error budget policy ba bên, review tháng → quý, cửa sổ 4 tuần): <https://sre.google/workbook/implementing-slos/> — xác minh 2026-10-13.
- Google SRE Book — Postmortem Culture (trigger postmortem) dùng cho liên kết sang incident: <https://sre.google/sre-book/postmortem-culture/> — xác minh 2026-10-13; chương Monitoring/Being On-Call — (chưa fetch lại 2026-10-13).
- PagerDuty Incident Response — roles (IC, Deputy, Scribe, SME, Liaison): <https://response.pagerduty.com/before/different_roles/> — xác minh 2026-10-13.
- OpenTelemetry HTTP metrics (`http.server.request.duration`) làm nguồn SLI latency: <https://opentelemetry.io/docs/specs/semconv/http/http-metrics/> — xác minh 2026-10-13.
- (chưa xác minh 2026-10-13) Alertmanager docs, sloth/pyrra/OpenSLO phiên bản — xác minh trước khi dùng.
- Khung cũ X-stored `01-process-and-standards.md` GĐ 8 (giám sát + cảnh báo), commit `1b80fe4`; catalog `seeker19110/stored` 21 §8 (observability cho loop), đọc 2026-10-13.
