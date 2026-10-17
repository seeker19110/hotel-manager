---
title: Phân tích tĩnh: lint, type, complexity, dead code, trùng lặp, kiến trúc
kind: module
prefix: QA-STATIC
applies_to: [all]
updated: 2026-10-16
---

# Phân tích tĩnh: lint, type, complexity, dead code, trùng lặp, kiến trúc

> Những gì máy kiểm được **không cần chạy code**: lint, kiểu, độ phức tạp, code chết, trùng lặp, ranh giới kiến trúc, và
> quy trình **tối ưu mã nguồn** không đổi hành vi. Bảo mật tĩnh (SAST) ở [`../12-security/appsec-web.md`](../12-security/appsec-web.md);
> ranh giới module ở [`../05-architecture/boundaries-and-modularity.md`](../05-architecture/boundaries-and-modularity.md).

## Nguyên tắc

- **Cổng máy trước, người sau** (P9): lint/type/format/dead-code chạy ở hook **và** CI (hook bỏ qua được bằng `--no-verify`).
- **Chế độ nghiêm từ đầu, nới có lý do.** TypeScript `strict` + `noUncheckedIndexedAccess`; pyright `strict` (hoặc mypy `--strict`); `any`/`# type: ignore` phải kèm lý do.
- **Tối ưu mã nguồn ≠ tối ưu hiệu năng.** Mục này làm mã dễ đọc/ít rác cho lập trình viên; hiệu năng runtime ở [`performance-and-load.md`](performance-and-load.md). Refactor **không đổi hành vi**, có test bảo vệ, đo trước–sau, PR riêng.
- **Baseline rồi ratchet.** Dự án có sẵn: đo số cảnh báo/trùng lặp/dead code hiện tại, chặn tăng, hạ dần — không dọn cả repo một lần.
- **Ít công cụ, một cấu hình.** Mỗi việc một công cụ; cấu hình trong repo, không trong IDE.

## Quyết định

| Việc | JS/TS | Python | Go / Java / .NET | Ghi chú |
|---|---|---|---|---|
| Lint + format | **Biome 2.5.15** (MIT/Apache-2.0, một công cụ) **hoặc** oxlint 1.87.0 + Prettier; ESLint 10.12.0 khi cần plugin đặc thù (jsx-a11y, playwright) | **ruff 0.17.0** (MIT; lint + format) | `golangci-lint`, `gofmt`; Checkstyle/Spotless; `dotnet format` + analyzers | uv/ruff thuộc OpenAI từ 03/2026, vẫn MIT, vẫn 0.x → ghim exact |
| Kiểm kiểu | TypeScript 7.0.2 `strict` | **pyright 1.1.414** (MIT) hoặc mypy 2.4.0 `--strict` | có sẵn | Không trộn pyright và mypy trong một repo |
| Dead code/export/dep thừa | **knip 6.41.0** (ISC) | vulture 2.16 (MIT) + `ruff F401/F841` + `deptry` | `staticcheck` (U1000); IDE inspections | knip cần plugin framework (vd typegen trước) |
| Trùng lặp | **jscpd 5.4.1** (MIT; 224 định dạng, SARIF) | jscpd (hỗ trợ Python) | jscpd / PMD CPD | Trùng ngữ nghĩa (Type-4) còn thử nghiệm |
| Độ phức tạp | ESLint `complexity`/`eslint-plugin-sonarjs` `cognitive-complexity`; Biome `noExcessiveCognitiveComplexity` | ruff `C901` (mccabe), radon 6.0.1 | `gocyclo`/`gocognit`; PMD | Ngưỡng cyclomatic ≤ 10, cognitive ≤ 15 (mặc định, đổi theo repo) |
| Ranh giới kiến trúc | **dependency-cruiser 18.6.0** (MIT) | **import-linter 2.15** (BSD-2) | `go-arch-lint`/`depguard`; ArchUnit | Fitness function AST tự viết khi cần (catalog 23 §3.3) |
| Nền tảng tổng hợp (tuỳ chọn) | SonarQube Community Build (LGPL-3.0, tự host, free); các edition khác thương mại | như trái | như trái | Chỉ thêm khi đội > 1, đã có cổng cơ bản |

