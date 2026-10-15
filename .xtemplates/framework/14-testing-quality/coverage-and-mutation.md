---
title: Coverage ratchet, mutation test, chất lượng test
kind: module
prefix: QA-COV
applies_to: [all]
updated: 2026-10-14
---

# Coverage ratchet, mutation test, chất lượng test

> Coverage là **sàn chống quên viết test**, không phải mục tiêu; mutation test mới đo test có **bắt được lỗi** không.
> Module này đặt ratchet (chỉ tăng, không giảm), mutation score cho vùng logic, và các cổng chất lượng của chính bộ test.

## Nguyên tắc

- **Ratchet, không mốc cố định.** Baseline = coverage hiện tại; CI đỏ khi giảm; tăng thì nâng baseline (tự động hoặc PR). Dự án mới có thể đặt `100` cho vùng logic với loại trừ ghi lý do (qlkh: `fail_under=100` + loại trừ có lý do).
- **Đo nhánh, không chỉ dòng.** Dòng 100% nhưng nhánh 60% là tự lừa.
- **Mutation score cho vùng quan trọng, không toàn repo.** Logic nghiệp vụ, tính tiền, phân quyền, parser: ≥ 70% (ngưỡng mutmut của qlkh); UI glue, cấu hình: không cần.
- **Test không assert là nợ.** Mỗi test có ít nhất một kỳ vọng thật; snapshot không thay assert nghiệp vụ.
- **Coverage của E2E không gộp vào unit** để không che hố ở tầng thấp.

## Quyết định

| Stack | Coverage (xác minh 2026-10-13) | Ratchet | Mutation |
|---|---|---|---|
| JS/TS | Vitest 5.0.4 `coverage` (`@vitest/coverage-v8` 5.0.4) hoặc Jest 30.5.2 `coverageThreshold`; `c8` 12.0.0 cho Node thuần | Vitest `coverage.thresholds.autoUpdate: true` (tự nâng khi vượt) hoặc script so baseline | StrykerJS `@stryker-mutator/core` 10.0.0 (Apache-2.0), `thresholds.break`, `incremental: true` |
| Python | `coverage` 7.16.2 + `pytest-cov` 7.1.0 `--cov-branch --cov-fail-under` | script nâng `fail_under` theo kết quả (coverage ratchet, xboss/qlkh) | mutmut 3.8.0 (phiên bản 3 **không có** cờ ngưỡng — đọc `mutmut export-cicd-stats`/`badge` rồi tự so) |
| Go | `go test -coverprofile -covermode=atomic` + `go tool cover -func` | script so tổng % với baseline | `go-mutesting`/`gremlins` (phiên bản **chưa xác minh**) |
| Java/Kotlin | JaCoCo `rules` (BRANCH `minimum`) | nâng `minimum` theo kết quả | PIT 1.30.0 (`mutationThreshold`, `coverageThreshold`) |
| .NET | coverlet `/p:Threshold` `/p:ThresholdType=branch` | script | Stryker.NET |
| Rust | `cargo-llvm-cov --fail-under-lines` | script | `cargo-mutants` |

Mặc định: **branch coverage ratchet toàn repo + mutation ≥ 70% cho thư mục logic nghiệp vụ** (danh sách thư mục ghi trong `PROJECT.md`). Mutation chạy incremental ở PR cho file đổi, đầy đủ nightly.

## Checklist

