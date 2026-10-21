---
title: E2E & a11y: Playwright/axe, mobile, flaky, trace
kind: module
prefix: QA-E2E
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-21
---

# E2E & a11y: Playwright/axe, mobile, flaky, trace

> Kiểm luồng người dùng thật qua giao diện, trên desktop **và** mobile viewport, kèm quét a11y tự động; giữ suite nhanh và
> không flaky. Tiêu chí tuân thủ a11y ở [`../04-standards/accessibility-standards.md`](../04-standards/accessibility-standards.md);
> kỹ thuật a11y ở [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md).

## Nguyên tắc

- **E2E chỉ cho luồng quan trọng nhất.** Đăng nhập → thao tác lõi → đạt mục tiêu; mỗi luồng một test; phần còn lại xuống unit/integration.
- **Selector theo vai trò, không theo CSS.** `getByRole`/`getByLabel`/`getByText` bền hơn và ép a11y đúng; `data-testid` là phương án cuối.
- **Mỗi test tự tạo dữ liệu, chạy độc lập, song song được.** Không phụ thuộc thứ tự, không dùng dữ liệu thật.
- **Flaky là bug có hạn sửa**, không phải thứ retry mãi. Retry ≤ 2 chỉ để lấy trace.
- **Quét a11y là một phần của mọi E2E**, không phải suite riêng dễ quên.

## Quyết định

| Nền tảng | Mặc định (xác minh 2026-10-13) | Thay thế + điều kiện | Không dùng |
|---|---|---|---|
| Web | Playwright `@playwright/test` 1.64.0 (Apache-2.0) + `@axe-core/playwright` 4.13.0 (MPL-2.0); project `desktop` (Chromium) + `mobile` (Pixel/iPhone emulation) | Cypress khi đội đã có suite lớn; WebdriverIO khi cần Appium chung | Selenium thuần cho dự án mới |
| Desktop (Electron/Tauri) | Playwright Electron API / Tauri WebDriver | WinAppDriver, XCUITest native khi app native | — |
| Mobile native | XCUITest (iOS), Espresso/Compose UI test (Android) | Appium/Detox cho cross-platform; Maestro (phiên bản **chưa xác minh**) | Chỉ test trên simulator một kích thước |
| Static site | Playwright smoke + `pa11y-ci` 5.0.0 (LGPL-3.0) cho nhiều URL | Lighthouse CI a11y category | — |
| Game (web/engine) | Headless script chạy vòng chơi cơ bản | Playwright cho UI web | — |
| Agent điều khiển browser để test | chỉ **tạo** test (sinh script Playwright), không làm cổng | — | Agent-run E2E làm required check (không tất định) |

## Checklist

