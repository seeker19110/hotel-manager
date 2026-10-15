---
title: Chuẩn quy trình & chất lượng (ISO 25010, SemVer, Conventional Commits, SLSA, SBOM, DORA)
kind: standard
prefix: STD-PROC
applies_to: [all]
updated: 2026-10-14
---

# Chuẩn quy trình & chất lượng (ISO 25010, SemVer, Conventional Commits, SLSA, SBOM, DORA)

> Phiên bản hiện hành của các chuẩn về mô hình chất lượng, đánh số phiên bản, thông điệp commit, chuỗi cung ứng
> (SLSA/SBOM) và đo lường giao hàng (DORA); chọn mức nào theo quy mô; chứng minh bằng CI. Quy trình Git/release ở
> [`../10-workflow/`](../10-workflow/README.md); kỹ thuật chuỗi cung ứng ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md).

## Nguyên tắc

- **Chuẩn quy trình chỉ có nghĩa khi máy thực thi.** Conventional Commits không có commitlint là văn hoá; có commitlint + release-please là hợp đồng.
- **Chất lượng là yêu cầu đo được, không phải tính từ.** ISO/IEC 25010 cho từ vựng (9 đặc tính); dự án phải gán số đo cho đặc tính nào quan trọng.
- **Phiên bản là lời hứa tương thích.** SemVer: major = phá vỡ; mọi API công khai (HTTP, thư viện, CLI, schema sự kiện) đều theo.
- **Chuỗi cung ứng có mức, tăng dần.** SLSA Build L1 (provenance) cho S, **L2 cho M, L3 cho L** — nhà là [`SEC-SUPPLY-014/015`](../12-security/supply-chain.md). SBOM sinh tự động mỗi release.
- **Đo trước khi tự động hoá.** DORA baseline trước khi bật agent/autopilot để biết tự động hoá có giúp hay không (catalog 21 §8).

## Quyết định

| Nhu cầu | Chuẩn | Mức theo quy mô | Không dùng khi |
|---|---|---|---|
| Từ vựng/khung yêu cầu chất lượng | ISO/IEC 25010:2023 | S: chọn ≤ 3 đặc tính có số đo; M/L: bảng đủ 9 đặc tính, "không áp dụng" có lý do | — |
| Đánh số phiên bản sản phẩm/thư viện/API | SemVer 2.0.0 | mọi quy mô | App tiêu dùng chỉ hiển thị → vẫn SemVer nội bộ, tên marketing riêng |
| Thông điệp commit, sinh changelog | Conventional Commits 1.0.0 + release-please | mọi quy mô | — |
| Chuỗi cung ứng build | SLSA v1.2 Build track | S: L1 (provenance); M: L2 (hosted build, provenance ký); L: L3 — theo [`SEC-SUPPLY-014/015`](../12-security/supply-chain.md) | Repo tài liệu thuần |
| SBOM | CycloneDX 1.7 (mặc định; ECMA-424) hoặc SPDX 3.0 (khi đối tác yêu cầu; bản ISO/IEC 5962:2021 tương ứng SPDX 2.2.1) | M+: sinh mỗi release | S nội bộ: MAY |
| Đo giao hàng | DORA 5 chỉ số (2025) | M+: đo tự động từ Git/CI/incident | S: ghi tay 2 chỉ số (lead time, deploy frequency) |
| Changelog | Keep a Changelog (phiên bản **chưa xác minh**) sinh từ commit | mọi quy mô | — |

## Bảng phiên bản hiện hành (xác minh 2026-10-13)

| Chuẩn | Phiên bản | Phát hành | URL | Áp dụng khi | Chứng minh tuân thủ |
|---|---|---|---|---|---|
| ISO/IEC 25010 | **2023** (ấn bản 2, 9 đặc tính) | 2023-11-15 (theo nguồn thứ cấp — iso.org 403) | <https://www.iso.org/standard/78176.html> | Viết yêu cầu phi chức năng | Bảng đặc tính → số đo → cổng trong `PROJECT.md` |
| Semantic Versioning | **2.0.0** | — | <https://semver.org/> | Mọi artifact có người tiêu thụ | Tag `vMAJOR.MINOR.PATCH`; oasdiff/API-extractor chặn breaking không major |
| Conventional Commits | **1.0.0** | — | <https://www.conventionalcommits.org/en/v1.0.0/> | Mọi repo | commitlint trong CI; changelog sinh tự động |
| SLSA | **v1.2** (Approved; thêm Source Track) | ngày phát hành **chưa xác minh** (trang không ghi) | <https://slsa.dev/spec/> | Build artifact phát hành | Provenance attestation xác minh được (`slsa-verifier`) |
| CycloneDX | **1.7** (ECMA-424) | 2025-10-21 | <https://cyclonedx.org/specification/overview/> | SBOM | File `sbom.cdx.json` mỗi release, `specVersion: "1.7"` |
| SPDX | **3.0**; ISO/IEC 5962:2021 tương ứng SPDX 2.2.1 | — | <https://spdx.dev/use/specifications/> | SBOM khi đối tác yêu cầu | File `.spdx.json` hợp lệ |
| DORA metrics | 5 chỉ số: change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate (báo cáo mới nhất 2025) | — | <https://dora.dev/guides/dora-metrics-four-keys/> | M+ | Dashboard tính từ Git/CI/incident |
| NIST SSDF | xem [`security-standards.md`](security-standards.md) | — | — | — | — |

