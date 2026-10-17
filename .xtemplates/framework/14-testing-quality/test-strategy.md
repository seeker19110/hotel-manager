---
title: Chiến lược kiểm thử: tháp, mức bao phủ, cổng, trách nhiệm
kind: module
prefix: QA-STRAT
applies_to: [all]
updated: 2026-10-17
---

# Chiến lược kiểm thử: tháp, mức bao phủ, cổng, trách nhiệm

> Quyết định **kiểm gì ở tầng nào, ai chịu trách nhiệm, cổng nào chặn**, cho mọi loại phần mềm. Các module khác trong
> mảng này đi sâu từng tầng; file này là bản đồ và các luật chung (tất định, cách ly, flaky, bằng chứng).

## Nguyên tắc

- **Test là cổng, không phải tài liệu.** Một lệnh chạy được toàn bộ (`scripts/dev-task.sh test` đọc `xt.yaml`), CI chạy nó trên mọi PR, đỏ thì không merge (P9).
- **Tầng thấp nhất có thể bắt được lỗi.** Lỗi logic → unit; lỗi ghép nối (DB, API) → integration/contract; lỗi luồng người dùng → E2E. Không đẩy lên E2E thứ unit bắt được.
- **Tất định hay không có.** Thời gian, ngẫu nhiên, mạng, thứ tự phải được kiểm soát; test flaky bị cách ly và có hạn sửa, không retry vô hạn.
- **Bug sửa phải có test tái hiện đỏ trước, xanh sau** (P12, bằng chứng "đã sửa").
- **Bằng chứng gắn nhãn thật.** Mỗi claim trong báo cáo ghi `real-path` (chạy thật), `faithful-fixture` (fixture trung thực) hay `asserted-not-measured` (chưa đo) — không trộn (catalog 07, 23 §3.1).

## Quyết định

| Hồ sơ | Tầng nặng nhất | Tầng bắt buộc khác | Tầng tùy chọn | Cổng chặn merge |
|---|---|---|---|---|
| `web-app` | Unit + component | E2E luồng chính (desktop + mobile) + axe; integration API | Visual regression | unit + E2E smoke + a11y |
| `api-service` | Integration với DB thật (testcontainers) | Unit logic; contract (OpenAPI/Pact) | Load (k6) nightly | unit + integration + contract |
| `library-sdk` | Unit + property-based | API surface snapshot (breaking change) | Benchmark | unit + api-diff |
| `cli-tool` | Golden/snapshot output + exit code | Unit | E2E trên 3 OS | unit + golden |
| `mobile-app` | Unit (logic tách khỏi UI) | UI test luồng chính trên emulator; a11y nền tảng | Device farm | unit + UI smoke |
| `data-ml` | Data tests (schema, null, drift) + eval record/replay | Unit cho transform | Eval online | data tests + eval offline |
| `ai-agent` / `agentic-system` | Eval (pass^k) record/replay + unit tool | Integration MCP/A2A snapshot | Red-team định kỳ | eval + unit + snapshot |
| `desktop-app` | Unit | E2E bằng driver nền tảng (Playwright Electron/WinAppDriver) | — | unit + E2E smoke |
| `game` | Unit cho rule/economy | Playtest script tự động (headless) | Perf frame budget | unit + headless smoke |
| `blockchain` | Unit contract (Foundry/Hardhat) + fuzz/invariant | Fork test mainnet | Formal verification | unit + invariant |
| `embedded-iot` | Unit host (mock HAL) | HIL smoke trên board thật | — | unit + HIL nightly |
| `static-site` | Build + link check + a11y | Lighthouse | — | build + a11y |

Mặc định: **tháp** (nhiều unit, vừa integration, ít E2E) cho backend/thư viện; **cúp (trophy)** nghiêng integration cho app CRUD mỏng logic. Chọn và ghi vào `PROJECT.md` mục chất lượng.

### Phân loại test đỏ: bốn nguyên nhân, bốn hành động

Mỗi test đỏ phải trỏ về **đúng một** nguyên nhân thật trước khi ai đó sửa gì. Thứ tự hỏi: code sản phẩm có sai so với SPEC không?

