---
title: Bảo trì: cập nhật phụ thuộc, EOL, nâng cấp major, nợ kỹ thuật
kind: module
prefix: OPS-MAINT
applies_to: [all]
updated: 2026-10-14
---

# Bảo trì: cập nhật phụ thuộc, EOL, nâng cấp major, nợ kỹ thuật

> Giữ hệ thống **sống** sau ra mắt: cập nhật phụ thuộc có nhịp (Dependabot/Renovate gom nhóm, WIP cap), theo dõi EOL của runtime/
> framework/CSDL bằng endoflife.date, nâng major có kế hoạch, nợ kỹ thuật có chủ và hạn, lịch quét lỗ hổng tuần. Công cụ quét và
> ghim thuộc [`../12-security/supply-chain.md`](../12-security/supply-chain.md); đây là **nhịp và quy trình** vận hành chúng.

## Nguyên tắc

- **Cập nhật nhỏ và đều rẻ hơn cập nhật lớn và hiếm**: patch/minor tự động theo tuần; major có kế hoạch, một PR riêng, có test và đường lùi.
- **EOL là deadline cứng**: runtime/framework/CSDL hết hỗ trợ = không còn vá bảo mật; nâng **trước** ngày EOL ≥ 3 tháng, theo dõi bằng máy (endoflife.date API), không bằng trí nhớ.
- **Lỗ hổng mới xuất hiện dù code không đổi** → quét theo lịch tuần, có SLA xử lý theo mức.
- **Nợ kỹ thuật là khoản vay có chủ**: ghi ở một nơi (`TECH-DEBT.md`/label), có người, lý do, hạn, chi phí trì hoãn; review hàng tháng; "lỗi lần thứ ba" → trả nợ bằng ADR.
- **Bảo trì có ngân sách thời gian** (vd ≥ 10–20% mỗi sprint) — không thì chỉ có tính năng và nợ.
- **Mọi thứ có chủ sở hữu và ngày xem lại**: dependency, flag, ADR, runbook, SLO, threat model.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Bot cập nhật | **Dependabot** gom nhóm (`groups`: minor+patch theo hệ sinh thái), `open-pull-requests-limit` theo WIP cap (vd 3), lịch tuần, bỏ qua major (`ignore: update-types: version-update:semver-major`) | **Renovate** (AGPL-3.0, chạy như dịch vụ/app — không ảnh hưởng license sản phẩm) khi đa nền tảng, cần `lockFileMaintenance`, automerge có điều kiện, regex manager |
| Automerge | Patch của dependency có test tốt và CI xanh → automerge; minor cần người; major không automerge | Thư viện/SDK phát hành cho người khác → không automerge gì |
| Theo dõi EOL | Script tuần đọc `https://endoflife.date/api/<product>.json` cho runtime, framework, CSDL, OS, tool IaC | Sản phẩm không có trên endoflife.date → ghi ngày EOL từ trang vendor kèm ngày xác minh |
| Nâng major | Một PR/nhánh riêng, đọc changelog/migration guide, codemod chính thức, chạy toàn bộ test + E2E, canary; ADR nếu đổi cách dùng | Major phá vỡ lớn (framework) → spike có hạn trước, kế hoạch nhiều PR nhỏ sau flag |
| Nợ kỹ thuật | `docs/TECH-DEBT.md` (hoặc issue label `tech-debt`) với chủ/lý do/hạn/chi phí trì hoãn; review tháng | Nợ lớn → ADR + roadmap |
| Dependency không bảo trì | Thay thế khi: archive, không release > 18 tháng, CVE không vá > 90 ngày; vendor có lock nếu buộc giữ | Fork nội bộ chỉ khi có người bảo trì và ghi ADR |
| Quét lỗ hổng | OSV-Scanner/pip-audit/`npm audit` tuần + SBOM re-scan; SLA: critical 7 ngày, high 30 ngày, medium 90 ngày (đội tự chốt) | Ngành bị quản lý → SLA chặt hơn theo luật |

## Checklist

