// SEC-LOG-001 — bảng `docs/security/security-events.md` ↔ danh mục `SECURITY_EVENTS` trong code, hai chiều, và mỗi sự kiện có test.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_EVENTS } from "./security-events.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const doc = readFileSync(join(ROOT, "docs/security/security-events.md"), "utf8");
// Dòng của bảng "Danh mục": | `event` | khi nào | phát ở | test |
const rows = [...doc.matchAll(/^\| `([a-z_]+(?:\.[a-z_]+)+)` \|(.*)\|\s*$/gm)].map((m) => ({
  event: m[1] as string,
  rest: m[2] as string,
}));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testFiles(p);
    return /\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("security-events.md ↔ SECURITY_EVENTS", () => {
  it("mỗi sự kiện trong code có đúng một dòng trong bảng và ngược lại", () => {
    expect(rows.map((r) => r.event).sort()).toEqual([...SECURITY_EVENTS].sort());
  });

  it("mỗi sự kiện được nhắc nguyên văn trong ≥ 1 file test khác (test thật phải gõ tên sự kiện)", () => {
    const self = new URL(import.meta.url).pathname;
    const sources = testFiles(join(ROOT, "packages/app/src"))
      .filter((f) => f !== self)
      .map((f) => readFileSync(f, "utf8"));
    const missing = SECURITY_EVENTS.filter((e) => !sources.some((s) => s.includes(e)));
    expect(missing).toEqual([]);
  });
});
