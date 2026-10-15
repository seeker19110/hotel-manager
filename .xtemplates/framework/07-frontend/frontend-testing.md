---
title: Kiểm thử frontend: component, visual, E2E, a11y
kind: module
prefix: FE-TEST
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Kiểm thử frontend: component, visual, E2E, a11y

> Tháp kiểm thử cho giao diện: **unit** cho logic thuần → **component** (Testing Library/Storybook, truy vấn theo vai trò) →
> **visual regression** (ảnh, hai theme, hai viewport) → **E2E** (Playwright, desktop + mobile, axe) với chính sách flaky rõ.
> Chiến lược chung → [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md); E2E/a11y chi tiết →
> [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md); coverage/mutation →
> [`../14-testing-quality/coverage-and-mutation.md`](../14-testing-quality/coverage-and-mutation.md); dữ liệu test →
> [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md).

## Nguyên tắc

1. **Test giống cách người dùng dùng**: truy vấn `getByRole` → `getByLabelText` → `getByText`; `getByTestId` là lựa chọn cuối.
   Test tốt ép a11y tốt.
2. **Tất định hay không có**: thời gian cố định, random có seed, mạng mock (MSW) ở unit/component; E2E chạy trên môi trường
   preview có dữ liệu riêng, tự tạo và tự dọn.
3. **Flaky là lỗi, không phải thời tiết**: retry trong CI để không chặn, nhưng mọi test flaky được đánh dấu, có issue, có hạn sửa;
   tỷ lệ flaky là metric.
4. **Ít E2E, đúng chỗ**: luồng sinh tiền/đăng nhập/thao tác lõi; còn lại đẩy xuống component/unit.
5. **Ảnh là bằng chứng**: visual regression cho component dùng chung và trang chính, chạy trong container cố định, baseline từ CI.
6. **Mỗi bug có test tái hiện đỏ trước khi sửa** (P12).

## Quyết định

| Tầng | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Unit (logic thuần) | Vitest 5.0.4 (MIT) (hoặc `node:test` khi muốn ít phụ thuộc) | Mọi dự án | — |
| Component | Testing Library (`@testing-library/react` 16.3.3) trên Vitest browser mode (`@vitest/browser` 5.0.4, chạy Playwright) **hoặc** jsdom 30.1.2/happy-dom 21.0.1 cho test nhanh | Component có tương tác | jsdom cho layout/CSS/scroll (không mô phỏng) → browser mode |
| Story-as-test | Storybook 10.6.2 + `@storybook/addon-vitest` 10.6.2 (play function, a11y addon) | Có Storybook | Không Storybook → Testing Library thuần |
| Visual regression | Playwright `toHaveScreenshot` (WebP, `maxDiffPixelRatio`) trong Docker image cố định | Mọi dự án có UI | Cần review UI cộng tác/đa trình duyệt → Chromatic (SaaS, có phí) — ghi ADR |
| E2E | Playwright 1.64.0 (Apache-2.0): projects `desktop` + `mobile`, `@axe-core/playwright` 4.13.0, `storageState` cho auth | Mọi web app | Cypress nếu đội đã có và không có lý do đổi |
| Mock API | MSW 3.0.3 (MIT) dùng chung unit/component/E2E (handler một nơi) | Mọi dự án | E2E staging với backend thật cho luồng chính (không mock) |
| Component test mobile native | XCTest/UI Testing, Espresso/Compose test; Detox/Maestro cho E2E | App native | — |

## Checklist

