# Chính sách cập nhật phụ thuộc

> BASE-DEP-003/006/007/008, OPS-MAINT-001/003. Cấu hình máy: `.github/dependabot.yml`, `scripts/eol-check.mjs`, `scripts/new-deps-check.mjs`,
> `scripts/check-image-pins.mjs`, `license-policy.json`. Xử lý lỗ hổng: [`VULN-SLA.md`](VULN-SLA.md).

## Nhịp cập nhật
- Dependabot bật cho mọi hệ sinh thái có manifest: `npm` (pnpm workspace), `github-actions`, `docker` (`deploy/**/Dockerfile*`), `docker-compose`
  (`deploy/compose.yaml`). Lịch **thứ Hai 03:00 giờ Việt Nam**; minor+patch gom một PR mỗi nhóm; trần PR mở 3 (npm) / 2 (còn lại);
  `cooldown` 14 ngày (không nhận bản mới phát hành chưa đủ hai tuần; cập nhật bảo mật không bị cooldown).
- Bản **major** không gom: một PR mỗi bản, dùng mẫu `.github/PULL_REQUEST_TEMPLATE/major-upgrade.md`, đọc changelog, có kế hoạch lùi.
- Mọi PR cập nhật vẫn qua đủ cổng (build · typecheck · lint · test · e2e · dep-audit · supply-chain). Không merge khi CI đỏ.
- Người duyệt xử lý PR Dependabot trong tuần; PR tồn đọng quá 2 tuần phải có lý do ở PR (hoặc đóng và ghi `@dependabot ignore` kèm lý do).
- Test `scripts/supply-chain.test.mjs` đối chiếu `dependabot.yml` với manifest thật: thêm hệ sinh thái/thư mục Dockerfile mà quên khai báo → test đỏ.

## Ghim
- Action: SHA 40 ký tự + `# vX.Y.Z` (`xt.py ci-check`). Image (compose, Dockerfile, service/container của workflow): `tag@sha256:<digest>`
  (`scripts/check-image-pins.mjs`). Binary tải về: kiểm SHA-256 (`scripts/dev-env-setup.sh`). Phiên bản Node/pnpm: `.nvmrc`, `packageManager`.
- Tương đương `pinact run --check` cho action: `ci-check` đã đòi SHA đầy đủ cho mọi `uses:` (không thêm công cụ thứ hai).

## Thêm phụ thuộc mới
Trước khi thêm: repo không archive, có bảo trì trong 12 tháng, giấy phép trong `license-policy.json` (`pnpm licenses:check`), không bật telemetry gửi dữ liệu
mặc định, đã có trong stdlib/repo chưa, **bản phát hành ≥ 2 tuần**. Mô tả PR có mục `## Phụ thuộc mới`, mỗi gói một dòng
`tên · giấy phép · lý do · phương án thay thế đã xét`; job `new-deps` (`.github/workflows/pr-deps.yml`) đỏ nếu `pnpm-lock.yaml` có phụ thuộc trực tiếp mới mà thiếu dòng.
Gói gián tiếp mới chỉ được báo; giấy phép và lỗ hổng của chúng do `licenses:check` và `dep-audit`/`supply-chain` kiểm.

## Hết hạn hỗ trợ (EOL)
`eol-check.yml` hằng tuần đối chiếu Node, Next.js, PostgreSQL, Caddy, Debian với endoflife.date: **đỏ** khi đã EOL (Node: còn ≤ 90 ngày);
**cảnh báo** khi còn < 6 tháng — mở việc nâng. SeaweedFS, pgBackRest, Alpine (trong tag caddy) không có trên endoflife.date: theo dõi qua Dependabot và quét image.

## SBOM và giấy phép
Mỗi lượt `supply-chain.yml` sinh SBOM CycloneDX (npm: `scripts/sbom.mjs`; image: syft) và lưu 90 ngày. `scripts/sbom-check.mjs`: giấy phép không rỗng ≥ 99%,
không NOASSERTION/UNKNOWN, không source-available (BUSL, SSPL, Elastic, Commons Clause…) ngoài `sbom_exceptions` của `license-policy.json`
(5 trường, hạn ≤ 12 tháng; source-available còn phải ghi ADR-NNNN).
