import { defineConfig } from "vitest/config";

// Môi trường tất định cho MỌI project (FE-TEST-003): múi giờ UTC và ngôn ngữ cố định — kết quả không đổi theo máy/CI.
// Đặt cả trên tiến trình chính (worker `fork` thừa hưởng) lẫn `test.env` của từng project.
const DETERMINISTIC_ENV = { TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } as const;
Object.assign(process.env, DETERMINISTIC_ENV);

// Hai project: `unit` (không I/O) và `db` (Postgres 17 thật: TEST_DATABASE_URL hoặc cluster tạm — packages/testkit).
// `unit` gồm cả test component React (`*.test.tsx`, Testing Library + happy-dom — mỗi tệp tự chọn môi trường bằng
// `// @vitest-environment happy-dom`); mạng và `next/navigation` được giả trong từng test (FE-TEST-001/003).
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
        // tsconfig của apps/web để `jsx: preserve` cho Next; test cần JSX đã biên dịch (runtime tự động của React 19).
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "unit",
          env: DETERMINISTIC_ENV,
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "apps/*/components/**/*.test.tsx",
            "apps/*/components/**/*.test.ts",
            "scripts/**/*.test.mjs",
          ],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "db",
          env: DETERMINISTIC_ENV,
          include: ["packages/*/src/**/*.db.test.ts", "apps/*/src/**/*.db.test.ts"],
          globalSetup: ["packages/testkit/src/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