- [ ] `QA-COV-001` **MUST** Đo coverage **nhánh** (branch) cho unit + integration, báo cáo lưu artifact CI. → Kiểm: cấu hình `--cov-branch`/`coverage.reporter` có `branches`; artifact `coverage/` tồn tại.
- [ ] `QA-COV-002` **MUST** Ratchet: CI đỏ khi coverage (lines và branches) thấp hơn baseline đã commit; baseline chỉ tăng. → Kiểm: Vitest `coverage.thresholds` (`lines`, `branches`) có giá trị số trong repo; hoặc `--cov-fail-under=<baseline>`; PR hạ baseline bị hook hỏi lý do. · Nguồn: catalog 23 §3.3 (coverage ratchet), Vitest docs `coverage.thresholds`
- [ ] `QA-COV-003` **MUST@L** Loại trừ coverage (`/* istanbul ignore */`, `# pragma: no cover`, `exclude`) phải kèm lý do; CI đếm số loại trừ và chặn tăng. → Kiểm: grep loại trừ không có comment lý do = 0; số lượng ≤ baseline.
- [ ] `QA-COV-004` **MUST** Không test nào không có assertion; snapshot không là assertion duy nhất cho logic nghiệp vụ. → Kiểm: lint `expect-expect` (eslint-plugin-vitest/jest), `pytest` plugin/grep `assert` mỗi test; review.
- [ ] `QA-COV-005` **MUST@L** Mutation test cho thư mục logic nghiệp vụ (danh sách trong `PROJECT.md`) với score ≥ 70%, chạy incremental ở PR cho file đổi và đầy đủ nightly. → Kiểm: StrykerJS `thresholds.break: 70` + `incremental`; mutmut: script đọc `export-cicd-stats` và exit ≠ 0 khi < 70; PIT `mutationThreshold=70`. · Nguồn: catalog 23 §3.3 (mutmut ≥ 70%)
- [ ] `QA-COV-006` **MUST@L** Mutant sống sót ở vùng tiền/phân quyền/parser được xử lý (thêm test hoặc ghi lý do "equivalent mutant") trước khi merge PR chạm vùng đó. → Kiểm: báo cáo mutation của PR không có mutant `Survived` chưa ghi chú trong các thư mục đánh dấu `critical`.
- [ ] `QA-COV-007` **MUST@L** Coverage unit/integration và E2E báo cáo tách riêng; E2E không được gộp để đạt ngưỡng unit. → Kiểm: hai artifact/báo cáo riêng; threshold áp cho báo cáo unit+integration.
- [ ] `QA-COV-008` **MUST** Không sửa cấu hình coverage/mutation để "cho xanh" (hạ ngưỡng, thêm exclude, tắt break) mà không có lý do và duyệt. → Kiểm: hook PreToolUse hỏi khi sửa `vitest.config`/`.coveragerc`/`stryker.config`/`pyproject [tool.coverage]`; PR diff cấu hình cổng cần reviewer.
- [ ] `QA-COV-009` **SHOULD** Per-file threshold cho vùng critical (vd `perFile` hoặc glob `src/domain/**: 100`) thay vì chỉ tổng. → Kiểm: cấu hình glob thresholds trong Vitest hoặc `[tool.coverage.report] fail_under` theo gói.
- [ ] `QA-COV-010` **SHOULD** Thời gian mutation ở PR ≤ 10 phút nhờ incremental + chỉ file đổi; nightly đầy đủ. → Kiểm: log thời gian; cấu hình `--incremental`/`mutate` theo `git diff`.
- [ ] `QA-COV-011` **SHOULD** Báo cáo mutation/coverage dạng SARIF/HTML upload artifact; xu hướng theo thời gian ghi `docs/ops/quality-trend.csv`. → Kiểm: artifact + file CSV cập nhật mỗi tuần.
- [ ] `QA-COV-012` **SHOULD** Test chậm (> 1 s unit) được liệt kê và tối ưu hoặc chuyển tầng. → Kiểm: `pytest --durations=10`/Vitest `--reporter=verbose` + ngưỡng cảnh báo.
- [ ] `QA-COV-013` **SHOULD** Tỷ lệ test/logic được theo dõi khi dùng agent viết code: agent không được xoá/skip test để qua cổng; feature list chỉ đổi pass/fail. → Kiểm: CI đỏ khi PR xoá file test mà không có nhãn `test-removal` + lý do. · Nguồn: research AI agent §3 (harness: agent không xoá test)
- [ ] `QA-COV-014` **MAY** Mutation cho toàn repo ở nightly với ngưỡng thấp hơn (50%) để phát hiện vùng test yếu.
- [ ] `QA-COV-015` **MAY** Theo dõi assertion density (assert/test) và flakiness rate như chỉ số chất lượng test.

## Bẫy thường gặp