- [ ] `FE-TEST-001` **MUST** Component có tương tác có test (Testing Library hoặc story `play`) dùng truy vấn theo vai trò/nhãn; `getByTestId` chỉ khi không có lựa chọn khác và có chú thích. → Kiểm: lint `testing-library/prefer-screen-queries`, `testing-library/no-container`; grep `getByTestId` / tổng truy vấn ≤ 10%. · Nguồn: Testing Library — Priority
- [ ] `FE-TEST-002` **MUST** E2E luồng chính (đăng nhập → thao tác lõi → kết quả) chạy trên **hai** project desktop và mobile, có quét axe sau mỗi bước. → Kiểm: `playwright.config` có 2 project + `AxeBuilder`; CI chạy cả hai. · Nguồn: [`../06-design-ux/responsive-and-mobile-first.md`](../06-design-ux/responsive-and-mobile-first.md); [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `FE-TEST-003` **MUST** Test tất định: thời gian giả (`vi.useFakeTimers`/`page.clock`), random có seed, locale/timezone cố định (`TZ=UTC`, `LANG`), mạng mock ở unit/component. → Kiểm: chạy test 3 lần liên tiếp cùng kết quả (`--repeat-each=3` cho Playwright); cấu hình `TZ` trong script test.
- [ ] `FE-TEST-004` **MUST@L** Chính sách flaky: CI `retries: 2`, `trace: 'on-first-retry'`; test flaky được gắn nhãn, mở issue trong 1 ngày làm việc, không được xoá/skip không lý do. → Kiểm: reporter JSON đếm `flaky`; CI fail khi tỷ lệ flaky > ngưỡng dự án (vd 2%) trong 7 ngày; grep `test.skip|it.skip|xit` → mỗi cái có link issue. · Nguồn: Playwright Test retries; P12
- [ ] `FE-TEST-005` **MUST@L** E2E độc lập thứ tự, tự tạo dữ liệu và dọn; không dùng dữ liệu production; tài nguyên dùng chung (tài khoản admin, cấu hình toàn cục) dùng `lock` hoặc test tuần tự có lý do. → Kiểm: `--shuffle` chạy xanh; `fullyParallel: true`; kiểm `baseURL` không phải production. · Nguồn: Playwright 1.63 test locks; [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)
- [ ] `FE-TEST-006` **MUST** Mỗi bug UI được sửa kèm test tái hiện (đỏ trước, xanh sau) ở tầng thấp nhất có thể. → Kiểm: PR fix có file test mới/sửa; CI job "regression" chạy. · Nguồn: P12
- [ ] `FE-TEST-007` **MUST@L** Mock API (MSW) có handler cho 200/4xx/5xx/timeout, dùng chung giữa unit/component/E2E; không mock bên trong component. → Kiểm: thư mục `mocks/handlers` duy nhất; grep `vi.mock('../api` trong test component = 0 (dùng MSW).
- [ ] `FE-TEST-008` **MUST@L** Visual regression cho component dùng chung (Storybook) và 3–5 trang chính, 2 theme × 2 viewport, chạy trong container cố định; diff cần duyệt trong PR. → Kiểm: job `visual` dùng image Playwright ghim phiên bản; baseline lưu trong repo/artifact; CI fail khi diff chưa cập nhật. · Nguồn: [`../06-design-ux/motion-and-visual-quality.md`](../06-design-ux/motion-and-visual-quality.md)
- [ ] `FE-TEST-009` **MUST@L** Coverage sàn cho logic frontend (hook, util, store, schema) và theo dõi không giảm (ratchet); không đếm coverage từ snapshot/story thuần. → Kiểm: `vitest run --coverage` với `thresholds` + script ratchet (xem [`../14-testing-quality/coverage-and-mutation.md`](../14-testing-quality/coverage-and-mutation.md)).
- [ ] `FE-TEST-010` **SHOULD** Component test chạy trong trình duyệt thật (Vitest browser mode/Storybook test) cho component phụ thuộc layout/CSS/scroll/focus; jsdom chỉ cho logic render đơn giản. → Kiểm: `vitest.config` có project `browser`; component dialog/menu/virtual list nằm trong project đó.
- [ ] `FE-TEST-011` **SHOULD** E2E dùng `storageState` tái sử dụng phiên đăng nhập (setup project), không đăng nhập qua UI ở mọi test. → Kiểm: `globalSetup`/project `setup` tạo `storageState`; thời gian E2E giảm (so sánh job).
- [ ] `FE-TEST-012` **SHOULD** CI E2E: cache trình duyệt theo lockfile, `workers` cố định (vd 4), shard khi > ngưỡng thời gian, artifact trace/video chỉ khi thất bại. → Kiểm: workflow có cache `~/.cache/ms-playwright` key `hashFiles(lockfile)`; `workers: process.env.CI ? 4 : undefined`. · Nguồn: catalog 23 (Playwright CI 4 worker, cache)
- [ ] `FE-TEST-013` **SHOULD** Test trạng thái lỗi/rỗng/offline cho component dữ liệu (xem [`../06-design-ux/ui-states-and-feedback.md`](../06-design-ux/ui-states-and-feedback.md)). → Kiểm: mỗi component dữ liệu có test 4 trạng thái.
- [ ] `FE-TEST-014` **SHOULD** Test bàn phím cho component tương tác (Tab/Enter/Esc/mũi tên) và `prefers-reduced-motion`. → Kiểm: story `play` dùng `userEvent.keyboard`; E2E `emulateMedia`.
- [ ] `FE-TEST-015` **SHOULD** Snapshot DOM/HTML hạn chế (chỉ cho markup ổn định nhỏ); không snapshot cả trang. → Kiểm: số file `.snap` > N dòng bị lint chặn; review.
- [ ] `FE-TEST-016` **SHOULD** Kiểm hợp đồng API client ↔ server (schema/OpenAPI) để mock không trôi khỏi thật. → Kiểm: test MSW handler validate bằng schema dùng chung; xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md).
- [ ] `FE-TEST-017` **SHOULD** Thời gian chạy test có ngân sách: unit/component < vài phút, E2E luồng chính < 10–15 phút trên CI; vượt → shard/tối ưu, không xoá test. → Kiểm: metric thời gian job theo PR; cảnh báo khi vượt.
- [ ] `FE-TEST-018` **MAY** Mutation testing cho logic UI quan trọng (`@stryker-mutator/core` 10.0.0). → Kiểm: mutation score ≥ ngưỡng dự án cho thư mục chọn.
- [ ] `FE-TEST-019` **MAY** Smoke test production sau deploy (read-only, tài khoản test riêng), kèm quét axe trang công khai. → Kiểm: job post-deploy chạy, không ghi dữ liệu.
- [ ] `FE-TEST-020` **MAY** Dùng `aria snapshot` của Playwright để assert cấu trúc tiếp cận thay vì DOM. → Kiểm: test chính có `toMatchAriaSnapshot`.

