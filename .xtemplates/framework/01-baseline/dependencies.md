---
title: Phụ thuộc: lockfile, cập nhật, license, lỗ hổng
kind: baseline
prefix: BASE-DEP
applies_to: [all]
updated: 2026-10-14
---

# Phụ thuộc: lockfile, cập nhật, license, lỗ hổng

> Sàn cho mọi phần mềm có phụ thuộc bên ngoài (gói, runtime, image, action CI, model): khai báo tường minh, **đóng băng**
> bằng lockfile, runtime trong cửa sổ hỗ trợ, quét lỗ hổng và license trong CI, cập nhật có nhịp. Ghim SHA, SBOM,
> chữ ký, SLSA, Scorecard là nhà của [`../12-security/supply-chain.md`](../12-security/supply-chain.md); chính sách
> license/IP ở [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md).

## Nguyên tắc

- **Khai báo và cô lập** (12-factor II): không dựa vào gói "có sẵn trên máy"; manifest + lockfile + cài đặt đóng băng.
- **Ít hơn là tốt hơn** (P3): mỗi phụ thuộc là bề mặt tấn công, chi phí cập nhật và rủi ro license. Thêm phụ thuộc là
  quyết định có lý do.
- **Lỗ hổng mới xuất hiện trên lockfile cũ**: quét theo lịch, không chỉ khi lockfile đổi.
- **Kiểm trạng thái trước khi tin**: repo archive? đổi chủ? license đổi? telemetry mặc định? (evidence-and-sources luật 7).
- **Runtime cũng là phụ thuộc**: Node/Python/Go/JDK/.NET hết hỗ trợ = không có vá bảo mật.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Cài trong CI | `npm ci` / `pnpm install --frozen-lockfile` / `yarn --immutable` · `uv sync --locked` hoặc `pip install --require-hashes -r requirements.txt` · `go build -mod=readonly` · `cargo build --locked` · `dotnet restore --locked-mode`. | Không bao giờ `npm install`/`pip install pkg` không lock trong CI. |
| Cập nhật tự động | **Dependabot** (có sẵn GitHub, gom nhóm, `cooldown` mặc định 3 ngày) hoặc **Renovate** 44.x (AGPL-3.0, dịch vụ/self-host; đa nền tảng). Gom nhóm minor/patch, 1 PR/tuần, bỏ major để duyệt tay. | Repo không trên GitHub/GitLab: Renovate self-host. |
| Quét lỗ hổng | **OSV-Scanner 2.7.x** (đa hệ sinh thái, Apache-2.0) + công cụ bản địa (`pip-audit`, `npm audit`, `cargo audit`, `govulncheck`, `dotnet list package --vulnerable`). | Trivy/Grype cho image; Dependency-Check cho Java/.NET khi cần báo cáo offline. |
| Ghim phiên bản thế nào | Manifest: phạm vi tương thích (`^`, `~=`); lockfile: chính xác + hash. Action CI/base image: **SHA/digest** (xem supply-chain). | Thư viện công khai: manifest không ghim cứng (để người dùng giải quyết xung đột), vẫn commit lockfile cho dev/CI. |
| Runtime | Phiên bản **LTS/được hỗ trợ**, ghim trong `.nvmrc`/`.node-version`/`.python-version`/`go.mod`/`global.json`/`mise.toml`; đổi lớn qua ADR. | Bản "Current"/pre-release chỉ cho thử nghiệm, không prod. |
| License cho phép | Allowlist mặc định: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, Unlicense, CC0; copyleft mạnh (GPL/AGPL) và không OSI (SSPL, BUSL, FSL, "source-available") → quyết định có ADR theo [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md). | — |

## Checklist

