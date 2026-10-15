---
title: Phương pháp audit
kind: method
updated: 2026-10-14
---

# Phương pháp audit

> Cách rà toàn diện một repo — dự án đích hoặc chính repo khung — sao cho **mọi phát hiện có bằng chứng tái hiện được,
> có mức, có Gate máy kiểm**, và lần quét sau chỉ quét lại phần đã đổi. Skill `/audit` thực thi phương pháp này;
> yêu cầu chi tiết của từng chủ đề nằm ở module "nhà" (bảng §3), file này chỉ điều phối.

## 1. Khi nào audit

| Tình huống | Phạm vi | Ghi chú |
|---|---|---|
| Nhận dự án có sẵn (brownfield, [`lifecycle.md`](lifecycle.md) G0) | Toàn bộ 13 nhóm | Sau khi có `BLUEPRINT.md`; kết quả là nợ ban đầu |
| Trước phát hành lớn / cổng G7 | Toàn bộ, `--strict` | Còn 🔴 mở → không phát hành |
| Định kỳ (gợi ý: mỗi quý, hoặc sau ~50 PR) | Chỉ nhóm có thay đổi (§6) | `xt.py audit plan` liệt kê nhóm cần quét lại |
| Sau sự cố / post-mortem | Nhóm liên quan | Phát hiện thành hàng rào máy (test, lint, Gate) |

## 2. Bước -1: đọc repo thật, không audit "khung trống"

`xt.py audit plan` in tín hiệu dò được từ file thật (manifest, lockfile, CI, migration, UI, container, hạ tầng,
harness agent) và suy ra nhóm nào **áp dụng**, **rút gọn** hay **N/A** kèm lý do. Agent đọc output này trước khi
quét, không đoán stack. Repo chỉ có tài liệu/cấu hình → audit tài liệu + cấu hình, **không bịa phát hiện về mã không tồn tại**.
Repo khung (có `framework/00-method/` + `scripts/xt.py`) → nhóm 9 và 13 là trọng tâm (quy ước, ID, link, nguồn, harness).

## 3. Mười ba nhóm và nhà của yêu cầu

| # | Mã | Nhóm | Rà gì (tối thiểu) | Nhà yêu cầu |
|---|---|---|---|---|
| 1 | ARCH | Kiến trúc & ranh giới | phụ thuộc vòng, lớp gọi ngược, C4 so với mã | [`boundaries-and-modularity`](../05-architecture/boundaries-and-modularity.md) |
| 2 | SEC | Bảo mật | SAST, secret toàn lịch sử, authz từng route, SSRF/IDOR, threat model còn đúng; có LLM → [`13-ai-engineering`](../13-ai-engineering/README.md) | [`security-minimum`](../01-baseline/security-minimum.md), [`appsec-web`](../12-security/appsec-web.md), [`threat-modeling`](../12-security/threat-modeling.md) |
| 3 | CODE | Chất lượng mã | lint 0 cảnh báo, type nghiêm, độ phức tạp, mã chết, trùng lặp, TODO | [`static-analysis-and-code-quality`](../14-testing-quality/static-analysis-and-code-quality.md) |
| 4 | TEST | Kiểm thử | coverage nhánh theo module quan trọng, ca biên, test không assert, flaky, mutation | [`test-strategy`](../14-testing-quality/test-strategy.md), [`coverage-and-mutation`](../14-testing-quality/coverage-and-mutation.md) |
| 5 | PERF | Hiệu năng | p95/ngân sách, N+1, index, bundle, cache; CLI: thời gian lệnh | [`performance-and-load`](../14-testing-quality/performance-and-load.md) |
| 6 | A11Y | A11y & UX | axe 0 critical, bàn phím, tương phản 2 theme, 4 trạng thái, mobile | [`accessibility`](../06-design-ux/accessibility.md), [`e2e-and-accessibility`](../14-testing-quality/e2e-and-accessibility.md) |
| 7 | DEP | Phụ thuộc | lockfile + hash, EOL runtime, license, major lạc hậu, CVE, ghim SHA action | [`dependencies`](../01-baseline/dependencies.md), [`supply-chain`](../12-security/supply-chain.md) |
| 8 | CI | CI/CD | required check có thật, permissions, secret, cache, thời gian, fail-open | [`ci-cd-pipeline`](../10-workflow/ci-cd-pipeline.md), [`quality-gates`](../01-baseline/quality-gates.md) |
| 9 | DOC | Tài liệu | README chạy được, ADR, runbook, link gãy, tài liệu lệch mã | [`documentation-minimum`](../01-baseline/documentation-minimum.md), [`documentation-workflow`](../10-workflow/documentation-workflow.md) |
| 10 | DATA | Dữ liệu | migration có đường lùi, backup đã thử khôi phục, PII map, xoá theo yêu cầu, thời gian/tiền | [`data-correctness`](../01-baseline/data-correctness.md), [`migrations`](../09-database/migrations.md), [`16-compliance-privacy`](../16-compliance-privacy/README.md) |
| 11 | CFG | Cấu hình & bí mật | env validate lúc khởi động, không secret trong mã/log, theo môi trường, fail-closed | [`configuration-and-secrets`](../01-baseline/configuration-and-secrets.md), [`environments-and-config`](../10-workflow/environments-and-config.md) |
| 12 | XFEAT | Thống nhất chéo tính năng | cùng khái niệm một cách xử lý (lỗi, phân trang, quyền, i18n, thời gian); A phá B | [`errors-and-logging`](../01-baseline/errors-and-logging.md), [`api-and-web-standards`](../04-standards/api-and-web-standards.md) |
| 13 | HAR | Harness & quy trình agent | lệnh `xt.yaml` chạy được, hook fail-open/fail-closed đúng chỗ, PROGRESS tươi, miễn trừ/bằng chứng blueprint còn đúng | [`harness-files`](../11-autonomous-loop/harness-files.md), [`stop-points-and-escalation`](../11-autonomous-loop/stop-points-and-escalation.md) |