## Bẫy thường gặp

- **`getByTestId` khắp nơi**: test không phát hiện mất nhãn/vai trò; chuyển sang `getByRole`.
- **Test component mock cả hook dữ liệu** → test chỉ kiểm việc mock; dùng MSW ở lớp mạng.
- **E2E đăng nhập qua UI ở mọi test** → chậm 5×, flaky do rate limit; `storageState`.
- **Retry che flaky mãi mãi**: retry không kèm issue/metric → bộ test mất niềm tin, rồi bị tắt.
- **Visual test trên máy dev** (font, GPU, DPI khác) → diff giả liên tục; container cố định + baseline CI.
- **Snapshot cả trang** → mọi thay đổi phải "cập nhật snapshot" mù; vô nghĩa.
- **`waitForTimeout(3000)`** thay vì chờ điều kiện → chậm và vẫn flaky; dùng `expect(locator).toBeVisible()` tự chờ.
- **Test phụ thuộc thứ tự** (test B dùng dữ liệu test A) → gãy khi shard/parallel; `--shuffle` lộ ngay.
- **Chạy E2E lên production với dữ liệu thật** → tạo rác/giao dịch thật; chỉ preview/staging.
- **jsdom cho dialog/menu/scroll** → "pass" nhưng thật không focus/trap; dùng trình duyệt thật.
- **Coverage 90% toàn snapshot** → số đẹp, không bắt lỗi; coverage chỉ cho logic + ratchet.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Vitest 5.0.4 (MIT) + `@testing-library/react` 16.3.3 (MIT) | `vitest run --coverage` | pre-push + CI | xanh; thresholds + ratchet |
| `@vitest/browser` 5.0.4 / Storybook `@storybook/addon-vitest` 10.6.2 | `vitest --project=browser` · `vitest --project=storybook` | CI | xanh; a11y addon 0 vi phạm |
| Playwright 1.64.0 (Apache-2.0) | `playwright test` (`retries: CI?2:0`, `trace: 'on-first-retry'`, `workers: 4`, projects desktop/mobile) | CI E2E (preview URL) | xanh; flaky ≤ ngưỡng |
| `@axe-core/playwright` 4.13.0 (MPL-2.0) | `AxeBuilder` sau mỗi bước | CI E2E | `violations = []` |
| Playwright `toHaveScreenshot` trong Docker `mcr.microsoft.com/playwright:v1.64.0` | `playwright test --project=visual` | CI | diff ≤ `maxDiffPixelRatio` |
| MSW 3.0.3 (MIT) | handlers dùng chung | test | mọi endpoint có handler lỗi |
| `eslint-plugin-testing-library` (phiên bản **chưa xác minh**) / lint `no-skipped-tests` có link issue | `eslint .` | CI | 0 vi phạm |
| Reporter JSON + script flaky-rate | `node scripts/flaky-rate.mjs results.json` | CI (7 ngày) | ≤ ngưỡng dự án |
| `@stryker-mutator/core` 10.0.0 (Apache-2.0) | `stryker run` thư mục chọn | nightly | ≥ ngưỡng |

## Nguồn

- Testing Library — About Queries: Priority (`getByRole` trước; `getByTestId` cuối): <https://testing-library.com/docs/queries/about/#priority> — xác minh 2026-10-13.
- Playwright — Test retries ("flaky" = fail lần đầu, pass khi retry; `retries` mặc định tắt; `--retries`; ưu tiên test độc lập): <https://playwright.dev/docs/test-retries>; Accessibility testing (`AxeBuilder`, `withTags`, `exclude`, `disableRules`; máy chỉ phát hiện một phần): <https://playwright.dev/docs/accessibility-testing>; Release notes 1.64 (WebP screenshot, `--shuffle`, `lock`, `default` project) và 1.63 (test locks, `locator.visible()`, aria snapshot trong trace): <https://playwright.dev/docs/release-notes> — xác minh 2026-10-13.
- Storybook 10.6 — Writing tests (Vitest addon chạy story trong browser mode qua Playwright; interaction `play`; a11y addon; visual test qua Chromatic — dịch vụ cloud của Storybook): <https://storybook.js.org/docs/writing-tests> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): vitest 5.0.4 · @vitest/browser 5.0.4 · @testing-library/react 16.3.3 · jsdom 30.1.2 · happy-dom 21.0.1 · storybook 10.6.2 · @storybook/addon-vitest 10.6.2 · @storybook/addon-a11y 10.6.2 · @playwright/test 1.64.0 · @axe-core/playwright 4.13.0 · msw 3.0.3 · @stryker-mutator/core 10.0.0 · @chromatic-com/storybook 5.5.1.
- Catalog `seeker19110/stored` mục 23 §2.5/§4.4 (Playwright CI `workers: 4`, cache `~/.cache/ms-playwright` theo lockfile, `retries: 2`, `trace: on-first-retry`, project desktop+mobile + axe), đọc 2026-10-13; khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 4.
