---
title: Tiêu chuẩn — phiên bản hiện hành và cách chứng minh tuân thủ
kind: index
updated: 2026-10-14
---

# 04 — Tiêu chuẩn — phiên bản hiện hành và cách chứng minh tuân thủ

> Mảng này trả lời ba câu hỏi cho mỗi chuẩn: **phiên bản nào đang hiện hành** (kèm ngày xác minh và URL), **chọn chuẩn
> nào cho quy mô/ngành nào**, và **chứng minh tuân thủ bằng bằng chứng máy nào**. Kỹ thuật thực hiện nằm ở mảng chuyên
> môn (12 bảo mật, 06 a11y, 08 API, 16 pháp lý, 13 AI); file ở đây chỉ ánh xạ chuẩn → mục khung → cổng. Mọi phiên bản
> ghi ngày xác minh 2026-10-13; không truy cập được nguồn gốc thì ghi "(chưa xác minh)" — xác minh lại khi khai báo vào
> `PROJECT.md` (G2).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`security-standards.md`](security-standards.md) | OWASP ASVS 5.0.0 / MASVS 2.1.0 / Top 10:2025 / API Security 2023, NIST SSDF 1.1 (+218A), CIS Benchmarks, ISO/IEC 27001:2022 | G2 khi chọn mức ASVS; G4 threat model; G7 báo cáo GO/NO-GO; khách hàng hỏi chứng nhận |
| [`accessibility-standards.md`](accessibility-standards.md) | WCAG 2.2 (2023-10, cập nhật 2024-12), EN 301 549 V3.2.1/V4.1.1, Section 508 (WCAG 2.0 AA), WCAG 3.0 WD | G2 khi sản phẩm có UI; bán cho khu vực công EU/Mỹ; trước phát hành (bảng SC + kiểm tay) |
| [`api-and-web-standards.md`](api-and-web-standards.md) | OpenAPI 3.1.x/3.2.1, RFC 9457, RFC 9110–9114, OAuth 2.1 draft-16, OIDC Core errata 2, JSON Schema 2020-12, RFC 8785 | G3–G4 khi viết hợp đồng API; chọn phiên bản OpenAPI; thiết kế lỗi/xác thực |
| [`data-privacy-standards.md`](data-privacy-standards.md) | Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP (hiệu lực 01/01/2026, thay NĐ 13/2023), GDPR, ISO/IEC 27701, NIST Privacy Framework 1.0 | G0–G2 khi có dữ liệu cá nhân; trước khi thêm SaaS xử lý dữ liệu; DPIA |
| [`process-and-quality-standards.md`](process-and-quality-standards.md) | ISO/IEC 25010:2023, SemVer 2.0.0, Conventional Commits 1.0.0, SLSA v1.2, CycloneDX 1.7/SPDX 3.0, DORA 5 chỉ số | G5 dựng nền (commitlint, release, SBOM); G7 release; đo DORA trước khi bật autopilot |
| [`ai-standards.md`](ai-standards.md) | ISO/IEC 42001:2023, NIST AI RMF 1.0 + AI 600-1, EU AI Act 2024/1689, OWASP LLM Top 10 2026 / Agentic / MCP Top 10 (beta), MCP 2026-07-28, A2A 1.0.1 | G1–G2 khi sản phẩm có LLM/agent/MCP; trước khi phát hành cho người dùng EU |

Cách dùng: chọn hàng phù hợp trong mục "Quyết định" của từng file → khai báo chuẩn + phiên bản vào `PROJECT.md` → mục
checklist `STD-*` được ghép vào blueprint và tick bằng bằng chứng (file ánh xạ, job CI, báo cáo scan).