- [ ] `OPS-MAINT-001` **MUST** Bot cập nhật phụ thuộc bật cho mọi hệ sinh thái trong repo (ngôn ngữ, Docker, GitHub Actions, Terraform…), lịch tuần, gom nhóm minor+patch, giới hạn PR mở. → Kiểm: `dependabot.yml`/`renovate.json` có đủ `package-ecosystem` ứng với manifest tồn tại (script so); `groups` + `open-pull-requests-limit` đặt. · Nguồn: GitHub Dependabot options reference; catalog stored 23 §2.5 (gom nhóm + WIP cap)
- [ ] `OPS-MAINT-002` **MUST@L** PR cập nhật được xử lý trong ≤ 14 ngày (merge/đóng có lý do); không để PR bot chất đống. → Kiểm: script đếm PR bot mở > 14 ngày = 0 (CI lịch tuần cảnh báo). · Nguồn: WIP cap (catalog 23 §2.5); P8
- [ ] `OPS-MAINT-003` **MUST** Theo dõi EOL bằng máy cho runtime, framework, CSDL, OS/image nền, tool IaC: job tuần đọc endoflife.date, cảnh báo khi còn < 6 tháng, đỏ khi đã EOL. → Kiểm: `scripts/eol-check` (dự án tự viết) với danh sách sản phẩm ↔ phiên bản đang dùng (đọc từ `package.json`/`pyproject`/Dockerfile/`required_version`); không có phiên bản đã EOL ở production. · Nguồn: endoflife.date (ví dụ xác minh 2026-10-13: Python 3.10 EOL 2026-10-01, Node 20 EOL 2026-04-30, Node 22 EOL 2027-04-30)
- [ ] `OPS-MAINT-004` **MUST** Quét lỗ hổng theo lịch tuần (dependency + image + SBOM) với SLA xử lý theo mức (critical/high/medium) ghi thành chính sách; vi phạm SLA hiện trong review tháng. → Kiểm: workflow `schedule`; `docs/ops/VULN-SLA.md`; báo cáo tháng số finding quá SLA = 0. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md) `SEC-SUPPLY-006`; NIST SSDF RV.1
- [ ] `OPS-MAINT-005` **MUST** Nâng major có kế hoạch: PR riêng, changelog/migration guide đọc và tóm tắt trong PR, codemod chính thức nếu có, toàn bộ test + E2E xanh, deploy qua canary/flag, đường lùi ghi rõ. → Kiểm: template PR `major-upgrade` với các mục bắt buộc; label `major`; không gộp major với tính năng. · Nguồn: P8; [`deployment-strategies.md`](deployment-strategies.md)
- [ ] `OPS-MAINT-006` **MUST@L** Nợ kỹ thuật ghi ở một nơi với chủ sở hữu, lý do, hạn/điều kiện trả, chi phí trì hoãn; `PROGRESS.md` mục "Nợ kỹ thuật" không ghi "(không có)" khi còn việc treo. → Kiểm: `docs/TECH-DEBT.md` hoặc issue label; script so "Nợ kỹ thuật: (không có)" với số issue `tech-debt` mở > 0 = đỏ. · Nguồn: research khung cũ §3b (PROGRESS ghi "không có" trong khi còn nợ); P1
- [ ] `OPS-MAINT-007` **MUST@L** Lockfile/lock của skill, MCP, action, image được làm mới có kiểm soát (`lockFileMaintenance` hoặc PR tuần) và qua cùng cổng như code. → Kiểm: PR lock refresh định kỳ; CI xanh. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `OPS-MAINT-008` **MUST@L** Dependency không bảo trì (archive, không release > 18 tháng, CVE không vá > 90 ngày) được phát hiện bằng máy và có kế hoạch thay thế/vendor. → Kiểm: Scorecard `Maintained` hoặc script đọc ngày release gần nhất; danh sách + ticket. · Nguồn: OpenSSF Scorecard; evidence-and-sources §1.7
- [ ] `OPS-MAINT-009` **MUST@L** Ngân sách bảo trì cố định (≥ 10% thời gian sprint/tháng, đội tự chốt) và review bảo trì hàng tháng: PR bot, EOL, nợ, flag quá hạn, runbook/ADR/SLO cũ, finding quá SLA. → Kiểm: biên bản review tháng `docs/ops/maintenance-reviews/`; ngân sách ghi trong PROJECT/PROGRESS. · Nguồn: P12; lifecycle G8
- [ ] `OPS-MAINT-010` **MUST@L** Tài liệu vận hành có ngày xem lại: runbook, SLO, threat model, ADR trạng thái, bảng liên hệ — quá 12 tháng không xem lại = cảnh báo; SHA/nhánh ghi trong PROGRESS/STATUS phải còn tồn tại và là tổ tiên của HEAD. → Kiểm: script đọc frontmatter `updated`/`review_by`; CI kiểm SHA trong PROGRESS là ancestor của HEAD. · Nguồn: catalog stored 21 §8 điểm 9 (docs tươi bằng máy); P5
- [ ] `OPS-MAINT-011` **MUST@L** Tool tự động sửa CI/cập nhật phụ thuộc (agent) không được: skip/disable test, hạ ngưỡng, rewrite history, re-run quá trần; chuỗi đỏ cùng chữ ký ≥ 3 → BLOCKED. → Kiểm: hook/policy từ [`../11-autonomous-loop/self-healing-ci.md`](../11-autonomous-loop/self-healing-ci.md); log BLOCKED. · Nguồn: catalog stored 21 §9; `SEC-SUPPLY-011`
- [ ] `OPS-MAINT-012` **MUST@L** Quy trình thay thế/ngừng dịch vụ (deprecation): thông báo trước ≥ 90 ngày cho API/SDK công khai, header `Deprecation`/`Sunset`, kế hoạch migration, đo tỷ lệ còn dùng trước khi tắt. → Kiểm: chính sách trong [`../08-backend/api-design.md`](../08-backend/api-design.md) được áp; metric usage phiên bản cũ. · Nguồn: RFC 9745 Deprecation header (chưa xác minh số RFC 2026-10-13); [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md)
- [ ] `OPS-MAINT-013` **SHOULD** Automerge patch của dependency khi CI (gồm E2E) xanh và dependency có test tốt; minor/major cần người. → Kiểm: cấu hình automerge theo `update-types`; log automerge. · Nguồn: Renovate/Dependabot docs (chưa fetch lại automerge 2026-10-13)
- [ ] `OPS-MAINT-014` **SHOULD** Canary dependency: một tập dependency rủi ro cao (vd urllib3, openssl binding, SDK thanh toán) được theo dõi release/advisory riêng và nâng sớm có eval. → Kiểm: danh sách canary dep + job theo dõi. · Nguồn: catalog stored 21 §8 (X-Agents `keeper`)
- [ ] `OPS-MAINT-015` **SHOULD** Harness/AI config (hook, skill, model id, prompt) ghi ngày + phiên bản và xét lại khi đổi model/tool — harness có hạn sử dụng. → Kiểm: file harness có `updated` + model id; review khi đổi model (ADR). · Nguồn: catalog stored 21 §2.2 (harness có hạn sử dụng)
- [ ] `OPS-MAINT-016` **SHOULD** Dọn định kỳ: branch cũ đã merge, artifact/image cũ (giữ N bản để rollback), flag quá hạn, dead code (knip/vulture/deadcode), dependency không dùng (depcheck/`pip-extra-reqs`). → Kiểm: job lịch tháng + báo cáo; ngưỡng giữ artifact ghi. · Nguồn: khung cũ `docs/ops/code-optimization-audit-prompt.md`; [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md)
- [ ] `OPS-MAINT-017` **SHOULD** License của dependency được quét lại khi cập nhật (license đổi giữa phiên bản — vd Terraform BUSL, Redis/Elastic trước đây); thay đổi license = review. → Kiểm: dependency review `deny-licenses`; SBOM license diff trong PR cập nhật. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)
- [ ] `OPS-MAINT-018` **MAY** Nâng major theo "spike có hạn" (≤ 2 ngày) trên nhánh bỏ đi để ước lượng trước khi lập kế hoạch. → Kiểm: kết quả spike ghi vào ticket. · Nguồn: P8
- [ ] `OPS-MAINT-019` **MAY** Theo dõi sức khoẻ dependency bằng deps.dev/Scorecard định kỳ và hiển thị trong README nội bộ. → Kiểm: badge/báo cáo. · Nguồn: OpenSSF Scorecard
- [ ] `OPS-MAINT-020` **MAY** Mirror/fork phụ thuộc quan trọng được đồng bộ upstream theo lịch và cite upstream; drift > N phiên bản = cảnh báo. → Kiểm: job so tag upstream. · Nguồn: catalog stored 23 §8.1 (mirror trôi xa upstream)