## Checklist

- [ ] `STD-PROC-001` **MUST** `PROJECT.md` có bảng yêu cầu chất lượng theo đặc tính ISO/IEC 25010:2023 với số đo và ngưỡng cho ít nhất 3 đặc tính (vd performance efficiency: p95 < 300 ms; reliability: SLO 99,9%; security: ASVS L2). → Kiểm: `grep -c "25010" PROJECT.md` ≥ 1 và bảng có ≥ 3 hàng ngưỡng số. · Nguồn: ISO/IEC 25010:2023
- [ ] `STD-PROC-002` **MUST** Phiên bản phát hành theo SemVer 2.0.0, tag Git `vX.Y.Z`. → Kiểm: `git tag --list 'v*' | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'` rỗng. · Nguồn: SemVer 2.0.0 §2, §9, §10
- [ ] `STD-PROC-003` **MUST** Thay đổi phá vỡ API công khai chỉ đi với tăng MAJOR và ghi `BREAKING CHANGE:` trong commit. → Kiểm: CI so sánh hợp đồng (oasdiff/API Extractor/`go-apidiff`) đỏ khi breaking mà version không tăng major. · Nguồn: SemVer 2.0.0 §8; Conventional Commits 1.0.0 (footer BREAKING CHANGE)
- [ ] `STD-PROC-004` **MUST** Mọi commit vào nhánh chính (và tiêu đề PR khi squash) theo Conventional Commits, subject ≤ 72 ký tự. → Kiểm: commitlint (`@commitlint/config-conventional`) chạy trong CI job `pr-policy`, exit 0. · Nguồn: Conventional Commits 1.0.0
- [ ] `STD-PROC-005` **MUST@L** Changelog và tag release sinh tự động từ commit (release-please hoặc tương đương), không viết tay. → Kiểm: workflow release tồn tại; `CHANGELOG.md` có header do công cụ sinh. · Nguồn: Conventional Commits 1.0.0; Keep a Changelog
- [ ] `STD-PROC-006` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SUPPLY-012`](../12-security/supply-chain.md): SBOM CycloneDX 1.7 hoặc SPDX 3.0 cho mỗi bản phát hành, đính kèm artifact.
- [ ] `STD-PROC-007` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SUPPLY-014`](../12-security/supply-chain.md): SLSA Build L2 cho M (bản cũ ghi L1, lệch nhà).
- [ ] `STD-PROC-008` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SUPPLY-015`](../12-security/supply-chain.md): SLSA Build L3 cho L.
- [ ] `STD-PROC-009` **MUST@L** Đo 5 chỉ số DORA tự động từ Git/CI/incident, có baseline trước khi bật tự động hoá bằng agent. → Kiểm: dashboard/CSV `docs/ops/dora.csv` cập nhật theo lịch; file baseline có ngày. · Nguồn: DORA (dora.dev)
- [ ] `STD-PROC-010` **SHOULD** Nhánh chính chỉ nhận squash merge với tiêu đề PR dạng conventional (một PR = một commit). → Kiểm: ruleset/branch protection `squash` only (`.github/rulesets/main.json`).
- [ ] `STD-PROC-011` **SHOULD** Thư viện/SDK công khai công bố chính sách hỗ trợ phiên bản (major cũ được vá bao lâu) trong README. → Kiểm: mục "Versioning"/"Support policy" tồn tại.
- [ ] `STD-PROC-012` **SHOULD** Deployment rework rate (DORA 2025) được đếm từ PR/hotfix gắn nhãn `rework` để phát hiện tự động hoá tạo việc làm lại. → Kiểm: truy vấn PR nhãn `rework` trong dashboard DORA.
- [ ] `STD-PROC-013` **MAY** Dùng SPDX 3.0 song song CycloneDX khi khách hàng yêu cầu ISO/IEC 5962 (bản ISO 2021 tương ứng SPDX 2.2.1 — hỏi khách cần bản nào).
- [ ] `STD-PROC-014` **MAY** Áp SLSA Source Track (v1.2) cho repo có nhiều đội/kiểm toán.

## Bẫy thường gặp

- **SemVer "0.x mãi mãi".** 0.y.z cho phép phá vỡ bất cứ lúc nào; người dùng không có lời hứa nào. Cách tránh: ra 1.0.0 khi có người dùng thật; ghi chính sách (STD-PROC-011). Ngược lại, uv/ruff vẫn 0.x và đổi rule giữa các bản — ghim exact.
- **Squash lấy sai thông điệp.** Squash mặc định dùng tiêu đề commit đơn/PR; nếu tiêu đề không conventional thì changelog hỏng (catalog 23 §2.5, TRAPS 58). Cách tránh: lint cả tiêu đề PR lẫn mọi commit.
- **Tag `v1.2` thiếu patch** hoặc `1.2.3` thiếu `v` lẫn lộn → công cụ release không nhận. Cách tránh: STD-PROC-002 regex.
- **SBOM sinh một lần rồi quên.** SBOM cũ không phản ánh dependency hiện tại. Cách tránh: sinh trong job release, không commit file SBOM vào repo.
- **Nhầm SLSA level của "builder" với của artifact.** Dùng GitHub Actions không tự động là L3; cần generator/provenance đúng và cách ly. Cách tránh: `slsa-verifier` là bằng chứng, không phải tên nền tảng.
- **DORA bị gian lận bởi tự động hoá.** Lead time 4,4 phút = thời gian CI, merge trước khi CI xong (baseline xboss, catalog 23 §2.5). Cách tránh: đo kèm change fail rate + rework rate; CI "advisory" không tính là cổng.
- **ISO 25010 chép 9 đặc tính không có số.** "Hệ thống phải bảo trì được" không kiểm được. Cách tránh: STD-PROC-001 bắt ngưỡng số.
- **Dependabot/Renovate làm đầy WIP cap** khiến PR người đỏ. Cách tránh: gom nhóm 1 PR/tuần, bỏ semver-major, security tách riêng (catalog 23 §2.5).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| commitlint (MIT) | `npx commitlint --from origin/main` · PR title: `echo "$TITLE" \| npx commitlint` | commit-msg hook + CI `pr-policy` | 0 lỗi |
| release-please 17.11.2 (Apache-2.0) | workflow `googleapis/release-please-action` | CI trên push `main` | PR release tự mở |
| syft (Apache-2.0) | `syft dir:. -o cyclonedx-json@1.7 > sbom.cdx.json` | CI job release | file hợp lệ, `specVersion` 1.7 |
| cyclonedx-cli / `sbom-utility` | `cyclonedx validate --input-file sbom.cdx.json` | CI release | exit 0 |
| slsa-github-generator + slsa-verifier (Apache-2.0) | `slsa-verifier verify-artifact …` | CI release + bước cài đặt phía người dùng | exit 0 |
| oasdiff / `@microsoft/api-extractor` / `go-apidiff` | so hợp đồng base ↔ head | CI PR | 0 breaking trừ major |
| Script DORA (tự viết, đọc GitHub API/CI log) | `python3 scripts/dora.py --since 30d` | cron tuần | xuất 5 chỉ số, lưu `docs/ops/dora.csv` |
| Tag regex | xem STD-PROC-002 | CI release | rỗng |

Phiên bản commitlint, syft, slsa-verifier: **chưa xác minh** ngày 2026-10-13 — tra registry/GitHub release trước khi ghim SHA.

## Nguồn

- ISO/IEC 25010:2023: <https://www.iso.org/standard/78176.html> — **(iso.org trả 403 ngày 2026-10-13; ngày 2023-11-15 theo nguồn thứ cấp)**
- Semantic Versioning 2.0.0: <https://semver.org/> — xác minh 2026-10-13
- Conventional Commits 1.0.0: <https://www.conventionalcommits.org/en/v1.0.0/> — xác minh 2026-10-13
- SLSA v1.2 (Approved): <https://slsa.dev/spec/> · <https://slsa.dev/spec/v1.2/whats-new> — xác minh 2026-10-13 (ngày phát hành không ghi)
- CycloneDX 1.7 (2025-10-21, ECMA-424): <https://cyclonedx.org/specification/overview/> — xác minh 2026-10-13
- SPDX 3.0; ISO/IEC 5962:2021 tương ứng SPDX 2.2.1: <https://spdx.dev/use/specifications/> — xác minh 2026-10-13
- DORA metrics (5 chỉ số; báo cáo 2025): <https://dora.dev/guides/dora-metrics-four-keys/> · <https://dora.dev/research/> — xác minh 2026-10-13
- release-please v17.11.2 (24/08/2026): catalog `seeker19110/stored` 13 §4c — đọc 2026-10-13; bài học WIP cap/squash: 23 §2.5.
