---
title: Cổng chất lượng tối thiểu (lint · format · type · test · CI)
kind: baseline
prefix: BASE-GATE
applies_to: [all]
updated: 2026-10-14
---

# Cổng chất lượng tối thiểu (lint · format · type · test · CI)

> Sàn cho mọi phần mềm: **năm cổng máy** (format, lint, type, test, build) chạy được bằng một lệnh mỗi cổng, chạy ở máy
> dev **và** lặp lại trong CI, và CI là *required check* trước khi vào nhánh mặc định. Pipeline chi tiết là nhà của
> [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md); công cụ phân tích tĩnh sâu ở
> [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md);
> chiến lược test ở [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md).

## Nguyên tắc

- **Cổng máy trước, người sau** (P9): thứ gì máy kiểm được thì không giao cho review.
- **Ba tầng độc lập**: (1) kỷ luật người/AI, (2) hook cục bộ chặn sớm, (3) CI + bảo vệ nhánh chặn cuối. Hook cục bộ **bỏ
  qua được** bằng `--no-verify`, nên CI luôn chạy lại cùng cổng.
- **Cổng chỉ có đạt/không đạt.** Không có "cảnh báo tạm bỏ qua"; cảnh báo lint = đỏ.
- **Một hợp đồng lệnh**: mỗi cổng là một lệnh có tên chuẩn (`format`, `lint`, `typecheck`, `test`, `build`) để người,
  hook, CI và agent gọi **cùng một thứ**.
- **Nới cấu hình để xanh là gian lận**: sửa lint/tsconfig/coverage/workflow phải đi PR riêng, có lý do.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Hook cục bộ bằng gì? | **pre-commit 4.7.0** (đa ngôn ngữ, `rev` ghim tag/SHA) cho Python/mixed; **lefthook 2.2.1** hoặc husky 9.1.7 + lint-staged cho JS/TS. | Repo thuần một ngôn ngữ đã có công cụ hook bản địa (Cargo `cargo-husky`, Go `pre-commit` vẫn ổn). Không dùng hook viết tay trong `.git/hooks` (không đi theo clone). |
| Formatter + linter | JS/TS: **Biome 2.5.x** (một công cụ) hoặc oxlint + Prettier · Python: **ruff** (format + lint) + **pyright** · Go: `gofmt`/`go vet` + `golangci-lint` · Rust: `rustfmt` + `clippy -D warnings` · .NET: `dotnet format` + analyzers `TreatWarningsAsErrors`. | Dự án có sẵn: giữ công cụ hiện có, chỉ thêm cổng; đổi công cụ là PR riêng (brownfield). |
| Kiểm kiểu | Ngôn ngữ có kiểu: bật chế độ nghiêm (`strict`, `noUncheckedIndexedAccess`; pyright `strict`; `-Wall -Werror`). | Ngôn ngữ động không có type-checker → thay bằng validate dữ liệu ở biên + test. |
| Test chạy ở cổng commit? | Hook commit chạy **test nhanh liên quan** (lint-staged/`--changed`); **toàn bộ** test ở CI. | Suite < 30 s thì chạy hết cả ở hook. |
| Một job hay nhiều job required? | **Một job gom** (`quality`) chạy các cổng chất lượng (tuần tự/song song bên trong). Ruleset của khung đòi **4 required check**: `quality`, `protection-guard` (đối chiếu ruleset ↔ job thật), `gitleaks` (quét bí mật) và `dep-audit` (lỗ hổng phụ thuộc); mỗi check phải là job có thật. | Monorepo lớn: job theo package nhưng vẫn một job tổng hợp luôn chạy (`quality`) làm required. |
| Coverage có là cổng không? | **Ratchet**: không được giảm so với nhánh mặc định; ngưỡng tuyệt đối do [`../14-testing-quality/coverage-and-mutation.md`](../14-testing-quality/coverage-and-mutation.md) quyết. | Repo mới chưa có baseline: đặt ratchet từ 0, không đặt 80% giả. |

## Checklist

