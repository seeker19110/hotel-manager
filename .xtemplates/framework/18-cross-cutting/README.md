---
title: Xuyên suốt
kind: index
updated: 2026-10-13
---

# 18 — Xuyên suốt

> Bảy module `kind: module` cho các chủ đề **cắt ngang mọi mảng** nhưng không thuộc riêng mảng nào: i18n, phương pháp
> hiệu năng, DX, tài liệu cho AI agent, biểu diễn dữ liệu (thời gian/tiền/đơn vị/ID/chuỗi), bền vững, và mã nguồn mở.
> Được ghép qua `modules` của hồ sơ/gói ngành (`18-cross-cutting/*`) và lọc theo `applies_to`. Mỗi file là **nhà** của
> chủ đề đó: baseline và các mảng khác chỉ tóm tắt và trỏ về đây (xem bảng ranh giới).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`i18n-and-l10n.md`](i18n-and-l10n.md) | Chuỗi tách khỏi mã, ICU MessageFormat/plural, định dạng theo CLDR/Intl, BCP 47, giãn chữ 130–300 %, RTL, font + NFC + tên người tiếng Việt, validate file dịch trong CI | G3–G4 khi thiết kế UI/API có người dùng nhiều ngôn ngữ; trước khi thêm ngôn ngữ thứ hai; khi có form tên/địa chỉ |
| [`performance-engineering.md`](performance-engineering.md) | Phương pháp: chỉ số theo hồ sơ, baseline, ngân sách trong CI, profiling trước khi sửa, phân vị thay trung bình, USE/RED, benchmark trung thực, cổng regression | G0 đặt chỉ số; G5 đặt ngân sách; mỗi PR `perf:`; khi "chậm" mà chưa có số |
| [`developer-experience.md`](developer-experience.md) | Clone → test xanh ≤ 3 lệnh, lệnh chuẩn máy đọc (`xt.yaml`/`runtime.yaml`), mise/devcontainer, hook < 30 s, CI < 10 phút, lỗi nói cách sửa, DORA/SPACE | G5 dựng nền; khi onboarding người/agent mới; khi hook bị `--no-verify` hoặc CI chậm |
| [`docs-for-ai-agents.md`](docs-for-ai-agents.md) | `AGENTS.md` nguồn duy nhất + bridge (`CLAUDE.md` `@AGENTS.md`, copilot-instructions, GEMINI.md), ngân sách 200 dòng/32 KiB, path-scoped rules, `SCOPE.md` + `.out-of-scope/`, `SKILL.md` theo Agent Skills spec, vendor-with-lock, `llms.txt` v2 | G5 khi dựng harness; khi thêm harness/skill mới; khi agent chạy sai lệnh hoặc bỏ qua luật |
| [`units-time-and-money.md`](units-time-and-money.md) | Nhà của: UTC + RFC 3339/9557, tên tz IANA (tzdata 2026e), monotonic clock, tiền số nguyên + ISO 4217 minor unit, làm tròn/phân bổ, đơn vị trong tên, UUIDv7 vs v4, NFC + collation | G3 đặc tả dữ liệu; G4 thiết kế schema; mọi PR chạm thời gian/tiền/ID; khi có bug "lệch một ngày/một đồng" |
| [`sustainability-and-efficiency.md`](sustainability-and-efficiency.md) | SCI 1.1.0, SWDM v4, ngân sách tài nguyên, dead code/dep thừa/trùng lặp, refactor không đổi hành vi, retention, đúng cỡ/scale-to-zero, CI không chạy thừa, chi phí AI | Cuối mỗi mảng (tối ưu mã nguồn); G8 định kỳ; khi hoá đơn/tài nguyên tăng bất thường |
| [`open-source-and-community.md`](open-source-and-community.md) | LICENSE/README/CONTRIBUTING/CoC 3.0/SECURITY.md (SLA 14 ngày)/SUPPORT/GOVERNANCE, DCO, CI an toàn cho fork, triage `needs-info` 14 ngày, REUSE 3.3, Scorecard ≥ 7, phát hành có SBOM + trusted publishing | Trước khi mở mã; khi nhận PR bên ngoài; khi phát hành công khai; khi điểm Scorecard giảm |

## Ranh giới "một chủ đề một nhà"

| Chủ đề | Nhà ở mảng này | Nơi chỉ trỏ/tóm tắt |
|---|---|---|
| Thời gian/tiền/đơn vị/ID/so sánh chuỗi | `units-time-and-money.md` | [`../01-baseline/data-correctness.md`](../01-baseline/data-correctness.md) (tóm tắt); [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md) (cách test) |
| Phương pháp hiệu năng | `performance-engineering.md` | web → [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md); tải → [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md) |
| Tài liệu cho AI | `docs-for-ai-agents.md` | tối thiểu → [`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md); file vòng lặp → [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md) |
| Quy trình OSS | `open-source-and-community.md` | license/IP → [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md); chữ ký/provenance → [`../12-security/supply-chain.md`](../12-security/supply-chain.md) |
| Tối ưu mã nguồn không đổi hành vi | `sustainability-and-efficiency.md` | công cụ làm cổng → [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md); tiền → [`../15-operations/cost-management.md`](../15-operations/cost-management.md) |
| i18n | `i18n-and-l10n.md` | a11y → [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md); microcopy → [`../06-design-ux/content-and-microcopy.md`](../06-design-ux/content-and-microcopy.md) |
