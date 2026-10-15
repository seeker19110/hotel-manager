---
title: Chi phí: ngân sách, cảnh báo, FinOps, chi phí AI/token
kind: module
prefix: OPS-COST
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Chi phí: ngân sách, cảnh báo, FinOps, chi phí AI/token

> Chi phí là một SLO: có ngân sách, cảnh báo 80/90/100%, tag để phân bổ, rightsizing định kỳ, và **circuit breaker** cho chi phí
> AI/token theo tenant/run — vì vòng lặp agent có thể đốt tiền nhanh hơn người kịp nhìn dashboard. Đo chi phí LLM ở mức ứng dụng
> (token, cache, model) là nhà của [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md);
> ngân sách vòng lặp dev ở [`../11-autonomous-loop/context-and-token-budget.md`](../11-autonomous-loop/context-and-token-budget.md).

## Nguyên tắc

- **Ngân sách là hard stop, không phải dashboard**: cảnh báo 80%, bóp (throttle) 90%, dừng 100% — enforce bằng code/policy cho thứ có thể chạy hoang (agent, job, autoscale).
- **Không tag = không biết ai tiêu**: mọi tài nguyên có `env`, `service`, `owner`, `cost-center`; chi phí AI gắn `tenant`, `feature`, `run_id`.
- **Chi phí theo đơn vị nghiệp vụ** (cost per order/user/run) mới so sánh được giữa tháng; tổng tiền tăng theo tăng trưởng là bình thường.
- **Rightsizing định kỳ, không một lần**: tài nguyên idle, over-provisioned, log/trace thừa, snapshot cũ — rà hàng tháng với số đo.
- **Kiến trúc quyết định chi phí**: chọn managed/serverless hay tự host, vùng, egress, retention là quyết định có ADR; "free tier" có điều kiện (xem bẫy).
- **Chuẩn mở cho dữ liệu chi phí**: FinOps FOCUS 1.4 để gom hoá đơn đa cloud/SaaS về một schema.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Ngân sách cloud | Budget của nhà cung cấp (AWS Budgets/GCP Budgets/Azure Cost Management) theo tháng, alert actual **và** forecasted ở 80/90/100% | Tổng hợp đa cloud bằng FOCUS + dashboard riêng khi > 1 nhà cung cấp |
| Hành động khi vượt | 80% thông báo; 90% chặn tạo tài nguyên mới (budget action/IAM deny) hoặc bóp job không khẩn; 100% dừng workload không SLA | Production có SLA: không tự dừng, chỉ leo thang người + tắt phần không thiết yếu |
| Chi phí K8s | OpenCost (CNCF incubating) phân bổ theo namespace/label | Kubecost/nhà cung cấp khi cần báo cáo đa cluster |
| Ước tính trước thay đổi | Infracost trong PR hạ tầng (xem [`infrastructure-as-code.md`](infrastructure-as-code.md)) | Bỏ ở S |
| Chi phí AI/LLM | Gateway/proxy ghi token in/out, model, cache hit theo `tenant`/`feature`/`run_id`; hạn mức theo tenant và theo run; circuit breaker 80/90/100% | Nhà cung cấp có hạn mức/usage API → vẫn đo ở phía mình (độ trễ hoá đơn) |
| Lưu trữ/quan sát | Lifecycle (hot → cold → xoá), retention có lý do, sampling trace | Giữ dài hơn chỉ cho audit/luật (12, 16) |
| Cam kết (RI/Savings Plans/committed use) | Chỉ sau ≥ 3 tháng số liệu ổn định; phủ ≤ 70% baseline | — |

## Checklist

