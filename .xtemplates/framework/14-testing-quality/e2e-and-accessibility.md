---
title: E2E & a11y: Playwright/axe, mobile, flaky, trace
kind: module
prefix: QA-E2E
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
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

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `@playwright/test` 1.64.0 | `npx playwright test --grep @smoke` (PR) · `npx playwright test` (nightly) | CI job `e2e` | 0 fail, 0 flaky trong required |
| `@axe-core/playwright` 4.13.0 | `new AxeBuilder({page}).withTags([...,'wcag22aa']).analyze()` | trong mọi spec `@smoke` | 0 `critical`/`serious` |
| `eslint-plugin-playwright` (phiên bản **chưa xác minh**) | rule `no-wait-for-timeout`, `no-focused-test`, `prefer-web-first-assertions` | CI lint | 0 error |
| `pa11y-ci` 5.0.0 | `pa11y-ci --sitemap https://staging/sitemap.xml` | CI nightly (static-site) | 0 error |
| Artifact | `actions/upload-artifact` (ghim SHA) `playwright-report/`, `test-results/` | CI `if: failure()` | retention ≥ 14 ngày |
| Cache browser | `actions/cache` `~/.cache/ms-playwright` | CI | cache hit → bỏ `install --with-deps` |
| XCUITest / Espresso | `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone SE'` · `./gradlew connectedCheck` | CI mobile | 0 fail |

## Nguồn

- Playwright test configuration (`forbidOnly`, `retries`, `workers`, `trace: 'on-first-retry'`): <https://playwright.dev/docs/test-configuration> — xác minh 2026-10-13
- Phiên bản (npm, xác minh 2026-10-13): `@playwright/test` 1.64.0, `@axe-core/playwright` 4.13.0, `pa11y-ci` 5.0.0.
- Lighthouse CI commit cuối 2025-06-26: <https://github.com/GoogleChrome/lighthouse-ci/commits/main> — xác minh 2026-10-13
- WCAG 2.2: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13
- Catalog `seeker19110/stored` 23 §2.5 (Playwright CI: `workers: 4` đo 80/150s, cache browser −29s, `retries: 2`, `trace: on-first-retry`, desktop+mobile+axe), 11 (agent browser, telemetry) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 3–4 (axe hai tầng, 2 project desktop/mobile, `getByRole`), commit `1b80fe4`.
