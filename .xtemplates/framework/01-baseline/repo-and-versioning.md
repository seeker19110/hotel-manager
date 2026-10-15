---
title: Repo, phiên bản và lịch sử thay đổi
kind: baseline
prefix: BASE-REPO
applies_to: [all]
updated: 2026-10-14
---

# Repo, phiên bản và lịch sử thay đổi

> Mức tối thiểu để **mọi** phần mềm (web, mobile, CLI, thư viện, firmware, model…) có một repo đọc được, lịch sử
> truy vết được và số phiên bản có nghĩa. Quy trình nhánh/PR/review và pipeline phát hành là nhà của
> [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md) và
> [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md); ở đây chỉ đặt sàn.

## Nguyên tắc

- **Một repo = một nguồn sự thật** cho mã, cấu hình, tài liệu và lịch sử quyết định (P5). Thứ gì không nằm trong repo
  (hoặc không sinh ra từ repo) thì phiên sau không tìm thấy.
- **Lịch sử là tài liệu**: commit message theo Conventional Commits để máy sinh CHANGELOG, tính phiên bản và lọc
  `git log` theo loại thay đổi.
- **Số phiên bản là lời hứa về tương thích** (SemVer) hoặc **về thời điểm** (CalVer). Chọn một, ghi rõ, không trộn.
- **Nhỏ và đảo ngược được** (P8): commit nhỏ, không rewrite lịch sử nhánh chung, không force-push nhánh mặc định.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| SemVer hay CalVer? | **SemVer 2.0.0** mặc định cho thư viện/SDK/API/CLI — người dùng cần biết "nâng cấp có vỡ không". | **CalVer** (`YYYY.0M.0D` hoặc `YY.MINOR.MICRO`) cho sản phẩm phát hành theo lịch, phạm vi lớn khó gán "breaking" (OS, dữ liệu như tzdb, ứng dụng người dùng cuối). CalVer **không** báo breaking → bắt buộc kèm CHANGELOG + chính sách deprecation theo thời gian. |
| Đang `0.y.z` có cần kỷ luật không? | Có: `0.y.z` được phép đổi API bất kỳ lúc nào (SemVer §4) nhưng vẫn phải ghi CHANGELOG; đạt `1.0.0` khi API công khai được dùng bởi người ngoài đội. | — |
| Sinh CHANGELOG bằng máy hay tay? | **Máy từ Conventional Commits** (release-please, git-cliff, changesets) + mục `Unreleased` người bổ sung ngữ cảnh. | Repo không theo Conventional Commits → viết tay theo Keep a Changelog, nhưng là nợ kỹ thuật phải ghi. |
| Monorepo hay nhiều repo? | Một sản phẩm, một đội, các gói phát hành cùng nhịp → monorepo (hồ sơ `monorepo`). | Vòng đời/quyền truy cập/nhịp phát hành khác nhau rõ rệt → tách repo. Ghi ADR. |
| Tag như thế nào? | `vX.Y.Z` annotated tag trên commit phát hành; monorepo dùng `pkg@X.Y.Z`. | Tag lightweight không có người/ngày → không dùng cho phát hành. |

## Checklist

