---
title: Monorepo nhiều thành phần (web + mobile + API)
kind: profile
slug: monorepo
prefix: PRF-MONO
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Monorepo nhiều thành phần (web + mobile + API)

> Một repo chứa nhiều app (`apps/*`) và package dùng chung (`packages/*`), có thể nhiều ngôn ngữ. Hồ sơ này
> **không thay** hồ sơ của từng thành phần — mỗi app/package vẫn áp đúng hồ sơ của nó; hồ sơ này thêm phần
> **ranh giới package, build graph + cache, versioning, CODEOWNERS, CI theo phần bị ảnh hưởng**.

## Khi nào dùng

- ≥ 2 thành phần triển khai riêng (web + API, web + mobile, nhiều service) chia sẻ code (types, SDK, UI kit, config) và muốn thay đổi xuyên thành phần trong **một PR**.
- Không dùng khi: chỉ 1 app + vài thư viện nội bộ nhỏ (dùng workspace đơn giản trong hồ sơ app đó); các đội hoàn toàn độc lập, release độc lập, không chia sẻ code (polyrepo + package publish theo [`library-sdk.md`](library-sdk.md)).
- Cách ghép blueprint: `compose --profile monorepo` cho repo; **mỗi app** ghép thêm blueprint riêng theo hồ sơ của nó ([`web-app.md`](web-app.md), [`mobile-app.md`](mobile-app.md), [`api-service.md`](api-service.md)…) đặt tại `apps/<tên>/BLUEPRINT.md`.

## Kiến trúc tham chiếu (C4 mức 1)

```text
repo/
├─ apps/        web (web-app) · mobile (mobile-app) · api (api-service) · docs (static-site)   ← triển khai riêng, KHÔNG import lẫn nhau
├─ packages/    types/contracts · sdk-client · ui · config (tsconfig/biome/tailwind) · utils    ← import được từ apps, có ranh giới tầng
├─ tooling/     scripts, generators, CI helpers
├─ pnpm-workspace.yaml (+ catalog) · turbo.json (task graph + cache) · .changeset/ · CODEOWNERS
└─ .github/workflows: ci (affected) · release (changesets) · deploy theo app
Luồng: PR → affected graph → lint/type/test/build chỉ phần đổi + phụ thuộc ngược → required check `quality` → merge → release theo package/app
```

- **Quy tắc tầng**: `apps → packages`; `packages` không import `apps`; `packages/types` không phụ thuộc gì; không vòng. Kiểm bằng máy (xem [`../05-architecture/boundaries-and-modularity.md`](../05-architecture/boundaries-and-modularity.md)).
- **Một nguồn sự thật** cho phiên bản dependency (catalog), cấu hình lint/TS (package `config`), hợp đồng API (package `contracts` sinh từ OpenAPI/schema).

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**. Bảng cho monorepo JS/TS; đa ngôn ngữ xem dòng cuối.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Package manager/workspace | pnpm workspaces + `catalog:` | 12.11.2 (npm `latest`; endoflife.date ghi 12.12.1) | npm 12.2.0 workspaces khi muốn 0 công cụ thêm; Bun workspaces (chưa xác minh) |
| Task runner + cache | Turborepo | `turbo` 2.11.7 (remote cache HMAC-SHA256 `signature: true`) | Nx 23.3.0 khi cần graph plugin, generators, `nx affected` theo task; moon (chưa xác minh phiên bản) |
| Versioning/release | Changesets | `@changesets/cli` 3.0.3 | release-please 17.11.2 (conventional commits, mỗi package một manifest); Lerna 10.1.0 chỉ khi đã dùng |
| Đồng bộ phiên bản dep | pnpm `catalog` + syncpack | syncpack 15.3.3; `@manypkg/cli` 0.25.1 kiểm workspace | — |
| Ranh giới import | `dependency-cruiser` (chưa xác minh phiên bản) / Nx `enforce-module-boundaries` / Biome `noRestrictedImports` | Biome 2.5.15 | Go: `import-linter` tương đương Python (chưa xác minh) |
| Lint/format/type | Biome 2.5.15 (một config gốc) + `tsc -b` project references (TS 7.0.2) | — | oxlint 1.87.0 |
| Test | Vitest 5.0.4 workspace (`projects`) + Playwright 1.64.0 theo app | — | — |
| Dead code | knip 6.41.0 (workspace mode) | — | — |
| CI | GitHub Actions + affected (`turbo run --filter=...[origin/main]` / `nx affected --base=origin/main`) + `nrwl/nx-set-shas` | — | GitLab CI tương đương |
| Node | 24 LTS, một `.nvmrc` + `packageManager` ở gốc | 24.21.0 | — |
| Đa ngôn ngữ | Mỗi ngôn ngữ một workspace gốc (`go.work`, Cargo workspace, `uv` workspace) + task runner gốc gọi xuyên ngôn ngữ | Go 1.27.2; Rust 1.99.0; `uv` 0.13.0 | Bazel/Pants khi > hàng trăm package (chưa xác minh phiên bản) |

