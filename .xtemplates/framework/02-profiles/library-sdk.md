---
title: Thư viện / SDK / package
kind: profile
slug: library-sdk
prefix: PRF-LIB
modules: [04-standards/*, 05-architecture/*, 08-backend/reliability-and-errors, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/maintenance-and-lifecycle, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-16
---

# Hồ sơ: Thư viện / SDK / package

> Mã được **người khác import** và nâng cấp theo lịch của họ. Sản phẩm là **API surface + type definitions +
> hợp đồng semver**; mỗi thay đổi công khai là một cam kết. Cổng chất lượng: API không vỡ ngoài ý muốn,
> package đúng định dạng cho mọi môi trường tiêu thụ, provenance khi publish, ma trận phiên bản hỗ trợ.

## Khi nào dùng

- Package publish lên npm/PyPI/crates.io/Maven/NuGet/pkg.go.dev, hoặc package nội bộ dùng chéo đội.
- SDK bọc API của sản phẩm (client chính thức) — ghép thêm [`../08-backend/api-design.md`](../08-backend/api-design.md) cho phía API.
- Không dùng khi: chạy như chương trình → [`cli-tool.md`](cli-tool.md) (CLI + thư viện: ghép cả hai); nhiều package trong một repo → [`monorepo.md`](monorepo.md) + hồ sơ này cho từng package.

## Kiến trúc tham chiếu (C4 mức 1)

```text
[Ứng dụng người dùng]  ──import──>  [Package]
                                      ├─ Public API (entry points, exports map, types) = HỢP ĐỒNG semver
                                      ├─ Internal (không export; đổi tự do)
                                      └─ Dependencies: ít, có dải phiên bản hợp lý; peerDependencies cho framework
[Repo] → CI (lint/type/test ma trận runtime) → build (ESM+CJS / wheel+sdist / crate)
      → kiểm package (publint, attw, twine check, cargo package) → publish qua OIDC + provenance → docs API sinh từ types
Bề mặt tiêu thụ: Node (ESM/CJS), bundler, Deno/Bun, browser, edge runtime; Python 3.x N phiên bản; Rust MSRV
```

- **API surface** được liệt kê tường minh (file `exports`, `__all__`, `pub`), có snapshot và kiểm diff trong CI.
- Thư viện **không** tự quyết thay người dùng: không log ra console mặc định, không đọc env ngầm, không side effect khi import.

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định (JS/TS) | Phiên bản (xác minh 2026-10-13) | Hệ sinh thái khác + điều kiện |
|---|---|---|---|
| Ngôn ngữ/runtime | TypeScript 7.0.2 `strict`; Node 24 LTS (24.21.0); hỗ trợ mọi Node còn LTS (22 Maintenance tới 2027-04-30) | — | Python 3.14.8 (hỗ trợ ≥ 3 phiên bản còn bảo trì); Go 1.27.2 (2 bản mới nhất); Rust 1.99.0 + MSRV ghi rõ |
| Build | `tsdown` (rolldown) xuất ESM + CJS + `.d.ts` | 0.23.1 | `tsup` 8.5.1; `tsc` thuần khi không bundle; Python `hatch` 1.18.1 / `uv build` 0.13.0; `cargo` |
| Kiểm package | `publint` + `@arethetypeswrong/cli` | 0.3.25 + 0.18.5 | `twine check` (chưa xác minh phiên bản); `cargo package --list` |
| API report | `@microsoft/api-extractor` (API report + diff) | 7.59.4 | `cargo-semver-checks` (chưa xác minh); Python `griffe` (chưa xác minh) |
| Docs API | TypeDoc | 0.28.20 | `mkdocs-material` 9.7.7 + mkdocstrings; `cargo doc`; `godoc` |
| Test | Vitest 5.0.4 + ma trận Node 22/24(/26 sau 2026-10-28) | — | pytest + `tox`/`nox` ma trận; `cargo test` + MSRV job |
| Versioning/changelog | Changesets `@changesets/cli` 3.0.3 (monorepo/đa package) hoặc release-please 17.11.2 (conventional commits) | — | semantic-release 25.0.9; Python: `hatch version` + towncrier (chưa xác minh) |
| Publish | npm **trusted publishing** (OIDC, provenance tự động) hoặc `npm publish --provenance` với `id-token: write` | — | PyPI Trusted Publishers (OIDC, token 15 phút); crates.io token scoped; Maven Central (chưa xác minh) |
| Kích thước | `size-limit` 14.2.0 (`@size-limit/preset-small-lib`) | — | Python: kích thước wheel trong CI |
| Lint/dep | Biome 2.5.15; knip 6.41.0 (export/dep thừa) | — | ruff/pyright; clippy + `cargo deny` 0.20.2 |
| License scan | Xem [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md) | — | — |

## Checklist

- [ ] `PRF-LIB-001` **MUST** Semantic Versioning 2.0.0: breaking → MAJOR, tính năng/deprecation → MINOR, sửa lỗi → PATCH; `0.y.z` được ghi rõ là chưa ổn định trong README; mỗi bản có CHANGELOG theo Keep a Changelog (Added/Changed/Deprecated/Removed/Fixed/Security). → Kiểm: tool versioning (Changesets/release-please) sinh version + changelog từ metadata, không gõ tay; CI chặn publish thiếu entry CHANGELOG. · Nguồn: semver.org 2.0.0; keepachangelog 1.1.0
- [ ] `PRF-LIB-002` **MUST** API surface công khai được **liệt kê tường minh** (`exports` map/`__all__`/`pub`) và có **API report** commit trong repo; PR làm đổi report phải gắn nhãn `breaking` hoặc `feature`. → Kiểm: `api-extractor run` (hoặc `cargo semver-checks`) trong CI; diff report ≠ rỗng mà không có nhãn → đỏ.
- [ ] `PRF-LIB-003` **MUST** Breaking change đi kèm: ghi chú nâng cấp (migration guide), deprecation warning ở ≥ 1 MINOR trước (khi khả thi), codemod cho thay đổi cơ học lớn. → Kiểm: mục `Removed`/`Changed` trong CHANGELOG trỏ guide; test deprecation warning phát ra ở bản trước.
- [ ] `PRF-LIB-004` **MUST** Type definitions đúng cho mọi cách tiêu thụ: ESM + CJS (hoặc ESM-only có ghi rõ), `exports` có `types` đúng điều kiện, không `any` ở API công khai. → Kiểm: `publint` 0 lỗi; `attw --pack` 0 vấn đề (không "Masquerading as CJS/ESM", không "FalseExportDefault"); `tsc --noEmit` trên project mẫu import package đã pack.
- [ ] `PRF-LIB-005` **MUST** Publish qua OIDC (npm trusted publishing / PyPI Trusted Publishers) với **provenance/attestation**; không token dài hạn trong CI; `repository` trong manifest khớp repo thật; 2FA bắt buộc cho tài khoản publish. → Kiểm: `npm audit signatures` xanh trên bản đã publish; workflow có `permissions: id-token: write` và không có `NPM_TOKEN`; PyPI project hiện publisher. · Nguồn: npm provenance docs; PyPI trusted publishers; SLSA v1.2
- [ ] `PRF-LIB-006` **MUST** Ma trận phiên bản hỗ trợ ghi trong README + `engines`/`requires-python`/`rust-version` và CI test **đúng ma trận đó** (ít nhất bản thấp nhất và cao nhất). → Kiểm: workflow matrix khớp bảng README; `engines.node` tồn tại; `pnpm install --engine-strict` qua. · Nguồn: endoflife.date (chọn phiên bản còn hỗ trợ)
- [ ] `PRF-LIB-007` **MUST** Không side effect khi import: không log, không đọc env/file, không fetch, không patch global; `sideEffects: false` (hoặc liệt kê file có) để tree-shake. → Kiểm: test `import` package rồi assert không có output/console/network; `package.json` có `sideEffects`.
- [ ] `PRF-LIB-008` **MUST** Dependency tối thiểu: không kéo framework vào `dependencies` (dùng `peerDependencies` + `peerDependenciesMeta`), không dependency chỉ cho dev vào runtime, không ghim chặt `=x.y.z` dependency runtime trừ lý do bảo mật có ghi. → Kiểm: `knip` 0 dep thừa; script kiểm `dependencies` không chứa `react|vue|typescript|@types/*`; kích thước install (`npm pack --dry-run`) có ngân sách.
- [ ] `PRF-LIB-009` **MUST** `npm pack`/`sdist`+`wheel` chỉ chứa file cần (`files`/`MANIFEST.in`/`include`), không chứa test, `.env`, source map tới mã nguồn nội bộ không công khai, hay bí mật. → Kiểm: `npm pack --dry-run` so với allowlist; gitleaks trên tarball; kích thước tarball < ngân sách.
- [ ] `PRF-LIB-010` **MUST** Lỗi do thư viện ném có **kiểu/mã** riêng (class/enum) và tài liệu; không nuốt lỗi; không `process.exit` trong thư viện. → Kiểm: test mỗi mã lỗi; lint cấm `process.exit`/`sys.exit` trong `src/`. · Nguồn: [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md)
- [ ] `PRF-LIB-011` **MUST@M** Chính sách bảo mật: `SECURITY.md` (kênh báo lỗ hổng riêng tư, SLA phản hồi), advisory qua GitHub Security Advisories/CVE, bản vá backport cho dòng còn hỗ trợ ghi trong bảng hỗ trợ. → Kiểm: file tồn tại; bảng "phiên bản được vá" trong `SECURITY.md`. · Nguồn: [`../18-cross-cutting/open-source-and-community.md`](../18-cross-cutting/open-source-and-community.md)
- [ ] `PRF-LIB-012` **SHOULD** Docs API sinh từ types/docstring (TypeDoc/mkdocstrings/rustdoc), mỗi API công khai có ví dụ chạy được và ví dụ được **test** (doctest/ví dụ trong test). → Kiểm: `typedoc --treatWarningsAsErrors`; doctest trong CI; README quickstart chạy trong CI trên package đã pack.
- [ ] `PRF-LIB-013` **SHOULD** Kích thước bundle khi người dùng import có ngân sách (`size-limit` cho entry chính và subpath), tree-shake được (import 1 hàm không kéo cả package). → Kiểm: `size-limit` CI; test bundle 1 hàm với `import { x }` so ngân sách.
- [ ] `PRF-LIB-014` **SHOULD** Dùng được ở nhiều runtime đã claim (Node, browser, Deno/Bun, edge): không dùng API chỉ Node ở entry chung; có điều kiện `exports` (`browser`, `node`, `default`) khi cần. → Kiểm: smoke test import trong runtime claim (vd `deno run`, `bun`, Playwright browser).
- [ ] `PRF-LIB-015` **SHOULD** Pre-release (`-alpha/-beta/-rc`) và dist-tag `next` cho major mới; không publish bản thử lên `latest`; có thể `npm deprecate` bản lỗi thay vì unpublish. → Kiểm: workflow pre-release gắn tag đúng; test `npm view <pkg> dist-tags`.
- [ ] `PRF-LIB-016` **SHOULD** Dependency có lịch cập nhật (Dependabot/Renovate gom nhóm) và audit theo lịch vì lỗ hổng mới xuất hiện dù lockfile không đổi. → Kiểm: `dependabot.yml`/`renovate.json`; job cron `pnpm audit`/`pip-audit`. · Nguồn: [`../01-baseline/dependencies.md`](../01-baseline/dependencies.md)
- [ ] `PRF-LIB-017` **SHOULD** Tương thích ngược được kiểm bằng **test của bản trước** chạy trên bản mới (hoặc contract test với 1–2 dự án tiêu thụ thật) trước mỗi MINOR. → Kiểm: job `compat` chạy test suite tag trước với build mới.
- [ ] `PRF-LIB-018` **MAY** Hỗ trợ dòng LTS riêng (vd `v1.x` nhận vá bảo mật 12 tháng sau `v2.0`) khi người dùng doanh nghiệp lớn. → Kiểm: nhánh `v1.x` có CI; bảng hỗ trợ ghi ngày hết hạn.
- [ ] `PRF-LIB-019` **MAY** Reproducible build (`SOURCE_DATE_EPOCH`, lockfile ghim) để bên thứ ba xác minh tarball khớp nguồn. → Kiểm: build 2 lần cùng hash tarball; hướng dẫn xác minh trong docs.
- [ ] `PRF-LIB-020` **SHOULD** Gói phát hành kèm hướng dẫn cho **agent của bên dùng** (`AGENTS.consumer.md`, `llms.txt` hoặc skill) nằm **trong tarball/wheel**, cùng phiên bản với mã; MCP của thư viện (nếu có) chạy cục bộ và đọc từ bản đã cài, không gọi tài liệu hosted có thể cũ hơn. → Kiểm: `npm pack --dry-run` (hoặc `unzip -l` wheel) liệt kê file hướng dẫn đó. · Nguồn: `seeker19110/stored` 06 §7f.2 (Zen DS: `AGENTS.consumer.md` + `llms.txt` đi kèm package, MCP stdio cục bộ không gọi mạng), 22 §2 (Remotion deprecate MCP vì tài liệu stale); đọc 2026-10-16

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của library-sdk | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals | Kích thước import + thời gian import | Ngân sách `size-limit` theo entry; `import` không side effect | `size-limit`, test import |
| axe/a11y | **DX của người tích hợp**: `--help` ở đây là docs API + types đúng | `publint` 0 lỗi; `attw` 0 vấn đề; typedoc 0 warning | publint, attw, TypeDoc |
| E2E Playwright | Ma trận runtime + test package đã pack + compat test bản trước | Xanh trên bản thấp nhất và cao nhất đã claim | GitHub matrix; `npm pack` + project mẫu |
| Security headers/CSP | Provenance + OIDC publish + SECURITY.md | 100 % bản publish có attestation; không token dài hạn | npm trusted publishing, PyPI trusted publishers, `npm audit signatures` |
| Contract API | API report + semver + CHANGELOG | Diff API không nhãn → đỏ; breaking chỉ ở MAJOR | api-extractor / cargo-semver-checks; Changesets |
| Bundle budget | Tarball/wheel size + dependency count | Dự án đặt; dep runtime tối thiểu | `npm pack --dry-run`, knip |
| Preview deployment | Pre-release + dist-tag `next` | Mỗi MAJOR có ≥ 1 RC công khai | npm dist-tags; PyPI pre-release |
| Rollback | `deprecate` bản lỗi + publish patch; không unpublish | Patch trong SLA `SECURITY.md` | `npm deprecate`; yank (crates.io) |
| (không có ở web) | Hướng dẫn cho agent nằm trong gói | File có trong danh sách tarball/wheel | `npm pack --dry-run`; `unzip -l` |

## Bẫy

- **Export "tiện tay" mọi thứ** → mọi refactor nội bộ thành breaking. Hàng rào: `exports` map tường minh + API report.
- **Types sai với CJS/ESM thật** (hoạt động với bundler nhưng vỡ với `node` thuần) — `attw` bắt được; không tin "chạy được trên máy tôi".
- **Ghim chặt dependency runtime** gây xung đột phiên bản ở dự án người dùng; hoặc **đưa framework vào `dependencies`** → nhân đôi React. Hàng rào: PRF-LIB-008.
- **Publish bằng token dài hạn trong CI** → token lộ = package bị thay thế (chuỗi cung ứng). Hàng rào: OIDC + provenance; 2FA.
- **Unpublish để "sửa"** → vỡ build của mọi người (và npm giới hạn unpublish). Hàng rào: `deprecate` + patch.
- **Side effect khi import** (đọc env, in log, polyfill global) → lỗi không giải thích được ở dự án người dùng; chặn tree-shake.
- **Nâng major theo tháng** vì không muốn giữ tương thích → người dùng ngừng cập nhật. Hàng rào: deprecation ≥ 1 MINOR + migration guide + codemod.
- **CHANGELOG viết tay quên mục** → người dùng không biết breaking. Hàng rào: sinh từ Changesets/conventional commits.
- **Test chỉ trên source, không trên package đã pack** → thiếu file trong `files` chỉ phát hiện sau publish. Hàng rào: PRF-LIB-004/009 test trên tarball.
- **Hướng dẫn cho agent ở website/MCP hosted** → agent của người dùng đọc tài liệu mới hơn/cũ hơn bản đã cài, sinh code sai API (Remotion bỏ MCP vì stale). Đưa vào tarball, cùng phiên bản (`PRF-LIB-020`).

## Nguồn

- Semantic Versioning 2.0.0: <https://semver.org/> — xác minh 2026-10-13. Keep a Changelog 1.1.0: <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13.
- npm provenance & trusted publishing (`--provenance`, `id-token: write`, `npm audit signatures`): <https://docs.npmjs.com/generating-provenance-statements> — xác minh 2026-10-13. PyPI Trusted Publishers: <https://docs.pypi.org/trusted-publishers/> — xác minh 2026-10-13.
- SLSA v1.2: <https://slsa.dev/spec/v1.2/> (mức Build theo nhà [`../12-security/supply-chain.md`](../12-security/supply-chain.md): L2 @M, L3 @L) — xác minh 2026-10-13.
- Node.js LTS: <https://endoflife.date/api/nodejs.json>; Python: <https://endoflife.date/api/python.json>; Go, Rust tương tự — xác minh 2026-10-13.
- Phiên bản npm: `tsdown`, `tsup`, `publint`, `@arethetypeswrong/cli`, `@microsoft/api-extractor`, `typedoc`, `vitest`, `@changesets/cli`, `release-please`, `semantic-release`, `size-limit`, `@biomejs/biome`, `knip`, `typescript`; PyPI `hatch`, `uv`, `mkdocs-material`; crates.io `cargo-deny` — xác minh 2026-10-13.
- Changesets workflow (`add` → `version` → `publish`): <https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md> (trang ghi "outdated", trỏ changesets.dev) — xác minh 2026-10-13.
- (chưa xác minh) `twine`, `cargo-semver-checks`, `griffe`, towncrier, Maven Central publishing, `mkdocstrings` — không tra ngày 2026-10-13.
- Catalog: npm provenance, REA (Release Please → publish → verify CLI từ npm, TypeDoc) 23 §4 — `research/2026-10-13-stored-catalog-extraction.md`; khung cũ KHUNG-3 C6 (commit `1b80fe4`).
- Catalog `seeker19110/stored` 06 §7f.2 (Zen DS: lớp cho AI agent trong package), 22 §2 (Remotion: MCP deprecated vì stale) — đọc 2026-10-16.