Nhóm **N/A** phải ghi lý do kiểm được (vd "không có UI: không có `*.html`/`*.tsx`/`*.vue`"). Nhóm **rút gọn** quét
phần có thật (vd CLI: nhóm 5 chỉ đo thời gian lệnh chính).

## 4. Phát hiện: định dạng, mức, bằng chứng

Mỗi phát hiện là **một dòng** trong bảng "Phát hiện" của `docs/ops/AUDIT-STATUS.md` (mẫu
[`../templates/AUDIT-STATUS.md`](../templates/AUDIT-STATUS.md)); chi tiết dài (output lệnh, đường tái hiện) ở
`docs/ops/AUDIT-REPORT-<ngày>.md` (mẫu [`../templates/AUDIT-REPORT.md`](../templates/AUDIT-REPORT.md)).

- **ID** `AUD-<MÃ>-NNN` — mã nhóm ở bảng §3, số tăng dần, **không tái sử dụng** (phát hiện bác bỏ vẫn giữ dòng).
- **Mức:** 🔴 chặn phát hành (mất/lộ dữ liệu, sai tiền/quyền, cổng giả xanh, sập không khôi phục) · 🟠 sửa trong
  đợt này (lỗi thật có đường tái hiện, cổng thiếu, tài liệu sai gây làm sai) · 🟢 nợ có chủ (cải thiện, rủi ro thấp).
- **Bằng chứng** mở đầu bằng loại ([`evidence-and-sources.md`](evidence-and-sources.md) luật 8):
  `đo được:` lệnh + kết quả · `suy luận:` file:dòng + lập luận · `chưa biết:` thiếu công cụ/quyền, ghi cần gì để đo.
  Suy luận không được trình bày như đo được; 🔴 phải đo được hoặc có đường tái hiện từng bước.
- **Gate:** lệnh máy (trong backtick) đỏ trước khi sửa, xanh sau khi sửa — bắt buộc với 🔴/🟠. Không có Gate máy
  được → ghi bước kiểm tay cụ thể và hạ mức tin cậy.
- **Trạng thái:** `mở` · `đã sửa` (kèm PR/SHA) · `chấp nhận` (kèm `chủ:` và `hạn: YYYY-MM-DD`) · `bác bỏ` (kèm lý do).
  `xt.py audit check` chặn chấp nhận quá hạn và chấp nhận không có chủ/hạn.

## 5. Quy trình

1. **Plan** — `xt.py audit plan [--blueprint BLUEPRINT.md] [--status docs/ops/AUDIT-STATUS.md]`: nhóm áp dụng,
   công cụ có/thiếu, bằng chứng blueprint có thể đã cũ (file được trích đã đổi sau khi tick), nhóm cần quét lại.
