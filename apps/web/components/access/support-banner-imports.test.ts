// D-133: biểu ngữ truy cập hỗ trợ hiện trên mọi trang nên không được kéo JS client vào bundle chung (ngân sách size-limit).
// Tách khỏi support-banner.test.tsx: đọc mã nguồn của chính component là việc của test `.ts` (như format-labels.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Mọi nguồn import (kể cả import nhiều dòng, `export … from`, `import("…")`) — T-2624 (AUD-TEST-003). */
function importSources(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g))
    out.push((m[1] ?? m[2]) as string);
  return out;
}

const isClientDirective = (src: string) =>
  /^\s*(["'])use client\1/.test(src.replace(/^(\s*\/\/[^\n]*\n)*/, ""));
const FORBIDDEN = /(command-form|use-command|next\/link)/;

describe("SupportBanner — ngân sách bundle", () => {
  it("không là client component và không nhập form lệnh", () => {
    const src = readFileSync(join(import.meta.dirname, "support-banner.tsx"), "utf8");
    expect(isClientDirective(src)).toBe(false);
    expect(importSources(src).filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });

  it("bộ dò bắt import nhiều dòng, nháy đơn, `use client` nháy đơn sau chú thích (không chỉ dòng đầu)", () => {
    const multi = 'import {\n  CommandForm,\n} from "../command/command-form.tsx";\n';
    expect(importSources(multi).filter((s) => FORBIDDEN.test(s))).toEqual(["../command/command-form.tsx"]);
    expect(importSources("import Link from 'next/link';").filter((s) => FORBIDDEN.test(s))).toEqual([
      "next/link",
    ]);
    expect(importSources('const m = await import("../command/use-command.ts");')).toEqual([
      "../command/use-command.ts",
    ]);
    expect(isClientDirective("// chú thích\n'use client';\nexport {}")).toBe(true);
    expect(isClientDirective('"use client";')).toBe(true);
    expect(isClientDirective("export const x = 'use client';")).toBe(false);
  });
});
