---
title: Chỉ mục khung X-Templates
kind: index
updated: 2026-10-14
---

# Khung X-Templates — chỉ mục

> Thư viện yêu cầu có ID cho mọi phần mềm. Đọc [`00-method/`](00-method/README.md) trước, rồi ghép blueprint cho dự án
> bằng `xt.py compose` (xem [`00-method/composition.md`](00-method/composition.md)).

| # | Mảng | Trả lời câu hỏi | Ghép vào blueprint |
|---|---|---|---|
| 00 | [Phương pháp](00-method/README.md) | Khung vận hành thế nào? | — |
| 01 | [Nền tảng chung](01-baseline/README.md) | Mọi phần mềm đều cần gì? | Luôn luôn |
| 02 | [Hồ sơ loại phần mềm](02-profiles/README.md) | Web, mobile, desktop, API, AI agent, agentic, game… khác nhau ở đâu? | Chọn 1 |
| 03 | [Gói ngành](03-industries/README.md) | Fintech, y tế, giáo dục, TMĐT, chính phủ… đòi hỏi gì riêng? | Chọn 0..n |
| 04 | [Tiêu chuẩn](04-standards/README.md) | Chuẩn nào, phiên bản nào, chứng minh tuân thủ ra sao? | Qua hồ sơ/ngành |
| 05 | [Kiến trúc](05-architecture/README.md) | Chọn kiểu kiến trúc, pattern, độ bền vững thế nào? | Qua hồ sơ |
| 06 | [Thiết kế & UI/UX](06-design-ux/README.md) | Design system, tokens, a11y, trạng thái, nội dung? | Hồ sơ có giao diện |
| 07 | [Frontend](07-frontend/README.md) | Render, dữ liệu, state, hiệu năng, bảo mật phía client? | Hồ sơ có giao diện |
| 08 | [Backend](08-backend/README.md) | API, auth, job, cache, tích hợp, độ tin cậy? | Hồ sơ có server |
| 09 | [Cơ sở dữ liệu](09-database/README.md) | Mô hình, migration, index, sao lưu, dữ liệu nhạy cảm? | Hồ sơ có dữ liệu |
| 10 | [Workflow](10-workflow/README.md) | Git, PR, review, CI/CD, phát hành, tài liệu? | Luôn luôn |
| 11 | [Vòng lặp tự động](11-autonomous-loop/README.md) | Autopilot chạy đến khi xong, dừng đúng lúc, có bằng chứng? | Khi dùng AI agent làm việc |
| 12 | [Bảo mật](12-security/README.md) | Threat model, AppSec, secrets, supply chain, hạ tầng? | Luôn luôn |
| 13 | [Kỹ thuật AI](13-ai-engineering/README.md) | LLM app, RAG, agent, agentic, eval, guardrail, MCP/A2A? | Hồ sơ AI |
| 14 | [Kiểm thử & chất lượng](14-testing-quality/README.md) | Chiến lược test, ca biên, hiệu năng, chất lượng mã? | Luôn luôn |
| 15 | [Vận hành](15-operations/README.md) | Hạ tầng, quan sát, SLO, sự cố, DR, chi phí? | Hồ sơ có triển khai |
| 16 | [Tuân thủ & quyền riêng tư](16-compliance-privacy/README.md) | Luật dữ liệu VN + quốc tế, AI Act, hồ sơ tuân thủ? | Có dữ liệu người dùng |
| 17 | [Sản phẩm & dự án](17-product-project/README.md) | Yêu cầu, đặc tả, ưu tiên, rủi ro, tài liệu, bàn giao? | Luôn luôn |
| 18 | [Xuyên suốt](18-cross-cutting/README.md) | i18n, hiệu năng, license, DX, bền vững? | Theo nhu cầu |
| — | [Mẫu tài liệu](templates/README.md) | PROJECT, PLAN, SPEC, ADR, threat model, runbook, post-mortem… | — |

## Cách đọc nhanh theo vai

| Bạn là | Đọc |
|---|---|
| Người mới / chủ dự án | `00-method/lifecycle.md` → `02-profiles/` (loại của bạn) → `03-industries/` (ngành của bạn) |
| AI agent nhận yêu cầu mới | `AGENTS.md` (gốc repo) → `11-autonomous-loop/` → ghép blueprint → lập PLAN |
| Kiến trúc sư | `05-architecture/` → `09-database/` → `12-security/threat-modeling` |
| Kỹ sư frontend/backend | `07-frontend/` hoặc `08-backend/` → `14-testing-quality/` |
| Người làm AI | `13-ai-engineering/` → `12-security/` → `16-compliance-privacy/` |