## Bẫy thường gặp

1. **Dependabot chỉ bật cho npm** → action/image/pip không bao giờ cập nhật (đo thật trên nhiều repo: Dependabot thiếu `github-actions`, catalog 23 §8.1). Tránh: `OPS-MAINT-001`.
2. **50 PR bot mở, không ai merge** → mọi người tắt bot. Tránh: gom nhóm + WIP cap + SLA 14 ngày (`OPS-MAINT-002`).
3. **Phát hiện EOL khi đã EOL** (Node 18 hết 04/2025, Python 3.9 hết 10/2025 vẫn còn trong `engines`/`requires-python` của repo thật, catalog 23 §8.1). Tránh: `OPS-MAINT-003` bằng máy.
4. **Gộp nâng major với tính năng** → không biết cái gì gây lỗi, không lùi được. Tránh: `OPS-MAINT-005`.
5. **"Nợ kỹ thuật: (không có)"** trong PROGRESS khi còn 3 việc treo (thấy ở khung cũ) → nợ vô hình. Tránh: `OPS-MAINT-006`.
6. **Automerge major** vì "CI xanh" trong khi test không phủ hành vi đổi. Tránh: major luôn cần người.
7. **Bot AI sửa CI bằng cách skip test** để xanh. Tránh: `OPS-MAINT-011` + hook `ask`/`deny`.
8. **License đổi âm thầm giữa phiên bản** (BUSL/SSPL) lọt vào sản phẩm. Tránh: `OPS-MAINT-017`.
9. **Harness viết cho model cũ** chạy với model mới → hành vi lệch, không ai xét lại. Tránh: `OPS-MAINT-015`.
10. **Docs trạng thái tự khai** (PROGRESS ghi SHA không tồn tại/nhánh đã xoá). Tránh: CI kiểm SHA là ancestor của HEAD (`OPS-MAINT-010`).

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Bot cập nhật | Dependabot (GitHub) / Renovate 44.x (AGPL-3.0) | `groups`, `open-pull-requests-limit: 3`, lịch tuần, bỏ major | repo | cấu hình thiếu hệ sinh thái = đỏ (script) |
| PR bot quá hạn | script `gh pr list --author app/dependabot --json createdAt` | > 14 ngày | CI lịch tuần | > 0 = cảnh báo |
| EOL | script đọc `https://endoflife.date/api/<product>.json` | so phiên bản dùng với `eol` | CI lịch tuần | < 6 tháng = cảnh báo; đã EOL = đỏ |
| Lỗ hổng tuần | OSV-Scanner v2.7.0 / pip-audit 2.10.1 / `npm audit` | `schedule` tuần | CI | quá SLA = báo cáo đỏ |
| Dependency bỏ rơi | Scorecard `Maintained` / script release date | > 18 tháng | CI lịch tháng | liệt kê + ticket |
| Nợ kỹ thuật | script so `PROGRESS.md` với issue `tech-debt` | — | CI | "(không có)" mà còn issue = đỏ |
| Docs tươi | script frontmatter `updated`/`review_by`; `git merge-base --is-ancestor <sha> HEAD` | — | CI | quá 12 tháng/SHA lạ = cảnh báo/đỏ |
| Dead code / dep thừa | knip (ISC), vulture (MIT), depcheck (MIT) | lịch tháng | CI | báo cáo |
| License diff | dependency-review `deny-licenses`; SBOM diff | PR cập nhật | CI | license cấm = đỏ |
| Major upgrade PR | template + label | checklist bắt buộc | PR | thiếu = chặn |

