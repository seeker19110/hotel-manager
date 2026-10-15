import { defineConfig } from "vitest/config";

// Hai project: `unit` (không I/O, chạy mọi nơi) và `db` (cần Postgres 17 — T-005 dựng runner).
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
          passWithNoTests: true,
        },
      },
    ],
  },
});
