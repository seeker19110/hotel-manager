---
title: Mã nguồn mở & cộng đồng: CONTRIBUTING, CoC, SECURITY.md, phát hành công khai
kind: module
prefix: XC-OSS
applies_to: [all]
updated: 2026-10-14
---

# Mã nguồn mở & cộng đồng: CONTRIBUTING, CoC, SECURITY.md, phát hành công khai

> Quy trình để một repo **công khai** (hoặc inner-source) nhận đóng góp an toàn và bền: bộ file sức khoẻ cộng đồng
> (LICENSE, README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, SUPPORT, GOVERNANCE), kênh báo lỗ hổng riêng tư với SLA,
> DCO/CLA, triage có nhãn và thời hạn, phát hành có ghi chú, điểm OpenSSF Scorecard/Badge. Lựa chọn **license và pháp
> lý IP** là nhà của [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md);
> chữ ký, provenance, trusted publishing ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md);
> SemVer/CHANGELOG ở [`../01-baseline/repo-and-versioning.md`](../01-baseline/repo-and-versioning.md).

## Nguyên tắc

- **Mở mã là mở trách nhiệm**: có người nhận báo lỗ hổng, có thời hạn phản hồi, có cách nói "không" (SCOPE).
- **Rào cản thấp cho đóng góp tốt, cao cho đóng góp xấu**: CONTRIBUTING rõ, CI chạy cho fork nhưng **không có bí mật**,
  review bắt buộc, không merge tự động từ bên ngoài.
- **Quy ước thắng thương lượng**: DCO/CLA, CoC, nhãn triage, thời hạn `needs-info` — ghi trước, áp đều.
- **Minh bạch vòng đời**: phiên bản hỗ trợ, lịch EOL, deprecation có thời gian, ghi chú phát hành cho người đọc.
- **Không thu hút sao, thu hút người bảo trì**: sao ≠ chất lượng (298k★ trên 684 commit — catalog 20 §3d).

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| License | Permissive (MIT/Apache-2.0 — Apache có điều khoản patent) cho thư viện/SDK; copyleft (GPL-3.0/AGPL-3.0) khi muốn mọi dẫn xuất mở; quyết định và tác động pháp lý ở [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md). | "Source-available" (BUSL/SSPL/FSL) gọi là open source — không OSI; ghi rõ nếu chọn. |
| DCO hay CLA? | **DCO 1.1** (`Signed-off-by`, kiểm bằng app/CI) cho hầu hết dự án: không ma sát pháp lý. | CLA khi cần chuyển nhượng/cấp phép lại (công ty có kế hoạch dual-license) — chi phí ma sát cao, cần quy trình ký. |
| Code of Conduct | **Contributor Covenant 3.0** (hoặc 2.1 đang dùng) + kênh báo cáo có ≥ 2 người nhận độc lập. | Tự viết CoC từ đầu. |
| Báo lỗ hổng | `SECURITY.md` + GitHub private vulnerability reporting (hoặc email PGP) + `security.txt`; SLA phản hồi ban đầu ≤ 14 ngày (OpenSSF Badge); phối hợp công bố 90 ngày mặc định. | Issue công khai cho lỗ hổng. |
| Quản trị | Dự án 1–3 maintainer: `GOVERNANCE.md` ngắn (ai quyết, cách thêm maintainer, bus factor); lớn hơn: mô hình rõ (BDFL/steering/meritocracy), `MAINTAINERS.md`. | Không ghi gì → tranh chấp khi có người thứ hai. |
| Phát hành | Tự động từ Conventional Commits (release-please/git-cliff/changesets), tag ký, artefact có SBOM + provenance (SLSA Build L2 từ M, L3 từ L — [`SEC-SUPPLY-014`/`015`](../12-security/supply-chain.md)), trusted publishing. | Phát hành từ máy cá nhân bằng token dài hạn. |

## Checklist

