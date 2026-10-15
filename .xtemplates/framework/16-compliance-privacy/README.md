---
title: Tuân thủ & quyền riêng tư
kind: index
updated: 2026-10-14
---

# 16 — Tuân thủ & quyền riêng tư

> "Nhà" của **pháp luật và quyền riêng tư** trong khung: thiết kế riêng tư, luật Việt Nam, luật quốc tế, quy định AI,
> đồng ý & quyền người dùng, hồ sơ/bằng chứng tuân thủ, license/IP. Kiểm soát kỹ thuật trên dữ liệu nhạy cảm nằm ở
> [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md); mối đe doạ AI ở
> [`../12-security/ai-security.md`](../12-security/ai-security.md). Mọi văn bản/chuẩn ghi số hiệu + ngày hiệu lực + nguồn,
> xác minh 2026-10-13; **luật Việt Nam thay đổi lớn 2025–2026** (Luật 91/2025/QH15 + NĐ 356/2025 thay NĐ 13/2023 từ
> 01/01/2026; Luật ANM 116/2025 + NĐ 333/2026; Luật AI 134/2025 + NĐ 142/2026; NĐ 330/2026 xử phạt) — kiểm tra văn bản
> sửa đổi/thay thế trước khi áp dụng.
>
> **Mức trong blueprint không phải miễn trừ pháp lý.** Ở quy mô M mỗi module chỉ giữ 4 MUST (ADR-0004); nghĩa vụ luật khác mang
> `MUST@L` nên hiện là SHOULD. Khi điều kiện của luật áp dụng cho dự án (có dữ liệu trẻ em, chuyển dữ liệu ra nước ngoài, người
> dùng EU…), coi mục đó là bắt buộc; bỏ qua chỉ khi ghi được căn cứ "không áp dụng" (vd `— Miễn: không xử lý dữ liệu trẻ em`).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`privacy-by-design.md`](privacy-by-design.md) | Data map, tối thiểu hoá, mục đích, retention, xoá lan mọi kho, crypto-shredding, DPIA, PII trong log/LLM | G3–G4 khi thiết kế bất kỳ tính năng chạm dữ liệu người dùng; trước khi thêm SDK/LLM |
| [`vietnam-data-law.md`](vietnam-data-law.md) | Luật 91/2025 + NĐ 356/2025 (đồng ý, ĐGTĐ 60 ngày, chuyển xuyên biên giới, vi phạm 72 h, trẻ em, ngành), NĐ 330/2026 phạt, Luật ANM 2025 + NĐ 333/2026 (cấp độ, lưu trữ trong nước, log 12 tháng), Luật Dữ liệu, GDĐT, NĐ 147/2024 | G2 khi có người dùng tại Việt Nam; trước khi dùng cloud/SaaS/LLM nước ngoài; G7 trước phát hành |
| [`international-privacy.md`](international-privacy.md) | GDPR, UK GDPR/DUAA 2025, CCPA/CPRA (regs 2025), PDPA SG/TH, DORA/NIS2/EHDS; bảng so sánh thời hạn; SCC/TIA | Khi có người dùng/khách hàng/máy chủ ngoài VN; mở thị trường mới |
| [`ai-regulation.md`](ai-regulation.md) | Luật AI 134/2025 + NĐ 142/2026 (phân loại cao/trung bình/thấp, nhãn AI, sự cố 72 h/5 ngày), EU AI Act + Omnibus 2026/1744 (high-risk 02/12/2027), ISO 42001, NIST AI RMF | Bất kỳ tính năng dùng model/LLM/quyết định tự động |
| [`consent-and-user-rights.md`](consent-and-user-rights.md) | Bản ghi đồng ý, banner/cookie gating, rút đồng ý, DSAR (truy cập/xoá/di chuyển) có SLA, trẻ em (< 16, ≥ 7), GPC/"không theo dõi", ADMT | Khi xây đăng ký, onboarding, tracking, trung tâm quyền riêng tư |
| [`records-and-audit-readiness.md`](records-and-audit-readiness.md) | Ma trận control, kho bằng chứng tự sinh, audit trail bất biến, rà quyền, chính sách có owner, nhà cung cấp, đào tạo, SOC 2/ISO 27001/PCI/hồ sơ VN | Khi khách hàng đòi bằng chứng, chuẩn bị kiểm toán, G8 vận hành |
| [`licensing-and-ip.md`](licensing-and-ip.md) | Chính sách license + SBOM + cổng CI, source-available ≠ OSS, license model/dataset, TDM (Luật SHTT 131/2025), đầu ra AI, ToS, thương hiệu, REUSE | Khi thêm phụ thuộc/model/dataset/asset; chọn license sản phẩm; viết ToS |

## Thứ tự đọc khuyến nghị

1. `privacy-by-design.md` → lập data map (một nguồn sự thật cho ROPA, retention, notice, DPIA).
2. `vietnam-data-law.md` (+ `international-privacy.md` nếu có thị trường ngoài) → nghĩa vụ cụ thể và mốc thời hạn.
3. `consent-and-user-rights.md` → xây luồng; `ai-regulation.md` nếu có AI.
4. `records-and-audit-readiness.md` → biến tất cả thành bằng chứng máy sinh; `licensing-and-ip.md` chạy trong CI từ ngày đầu.

Mẫu liên quan: [`../templates/DPIA.md`](../templates/DPIA.md), [`../templates/THREAT-MODEL.md`](../templates/THREAT-MODEL.md),
[`../templates/POST-MORTEM.md`](../templates/POST-MORTEM.md). Chuẩn tham chiếu: [`../04-standards/data-privacy-standards.md`](../04-standards/data-privacy-standards.md).
