---
title: Gói ngành
kind: index
updated: 2026-10-14
---

# 03 — Gói ngành

> Chọn **0..n** gói ngành khi `compose` (vd ví điện tử cho bệnh viện = `fintech` + `healthcare`). Mỗi gói = **khung
> pháp lý** (Việt Nam + quốc tế, số hiệu + ngày hiệu lực + nguồn, xác minh 2026-10-13) + **mô hình nghiệp vụ** + **ca biên**
> + **checklist đặc thù** (prefix `IND-*`) + `modules` kéo thêm module khung cần cho ngành. Ngành bị quản lý (fintech,
> healthcare, government) mặc định quy mô **L**. Luật Việt Nam đổi nhanh trong 2025–2026 (Luật 91/2025 + NĐ 356/2025 thay
> NĐ 13/2023; Luật ANM 2025 + NĐ 333/2026 thay Luật 2018 + NĐ 53/2022; Luật TMĐT 2025; Luật AI 2025) — **kiểm tra văn bản
> sửa đổi/thay thế trước khi áp dụng**.

| Slug | Ngành | Luật/chuẩn chính (VN · quốc tế) | Đọc khi nào |
|---|---|---|---|
| `fintech` | [Tài chính · thanh toán · ví điện tử](fintech.md) | NĐ 52/2024, TT 40/2024 (+41/2025), TT 50/2024, Luật PCRT 14/2022, NĐ 94/2025, NĐ 70/2025 · PCI DSS 4.0.1, PSD2/SCA, DORA, FATF, EMV 3DS | Chạm tiền thật, thẻ, ví, KYC/AML, ledger, đối soát |
| `healthcare` | [Y tế · sức khoẻ · dữ liệu bệnh nhân](healthcare.md) | Luật KBCB 15/2023, TT 13/2025 (EMR), NĐ 102/2025, QĐ 130/QĐ-BYT · HIPAA, EHDS, MDR/IEC 62304, FHIR | Dữ liệu sức khoẻ, bệnh án, kê đơn, BHYT, AI lâm sàng |
| `education` | [Giáo dục · edtech · trẻ em](education.md) | Luật Trẻ em 2016 + NĐ 56/2017, Luật 91/2025 Đ.24, NĐ 147/2024, Luật GD sửa đổi 123/2025 · FERPA, COPPA 2025, LTI 1.3 | Người học < 16, học bạ/điểm, LMS, AI gia sư |
| `ecommerce` | [Thương mại điện tử · bán lẻ · marketplace](ecommerce.md) | Luật TMĐT 122/2025 + NĐ 248/2026, Luật BVQLNTD 19/2023, NĐ 70/2025, NĐ 117/2025 + 68/2026, Luật Quảng cáo 75/2025 · CRD, DSA, EAA | Giỏ/đơn/tồn kho/khuyến mãi, sàn nhiều người bán, livestream |
| `government` | [Chính phủ · dịch vụ công · khu vực công](government.md) | NĐ 42/2022, NĐ 118/2025, TT 21/2023, Khung KT CPS 4.0 (QĐ 292/QĐ-BKHCN), Luật Căn cước + NĐ 69/2024, Luật Lưu trữ 33/2024, Luật ANM 2025 (cấp độ) · EN 301 549, eIDAS 2.0, NIST 800-63-4 | Chủ quản là cơ quan nhà nước, DVC, CSDL quốc gia, bán cho khu vực công |
| `saas-multitenant` | [SaaS B2B đa tenant](saas-multitenant.md) | Luật 91/2025 Đ.37 (bên xử lý), NĐ 333/2026 Đ.19, Luật CNCNS 71/2025 (chuyển nhà cung cấp) · GDPR Art. 28, SOC 2, ISO 27001/27701, Data Act | Nhiều tổ chức dùng chung hạ tầng, DPA, tenant isolation |
| `media-content` | [Truyền thông · nội dung · xuất bản · UGC](media-content.md) | NĐ 147/2024, Luật Báo chí 126/2025, Luật ANM 2025 Đ.16, Luật Quảng cáo 75/2025, Luật AI 2025 (nhãn AI), NĐ 174/2026 · DSA, UK OSA, DMCA | Xuất bản, UGC, kiểm duyệt, livestream, đề xuất nội dung |
| `logistics` | [Logistics · vận tải · chuỗi cung ứng](logistics.md) | NĐ 163/2017, Luật Đường bộ 35/2024 + NĐ 158/2024 (+218/2026), NĐ 151/2024 (GSHT), Luật Bưu chính 2010, NĐ 34/2024, Luật Hải quan (sửa 2025/2026) · Incoterms 2020, GS1 | Điều phối hàng/xe/người giao, tracking, kho, hải quan |

## Cách dùng

```bash
python3 .xtemplates/scripts/xt.py list industries
python3 .xtemplates/scripts/xt.py compose --profile web-app --industry fintech --industry healthcare --scale L --out BLUEPRINT.md
```

- `modules` của mỗi gói kéo thêm module khung (vd `16-compliance-privacy/*`, `09-database/transactions-and-consistency`);
  trùng với hồ sơ thì máy bỏ trùng.
- Mục không áp dụng → `[~] — Miễn: <lý do>` trong blueprint (vd fintech chỉ nhúng PSP: `Miễn: SAQ A`).
- Nghĩa vụ pháp lý chung về dữ liệu cá nhân nằm ở [`../16-compliance-privacy/`](../16-compliance-privacy/README.md); gói
  ngành chỉ nêu điều khoản ngành và trỏ tới đó.