| Nguyên nhân | Dấu hiệu | Hành động được phép | Bằng chứng bắt buộc | Cấm |
|---|---|---|---|---|
| **Bug thật** | Kỳ vọng khớp SPEC, code trả khác | Sửa code; **giữ nguyên test** | Nhánh code + input cụ thể → kết quả sai (đường tái hiện); trích điều khoản SPEC | Sửa assertion cho khớp output sai |
| **Kỳ vọng sai** | Test hiểu sai SPEC, code đúng | Sửa assertion | Trích SPEC cho thấy kỳ vọng cũ sai; nêu trong commit | Sửa vì "cho xanh" khi chưa đọc SPEC |
| **Bó vào cài đặt** | Refactor giữ nguyên hành vi mà test vẫn đỏ (assert hàm private, thứ tự gọi, cấu trúc state nội bộ) | Viết lại test theo hành vi quan sát được | Chứng minh hành vi công khai không đổi (test cũ ở tầng cao hơn vẫn xanh) | Xoá test; mock thêm để khớp |
| **Flaky / môi trường** | Đỏ-xanh ngẫu nhiên trên cùng commit; hoặc đỏ vì hạ tầng | Theo [`QA-STRAT-009`](#checklist) và [`self-healing-ci.md`](../11-autonomous-loop/self-healing-ci.md): hai run cùng SHA, issue, người duyệt khi cách ly | Run đỏ và run xanh cùng SHA | Tự gắn `@flaky` cho test đỏ thật; retry đến khi xanh |

**Thiếu nhánh không phải nguyên nhân đỏ.** Nhánh chưa phủ làm test *không chạy tới*, nên không đỏ; nó lộ ra ở báo cáo coverage/mutation ([`coverage-and-mutation.md`](coverage-and-mutation.md)) và xử lý bằng thêm test, không bằng phân loại test đỏ.

### Chọn tầng theo rủi ro của thay đổi

Không chạy mọi tầng cho mọi thay đổi; chọn theo thứ nó có thể làm hỏng, vẫn theo luật "tầng thấp nhất bắt được lỗi".

| Thay đổi chạm | Tầng bắt buộc thêm ngoài unit | Mặt cắt ngang cần xét |
|---|---|---|
| Logic thuần (tính toán, parser, rule) | Property/ca biên ([`unit-and-logic-edge-cases.md`](unit-and-logic-edge-cases.md)) | Mutation ở vùng đó ([`coverage-and-mutation.md`](coverage-and-mutation.md)) |
| Truy cập dữ liệu, migration, hàng đợi, API | Integration/contract với DB thật ([`integration-and-contract.md`](integration-and-contract.md)) | Idempotency, retry, rollback |
| Auth, phân quyền, tiền, dữ liệu cá nhân | Integration authz qua HTTP + ca "vượt quyền" | Bảo mật ([`../12-security/`](../12-security/README.md)) |
| Luồng người dùng chính, UI | E2E smoke + a11y ([`e2e-and-accessibility.md`](e2e-and-accessibility.md)) | Hiệu năng web |
| Đường nóng, truy vấn nặng, tải tăng | Load/benchmark ([`performance-and-load.md`](performance-and-load.md)) | Hiệu năng |
| Chỉ tài liệu/cấu hình không đổi hành vi | Cổng tĩnh (lint, link) | — |

### Ba mặt cắt ngang

Hiệu năng, bảo mật, độ tin cậy **không phải tầng của tháp**: chúng cắt ngang mọi tầng và mỗi mặt có nhà riêng. Test strategy chỉ chỉ đường.

| Mặt cắt | Kiểm ở | Nhà |
|---|---|---|
| Hiệu năng | load, stress, spike, soak, benchmark ratchet | [`performance-and-load.md`](performance-and-load.md) |
| Bảo mật | authn/authz, BOLA/BFLA, injection, XSS, CSRF, SSRF, rate-limit, prompt injection | [`integration-and-contract.md`](integration-and-contract.md) (authz qua HTTP), [`../12-security/`](../12-security/README.md) |
| Độ tin cậy | logging/tracing, retry, idempotency, chaos, backup/restore, rollback | [`../15-operations/`](../15-operations/README.md), [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md) |

## Checklist

- [ ] `QA-STRAT-001` **MUST** Một lệnh chạy toàn bộ test khai trong `xt.yaml` (hoặc `package.json`/`Makefile`) và CI gọi đúng lệnh đó. → Kiểm: `scripts/dev-task.sh test` exit 0; job CI dùng cùng lệnh (grep trong workflow). · Nguồn: P9
- [ ] `QA-STRAT-002` **MUST** CI chạy test trên mọi PR và là required check; merge bị chặn khi đỏ. → Kiểm: ruleset/branch protection liệt kê job test; không `continue-on-error`. · Nguồn: catalog 23 §2.5
- [ ] `QA-STRAT-003` **MUST@L** `PROJECT.md` ghi chiến lược (tầng nào, cổng nào, ngưỡng) theo bảng Quyết định. → Kiểm: mục "Kiểm thử" trong `PROJECT.md` liệt kê ≥ 2 tầng và ngưỡng.
- [ ] `QA-STRAT-004` **MUST@L** Mỗi tính năng MVP có ≥ 1 test chấp nhận tự động ánh xạ tiêu chí Given/When/Then trong spec. → Kiểm: tên test/tag chứa ID tính năng; script đối chiếu spec ↔ test không ID nào thiếu. · Nguồn: [`../17-product-project/specification.md`](../17-product-project/specification.md)
- [ ] `QA-STRAT-005` **MUST** Bug production sửa kèm test tái hiện (đỏ trước khi sửa). → Kiểm: PR `fix:` có file test thay đổi; CI job kiểm `fix:` thiếu test → cảnh báo/đỏ.
- [ ] `QA-STRAT-006` **MUST@L** Test tất định: thời gian giả lập, seed ngẫu nhiên cố định, không gọi mạng thật ở unit. → Kiểm: lint/cấu hình chặn `fetch`/socket ở unit (vd `vi.stubGlobal`, `pytest-socket`); test chạy 3 lần cùng kết quả.
- [ ] `QA-STRAT-007` **MUST@L** Test cách ly: mỗi test tự tạo và dọn dữ liệu, chạy được song song và theo thứ tự ngẫu nhiên. → Kiểm: `pytest -p randomly`/`vitest --sequence.shuffle`/`go test -shuffle=on` xanh.
- [ ] `QA-STRAT-008` **MUST** Không `test.only`/`.skip`/`xit`/`@pytest.mark.skip` không lý do lọt vào nhánh chính. → Kiểm: Playwright `forbidOnly: !!process.env.CI`; lint rule `no-focused-tests`/`no-disabled-tests`; grep skip phải kèm ticket.
- [ ] `QA-STRAT-009` **MUST@L** Chính sách flaky: test flaky được gắn nhãn `@flaky` + ticket, cách ly khỏi cổng, hạn sửa ≤ 2 tuần; retry CI ≤ 2. → Kiểm: danh sách flaky trong `docs/ops/flaky.md` có ngày; cấu hình `retries` ≤ 2.
- [ ] `QA-STRAT-010` **MUST@L** Ngân sách thời gian: unit ≤ 2 phút, toàn bộ cổng PR ≤ 15 phút (ghi và điều chỉnh trong `PROJECT.md`). → Kiểm: CI in thời gian job; cảnh báo khi vượt.
- [ ] `QA-STRAT-011` **MUST@L** Smoke test sau deploy (staging và production) chạy tự động, fail → rollback/cảnh báo. → Kiểm: job post-deploy gọi `run_smoke.sh`/E2E `@smoke`; log có kết quả.
- [ ] `QA-STRAT-012` **MUST@L** Báo cáo kiểm thử (GO/NO-GO) gắn nhãn bằng chứng `real-path` / `faithful-fixture` / `asserted-not-measured` cho từng claim. → Kiểm: `GO-NO-GO.md` có cột nhãn; 0 claim thiếu nhãn. · Nguồn: catalog 07, 23 §3.1
- [ ] `QA-STRAT-013` **SHOULD** Test gắn tag theo tầng/tốc độ (`@unit`, `@integration`, `@e2e`, `@slow`) để chạy chọn lọc ở pre-commit và đầy đủ ở CI. → Kiểm: lệnh `test:quick` và `test:all` tồn tại.
- [ ] `QA-STRAT-014` **SHOULD** Mỗi thư mục/module có chủ sở hữu test (CODEOWNERS) và test nằm cạnh code hoặc theo cấu trúc gương. → Kiểm: `CODEOWNERS` phủ `tests/`/`__tests__`.
- [ ] `QA-STRAT-015` **SHOULD** Lỗi lặp lại tạo hàng rào mới (test, lint rule, hook) ghi trong post-mortem. → Kiểm: post-mortem có mục "hàng rào" trỏ PR. · Nguồn: P12
- [ ] `QA-STRAT-016` **SHOULD** Test chạy được offline trong sandbox agent (không cần secret thật) — dùng fixture/record-replay. → Kiểm: `scripts/dev-task.sh test` xanh với `.env.test` không chứa secret thật.
- [ ] `QA-STRAT-017` **SHOULD** Eval cho LLM/agent có negative control (case phải fail) và chạy record/replay ở PR; chỉ ghi lại qua `workflow_dispatch`. → Kiểm: bộ eval có ≥ 1 case `expect: fail`; job PR không có API key model. · Nguồn: catalog 07, 23 §3.1
- [ ] `QA-STRAT-018` **SHOULD** Ma trận hỗ trợ (OS/trình duyệt/phiên bản runtime) ghi rõ và CI chạy ít nhất phiên bản thấp nhất + cao nhất. → Kiểm: workflow `matrix` có ≥ 2 giá trị.
- [ ] `QA-STRAT-019` **MAY** Visual regression (Playwright `toHaveScreenshot`/Storybook) cho design system.
- [ ] `QA-STRAT-020` **MAY** Test trên device farm/3 OS cho mobile/CLI khi có người dùng đa nền tảng.
- [ ] `QA-STRAT-021` **SHOULD** Test đỏ được phân loại vào một trong bốn nguyên nhân (bug thật · kỳ vọng sai · bó vào cài đặt · flaky/môi trường) trước khi sửa; bug thật giữ nguyên test, các nguyên nhân còn lại nêu bằng chứng ở bảng "Phân loại test đỏ". → Kiểm: commit `fix:` ghi nguyên nhân và đường tái hiện/trích SPEC; PR sửa assertion không kèm trích SPEC bị `reviewer` từ chối. · Nguồn: Fowler *Practical Test Pyramid* (test hành vi, không test cài đặt); [`LOOP-CI-001`](../11-autonomous-loop/self-healing-ci.md)
- [ ] `QA-STRAT-022` **SHOULD** Tầng test chạy cho mỗi thay đổi chọn theo rủi ro thay đổi chạm (bảng "Chọn tầng theo rủi ro"), không chạy mọi tầng cho mọi PR và không bỏ tầng bắt buộc của vùng chạm auth/tiền/dữ liệu. → Kiểm: mô tả PR hoặc `PLAN.md` ghi tầng đã chọn và lý do cho thay đổi chạm vùng rủi ro; cổng PR ≤ ngân sách `QA-STRAT-010`.
- [ ] `QA-STRAT-023` **SHOULD** Ở vùng `critical` (tiền, phân quyền, parser), người viết test độc lập với người viết code: test chấp nhận viết từ SPEC, không từ code đã có, bởi ngữ cảnh khác (vd `executor` thứ hai chỉ nhận SPEC + giao diện công khai); người điều phối giữ vai duy nhất ([`LOOP-ORCH-001`](../11-autonomous-loop/orchestration-and-subagents.md)). → Kiểm: PR vùng `critical` có test do lượt/ngữ cảnh khác với lượt viết code; mutation score vùng đó ≥ ngưỡng `QA-COV-005`. · Nguồn: arXiv 2412.14137 (bộ sinh test LLM quan sát cài đặt rồi lọc test đỏ nên khó tìm bug) — đọc tóm tắt 2026-10-17 (chưa xác minh toàn văn)

## Bẫy thường gặp

- **Kem ốc quế (ice-cream cone):** nhiều E2E chậm, ít unit. Chậm, flaky, không chỉ ra lỗi ở đâu. Cách tránh: bảng Quyết định; E2E chỉ luồng chính.
- **Test chi tiết triển khai** (assert hàm private, cấu trúc state nội bộ) → refactor là đỏ dù hành vi đúng. Cách tránh: test qua giao diện công khai; `getByRole` thay selector CSS.
- **Mock tất cả** → test xanh, production đỏ (DB thật khác mock). Cách tránh: integration với testcontainers ([`integration-and-contract.md`](integration-and-contract.md)).
- **CI "advisory"**: job test không required, merge trước khi xong (baseline xboss: lead time 4,4 phút = thời gian CI). Cách tránh: QA-STRAT-002; `xt.py ci-check` + job `protection-guard` kiểm chính CI (ý gốc: catalog 23 §3.3).
- **Làm cổng xanh bằng nới cấu hình**: skip test, hạ ngưỡng, tăng retry. Cách tránh: hook hỏi khi chạm cấu hình cổng; review diff cấu hình riêng.
- **Snapshot làm oracle**: cập nhật snapshot "cho xanh" mà không đọc. Cách tránh: snapshot chỉ cho output ổn định (CLI golden), review diff snapshot như code.
- **Retry che bug thật** (race condition xanh ở lần 2). Cách tránh: retry ≤ 2 + trace on-first-retry + ticket.
- **Agent suy diễn lệnh test từ văn xuôi** → "evidence unverified" 11 lần liên tiếp (qlkh). Cách tránh: `xt.yaml`/`runtime.yaml` là nguồn lệnh duy nhất.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `scripts/dev-task.sh test` (đọc `xt.yaml`) | `scripts/dev-task.sh test` | pre-commit (tập `quick`) + CI (đầy đủ) | exit 0 |
| Vitest 5.0.4 / Jest 30.5.2 / pytest 9.1.1 / `go test` (Go 1.27) / JUnit 6.1.3 | `vitest run` · `pytest -q` · `go test ./... -shuffle=on -race` · `mvn test` | CI | 0 fail |
| Lint test | ESLint `eslint-plugin-vitest`/`jest` rule `no-focused-tests`, `no-disabled-tests`; `pytest --strict-markers` | CI | 0 vi phạm |
| Shuffle/isolation | `pytest -p randomly` · `vitest --sequence.shuffle` · `go test -shuffle=on` | CI nightly | xanh |
| Thời gian job | GitHub Actions `timeout-minutes: 15` cho job PR | CI | không timeout |
| Script spec ↔ test | `python3 scripts/check-acceptance-tests.py` (tự viết) | CI | 0 tính năng thiếu test |

## Nguồn

- Phiên bản công cụ (registry, xác minh 2026-10-13): `vitest` 5.0.4, `jest` 30.5.2 (npm); `pytest` 9.1.1 (PyPI, 2026-06-19); Go 1.27 (<https://endoflife.date/api/go.json>, 2026-08-19); JUnit 6.1.3 (<https://github.com/junit-team/junit-framework/releases>, 07/08, năm không hiện).
- Playwright test configuration (`forbidOnly`, `retries`, `workers`, `trace`): <https://playwright.dev/docs/test-configuration> — xác minh 2026-10-13
- Catalog `seeker19110/stored` mục 07 (claim matrix, negative control, record/replay), 23 §2.5 (gate aggregator, CI advisory), 23 §3.3 (`runtime.yaml`, `ci_guard.py`) — đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md` §2.4, §2.7.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 4 (E2E luồng chính, dữ liệu test tất định), commit `1b80fe4`.
- Martin Fowler, *The Practical Test Pyramid* (đẩy test xuống tầng thấp nhất; test hành vi, không test cài đặt; E2E flaky nên giữ ít): <https://martinfowler.com/articles/practical-test-pyramid.html> — đọc 2026-10-17. Google Testing Blog, *Just Say No to More End-to-End Tests* (giữ hình tháp): <https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html> — đọc một phần 2026-10-17.
- Bộ sinh test LLM và bài toán oracle: arXiv 2412.14137 (<https://arxiv.org/html/2412.14137v1>), 2601.05542, AugmenTest 2501.17461 (oracle suy từ tài liệu, không từ code) — **chỉ đọc tóm tắt tìm kiếm 2026-10-17, chưa đọc toàn văn**.
- `seeker19110/stored` mục 09 §3 (kiểm ảnh agent QA 7 tầng + 4 verdict, 2026-10-17): nguồn của bảng phân loại test đỏ, chọn tầng theo rủi ro và ba mặt cắt ngang; verdict "missing branch" của bản gốc bị loại vì không làm test đỏ, thay bằng flaky/môi trường.