- [ ] `BASE-GATE-001` **MUST** Có đúng năm lệnh chuẩn `format` · `lint` · `typecheck` · `test` · `build` (hoặc tương đương của ngôn ngữ) được khai báo ở **một** nơi máy đọc được (`package.json#scripts`, `Makefile`, `justfile`, `noxfile`, `runtime.yaml`); mỗi lệnh có trong `xt.yaml`, lệnh không áp dụng ghi `""` kèm chú thích lý do. Nhà của bộ khoá `xt.yaml`: [`LOOP-HARNESS-008`](../11-autonomous-loop/harness-files.md) — `scripts/dev-task.sh` chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build → typecheck → lint → test; `lint` nên gồm kiểm format); khoá khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`…) agent đọc và chạy trực tiếp. → Kiểm: `xt.yaml` có đủ năm khoá, khoá `""` có chú thích lý do; chạy từng lệnh không rỗng từ clone sạch, exit 0; tên lệnh được CI và hook gọi nguyên văn (grep workflow). · Nguồn: 12-factor II; catalog 23 §3.3 (`runtime.yaml`)
- [ ] `BASE-GATE-002` **MUST** Formatter chạy ở chế độ kiểm (`--check`) trong CI và chế độ sửa ở hook; định dạng là **tất định** (cùng input → cùng output). → Kiểm: CI `format --check` exit 0; chạy `format` hai lần không tạo diff. · Nguồn: OpenSSF Badge `warnings`
- [ ] `BASE-GATE-003` **MUST** Linter chạy với **0 cảnh báo** (cảnh báo = lỗi) trên toàn repo; rule tắt phải có comment lý do tại chỗ hoặc trong config. → Kiểm: `lint` exit 0 với `--max-warnings 0` / `-D warnings` / `TreatWarningsAsErrors`; grep `eslint-disable|noqa|#nosec|allow(` không có dòng thiếu lý do. · Nguồn: OpenSSF Badge `warnings_fixed`, `warnings_strict`
- [ ] `BASE-GATE-004` **MUST** Type-checker ở chế độ nghiêm (nếu ngôn ngữ có): TypeScript `strict: true`, không `any` ngầm; pyright/mypy `strict`; Rust `clippy -D warnings`; Go `go vet`. → Kiểm: file config có cờ nghiêm; `typecheck` exit 0 trong CI. · Nguồn: khung cũ `01-process-and-standards.md` nguyên tắc 2
- [ ] `BASE-GATE-005` **MUST** Có bộ test tự động chạy bằng một lệnh, **tất định** (không phụ thuộc giờ máy, mạng, thứ tự) và CI chạy **toàn bộ** trên mỗi PR. → Kiểm: `test` exit 0; chạy 3 lần liên tiếp cùng commit cho cùng kết quả; CI không có `continue-on-error` ở bước test. · Nguồn: OpenSSF Badge `test`, `test_continuous_integration`
- [ ] `BASE-GATE-006` **MUST** CI chạy lại **mọi** cổng của hook cục bộ (hook có thể bị `--no-verify`); không có cổng nào chỉ tồn tại ở máy dev. → Kiểm: đối chiếu danh sách hook trong `.pre-commit-config.yaml`/`lefthook.yml` với bước trong workflow CI — mỗi hook có bước CI tương ứng. · Nguồn: pre-commit docs (CI); catalog 13 §4c
- [ ] `BASE-GATE-007` **MUST** Nhánh mặc định yêu cầu CI xanh (required status check) và "up to date" với nhánh đích trước khi merge. → Kiểm: ruleset JSON có `required_status_checks` với `strict_required_status_checks_policy: true`. · Nguồn: GitHub rulesets; Scorecard Branch-Protection, CI-Tests
- [ ] `BASE-GATE-008` **MUST** Build từ clone sạch (`git clone` → cài phụ thuộc đóng băng → `build`) thành công trong CI; không phụ thuộc file cục bộ hay cache có sẵn để xanh. → Kiểm: job CI dùng runner mới, không `continue-on-error`; `build` exit 0. · Nguồn: 12-factor II, V
- [ ] `BASE-GATE-009` **MUST** Thay đổi **cấu hình cổng** (lint/type/coverage/CI/hook/ruleset) đi PR riêng, có lý do trong mô tả; agent tự động không được tự nới. → Kiểm: hook PreToolUse/CODEOWNERS yêu cầu review người cho đường dẫn `eslint.config.*`, `tsconfig*.json`, `pyproject.toml[tool.*]`, `.github/workflows/**`, `.pre-commit-config.yaml`. · Nguồn: catalog 12 §3, 23 §4.3 ("làm cổng xanh bằng nới cấu hình")
- [ ] `BASE-GATE-010` **MUST@M** CI chạy trên runner có `permissions:` tối thiểu (`contents: read` mặc định) và action bên thứ ba ghim theo SHA đầy đủ. → Kiểm: `actionlint` + `pinact run --check` exit 0; mọi workflow có khối `permissions:` cấp đầu. · Nguồn: GitHub Actions security hardening; chi tiết ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `BASE-GATE-011` **SHOULD** Thời gian từ push đến kết quả cổng CI < 10 phút cho PR thông thường; cache phụ thuộc theo hash lockfile; job nặng (E2E, load) tách job riêng không chặn vòng lặp nhanh. → Kiểm: thời lượng job `quality` trung bình 30 ngày (`gh run list --json durationMs`) < 600 s. · Nguồn: DORA (lead time for changes)
- [ ] `BASE-GATE-012` **SHOULD** Test flaky được phát hiện (chạy lại tự động chỉ với test gắn nhãn flaky), cách ly khỏi cổng và có issue theo dõi; không dùng `retries` toàn cục để che. → Kiểm: cấu hình test runner chỉ retry theo nhãn; danh sách flaky trong repo có ngày và owner. · Nguồn: Google Testing Blog, "Flaky Tests at Google" (2016-05-27)
- [ ] `BASE-GATE-013` **SHOULD** Coverage dùng **ratchet**: không thấp hơn nhánh mặc định; file loại trừ phải ghi lý do. → Kiểm: CI so sánh `coverage.json` với baseline lưu trong repo/artefact; giảm = đỏ. · Nguồn: catalog 23 §2.5 (coverage ratchet)
- [ ] `BASE-GATE-014` **SHOULD** Kết quả cổng xuất ở định dạng máy đọc (JUnit XML, SARIF, JSON) và lưu làm artefact ≥ 30 ngày để làm bằng chứng (P1). → Kiểm: workflow có `upload-artifact` cho báo cáo test/lint; blueprint tick trỏ tới run id. · Nguồn: P1 (principles.md); evidence-and-sources.md §2
- [ ] `BASE-GATE-015` **SHOULD** Hook cục bộ tự cài sau khi clone (`prepare` script, `lefthook install` trong postinstall, hoặc hướng dẫn một dòng trong README) để cổng tầng 2 không phụ thuộc trí nhớ. → Kiểm: clone mới + cài phụ thuộc → `.git/hooks/pre-commit` tồn tại. · Nguồn: khung cũ "ba tầng phòng thủ"
- [ ] `BASE-GATE-016` **SHOULD** Cổng có **ngân sách**: lint/format/typecheck tổng < 60 s trên máy dev cho thay đổi thường (dùng cache, chỉ chạy file thay đổi ở hook). → Kiểm: đo `time` chạy hook trên commit mẫu; ghi vào README DX. · Nguồn: [`../18-cross-cutting/developer-experience.md`](../18-cross-cutting/developer-experience.md)
- [ ] `BASE-GATE-017` **MAY** Thêm cổng "dead code/trùng lặp" (knip, jscpd, vulture, `deadcode`) ở chế độ báo cáo trước, nâng thành chặn khi baseline sạch. → Kiểm: job CI xuất báo cáo; ngưỡng ghi trong config. · Nguồn: [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md)
- [ ] `BASE-GATE-018` **MAY** Fitness function cho **chính CI** (AST/script): job `quality` không được `continue-on-error`, không `if: false`, không `|| true` ở bước cổng. → Kiểm: `xt.py ci-check` exit 0 trong CI (bắt `continue-on-error`, thiếu `permissions`/`timeout-minutes`, action chưa ghim SHA) và job `protection-guard` đối chiếu required check ↔ job thật; `if: false`/`|| true` chưa có máy kiểm, tự rà. · Nguồn: catalog 23 §3.3 (`ci_guard`, bản gốc của ý này)
- [ ] `BASE-GATE-019` **MUST@M** Ruleset nhánh mặc định không có ai (kể cả admin/bot) trong bypass list; review bắt buộc trước merge theo [`WF-GIT-011`](../10-workflow/git-and-branching.md). → Kiểm: ruleset JSON có `bypass_actors: []` (ruleset dạng code theo `WF-GIT-002`). · Nguồn: GitHub rulesets; Scorecard Branch-Protection

