// FE-BUILD-005: env có schema tách client/server/build; sai kiểu → build fail; không đọc `process.env` ngoài module cấu hình.
// Đọc env chỉ ở packages/app/src/config/* (runtime/edge/build/client/worker — đều qua schema zod). Ngoài đó là danh sách cho phép
// có lý do (cấu hình công cụ dev/test, CLI truyền nguyên env vào schema riêng). Không ai dùng `process.env.X!`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Tệp ngoài module cấu hình được đọc env — kèm lý do. */
const ALLOWED: Record<string, string> = {
  "apps/web/playwright.config.ts":
    "cấu hình Playwright (cổng, trình duyệt, CI) — công cụ test, không vào bundle",
  "apps/web/scripts/dev-stack.ts": "script dựng môi trường dev cục bộ (cổng Postgres/web, đường dẫn weed)",
  "packages/db/src/migration-cli.ts":
    "CLI truyền nguyên env vào loadMigrationConfig (schema riêng ở migration-config.ts)",
  "packages/testkit/src/global-setup.ts": "testkit: dựng DB test",
  "packages/testkit/src/pg-cluster.ts": "testkit: cụm Postgres tạm cho test",
  "packages/testkit/src/s3-server.ts": "testkit: S3 giả cho test",
};

const sources = (): string[] =>
  spawnSync("git", ["ls-files", "apps", "packages"], { cwd: ROOT, encoding: "utf8" })
    .stdout.split("\n")
    .filter((f) => /\.(ts|tsx|mjs|js|cjs)$/.test(f))
    .filter((f) => !/\.test\.|\/e2e\/|(^|\/)node_modules\//.test(f));

describe("FE-BUILD-005 — ranh giới env", () => {
  it("không đọc process.env ngoài packages/app/src/config/* và danh sách cho phép; không `process.env.X!`", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const outside: string[] = [];
    const bang: string[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      if (/process\.env\.[A-Za-z_][A-Za-z0-9_]*!/.test(text)) bang.push(f);
      if (!/\bprocess\.env\b/.test(text)) continue;
      if (f.startsWith("packages/app/src/config/")) continue;
      if (Object.hasOwn(ALLOWED, f)) seen.add(f);
      else outside.push(f);
    }
    expect(outside, "đọc env qua schema ở packages/app/src/config/* hoặc thêm ALLOWED kèm lý do").toEqual([]);
    expect(bang).toEqual([]);
    expect(
      Object.keys(ALLOWED).filter((f) => !seen.has(f)),
      "ngoại lệ mồ côi",
    ).toEqual([]);
  });

  it("nạp next.config với env build sai kiểu → exit ≠ 0 và nêu tên biến; hợp lệ/không đặt → exit 0", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["next.config.ts"], {
        cwd: join(ROOT, "apps/web"),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
        timeout: 60_000,
      });
    const bad = run({ HM_BUILD_ID: "" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("HM_BUILD_ID");
    expect(run({ HM_BUILD_ID: "x".repeat(201) }).status).not.toBe(0);
    expect(run({ HM_BUILD_ID: "release-1" }).status).toBe(0);
    expect(run({}).status).toBe(0);
  });
});