Mặc định cho repo mới: **Biome + TypeScript strict + knip + jscpd + dependency-cruiser** (JS/TS); **uv + ruff + pyright + import-linter + pre-commit** (Python).

## Checklist

- [ ] `QA-STATIC-001` **MUST** Lint 0 lỗi, 0 cảnh báo (hoặc baseline đã ghi) chạy ở hook và CI với cùng cấu hình. → Kiểm: `scripts/dev-task.sh lint` exit 0; job CI dùng cùng lệnh.
- [ ] `QA-STATIC-002` **MUST@L** Formatter chạy tự động (hook PostToolUse/pre-commit) và CI kiểm `--check`. → Kiểm: `biome format --write`/`ruff format` ở hook; CI `biome ci`/`ruff format --check` exit 0.
- [ ] `QA-STATIC-003` **MUST** Kiểm kiểu chế độ nghiêm: TS `strict: true` + `noUncheckedIndexedAccess`; Python pyright `strict` hoặc mypy `--strict` cho mã mới. → Kiểm: `tsconfig.json`/`pyrightconfig.json` có khoá tương ứng; `tsc --noEmit`/`pyright` exit 0.
- [ ] `QA-STATIC-004` **MUST** Không `any`/`@ts-ignore`/`# type: ignore`/`eslint-disable` không kèm lý do. → Kiểm: lint `no-explicit-any`, `ban-ts-comment` (`allow-with-description`), ruff `PGH003`; grep disable không có comment = 0.
- [ ] `QA-STATIC-005` **MUST** Không bí mật, `console.log`/`print` debug, code comment-out "để phòng" trong nhánh chính. → Kiểm: gitleaks 0 finding; lint `no-console` (trừ logger), ruff `T201`; review diff.
- [ ] `QA-STATIC-006` **MUST@L** Dead code/export/dependency không dùng = 0 (hoặc baseline ratchet không tăng). → Kiểm: `knip` / `vulture --min-confidence 80` + `deptry` exit 0 trong CI.
- [ ] `QA-STATIC-007` **MUST@L** Trùng lặp ≤ ngưỡng ghi trong repo (mặc định 3% dòng; không tăng so với baseline). → Kiểm: `jscpd --threshold 3 --reporters console,sarif` exit 0.
- [ ] `QA-STATIC-008` **MUST@L** Ranh giới kiến trúc được khai báo và kiểm máy (domain ← application ← infrastructure; UI không import DB). → Kiểm: `depcruise --validate .dependency-cruiser.cjs src` / `lint-imports` exit 0. · Nguồn: [`../05-architecture/boundaries-and-modularity.md`](../05-architecture/boundaries-and-modularity.md)
- [ ] `QA-STATIC-009` **MUST@L** Độ phức tạp hàm có ngưỡng (cyclomatic ≤ 10 hoặc cognitive ≤ 15 mặc định) và CI đỏ khi vượt với mã mới. → Kiểm: rule `complexity`/`C901`/`noExcessiveCognitiveComplexity` mức `error`.
- [ ] `QA-STATIC-010` **MUST@L** Refactor không đổi hành vi: PR `refactor:` không chứa đổi hành vi, có test bảo vệ vùng sửa, số đo trước–sau (dòng, dep, cảnh báo, bundle) trong mô tả PR. → Kiểm: template PR mục "Đo trước–sau"; CI kiểm PR `refactor:` không sửa file test kỳ vọng (chỉ thêm) và test xanh. · Nguồn: khung cũ Nhóm 2 mục 9
- [ ] `QA-STATIC-011` **MUST@L** Trước khi đóng một mảng/tính năng: chạy checklist tối ưu mã nguồn (dead code, trùng lặp, dep thừa, bundle) và ghi kết quả vào PR cuối của mảng. → Kiểm: PR có mục "Tối ưu mã nguồn" với output knip/jscpd/size.
- [ ] `QA-STATIC-012` **MUST@L** Dự án có sẵn: baseline số đo tĩnh commit vào repo (`docs/ops/static-baseline.json`), CI chặn tăng (ratchet), hạ dần theo "đụng đâu dọn đó". → Kiểm: script so output hiện tại với baseline; vượt → đỏ; baseline chỉ giảm.
- [ ] `QA-STATIC-013` **SHOULD** Hook local không phải cổng cuối: CI chạy lại toàn bộ lint/type/format vì `--no-verify` bỏ qua được. → Kiểm: job CI `quality` có 3 bước này không `continue-on-error`.
- [ ] `QA-STATIC-014` **SHOULD** Một job `quality` gom mọi cổng tĩnh làm required check chất lượng (ruleset còn `protection-guard`, `gitleaks`, `dep-audit`); thêm cổng không cần sửa ruleset. → Kiểm: ruleset yêu cầu `quality`; `quality` `needs:` các job con. · Nguồn: catalog 23 §2.5 (ADR-0003)
- [ ] `QA-STATIC-015` **SHOULD** Không gom thứ chỉ *trông* giống nhau khi DRY (quy tắc 3 lần); không gom trừu tượng sớm. → Kiểm: review; jscpd báo trùng nhưng PR giải thích nếu giữ.
- [ ] `QA-STATIC-016` **SHOULD** Hàm > 4 tham số gom thành object có kiểu; `if/else` lồng sâu → guard clause. → Kiểm: rule `max-params: 4`, ruff `PLR0913`; `max-depth`.
- [ ] `QA-STATIC-017` **SHOULD** Import lẻ và tách động cho phần nặng ít dùng; không hai thư viện cùng vai trò (2 lib ngày tháng, 2 HTTP client). → Kiểm: knip/`deptry` + script liệt kê dep theo nhóm; bundle analyzer trong PR.
- [ ] `QA-STATIC-018` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md) (`PROGRESS.md` tươi bằng máy: SHA tổ tiên HEAD); hợp đồng repo kiểm bằng `xt.py validate`.
- [ ] `QA-STATIC-019` **MAY** SonarQube Community Build tự host làm bảng tổng hợp khi đội > 1; không thay cổng CI.
- [ ] `QA-STATIC-020` **MAY** Fitness function AST tự viết cho quy tắc riêng (vd mọi route có kiểm quyền; SQL chạm PII phải nhận context) khi lint sẵn không đủ.
- [ ] `QA-STATIC-021` **SHOULD** Mỗi luật/cổng tự viết (semgrep, ESLint, script `check:*`) có fixture xấu phải fail và fixture tốt phải pass, chạy trong CI. Nâng thành **MUST@L** khi cổng nằm trong required check. → Kiểm: `semgrep --test`, ESLint `RuleTester`, script chạy trên `fixtures/bad.*` cho exit ≠ 0 và trên `fixtures/good.*` cho exit 0. · Nguồn: stored 06 §7f (self-test 205 luật), §7b (fixture "plausible-wrong")

