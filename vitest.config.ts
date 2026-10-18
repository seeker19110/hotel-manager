import { defineConfig } from "vitest/config";

// Hai project: `unit` (không I/O) và `db` (Postgres 17 thật: TEST_DATABASE_URL hoặc cluster tạm — packages/testkit).
export default defineConfig({
  test: {
    // Coverage v8 cho unit + db (QA-COV-001/002): có `branches`; ngưỡng là sàn ratchet — chỉ được tăng (QA-COV-008:
    // hạ ngưỡng / thêm `exclude` để "cho xanh" cần lý do ghi trong PR; file này nằm trong `merge_risk_paths` của xt.yaml
    // nên PR đổi nó luôn do người merge). Chỉ chạy khi có `--coverage` (job `coverage` của CI).
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: [
        "packages/*/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "apps/web/src/**/*.ts",
        "apps/web/lib/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts", "packages/testkit/**", "packages/app/src/testing/**"],
      thresholds: { lines: 94.8, branches: 83.8, functions: 96.0, statements: 92.1 },
    },
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
          include: ["packages/*/src/**/*.db.test.ts", "apps/*/src/**/*.db.test.ts"],
          globalSetup: ["packages/testkit/src/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