## Bẫy thường gặp

- **"CI xanh" vì job bị skip.** Điều kiện `if:` hoặc `paths:` làm job không chạy → GitHub coi required check "chưa báo cáo" hoặc xanh rỗng. Dùng job tổng hợp luôn chạy (`quality`); bên trong tự quyết việc gì bỏ qua và **ghi rõ**.
- **Hook cục bộ là cổng duy nhất.** `git commit --no-verify` hoặc agent chạy `--bare` bỏ qua tất cả. CI phải lặp lại.
- **Nới `tsconfig`/`eslint` để hết đỏ.** Lịch sử catalog: agent tự sửa coverage/eslint để qua cổng. Khoá bằng CODEOWNERS + hook `ask`/`deny` cho file cấu hình cổng.
- **`retries: 3` toàn cục.** Che flaky và race thật. Retry chỉ cho test gắn nhãn, có issue.
- **Test phụ thuộc giờ thật/mạng thật.** Đỏ ngẫu nhiên vào nửa đêm UTC hay khi API bên ngoài chậm. Fake clock, fixture, record/replay.
- **Format bằng hai công cụ** (Prettier + ESLint formatting rules, hoặc Black + ruff format) tranh nhau → diff lắc. Một formatter, tắt rule format của linter.
- **Lệnh cổng chỉ nằm trong văn xuôi README.** Agent suy diễn sai lệnh (catalog 23: 11 lần `unverified`). Khai báo ở nơi máy đọc.
- **Job required đặt tên khác tên trong ruleset** sau khi đổi tên workflow → merge bị kẹt hoặc cổng mất hiệu lực âm thầm. CI đối chiếu ruleset với tên job thật.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Hook đa ngôn ngữ | pre-commit 4.7.0 (MIT) | `pre-commit run --all-files` | local + CI | 0 lỗi |
| Hook JS/TS | lefthook 2.2.1 (MIT) hoặc husky 9.1.7 + lint-staged 17.6.0 (MIT) | `lefthook run pre-commit` | local; CI lặp lại từng lệnh | 0 lỗi |
| Format + lint JS/TS | Biome 2.5.x (MIT/Apache-2.0) | `biome ci .` | CI; `biome check --write` ở hook | 0 cảnh báo |
| Format + lint Python | ruff 0.17.0 (MIT) | `ruff format --check . && ruff check .` | hook + CI | 0 |
| Type Python / TS | pyright 1.1.414 (MIT) · TypeScript 7.0.2 (Apache-2.0) | `pyright` · `tsc --noEmit -p tsconfig.json` | CI | 0 lỗi |
| Lint workflow CI | actionlint v1.7.12 (MIT) · pinact v5.0.0 (MIT) | `actionlint` · `pinact run --check` | CI | 0 |
| Shell script | ShellCheck v0.11.0 (GPL-3.0) | `shellcheck -S warning scripts/*.sh` | hook + CI | 0 |
| Bảo vệ nhánh khớp job thật | job `protection-guard` (trong `ci.yml`) | đọc `.github/rulesets/main.json`, so `required_status_checks` với tên job trong `.github/workflows/*.yml` | CI | lệch = đỏ; ruleset chưa hiệu lực trên nhánh mặc định = cảnh báo (đổi `::warning` thành `exit 1` để ép) |
| Fitness function workflow | `xt.py ci-check` | `xt.py ci-check` | CI (trong `lint`) | 0 lỗi |
| Bằng chứng | upload-artifact (JUnit/SARIF/JSON) | `--reporter junit` / `--format sarif` | CI | lưu ≥ 30 ngày |