## Bẫy thường gặp

- **Tắt rule thay vì sửa** (`eslint-disable` không lý do, `# noqa` hàng loạt). Cách tránh: QA-STATIC-004; đếm disable trong baseline.
- **Chạy lint chỉ ở IDE/hook** → `--no-verify` qua mặt. Cách tránh: QA-STATIC-013.
- **Dọn cả repo một lần** trong dự án có sẵn → PR khổng lồ, conflict, không review được. Cách tránh: baseline + ratchet (QA-STATIC-012).
- **Trộn refactor với feature** trong một PR → không lần được lỗi. Cách tránh: `refactor:` PR riêng (QA-STATIC-010).
- **Trừu tượng hoá sai** (gom 2 thứ trông giống rồi phải tách). Cách tránh: quy tắc 3 lần; đọc jscpd có suy xét.
- **knip báo sai vì thiếu plugin framework** (file sinh từ typegen). Cách tránh: cấu hình plugin, chạy codegen trước knip.
- **Hai type checker Python** (mypy + pyright) cho kết quả khác nhau. Cách tránh: chọn một, ghi ADR.
- **Coi SonarQube là cổng** rồi bỏ lint/type cục bộ. Cách tránh: SonarQube là dashboard; cổng vẫn là CI job `gate`.
- **Tối ưu non**: "tối ưu" chỗ chưa đo là điểm nghẽn. Cách tránh: đo trước ([`performance-and-load.md`](performance-and-load.md)).
- **Luật/cổng tự viết chưa từng thấy đỏ** → xanh vì luật hỏng (regex sai, glob lệch), không phải vì mã sạch. Tránh: fixture xấu + fixture tốt chạy trong CI (`QA-STATIC-021`).

