---
title: Phát hành, SemVer, CHANGELOG, tag, rollback
kind: module
prefix: WF-REL
applies_to: [all]
updated: 2026-10-14
---

# Phát hành, SemVer, CHANGELOG, tag, rollback

> Phát hành là **sự kiện máy tạo** từ lịch sử Conventional Commits: release-please (hoặc changesets cho monorepo
> nhiều package) mở Release PR → merge → tag ký + GitHub Release + CHANGELOG theo Keep a Changelog. Mỗi bản phát
> hành có **đường lùi đã diễn tập**. Cơ chế deploy (canary/blue-green) ở
> [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md).

## Nguyên tắc

1. **Phiên bản là hệ quả của commit, không phải quyết định tay.** `fix` → PATCH, `feat` → MINOR, `!`/`BREAKING
   CHANGE` → MAJOR (SemVer 2.0.0); người chỉ quyết *khi nào* phát hành.
2. **Bản đã phát hành là bất biến.** Không sửa tag/asset đã công bố; lỗi → bản mới (`x.y.z+1`), kèm ghi chú.
3. **CHANGELOG cho người dùng, không phải git log.** Nhóm Added/Changed/Deprecated/Removed/Fixed/Security, ngày
   ISO, link so sánh; thay đổi phá vỡ nêu cách di trú.
4. **Rollback là tính năng của bản phát hành.** Mỗi release biết bản trước, cách lùi (artefact cũ, migration
   tương thích), và đã diễn tập ít nhất một lần trước khi lên prod.
5. **Deploy ≠ release.** Dịch vụ có thể deploy nhiều lần/ngày (CD); "release" cho người dùng là mốc có phiên bản,
   ghi chú, và có thể bật dần qua flag.

## Quyết định

| Loại dự án | Chọn | Ghi chú |
|---|---|---|
| Dịch vụ/web một package, deploy liên tục | **release-please** (release-type theo ngôn ngữ) + squash merge; tag `vX.Y.Z` tại commit Release PR | Phiên bản là mốc theo dõi/rollback, không nhất thiết hiển thị cho người dùng |
| Monorepo nhiều package publish độc lập (npm) | **changesets** (file `.changeset/*.md` mô tả bump mỗi package) + Version Packages PR | release-please manifest cũng được nếu không cần ghi changeset thủ công |
| Thư viện/SDK/CLI | SemVer nghiêm ngặt, public API khai báo, deprecation ≥ 1 MINOR trước khi bỏ ở MAJOR; publish có provenance | 0.y.z trong lúc API chưa ổn định — nói rõ trong README |
| Mobile/desktop (store) | Phiên bản hiển thị + build number tăng đơn điệu; nhánh `release/x.y` ngắn để hardening; CHANGELOG theo store | Hotfix cherry-pick về `main` ngay |
| API công khai | Version API ([`../08-backend/api-design.md`](../08-backend/api-design.md)) tách với version code; CHANGELOG API riêng | — |
| Lịch phát hành | Theo nhu cầu (CD) hoặc nhịp cố định (tuần/2 tuần) — ghi trong `PROJECT.md` | "Khi nào xong" không có lịch |

## Checklist