- [ ] `XC-OSS-001` **MUST** Bộ **file sức khoẻ cộng đồng** ở gốc/`.github/`/`docs/`: `LICENSE` (SPDX, OSI nếu gọi là open source), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md` (hoặc mục trong README), issue/PR template; GitHub community profile đầy đủ. → Kiểm: `gh api repos/{o}/{r}/community/profile --jq .health_percentage` = 100; file tồn tại theo đường dẫn GitHub chấp nhận. · Nguồn: GitHub community profile; default community health files
- [ ] `XC-OSS-002` **MUST@L** `CONTRIBUTING.md` nêu: cách dựng môi trường (trỏ README/`AGENTS.md`), tiêu chuẩn PR (conventional commit, test, lint, kích thước), quy trình review và thời gian phản hồi dự kiến, DCO/CLA, cách báo lỗi/đề xuất, phạm vi nhận (`SCOPE.md`). → Kiểm: script kiểm heading; GitHub hiện link CONTRIBUTING khi mở PR (file đúng vị trí). · Nguồn: GitHub "Setting guidelines for repository contributors"; OpenSSF Badge `contribution`, `contribution_requirements`
- [ ] `XC-OSS-003` **MUST@L** `CODE_OF_CONDUCT.md` dựa trên Contributor Covenant 3.0 (CC BY-SA 4.0) hoặc 2.1, có **kênh báo cáo thật** (email/biểu mẫu) tới ≥ 2 người, phạm vi áp dụng và thang xử lý; link từ README/CONTRIBUTING. → Kiểm: file có placeholder liên hệ đã điền (không còn `[INSERT CONTACT METHOD]`); test gửi thử tới kênh. · Nguồn: Contributor Covenant 3.0 / 2.1; opensource.guide (Code of Conduct)
- [ ] `XC-OSS-004` **MUST** `SECURITY.md` nêu phiên bản được hỗ trợ, cách báo riêng tư (GitHub private vulnerability reporting bật, hoặc email + khoá PGP), SLA phản hồi ban đầu ≤ 14 ngày, chính sách công bố phối hợp; dịch vụ công khai có `/.well-known/security.txt`. → Kiểm: `gh api repos/{o}/{r}` + settings bật PVR; `curl -f /.well-known/security.txt`; nhật ký báo cáo 6 tháng gần nhất phản hồi ≤ 14 ngày. · Nguồn: OpenSSF Badge `vulnerability_report_process`, `vulnerability_report_private`, `vulnerability_report_response`; RFC 9116; Scorecard Security-Policy
- [ ] `XC-OSS-005` **MUST** Mọi đóng góp qua **PR có review** của maintainer khác tác giả; CI chạy cho PR từ fork **không có bí mật** và với `permissions` chỉ đọc; không workflow `pull_request_target` chạy mã của fork với quyền ghi; workflow `issue_comment` có `contents: write` phải kiểm `author_association`. → Kiểm: ruleset `required_approving_review_count ≥ 1`; `actionlint` + review workflow: không `pull_request_target` checkout head của fork; grep `author_association` trong workflow có quyền ghi. · Nguồn: GitHub Actions security hardening; Scorecard Code-Review, Dangerous-Workflow; catalog 23 §8.1
- [ ] `XC-OSS-006` **MUST@L** Mỗi commit có **DCO** `Signed-off-by` (hoặc CLA đã ký) được CI kiểm; `CONTRIBUTING.md` giải thích `git commit -s`. → Kiểm: DCO app/`check-dco` job chặn PR thiếu trailer. · Nguồn: Developer Certificate of Origin 1.1
- [ ] `XC-OSS-007` **MUST** Phát hành công khai có: tag ký, ghi chú phát hành người đọc được (không phải git log) nêu breaking/deprecation/lỗ hổng đã vá (CVE id), artefact kèm checksum và SBOM; publish lên registry qua **trusted publishing/OIDC** với 2FA bắt buộc. → Kiểm: release có `sbom.*.json`, `SHA256SUMS`; workflow publish có `id-token: write`, không token tĩnh; `release_notes_vulns` được ghi khi có CVE. · Nguồn: OpenSSF Badge `release_notes`, `release_notes_vulns`; Scorecard Signed-Releases; [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `XC-OSS-008` **MUST@L** Chính sách **phiên bản hỗ trợ và deprecation** công bố: dòng nào nhận vá bảo mật, bao lâu, thông báo deprecation trước ≥ 1 phiên bản minor hoặc ≥ 6 tháng; bảng trong `SECURITY.md`/`docs/support-policy.md`. → Kiểm: bảng tồn tại và khớp tag thực tế; CHANGELOG có mục `Deprecated` trước `Removed`. · Nguồn: Keep a Changelog 1.1.0 (deprecations); OpenSSF Badge `version_semver`
- [ ] `XC-OSS-009` **MUST@L** Repo có ≥ 2 maintainer có quyền admin/publish (bus factor) và `GOVERNANCE.md`/`MAINTAINERS.md` nêu cách quyết định, thêm/bớt maintainer, và kế hoạch khi dự án ngừng (archive có thông báo, chuyển giao). → Kiểm: `gh api repos/{o}/{r}/collaborators?permission=admin` ≥ 2; file tồn tại. · Nguồn: Scorecard Maintained; OpenSSF Badge `bus_factor` (silver)
- [ ] `XC-OSS-010` **MUST@L** Điểm **OpenSSF Scorecard** ≥ 7/10 và/hoặc OpenSSF Best Practices Badge mức *passing*; các check High/Critical (Branch-Protection, Token-Permissions, Dangerous-Workflow, Vulnerabilities, Signed-Releases, Code-Review, Binary-Artifacts) không đỏ. → Kiểm: workflow `ossf/scorecard-action` upload SARIF; badge trong README trỏ kết quả thật. · Nguồn: OpenSSF Scorecard v5.6.0; OpenSSF Best Practices Badge
- [ ] `XC-OSS-011` **SHOULD** Triage có quy tắc: nhãn chuẩn (`bug`, `enhancement`, `good first issue`, `needs-info`, `out-of-scope`), issue template bắt buộc bước tái hiện, `needs-info` tự đóng sau 14 ngày không phản hồi, bot stale có ngoại lệ cho issue đã xác nhận; phản hồi ban đầu cho bug ≤ 7 ngày. → Kiểm: workflow `needs-info`/stale tồn tại; tỷ lệ issue 2–12 tháng được phản hồi > 50 %. · Nguồn: OpenSSF Badge `report_process`, `report_responses`; catalog 20 §3c (`needs-info` 14 ngày)
- [ ] `XC-OSS-012` **SHOULD** `SCOPE.md` + `.out-of-scope/` công khai tiêu chí nhận (failure quan sát được, hợp triết lý) và danh sách đã từ chối có lý do; `+1` không được tính là bằng chứng. → Kiểm: file tồn tại; issue bị đóng `out-of-scope` trỏ file tương ứng. · Nguồn: catalog 20 §3c; [`docs-for-ai-agents.md`](docs-for-ai-agents.md) XC-DOCAI-008
- [ ] `XC-OSS-013` **SHOULD** Tuân thủ **REUSE 3.3**: `LICENSES/<SPDX-id>.txt`, header `SPDX-License-Identifier`/`SPDX-FileCopyrightText` hoặc `REUSE.toml`; thông báo bên thứ ba (`THIRD_PARTY_NOTICES`) sinh từ SBOM. → Kiểm: `reuse lint` 0 lỗi trong CI; file notices cập nhật mỗi release. · Nguồn: REUSE Specification 3.3 (2024-11-14); SPDX License List 3.29.0
- [ ] `XC-OSS-014` **SHOULD** Phụ thuộc, action, image của dự án mở cũng ghim SHA và cập nhật tự động (Dependabot/Renovate cho `github-actions`, gói, docker); PR bot có nhãn `no-changelog`. → Kiểm: `pinact run --check`; `dependabot.yml` đủ hệ sinh thái. · Nguồn: Scorecard Pinned-Dependencies, Dependency-Update-Tool; [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `XC-OSS-015` **SHOULD** Thương hiệu/tên: tên gói không xung đột trên registry (đăng ký giữ chỗ scope), không dùng tên/logo của tổ chức khác (vd điều khoản "không dùng thương hiệu Claude Code" trong Agent SDK terms), `TRADEMARKS.md` nếu có nhãn hiệu. → Kiểm: tên đã đăng ký trên npm/PyPI/crates; review license của logo. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md); [`../../research/2026-10-13-ai-agent-research.md`](../../research/2026-10-13-ai-agent-research.md) (Agent SDK terms)
- [ ] `XC-OSS-016` **SHOULD** Repo công khai **không chứa và chưa từng chứa** bí mật, dữ liệu người dùng, URL nội bộ; trước khi mở mã từ repo riêng tư: quét toàn lịch sử, cân nhắc tạo lịch sử mới. → Kiểm: gitleaks `--log-opts=--all` = 0; checklist "mở mã" ghi ngày thực hiện. · Nguồn: OWASP Secrets Management CS; [`../01-baseline/security-minimum.md`](../01-baseline/security-minimum.md)
- [ ] `XC-OSS-017` **MAY** Đóng góp do AI sinh được khai báo (nhãn/mục trong PR template: công cụ nào, người đã review), và CONTRIBUTING nói rõ chính sách (chấp nhận có review người; không chấp nhận PR hàng loạt không có người chịu trách nhiệm). → Kiểm: PR template có ô; nhãn `ai-assisted` dùng được. · Nguồn: P11 (minh bạch khi dùng AI); catalog 22 §9c (tách quyền job có model)
- [ ] `XC-OSS-018` **MAY** Kênh cộng đồng (Discussions/Discord/mailing list) được ghi trong `SUPPORT.md` với kỳ vọng phản hồi; FUNDING.yml nếu nhận tài trợ. → Kiểm: `SUPPORT.md` tồn tại; link sống (lychee). · Nguồn: GitHub default community health files
- [ ] `XC-OSS-019` **MAY** Mirror/fork phải **cite upstream** và ghi khác biệt; kiểm trạng thái upstream (archive/đổi tên) định kỳ. → Kiểm: README fork có mục "Upstream" + commit base. · Nguồn: catalog WORKFLOW/README §18 (mirror cite upstream)

## Bẫy thường gặp

- **"Open source" nhưng license BUSL/SSPL/FSL** → người dùng doanh nghiệp bị chặn, cộng đồng mất niềm tin. Nói đúng: source-available.
- **`SECURITY.md` có email không ai đọc**; báo cáo lỗ hổng nằm 3 tháng rồi bị công bố 0-day. SLA + ≥ 2 người nhận + tự gửi thử định kỳ.
- **`pull_request_target` + checkout head của fork** → kẻ lạ chạy mã với `GITHUB_TOKEN` ghi và bí mật. Chỉ `pull_request` cho fork; không bí mật.
- **Workflow `issue_comment` có `contents: write`** không kiểm `author_association` → ai bình luận cũng kích được bot ghi repo (catalog 23 §8.1).
- **Bot stale đóng cả bug đã xác nhận** → cộng đồng giận. Ngoại lệ theo nhãn; `needs-info` mới tự đóng.
- **Không có `SCOPE.md`** → mỗi tính năng đề xuất là một cuộc tranh luận lặp; maintainer kiệt sức. Viết "không" một lần, trỏ về.
- **Một maintainer giữ khoá publish**; nghỉ việc là dự án chết hoặc bị chiếm (lịch sử npm). ≥ 2 admin, trusted publishing.
- **Mở mã repo riêng tư nguyên lịch sử** chứa khoá cũ, dữ liệu test thật. Quét toàn lịch sử trước; cân nhắc lịch sử mới.
- **Sao làm thước đo** — 298k★/684 commit, 11/201 repo "official" đã archive (catalog 04 §2c). Đo Maintained, Code-Review, phản hồi issue.
- **CoC chép template để nguyên `[INSERT CONTACT METHOD]`** — có cũng như không. Điền và kiểm.
- **Skill/plugin không có LICENSE, link mạo danh** (catalog: Awesome-AI-Security-Skills) — không cài, không dẫn.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Community profile | GitHub API | `gh api repos/{o}/{r}/community/profile --jq .health_percentage` | cron tuần | 100 |
| Scorecard | ossf/scorecard v5.6.0 (Apache-2.0) `scorecard-action` | `scorecard --repo=github.com/{o}/{r} --format=json` | cron tuần + badge | ≥ 7; không check Critical đỏ |
| DCO | DCO GitHub App / `check-dco` script (`git log --format=%B \| grep Signed-off-by`) | job CI | PR | 100 % commit |
| Workflow nguy hiểm | actionlint v1.7.12 (MIT) · zizmor (MIT) · Scorecard Dangerous-Workflow | `zizmor .github/workflows` | CI | 0 high |
| REUSE | reuse 6.2.0 (Apache-2.0) | `reuse lint` | CI | 0 lỗi |
| SECURITY/CoC điền đủ | script grep placeholder (`INSERT`, `TODO`, `example.com`) | `check:health-files` | CI | 0 placeholder |
| security.txt | curl | `curl -f https://<host>/.well-known/security.txt` | smoke | 200, `Expires` < 1 năm |
| Triage | workflow `needs-info`/stale (actions/stale, MIT) | — | cron | `needs-info` đóng sau 14 ngày |
| Phát hành | release-please v17.11.2 / git-cliff v2.14.2 · syft v1.54.1 · cosign (Apache-2.0) | theo [`../12-security/supply-chain.md`](../12-security/supply-chain.md) | release | SBOM + checksum + chữ ký |
| Bí mật lịch sử | gitleaks v8.30.1 (MIT) | `gitleaks git --log-opts=--all` | trước khi mở mã + cron | 0 |

