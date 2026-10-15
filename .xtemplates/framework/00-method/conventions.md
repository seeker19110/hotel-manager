---
title: Quy ước viết module của khung
kind: method
updated: 2026-10-14
---

# Quy ước viết module của khung

> Hợp đồng định dạng cho **mọi file trong `framework/`**. Máy (`scripts/xt.py validate`) kiểm các quy ước
> có dấu 🔒; vi phạm làm CI đỏ. Người/AI viết module mới đọc file này trước.

## 1. Ngôn ngữ và tên

- Nội dung **tiếng Việt có dấu**; thuật ngữ kỹ thuật giữ tiếng Anh khi đó là tên chuẩn (vd *idempotency key*, *Core Web Vitals*).
- Tên file và thư mục: **tiếng Anh, chữ thường, gạch nối** (`kebab-case.md`). Thư mục mảng đánh số `NN-ten-mang/`.
- Mỗi thư mục có `README.md` làm chỉ mục: bảng *file → nội dung → đọc khi nào*.

## 2. Frontmatter 🔒

Mọi file `.md` trong `framework/` bắt đầu bằng khối YAML **dạng phẳng** (chỉ `khoá: giá trị` hoặc `khoá: [a, b]`):

```yaml
---
title: Xác thực & quản lý phiên
kind: module
prefix: SEC-AUTH
applies_to: [all]
updated: 2026-10-13
---
```

| Khoá | Bắt buộc | Giá trị |
|---|---|---|
| `title` | luôn | Tên hiển thị |
| `kind` | luôn | `method` · `index` · `module` · `baseline` · `profile` · `industry` · `standard` · `template` |
| `updated` | luôn | Ngày cập nhật nội dung `YYYY-MM-DD` |
| `prefix` | khi file có mục checklist | Tiền tố ID, **duy nhất toàn khung**, dạng `AAA` hoặc `AAA-BBB` (chữ in hoa/số) |
| `applies_to` | `module`, `baseline` | `[all]` hoặc danh sách slug hồ sơ (`[web-app, mobile-app]`) |
| `modules` | `profile`, `industry` | Danh sách module được ghép vào blueprint, đường dẫn tương đối từ `framework/`, bỏ `.md`; cho phép `*` cuối (vd `08-backend/*`) |
| `slug` | `profile`, `industry` | Tên ngắn dùng trong lệnh `compose` (vd `web-app`, `fintech`) |

## 3. Mục checklist 🔒

Mỗi yêu cầu kiểm được là **một dòng**:

```markdown
- [ ] `SEC-AUTH-001` **MUST** Băm mật khẩu bằng Argon2id (hoặc scrypt/bcrypt khi nền tảng không có) với tham số theo OWASP. → Kiểm: test đơn vị đọc hash có tiền tố `$argon2id$`. · Nguồn: ASVS 5.0 V6
```

- **ID** = `prefix` của file + `-` + 3 chữ số, **duy nhất toàn khung, không bao giờ tái sử dụng** (mục bị bỏ → giữ ID, đổi mức thành `MAY` và ghi "Ngừng dùng").
- **Mức** (theo RFC 2119): `MUST` — thiếu là chưa đạt; `SHOULD` — bỏ phải ghi lý do; `MAY` — tùy chọn.
- **Ngưỡng quy mô** (tùy chọn): `MUST@M` hoặc `MUST@L` — bắt buộc từ quy mô đó trở lên; nhỏ hơn thì máy hạ thành `SHOULD`.
  Ở quy mô S, máy còn hạ MUST trơn của module chuyên sâu thành SHOULD (ADR-0003). Vì vậy yêu cầu mà **mọi** phần mềm, kể cả prototype, phải có thì đặt ở `01-baseline/`, không đặt ở module.
  Mỗi module/chuẩn có **tối đa 4** mục hiệu lực MUST ở quy mô M (`MUST` trơn + `MUST@M`); phần vượt là `MUST@L` — `xt.py validate` chặn (ADR-0004).
  Bốn mục giữ là mục mà thiếu thì gây hại khó đảo ngược (dữ liệu, quyền, tiền, luật, sập không khôi phục), rồi mục nền móng, rồi mục kiểm rẻ bằng máy.
  - `S` = thử nghiệm/MVP nội bộ, ít người dùng · `M` = production có người dùng thật · `L` = quy mô lớn, nhiều đội, hoặc ngành bị quản lý.