- [ ] `BASE-DEP-001` **MUST** Mọi phụ thuộc khai báo trong manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`) và **lockfile được commit** (`package-lock.json`/`pnpm-lock.yaml`, `uv.lock`/`requirements.txt` có hash, `go.sum`, `Cargo.lock`, `packages.lock.json`). → Kiểm: `git ls-files` có lockfile; `.gitignore` không chứa lockfile; CI đỏ nếu thiếu. · Nguồn: 12-factor II
- [ ] `BASE-DEP-002` **MUST** CI và build sản phẩm cài **đóng băng** từ lockfile; manifest lệch lockfile → thất bại, không tự sửa lockfile. → Kiểm: workflow dùng `npm ci`/`--frozen-lockfile`/`--locked`/`--require-hashes`/`-mod=readonly`; test: sửa manifest không cập nhật lock → CI đỏ. · Nguồn: npm ci docs; pip secure installs; Go modules reference (`-mod=readonly`)
- [ ] `BASE-DEP-003` **MUST** Runtime/ngôn ngữ dùng phiên bản còn **được hỗ trợ bảo mật** (Node 22/24 LTS, Python ≥ 3.11, Go hai bản mới nhất, .NET 8/10 LTS, Java LTS…) và được ghim trong file phiên bản; không phụ thuộc runtime cài sẵn. → Kiểm: `.nvmrc`/`.python-version`/`mise.toml`/`go.mod go` tồn tại; CI đối chiếu với `https://endoflife.date/api/<product>.json` (`eol` > hôm nay + 90 ngày) hằng tuần. · Nguồn: endoflife.date API; nodejs.org previous releases; devguide.python.org versions
- [ ] `BASE-DEP-004` **MUST** Quét lỗ hổng phụ thuộc trong CI trên **mỗi PR** và **theo lịch** (ít nhất hằng tuần); mức high/critical chưa xử lý chặn merge; ngoại lệ ghi file có `cve`, `reason`, `approved_by`, `expires`. → Kiểm: `osv-scanner scan source -r . --config osv-scanner.toml` exit 0; file ngoại lệ không có mục quá hạn (script kiểm). · Nguồn: OWASP Vulnerable Dependency Management CS; OpenSSF Badge `vulnerabilities_fixed_60_days`
- [ ] `BASE-DEP-005` **MUST** License của mọi phụ thuộc (kể cả transitive) được **biết** và nằm trong allowlist; gói không rõ license hoặc copyleft/không OSI phải có quyết định ghi lại trước khi dùng. → Kiểm: `license-checker`/`pip-licenses`/`go-licenses`/`cargo deny check licenses` với allowlist trong repo = 0 vi phạm; ngoại lệ ở `license-exceptions.json` có `approved_by`/`expires`. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md); catalog 23 §2.5
- [ ] `BASE-DEP-006` **MUST** Trước khi thêm phụ thuộc mới: kiểm repo không archive, có bảo trì trong 12 tháng, license hợp lệ, không bật telemetry gửi dữ liệu mặc định, có cách thay thế trong stdlib hay không; ghi một dòng lý do trong PR. → Kiểm: PR template có mục "Phụ thuộc mới: tên · license · lý do · thay thế đã xét"; CI so `git diff origin/<base> -- <lockfile>`, có gói mới mà mục "Phụ thuộc mới" trong mô tả PR trống → đỏ. · Nguồn: evidence-and-sources.md luật 7; catalog README §18, §21
- [ ] `BASE-DEP-007` **MUST** Cập nhật phụ thuộc **tự động và có nhịp**: Dependabot/Renovate bật cho mọi hệ sinh thái trong repo (gói, `github-actions`, `docker`), gom nhóm minor/patch, giới hạn số PR mở. → Kiểm: `.github/dependabot.yml` (`version: 2`) hoặc `renovate.json` liệt kê đủ `package-ecosystem` có trong repo; có PR bot trong 30 ngày gần nhất. · Nguồn: Dependabot configuration options; Scorecard Dependency-Update-Tool
- [ ] `BASE-DEP-008` **MUST@M** Phụ thuộc tải lúc build/CI (action, base image, binary, model) được ghim theo **SHA/digest/checksum**, không chỉ tag; chi tiết và SBOM ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md). → Kiểm: `pinact run --check`; `FROM image@sha256:`; `sha256sum -c` cho binary tải về. · Nguồn: GitHub Actions security hardening; Scorecard Pinned-Dependencies
- [ ] `BASE-DEP-009` **MUST@M** Quét lỗ hổng **image/container và hệ điều hành** (không chỉ gói ngôn ngữ) cho artefact triển khai. → Kiểm: `trivy image`/`grype` trong CI build image, 0 high/critical chưa duyệt. · Nguồn: OWASP Vulnerable Dependency Management CS (Trivy, Grype)
- [ ] `BASE-DEP-010` **SHOULD** Phụ thuộc không dùng được **gỡ** định kỳ; dependency trùng vai (hai thư viện HTTP, hai thư viện ngày) bị cấm trừ khi có lý do. → Kiểm: `knip`/`depcheck` (JS), `deptry` (Python), `go mod tidy && git diff --exit-code`, `cargo machete` = 0 gói thừa trong CI. · Nguồn: [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md)
- [ ] `BASE-DEP-011` **SHOULD** Phụ thuộc có **kiểm tra toàn vẹn** khi cài: npm `integrity` trong lockfile, pip `--require-hashes`, `go.sum` + `GOSUMDB`, Cargo checksum; registry riêng cấu hình tường minh, không "fallback" ra public khi gói nội bộ không có (dependency confusion). → Kiểm: `.npmrc`/`pip.conf`/`GOPRIVATE` khai báo scope nội bộ; tên gói nội bộ được đăng ký giữ chỗ trên registry public hoặc dùng scope riêng. · Nguồn: pip secure installs; Go modules (`GOSUMDB`, `GOPRIVATE`)
- [ ] `BASE-DEP-012` **SHOULD** Cập nhật **major** đi PR riêng do người duyệt, có ghi chú breaking từ CHANGELOG upstream và test đầy đủ; không gom major vào nhóm tự merge. → Kiểm: cấu hình bot có `ignore: update-types: ["version-update:semver-major"]` hoặc nhóm riêng; PR major có nhãn và review. · Nguồn: Dependabot `groups`/`ignore`; catalog 23 §2.5
- [ ] `BASE-DEP-013` **SHOULD** Bản phát hành gói công khai (npm/PyPI/crates/NuGet) dùng **trusted publishing/OIDC** + 2FA bắt buộc trên tài khoản registry; token dài hạn không nằm trong CI. → Kiểm: workflow publish có `id-token: write`, không có `NPM_TOKEN`/`PYPI_TOKEN` tĩnh; cấu hình registry bật 2FA. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `BASE-DEP-014` **SHOULD** Có **danh sách phụ thuộc có chủ** (ít nhất SBOM sinh tự động CycloneDX/SPDX mỗi bản phát hành) để trả lời "có dùng gói X phiên bản Y không" trong vài phút khi có CVE. → Kiểm: artefact `sbom.cdx.json`/`sbom.spdx.json` kèm mỗi release (syft 1.54.x). · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `BASE-DEP-015` **SHOULD** Cài phụ thuộc trong CI có **cache theo hash lockfile** để nhanh nhưng không bao giờ cache thay cho lockfile (cache hỏng → cài lại, không đổi kết quả). → Kiểm: `actions/cache`/`setup-*` `cache-dependency-path` trỏ lockfile; job vẫn xanh khi xoá cache. · Nguồn: [`quality-gates.md`](quality-gates.md) BASE-GATE-011
- [ ] `BASE-DEP-016` **MAY** `cooldown` cho cập nhật tự động (vd 3–7 ngày sau khi upstream phát hành) để tránh nhận bản vừa bị rút/tiêm mã. → Kiểm: `dependabot.yml` có `cooldown.default-days` hoặc Renovate `minimumReleaseAge`. · Nguồn: Dependabot `cooldown`
- [ ] `BASE-DEP-017` **MAY** Vendor (sao chép có lock: ghim commit, sha256 từng file, ghi lý do `rejected` cho phần bỏ) phụ thuộc nhỏ hoặc nhạy cảm của **mã ứng dụng**. Skill/MCP server/plugin của agent không thuộc mục này — bắt buộc theo [`SEC-SUPPLY-016`](../12-security/supply-chain.md). → Kiểm: `docs/integrations/*.lock.json` có commit + sha256; script `verify-vendor` chạy trong CI. · Nguồn: catalog 23 §3.1, 20 §3b (vendor-with-lock)
- [ ] `BASE-DEP-018` **MAY** Kiểm điểm **Scorecard** của phụ thuộc quan trọng (`scorecard --repo=github.com/<o>/<r>`) trước khi thêm; điểm Maintained/Vulnerabilities thấp là tín hiệu cân nhắc. → Kiểm: ghi điểm trong PR thêm phụ thuộc. · Nguồn: OpenSSF Scorecard