## Nguồn

- GitHub Docs — Dependabot options reference (`groups`, `open-pull-requests-limit` mặc định 5, `ignore`/`update-types`): <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference> — xác minh 2026-10-13.
- endoflife.date API (Python 3.10 EOL 2026-10-01, 3.9 EOL 2025-10-31; Node 18 EOL 2025-04-30, 20 EOL 2026-04-30, 22 EOL 2027-04-30, 24 EOL 2028-04-30; Terraform/OpenTofu/PostgreSQL/Kubernetes cycles): <https://endoflife.date/api/python.json>, <https://endoflife.date/api/nodejs.json> — xác minh 2026-10-13.
- Renovate AGPL-3.0: <https://github.com/renovatebot/renovate/blob/main/license> — xác minh 2026-10-13; phiên bản 44.151.5 theo catalog `seeker19110/stored` 13 §4c (2026-10-12).
- OpenSSF Scorecard (check Maintained, Vulnerabilities, Dependency-Update-Tool): <https://scorecard.dev/> — xác minh 2026-10-13.
- NIST SP 800-218 SSDF v1.1 — RV.1 (phát hiện và xác nhận lỗ hổng liên tục): <https://csrc.nist.gov/pubs/sp/800/218/final> — xác minh 2026-10-13.
- Khung cũ X-stored `docs/ops/code-optimization-audit-prompt.md` (knip/depcheck/jscpd), `01-process-and-standards.md` GĐ 8, commit `1b80fe4`; `research/2026-10-13-old-framework-analysis.md` §3b (PROGRESS "Nợ kỹ thuật: (không có)").
- Catalog `seeker19110/stored` 23 §2.5 (Dependabot gom nhóm, WIP cap), §8.1 (Node 18/Python 3.9 EOL còn trong repo; mirror trôi upstream), 21 §2.2 (harness có hạn sử dụng), §8 điểm 9 (docs tươi bằng máy), §9 (agent sửa CI), đọc 2026-10-13.
- (chưa xác minh 2026-10-13) RFC 9745 Deprecation header, automerge docs của Dependabot/Renovate, knip/vulture/depcheck phiên bản — xác minh trước khi dẫn.
