---
title: SaaS B2B đa tenant
kind: industry
slug: saas-multitenant
prefix: IND-SAAS
modules: [16-compliance-privacy/*, 12-security/*, 08-backend/authn-authz, 08-backend/api-design, 08-backend/background-jobs-and-queues, 08-backend/caching, 08-backend/reliability-and-errors, 08-backend/integrations-and-webhooks, 09-database/data-modeling, 09-database/sensitive-data-and-access, 09-database/migrations, 09-database/backup-and-recovery, 09-database/indexing-and-query-performance, 05-architecture/resilience-and-scalability, 05-architecture/boundaries-and-modularity, 15-operations/slo-and-alerting, 15-operations/cost-management, 15-operations/deployment-strategies, 15-operations/observability, 14-testing-quality/performance-and-load, 14-testing-quality/integration-and-contract, 10-workflow/release-and-versioning]
updated: 2026-10-16
---

# Gói ngành: SaaS B2B đa tenant

> Ghép cho phần mềm **một mã nguồn phục vụ nhiều khách hàng doanh nghiệp (tenant)** dùng chung hạ tầng. Rủi ro số một
> là rò dữ liệu giữa tenant; số hai là một tenant làm chậm tất cả (noisy neighbor); số ba là không chứng minh được
> tuân thủ cho khách hàng (SOC 2/ISO 27001/DPA). Gói này cho **nền tảng**; ngành của khách hàng (y tế, tài chính…)
> ghép thêm gói tương ứng.

## Khi nào dùng

Dùng khi có khái niệm **tổ chức/workspace** với nhiều người dùng, dữ liệu phân tách theo tổ chức, có hợp đồng/gói
dịch vụ, SLA và khách hàng yêu cầu bằng chứng bảo mật. Ứng dụng B2C một tài khoản = một người **không** cần gói này
(dùng hồ sơ web-app + baseline).

## Kiến trúc tham chiếu

```text
[Khách hàng A/B/C] → [Edge: WAF, rate limit theo tenant] → [API: tenant resolver (subdomain/JWT claim) → RLS context]
                                                           ├─ Postgres shared schema + RLS (mặc định)  hoặc  schema/DB riêng cho tenant lớn/regulated
                                                           ├─ Queue/job: hàng đợi có fair-share theo tenant, quota
                                                           ├─ Object storage: prefix theo tenant + KMS key theo tenant (crypto-shredding)
                                                           ├─ Cache: key có tiền tố tenant
                                                           └─ Billing/Entitlement: gói, hạn mức, feature flag theo tenant
[Admin nội bộ] → impersonation có lý do + audit; [Tenant admin] → SSO (OIDC/SAML), SCIM, audit log tự phục vụ
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Khi nào khác |
|---|---|---|
| Mô hình dữ liệu | Shared DB, shared schema, cột `tenant_id` ở **mọi** bảng + Row-Level Security bật mặc định | Tenant regulated/yêu cầu cư trú dữ liệu → DB/cluster riêng theo vùng |
| Xác thực | OIDC/SAML SSO cho tenant, SCIM cho provisioning, MFA bắt buộc cho admin | Xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md) |
| Khoá mã hoá | KMS với khoá (hoặc data key) riêng từng tenant | Xoá tenant = huỷ khoá |
| Giới hạn tài nguyên | Rate limit + quota (API, job, storage) theo gói; hàng đợi fair-share | Tenant "enterprise" có pool riêng |
| Bằng chứng tuân thủ | SOC 2 Type II (TSC 2017, points of focus 2022) hoặc ISO/IEC 27001:2022 + ISO/IEC 27701:2025; trang trust center | Khách hàng EU: DPA theo GDPR Art. 28 + SCC |
| Phiên bản API | Versioning rõ, deprecation ≥ 6 tháng, changelog công khai | [`../08-backend/api-design.md`](../08-backend/api-design.md) |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với SaaS | Nguồn |
|---|---|---|---|
| Luật BVDLCN 91/2025/QH15 + NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026) | 01/01/2026 | SaaS là **bên xử lý** cho tenant (và bên kiểm soát với dữ liệu người dùng của mình): hợp đồng xử lý, biện pháp bảo vệ, thông báo vi phạm 72 h, xoá/trả dữ liệu khi kết thúc (Đ.37); hồ sơ chuyển dữ liệu ra nước ngoài nếu hạ tầng ở nước ngoài (Đ.20) | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật An ninh mạng 116/2025/QH15; NĐ 333/2026/NĐ-CP Đ.19–20 | 01/07/2026; 19/08/2026 | Dịch vụ "lưu trữ, chia sẻ dữ liệu trên không gian mạng", "ứng dụng trực tuyến" thuộc nhóm phải lưu dữ liệu người dùng VN trong nước (DN trong nước bắt buộc; DN nước ngoài khi Bộ Công an yêu cầu), ≥ 24 tháng | Công báo 499 |
| Luật Dữ liệu 60/2024/QH15 + NĐ 165/2025/NĐ-CP | 01/07/2025 | Dữ liệu cốt lõi/quan trọng của tenant (cơ quan nhà nước, hạ tầng) chuyển xuyên biên giới phải đánh giá rủi ro | thuvienphapluat |
| Luật Công nghiệp công nghệ số 71/2025/QH15 | 01/01/2026 | Cấm rào cản kỹ thuật/thương mại ngăn khách hàng lưu dữ liệu hoặc chuyển nhà cung cấp (data portability/exit) | thuvienphapluat 621341 |
| Luật Giao dịch điện tử 20/2023/QH15 | 01/07/2024 | Hợp đồng điện tử, chữ ký điện tử cho hợp đồng dịch vụ | thuvienphapluat 513347 |
| Luật BVQLNTD 19/2023/QH15 | 01/07/2024 | Khi có khách hàng cá nhân: hợp đồng mẫu, điều kiện giao dịch chung | moit.gov.vn |

**Quốc tế (xác minh 2026-10-13):** GDPR Art. 28 (bên xử lý, sub-processor), Art. 32, 33, 44–49 (SCC 2021/914) ·
UK GDPR + DPA 2018 + Data (Use and Access) Act 2025 (c. 18, Royal Assent 19/06/2025, áp dụng theo giai đoạn) · CCPA/CPRA
("service provider" contract) · Singapore PDPA (thông báo vi phạm ≤ 3 ngày lịch) · SOC 2 TSC 2017 (points of focus
2022) · ISO/IEC 27001:2022 (bản 2013 hết chuyển tiếp 31/10/2025), ISO/IEC 27017/27018 (cloud), ISO/IEC 27701:2025 ·
EU Data Act 2023/2854 (áp dụng 12/09/2025: chuyển đổi/thoát dịch vụ xử lý dữ liệu) · DORA 2022/2554 khi khách hàng là
tổ chức tài chính EU (ICT third-party) · NIS2 2022/2555.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Tenant** (`id, slug, region, plan, status, data_residency, kms_key_id, created_at, deleted_at, purge_after`),
  **Membership** (user × tenant × role), **Entitlement** (feature, limit, period), **Subscription/Invoice**,
  **AuditLog** (tenant-scoped, export được), **ApiKey** (hash, scope, tenant), **Webhook endpoint** (tenant, secret).
- **Mọi bảng nghiệp vụ có `tenant_id NOT NULL`** và chỉ số composite `(tenant_id, …)`; RLS policy
  `tenant_id = current_setting('app.tenant_id')`.
- **Vòng đời tenant:** `trial → active → past_due → suspended → cancelled → purged` (sau thời gian giữ, vd 30 ngày, có xuất dữ liệu).
- **Tenant lớn:** sharding theo tenant hoặc DB riêng; metadata chung ở control plane.

## Ca biên nghiệp vụ

1. **Rò dữ liệu chéo tenant qua truy vấn thiếu `tenant_id`** (JOIN bảng phụ, báo cáo, search index, cache key):
   RLS là lưới an toàn, nhưng index/cache nằm ngoài DB phải có tiền tố tenant.
2. **Người dùng thuộc nhiều tenant** đổi ngữ cảnh: token/session phải mang `tenant_id` hiện tại; không dùng `user_id`
   một mình để tra dữ liệu.
3. **Xoá tenant:** xoá mềm + thời gian giữ để khách hàng xuất; sau đó purge **mọi** kho (DB, storage, index, cache,
   backup qua huỷ khoá, log có PII, sub-processor) và trả bằng chứng xoá.
4. **Noisy neighbor:** một tenant chạy export 10 GB/ job nặng → hàng đợi fair-share, quota, cô lập worker pool; không
   để p95 của tenant khác vượt SLO.
5. **Migration schema trên 10.000 tenant/ shard:** phải online, lùi được, chạy theo lô; schema riêng từng tenant thì
   migration là vòng lặp có checkpoint.
6. **Tenant đổi vùng cư trú (VN → SG)** hay yêu cầu "dữ liệu phải ở VN": di chuyển dữ liệu có kiểm chứng và hồ sơ
   chuyển dữ liệu xuyên biên giới.
7. **Hạ cấp gói khi vượt hạn mức** (đang dùng 50 ghế, gói mới 10): không khoá dữ liệu; chỉ chặn tạo mới + cảnh báo.
8. **Impersonation của support** vào tenant: có lý do, giới hạn thời gian, tenant admin thấy trong audit log.
9. **Webhook của tenant chết/chậm:** retry lũy thừa có giới hạn, DLQ theo tenant, không chặn tenant khác.
10. **Thanh toán thất bại → `past_due`:** thời gian ân hạn, chỉ đọc trước khi tạm ngưng; không xoá dữ liệu.
11. **SSO của tenant sai cấu hình (IdP đổi chứng chỉ):** luồng khôi phục cho tenant admin không qua SSO (break-glass có MFA).
12. **Rate limit theo API key chung cho cả tenant** → một key chạy hết hạn mức: hạn mức theo key và theo tenant.

## Checklist

- [ ] `IND-SAAS-001` **MUST** Mọi bảng nghiệp vụ có `tenant_id NOT NULL`; Row-Level Security (hoặc tương đương) bật mặc định và kết nối ứng dụng không có quyền bỏ qua RLS. → Kiểm: test lint schema (bảng thiếu `tenant_id` → fail); test tích hợp: đặt ngữ cảnh tenant A truy vấn id của tenant B → 0 dòng; vai DB ứng dụng không `BYPASSRLS`. · Nguồn: ASVS 5.0 V8; [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md)
- [ ] `IND-SAAS-002` **MUST** Ngữ cảnh tenant lấy từ token/phiên đã xác thực (claim), không từ tham số client; mọi handler kiểm quyền theo (user, tenant, role). → Kiểm: test E2E đổi `tenant_id` trong body/URL sang tenant khác → 403/404; không có endpoint nhận `tenant_id` thô. · Nguồn: OWASP Top 10 A01 (Broken Access Control); ASVS 5.0 V8
- [ ] `IND-SAAS-003` **MUST** Cache key, search index, object storage path, queue message đều mang tiền tố/trường tenant; kiểm tra tenant khi đọc lại. → Kiểm: grep/lint khoá cache phải bắt đầu bằng `t:{tenant_id}`; test index trả kết quả lọc theo tenant. · Nguồn: thực hành nội bộ
- [ ] `IND-SAAS-004` **MUST** Test rò dữ liệu chéo tenant tự động (cross-tenant access suite) chạy trong CI cho mọi endpoint đọc/ghi: tạo 2 tenant, cố gắng truy cập chéo bằng mọi vai. → Kiểm: bộ test tồn tại và sinh từ danh sách route (route mới không có test → fail). · Nguồn: ASVS 5.0 V8; OWASP API Top 10 API1 (BOLA)
- [ ] `IND-SAAS-005` **MUST** Mã hoá dữ liệu nghỉ với khoá (hoặc data key) riêng từng tenant tại KMS; xoá tenant = huỷ khoá (crypto-shredding) kể cả backup. → Kiểm: bảng `tenant.kms_key_id`; test huỷ khoá → đọc object/backup thất bại. · Nguồn: GDPR Art. 32; Luật 91/2025/QH15 Đ.12, Đ.14
- [ ] `IND-SAAS-006` **MUST** Vòng đời xoá tenant: xoá mềm + thời gian giữ công bố có xuất dữ liệu; sau đó purge mọi kho (DB, storage, index, cache, log PII, sub-processor) trong thời hạn hợp đồng và cấp chứng nhận xoá. → Kiểm: test E2E xoá tenant → sau job purge, truy vấn từng kho = rỗng; mẫu chứng nhận xoá. · Nguồn: GDPR Art. 28(3)(g); Luật 91/2025/QH15 Đ.37
- [ ] `IND-SAAS-007` **MUST** Khách hàng xuất được toàn bộ dữ liệu của mình ở định dạng mở (JSON/CSV + file) tự phục vụ; không có rào cản kỹ thuật/thương mại khi chuyển nhà cung cấp. → Kiểm: endpoint/job export có test; tài liệu định dạng công khai. · Nguồn: Luật 71/2025/QH15 (cấm rào cản chuyển nhà cung cấp); GDPR Art. 20; EU Data Act 2023/2854
- [ ] `IND-SAAS-008` **MUST** Hạn mức và rate limit theo tenant **và** theo API key; hàng đợi job fair-share; worker pool/quota ngăn một tenant chiếm toàn bộ. → Kiểm: test tải: tenant A bão hoà hạn mức, p95 của tenant B vẫn trong SLO; cấu hình quota theo gói có trong repo. · Nguồn: [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md)
- [ ] `IND-SAAS-009` **MUST** Audit log theo tenant (ai, làm gì, khi nào, từ đâu) bất biến, tenant admin xem/xuất được; impersonation của nhân viên hỗ trợ có lý do, giới hạn thời gian và hiển thị cho tenant. → Kiểm: test impersonation tạo sự kiện audit thấy được bởi tenant admin; log append-only; xem [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md). · Nguồn: SOC 2 TSC CC6, CC7; ASVS 5.0 V16
- [ ] `IND-SAAS-010` **MUST** Hợp đồng xử lý dữ liệu (DPA) mẫu với danh sách sub-processor công khai, thông báo thay đổi trước ≥ 30 ngày, cam kết thông báo vi phạm (≤ 72 h VN/EU; ≤ 3 ngày lịch SG), vị trí lưu trữ. → Kiểm: `docs/legal/DPA.md` + trang sub-processor có phiên bản; runbook sự cố có SLA thông báo khách hàng. · Nguồn: GDPR Art. 28; Luật 91/2025/QH15 Đ.17, Đ.23, Đ.37; PDPA SG s.26D
- [ ] `IND-SAAS-011` **MUST** Cư trú dữ liệu: `tenant.region` quyết định cụm/vùng lưu; tenant VN (DN trong nước) lưu trong nước theo NĐ 333/2026 Đ.19; hạ tầng nước ngoài nằm trong hồ sơ chuyển dữ liệu. → Kiểm: policy IaC chặn tạo kho ngoài vùng cho tenant có `data_residency`; data map có `region`. · Nguồn: NĐ 333/2026/NĐ-CP Đ.19–20; Luật 91/2025/QH15 Đ.20
- [ ] `IND-SAAS-012` **MUST@M** SSO (OIDC/SAML) + SCIM cho tenant; MFA bắt buộc cho tenant admin và nhân viên nội bộ; khôi phục khi IdP hỏng qua break-glass có MFA và audit. → Kiểm: test E2E SSO + SCIM deprovision thu hồi phiên ≤ 5 phút; xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md). · Nguồn: ASVS 5.0 V6; SOC 2 CC6.1
- [ ] `IND-SAAS-013` **MUST@M** SLO công bố theo gói (uptime, p95 API) với dashboard theo tenant; status page; cảnh báo theo error budget. → Kiểm: SLO trong `docs/ops/slo.md`; alert đã kích hoạt thử; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: SOC 2 A1 (Availability)
- [ ] `IND-SAAS-014` **MUST@M** Migration schema online, lùi được, chạy theo lô/tenant có checkpoint; không khoá bảng dài; diễn tập trên bản sao production trước khi áp. → Kiểm: checklist migration + log diễn tập; xem [`../09-database/migrations.md`](../09-database/migrations.md). · Nguồn: thực hành nội bộ
- [ ] `IND-SAAS-015` **MUST@M** Backup/khôi phục có thể **theo từng tenant** (point-in-time hoặc export) với RPO/RTO công bố; diễn tập khôi phục một tenant ≥ 2 lần/năm. → Kiểm: biên bản diễn tập; thời gian đo. · Nguồn: SOC 2 A1.2; [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md)
- [ ] `IND-SAAS-016` **MUST@L** Bằng chứng tuân thủ độc lập: SOC 2 Type II hoặc ISO/IEC 27001:2022 (± 27701:2025) với phạm vi gồm hệ thống SaaS; trust center công khai kiểm soát, pentest hằng năm. → Kiểm: báo cáo/chứng chỉ còn hạn; xem [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md). · Nguồn: AICPA TSP 100; ISO/IEC 27001:2022
- [ ] `IND-SAAS-017` **SHOULD** Feature flag/entitlement theo tenant kiểm ở server; hạ cấp gói không khoá dữ liệu, chỉ chặn tạo mới và cảnh báo. → Kiểm: test hạ gói → đọc được, tạo mới bị chặn. · Nguồn: Luật BVQLNTD 19/2023/QH15 (khi khách cá nhân)
- [ ] `IND-SAAS-018` **SHOULD** API có phiên bản, chính sách deprecation ≥ 6 tháng với header cảnh báo, changelog công khai; webhook ra ngoài ký HMAC, retry có giới hạn, DLQ theo tenant. → Kiểm: contract test phiên bản cũ; test webhook retry; xem [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md). · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `IND-SAAS-019` **SHOULD** Chi phí hạ tầng gán theo tenant (tag/label), cảnh báo tenant vượt ngưỡng chi phí so với doanh thu gói. → Kiểm: báo cáo cost-per-tenant hằng tháng; xem [`../15-operations/cost-management.md`](../15-operations/cost-management.md). · Nguồn: thực hành FinOps
- [ ] `IND-SAAS-020` **SHOULD** Triển khai theo vòng (canary theo tenant nội bộ → % tenant → tất cả) với rollback tự động theo SLO. → Kiểm: pipeline có giai đoạn canary + tiêu chí; xem [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md). · Nguồn: thực hành SRE
- [ ] `IND-SAAS-021` **SHOULD** Dữ liệu người dùng cuối của tenant chỉ dùng cho mục đích cung cấp dịch vụ; không huấn luyện model/phân tích chéo tenant nếu không có đồng ý ghi trong hợp đồng. → Kiểm: data map ghi mục đích; flag `training_opt_in` theo tenant. · Nguồn: GDPR Art. 28(3)(a); Luật 91/2025/QH15 Đ.37
- [ ] `IND-SAAS-022` **MAY** Cho tenant quản lý khoá riêng (BYOK/HYOK). → Kiểm: tài liệu + test xoay khoá. · Nguồn: ISO/IEC 27018
- [ ] `IND-SAAS-023` **MAY** Cung cấp audit log streaming (SIEM) cho tenant enterprise. → Kiểm: endpoint/integration có test. · Nguồn: SOC 2 CC7.2
- [ ] `IND-SAAS-024` **SHOULD** Thành phần AI có **trạng thái thích nghi lúc chạy** (prior/hiệu chỉnh theo batch, ngưỡng động, hạn mức leo thang, semantic cache, memory bank) được khoá theo tenant (mỗi tenant một instance/khoá trạng thái) hoặc dùng cấu hình cố định (vd `prior=none`); không chia sẻ trạng thái giữa tenant. → Kiểm: test tenant A gửi 100 request lệch nhãn → đầu ra của tenant B cho cùng input không đổi (so trước/sau). · Nguồn: `seeker19110/stored` 17 §2c.5 (AnyJev: prior batch là trạng thái theo tiến trình; hệ đa tenant nên tách `Decider` theo tenant hoặc dùng `content_free`/`none`; đọc 2026-10-16)

## Cổng chất lượng tương đương

| Cổng chung | Tương đương SaaS | Ngưỡng |
|---|---|---|
| Bảo mật | Cross-tenant test suite 100% route; ASVS 5.0 L2; pentest/năm | CI + báo cáo |
| Hiệu năng | p95 API theo gói; noisy-neighbor test: tenant B không vượt SLO khi A bão hoà | k6 |
| Tin cậy | Uptime theo SLO; diễn tập khôi phục một tenant | biên bản |
| Tuân thủ | DPA + sub-processor list + bằng chứng xoá tenant; SOC 2/ISO (L) | trust center |
| Phát hành | Canary theo tenant, rollback tự động | pipeline |

## Bẫy

- **Lọc tenant ở tầng ứng dụng, không ở DB** → một truy vấn quên `WHERE` là rò toàn bộ.
- **Search index/cache dùng chung không tiền tố** → rò qua autocomplete.
- **Xoá tenant chỉ xoá DB** → storage, index, backup, analytics vẫn còn.
- **Hạn mức theo API key** nhưng tenant tạo 100 key.
- **Migration "chạy một lần"** trên hàng nghìn schema → nửa chừng lỗi, không checkpoint.
- **Impersonation không log** → không chứng minh được với khách hàng/kiểm toán.
- **Hợp đồng nói "dữ liệu ở VN"** nhưng log/analytics/LLM ở nước ngoài.
- **SOC 2 Type I rồi dừng**: khách hàng doanh nghiệp yêu cầu Type II định kỳ.
- **Thành phần AI "tự học" dùng chung giữa tenant** (prior hiệu chỉnh, ngưỡng động, semantic cache, memory bank) → request của tenant A làm đổi đầu ra của tenant B; vừa rò dữ liệu vừa không tái lập được. Khoá theo tenant hoặc cố định (`IND-SAAS-024`).

## Nguồn

- Luật BVDLCN 91/2025/QH15 và NĐ 356/2025/NĐ-CP (thay NĐ 13/2023/NĐ-CP từ 01/01/2026): xem nguồn tại [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) — xác minh 2026-10-13.
- NĐ 333/2026/NĐ-CP (19/08/2026) Đ.19–20, Công báo 499: <https://congbaocdn.chinhphu.vn/180507251028987904/2026/9/4/470335-1787890927_v1_1788486330_signed.pdf> — xác minh 2026-10-13.
- Luật Công nghiệp công nghệ số 71/2025/QH15 (hiệu lực 01/01/2026): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-Cong-nghiep-cong-nghe-so-2025-so-71-2025-QH15-621341.aspx> — xác minh 2026-10-13.
- GDPR Art. 28, 32, 33: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — xác minh gián tiếp 2026-10-13 (EUR-Lex không trả nội dung qua công cụ).
- UK Data (Use and Access) Act 2025 c. 18: <https://www.legislation.gov.uk/ukpga/2025/18/contents> — xác minh 2026-10-13.
- Singapore PDPC — thông báo vi phạm 3 ngày lịch, mức phạt 10%/S$1M từ 01/10/2022: <https://www.pdpc.gov.sg/report-data-breach/before-you-report-a-data-breach-3/info> — xác minh 2026-10-13.
- AICPA SOC 2 TSC 2017 (revised points of focus 2022): <https://www.aicpa-cima.com/> — (chưa xác minh trực tiếp tài liệu TSP 100 ngày 2026-10-13; xác nhận qua nguồn thứ cấp).
- ISO/IEC 27001:2022 (hết chuyển tiếp 31/10/2025): <https://www.iso.org/standard/27001>; ISO/IEC 27701:2025: <https://www.iso.org/standard/27701> — xác minh 2026-10-13.
- EU Data Act 2023/2854 (áp dụng 12/09/2025); DORA 2022/2554 (17/01/2025); NIS2 2022/2555 — xác minh gián tiếp 2026-10-13 qua nguồn thứ cấp.
- OWASP ASVS 5.0.0: <https://github.com/OWASP/ASVS/releases> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 17 §2c.5 (AnyJev: prior batch theo tiến trình, tách theo tenant) — đọc 2026-10-16.
