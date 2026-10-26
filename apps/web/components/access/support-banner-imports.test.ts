// D-133: biểu ngữ truy cập hỗ trợ hiện trên mọi trang nên không được kéo JS client vào bundle chung (ngân sách size-limit).
// Tách khỏi support-banner.test.tsx: đọc mã nguồn của chính component là việc của test `.ts` (như format-labels.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("SupportBanner — ngân sách bundle", () => {
  it("không là client component và không nhập form lệnh", () => {
    const src = readFileSync(join(import.meta.dirname, "support-banner.tsx"), "utf8");
    expect(src).not.toMatch(/^"use client"/m);
    expect(src).not.toMatch(/^import .*(command-form|use-command|next\/link)/m);
  });
});