## Checklist

- [ ] `PRF-MONO-001` **MUST** Ranh giới package được **ép bằng máy**: apps không import apps; packages không import apps; không import vòng; không import đường dẫn tương đối xuyên package (`../../packages/x/src`). → Kiểm: `dependency-cruiser`/Nx boundaries/Biome `noRestrictedImports` chạy trong CI với 0 vi phạm; `pnpm -r exec madge --circular` (hoặc tương đương) rỗng. · Nguồn: [`../05-architecture/boundaries-and-modularity.md`](../05-architecture/boundaries-and-modularity.md)
- [ ] `PRF-MONO-002` **MUST** Mỗi package khai báo đúng dependency của mình (không dựa vào hoisting); cài với `--frozen-lockfile`; một lockfile ở gốc. → Kiểm: `pnpm install --frozen-lockfile` xanh; `knip` 0 "unlisted dependencies"; `manypkg check` xanh.
- [ ] `PRF-MONO-003` **MUST** Phiên bản dependency dùng chung được quản lý **một nơi** (pnpm `catalog:`) và kiểm lệch; mỗi dependency bên ngoài chỉ có **một** phiên bản major trong lockfile trừ ngoại lệ ghi lý do. → Kiểm: `syncpack lint` 0 lỗi; script liệt kê duplicate major trong `pnpm-lock.yaml` so với allowlist. · Nguồn: [`../00-method/principles.md`](../00-method/principles.md) P5
- [ ] `PRF-MONO-004` **MUST** Build graph khai báo tường minh (`turbo.json`/`project.json`): task `build` của package phụ thuộc `^build`; `inputs`/`outputs` đúng để cache không sai; biến môi trường ảnh hưởng build khai trong `env`/`globalEnv`. → Kiểm: `turbo run build --dry-run=json` cho đồ thị không vòng; test "cache hit sai": đổi env khai báo → cache miss.
- [ ] `PRF-MONO-005` **MUST** CI chạy **theo phần bị ảnh hưởng** + phụ thuộc ngược (affected), dùng base là commit CI xanh gần nhất trên `main`; đổi lockfile/config gốc → coi mọi thứ bị ảnh hưởng. → Kiểm: workflow dùng `--filter=...[<base>]` hoặc `nx affected --base`; `fetch-depth: 0`; test PR chỉ đổi `apps/docs` không chạy test `apps/api`. · Nguồn: Nx affected docs
- [ ] `PRF-MONO-006` **MUST** Một job gom `quality` làm **required check chất lượng** (lint/type/test/build/boundaries; ngoài ra chỉ `protection-guard`, `gitleaks`, `dep-audit`) để branch protection không lệch với tên job thay đổi. → Kiểm: ruleset `main` yêu cầu đúng job đó; job `quality` `needs` mọi job con. · Nguồn: catalog 13 §4b, 23 §2.5 — `research/2026-10-13-stored-catalog-extraction.md`
- [ ] `PRF-MONO-007` **MUST** `CODEOWNERS` theo thư mục app/package (và cho chính file `CODEOWNERS`, `.github/workflows`, `packages/config`); "Require review from Code Owners" bật; owner là team, không cá nhân. → Kiểm: file ở `.github/CODEOWNERS`; API `rules/branches/main` có `required_review_thread`/code owner review; mọi thư mục `apps/*`, `packages/*` khớp ít nhất một dòng. · Nguồn: GitHub CODEOWNERS docs
- [ ] `PRF-MONO-008` **MUST** Versioning rõ: app triển khai (không publish) dùng SHA/ngày + changelog theo app; package publish dùng semver qua Changesets (hoặc release-please manifest), mỗi PR đổi package công khai có changeset. → Kiểm: `changeset status --since=origin/main` trong CI đỏ khi thiếu; package app có `"private": true`. · Nguồn: [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md); [`library-sdk.md`](library-sdk.md) PRF-LIB-001
- [ ] `PRF-MONO-009` **MUST** Hợp đồng giữa app (API ↔ web ↔ mobile) là package `contracts` **sinh từ một nguồn** (OpenAPI/schema → types/client), không viết tay hai nơi; đổi hợp đồng = PR đổi cả producer và consumer. → Kiểm: CI chạy generator và `git diff --exit-code` trên output; contract test giữa api và client. · Nguồn: [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md)
- [ ] `PRF-MONO-010` **MUST@M** Remote cache có **ký và xác minh artifact** (Turborepo `remoteCache.signature: true` + `TURBO_REMOTE_CACHE_SIGNATURE_KEY`; Nx tương đương) và token cache chỉ đọc cho PR từ fork. → Kiểm: `turbo.json` có `signature: true`; workflow PR fork không có secret ghi cache. · Nguồn: Turborepo remote caching docs
- [ ] `PRF-MONO-011` **MUST** Deploy theo app, chỉ app bị ảnh hưởng, với bằng chứng từ cùng SHA đã qua `quality`; migration DB thuộc app `api` chạy trước deploy consumer theo quy ước mở rộng-rồi-thu hẹp. → Kiểm: workflow deploy có điều kiện affected; log deploy ghi SHA; thứ tự job `migrate` → `deploy-api` → `deploy-web`. · Nguồn: [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md); [`../09-database/migrations.md`](../09-database/migrations.md)
- [ ] `PRF-MONO-012` **SHOULD** Cấu hình dùng chung (tsconfig, Biome, Tailwind, ESLint plugin) nằm ở `packages/config` và được **extend**, không copy; mọi package `extends` từ đó. → Kiểm: grep `"extends"` mọi `tsconfig.json` trỏ về `@repo/config`; không có config trùng lặp (jscpd trên file config).
- [ ] `PRF-MONO-013` **SHOULD** Generator/template tạo package/app mới (`turbo gen`/`nx g`/script) đã có sẵn lint/test/tsconfig/CODEOWNERS/README chuẩn, để package mới không "quên" cổng. → Kiểm: tạo package mẫu bằng generator rồi chạy `quality` xanh ngay.
- [ ] `PRF-MONO-014` **SHOULD** Thời gian CI có ngân sách (vd PR chỉ đổi docs < N phút — dự án đặt) và theo dõi tỷ lệ cache hit; cache miss hàng loạt là sự cố cần điều tra. → Kiểm: `turbo run --summarize` lưu số cache hit theo PR; dashboard thời gian CI.
- [ ] `PRF-MONO-015` **SHOULD** Thay đổi xuyên tầng (đổi `packages/types` làm vỡ 3 app) phải chạy test của **mọi consumer** và có migration note trong PR; không merge khi consumer đỏ dù "sẽ sửa sau". → Kiểm: affected graph bao gồm dependents (mặc định); không có `continue-on-error` trong job test.
- [ ] `PRF-MONO-016` **SHOULD** Dependabot/Renovate gom nhóm theo workspace và giới hạn PR mở (WIP cap), cập nhật `catalog:` thay vì từng package. → Kiểm: `dependabot.yml` có `groups`; số PR bot mở ≤ cap. · Nguồn: [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `PRF-MONO-017` **SHOULD** Secrets và env theo **từng app** (không một `.env` gốc dùng chung), tên biến có tiền tố app; CI cấp secret theo job/environment tối thiểu. → Kiểm: không có `.env*` ở gốc trong `git ls-files`; mỗi app có `env.example` + schema validate. · Nguồn: [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `PRF-MONO-018` **MAY** Sparse checkout/partial clone và hướng dẫn cho đội chỉ làm một app; `README` gốc là bản đồ (app nào, chủ nào, chạy thế nào) trỏ README từng package. → Kiểm: `README.md` gốc có bảng app/package → owner → lệnh dev.
- [ ] `PRF-MONO-019` **MAY** Khi > 1 ngôn ngữ: task runner gốc gọi được tool từng ngôn ngữ (Turbo/Nx/moon/`make`), mỗi ngôn ngữ giữ workspace riêng (`go.work`, Cargo workspace, `uv` workspace) và cổng riêng theo hồ sơ. → Kiểm: `turbo run test` chạy cả `go test`/`pytest`; CI matrix theo ngôn ngữ chỉ khi affected.

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của monorepo | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals / p95 | **Áp theo từng app** bằng hồ sơ của app đó | Theo blueprint từng app | `apps/<app>/BLUEPRINT.md` |
| Lint/type/test | Chạy affected + dependents, gom vào `quality` | 0 lỗi; cache hit đúng (không false hit) | Turborepo/Nx; `quality` required check |
| Security headers/CSP | Ranh giới package + cache ký + CODEOWNERS | 0 vi phạm boundary; `signature: true`; 100 % thư mục có owner | dependency-cruiser/Nx boundaries; CODEOWNERS |
| Bundle budget | Số phiên bản major trùng của mỗi dep + kích thước mỗi app | 1 major/dep (trừ allowlist) | syncpack, lockfile script, `size-limit` theo app |
| Contract API | Package `contracts` sinh từ nguồn + contract test | `git diff --exit-code` sau generate | Generator trong CI |
| Preview/rollback | Preview và rollback **theo app**; release package theo Changesets | Deploy chỉ app affected; rollback từng app độc lập | Workflow deploy có điều kiện |
| Thời gian CI | Ngân sách CI theo loại PR + tỷ lệ cache hit | Dự án đặt; cache hit theo dõi theo PR | `turbo --summarize`, dashboard |
| Tài liệu | README gốc là bản đồ; README mỗi package | Mọi package có README + owner | `manypkg`/script kiểm file bắt buộc |

## Bẫy

- **Hoisting che dependency thiếu**: package chạy được nhờ package khác kéo dep → vỡ khi publish/tách. Hàng rào: PRF-MONO-002 (knip + manypkg), pnpm strict mặc định.
- **Cache hit sai** vì `inputs`/`env` khai thiếu → build "xanh" với output cũ. Hàng rào: PRF-MONO-004 test đổi env → miss; `--force` khi điều tra.
- **Affected tính sai base** (dùng `HEAD~1` thay vì commit xanh gần nhất) → bỏ sót test. Hàng rào: `nx-set-shas`/`--filter=...[origin/main]` + `fetch-depth: 0`.
- **Một `.env` gốc dùng chung** → app docs có secret của API. Hàng rào: PRF-MONO-017.
- **Import tương đối xuyên package** (`../../packages/ui/src/button`) qua mặt `exports` và cache. Hàng rào: boundary rule + `exports` map.
- **Hai phiên bản React/TS trong lockfile** → lỗi hooks/type khó hiểu. Hàng rào: catalog + syncpack.
- **Required check đặt theo tên job con** → đổi tên job = merge không cổng. Hàng rào: job `quality` gom (PRF-MONO-006); `protection-guard` đối chiếu ruleset với job thật (bài học khung cũ `ci.yml`).
- **"Sửa consumer sau"** khi đổi package chung → `main` đỏ kéo dài. Hàng rào: PRF-MONO-015.
- **Remote cache không ký + token ghi cho fork** → PR ngoài có thể đầu độc artifact cho `main`. Hàng rào: PRF-MONO-010.
- **Đính chính nguồn:** Turborepo docs chuyển từ `turborepo.com` sang `turborepo.dev` (redirect 301 ngày 2026-10-13); link cũ vẫn hoạt động nhưng nên cập nhật.

## Nguồn

- Turborepo remote caching (HMAC-SHA256 `signature`, `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, self-host): <https://turborepo.dev/docs/core-concepts/remote-caching> — xác minh 2026-10-13.
- Nx affected (base/head, `nx-set-shas`, lockfile → all affected): <https://nx.dev/docs/features/ci-features/affected> — xác minh 2026-10-13.
- GitHub CODEOWNERS (vị trí, cú pháp, Require review from Code Owners): <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners> — xác minh 2026-10-13.
- pnpm settings (`catalog`/`catalogs`, `minimumReleaseAge`, `engineStrict`, `verifyDepsBeforeRun`, `strictDepBuilds` có trong danh sách): <https://pnpm.io/settings> — xác minh 2026-10-13 (mô tả chi tiết từng khóa chưa đọc).
- Changesets workflow: <https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md> — xác minh 2026-10-13 (trang ghi outdated, trỏ changesets.dev).
- Phiên bản npm: `pnpm`, `npm`, `turbo`, `nx`, `@changesets/cli`, `release-please`, `lerna`, `syncpack`, `@manypkg/cli`, `knip`, `@biomejs/biome`, `oxlint`, `vitest`, `@playwright/test`, `typescript`; endoflife.date `pnpm` (12.12.1 — lệch với npm `latest` 12.11.2), `nodejs`, `go`, `rust`; PyPI `uv` — xác minh 2026-10-13.
- Bài học catalog: job `quality` gom làm required check, Dependabot gom nhóm + WIP cap, dhcb monorepo npm 3 app/23 package (13 §4b, 23 §2.5, 23 §4.1) — `research/2026-10-13-stored-catalog-extraction.md`; khung cũ `ci.yml` `protection-guard` — `research/2026-10-13-old-framework-analysis.md`; KHUNG-3 C10 (commit `1b80fe4`).
- (chưa xác minh) `dependency-cruiser`, `madge`, moon, Bazel/Pants, Bun workspaces phiên bản — không tra ngày 2026-10-13.