- **`→ Kiểm:`** (bắt buộc với `MUST`, nên có với `SHOULD`): cách chứng minh bằng máy hoặc bằng chứng cụ thể (lệnh, test, file, cấu hình). Không viết "đảm bảo X" mà không nói kiểm thế nào.
- **`· Nguồn:`** (khi yêu cầu đến từ chuẩn/luật): mã chuẩn + mục (`ASVS 5.0 V6`, `WCAG 2.2 SC 2.5.8`, `Luật 91/2025/QH15 Đ.20`).
- Một ý một dòng. Không lồng danh sách con dưới mục checklist.

Trạng thái trong **blueprint của dự án** (file sinh ra, không phải trong khung): `[ ]` chưa · `[x]` đạt · `[~]` miễn trừ, bắt buộc kèm `— Miễn: <lý do>`.

## 4. Cấu trúc một module (`kind: module` / `baseline`) 🔒

```markdown
# <Tiêu đề>

> Tóm tắt 1–3 câu: module giải quyết gì, áp dụng khi nào.

## Nguyên tắc
## Quyết định            ← bảng "khi nào dùng gì" / cây quyết định (nếu có lựa chọn)
## Checklist             ← 🔒 bắt buộc có (trừ khi file không có mục)
## Bẫy thường gặp        ← anti-pattern, lỗi hay gặp, ca biên
## Cổng tự động          ← công cụ/lệnh kiểm bằng máy, đặt ở CI hay hook
## Nguồn                 ← 🔒 bắt buộc: URL chính thống + ngày xác minh
```

Thứ tự giữ như trên; được thêm mục riêng giữa "Quyết định" và "Checklist".

## 5. Hồ sơ loại phần mềm (`kind: profile`) và gói ngành (`kind: industry`)

Ngoài frontmatter `slug` + `modules`, nội dung gồm: **Khi nào dùng**, **Kiến trúc tham chiếu**, **Stack mặc định
khuyến nghị** (kèm phiên bản + ngày xác minh — luôn ghi "xác minh lại trước khi dùng"), **Checklist đặc thù**
(mục có ID theo `prefix` riêng), **Cổng chất lượng tương đương**, **Bẫy**, **Nguồn**.

Gói ngành thêm: **Khung pháp lý** (Việt Nam + quốc tế, số hiệu văn bản + ngày hiệu lực), **Mô hình dữ liệu/nghiệp vụ
đặc trưng**, **Ca biên nghiệp vụ**.

## 6. Nguồn và độ tin cậy

- Ưu tiên nguồn **chính thống** (trang chuẩn, văn bản luật, tài liệu chính thức, repo chính chủ) hơn blog tổng hợp.
- Phiên bản/số liệu luôn kèm **ngày xác minh**. Không xác minh được → ghi **(chưa xác minh)**, không đoán.
- Văn bản pháp luật: số hiệu đầy đủ + ngày hiệu lực; nhắc "kiểm tra văn bản sửa đổi trước khi áp dụng".
- Không chép nguyên văn dài; tóm tắt + mã mục + link.

## 7. Liên kết

- Liên kết nội bộ dùng **đường dẫn tương đối** tới file `.md` có thật 🔒.
- Không trùng lặp nội dung giữa các module: một chủ đề có **một nhà**; nơi khác chỉ trỏ tới.
- Mục bị gộp vào nhà khác: giữ ID, đổi mức thành `MAY`, ghi `Ngừng dùng <ngày> — gộp vào <ID-nhà kèm liên kết tương đối>`.
  MAY không vào blueprint mặc định nên dự án không thấy trùng; ID không bao giờ cấp lại.
- Ngoại lệ có chủ đích: `01-baseline/` được giữ một mục **sàn** ngắn (MUST) cho chủ đề có nhà ở module chuyên sâu, kèm liên kết tới nhà,
  vì ở quy mô S MUST của module bị hạ thành SHOULD (ADR-0003). Mục sàn chỉ nêu yêu cầu tối thiểu; chi tiết và cách kiểm đầy đủ ở nhà.

### Bản đồ "một chủ đề một nhà"

