---
title: Tài chính · thanh toán · ví điện tử
kind: industry
slug: fintech
prefix: IND-FIN
modules: [12-security/*, 16-compliance-privacy/*, 09-database/transactions-and-consistency, 09-database/sensitive-data-and-access, 09-database/backup-and-recovery, 08-backend/authn-authz, 08-backend/integrations-and-webhooks, 08-backend/background-jobs-and-queues, 08-backend/reliability-and-errors, 18-cross-cutting/units-time-and-money, 14-testing-quality/unit-and-logic-edge-cases, 14-testing-quality/integration-and-contract, 15-operations/incident-response, 15-operations/slo-and-alerting, 15-operations/backup-and-disaster-recovery]
updated: 2026-10-14
---

# Gói ngành: Tài chính · thanh toán · ví điện tử

> Ghép cho sản phẩm chạm tới **tiền thật**: cổng thanh toán, ví điện tử, trung gian thanh toán, cho vay/BNPL, đầu tư,
> ngân hàng số, kế toán/hoá đơn, tài sản mã hoá. Ngành bị quản lý → quy mô mặc định **L**. Tiền là số nguyên, sổ cái
> bút toán kép, mọi thao tác idempotent, đối soát hằng ngày, PCI scope nhỏ nhất, KYC/AML theo luật.

## Khi nào dùng

Dùng khi hệ thống **giữ, chuyển, ghi nhận hoặc quyết định về tiền** của người khác, hoặc chạm dữ liệu thẻ/tài khoản
ngân hàng. Chỉ nhúng nút thanh toán của PSP (Stripe/VNPay/MoMo…) và không chạm số thẻ → vẫn ghép gói này nhưng được
miễn phần lớn mục PCI (ghi `[~] — Miễn: SAQ A`). Kết hợp `ecommerce` cho sàn, `healthcare` cho thanh toán viện phí.

## Kiến trúc tham chiếu

```text
[Client] → [API gateway + WAF + rate limit] → [Service nghiệp vụ]
                                               ├─ Ledger service (append-only, bút toán kép, số nguyên)
                                               ├─ Payment orchestrator (idempotency key, state machine, outbox)
                                               ├─ KYC/AML service (eKYC, sanction screening, giám sát giao dịch)
                                               └─ Reconciliation job (đối soát PSP/ngân hàng theo ngày)
[PSP / ngân hàng / NAPAS] ⇄ webhook (ký, idempotent) ⇄ [Outbox/Queue] → [Ledger]
Dữ liệu thẻ: KHÔNG đi qua hệ thống (token hoá tại PSP) → PCI scope = SAQ A/A-EP
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú/khi nào khác |
|---|---|---|
| Kiểu tiền | Số nguyên đơn vị nhỏ nhất (VND không có xu → đơn vị = đồng; USD = cent) + mã tiền ISO 4217 | Không dùng float/double ở bất kỳ tầng nào; xem [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md) |
| Sổ cái | Bảng `journal_entries` + `postings` append-only, tổng debit = credit trong một giao dịch CSDL | Số dư là **dẫn xuất** (materialized), không phải cột sửa tay |
| Thanh toán | PSP có token hoá + 3-D Secure (EMV 3DS 2.3.1.1, xác minh EMVCo 2026-10-13; bản 2.4.0.0 mới ở dạng dự thảo) | Chỉ tự xử lý PAN khi là tổ chức được cấp phép |
| Chuẩn thông điệp | ISO 20022 cho liên ngân hàng (SWIFT MT/MX kết thúc giai đoạn song song 22/11/2025); ISO 8583 cho thẻ | Nội địa VN theo đặc tả NAPAS/ngân hàng |
| Bảo mật ứng dụng | OWASP ASVS 5.0.0 mức L2–L3 (phát hành 30/05/2025) | Xem [`../12-security/appsec-web.md`](../12-security/appsec-web.md) |
| Xác thực giao dịch | Sinh trắc học/MFA theo TT 50/2024/TT-NHNN; PSD2 SCA ở EU | Ngưỡng theo văn bản hiện hành của NHNN |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| Luật Các tổ chức tín dụng 32/2024/QH15 | 18/01/2024 · 01/07/2024 | Đ.13 bảo mật thông tin khách hàng; điều kiện hoạt động | thuvienphapluat 577203 |
| NĐ 52/2024/NĐ-CP thanh toán không dùng tiền mặt | 15/05/2024 · 01/07/2024 (thay NĐ 101/2012) | Tiền điện tử, ví điện tử, trung gian thanh toán, mở/sử dụng tài khoản | thuvienphapluat 613117 |
| TT 40/2024/TT-NHNN trung gian thanh toán | 17/07/2024 · 17/07/2024 (một số điều muộn hơn) | Ví điện tử: liên kết tài khoản, hạn mức 100 triệu đồng/tháng (Đ.26), tài khoản đảm bảo thanh toán; sửa bởi TT 41/2025/TT-NHNN (hiệu lực 05/11/2025, thanh toán công tới 300 triệu/tháng) | luatvietnam 360680; sbv.gov.vn |
| TT 17/2024/TT-NHNN mở & sử dụng tài khoản thanh toán; TT 18/2024/TT-NHNN thẻ | 28/06/2024 · sinh trắc học bắt buộc với cá nhân từ 01/01/2025, tổ chức từ 01/07/2025 | Đối chiếu giấy tờ + sinh trắc học (chip CCCD/VNeID) trước giao dịch điện tử | lsvn.vn; thuvienphapluat |
| TT 50/2024/TT-NHNN an toàn bảo mật dịch vụ trực tuyến | 31/10/2024 · 01/01/2025 | Mobile Banking không lưu mật khẩu, chống deepfake/mặt nạ 3D, mã hoá PIN/sinh trắc khi lưu (Đ.19), không gửi link qua SMS | sbv.gov.vn |
| Luật Phòng, chống rửa tiền 14/2022/QH15; NĐ 19/2023/NĐ-CP; TT 09/2023/TT-NHNN; QĐ 11/2023/QĐ-TTg | 15/11/2022 · 01/03/2023; NĐ hiệu lực 28/04/2023; TT 28/07/2023 (báo cáo từ 01/12/2023) | Nhận biết khách hàng (KYC), báo cáo giao dịch giá trị lớn ≥ 400 triệu đồng (QĐ 11/2023, từ 01/12/2023), giao dịch đáng ngờ, chuyển tiền điện tử | caselaw 411476; sbv.gov.vn |
| NĐ 94/2025/NĐ-CP sandbox ngân hàng | 29/04/2025 · 01/07/2025 | Thử nghiệm có kiểm soát: chấm điểm tín dụng, Open API, P2P lending; ≤ 2 năm, chỉ trong VN | luatvietnam 399142 |
| NĐ 123/2020/NĐ-CP + NĐ 70/2025/NĐ-CP hoá đơn điện tử | 19/10/2020 · 01/07/2022; NĐ 70: 20/03/2025 · 01/06/2025 | Hoá đơn điện tử có mã, thời điểm lập, nội dung người mua; Luật Kế toán 88/2015/QH13 Đ.41 lưu chứng từ ≥ 10 năm | thuvienphapluat |
| Luật BVDLCN 91/2025/QH15 Đ.27 | 26/06/2025 · 01/01/2026 | Không chấm điểm tín dụng khi chưa có đồng ý; thông báo khi lộ thông tin tài khoản | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật Công nghiệp công nghệ số 71/2025/QH15 | 14/06/2025 · 01/01/2026 | Định nghĩa tài sản số/tài sản mã hoá; điều kiện kinh doanh dịch vụ tài sản mã hoá do Chính phủ quy định | thuvienphapluat 621341 |

**Quốc tế (xác minh 2026-10-13):** PCI DSS v4.0.1 (11/06/2024; v4.0 nghỉ hưu 31/12/2024; yêu cầu "future-dated" bắt
buộc từ 31/03/2025) · PSD2 Directive (EU) 2015/2366 + RTS SCA Delegated Regulation (EU) 2018/389 · PSD3/PSR: thoả thuận
chính trị 27/11/2025, văn bản cuối 23/04/2026, **chưa đăng Công báo EU tính đến 2026-10-13 (chưa xác minh)** · DORA
Regulation (EU) 2022/2554 áp dụng từ 17/01/2025 · FATF 40 Recommendations, R.16 sửa 06/2025 (hiệu lực tới cuối 2030),
R.15 cho VASP · GDPR 2016/679 · ISO 20022 · EMV 3DS 2.3.1.1.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Ledger bút toán kép:** `account(id, type, currency)`, `journal_entry(id, idempotency_key, occurred_at, posted_at,
  status)`, `posting(entry_id, account_id, amount_minor, direction)`; ràng buộc Σdebit = Σcredit per entry; không
  UPDATE/DELETE — sửa bằng bút toán đảo (reversal).
- **Giao dịch thanh toán = state machine:** `created → authorized → captured → settled → (partially_)refunded /
  failed / reversed`; mọi chuyển trạng thái idempotent theo `idempotency_key` của client và `provider_ref` của PSP.
- **Tiền:** `amount_minor BIGINT` + `currency CHAR(3)`; VND đơn vị nhỏ nhất = 1 đồng (ISO 4217 exponent 0).
- **Đối soát:** bảng `settlement_file` (từ PSP/ngân hàng) ↔ `journal_entry`; lệch → `reconciliation_break` có chủ xử lý.
- **KYC/AML:** `customer_due_diligence(level, verified_at, documents)`, `sanction_screen(result, list_version)`,
  `suspicious_activity_report`; dữ liệu giữ theo luật PCRT.
- **Thời gian:** lưu UTC + `business_date` theo múi giờ cắt ngày (VN: UTC+7) cho đối soát/báo cáo.

## Ca biên nghiệp vụ

1. **Hoàn tiền một phần nhiều lần:** tổng các lần hoàn ≤ số đã capture; hai yêu cầu hoàn cùng lúc không được vượt
   (khoá hàng + kiểm tra trong cùng giao dịch CSDL).
2. **Giao dịch trùng do retry/timeout:** client gửi lại cùng `idempotency_key` → trả kết quả cũ; khác key nhưng cùng
   nội dung trong 60 s → cảnh báo trùng (dedupe window).
3. **Webhook PSP đến hai lần, hoặc đến trước phản hồi API:** xử lý idempotent theo `provider_event_id`; trạng thái
   không được lùi (captured không về authorized).
4. **Lệch múi giờ cuối ngày:** giao dịch 23:59:30 UTC+7 thuộc ngày nào trong file đối soát PSP (có thể cắt theo UTC)?
   Phải khai báo `business_date` theo quy ước từng PSP.
5. **Làm tròn phí:** phí 1,5% của 10.001 đ = 150,015 → làm tròn **nửa lên theo đồng** theo hợp đồng và ghi rõ; tổng phí
   theo lô ≠ Σ phí từng giao dịch làm tròn → đối soát phải dung sai 0 bằng cách tính cùng công thức.
6. **Nạp tiền thành công ở ngân hàng nhưng ghi sổ thất bại (crash giữa chừng):** outbox + job bù; không bao giờ ghi có
   (credit) hai lần — kiểm `provider_ref` unique.
7. **Số dư âm do race:** hai lệnh chi cùng lúc trên số dư 100 → dùng `SELECT … FOR UPDATE` hoặc ràng buộc
   `CHECK balance >= 0` trên bảng số dư dẫn xuất; test song song.
8. **Chargeback sau khi đã hoàn tiền:** trạng thái phải cho phép `refunded → chargeback_pending` với bút toán riêng,
   không trừ hai lần.
9. **Hạn mức ví 100 triệu/tháng vượt do giao dịch "pending" chưa tính:** tính hạn mức trên cả pending; test tháng có
   31 ngày và đổi tháng theo UTC+7.
10. **Đổi tiền tệ:** tỷ giá chốt tại thời điểm giao dịch, lưu `fx_rate`, `rate_source`, `rate_at`; làm tròn một lần ở cuối.
11. **Khách hàng bị khoá vì sanction match giả (trùng tên):** cần luồng "review thủ công" với SLA, không tự động chặn vĩnh viễn.
12. **Hoá đơn điện tử lập sai thời điểm** (lập sau 23:59 ngày giao dịch) → vi phạm NĐ 70/2025 Đ.9; job lập hoá đơn phải theo `business_date`.

## Checklist

- [ ] `IND-FIN-001` **MUST** Mọi số tiền lưu/tính bằng số nguyên đơn vị nhỏ nhất kèm mã tiền ISO 4217; cấm kiểu float/double/number cho tiền ở DB, API, UI. → Kiểm: rule lint (Semgrep/ESLint) cấm `float|double|Number(` trong module tiền; schema DB cột `*_minor BIGINT`; test tính phí với 10.001 đ. · Nguồn: ISO 4217; ASVS 5.0 V11
- [ ] `IND-FIN-002` **MUST** Sổ cái bút toán kép append-only: mỗi giao dịch ghi ≥ 2 posting, Σdebit = Σcredit được ràng buộc trong CSDL; sửa sai bằng bút toán đảo. → Kiểm: trigger/constraint hoặc test tích hợp chèn entry lệch bị từ chối; không có quyền UPDATE/DELETE trên bảng posting cho vai ứng dụng. · Nguồn: thực hành kế toán; Luật Kế toán 88/2015/QH13 Đ.41
- [ ] `IND-FIN-003` **MUST** Mọi API tạo/đổi tiền nhận `Idempotency-Key`; cùng key + cùng payload → cùng kết quả, cùng key + khác payload → 409/422; key lưu ≥ 24 giờ. → Kiểm: contract test gửi 2 lần song song, đúng 1 bút toán; test khác payload trả lỗi. · Nguồn: IETF draft Idempotency-Key header; thực hành PSP
- [ ] `IND-FIN-004` **MUST** Webhook từ PSP/ngân hàng được xác minh chữ ký/HMAC + timestamp chống phát lại, xử lý idempotent theo `provider_event_id`, trả 2xx nhanh rồi xử lý qua queue. → Kiểm: test webhook sai chữ ký → 401; cùng event 2 lần → 1 bút toán; xem [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md). · Nguồn: ASVS 5.0 V13
- [ ] `IND-FIN-005` **MUST** Chuyển trạng thái giao dịch qua state machine khai báo; chuyển không hợp lệ bị từ chối và ghi log. → Kiểm: bảng chuyển trạng thái trong code + property test mọi cặp trạng thái không nằm trong bảng đều ném lỗi. · Nguồn: thực hành nội bộ
- [ ] `IND-FIN-006` **MUST** Đối soát hằng ngày với file/API của PSP và ngân hàng; mọi chênh lệch tạo `reconciliation_break` có chủ xử lý và SLA; số dư sổ cái = Σ posting (không trôi). → Kiểm: job đối soát có lịch và metric `recon_breaks_open`; test số dư dẫn xuất = tổng posting trên dữ liệu mẫu. · Nguồn: TT 40/2024/TT-NHNN (đối soát trung gian thanh toán)
- [ ] `IND-FIN-007` **MUST** Dữ liệu thẻ (PAN, CVV, track) không bao giờ chạm hệ thống của mình: token hoá tại PSP (iframe/hosted fields); nếu buộc chạm → đạt PCI DSS v4.0.1 toàn bộ 12 yêu cầu và có QSA/SAQ phù hợp. → Kiểm: quét repo/log/DB bằng regex PAN (Luhn) = 0; tài liệu phạm vi PCI nêu SAQ loại gì; log request không chứa 16 số. · Nguồn: PCI DSS v4.0.1 Req. 3, 4, 6, 12
- [ ] `IND-FIN-008` **MUST** Xác thực mạnh cho giao dịch: MFA/sinh trắc học theo TT 50/2024 & TT 17/2024 (VN) hoặc SCA PSD2 (EU); app không lưu mật khẩu, không gửi link qua SMS. → Kiểm: test E2E giao dịch vượt ngưỡng yêu cầu yếu tố thứ hai; rà cấu hình app không có "remember password"; xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md). · Nguồn: TT 50/2024/TT-NHNN Đ.8, Đ.19; TT 17/2024/TT-NHNN Đ.17; RTS 2018/389
- [ ] `IND-FIN-009` **MUST** KYC trước khi cho giao dịch: định danh khách hàng theo Luật PCRT (eKYC với CCCD gắn chip/VNeID), sàng lọc danh sách cấm vận/PEP, lưu bằng chứng; giám sát giao dịch tạo báo cáo giao dịch giá trị lớn (≥ 400 triệu đồng) và đáng ngờ. → Kiểm: tài khoản chưa KYC không gọi được API chuyển tiền (test); job báo cáo có lịch; bảng `sanction_screen` có `list_version`. · Nguồn: Luật PCRT 14/2022/QH15; TT 09/2023/TT-NHNN; QĐ 11/2023/QĐ-TTg; FATF R.10, R.16
- [ ] `IND-FIN-010` **MUST** Hạn mức theo luật (ví điện tử cá nhân 100 triệu đồng/tháng; 300 triệu cho thanh toán công theo TT 41/2025) được cấu hình tập trung và kiểm cả giao dịch pending. → Kiểm: hạn mức ở file cấu hình có nguồn văn bản; test vượt hạn mức khi có pending. · Nguồn: TT 40/2024/TT-NHNN Đ.26; TT 41/2025/TT-NHNN
- [ ] `IND-FIN-011` **MUST** Nhật ký giao dịch và truy cập tài chính bất biến (append-only/WORM), có thời gian UTC đồng bộ NTP, lưu ≥ 10 năm cho chứng từ kế toán và ≥ 5 năm hồ sơ KYC. → Kiểm: cấu hình retention; log ở kho immutable; xem [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md). · Nguồn: Luật Kế toán 88/2015/QH13 Đ.41; Luật PCRT 14/2022/QH15 (lưu hồ sơ)
- [ ] `IND-FIN-012` **MUST** Mọi phép tính phí/lãi/tỷ giá có quy tắc làm tròn ghi thành code dùng chung (một hàm), kèm test ca biên (0, 1 đồng, số lẻ, tổng lô). → Kiểm: test đơn vị bảng ca biên; không có hai hàm làm tròn khác nhau (grep). · Nguồn: ISO 4217; [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)
- [ ] `IND-FIN-013` **MUST** Thao tác tiền chạy trong giao dịch CSDL có mức cô lập đủ (SERIALIZABLE hoặc khoá hàng) và test song song chứng minh không có số dư âm/chi đôi. → Kiểm: test chạy N worker đồng thời rút trên 1 ví; số dư cuối đúng; xem [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md). · Nguồn: thực hành nội bộ
- [ ] `IND-FIN-014` **MUST@L** Có khả năng khôi phục: RPO ≤ 5 phút, RTO theo SLA ngân hàng đối tác, backup sổ cái mã hoá và diễn tập khôi phục ≥ 2 lần/năm; kế hoạch theo DORA/yêu cầu NHNN khi áp dụng. → Kiểm: biên bản diễn tập, số đo RPO/RTO thực; xem [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md). · Nguồn: DORA 2022/2554 Art. 11–12; TT 50/2024/TT-NHNN
- [ ] `IND-FIN-015` **MUST@L** Tài sản mã hoá/ví số: tuân thủ điều kiện kinh doanh theo Luật 71/2025/QH15 và văn bản hướng dẫn; áp dụng Travel Rule (FATF R.16/R.15) khi chuyển tài sản ảo. → Kiểm: ADR pháp lý + giấy phép; tích hợp Travel Rule có test. · Nguồn: Luật 71/2025/QH15; FATF R.15, R.16
- [ ] `IND-FIN-016` **SHOULD** Hoá đơn điện tử lập đúng thời điểm theo NĐ 70/2025, có mã cơ quan thuế khi thuộc diện, lưu ≥ 10 năm. → Kiểm: job lập hoá đơn theo `business_date`; test ca giao dịch 23:59. · Nguồn: NĐ 123/2020/NĐ-CP Đ.9 (sửa bởi NĐ 70/2025); Luật Kế toán Đ.41
- [ ] `IND-FIN-017` **SHOULD** Phát hiện gian lận theo thời gian thực (velocity, thiết bị, địa lý) với ngưỡng cấu hình và luồng review thủ công; không chặn vĩnh viễn tự động. → Kiểm: metric `fraud_rule_hits`, hàng chờ review có SLA. · Nguồn: PSD2 RTS 2018/389 Art. 18 (TRA); thực hành PSP
- [ ] `IND-FIN-018` **SHOULD** Thông báo khách hàng ngay khi phát hiện lộ thông tin tài khoản/tín dụng; không chấm điểm tín dụng khi chưa có đồng ý riêng. → Kiểm: runbook sự cố có bước thông báo; flag `credit-scoring` gắn consent. · Nguồn: Luật 91/2025/QH15 Đ.27
- [ ] `IND-FIN-019` **SHOULD** Kiểm thử hợp đồng (contract test) với sandbox PSP/ngân hàng trong CI; mọi thay đổi API đối tác có test tái hiện. → Kiểm: job CI gọi sandbox hoặc mock ghi từ bản ghi thật; xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md). · Nguồn: thực hành nội bộ
- [ ] `IND-FIN-020` **SHOULD** Dashboard vận hành tiền: tỷ lệ giao dịch thành công, p95 độ trễ authorize, số break đối soát, số webhook thất bại — cảnh báo theo SLO. → Kiểm: dashboard tồn tại; alert đã kích hoạt thử; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: DORA Art. 10 (phát hiện)
- [ ] `IND-FIN-021` **MAY** Dùng ISO 20022 (pain/pacs/camt) cho tích hợp ngân hàng mới thay định dạng tệp riêng. → Kiểm: schema XSD trong repo + test parse. · Nguồn: ISO 20022; SWIFT kết thúc song song MT/MX 22/11/2025
- [ ] `IND-FIN-022` **MAY** Thử nghiệm sản phẩm mới (chấm điểm tín dụng, Open API, P2P) qua sandbox NĐ 94/2025 thay vì tự vận hành ngoài khung pháp lý. → Kiểm: hồ sơ đăng ký sandbox hoặc ADR giải thích vì sao không cần. · Nguồn: NĐ 94/2025/NĐ-CP

## Cổng chất lượng tương đương

| Cổng chung | Tương đương fintech | Ngưỡng |
|---|---|---|
| Hiệu năng web CWV | p95 authorize ≤ 2 s; p99 ghi sổ ≤ 500 ms; webhook ack ≤ 1 s | Đo bằng k6 + trace |
| Độ phủ test | 100% nhánh của module tiền/ledger/state machine; mutation score ≥ 80% ở module tiền (nâng từ 70% của [`QA-COV-005`](../14-testing-quality/coverage-and-mutation.md)) | Stryker/mutmut |
| Bảo mật | ASVS 5.0 L2 (L3 cho ví/ngân hàng); PCI SAQ đúng loại; pentest độc lập hằng năm | Báo cáo scan + pentest |
| Đúng dữ liệu | Đối soát T+1 = 0 break chưa xử lý quá 24 h; số dư dẫn xuất = Σ posting | Job + alert |
| Phát hành | GO/NO-GO có mục pháp lý (KYC, hạn mức, hoá đơn, ĐGTĐ) ✅ | `blueprint-status --strict` |

## Bẫy

- **Số dư là cột UPDATE** → trôi số, không truy vết. Dùng sổ cái + số dư dẫn xuất.
- **Retry không idempotent ở tầng HTTP client** (axios-retry mặc định) → chi đôi. Bắt buộc key ở mọi POST tiền.
- **Làm tròn ở nhiều nơi** (UI, API, DB) với quy tắc khác nhau → lệch 1 đồng không đối soát được.
- **Tin webhook mà không xác minh chữ ký** hoặc không chống phát lại.
- **Timezone máy chủ = local** → `business_date` sai sau 17:00 UTC.
- **Lưu PAN "chỉ 6 số đầu 4 số cuối"** nhưng log request đầy đủ → vào PCI scope toàn bộ.
- **KYC "sẽ làm sau khi có khách"** → vi phạm PCRT từ giao dịch đầu tiên.
- **Nghĩ PSD3 đã áp dụng:** tới 2026-10-13 chưa đăng Công báo EU; vẫn PSD2 + RTS SCA.

## Nguồn

- Luật Các tổ chức tín dụng 32/2024/QH15 (18/01/2024, hiệu lực 01/07/2024): <https://thuvienphapluat.vn/van-ban/tien-te-ngan-hang/luat-cac-to-chuc-tin-dung-32-2024-qh15-577203.aspx> — xác minh 2026-10-13.
- NĐ 52/2024/NĐ-CP (15/05/2024, hiệu lực 01/07/2024): <https://thuvienphapluat.vn/van-ban/Tien-te-Ngan-hang/Decree-52-2024-ND-CP-regulations-on-cashless-payments-613117.aspx>; TT 40/2024/TT-NHNN (17/07/2024): <https://luatvietnam.vn/tai-chinh/thong-tu-40-2024-tt-nhnn-2024-hoat-dong-cung-ung-dich-vu-trung-gian-thanh-toan-360680-d1.html>; TT 41/2025/TT-NHNN (hiệu lực 05/11/2025): <https://luatvietnam.vn/linh-vuc-khac/tong-hop-diem-moi-thong-tu-41-2025-tt-nhnn-ve-vi-dien-tu-883-106022-article.html> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- TT 50/2024/TT-NHNN (31/10/2024, hiệu lực 01/01/2025): <https://sbv.gov.vn/en/w/sbv622877>; TT 17/2024/TT-NHNN & TT 18/2024/TT-NHNN: <https://lsvn.vn/bat-buoc-xac-thuc-sinh-trac-hoc-doi-voi-moi-giao-dich-chuyen-tien-tu-01-01-2025-a151500.html> — xác minh 2026-10-13 (nguồn thứ cấp cho TT 17/18).
- Luật Phòng, chống rửa tiền 14/2022/QH15 (15/11/2022, hiệu lực 01/03/2023): <https://caselaw.vn/van-ban-phap-luat/411476-luat-phong-chong-rua-tien-so-14-2022-qh15-ngay-15-11-2022-cua-quoc-hoi>; TT 09/2023/TT-NHNN (28/07/2023): <https://caselaw.vn/van-ban-phap-luat/413201-thong-tu-so-09-2023-tt-nhnn-ngay-28-07-2023-cua-thong-doc-ngan-hang-nha-nuoc-viet-nam-huong-dan-thuc-hien-luat-phong-chong-rua-tien>; QĐ 11/2023/QĐ-TTg ngưỡng 400 triệu (từ 01/12/2023) — xác minh 2026-10-13; (chưa xác minh) điều khoản thời hạn lưu hồ sơ KYC 5 năm — không đối chiếu được toàn văn ngày 2026-10-13.
- NĐ 94/2025/NĐ-CP (29/04/2025, hiệu lực 01/07/2025): <https://luatvietnam.vn/tai-chinh/nghi-dinh-942025nd-cp-co-che-thu-nghiem-co-kiem-soat-trong-linh-vuc-ngan-hang-399142-d1.html> — xác minh 2026-10-13.
- NĐ 123/2020/NĐ-CP và NĐ 70/2025/NĐ-CP (20/03/2025, hiệu lực 01/06/2025): <https://thuvienphapluat.vn/hoi-dap-phap-luat/diem-moi-ve-dang-ky-su-dung-hoa-don-dien-tu-theo-nghi-dinh-70-138046958.html>; Luật Kế toán 88/2015/QH13 Đ.41: <https://hethongphapluat.com/luat-ke-toan-2015/dieu-41> — xác minh 2026-10-13.
- Luật Công nghiệp công nghệ số 71/2025/QH15 (14/06/2025, hiệu lực 01/01/2026): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-Cong-nghiep-cong-nghe-so-2025-so-71-2025-QH15-621341.aspx> — xác minh 2026-10-13.
- PCI DSS v4.0.1 (11/06/2024): <https://blog.pcisecuritystandards.org/just-published-pci-dss-v4-0-1> và <https://www.pcisecuritystandards.org/document_library/> — xác minh 2026-10-13.
- OWASP ASVS 5.0.0 (30/05/2025): <https://github.com/OWASP/ASVS/releases> — xác minh 2026-10-13.
- EMV 3-D Secure 2.3.1.1 (bản 2.4.0.0 dự thảo 03/06/2026): <https://www.emvco.com/emv-technologies/3-d-secure/> — xác minh 2026-10-13.
- PSD2 2015/2366 và RTS SCA 2018/389: <https://eur-lex.europa.eu/eli/reg_del/2018/389/oj> — xác minh gián tiếp 2026-10-13 (EUR-Lex không trả nội dung qua công cụ); PSD3/PSR trạng thái: <https://www.williamfry.com/knowledge/psd3-psr-final-compromise-texts-are-published/> — 2026-10-13 (chưa xác minh đăng Công báo).
- DORA Regulation (EU) 2022/2554 (áp dụng 17/01/2025): <https://eur-lex.europa.eu/eli/reg/2022/2554/oj> — xác minh gián tiếp 2026-10-13.
- FATF Recommendation 16 (sửa 06/2025): <https://www.fatf-gafi.org/en/publications/Fatfrecommendations/update-Recommendation-16-payment-transparency-june-2025.html> — xác minh 2026-10-13.
- ISO 20022 / kết thúc song song MT-MX 22/11/2025: <https://www.swift.com/> — xác minh 2026-10-13 (qua trang Swift).
- Nghiên cứu nền: `research/2026-10-13-stored-catalog-extraction.md` §2.16 (SePay VietQR: HMAC + idempotent).