## Bẫy thường gặp

- **`npm install` trong CI** → lockfile bị cập nhật ngầm, build hôm nay khác hôm qua. `npm ci`.
- **Lockfile trong `.gitignore` "vì xung đột merge"**. Giải quyết xung đột lockfile bằng cài lại, không bỏ lock.
- **Quét chỉ khi lockfile đổi** → CVE công bố tuần sau không ai biết. Cron hằng tuần (bài học pip-audit catalog 23).
- **Node 18 / Python 3.9/3.10 vẫn chạy prod** sau EOL (Node 18: 04/2025; Python 3.9: 10/2025; 3.10: 2026-10-01) — không còn vá bảo mật. Cổng EOL tự động.
- **Bot mở 40 PR một lúc** → không ai review, tất cả bị đóng. Gom nhóm, giới hạn PR mở, WIP cap.
- **"Free" không có nghĩa OSI**: n8n (SUL), Open WebUI, SSPL/BUSL/FSL… — ba câu hỏi: xuất bản được? dùng thương mại được? xuất dữ liệu ra được? (catalog 05).
- **Gói 11/201 trong list "official" đã archive** (catalog 04 §2c, 5,5%) — nổi tiếng không miễn việc kiểm trạng thái.
- **Telemetry bật mặc định** gửi task/URL (chrome-devtools-mcp, codegraph) — đọc cấu hình mặc định trước khi cài.
- **Dependency confusion**: gói nội bộ `@acme/utils` không đăng ký trên registry public → kẻ tấn công đăng ký, CI tải nhầm. Scope riêng + registry khai báo tường minh.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Cài đóng băng | npm/pnpm/yarn · uv 0.13.0 (Apache-2.0/MIT) · pip 26.x · go · cargo · dotnet | `npm ci` · `uv sync --locked` · `pip install --require-hashes` · `go build -mod=readonly` · `cargo build --locked` | CI | lệch = đỏ |
| Lỗ hổng | OSV-Scanner v2.7.0 (Apache-2.0) · pip-audit 2.10.1 (Apache-2.0) · `npm audit` · `cargo audit` · `govulncheck` · Trivy/Grype (Apache-2.0) | `osv-scanner scan source -r .` | PR + cron tuần | 0 high/critical chưa duyệt |
| License | license-checker / pip-licenses / go-licenses / cargo-deny / syft + script allowlist | `cargo deny check licenses` ... | CI | 0 ngoài allowlist |
| Runtime EOL | script + endoflife.date API | `curl https://endoflife.date/api/nodejs.json` so với `.nvmrc` | cron tuần | eol > hôm nay + 90 ngày |
| Phụ thuộc thừa | knip 6.41.0 (ISC) · depcheck · deptry · `go mod tidy` · cargo-machete | `knip` | CI | 0 |
| Cập nhật | Dependabot (GitHub) · Renovate 44.155.1 (AGPL-3.0) | cấu hình `dependabot.yml`/`renovate.json` | nền tảng | PR gom nhóm hằng tuần |
| Ghim SHA/digest | pinact v5.0.0 (MIT) · Dependabot `github-actions`/`docker` | `pinact run --check` | CI | 0 chưa ghim |
| SBOM | syft v1.54.1 (Apache-2.0) | `syft . -o cyclonedx-json > sbom.cdx.json` | release | artefact kèm release |