2. **Blueprint** — mỗi MUST/SHOULD mở có thể kiểm ngay → phát hiện; miễn trừ/bằng chứng bị đánh dấu cũ → xác minh lại.
3. **Quét theo nhóm** — chạy lệnh thật, không đọc lướt. Nhóm độc lập về file có thể giao subagent chạy song song
   (read-only, mỗi subagent một cụm nhóm, trả bảng phát hiện); phiên chính gộp và đánh số ID.
4. **Xác minh đối kháng** — mọi 🔴/🟠 được một reviewer khác (model khác) tái hiện độc lập; không tái hiện được → hạ
   thành `suy luận` hoặc `bác bỏ`. Đây là chốt chặn ảo giác quan trọng nhất của audit.
5. **Ghi** — cập nhật `AUDIT-STATUS.md` (nhóm đã quét + SHA, bảng phát hiện) và `AUDIT-REPORT-<ngày>.md`;
   `xt.py audit check docs/ops/AUDIT-STATUS.md` phải exit 0 (schema đúng).
6. **DỪNG CHỜ DUYỆT** — trình kế hoạch sửa theo đợt (mỗi đợt ≤ 1 PR, bug có test tái hiện trước khi sửa). Không sửa
   trước khi người duyệt, trừ khi đang trong autopilot đã duyệt trước và phát hiện thuộc phạm vi PLAN.
7. **Hội tụ** — sửa → `/gate` → quét lại nhóm liên quan → lặp tới khi `xt.py audit check --strict` exit 0.

## 6. Quét lại theo thay đổi

`AUDIT-STATUS.md` ghi SHA lúc quét từng nhóm. Lần sau, `xt.py audit plan --status …` lấy `git diff --name-only <SHA>..HEAD`
và ánh xạ file đổi sang nhóm (workflow → 8, lockfile/manifest → 7, test → 4, migration → 10, tài liệu → 9,
`AGENTS.md`/`xt.yaml`/`.claude/` → 13, mã nguồn → 1·2·3·12). SHA không còn là tổ tiên HEAD (rebase/squash) → quét lại
nhóm đó từ đầu. Nhóm không đổi giữ kết quả cũ, nhưng phát hiện `chấp nhận` vẫn bị kiểm hạn.

## 7. Definition of Complete

Audit **xong** khi và chỉ khi `xt.py audit check docs/ops/AUDIT-STATUS.md --strict` exit 0:
mọi nhóm `đã quét` (SHA tổ tiên HEAD) hoặc `N/A` có lý do · không còn 🔴/🟠 `mở` · mọi `chấp nhận` có chủ và còn hạn.
Báo cáo cuối: đã quét gì · số phát hiện theo mức/trạng thái · bằng chứng (lệnh + exit code) · nợ 🟢 còn lại có chủ.

## 8. Bẫy

- Liệt kê "best practice" chung chung thay vì lỗi có thật trong repo này → mỗi phát hiện phải trỏ file:dòng hoặc lệnh.
- Tin miễn trừ cũ: miễn trừ viết khi CI chưa cài gì có thể sai khi CI đã cài công cụ — `audit plan` đánh dấu, người xác minh.
- Ghi SHA của nhánh PR vào cột SHA: squash-merge xoá commit đó, sổ trên nhánh chính hỏng (`audit check` đỏ). Ghi SHA
  **trên nhánh chính** mà lần quét dựa vào (thường là base của nhánh audit); thay đổi sau đó tự hiện ở "Quét lại".
- Coverage từ test chạy qua subprocess bị đếm thiếu → ghi rõ cách đo, đừng kết luận "0% không test".
- Công cụ không cài được → `chưa biết`, không phải "đạt".
- Sửa trong lúc audit làm lẫn bằng chứng → audit xong, duyệt, rồi mới sửa theo đợt.

## Nguồn

- Luật bằng chứng của khung: [`evidence-and-sources.md`](evidence-and-sources.md) (xác minh 2026-10-14).
- Vòng đời và brownfield: [`lifecycle.md`](lifecycle.md) (xác minh 2026-10-14).
- Mức RFC 2119 cho yêu cầu: https://www.rfc-editor.org/rfc/rfc2119 (xác minh 2026-10-14).
