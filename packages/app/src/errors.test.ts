// Danh mục mã lỗi khớp hợp đồng và khớp mã nguồn (API-CONTRACT §2).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sharedContractCodes(): Map<string, number> {
  const text = readFileSync(join(ROOT, "docs/design/API-CONTRACT.md"), "utf8");
  const section = text.slice(text.indexOf("## 2."), text.indexOf("## 3."));
  const out = new Map<string, number>();
  for (const m of section.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm)) out.set(m[1] as string, Number(m[2]));
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("ERROR_CODES ↔ API-CONTRACT §2", () => {
  const shared = sharedContractCodes();
  it("đọc được bảng mã dùng chung", () => {
    expect(shared.size).toBeGreaterThanOrEqual(20);
  });
  it.each([...shared])("%s → %i", (code, status) => {
    expect(ERROR_CODES[code as keyof typeof ERROR_CODES]?.status).toBe(status);
  });
});

describe("ERROR_CODES ↔ mã nguồn", () => {
  const used = new Map<string, Set<number>>();
  for (const dir of ["packages/app/src", "apps/web/app", "apps/web/lib", "apps/worker/src"]) {
    for (const f of sourceFiles(join(ROOT, dir))) {
      for (const m of readFileSync(f, "utf8").matchAll(/CommandError\(\s*"([A-Z_]+)",\s*(\d{3})/g)) {
        const set = used.get(m[1] as string) ?? new Set<number>();
        set.add(Number(m[2]));
        used.set(m[1] as string, set);
      }
    }
  }
  it("tìm thấy mã trong nguồn", () => {
    expect(used.size).toBeGreaterThan(5);
  });
  it.each([...used])("%s có trong danh mục với đúng status", (code, statuses) => {
    const spec = ERROR_CODES[code as keyof typeof ERROR_CODES];
    expect(spec, `thiếu ${code} trong errors.ts`).toBeDefined();
    expect([...statuses]).toEqual([spec?.status]);
  });
});
