import { defineConfig } from "vitest/config";

// Hai project: `unit` (không I/O) và `db` (Postgres 17 thật: TEST_DATABASE_URL hoặc cluster tạm — packages/testkit).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "db",
          include: ["packages/*/src/**/*.db.test.ts"],
          globalSetup: ["packages/testkit/src/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