- [ ] `WF-REL-001` **MUST** Phiên bản theo SemVer 2.0.0 và được sinh tự động từ Conventional Commits (release-please/changesets/semantic-release), không sửa tay số phiên bản trong PR tính năng. → Kiểm: workflow release tồn tại; `git log` không có commit tay "bump version" ngoài Release PR. · Nguồn: SemVer 2.0.0, Conventional Commits 1.0.0
- [ ] `WF-REL-002` **MUST@L** `CHANGELOG.md` theo Keep a Changelog (Unreleased, nhóm Added/Changed/Deprecated/Removed/Fixed/Security, ngày `YYYY-MM-DD`, link so sánh phiên bản), sinh tự động + có thể biên tập trong Release PR; thay đổi phá vỡ có hướng dẫn di trú. → Kiểm: file tồn tại, mục mới nhất khớp tag mới nhất; lint cấu trúc (script/markdownlint rule). · Nguồn: Keep a Changelog 1.1.0
- [ ] `WF-REL-003` **MUST** Mỗi phát hành có tag `vX.Y.Z` bất biến trỏ đúng commit đã qua `quality`, GitHub Release kèm ghi chú và artefact/checksum; không xoá/dời tag đã công bố. → Kiểm: ruleset tag `v*` cấm xoá/cập nhật; `gh release view vX.Y.Z` có asset + checksum. · Nguồn: GitHub Rulesets (tag target)
- [ ] `WF-REL-004` **MUST** Kế hoạch rollback ghi trong Release/runbook: bản trước là gì, lệnh lùi (deploy artefact cũ/đổi tag image), migration đi kèm tương thích ngược (expand/contract) hoặc có đường lùi; **đã diễn tập** rollback trước khi lên prod lần đầu và sau mỗi thay đổi cơ chế deploy. → Kiểm: `docs/ops/RUNBOOK` mục rollback có ngày diễn tập; migration PR link [`../09-database/migrations.md`](../09-database/migrations.md). · Nguồn: P8, lifecycle G7
- [ ] `WF-REL-005` **MUST@L** Artefact phát hành build một lần từ commit đã tag, có checksum (SHA-256) và tên chứa phiên bản + commit; deploy dùng đúng artefact đó, không build lại. → Kiểm: release asset `SHA256SUMS`; image tag `vX.Y.Z` và `sha-<commit>` cùng digest. · Nguồn: 12-factor V
- [ ] `WF-REL-006` **MUST@L** Thay đổi phá vỡ: đánh dấu `!`/`BREAKING CHANGE`, nâng MAJOR (hoặc MINOR khi 0.y.z, nói rõ), ghi chú di trú, deprecation có cảnh báo runtime/log ≥ 1 MINOR trước khi bỏ (thư viện/API). → Kiểm: `oasdiff`/API diff đỏ khi breaking không có `!`; CHANGELOG có mục Deprecated trước Removed. · Nguồn: SemVer 2.0.0 §7–8
- [ ] `WF-REL-007` **MUST@M** Release có smoke test tự động sau deploy (luồng chính, health, phiên bản trả về khớp tag) và cửa sổ theo dõi (error rate, latency) với tiêu chí auto-rollback hoặc người quyết trong N phút. → Kiểm: job post-deploy smoke; cảnh báo theo [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md); runbook ghi ngưỡng lùi.
- [ ] `WF-REL-008` **MUST@L** Ứng dụng tự báo phiên bản đang chạy (endpoint `/version` hoặc log khởi động: version + commit SHA + build time) để đối chiếu khi sự cố. → Kiểm: `curl /version` trả JSON khớp tag deploy; log startup có SHA.
- [ ] `WF-REL-009` **MUST@L** Tag phát hành được ký (SSH/GPG `git tag -s` hoặc ký bởi workflow có OIDC) và xác minh được; với package npm/PyPI/container bật provenance/attestation theo [`../12-security/supply-chain.md`](../12-security/supply-chain.md). → Kiểm: `git tag -v vX.Y.Z` hợp lệ; `npm audit signatures`/`cosign verify` pass. · Nguồn: GitHub commit signature verification
- [ ] `WF-REL-010` **MUST@L** Hotfix: nhánh từ tag/`main`, PR qua cổng đầy đủ (không bỏ test vì "gấp"), phát hành PATCH, ghi CHANGELOG; không deploy tay bỏ qua pipeline. → Kiểm: mọi deploy prod có run CD tương ứng; không có "manual deploy" trong log hạ tầng. · Nguồn: P8
- [ ] `WF-REL-011` **MUST@L** Lịch phát hành và cửa sổ đóng băng (freeze) ghi rõ; phát hành ngoài giờ hỗ trợ cần người trực và kế hoạch lùi; thông báo người dùng/khách hàng cho thay đổi phá vỡ theo SLA hợp đồng. → Kiểm: lịch trong `docs/ops/`; thông báo lưu cùng release.
- [ ] `WF-REL-012` **SHOULD** Release notes cho người dùng (từ [`../templates/RELEASE-NOTES.md`](../templates/RELEASE-NOTES.md)) tách khỏi CHANGELOG kỹ thuật khi có người dùng ngoài đội; ngôn ngữ của người dùng. → Kiểm: file/notes đính kèm release.
- [ ] `WF-REL-013` **SHOULD** PR bot (Dependabot/Renovate) gắn nhãn `no-changelog`/`chore` để không làm nhiễu CHANGELOG; cập nhật dependency bảo mật ghi mục Security. → Kiểm: cấu hình release-please `changelog-sections`/nhãn.
- [ ] `WF-REL-014` **SHOULD** Feature flag cho thay đổi rủi ro: deploy tắt, bật dần theo phần trăm/tenant, có kill switch; dọn flag sau khi ổn định (hạn ≤ 2 chu kỳ phát hành). → Kiểm: danh sách flag có ngày tạo/hạn dọn ([`environments-and-config.md`](environments-and-config.md)).
- [ ] `WF-REL-015` **SHOULD** Thư viện: public API khai báo rõ (docs/`exports`), test tương thích API (API extractor/`go vet`/`abi` check) trong CI; 0.y.z nói rõ "chưa ổn định". → Kiểm: job API-compat; README có mục stability.
- [ ] `WF-REL-016` **SHOULD** Đo DORA cho phát hành: deployment frequency, change lead time, change fail rate, failed deployment recovery time, rework rate — xem lại theo quý. → Kiểm: dashboard/báo cáo quý trong `docs/ops/`. · Nguồn: DORA metrics
- [ ] `WF-REL-017` **MAY** Release candidate/pre-release (`vX.Y.Z-rc.1`) cho sản phẩm đóng gói; pre-release không được coi là ổn định theo SemVer. → Kiểm: tag pre-release có hậu tố; CD không deploy prod từ pre-release.
- [ ] `WF-REL-018` **MAY** Ký và công bố SBOM cùng release (CycloneDX/SPDX) — chi tiết [`../12-security/supply-chain.md`](../12-security/supply-chain.md). → Kiểm: asset SBOM trong release.