- [ ] `BASE-REPO-001` **MUST** Toàn bộ mã nguồn, cấu hình, migration, tài liệu, script build/CI nằm trong một repo Git có remote; không có "file chỉ ở máy tôi". → Kiểm: `git ls-files` liệt kê đủ các file cần để build từ clone mới; CI build từ `git clone` sạch xanh. · Nguồn: 12-factor I (Codebase)
- [ ] `BASE-REPO-002` **MUST** Có `.gitignore` phù hợp stack; không commit artefact build, `node_modules/`, `.venv/`, file IDE, file `.env*` chứa giá trị thật. → Kiểm: `git ls-files | grep -E '(^|/)(node_modules|dist|build|\.venv)/|(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$'` ra 0 dòng (`.env.example` được commit theo [`BASE-CFG-003`](configuration-and-secrets.md)); hook pre-commit chặn file bị ignore. · Nguồn: 12-factor III
- [ ] `BASE-REPO-003` **MUST** Có `.gitattributes` với `* text=auto` (và `eol=lf` cho script shell) để line ending không khác nhau giữa Windows/macOS/Linux. → Kiểm: file `.gitattributes` tồn tại; `git ls-files --eol | grep 'w/crlf'` chỉ ra file được khai báo `eol=crlf` tường minh. · Nguồn: git gitattributes `text`/`eol`
- [ ] `BASE-REPO-004` **MUST** Có file `LICENSE` ở gốc (kể cả repo riêng tư: ghi rõ "Proprietary"/chủ sở hữu) và trường license trong manifest gói khớp với file. → Kiểm: `LICENSE` tồn tại; `package.json`/`pyproject.toml`/`Cargo.toml` có `license` là SPDX id (hoặc `UNLICENSED`/`LicenseRef-Proprietary`) khớp. · Nguồn: SPDX License List 3.29.0; OpenSSF Badge `license_location`
- [ ] `BASE-REPO-005` **MUST** Commit message theo **Conventional Commits 1.0.0**: `type(scope)!: mô tả`, `BREAKING CHANGE:` footer khi vỡ tương thích; subject ≤ 72 ký tự. → Kiểm: commitlint (hoặc regex trong hook `commit-msg`) chạy ở local và lặp lại trong CI trên mọi commit của PR. · Nguồn: Conventional Commits 1.0.0 §1, §12–13
- [ ] `BASE-REPO-006` **MUST** Mỗi phiên bản phát hành có **một định danh duy nhất** theo SemVer 2.0.0 hoặc CalVer đã chọn, ghi trong một nguồn duy nhất (manifest gói hoặc file `VERSION`) và gắn **annotated tag** trùng giá trị. → Kiểm: `git tag -l 'v*'` có tag cho bản mới nhất; `git cat-file -t <tag>` = `tag`; giá trị trong manifest == tag. · Nguồn: SemVer 2.0.0 §2–8; OpenSSF Badge `version_unique`, `version_tags`
- [ ] `BASE-REPO-007` **MUST** Có `CHANGELOG.md` theo Keep a Changelog 1.1.0: mục `Unreleased` ở đầu, mỗi bản có ngày ISO 8601 (`YYYY-MM-DD`), nhóm Added/Changed/Deprecated/Removed/Fixed/Security, bản mới nhất trước; ghi chú người đọc được, không dán `git log`. → Kiểm: CI kiểm `CHANGELOG.md` có heading `## [Unreleased]` và heading bản mới nhất trùng tag; hoặc file sinh bởi release-please/git-cliff trong PR phát hành. · Nguồn: Keep a Changelog 1.1.0; OpenSSF Badge `release_notes`
- [ ] `BASE-REPO-008` **MUST** Nhánh mặc định được bảo vệ: không force-push, không xoá, mọi thay đổi qua PR (kể cả làm một mình). → Kiểm: ruleset/branch protection đọc qua API (`gh api repos/{o}/{r}/rulesets`) có `non_fast_forward`, `deletion`, `pull_request`; cấu hình lưu dạng code trong `.github/rulesets/*.json`. · Nguồn: GitHub rulesets; Scorecard Branch-Protection
- [ ] `BASE-REPO-009` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-001`](../12-security/secrets-management.md): không bí mật trong toàn lịch sử git, lộ thì xoay trước (`SEC-SECRET-011`); sàn mọi quy mô giữ ở [`BASE-SEC-002`](security-minimum.md).
- [ ] `BASE-REPO-010` **SHOULD** Thay đổi gây **breaking** phải xuất hiện ở ba nơi nhất quán: commit `!`/`BREAKING CHANGE:`, mục CHANGELOG, và bump MAJOR (SemVer) hoặc ghi chú deprecation (CalVer). → Kiểm: test CI so khớp: có commit `!` kể từ tag trước ⇒ phiên bản mới có MAJOR tăng. · Nguồn: Conventional Commits FAQ; SemVer 2.0.0 §8
- [ ] `BASE-REPO-011` **SHOULD** `README.md` ở gốc nêu một dòng mô tả, cách chạy, cách test, và trỏ tới `CHANGELOG.md`, `LICENSE`, tài liệu; nội dung tối thiểu theo [`documentation-minimum.md`](documentation-minimum.md). → Kiểm: script kiểm tồn tại các heading bắt buộc trong README. · Nguồn: OpenSSF Badge `documentation_basics`
- [ ] `BASE-REPO-012` **SHOULD** Commit nhỏ, một thay đổi logic mỗi commit; PR < ~400 dòng thay đổi trừ khi là sinh mã/đổi tên hàng loạt (ghi rõ trong mô tả PR). → Kiểm: CI cảnh báo khi `git diff --shortstat base..head` vượt ngưỡng đã đặt trong repo. · Nguồn: P8 (principles.md)
- [ ] `BASE-REPO-013` **MUST** Không force-push và không rewrite lịch sử (`rebase`, `amend`, `reset`) trên **nhánh dùng chung** (nhánh chính, nhánh có người/agent khác làm, nhánh đã có PR được review); chỉ rewrite nhánh cá nhân chưa chia sẻ — quy tắc chi tiết ở [`WF-GIT-009`](../10-workflow/git-and-branching.md). → Kiểm: ruleset theo Kiểm của `BASE-REPO-008`; quy ước nhánh dùng chung ghi trong `CONTRIBUTING.md`/`AGENTS.md`. · Nguồn: P8; AGENTS.md §3
- [ ] `BASE-REPO-014` **SHOULD** File lớn/nhị phân (model, media, dataset) không commit thẳng; dùng Git LFS hoặc kho artefact có địa chỉ và checksum trong repo. → Kiểm: hook chặn file > ngưỡng (vd 1 MB) không thuộc `.gitattributes` `filter=lfs`; `git lfs ls-files` liệt kê file lớn. · Nguồn: Scorecard Binary-Artifacts
- [ ] `BASE-REPO-015` **SHOULD** Ghi `CODEOWNERS` (hoặc tương đương) cho vùng mã nhạy cảm (auth, thanh toán, migration, CI) để review bắt buộc đúng người. → Kiểm: file `.github/CODEOWNERS` tồn tại và hợp lệ (GitHub báo lỗi cú pháp ở tab Code owners). · Nguồn: GitHub CODEOWNERS
- [ ] `BASE-REPO-016` **MAY** Ký commit/tag (SSH hoặc GPG, hoặc Sigstore gitsign) và bật "require signed commits" trên nhánh mặc định với quy mô L. → Kiểm: `git log --show-signature -1` hiển thị chữ ký hợp lệ; ruleset có `required_signatures`. · Nguồn: GitHub rulesets
- [ ] `BASE-REPO-017` **MAY** Dùng `Signed-off-by` (DCO 1.1) khi repo nhận đóng góp bên ngoài thay cho CLA. → Kiểm: DCO check app/CI đọc trailer `Signed-off-by:` trên mọi commit của PR. · Nguồn: DCO 1.1
- [ ] `BASE-REPO-018` **MAY** Dùng squash merge để lịch sử nhánh mặc định tuyến tính, mỗi PR = một commit conventional; tiêu đề squash phải đúng dạng conventional vì nó trở thành commit message. → Kiểm: ruleset `required_linear_history` + commitlint chạy trên commit sau merge. · Nguồn: Conventional Commits 1.0.0

## Bẫy thường gặp

- **CHANGELOG = `git log` dán vào.** Keep a Changelog gọi đây là "commit log diffs": nhiễu, không nói người dùng bị ảnh hưởng gì. Viết theo *thay đổi có nghĩa với người dùng*; máy sinh khung, người bổ sung ngữ cảnh.
- **Tag `v1.2.3` nhưng manifest ghi `1.2.2`.** Hai nguồn sự thật cho phiên bản. Giữ một nguồn (manifest) và tag từ nguồn đó bằng script phát hành; CI so khớp.
- **`0.y.z` mãi mãi.** Người dùng không biết cái gì ổn định. Đặt mốc `1.0.0` khi API được dùng bên ngoài; nếu dùng CalVer thì công bố chính sách deprecation (vd Twisted: một năm và hai bản phát hành).
- **CalVer có zero-padding nhưng công cụ parse theo SemVer.** `2026.09.11` không phải SemVer hợp lệ (số không được có 0 đứng đầu). Nếu hệ sinh thái bắt buộc SemVer (npm, Cargo), dùng `2026.9.11`.
- **`BREAKING CHANGE` chỉ ghi trong mô tả PR, không ghi trong commit.** Sau squash merge, công cụ sinh phiên bản chỉ đọc commit → bump sai. Đưa `!` vào tiêu đề squash.
- **Line ending lẫn lộn** làm diff "đổi cả file", che mất thay đổi thật và phá hash của script. `* text=auto` + `git add --renormalize .` một lần.
- **Secret đã vào lịch sử, chỉ xoá ở commit mới.** Vẫn còn ở mọi clone/fork. Xoay bí mật ngay; dọn lịch sử là bước phụ.
- **Agent tự merge/force-push để "cho xanh".** Ruleset không có bypass cho bot; agent chỉ được mở PR (xem [`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md)).

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Định dạng commit message | commitlint 21.2.3 (MIT) + `@commitlint/config-conventional`; hoặc regex shell | `npx commitlint --from=origin/main --to=HEAD` | hook `commit-msg` (husky/lefthook/pre-commit) **và** CI | 0 lỗi |
| Bí mật trong toàn lịch sử | gitleaks v8.30.1 (MIT) | `gitleaks git --log-opts=--all --redact` | CI hằng ngày + trên PR (`fetch-depth: 0`) | 0 phát hiện |
| Sinh phiên bản + CHANGELOG | release-please v17.11.2 (Apache-2.0) · git-cliff v2.14.2 (MIT/Apache-2.0) · changesets (MIT) | `release-please release-pr` / `git cliff --unreleased` | CI trên nhánh mặc định | PR phát hành tự mở; không tag tay |
| Nhánh mặc định được bảo vệ | GitHub rulesets (as code) | `gh api repos/{o}/{r}/rulesets` so với `.github/rulesets/main.json` | CI job `protection-guard` | required check không khớp job thật = đỏ; ruleset chưa hiệu lực trên nhánh mặc định = cảnh báo (đổi `::warning` thành `exit 1` để ép) |
| Line ending / file lớn | git + script | `git ls-files --eol`; hook chặn file > 1 MB không LFS | pre-commit | 0 vi phạm |
| Tag khớp manifest | script repo | so `git describe --tags --abbrev=0` với version trong manifest | CI job release | bằng nhau |