## Nguồn

- GitHub — community profiles: <https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories>; default community health files (`.github` repo; thứ tự `.github` → gốc → `docs`): <https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file>; CONTRIBUTING: <https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors> — xác minh 2026-10-13
- GitHub — security policy (`SECURITY.md`): <https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository>; private vulnerability reporting: <https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository> — xác minh 2026-10-13
- GitHub Actions security hardening (fork, `pull_request_target`, permissions): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13
- Contributor Covenant 3.0 (CC BY-SA 4.0; thang 4 bước) và 2.1 (Correction/Warning/Temporary Ban/Permanent Ban): <https://www.contributor-covenant.org/version/3/0/code_of_conduct/>, <https://www.contributor-covenant.org/version/2/1/code_of_conduct/> — xác minh 2026-10-13; ngày phát hành 3.0 **(chưa xác minh)**
- opensource.guide — Your Code of Conduct: <https://opensource.guide/code-of-conduct/> — xác minh 2026-10-13; choosealicense.com (GitHub): <https://choosealicense.com/> — xác minh 2026-10-13
- Developer Certificate of Origin 1.1 (Linux Foundation): <https://developercertificate.org/> — xác minh 2026-10-13
- OpenSSF Best Practices Badge criteria (passing: `contribution`, `report_process`, `vulnerability_report_*` 14 ngày, `release_notes`, `floss_license_osi`): <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13; mức silver `bus_factor` **(chưa xác minh — chỉ đọc trang passing)**
- OpenSSF Scorecard v5.6.0 (Apache-2.0; checks và mức rủi ro): <https://github.com/ossf/scorecard> — xác minh 2026-10-13
- RFC 9116 security.txt: <https://www.rfc-editor.org/rfc/rfc9116> — xác minh 2026-10-13
- REUSE Specification 3.3 (2024-11-14): <https://reuse.software/spec-3.3/> — xác minh 2026-10-13; reuse 6.2.0 (PyPI) — xác minh 2026-10-13; SPDX License List 3.29.0: <https://spdx.org/licenses/> — xác minh 2026-10-13
- SLSA v1.2 là bản hiện hành (v1.1 đã retired): <https://slsa.dev/spec/v1.1/levels> — xác minh 2026-10-13
- Keep a Changelog 1.1.0: <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13
- Catalog `seeker19110/stored` 20 §3c–3d (SCOPE.md, `needs-info` 14 ngày, sao ≠ chất lượng), 04 §2c (5,5 % repo "official" archive), 22 §9c, 23 §8.1 (`author_association`, ma trận vệ sinh), README §18 (mirror cite upstream) theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md), đọc 2026-10-13.
