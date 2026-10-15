---
title: Build, tooling, lint/format/type, env công khai
kind: module
prefix: FE-BUILD
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Build, tooling, lint/format/type, env công khai

> Chuỗi công cụ frontend phải **tái lập được, nhanh, và chặn lỗi trước khi vào repo**: Node LTS ghim, lockfile, TypeScript
> strict, một bộ lint/format, env validate lúc build (client/server tách), không `ignoreBuildErrors`, source map không public,
> bundle có phân tích. Cổng tối thiểu mọi dự án → [`../01-baseline/quality-gates.md`](../01-baseline/quality-gates.md); CI →
> [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md); phân tích tĩnh chung →
> [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md).

## Nguyên tắc

1. **Build tái lập**: cùng lockfile + cùng Node + cùng package manager ⇒ cùng artifact. CI dùng `npm ci`/`pnpm install --frozen-lockfile`.
2. **Lỗi type/lint là lỗi build.** Không cờ bỏ qua; không hạ ngưỡng để xanh.
3. **Một bộ công cụ, chạy ở hai nơi**: pre-commit (nhanh, file đã sửa) và CI (toàn bộ) — cùng cấu hình, cùng phiên bản.
4. **Env là hợp đồng có kiểu**: schema tách `client` (tiền tố công khai) và `server`; thiếu/sai → build fail, không "undefined" ở runtime.
5. **Biết bundle của mình**: analyzer trong quy trình, ngân sách là cổng (xem [`performance-web-vitals.md`](performance-web-vitals.md)).
6. **Mục tiêu trình duyệt tường minh** (Baseline/browserslist), không "mọi trình duyệt".

## Quyết định