Cảnh báo license/telemetry: Renovate là AGPL-3.0 (dùng dạng dịch vụ thì không ảnh hưởng mã của bạn); Biome/oxlint/ruff/pyright/pre-commit/actionlint/pinact đều MIT/Apache; ShellCheck GPL-3.0 (chạy như công cụ, không link vào sản phẩm).

## Nguồn

- pre-commit (cấu hình, `rev` ghim, chạy trong CI): <https://pre-commit.com/> — xác minh 2026-10-13
- GitHub rulesets — required status checks, bypass list: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets> — xác minh 2026-10-13
- GitHub Actions security hardening (ghim SHA, `permissions`): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13
- OpenSSF Best Practices Badge (`test`, `test_continuous_integration`, `warnings`, `static_analysis`): <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13
- OpenSSF Scorecard checks (CI-Tests, Branch-Protection, Token-Permissions): <https://github.com/ossf/scorecard> — xác minh 2026-10-13
- DORA four keys (lead time, change fail rate…): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13
- Google Testing Blog, "Flaky Tests at Google and How We Mitigate Them" (2016-05-27): <https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html> — chỉ đọc được tiêu đề/ngày ngày 2026-10-13; số liệu trong bài **(chưa xác minh)**
- The Twelve-Factor App II, V: <https://12factor.net/> — xác minh 2026-10-13
- Phiên bản công cụ (xác minh 2026-10-13 qua registry/release page): pre-commit 4.7.0 (xác minh PyPI 2026-10-12, kiểm lại 2026-10-14), ruff 0.17.0, pyright 1.1.414, lefthook 2.2.1, husky 9.1.7, lint-staged 17.6.0, typescript 7.0.2, actionlint v1.7.12, pinact v5.0.0, ShellCheck v0.11.0; Biome 2.5.15 theo [`../../research/2026-10-13-stored-catalog-extraction.md`](../../research/2026-10-13-stored-catalog-extraction.md) (catalog 13 §4c).
- Khung cũ X-stored `01-process-and-standards.md` ("ba tầng phòng thủ", 7 nguyên tắc), commit `1b80fe4`; catalog `seeker19110/stored` 13 §4b–4c, 23 §2.5/§3.3/§4.3, đọc 2026-10-13.