- [ ] `OPS-COST-001` **MUST** Có ngân sách tháng cho mỗi môi trường/dự án cloud và cho dịch vụ AI, với cảnh báo ở 80%, 90%, 100% cả chi phí thực và dự báo, gửi tới kênh có người đọc. → Kiểm: cấu hình budget trong IaC (`aws_budgets_budget`/`google_billing_budget`); alert đã thử kích hoạt 1 lần (ghi ngày). · Nguồn: AWS Budgets docs (alert actual/forecasted); catalog stored 21 §8 (80/90/100)
- [ ] `OPS-COST-002` **MUST@L** Mọi tài nguyên cloud có tag bắt buộc (`env`, `service`, `owner`, `cost-center`); policy chặn tạo thiếu tag; báo cáo chi phí nhóm theo tag. → Kiểm: `default_tags`/label trong IaC; conftest/checkov rule thiếu tag = deny; % chi phí không tag < 5%. · Nguồn: FinOps FOCUS (phân bổ); [`infrastructure-as-code.md`](infrastructure-as-code.md)
- [ ] `OPS-COST-003` **MUST** Chi phí AI/LLM đo ở phía mình: token in/out, model, cache hit/miss, số lần gọi, chi phí ước tính theo bảng giá có ngày — gắn `tenant`, `feature`, `user`/`run_id`; dashboard chi phí theo tenant. → Kiểm: metric `llm_tokens_total{tenant,feature,model,direction}`; bảng giá `model-rates.json` có `verified_at`; dashboard tồn tại. · Nguồn: OTel GenAI `gen_ai.usage.*`; [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md)
- [ ] `OPS-COST-004` **MUST** Circuit breaker chi phí cho mọi workload có thể chạy hoang (agent loop, job nền, autoscale, gọi API trả phí): ngân sách theo run và theo ngày/tenant; 80% cảnh báo, 90% bóp, 100% dừng — enforce bằng code, không bằng prompt. → Kiểm: test mô phỏng vượt 100% → dừng + alert; cấu hình ngưỡng trong code/config có review. · Nguồn: catalog stored 21 §8 (spend circuit breaker; ví dụ runaway 400 lần/5 phút); OWASP LLM 2026 LLM06
- [ ] `OPS-COST-005` **MUST** Giới hạn trần autoscale/concurrency (max instances, max workers, max tokens/phút) để sự cố hoặc tấn công không tạo hoá đơn không giới hạn. → Kiểm: `max_size`/`maxReplicas`/quota trong IaC; không có autoscale không trần. · Nguồn: OWASP API Top 10 2023 API4; LLM06
- [ ] `OPS-COST-006` **MUST@L** Chi phí theo đơn vị nghiệp vụ (cost per active user/order/run/1k request) tính hàng tháng và theo dõi xu hướng; ngưỡng tăng > 20%/tháng không do tăng trưởng → điều tra. → Kiểm: báo cáo tháng có unit cost; nguồn số liệu tự động. · Nguồn: FinOps Framework (unit economics — chưa fetch lại 2026-10-13)
- [ ] `OPS-COST-007` **MUST@L** Rà rightsizing hàng tháng với số đo: instance CPU < 20% trong 30 ngày, volume/IP/LB/snapshot không gắn, log/trace ingest tăng, bucket không lifecycle, môi trường dev chạy đêm/cuối tuần. → Kiểm: báo cáo rightsizing (cloud recommender/script) + ticket hành động; dev tắt theo lịch. · Nguồn: AWS/GCP recommender docs (chưa fetch lại); FinOps
- [ ] `OPS-COST-008` **MUST@L** Thay đổi hạ tầng có ước tính chi phí trong PR; tăng > ngưỡng (đội chọn, vd 10% ngân sách tháng) cần duyệt chủ ngân sách. → Kiểm: Infracost comment; label duyệt. · Nguồn: [`infrastructure-as-code.md`](infrastructure-as-code.md) `OPS-IAC-012`
- [ ] `OPS-COST-009` **MUST@L** Hạn mức AI theo tenant/người dùng (free/paid) enforce ở gateway, trả lỗi rõ khi hết; hạn mức ghi trong hợp đồng/điều khoản. → Kiểm: test vượt hạn mức → 429 + thông điệp; cấu hình hạn mức theo plan. · Nguồn: catalog stored 23 §4.1 (free tier 30 lượt/ngày); LLM06
- [ ] `OPS-COST-010` **MUST@L** Retention/lifecycle cho log, trace, backup, artifact, image registry, snapshot với lý do; dữ liệu lạnh chuyển tầng rẻ; xoá tự động sau hạn. → Kiểm: lifecycle policy trong IaC; chi phí storage theo tầng trên dashboard. · Nguồn: [`observability.md`](observability.md); [`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md)
- [ ] `OPS-COST-011` **MUST@L** Dữ liệu hoá đơn gom về schema FOCUS (hoặc tương đương) cho đa cloud/SaaS; báo cáo chi phí theo đội/sản phẩm hàng tháng tới chủ ngân sách; chargeback/showback. → Kiểm: pipeline export billing → FOCUS; báo cáo tháng có người nhận. · Nguồn: FinOps FOCUS 1.4
- [ ] `OPS-COST-012` **MUST@L** Cam kết (RI/Savings Plans/CUD) dựa trên ≥ 3 tháng dữ liệu, phủ ≤ 70% baseline; utilization/coverage có alert < 80%. → Kiểm: budget utilization/coverage; ADR cam kết. · Nguồn: AWS Budgets (RI/SP utilization & coverage budgets)
- [ ] `OPS-COST-013` **SHOULD** Môi trường dev/preview tự huỷ theo TTL (vd 7 ngày không dùng) và tắt ngoài giờ; preview per-PR huỷ khi PR đóng. → Kiểm: tag `ttl` + job dọn; preview env có hook đóng PR. · Nguồn: FinOps (waste)
- [ ] `OPS-COST-014` **SHOULD** Chi phí egress/data transfer và gọi API bên thứ ba được tách riêng và theo dõi (thường là bất ngờ lớn nhất). → Kiểm: dashboard có dòng egress + third-party API; alert tăng > 50%/tuần. · Nguồn: FinOps
- [ ] `OPS-COST-015` **SHOULD** Prompt caching/batching/model nhỏ cho tác vụ đơn giản được dùng có chủ đích và đo hiệu quả (A/B chi phí/chất lượng), không chỉ "model mạnh nhất cho mọi thứ". → Kiểm: báo cáo cache hit rate; ADR chọn model theo tác vụ. · Nguồn: [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md)
- [ ] `OPS-COST-016` **SHOULD** Bảng giá model/dịch vụ dùng để tính chi phí có ngày xác minh và được cập nhật ≤ 90 ngày; không hard-code giá trong nhiều nơi. → Kiểm: một file giá có `verified_at`; CI cảnh báo quá 90 ngày. · Nguồn: P5; evidence-and-sources (giá model lệch giữa tài liệu — research cũ §3b)
- [ ] `OPS-COST-017` **SHOULD** Chi phí observability (ingest GB, series, span) là dòng ngân sách riêng với alert; cardinality/sampling là đòn bẩy đầu tiên. → Kiểm: dashboard chi phí quan sát; alert ingest. · Nguồn: [`observability.md`](observability.md) `OPS-OBS-010`
- [ ] `OPS-COST-018` **MAY** Dùng OpenCost/Kubecost để phân bổ chi phí K8s theo namespace/label và showback cho đội. → Kiểm: OpenCost cài, báo cáo theo namespace. · Nguồn: OpenCost (CNCF incubating)
- [ ] `OPS-COST-019` **MAY** Spot/preemptible cho workload chịu gián đoạn (batch, CI, eval) với xử lý interrupt. → Kiểm: node pool spot + test interrupt. · Nguồn: FinOps
- [ ] `OPS-COST-020` **MAY** Review kiến trúc chi phí hàng quý (managed vs tự host, vùng, serverless vs instance) với số liệu thật và ADR nếu đổi. → Kiểm: biên bản quý. · Nguồn: P4; ADR

## Bẫy thường gặp

1. **Alert ngân sách chỉ gửi email không ai đọc** → biết khi hoá đơn về. Tránh: kênh có người + budget action tự động (`OPS-COST-001/004`).
2. **Độ trễ hoá đơn cloud 8–12 giờ** (AWS Budgets cập nhật ≤ 3 lần/ngày) → vượt xa ngưỡng trước khi alert. Tránh: đo ở phía mình cho thứ chạy nhanh (token, request) + trần autoscale.
3. **Agent loop không trần** → 400 lần gọi/5 phút khi tool trả rỗng (ví dụ vendor, catalog 21 §8). Tránh: circuit breaker theo run (`OPS-COST-004`).
4. **"Free tier" có điều kiện**: giới hạn người dùng/tháng, yêu cầu giữ thương hiệu, không xuất dữ liệu (catalog 05: 3 câu hỏi trước khi tin "free"). Tránh: ghi điều kiện vào ADR/license review.
5. **Không tag** → cuối tháng không biết 40% chi phí của ai. Tránh: policy chặn thiếu tag (`OPS-COST-002`).
6. **Log debug ở prod + retention mặc định dài** → chi phí quan sát vượt chi phí compute. Tránh: `OPS-COST-010/017`.
7. **Egress bất ngờ** (sync đa vùng, CDN cấu hình sai, backup kéo ra ngoài) → tách dòng egress (`OPS-COST-014`).
8. **Cam kết RI 3 năm ở tháng thứ 2** → kiến trúc đổi, cam kết thành lãng phí. Tránh: `OPS-COST-012`.
9. **Giá model hard-code ở 3 nơi, lệch nhau** (đã thấy trong research khung cũ) → báo cáo chi phí sai. Tránh: một file giá có ngày (`OPS-COST-016`).
10. **Tối ưu chi phí bằng cách tắt backup/giảm replica** → tiết kiệm nhỏ, rủi ro lớn (P3: đúng › an toàn › ít hơn › … › nhanh). Rightsizing không chạm vào DR/SLO.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Budget + alert | AWS Budgets / GCP Budgets / Azure (IaC) | 80/90/100% actual + forecasted → SNS/Slack | IaC | thiếu = đỏ (checkov custom) |
| Budget action | IAM deny tạo tài nguyên / tắt dev | 90% | cloud | tự động |
| Tag bắt buộc | conftest/checkov trên plan | `env, service, owner, cost-center` | CI IaC | thiếu = đỏ |
| Ước tính PR | Infracost (Apache-2.0) | `infracost diff` comment | CI PR | > ngưỡng = duyệt |
| Chi phí AI | gateway metric + bảng giá | `llm_cost_estimate{tenant}`; alert 80/90/100 theo tenant/ngày | runtime | 100% = dừng |
| Circuit breaker run | test tích hợp | vượt ngân sách run → dừng | CI | không dừng = đỏ |
| Trần autoscale | checkov/conftest | `max_size`/`maxReplicas` bắt buộc | CI IaC | thiếu = đỏ |
| Rightsizing | cloud recommender / script | hàng tháng | lịch | ticket |
| Dev TTL | job dọn theo tag `ttl` | hàng ngày | lịch | huỷ |
| Giá model tươi | script đọc `model-rates.json` | `verified_at` ≤ 90 ngày | CI lịch | quá = cảnh báo |
| FOCUS export | pipeline billing → FOCUS 1.4 | hàng tháng | lịch (L) | thiếu = báo cáo |

## Nguồn

- AWS Budgets — Managing your costs (alert actual/forecasted, budget actions, cập nhật ≤ 3 lần/ngày, độ trễ 8–12 giờ, RI/SP utilization & coverage): <https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html> — xác minh 2026-10-13.
- FinOps FOCUS specification v1.4: <https://focus.finops.org/> — xác minh 2026-10-13 (ngày phát hành 1.4 không hiện trên trang).
- OpenCost (CNCF incubating): <https://www.opencost.io/> — xác minh 2026-10-13 (license phần mềm không hiện trên trang chủ — xác minh repo).
- OWASP Top 10 for LLM Applications 2026 — LLM06 Unbounded Consumption (bản 2025 là LLM10; bảng đổi mã ở [`../12-security/ai-security.md`](../12-security/ai-security.md)): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14; OWASP API Top 10 2023 API4: <https://api-security.owasp.org/> — xác minh 2026-10-13.
- OTel GenAI semconv `gen_ai.usage.input_tokens/output_tokens`: theo research AI §4.3.
- Catalog `seeker19110/stored` 21 §8 (spend circuit breaker 80/90/100, runaway 400 lần/5 phút; arXiv 2606.03115 SPOQ — chưa xác minh), 05 (3 câu hỏi "free"), 23 §2.1/§4.1 (bảng giá model lệch; free tier dhcb), đọc 2026-10-13.
- (chưa xác minh 2026-10-13) FinOps Framework unit economics, cloud recommender docs, Infracost/Kubecost phiên bản — xác minh trước khi dẫn.