| Câu hỏi | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Bundler/dev server | **Vite 8.3.4** (MIT) cho SPA/library; bundler tích hợp của meta-framework (Next 16.4.0, Nuxt 4.6.1, SvelteKit 3.0.1, Astro 7.3.8) | Theo framework | Webpack tự cấu hình cho dự án mới |
| TypeScript | **TypeScript 7.0.2** (bản native, 08/07/2026) với `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; 6.0 (23/03/2026) là bản JS cuối — dùng khi tool chain chưa hỗ trợ 7 | Mọi dự án TS | `any`/`@ts-ignore` không lý do; tắt `strict` cho "nhanh" |
| Lint + format | **Biome 2.5.15** (MIT/Apache-2.0; > 500 rule, format tương thích Prettier) | Repo mới, muốn một công cụ | Cần rule type-aware/plugin đặc thù (`typescript-eslint` 8.71.2, `jsx-a11y`, `tanstack/query`) → ESLint 10.12.0 + oxlint 1.87.0 chạy trước cho tốc độ |
| Dead code/dup | knip 6.41.0 (ISC) + jscpd 5.4.1 (MIT) | Mọi dự án | — |
| Env validate | `@t3-oss/env-nextjs` 0.13.11 (Next) hoặc `env.ts` với Zod/Valibot tách `client`/`server`; Vite: `import.meta.env` + `vite-env.d.ts` + schema | Mọi dự án | Đọc `process.env.X!` rải rác |
| Pre-commit | lefthook 2.2.1 (MIT) hoặc husky 9.1.7 + lint-staged 17.6.0 | Mọi dự án | Hook chạy toàn repo > 10 s → chỉ staged files |
| Node | **Node 24 LTS** (Active tới 20/10/2026 → Maintenance; EOL 30/04/2028); Node 26 thành LTS 28/10/2026 — đổi sau khi tool chain xác nhận | Mọi dự án | Node 22 chỉ bảo trì (EOL 30/04/2027); không dùng bản lẻ (25) |
| Package manager | Ghim bằng trường `packageManager` (corepack) + lockfile commit | Mọi dự án | Hai lockfile trong repo |

## Checklist

- [ ] `FE-BUILD-001` **MUST** Node và package manager ghim: `.nvmrc`/`.node-version` + `engines.node` + `packageManager`; CI dùng đúng bản; lockfile commit, cài bằng `npm ci`/`--frozen-lockfile`. → Kiểm: CI step `node --version` khớp `.nvmrc`; `git ls-files | grep -c lock` = 1; `npm ci` không sửa lockfile (`git diff --exit-code`). · Nguồn: endoflife.date Node.js
- [ ] `FE-BUILD-002` **MUST@L** TypeScript `strict: true` (+ `noUncheckedIndexedAccess`, `noImplicitOverride`); không `any` tường minh, không `@ts-ignore` (dùng `@ts-expect-error` có lý do). → Kiểm: `tsc --noEmit` xanh trong CI; lint `no-explicit-any`, `ban-ts-comment` error; grep `@ts-ignore` = 0.
- [ ] `FE-BUILD-003` **MUST** Build production không bỏ qua lỗi: không `ignoreBuildErrors`/`ignoreDuringBuilds`/`skipLibCheck` để che lỗi dự án; `build` chạy sau `typecheck` + `lint`. → Kiểm: grep cấu hình = 0; thứ tự job trong CI. · Nguồn: catalog 09 §1.4
- [ ] `FE-BUILD-004` **MUST** Lint + format một cấu hình, 0 cảnh báo (`--max-warnings 0`), chạy ở pre-commit (staged) và CI (toàn bộ), cùng phiên bản (lockfile). → Kiểm: `biome ci .` hoặc `eslint . --max-warnings 0 && prettier --check .` xanh; hook pre-commit tồn tại (`lefthook.yml`/`.husky/`).
- [ ] `FE-BUILD-005` **MUST** Env có schema tách `client`/`server`; biến client chỉ qua tiền tố công khai; thiếu/sai kiểu → build/khởi động fail; không `process.env.X!` ngoài module env. → Kiểm: test chạy build với env thiếu → exit ≠ 0; grep `process.env\.` ngoài `env.ts` = 0 (trừ cấu hình). · Nguồn: Next.js env docs; Vite env docs; [`../01-baseline/configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md)
- [ ] `FE-BUILD-006` **MUST@L** Source map production không public: Next mặc định tắt; Vite `'hidden'` khi cần upload cho error tracking, xoá khỏi artifact deploy. → Kiểm: `curl -I <asset>.js.map` → 404 trên production; job upload map có bước xoá. · Nguồn: Next.js `productionBrowserSourceMaps`; Vite `build.sourcemap`
- [ ] `FE-BUILD-007` **MUST@L** Mục tiêu trình duyệt tường minh (`browserslist` 4.29.3 hoặc `build.target`), ghi trong repo và khớp chính sách hỗ trợ của sản phẩm; polyfill chỉ theo mục tiêu. → Kiểm: file `.browserslistrc`/`build.target` tồn tại; `npx browserslist` in danh sách; không `core-js` toàn bộ trong bundle. · Nguồn: Vite build options (`baseline-widely-available`)
- [ ] `FE-BUILD-008` **MUST@L** Bundle được phân tích khi thêm dependency hoặc khi ngân sách báo; dead code/dependency thừa bị gỡ định kỳ. → Kiểm: `knip` 0 unused trong CI; `size-limit` xanh; PR thêm dependency > 20 kB có ảnh analyzer. · Nguồn: [`performance-web-vitals.md`](performance-web-vitals.md); [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `FE-BUILD-009` **MUST@L** Build không cần mạng ngoài registry (không tải binary/font/schema lúc build từ URL không ghim); artifact build gắn commit SHA và có thể tái tạo. → Kiểm: build trong CI với proxy chỉ cho registry xanh; artifact có `BUILD_SHA` (env/meta tag).
- [ ] `FE-BUILD-010` **MUST@L** Một job `quality` gom typecheck/lint/test/build làm required check chất lượng (ngoài `protection-guard`, `gitleaks`, `dep-audit`); thời gian ≤ ngân sách (vd 10 phút) nhờ cache (`node_modules`, `.next/cache`, Playwright browsers). → Kiểm: branch ruleset yêu cầu job `quality`; cache key theo lockfile; thời gian job theo dõi. · Nguồn: catalog 23 §2.5, 13 §4b
- [ ] `FE-BUILD-011` **SHOULD** Pre-commit chỉ chạy trên file staged (lint/format/typecheck nhanh) < 10 s; pre-push chạy test liên quan. → Kiểm: `lefthook.yml` có `{staged_files}`; đo thời gian hook.
- [ ] `FE-BUILD-012` **SHOULD** Cấu hình tool chain nằm ở file (không trong `package.json` scripts dài); script đặt tên chuẩn: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `check:*` — và khai báo trong `xt.yaml`/tài liệu để agent chạy đúng. → Kiểm: `package.json` có đủ script; `xt.yaml` trỏ tới. · Nguồn: [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md)
- [ ] `FE-BUILD-013` **SHOULD** Trùng lặp mã ≤ ngưỡng dự án (jscpd) và theo dõi không tăng. → Kiểm: `jscpd --threshold <n>` trong CI.
- [ ] `FE-BUILD-014` **SHOULD** Dependency cập nhật tự động theo nhóm (Renovate/Dependabot), ghim exact cho tool chain; major update có PR riêng chạy đủ cổng. → Kiểm: file cấu hình bot; `package.json` tool chain không `^` (xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
- [ ] `FE-BUILD-015` **SHOULD** Monorepo: task graph (Turborepo/Nx) với cache theo input, `affected` cho CI; mỗi package có `typecheck`/`lint` riêng (xem hồ sơ monorepo). → Kiểm: `turbo run build --filter=...[origin/main]` chạy trong CI.
- [ ] `FE-BUILD-016` **SHOULD** Lint a11y, security, query bật trong bộ rule (jsx-a11y hoặc Biome `a11y`; `react/no-danger`; `@tanstack/eslint-plugin-query`). → Kiểm: cấu hình lint liệt kê plugin; 0 vi phạm.
- [ ] `FE-BUILD-017` **SHOULD** Telemetry của tool chain tắt hoặc có ý thức (Next `NEXT_TELEMETRY_DISABLED=1`, Storybook `disableTelemetry`, Turbo `TURBO_TELEMETRY_DISABLED`) trong CI và máy dev. → Kiểm: biến env trong CI/`.env.example`; cấu hình Storybook. · Nguồn: [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md) luật 7
- [ ] `FE-BUILD-018` **MAY** Dùng oxlint 1.87.0 làm pass nhanh trước ESLint type-aware. → Kiểm: script `lint` chạy `oxlint && eslint`.
- [ ] `FE-BUILD-019` **MAY** Dùng `node:test` thay Vitest khi muốn ít phụ thuộc (ADR). → Kiểm: ADR ghi lý do; CI chạy `node --test`.
- [ ] `FE-BUILD-020` **MAY** Kiểm license dependency frontend trong CI (xem [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)). → Kiểm: báo cáo license không có giấy phép cấm.

## Bẫy thường gặp

- **`ignoreBuildErrors: true` "tạm thời"** → ở lại mãi, production chạy code type sai.
- **Hai lockfile** (npm + pnpm) hoặc không commit lockfile → CI và máy dev khác phiên bản, lỗi không tái hiện.
- **Node không ghim** → CI chạy Node mới, dev chạy cũ; hoặc dùng bản lẻ (25) không LTS.
- **`process.env.NEXT_PUBLIC_X!` rải 30 chỗ** → thiếu biến chỉ lộ khi người dùng bấm; schema env fail lúc build.
- **Format bằng Prettier ở máy, Biome ở CI** → diff vô tận; một công cụ, một phiên bản.
- **Pre-commit chạy toàn bộ test** → 2 phút mỗi commit → mọi người `--no-verify`. Staged files + CI làm phần nặng.
- **`skipLibCheck` để che lỗi kiểu của dự án**: chỉ dùng cho `.d.ts` bên thứ ba có chủ đích và ghi lý do.
- **Source map public để Sentry đọc** → lộ mã; upload riêng rồi xoá.
- **`next dev` ghi đè file tài liệu agent** (đã ghi nhận `AGENTS.md` bị ghi đè): giữ bản gốc trong `docs/` và script kiểm.
- **Nâng TypeScript 7 mà tool chain (lint type-aware, plugin) chưa hỗ trợ** → lỗi lạ; thử trên nhánh, giữ 6.x cho tới khi xanh.
- **Chạy cài đặt bằng `curl | sh` cho tool mới** → chuỗi cung ứng; cài qua registry có ghim (xem supply-chain).

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| TypeScript 7.0.2 (Apache-2.0) | `tsc --noEmit` (`tsc -b` monorepo) | pre-push + CI | 0 lỗi |
| Biome 2.5.15 (MIT/Apache-2.0) **hoặc** ESLint 10.12.0 + typescript-eslint 8.71.2 + oxlint 1.87.0 (MIT) | `biome ci .` / `oxlint && eslint . --max-warnings 0` | pre-commit (staged) + CI | 0 lỗi, 0 cảnh báo |
| knip 6.41.0 (ISC) · jscpd 5.4.1 (MIT) | `knip` · `jscpd src --threshold <n>` | CI | 0 unused; ≤ ngưỡng |
| Env schema (`@t3-oss/env-nextjs` 0.13.11 / Zod `env.ts`) | chạy trong `next.config`/`vite.config` | build | fail khi thiếu/sai |
| size-limit 14.2.0 + analyzer | `size-limit` | CI | ≤ ngân sách |
| lefthook 2.2.1 / husky 9.1.7 + lint-staged 17.6.0 (MIT) | `pre-commit: lint/format staged; pre-push: typecheck+test` | máy dev | < 10 s pre-commit |
| Grep cấu hình nguy hiểm | `rg -n "ignoreBuildErrors|ignoreDuringBuilds|@ts-ignore" --glob '!node_modules'` | pre-commit + CI | 0 |
| curl | `curl -I <asset>.js.map` | smoke sau deploy | 404 |
| Renovate/Dependabot | cấu hình gom nhóm | lịch | PR tự động qua cổng |

## Nguồn

- TypeScript devblog — TypeScript 7.0 (08/07/2026, bản native), 6.0 (23/03/2026; "last release based on the current JavaScript codebase"), 5.9 (01/08/2025): <https://devblogs.microsoft.com/typescript/> — xác minh 2026-10-13.
- Vite blog (Vite 8: 12/03/2026) <https://vite.dev/blog>; Vite build options (`build.sourcemap` mặc định `false`/`'hidden'`; `build.target` `baseline-widely-available` mốc 2026-01-01: Chrome 111, Edge 111, Firefox 114, Safari 16.4) <https://vite.dev/config/build-options>; Env and Mode (`VITE_` lộ ra client) <https://vite.dev/guide/env-and-mode> — xác minh 2026-10-13.
- Next.js 16.4.0 — Environment variables (`NEXT_PUBLIC_` inline lúc build; runtime env qua `connection()`) <https://nextjs.org/docs/app/guides/environment-variables>; `productionBrowserSourceMaps` mặc định tắt <https://nextjs.org/docs/app/api-reference/config/next-config-js/productionBrowserSourceMaps> — xác minh 2026-10-13.
- endoflife.date — Node.js (24 Active LTS tới 2026-10-20, EOL 2028-04-30; 22 Maintenance, EOL 2027-04-30; 26 LTS từ 2026-10-28; 20 EOL 2026-04-30): <https://endoflife.date/api/nodejs.json> — xác minh 2026-10-13.
- Biome blog (v2.5 05/06/2026: > 500 rule; v2.4 10/02/2026: 15 rule a11y HTML): <https://biomejs.dev/blog/> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): typescript 7.0.2 · vite 8.3.4 · @vitejs/plugin-react 6.1.2 · next 16.4.0 · nuxt 4.6.1 · @sveltejs/kit 3.0.1 · astro 7.3.8 · @biomejs/biome 2.5.15 · eslint 10.12.0 · typescript-eslint 8.71.2 · oxlint 1.87.0 · knip 6.41.0 · jscpd 5.4.1 · lefthook 2.2.1 · husky 9.1.7 · lint-staged 17.6.0 · browserslist 4.29.3 · @t3-oss/env-nextjs 0.13.11 · size-limit 14.2.0.
- Catalog `seeker19110/stored` mục 13 §4b–4c (biome/oxlint + knip + jscpd; một job `quality` required; pre-commit ở máy và CI), mục 09 §1.4 (không `ignoreBuildErrors`), mục 23 §2.4 (`next dev` ghi đè AGENTS.md), đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md` §2.9.
