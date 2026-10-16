// Review lát 7 🟡6 — chỗ DUY NHẤT đọc `X-Forwarded-For` là `forwardedClientIp` (security-events.ts): lấy hop PHẢI NHẤT. Ai đọc
// header này ở nơi khác (hop đầu = client tự khai, giả được) sẽ làm test này đỏ.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) return [];
    return e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)];
  });
}

describe("X-Forwarded-For chỉ được đọc qua forwardedClientIp", () => {
  it("không mã sản phẩm nào khác truy cập header x-forwarded-for", () => {
    const offenders = ["apps", "packages"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.(ts|tsx|mjs)$/.test(f))
      .filter((f) => !f.endsWith("packages/app/src/logging/security-events.ts"))
      .filter((f) => /x-forwarded-for/i.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
