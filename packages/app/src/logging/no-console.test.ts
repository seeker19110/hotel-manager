// BASE-ERR-006 / SEC-SECRET-007 — mã sản phẩm không dùng console.* (đi qua logger để che bí mật/PII, có correlation_id).
// Ngoại lệ có lý do: script build (apps/web/scripts), hạ tầng test (packages/testkit), file test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const SCAN = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "test-results", "playwright-report"]);
const ALLOW = [/^apps\/web\/scripts\//, /^packages\/testkit\//, /^apps\/web\/e2e\//];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name) ? [p] : [];
  });
}

describe("logging — không console.* ở mã sản phẩm", () => {
  it("không file nguồn sản phẩm nào gọi console.log/info/warn/error/debug", () => {
    const hits: string[] = [];
    for (const top of SCAN)
      for (const file of sources(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (ALLOW.some((re) => re.test(rel))) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
              hits.push(`${rel}:${i + 1}`);
          });
      }
    expect(hits).toEqual([]);
  });
});
