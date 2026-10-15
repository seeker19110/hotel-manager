---
title: Chuỗi cung ứng: ghim, SBOM, chữ ký, SLSA, Scorecard, Dependabot
kind: module
prefix: SEC-SUPPLY
applies_to: [all]
updated: 2026-10-15
---

# Chuỗi cung ứng: ghim, SBOM, chữ ký, SLSA, Scorecard, Dependabot

> **Nhà** của bảo mật chuỗi cung ứng phần mềm: thứ gì đi vào build (dependency, action CI, image nền, tool tải về, skill/MCP) phải
> được ghim, kiểm checksum/chữ ký, quét lỗ hổng và liệt kê trong SBOM; thứ gì đi ra (artifact, image, package) phải có provenance
> và chữ ký. [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md) giữ mức tối thiểu và trỏ về đây; lịch cập nhật phụ
> thuộc thuộc [`../15-operations/maintenance-and-lifecycle.md`](../15-operations/maintenance-and-lifecycle.md).

## Nguyên tắc

- **Ghim theo nội dung, không theo tên**: tag/branch/`latest` có thể bị đổi; SHA commit, digest image, checksum file thì không. Ghim kèm
  comment phiên bản để người đọc hiểu (`uses: actions/checkout@<sha> # v4.2.2`).