| Chủ đề | Nhà (mục gốc) | Nơi khác chỉ giữ |
|---|---|---|
| Xác thực, phiên, phân quyền, IDOR | `08-backend/authn-authz.md` | 12 appsec: lớp lỗ hổng + trỏ |
| CSRF, header bảo mật, injection | `12-security/appsec-web.md` | 07 client-security: CSP/Trusted Types phía trình duyệt |
| Bí mật (lưu, xoay, quét, OIDC CI) | `12-security/secrets-management.md` | 01 configuration-and-secrets: tối thiểu + trỏ |
| Cấu hình, schema env, tiền tố biến công khai | `01-baseline/configuration-and-secrets.md` | 10 environments-and-config: môi trường, preview, flag, gate deploy |
| Chuỗi cung ứng, ghim SHA, SBOM, SLSA, vendor-lock skill/MCP | `12-security/supply-chain.md` | 01 dependencies: tối thiểu + trỏ |
| Log ứng dụng, lỗi trả client | `01-baseline/errors-and-logging.md` | — |
| Nền tảng quan sát, trace_id lan truyền | `15-operations/observability.md` | — |
| Log/audit bảo mật | `12-security/logging-audit-and-incident.md` | — |
| Tiền, thời gian, ID, đơn vị, chuẩn hoá chuỗi | `18-cross-cutting/units-time-and-money.md` | 01 data-correctness: tóm tắt; 09 data-modeling: kiểu cột cụ thể |
| Idempotency, outbox, saga, webhook (ngữ nghĩa), retry | `05-architecture/integration-patterns.md`, `resilience-and-scalability.md` | 08 backend: số vận hành, header HTTP, DLQ |
| Migration | `09-database/migrations.md` | 15 deployment: migration online + trỏ |
| Sao lưu CSDL / DR hệ thống | `09-database/backup-and-recovery.md` / `15-operations/backup-and-disaster-recovery.md` | — |
| Tiếp cận (a11y), vùng chạm | `06-design-ux/accessibility.md` | 04 chuẩn: phiên bản; 14 e2e: cách test |
| Hiệu năng web / test tải / phương pháp | `07-frontend/performance-web-vitals.md` / `14-testing-quality/performance-and-load.md` / `18-cross-cutting/performance-engineering.md` | — |
| Bảo mật AI (mối đe doạ) / guardrail sản phẩm | `12-security/ai-security.md` / `13-ai-engineering/guardrails-and-safety.md` | — |
| Vòng lặp tự động khi PHÁT TRIỂN / hệ agentic là SẢN PHẨM | `11-autonomous-loop/` / `13-ai-engineering/agentic-systems.md` | — |
| Tài liệu cho AI agent (AGENTS.md, SKILL.md) | `18-cross-cutting/docs-for-ai-agents.md` | — |
| PROGRESS/PLAN/file harness | `11-autonomous-loop/harness-files.md` | 01-baseline: sàn `BASE-DOC-008` |
| "4 con số" của vòng lặp; lỗi lặp 3 lần → BLOCKED | `11-autonomous-loop/loop-design.md` (`LOOP-DESIGN-001`, `LOOP-DESIGN-005`) | PLAN/skill/README: trỏ |
| Bộ khoá `xt.yaml` (dev-task chạy khoá nào) | `templates/xt.yaml` + `LOOP-HARNESS-008` | 01 quality-gates, 18 docs-for-ai-agents: trỏ |
| ADR | `05-architecture/decision-records.md` | — |
| Spec | `17-product-project/specification.md` | 10 spec-driven: quy trình |
| Sự cố | `15-operations/incident-response.md` | 12 logging-audit: phần bảo mật |
| Quyền riêng tư, luật dữ liệu | `16-compliance-privacy/` | 09 sensitive-data: kiểm soát kỹ thuật |
| Giấy phép | `16-compliance-privacy/licensing-and-ip.md` | 18 open-source: quy trình OSS |

## 8. Khi nào sửa khung

- Thêm/sửa mục: giữ ID cũ ổn định; cập nhật `updated`; ghi `CHANGELOG.md`.
- Đổi quyết định lớn về cấu trúc khung: ghi ADR ở `docs/adr/`.
- Chạy `python3 scripts/xt.py validate` và `python3 -m unittest discover -s tests` trước khi commit.
