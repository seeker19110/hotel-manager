// S-020 — làm tròn tiền chỉ qua `packages/domain/src/money` (một hàm). Test kiến trúc: không có `Math.round`/`toFixed` trong
// mã nguồn (trừ module money) của packages/* và apps/*.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter(
      (f) => !f.includes("node_modules") && !f.includes(`${join("src", "money")}`) && !f.includes(".next"),
    );
}

describe("S-020 làm tròn qua một hàm duy nhất", () => {
  it("không có Math.round/toFixed ngoài packages/domain/src/money", () => {
    const roots = [
      "packages/domain/src",
      "packages/app/src",
      "packages/db/src",
      "apps/web/app",
      "apps/web/components",
      "apps/web/lib",
      "apps/worker/src",
    ];
    const offenders: string[] = [];
    for (const r of roots) {
      let list: string[] = [];
      try {
        list = files(join(ROOT, r));
      } catch {
        continue;
      }
      for (const f of list) {
        const text = readFileSync(f, "utf8");
        if (/Math\.round\(|\.toFixed\(/.test(text)) offenders.push(f.slice(ROOT.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