## Cổng tự động

| Công cụ (xác minh 2026-10-13) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Biome 2.5.15 | `biome ci .` (lint + format check) | pre-commit (`biome check --write` file sửa) + CI | 0 error/warning |
| oxlint 1.87.0 | `oxlint --deny-warnings` | CI | 0 |
| ESLint 10.12.0 (khi cần plugin) | `eslint . --max-warnings 0` | CI | 0 |
| TypeScript 7.0.2 | `tsc --noEmit -p tsconfig.json` | CI | 0 lỗi |
| ruff 0.17.0 | `ruff check . && ruff format --check .` | pre-commit + CI | 0 |
| pyright 1.1.414 / mypy 2.4.0 | `pyright` · `mypy --strict src` | CI | 0 lỗi |
| knip 6.41.0 | `knip --reporter compact` | CI | 0 (hoặc ≤ baseline) |
| jscpd 5.4.1 | `jscpd src --threshold 3 --reporters console,sarif` | CI | ≤ 3% |
| dependency-cruiser 18.6.0 / import-linter 2.15 | `depcruise --validate .dependency-cruiser.cjs src` · `lint-imports` | CI | 0 vi phạm |
| vulture 2.16 / radon 6.0.1 | `vulture src --min-confidence 80` · `radon cc src -n C` | CI | 0 / không hàm mức C+ mới |
| pre-commit 4.7.0 (MIT; xác minh PyPI 2026-10-12) | `pre-commit run --all-files` | hook + CI | 0 |
| Baseline ratchet (tự viết) | `python3 scripts/static-ratchet.py --baseline docs/ops/static-baseline.json` | CI | không tăng |
| Self-test luật tự viết | `semgrep --test` · ESLint `RuleTester` · script `check:*` chạy trên `fixtures/bad.*`/`good.*` | CI | bad → exit ≠ 0, good → exit 0 |

## Nguồn

- Phiên bản (registry, xác minh 2026-10-13): npm `@biomejs/biome` 2.5.15, `oxlint` 1.87.0, `eslint` 10.12.0, `typescript` 7.0.2, `knip` 6.41.0, `jscpd` 5.4.1, `dependency-cruiser` 18.6.0; PyPI `ruff` 0.17.0, `pyright` 1.1.414, `mypy` 2.4.0, `import-linter` 2.15, `vulture` 2.16, `radon` 6.0.1 (2023 — bảo trì chậm), `uv` 0.13.0.
- SonarQube Community Build LGPL-3.0: <https://github.com/SonarSource/sonarqube> · <https://www.sonarsource.com/open-source-editions/> — xác minh 2026-10-13
- import-linter: <https://import-linter.readthedocs.io/> (trang contract types trả 404 ngày 2026-10-13 — kiểm tài liệu phiên bản hiện hành)
- Catalog `seeker19110/stored` 13 §4b–4c (stack quality gate, pre-commit (bản 4.7.0 xác minh PyPI 2026-10-12), hook `--no-verify`, uv/ruff thuộc OpenAI), 23 §2.5 (gate aggregator), 23 §3.3 (fitness function AST, coverage ratchet), 23 §4.5 (`validate_repo.py`) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 9 "Tối ưu mã nguồn" (nguyên tắc vàng, checklist dead code/trùng lặp/dep/bundle, khi nào không refactor), commit `1b80fe4` — đọc 2026-10-13.
- Catalog `seeker19110/stored` mục 06 §7f (`usage:selftest`: 205 luật, mỗi luật bắt được lỗi trong fixture xấu, fixture tốt sạch), §7b (diagram-design: fixture "plausible-wrong" cho cổng kiểm) — đọc 2026-10-16.