## Bẫy thường gặp

- **Sửa tay `version` trong PR tính năng.** Xung đột liên tục, phiên bản không khớp commit. Để bot bump trong Release PR.
- **Merge commit/rebase thay vì squash với release-please.** Lịch sử phi tuyến → changelog thiếu/trùng, `BEGIN_COMMIT_OVERRIDE` không hoạt động. Squash.
- **CHANGELOG = git log.** Người dùng không đọc được; thay đổi quan trọng chìm trong "chore". Keep a Changelog + biên tập trong Release PR.
- **Tag bị dời để "sửa nhanh".** Người đã tải bản cũ không biết; checksum lệch. Tag bất biến, phát hành bản mới.
- **Rollback chỉ có trong tài liệu.** Lần đầu lùi là lúc sự cố → thất bại. Diễn tập ở staging, ghi ngày.
- **Migration không tương thích với bản trước.** Lùi code nhưng schema mới → bản cũ crash. Expand/contract: thêm cột trước, bỏ sau N bản.
- **Deploy tay "vì pipeline chậm".** Không biết prod đang chạy gì. Mọi deploy qua CD; `/version` để đối chiếu.
- **Flag mãi không dọn.** Hàng trăm nhánh code chết. Hạn dọn trong danh sách flag.
- **Mâu thuẫn nguồn:** Keep a Changelog hiển thị "Version 1.1.0" nhưng changelog của chính site ghi 1.1.2 (2024-09-27); khung dẫn **1.1.0** là bản đặt tên chính thức của trang, nội dung quy tắc không đổi.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| release-please (Apache-2.0) 17.11.2 | `googleapis/release-please-action@<sha>` với `release-type` + `config/manifest` cho monorepo | CD on push `main` | Release PR mở/cập nhật tự động |
| changesets (MIT) @changesets/cli 3.0.3 | `changeset` (dev) · `changeset version` · `changeset publish` + `changesets/action@<sha>` | CI + CD | PR thiếu changeset → `changeset status` đỏ (trừ nhãn) |
| semantic-release (MIT) 25.0.9 | thay thế khi muốn publish không qua Release PR | CD | — |
| CHANGELOG lint | script kiểm cấu trúc Keep a Changelog + mục mới nhất = tag mới nhất | CI | Đỏ khi lệch |
| API diff | `oasdiff breaking` / API extractor / `go-apidiff` | CI | Breaking không có `!` → đỏ |
| Tag ruleset | ruleset target `tag` pattern `v*`: cấm xoá/update, `required_signatures` (L) | GitHub | — |
| Smoke post-deploy | job `curl /version` + E2E luồng chính | CD | Fail → auto-rollback/cảnh báo |
| Checksum/provenance | `sha256sum` asset; `npm publish --provenance`; `cosign sign` | CD | Có cho mọi release |

## Nguồn

- Semantic Versioning 2.0.0: <https://semver.org/spec/v2.0.0.html> — xác minh 2026-10-13
- Conventional Commits 1.0.0 (fix→PATCH, feat→MINOR, BREAKING→MAJOR): <https://www.conventionalcommits.org/en/v1.0.0/> — xác minh 2026-10-13
- Keep a Changelog 1.1.0: <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13
- release-please README (Release PR, release types, manifest monorepo, khuyến nghị squash): <https://github.com/googleapis/release-please#readme> — xác minh 2026-10-13; release-please 17.11.2 (npm) — xác minh 2026-10-13
- changesets README (v3 trên `main`): <https://github.com/changesets/changesets#readme> — xác minh 2026-10-13; @changesets/cli 3.0.3 (npm) — xác minh 2026-10-13
- GitHub — About commit signature verification (ký tag): <https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification> — xác minh 2026-10-13
- GitHub — Rulesets (target tag): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets> — xác minh 2026-10-13
- DORA — Metrics (5 chỉ số): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13
- semantic-release 25.0.9 (npm) — xác minh 2026-10-13. (chưa xác minh) oasdiff, go-apidiff, API Extractor phiên bản.
- Khung cũ X-stored commit `1b80fe4`: `.github/workflows/release.yml` (release-please node), `CONTRIBUTING.md` (squash + release-please). `research/2026-10-13-stored-catalog-extraction.md` §2.7; catalog `13-dev-stack-devops` §4b (release-please, nhãn `no-changelog`), §4c.
