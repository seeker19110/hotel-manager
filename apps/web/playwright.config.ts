// E2E (SPEC-pwa, PLAN T-013/T-014): build production rồi e2e/server.ts (Postgres + seed giả + `next start`) —
// SW chỉ bật ở production.
// Chạy: pnpm --filter web exec playwright test <tên>   (pwa | smoke)
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Mỗi project có server + CSDL seed RIÊNG (cổng riêng, kèm bản sao +1): nhiều luồng E2E ghi dữ liệu một lần (đăng ký, nhận lời mời,
// thu tiền, OTP) nên hai project không thể dùng chung một CSDL. Tệp tạm của seed khoá theo cổng (e2e/fixtures.ts `portOf`).
const DESKTOP_PORT = PORT + 200;
const DESKTOP_URL = `http://127.0.0.1:${DESKTOP_PORT}`;
// Môi trường agent có sẵn Chromium ở /opt/pw-browsers (không chạy `playwright install`); CI/máy khác: PW_CHROMIUM_PATH
// hoặc trình duyệt do `playwright install chromium` cài.
const executablePath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

// Múi giờ/ngôn ngữ cố định cho mọi project (FE-TEST-003): kết quả không phụ thuộc máy chạy. Ngày hiển thị là giờ Việt Nam
// do ứng dụng tự tính, không lấy múi giờ của trình duyệt.
const DETERMINISTIC = { locale: "vi-VN", timezoneId: "UTC" } as const;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // QA-E2E-005 / QA-STRAT-008: CI cấm `test.only` lọt vào (forbidOnly), thử lại ≤ 2 lần, lấy trace ở lần thử lại đầu;
  // workers cố định (1: mọi spec dùng chung một server + một Postgres seed).
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...DETERMINISTIC,
    baseURL: BASE_URL,
    trace: "on-first-retry",
    launchOptions: executablePath ? { executablePath } : {},
  },
  // Hai project (FE-TEST-002, PRF-WEB-006, UX-RESP-008): luồng chính chạy trên điện thoại (Pixel 7, mobile-first) VÀ máy tính để bàn.
  // Số đo trọng lượng trang (`perf-baseline`, ngân sách `perf/budgets.json`) chỉ định nghĩa cho thiết bị di động nên không chạy ở desktop.
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], baseURL: BASE_URL } },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], baseURL: DESKTOP_URL },
      testIgnore: /perf-baseline\.spec\.ts$/,
    },
  ],
  // Máy chủ đầu tiên build; máy chủ thứ hai (Playwright khởi động lần lượt, đợi từng cái sẵn sàng) dùng lại bản build.
  webServer: [
    {
      command: "pnpm build && node e2e/server.ts",
      url: `${BASE_URL}/api/health`,
      timeout: 300_000,
      reuseExistingServer: false,
      env: { NEXT_TELEMETRY_DISABLED: "1", E2E_PORT: String(PORT) },
      // SIGTERM để e2e/server.ts kịp xoá DB/cluster tạm.
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
    {
      command: "node e2e/server.ts",
      url: `${DESKTOP_URL}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NEXT_TELEMETRY_DISABLED: "1", E2E_PORT: String(DESKTOP_PORT) },
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
  ],
});