- **Lockfile là hợp đồng**: cài bằng chế độ "đúng lockfile" (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`, `go mod verify`,
  `cargo --locked`); CI đỏ khi lockfile thay đổi ngoài ý muốn.
- **Lỗ hổng mới xuất hiện dù lockfile không đổi** → quét theo lịch (tuần), không chỉ khi có PR.
- **Pipeline là production**: runner, token, action bên thứ ba có quyền ghi vào repo/registry — áp cùng chuẩn (quyền tối thiểu, ghim,
  không fail-open) như ứng dụng. CI có AI đọc issue/PR công khai là ranh giới tin cậy (prompt injection vào workflow).
- **Tài sản prompt là chuỗi cung ứng**: skill, MCP server, định nghĩa agent, system prompt được cài/vendor như dependency — có lock, hash, review.
- **Chống "làm cổng xanh bằng nới cấu hình"**: sửa file cổng (eslint/tsconfig/coverage/workflow/migration đã áp) là thay đổi rủi ro cao, cần
  người duyệt — đặc biệt khi agent tự sửa.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Cập nhật dependency tự động | **Dependabot** (có sẵn GitHub; gom nhóm `groups`, `open-pull-requests-limit` mặc định 5) | **Renovate** (AGPL-3.0, v44.x) khi cần đa nền tảng/đa registry/quy tắc phức tạp; AGPL không ảnh hưởng sản phẩm vì chạy như dịch vụ riêng — vẫn ghi vào license review |
| Quét lỗ hổng dependency | **OSV-Scanner** v2.7.0 (Apache-2.0, offline được, quét cả lockfile + image) | `npm audit`/`pip-audit` 2.10.1/`govulncheck`/`cargo audit` theo hệ sinh thái khi chỉ một ngôn ngữ; Trivy (Apache-2.0) khi cần quét image + IaC một tool — **ghim SHA + kiểm checksum** (từng có sự cố CVE-2026-33634) |
| Chặn lỗ hổng mới trong PR | `actions/dependency-review-action` với `fail-on-severity: high` + `deny-licenses` | Ngoài GitHub → OSV-Scanner diff mode hoặc Renovate vulnerability alerts |
| SBOM | **syft** v1.54.1 (Apache-2.0) xuất **CycloneDX 1.7** (ECMA-424) | SPDX 3.0 (bản ISO/IEC 5962:2021 tương ứng SPDX 2.2.1) khi đối tác yêu cầu; `cyclonedx-*` plugin của build tool khi cần SBOM từ bước build |
| Ký artifact/image | **cosign** v3.1.3 (Sigstore, keyless qua OIDC) + attestation SLSA provenance | Ký bằng khoá KMS khi không có OIDC identity ổn định; npm provenance (`--provenance`) cho package npm |
| Mức SLSA | Build **L2** (hosted builder ký provenance) cho M; **L3** cho L hoặc thư viện nhiều người dùng | L1 (chỉ sinh provenance) cho S |
| Đánh giá dependency trước khi thêm | OpenSSF Scorecard v5.6.0 (check Maintained, Vulnerabilities, Pinned-Dependencies, Dangerous-Workflow…) + `deps.dev` | Repo archive/đổi tên/không license → không thêm; vendor có lock nếu bắt buộc |
| Policy-as-code cho cấu hình | **OPA/conftest** v0.71.1 (Apache-2.0) kiểm workflow/manifest/Dockerfile | checkov cho IaC cloud; cả hai khi có nhiều loại file |
| Ghim action GitHub | `pinact` (tự động ghim SHA + comment) + `zizmor` 1.30.1 (MIT) phân tích tĩnh workflow | `ratchet`; Scorecard check Pinned-Dependencies để đo |
| Skill/MCP/plugin cho agent | Vendor có lock (`sha256` từng file, pin commit, prefix tên) + quét tĩnh trong sandbox trước khi cài | Cài trực tiếp từ marketplace chỉ khi nguồn kiểm duyệt từng dòng hook/script (vd trailofbits/skills-curated) |

## Checklist

- [ ] `SEC-SUPPLY-001` **MUST** Mọi `uses:` trong workflow CI ghim **SHA commit 40 ký tự** kèm comment phiên bản; không dùng tag/branch. → Kiểm: `zizmor .github/workflows` (rule `unpinned-uses`) = 0; Scorecard Pinned-Dependencies = 10; `rg "uses: .*@(v|main|master)" .github` = 0. · Nguồn: GitHub Actions hardening; OpenSSF Scorecard; catalog stored 23 §8.1
- [ ] `SEC-SUPPLY-002` **MUST@L** Mọi workflow có khối `permissions:` cấp đầu tối thiểu (`contents: read` mặc định); job cần ghi nâng quyền riêng ở cấp job. → Kiểm: `zizmor` rule `excessive-permissions` = 0; Scorecard Token-Permissions = 10. · Nguồn: GitHub Actions hardening; Scorecard
- [ ] `SEC-SUPPLY-003` **MUST** Cài dependency ở chế độ khoá đúng lockfile (`npm ci`/`pnpm --frozen-lockfile`/`uv sync --locked`/`go mod verify`/`cargo --locked`); lockfile commit và CI đỏ nếu lockfile đổi sau cài. → Kiểm: lệnh cài trong CI; bước `git diff --exit-code <lockfile>` sau cài. · Nguồn: NIST SSDF PW.4; SLSA (build nhất quán)
- [ ] `SEC-SUPPLY-004` **MUST@L** Image nền Docker ghim **digest** (`FROM python:3.13-slim@sha256:…`) và được quét lỗ hổng trước khi dùng. → Kiểm: `rg "^FROM .*@sha256:" Dockerfile*` khớp mọi `FROM`; OSV-Scanner/Trivy quét image = 0 critical. · Nguồn: NIST SP 800-190 §4.1; Scorecard Pinned-Dependencies
- [ ] `SEC-SUPPLY-005` **MUST@L** Tool tải về trong CI/script cài (binary, installer) kiểm **checksum** từ file `tool-checksums.txt` trong repo; cấm `curl … | sh`/`iwr … | iex`. → Kiểm: `rg "curl[^|]*\|\s*(ba)?sh" -g '!docs/**'` = 0; script tải có `sha256sum -c`. · Nguồn: catalog stored 12 §3 (Trivy backdoor); SLSA (toàn vẹn đầu vào)
- [ ] `SEC-SUPPLY-006` **MUST** Quét lỗ hổng dependency (OSV-Scanner hoặc tool hệ sinh thái) trên mỗi PR **và theo lịch tuần**; critical/high chưa có ngoại lệ có hạn = đỏ. → Kiểm: workflow `osv-scanner` chạy `pull_request` + `schedule`; file ngoại lệ `osv-scanner.toml` có `reason` + ngày hết hạn. · Nguồn: OWASP Top 10:2025 A03; catalog stored 12 (pip-audit tuần)
- [ ] `SEC-SUPPLY-007` **MUST@L** PR thêm/nâng dependency qua dependency review: chặn lỗ hổng ≥ high và license ngoài allowlist. → Kiểm: `actions/dependency-review-action` với `fail-on-severity: high`, `allow-licenses`/`deny-licenses`; ngoài GitHub → OSV-Scanner diff + license check trong CI. · Nguồn: GitHub dependency review docs; [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)
- [ ] `SEC-SUPPLY-008` **MUST@L** Dependency mới được đánh giá trước khi thêm: còn bảo trì, license OSI/khớp allowlist, không archive/đổi chủ, Scorecard ≥ ngưỡng đội chọn. → Kiểm: PR thêm dependency có mục "Đánh giá" (link Scorecard/deps.dev); script chặn package có license ngoài allowlist. · Nguồn: OpenSSF Scorecard; evidence-and-sources §1.7
- [ ] `SEC-SUPPLY-009` **MUST** Workflow chạy trên `issue_comment`/`pull_request_target`/`workflow_run` có quyền ghi phải kiểm `author_association` (OWNER/MEMBER/COLLABORATOR) và **không checkout code của fork**. → Kiểm: `zizmor` rule `dangerous-triggers`/`template-injection` = 0; Scorecard Dangerous-Workflow = 10; grep workflow có `pull_request_target` + `ref: …head.sha` = 0. · Nguồn: GitHub Actions hardening; catalog stored 23 §8.1 (lỗi kế thừa từ upstream của một fork skill red-team)
- [ ] `SEC-SUPPLY-010` **MUST@L** CI có bước AI (đọc issue/PR/comment) tách thành hai job: job có model chỉ **đọc + soạn nháp** với token read-only; job khác không có model mới được ghi/đăng, sau khi qua kiểm máy. → Kiểm: workflow có 2 job, job model `permissions: contents: read` và không có bước `gh pr comment`/push. · Nguồn: catalog stored 12 (CI có AI), 21 §4 (gh-aw safe-outputs); OWASP ASI01
- [ ] `SEC-SUPPLY-011` **MUST@L** Sửa file cổng chất lượng (`eslint*`, `tsconfig*`, cấu hình coverage, `.github/workflows/*`, migration đã áp, `codecov`/`sonar`) cần người duyệt riêng; agent tự động chỉ được đề xuất. → Kiểm: hook `PreToolUse` `ask` cho các path này + `deny` cho migration đã áp; CODEOWNERS yêu cầu review nhóm bảo mật; CI đỏ khi coverage threshold giảm. · Nguồn: catalog stored 12 §3, 23 §4.3; [`../11-autonomous-loop/self-healing-ci.md`](../11-autonomous-loop/self-healing-ci.md)
- [ ] `SEC-SUPPLY-012` **MUST@L** Sinh SBOM (CycloneDX 1.7 hoặc SPDX 3.0) cho mỗi bản phát hành/image, lưu kèm artifact và quét lại SBOM theo lịch. → Kiểm: `syft <image|dir> -o cyclonedx-json > sbom.cdx.json` trong workflow release; artifact tồn tại; `osv-scanner --sbom sbom.cdx.json` chạy tuần. · Nguồn: NIST SSDF PS.3.2; CycloneDX ECMA-424
- [ ] `SEC-SUPPLY-013` **MUST@L** Image/artifact phát hành được ký (cosign keyless qua OIDC) kèm attestation provenance; môi trường deploy **chỉ chạy artifact có chữ ký hợp lệ**. → Kiểm: `cosign sign` + `cosign attest --predicate provenance.json` trong release; admission policy (Kyverno/Sigstore policy-controller/`cosign verify` trong deploy script) chặn image không ký. · Nguồn: SLSA v1.2 Build L2; Sigstore docs
- [ ] `SEC-SUPPLY-014` **MUST@L** Đạt SLSA Build L2: build trên hosted builder, provenance do builder sinh và ký, người tiêu thụ xác minh. → Kiểm: `slsa-framework/slsa-github-generator` (hoặc tương đương) sinh provenance; `slsa-verifier`/`cosign verify-attestation` trong pipeline deploy. · Nguồn: SLSA v1.2 spec
- [ ] `SEC-SUPPLY-015` **MUST@L** Đạt SLSA Build L3 (builder cách ly, khoá ký không truy cập được từ bước build do người dùng định nghĩa) cho artifact phân phối rộng (thư viện, image public, installer). → Kiểm: provenance ghi builder id đạt L3; chính sách verify yêu cầu L3. · Nguồn: SLSA v1.2 Build L3
- [ ] `SEC-SUPPLY-016` **MUST@L** (nhà của vendor-lock skill/MCP/plugin) Skill/MCP server/plugin cho agent được **vendor có lock** (pin commit, `sha256` từng file, prefix tên) hoặc cài từ nguồn kiểm duyệt; quét tĩnh (SkillSpector/skill-scanner/agent-scan) **trong sandbox** trước khi cài; tự đọc `install.sh`, hook, lệnh sửa `~/.claude/settings.json`. → Kiểm: file lock (`skills.lock.json`) có hash; CI so hash thực tế với lock; log quét lưu `docs/security/`. · Nguồn: catalog stored 12 §3e, 20 §3b; OWASP MCP Top 10 MCP03/MCP04; ASI04; OWASP LLM 2026 LLM04
- [ ] `SEC-SUPPLY-017` **MUST@L** Tool list/mô tả của MCP server được ghim (hash mô tả + phiên bản server); mô tả đổi → chặn và báo (chống tool poisoning/rug pull). → Kiểm: test khởi động so hash `tools/list` với lock; thay đổi = fail. · Nguồn: MCP spec (tool description là untrusted); OWASP MCP Top 10 MCP03; khung cũ spec C2-FR-07
- [ ] `SEC-SUPPLY-018` **SHOULD** Dependabot/Renovate bật cho **mọi** hệ sinh thái trong repo (npm/pip/go/docker/github-actions), gom nhóm minor+patch, giới hạn PR mở theo WIP cap, bỏ qua major (xử lý có kế hoạch). → Kiểm: `dependabot.yml` có đủ `package-ecosystem` theo file manifest tồn tại; `groups` + `open-pull-requests-limit` đặt rõ. · Nguồn: GitHub Dependabot options reference; catalog stored 23 §2.5
- [ ] `SEC-SUPPLY-019` **SHOULD** Workflow CI qua policy-as-code (conftest với rule Rego: ghim SHA, permissions, không `curl|sh`, không `continue-on-error` ở job cổng). → Kiểm: `conftest test .github/workflows -p policy/ci` trong CI; rule có test riêng. · Nguồn: catalog stored 12 §3 (OPA/conftest), 23 §3.3 (fitness function cho CI)
- [ ] `SEC-SUPPLY-020` **SHOULD** Tự đo Scorecard cho repo của mình theo lịch và giữ điểm không giảm. → Kiểm: `ossf/scorecard-action` tuần, kết quả lên code-scanning; ngưỡng tổng ≥ 7 (đội tự chọn, ghi ADR). · Nguồn: OpenSSF Scorecard
- [ ] `SEC-SUPPLY-021` **SHOULD** Package tự phát hành (npm/PyPI/crates) bật provenance/trusted publishing qua OIDC; không dùng token tĩnh dài hạn. → Kiểm: `npm publish --provenance`/PyPI trusted publisher cấu hình; registry hiển thị provenance. · Nguồn: SLSA; npm/PyPI docs (chưa fetch lại 2026-10-13)
- [ ] `SEC-SUPPLY-022` **SHOULD** Runner CI tự host (nếu có) là ephemeral, không chạy job từ fork, không mount docker socket. → Kiểm: cấu hình runner `--ephemeral`; chính sách repo không cho fork dùng self-hosted runner. · Nguồn: GitHub Actions hardening (self-hosted runners)
- [ ] `SEC-SUPPLY-023` **MAY** Mirror/proxy registry nội bộ (Artifactory/Nexus/`verdaccio`) với quarantine package mới < N ngày để tránh typosquat/compromise mới công bố. → Kiểm: `.npmrc`/`pip.conf` trỏ mirror. · Nguồn: kinh nghiệm vận hành
- [ ] `SEC-SUPPLY-024` **MAY** Lockfile cho workflow (khi nền tảng hỗ trợ) thay/bổ sung ghim SHA. → Kiểm: file lock workflow tồn tại và CI kiểm. · Nguồn: GitHub Actions hardening (lockfile ưu tiên hơn SHA khi có)
- [ ] `SEC-SUPPLY-025` **SHOULD** Đánh giá dependency/skill/tool trên **repo gốc**, không trên bản mirror hay fork: chủ repo khớp đường dẫn module (`go.mod`, `package.json` `repository`, trang registry) và tác giả commit; sao/fork của mirror không phải tín hiệu chất lượng (repo gốc có thể đã bị gỡ vì lạm dụng). → Kiểm: mục "Đánh giá" trong PR thêm dependency ghi URL repo gốc + bằng chứng khớp (dòng `module`/`repository`). · Nguồn: `seeker19110/stored` 12 §3k (ARTEX, mirror Hinln/ARTEX)
- [ ] `SEC-SUPPLY-026` **SHOULD** Số commit, số sao và bảng thống kê trong README không dùng làm bằng chứng "còn bảo trì": đọc lịch sử thật (`git log --format='%an %s'`), loại commit bot/tự động ghi timestamp, xem ngày commit người viết gần nhất và lịch sử advisory/gỡ bỏ; tool dual-use đã có lạm dụng thật hoặc bị tác giả rút về thì không đưa vào dự án. → Kiểm: mục "Đánh giá" ghi số commit người viết trong 12 tháng (lệnh + kết quả) và kết quả tra advisory. · Nguồn: `seeker19110/stored` 12 §3j (s4ntrx: 5.340/5.571 commit là bot), 12 §3k

## Bẫy thường gặp

1. **Ghim `@v4` và coi là ghim.** Tag di chuyển được; sự cố `tj-actions/changed-files` (2025) là ví dụ tag bị trỏ sang commit độc. Tránh: `SEC-SUPPLY-001` + `pinact`.
2. **Dependabot chỉ cho npm**, bỏ `github-actions`/`docker`/`pip` → action và image nền không bao giờ được cập nhật (đo thật: 0/42 action ghim ở một repo, catalog 23 §8.1).
3. **Scan chỉ khi có PR.** Lỗ hổng mới công bố cho phiên bản đang dùng không tạo PR → không ai biết. Tránh: lịch tuần (`SEC-SUPPLY-006`).
4. **`continue-on-error: true` ở job cổng** để "CI đừng đỏ" → cổng không còn là cổng. Tránh: policy conftest cấm; `/gate` đọc job thật.
5. **Tắt rule/giảm coverage để xanh** — agent tự sửa CI hay làm. Tránh: hook `ask`/`deny` + CODEOWNERS (`SEC-SUPPLY-011`).
6. **`issue_comment` + `contents: write` không kiểm `author_association`** → ai cũng kích hoạt được job có quyền ghi (lỗi kế thừa từ upstream trong một fork, catalog 23 §8.1).
7. **Trust marketplace vì nhiều sao.** Ví dụ list skill bảo mật: nhiều mục không LICENSE, link 404, installer sửa `~/.claude/settings.json`, repo cá nhân gắn tên hãng (catalog 12 §3e). Tránh: `SEC-SUPPLY-016`.
8. **SBOM sinh một lần rồi quên.** SBOM có giá trị khi được quét lại khi có CVE mới. Tránh: lưu SBOM theo phiên bản + quét tuần.
9. **Trivy/scanner tải từ `install.sh` không checksum** → chính công cụ bảo mật là vector tấn công. Tránh: `SEC-SUPPLY-005`.
10. **Ký nhưng không verify.** `cosign sign` xong mà deploy không `cosign verify` → chữ ký chỉ để trang trí. Tránh: `SEC-SUPPLY-013` phần admission.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Ghim SHA + permissions + trigger nguy hiểm | zizmor 1.30.1 (MIT); pinact | `zizmor --min-severity medium .github/workflows`; `pinact run` để sửa | pre-commit + CI | finding ≥ medium = đỏ |
| Lint workflow | actionlint (MIT) | `actionlint` | pre-commit + CI | lỗi = đỏ |
| Lỗ hổng dependency | OSV-Scanner v2.7.0 (Apache-2.0) | `osv-scanner scan source -r . --config osv-scanner.toml` | CI PR + `schedule` tuần | critical/high không ngoại lệ = đỏ |
| Lỗ hổng Python/Node riêng | pip-audit 2.10.1; `npm audit --audit-level=high` | — | CI | high = đỏ |
| Diff dependency PR | actions/dependency-review-action | `fail-on-severity: high`, `deny-licenses: GPL-3.0, AGPL-3.0` (theo chính sách) | CI PR | đỏ |
| SBOM | syft v1.54.1 (Apache-2.0) | `syft dir:. -o cyclonedx-json=sbom.cdx.json` | release | artifact bắt buộc |
| Ký + provenance | cosign v3.1.3 (Apache-2.0) | `cosign sign --yes <image@digest>`; `cosign attest --type slsaprovenance` | release | thiếu = không deploy |
| Verify khi deploy | cosign / Kyverno / policy-controller | `cosign verify --certificate-identity-regexp … --certificate-oidc-issuer …` | deploy | fail = dừng |
| Policy workflow/Dockerfile | conftest v0.71.1 (Apache-2.0) | `conftest test .github Dockerfile -p policy/` | CI | deny = đỏ |
| Checksum tool tải về | sha256sum + `tool-checksums.txt` | `sha256sum -c tool-checksums.txt` | script cài / CI | lệch = dừng |
| Scorecard | ossf/scorecard-action v5.6.0 (Apache-2.0) | lịch tuần, publish SARIF | CI | điểm giảm = cảnh báo |
| Hash skill/MCP | script repo | so `skills.lock.json` với file thật; so hash `tools/list` | CI + khởi động agent | lệch = fail |

## Nguồn

- SLSA v1.2 (Approved; Build L0–L3, Source track): <https://slsa.dev/spec/v1.2/> và <https://slsa.dev/spec/v1.2/build-track-basics> — xác minh 2026-10-13.
- OpenSSF Scorecard v5.6.0 và danh sách check: <https://scorecard.dev/>, <https://github.com/ossf/scorecard/releases/latest> — xác minh 2026-10-13.
- GitHub Docs — Security hardening for GitHub Actions (ghim SHA, `permissions`, `pull_request_target`, script injection): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- GitHub Docs — Dependabot options reference (`groups`, `open-pull-requests-limit` mặc định 5): <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference> — xác minh 2026-10-13; About dependency review: <https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review> — xác minh 2026-10-13.
- NIST SP 800-218 SSDF v1.1 (PS.3, PW.4): <https://csrc.nist.gov/pubs/sp/800/218/final> — xác minh 2026-10-13.
- OWASP Top 10:2025 A03 Software Supply Chain Failures, A08 Integrity Failures: <https://top10.owasp.org/2025> — xác minh 2026-10-13.
- OWASP MCP Top 10 (MCP01–MCP10, living document, CC BY-NC-SA 4.0): <https://github.com/OWASP/www-project-mcp-top-10> — xác minh 2026-10-13.
- CycloneDX 1.7 (2025-10-21; ECMA-424): <https://cyclonedx.org/specification/overview/>; SPDX 3.0; ISO/IEC 5962:2021 tương ứng SPDX 2.2.1: <https://spdx.dev/use/specifications/> — xác minh 2026-10-13 (đính chính 2026-10-14: bản trước ghi như thể ISO/IEC 5962:2021 là SPDX 3.0).
- Phiên bản tool (tag xác minh 2026-10-13, trang GitHub không hiện năm): syft v1.54.1, cosign v3.1.3, conftest v0.71.1, OSV-Scanner v2.7.0 (12/10/2026 theo catalog 12 §3d), checkov 3.3.28 + pip-audit 2.10.1 + zizmor 1.30.1 (PyPI, 2026-10-13); Renovate AGPL-3.0 (LICENSE fetch 2026-10-13), 44.151.5 theo catalog 13 (2026-10-12).
- Catalog `seeker19110/stored` 12 §3 (7 quy tắc, supply chain, CI có AI), 23 §8.1 (ma trận vệ sinh), 20 §3b (vendor-with-lock), đọc 2026-10-13. Sự cố tj-actions/changed-files 2025 và Trivy CVE-2026-33634: ghi theo catalog, (chưa xác minh lại nguồn gốc ngày 2026-10-13).
- Catalog `seeker19110/stored` 12 §3j (số commit do bot ghi timestamp, bảng thống kê README sai), 12 §3k (ARTEX: tool dual-use bị lạm dụng, tác giả gỡ, sao dồn về mirror) — đọc 2026-10-15.