Cảnh báo: Renovate AGPL-3.0 (chỉ ảnh hưởng khi sửa và phân phối Renovate); Trivy từng bị cài backdoor (CVE-2026-33634, catalog 12 §3) → ghim SHA + kiểm checksum khi cài; uv/ruff thuộc OpenAI từ 03/2026, license không đổi (catalog 13 §4c).

## Nguồn

- The Twelve-Factor App II Dependencies: <https://12factor.net/dependencies> — xác minh 2026-10-13
- npm `npm ci`: <https://docs.npmjs.com/cli/v11/commands/npm-ci> — xác minh 2026-10-13
- pip Secure installs (`--require-hashes`): <https://pip.pypa.io/en/stable/topics/secure-installs/> — xác minh 2026-10-13
- Go Modules Reference (`-mod=readonly` mặc định từ Go 1.16, `go.sum`): <https://go.dev/ref/mod> — xác minh 2026-10-13
- Dependabot `dependabot.yml` (groups, open-pull-requests-limit, cooldown): <https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Vulnerable Dependency Management: <https://cheatsheetseries.owasp.org/cheatsheets/Vulnerable_Dependency_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- endoflife.date API (xác minh 2026-10-13): Node 22 EOL 2027-04-30, Node 24 EOL 2028-04-30, Node 26 LTS từ 2026-10-28 (<https://endoflife.date/api/nodejs.json>); Python 3.10 EOL 2026-10-01, 3.11 EOL 2027-10-31, 3.15 mới nhất (<https://endoflife.date/api/python.json>); Go 1.27/1.26 được hỗ trợ (<https://endoflife.date/api/go.json>); .NET 8 EOL 2026-11-10, .NET 10 LTS (<https://endoflife.date/api/dotnet.json>)
- Node.js previous releases (v24 Krypton, v22 Jod là LTS; v26 Current): <https://nodejs.org/en/about/previous-releases> — xác minh 2026-10-13; Python versions: <https://devguide.python.org/versions/> — xác minh 2026-10-13
- OpenSSF Scorecard (Dependency-Update-Tool, Pinned-Dependencies, Vulnerabilities): <https://github.com/ossf/scorecard> — xác minh 2026-10-13
- Phiên bản công cụ (xác minh 2026-10-13): OSV-Scanner v2.7.0, syft v1.54.1, pinact v5.0.0, Renovate 44.155.1 (release page GitHub); pip-audit 2.10.1, uv 0.13.0 (PyPI); knip 6.41.0 (npm)
- Catalog `seeker19110/stored` 04 §2c, 05, 12 §3, 13 §4c, 20 §3b, 23 §2.5/§3.1/§8.1 theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md), đọc 2026-10-13.