- [ ] `QA-E2E-001` **MUST** Có E2E cho luồng chính (ít nhất: đăng nhập/đăng ký, thao tác lõi tạo giá trị, thanh toán nếu có) chạy trong CI trên mọi PR. → Kiểm: test tag `@smoke` ≥ 3; job `e2e` required.
- [ ] `QA-E2E-002` **MUST@L** Mỗi luồng chính chạy trên cả project desktop và mobile viewport. → Kiểm: `playwright.config` có ≥ 2 `projects` (`desktop`, `mobile`) và báo cáo có kết quả cả hai. · Nguồn: [`../06-design-ux/responsive-and-mobile-first.md`](../06-design-ux/responsive-and-mobile-first.md)
- [ ] `QA-E2E-003` **MUST** Mỗi E2E (hoặc mỗi trang chính) kèm quét axe với tag đến `wcag22aa`, 0 vi phạm `critical`/`serious`. → Kiểm: helper `expectNoA11yViolations(page)` được gọi trong mọi spec `@smoke`; CI đỏ khi có vi phạm. · Nguồn: WCAG 2.2 AA
- [ ] `QA-E2E-004` **MUST@L** Selector ưu tiên `getByRole`/`getByLabel`/`getByText`; `data-testid` chỉ khi không có vai trò hợp lý. → Kiểm: lint `playwright/prefer-locator`/grep `page.locator('.`/`#` ≤ ngưỡng ghi trong repo (mặc định 0 trong spec `@smoke`).
- [ ] `QA-E2E-005` **MUST** `forbidOnly` bật ở CI; `retries` ≤ 2; `trace: 'on-first-retry'`; `workers` cố định ở CI (mặc định 4 theo đo catalog 23). → Kiểm: `playwright.config` có `forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`, `trace: 'on-first-retry'`. · Nguồn: Playwright docs test-configuration
- [ ] `QA-E2E-006` **MUST** Test tự tạo dữ liệu qua API/seed và dọn sau; không dùng tài khoản/dữ liệu thật; chạy trên môi trường staging/preview. → Kiểm: `baseURL` không phải production; fixture tạo user với email `+e2e-<uuid>`; cleanup trong `afterEach`/global teardown.
- [ ] `QA-E2E-007` **MUST@L** Không `waitForTimeout` cố định; chờ theo điều kiện (`expect(locator).toBeVisible()`, `waitForResponse`). → Kiểm: `grep -r "waitForTimeout" e2e/` = 0 (ngoại lệ có comment lý do).
- [ ] `QA-E2E-008` **MUST@L** Trace/video/screenshot của test đỏ được upload artifact và giữ ≥ 14 ngày. → Kiểm: workflow có `upload-artifact` cho `playwright-report/` và `test-results/` khi `failure()`.
- [ ] `QA-E2E-009` **MUST@L** Flaky: test đỏ-xanh trong cùng run được gắn `@flaky` + ticket, cách ly khỏi required check, hạn sửa ≤ 2 tuần. → Kiểm: báo cáo Playwright `flaky` count = 0 trong required; `docs/ops/flaky.md` có hạn. · Nguồn: [`test-strategy.md`](test-strategy.md) QA-STRAT-009
- [ ] `QA-E2E-010` **MUST@L** Kiểm tay bàn phím + trình đọc màn hình cho luồng chính mỗi release lớn, ghi biên bản. → Kiểm: mục trong `GO-NO-GO.md`. · Nguồn: [`../04-standards/accessibility-standards.md`](../04-standards/accessibility-standards.md) STD-A11Y-004
- [ ] `QA-E2E-011` **MUST@L** Mobile native: UI test luồng chính trên emulator/simulator trong CI với ít nhất một kích thước nhỏ (≤ 5,4") và font scale lớn. → Kiểm: job CI chạy XCUITest/Espresso; cấu hình device có 2 profile.
- [ ] `QA-E2E-012` **SHOULD** Cache trình duyệt Playwright theo lockfile; cài `--with-deps` chỉ khi cache miss. → Kiểm: workflow cache `~/.cache/ms-playwright` key `hashFiles('**/package-lock.json')` (đo −29s, catalog 23 §2.5).
- [ ] `QA-E2E-013` **SHOULD** Thời gian suite E2E ở PR ≤ 10 phút; phần còn lại chạy nightly. → Kiểm: log thời gian job; tag `@nightly`.
- [ ] `QA-E2E-014` **SHOULD** Test trạng thái UI: rỗng, tải, lỗi, thành công cho màn hình chính (chặn API bằng `route` để ép trạng thái). → Kiểm: spec có 4 ca `empty|loading|error|success` cho mỗi màn `@smoke`. · Nguồn: [`../06-design-ux/ui-states-and-feedback.md`](../06-design-ux/ui-states-and-feedback.md)
- [ ] `QA-E2E-015` **SHOULD** Kiểm theme: luồng chính chạy ở cả dark và light, axe kiểm tương phản ở cả hai. → Kiểm: project hoặc fixture `colorScheme: 'dark'|'light'`.
- [ ] `QA-E2E-016` **SHOULD** Kiểm `prefers-reduced-motion`: animation lớn tắt khi emulate. → Kiểm: test `page.emulateMedia({reducedMotion: 'reduce'})` assert không có transition dài.
- [ ] `QA-E2E-017` **SHOULD** Visual regression chỉ cho component ổn định (design system), ngưỡng diff ghi rõ, review ảnh như code. → Kiểm: `toHaveScreenshot` với `maxDiffPixelRatio` ghi trong config.
- [ ] `QA-E2E-018` **MAY** Chạy E2E đa trình duyệt (WebKit/Firefox) ở nightly.
- [ ] `QA-E2E-019` **MAY** Dùng agent/LLM để **sinh** kịch bản E2E từ spec, người review rồi commit; không dùng agent chạy trực tiếp làm cổng.
- [ ] `QA-E2E-020` **SHOULD** Chia shard song song: `fullyParallel: true` (shard cân bằng ở mức từng test, không phải từng file) + ma trận CI `--shard=<i>/<N>` với `fail-fast: false`; chọn N sao cho shard chậm nhất ≈ ngân sách thời gian (`QA-E2E-026`); báo cáo blob của mọi shard gộp một lần bằng `merge-reports`. → Kiểm: `playwright.config` có `fullyParallel: true` và `reporter: process.env.CI ? 'blob' : 'html'`; workflow có `strategy.matrix.shardIndex` + job gộp `needs: [e2e]` chạy `npx playwright merge-reports`; thời gian job shard chậm nhất ≤ ngân sách. · Nguồn: Playwright docs test-sharding (xác minh 2026-10-18)
- [ ] `QA-E2E-021` **SHOULD** Build một lần, mọi shard dùng lại: job build riêng đẩy artifact (bản build/preview), shard tải về và khởi động từ bản build — không build lại ở từng shard, không chạy dev server; cài trình duyệt theo `QA-E2E-012`. → Kiểm: workflow có job `build` + `actions/upload-artifact`; job shard có `needs: [build]` và không có bước `build`; `webServer.command` trỏ lệnh serve bản build.
- [ ] `QA-E2E-022` **SHOULD** Đăng nhập một lần cho mỗi worker: project `setup` đăng nhập qua giao diện rồi lưu `storageState` (`playwright/.auth/`, vào `.gitignore`) — **mỗi worker một tài khoản test riêng**, không dùng chung một tài khoản cho mọi worker (`QA-E2E-006`, mục Bẫy); mọi project test dùng `storageState` + `dependencies: ['setup']`; dữ liệu nền tạo qua API/seed (`QA-E2E-006`), giao diện chỉ dùng cho bước đang kiểm. → Kiểm: config có project `setup` (`testMatch: /.*\.setup\.ts/`) và `storageState`; tài khoản/file trạng thái khác nhau theo `workerIndex`; `.gitignore` có `playwright/.auth`; chỉ spec đăng nhập đi qua form đăng nhập. · Nguồn: Playwright docs auth (xác minh 2026-10-18)
- [ ] `QA-E2E-023` **SHOULD** Chọn test theo ảnh hưởng ở PR: PR chỉ chạy `@smoke` + spec của luồng bị đổi (khai lệnh ở `xt.yaml` `e2e_affected`; Gate mỗi task của autopilot cũng chỉ chạy spec của lát đó), còn suite đầy đủ chạy khi push `main`, trước deploy/phát hành và nightly (autopilot: `loop verify` chỉ chạy lại Gate của từng task nên PLAN phải có task cuối với Gate là lệnh `e2e` đầy đủ); PR chạm vùng dùng chung (thành phần lõi, config, lockfile, workflow, schema) → chạy đầy đủ. Job bỏ qua báo `skipped` được `quality` chấp nhận (`WF-CI-017`); không bao giờ để bản deploy đi qua mà thiếu lần chạy đầy đủ xanh. → Kiểm: workflow tính tập spec từ `git diff` và có ca "chạm lockfile → đầy đủ"; push `main` chạy đầy đủ; deploy `needs` job e2e đầy đủ; PLAN có task cuối Gate = `e2e` đầy đủ.
- [ ] `QA-E2E-024` **SHOULD** Đỏ sớm, huỷ phần thừa: `@smoke` chạy thành job riêng trước và đỏ thì huỷ phần còn lại (`--max-failures`), huỷ run cũ cùng nhánh (`concurrency` + `cancel-in-progress: true`). → Kiểm: workflow có `concurrency.cancel-in-progress: true` cho nhánh PR; lệnh CI có `--max-failures=<n>` hoặc `maxFailures` trong config. · Nguồn: Playwright docs test-parallel (xác minh 2026-10-18)
- [ ] `QA-E2E-025` **SHOULD** Bớt việc thừa trong từng test: timeout ngắn theo đo (`expect.timeout`, `actionTimeout` ≤ 10 s; không nâng timeout toàn cục để che test chậm), chờ theo sự kiện (`QA-E2E-007`), chặn tài nguyên không liên quan (ảnh, font, analytics) bằng `route`, tắt animation (`reducedMotion`). → Kiểm: `playwright.config` có `expect.timeout` và `use.actionTimeout` ≤ 10 000; fixture chặn host analytics; không có `timeout` toàn cục > 60 000 mà thiếu comment lý do.
- [ ] `QA-E2E-026` **SHOULD** Có ngân sách thời gian và đo mỗi run: mặc định PR ≤ 5 phút đồng hồ khi đã shard (trần cứng `QA-E2E-013` ≤ 10), suite đầy đủ ≤ 15 phút; mỗi run in p50/p95 và 10 test chậm nhất vào step summary; vượt ngân sách hai run liên tiếp thì mở task tối ưu (tăng shard, tách test, đẩy xuống integration). Không chữa chậm bằng cách bỏ test hay tăng retry. → Kiểm: step summary có bảng thời gian (từ `--reporter=json`); `docs/ops/` có bảng thời gian theo tuần; có task tối ưu khi vượt.
- [ ] `QA-E2E-027` **MAY** Test có **bước agent** (browser agent): job required chỉ **phát lại cache đã kiểm** (cache chỉ ghi sau khi bước xác minh pass; phát lại không gọi model) và không có khoá model; cache miss/stale = đỏ (như `--strict-cache` của tester-army/e2e), cache làm mới ở job riêng ngoài đường merge; luồng tiền/quyền vẫn assert bằng locator. → Kiểm: job required không có secret API model; test cố ý làm hỏng cache → đỏ. · Nguồn: tester-army/e2e docs/cache.mdx <https://github.com/tester-army/e2e> (đọc 2026-10-18)
- [ ] `QA-E2E-028` **SHOULD** E2E chỉ dùng tài khoản/dữ liệu **tổng hợp**; video, download, cache agent và log **không che** giá trị đã gõ, nên quét `playwright-report/`, `test-results/` và thư mục cache agent bằng `gitleaks dir <path>` (gitleaks ≥ 8.19; `detect`/`protect` deprecated) **trước** `actions/upload-artifact` (`QA-E2E-008`, [`WF-CI-019`](../10-workflow/ci-cd-pipeline.md)) hoặc commit. → Kiểm: bước `gitleaks dir` đứng trước `actions/upload-artifact` trong workflow; `rg` email/SĐT thật trong fixture = 0. · Nguồn: tester-army/e2e docs/security.mdx ("Neither is masked"); gitleaks README <https://github.com/gitleaks/gitleaks> (đọc 2026-10-18)
- [ ] `QA-E2E-029` **SHOULD** Khởi đầu tối thiểu ở dự án đích: một lệnh `e2e` trong `xt.yaml` chạy `@smoke` luồng chính (`QA-E2E-001`) kèm axe (`QA-E2E-003`), project `desktop` (thêm `mobile` ở L — `QA-E2E-002`), `fullyParallel: true`, `forbidOnly`/`retries`/`trace` theo `QA-E2E-005`, chia shard bằng `--shard=${XT_SHARD:-1/1}` (matrix mẫu 2 shard cần ≥ 2 test — `QA-E2E-001` đã đòi ≥ 3 `@smoke` — để không shard nào rỗng); cài trình duyệt ở `e2e_setup`; job `e2e` của CI mẫu chạy cùng lúc với test (không `needs: build` — lệnh `e2e` tự build và phục vụ). Gộp báo cáo blob, build một lần, đăng nhập theo worker, chọn theo ảnh hưởng, cache trình duyệt, nightly đa trình duyệt (`QA-E2E-012`, `-018`, `-020`…`-023`) thêm khi thời gian PR vượt ngân sách `QA-E2E-026`, không thêm từ đầu. → Kiểm: `xt.yaml` có `e2e` chứa `XT_SHARD`; `dev-task.sh e2e-mode` in `shard`; job `e2e` của CI xanh ở cả hai shard. · Nguồn: [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md) `WF-CI-025`; Playwright docs test-sharding (xác minh 2026-10-18); D-115

## Bẫy thường gặp

- **`waitForTimeout(3000)` khắp nơi** → chậm và vẫn flaky. Cách tránh: QA-E2E-007 chờ theo điều kiện.
- **Selector CSS/XPath theo cấu trúc DOM** → đổi class là đỏ. Cách tránh: `getByRole`.
- **Dùng chung một tài khoản test** → test song song dẫm nhau. Cách tránh: user theo test (QA-E2E-006).
- **Chạy E2E trên production** "vì staging không giống". Cách tránh: preview/staging giống production bằng IaC; cấm `baseURL` production trong CI.
- **Retry 5 lần "cho xanh"** che race thật. Cách tránh: retry ≤ 2 + trace + ticket.
- **axe chỉ chạy ở một trang** (trang chủ) → bỏ sót form/modal. Cách tránh: helper gọi sau mỗi bước mở modal/trang.
- **Lighthouse CI làm cổng a11y duy nhất** — repo đứng yên từ 2025-06-26, chấm trang đơn. Cách tránh: axe trong E2E là cổng chính.
- **Agent điều khiển browser làm cổng** (browser-use, TesterArmy…): không tất định, có công cụ bật telemetry mặc định (catalog 11). Cách tránh: chỉ sinh test, người duyệt.
- **Bỏ mobile viewport** vì "responsive rồi". Cách tránh: QA-E2E-002 bắt buộc 2 project.
- **Tăng tốc bằng cách bỏ test hoặc nâng retry/timeout** → cổng xanh nhưng hồi quy lọt. Cách tránh: tăng shard, build một lần, đăng nhập một lần, chọn test theo ảnh hưởng (QA-E2E-020…023); không bao giờ để deploy đi qua mà thiếu lần chạy đầy đủ.
- **Chọn test theo ảnh hưởng nhưng bỏ sót vùng dùng chung** (lockfile, config, thành phần lõi) → PR đổi nền mà chỉ chạy vài spec. Cách tránh: danh sách vùng chạy đầy đủ trong QA-E2E-023, suite đầy đủ trên `main`.
- **Đăng nhập qua giao diện ở mọi test** → mỗi test mất vài giây thừa nhân với hàng trăm test. Cách tránh: QA-E2E-022.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `@playwright/test` 1.64.0 | `npx playwright test --grep @smoke` (PR) · `npx playwright test` (nightly) | CI job `e2e` | 0 fail, 0 flaky trong required |
| `@axe-core/playwright` 4.13.0 | `new AxeBuilder({page}).withTags([...,'wcag22aa']).analyze()` | trong mọi spec `@smoke` | 0 `critical`/`serious` |
| `eslint-plugin-playwright` (phiên bản **chưa xác minh**) | rule `no-wait-for-timeout`, `no-focused-test`, `prefer-web-first-assertions` | CI lint | 0 error |
| `pa11y-ci` 5.0.0 | `pa11y-ci --sitemap https://staging/sitemap.xml` | CI nightly (static-site) | 0 error |
| Artifact | `actions/upload-artifact` (ghim SHA) `playwright-report/`, `test-results/` | CI `if: failure()` | retention ≥ 14 ngày |
| Cache browser | `actions/cache` `~/.cache/ms-playwright` | CI | cache hit → bỏ `install --with-deps` |
| Shard + gộp báo cáo | `npx playwright test --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}` · `npx playwright merge-reports --reporter html ./all-blob-reports` | CI job `e2e` (matrix) + job gộp | shard chậm nhất ≤ ngân sách (QA-E2E-026) |
| Đỏ sớm | `--max-failures=<n>` · `concurrency: cancel-in-progress: true` | CI | huỷ run cũ, dừng khi đỏ |
| Ngân sách thời gian | `--reporter=json` → bảng p50/p95 + 10 test chậm nhất vào `$GITHUB_STEP_SUMMARY` | CI | PR ≤ 5 phút (cứng ≤ 10), đầy đủ ≤ 15 |
| XCUITest / Espresso | `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone SE'` · `./gradlew connectedCheck` | CI mobile | 0 fail |

## Nguồn

- Playwright test configuration (`forbidOnly`, `retries`, `workers`, `trace: 'on-first-retry'`): <https://playwright.dev/docs/test-configuration> — xác minh 2026-10-13
- Playwright sharding (`--shard=x/y`, blob reporter + `merge-reports`, `fullyParallel` để shard cân bằng theo từng test, ví dụ ma trận `fail-fast: false`): <https://playwright.dev/docs/test-sharding> — xác minh 2026-10-18. Trang không nêu phiên bản cho blob reporter/`merge-reports` (chưa xác minh phiên bản).
- Playwright auth (`storageState`, project `setup` + `dependencies`, thư mục `playwright/.auth` vào `.gitignore`): <https://playwright.dev/docs/auth> — xác minh 2026-10-18.
- Playwright parallelism (`fullyParallel`, `--max-failures`/`maxFailures`; trang không nêu số `workers` mặc định): <https://playwright.dev/docs/test-parallel> — xác minh 2026-10-18.
- Phiên bản (npm, xác minh 2026-10-13): `@playwright/test` 1.64.0, `@axe-core/playwright` 4.13.0, `pa11y-ci` 5.0.0.
- Lighthouse CI commit cuối 2025-06-26: <https://github.com/GoogleChrome/lighthouse-ci/commits/main> — xác minh 2026-10-13
- WCAG 2.2: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13
- Catalog `seeker19110/stored` 23 §2.5 (Playwright CI: `workers: 4` đo 80/150s, cache browser −29s, `retries: 2`, `trace: on-first-retry`, desktop+mobile+axe), 11 (agent browser, telemetry) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 3–4 (axe hai tầng, 2 project desktop/mobile, `getByRole`), commit `1b80fe4`.
- tester-army/e2e (docs/cache.mdx: cache ghi sau xác minh pass, phát lại không gọi model; docs/security.mdx: video/download/cache "Neither is masked"): <https://github.com/tester-army/e2e> — đọc 2026-10-18. gitleaks ≥ 8.19 (`gitleaks dir`; `detect`/`protect` deprecated): <https://github.com/gitleaks/gitleaks> — đọc 2026-10-18.