- **Mục tiêu "100% coverage" toàn repo** → test vô nghĩa gọi hàm không assert. Cách tránh: ratchet + mutation ở vùng quan trọng; `expect-expect`.
- **Hạ ngưỡng khi đỏ** ("tạm thời"). Cách tránh: QA-COV-008 hook + review; baseline chỉ tăng.
- **Loại trừ tràn lan** (`no cover` cho mọi nhánh lỗi). Cách tránh: QA-COV-003 đếm loại trừ.
- **Mutation toàn repo mỗi PR** → 2 giờ, mọi người tắt. Cách tránh: incremental + scope thư mục (QA-COV-005/010).
- **Equivalent mutant bị coi là test yếu** → thêm test vô nghĩa. Cách tránh: ghi chú equivalent, loại khỏi điểm.
- **mutmut 3 không có cờ ngưỡng** — agent "bịa" `--fail-under`. Cách tránh: script đọc `export-cicd-stats` (đã kiểm docs 2026-10-13); ghi lệnh thật vào `xt.yaml`.
- **Gộp coverage E2E** che hố unit. Cách tránh: QA-COV-007.
- **Agent xoá test để xanh.** Cách tránh: QA-COV-013; harness feature list chỉ đổi pass/fail.

## Cổng tự động

| Công cụ (xác minh 2026-10-13) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Vitest 5.0.4 + `@vitest/coverage-v8` 5.0.4 | `vitest run --coverage` với `coverage.thresholds: { lines, branches, functions, statements, autoUpdate: true }` | CI | ≥ baseline; `autoUpdate` commit baseline mới qua PR |
| Jest 30.5.2 | `jest --ci --coverage` + `coverageThreshold.global.branches` | CI | ≥ baseline |
| pytest-cov 7.1.0 / coverage 7.16.2 | `pytest --cov=src --cov-branch --cov-report=xml --cov-fail-under=$(cat .coverage-baseline)` | CI | ≥ baseline |
| `go test` | `go test ./... -covermode=atomic -coverprofile=cover.out && python3 scripts/cov-ratchet.py cover.out` | CI | ≥ baseline |
| JaCoCo | `jacoco:check` rule BRANCH `COVEREDRATIO` ≥ baseline | CI | ≥ baseline |
| StrykerJS 10.0.0 | `npx stryker run --incremental` (`thresholds: {high: 80, low: 60, break: 70}`) | CI PR (file đổi) + nightly | ≥ 70% vùng critical |
| mutmut 3.8.0 | `mutmut run && mutmut export-cicd-stats > stats.json && python3 scripts/mutation-gate.py stats.json --min 70` (dự án tự viết) | CI nightly + PR scope | ≥ 70% |
| PIT 1.30.0 | `mvn org.pitest:pitest-maven:mutationCoverage -DmutationThreshold=70` | CI | ≥ 70% |
| Lint test | `eslint-plugin-vitest`/`jest` `expect-expect`, `no-standalone-expect` | CI | 0 |

## Nguồn

- Vitest `coverage.thresholds` (`lines/functions/branches/statements`, `autoUpdate`, `perFile`, `100`): <https://vitest.dev/config/coverage> — xác minh 2026-10-13
- StrykerJS configuration (`thresholds` mặc định `{high: 80, low: 60, break: null}`, `incremental`): <https://stryker-mutator.io/docs/stryker-js/configuration/> — xác minh 2026-10-13; v10.0.0 (14/08/2026) catalog 13 §4c
- mutmut 3 (cấu hình `[tool.mutmut]`, `export-cicd-stats`, `badge`; không có cờ ngưỡng): <https://mutmut.readthedocs.io/en/latest/> — xác minh 2026-10-13
- Phiên bản (registry, xác minh 2026-10-13): npm `@stryker-mutator/core` 10.0.0, `@vitest/coverage-v8` 5.0.4, `c8` 12.0.0; PyPI `mutmut` 3.8.0 (2026-09-12), `coverage` 7.16.2, `pytest-cov` 7.1.0; PIT 1.30.0 (<https://github.com/hcoles/pitest/releases>, 27/08, năm không hiện).
- Catalog `seeker19110/stored` 23 §3.3 (qlkh: mutmut ≥ 70%, `fail_under=100` với loại trừ có lý do; xboss: coverage ratchet), 07 (mutation: cố ý phá bất biến, đòi test đỏ) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 4 "coverage là sàn, không phải mục tiêu", commit `1b80fe4`.