## Nguồn

- Conventional Commits 1.0.0: <https://www.conventionalcommits.org/en/v1.0.0/> — xác minh 2026-10-13
- Semantic Versioning 2.0.0: <https://semver.org/spec/v2.0.0.html> — xác minh 2026-10-13
- Keep a Changelog 1.1.0: <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13
- CalVer: <https://calver.org/> — xác minh 2026-10-13
- The Twelve-Factor App, I Codebase & III Config: <https://12factor.net/> — xác minh 2026-10-13
- git `gitattributes` (`text`, `eol`, `export-ignore`): <https://git-scm.com/docs/gitattributes> — xác minh 2026-10-13
- GitHub rulesets — rules khả dụng: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets> — xác minh 2026-10-13
- SPDX License List 3.29.0 (2026-09-16): <https://spdx.org/licenses/> — xác minh 2026-10-13
- OpenSSF Best Practices Badge, tiêu chí passing (`version_unique`, `version_tags`, `license_location`, `release_notes`): <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13
- Developer Certificate of Origin 1.1: <https://developercertificate.org/> — xác minh 2026-10-13
- Phiên bản công cụ (xác minh 2026-10-13): commitlint 21.2.3 (`registry.npmjs.org/commitlint/latest`); gitleaks v8.30.1 (<https://github.com/gitleaks/gitleaks/releases/latest>); git-cliff v2.14.2 (<https://github.com/orhun/git-cliff/releases/latest>); release-please v17.11.2 theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md) (catalog 13 §4c, đọc 2026-10-12).
- Khung cũ X-stored `CLAUDE.md` §8 (quy ước Git, squash merge), commit `1b80fe4`; catalog `seeker19110/stored` 23 §2.5 (commit subject ≤ 72, WIP cap), đọc 2026-10-13.
