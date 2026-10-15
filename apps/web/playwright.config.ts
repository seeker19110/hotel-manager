// E2E (SPEC-pwa, PLAN T-013/T-014): build production rồi e2e/server.ts (Postgres + seed giả + `next start`) —
// SW chỉ bật ở production.
// Chạy: pnpm --filter web exec playwright test <tên>   (pwa | smoke)
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Môi trường agent có sẵn Chromium ở /opt/pw-browsers (không chạy `playwright install`); CI/máy khác: PW_CHROMIUM_PATH
// hoặc trình duyệt do `playwright install chromium` cài.
const executablePath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium-mobile", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "pnpm build && node e2e/server.ts",
    url: `${BASE_URL}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1", E2E_PORT: String(PORT) },
    // SIGTERM để e2e/server.ts kịp xoá DB/cluster tạm.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
