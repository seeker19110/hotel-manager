// TM-10: bundle phía client không được chứa tên/giá trị biến bí mật.
// Cổng `gate` chạy build trước test nên `.next/static` có sẵn; chạy riêng mà chưa build thì test được bỏ qua có ghi lý do.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_KEYS } from "./schema.ts";

const STATIC_DIR = new URL("../../../../apps/web/.next/static", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe.skipIf(!existsSync(STATIC_DIR))("bundle client (TM-10) — cần `pnpm build` trước", () => {
  it("không file tĩnh nào nhắc tên biến bí mật", () => {
    const leaks: string[] = [];
    for (const f of files(STATIC_DIR).filter((p) => /\.(js|css|html|json)$/.test(p))) {
      const text = readFileSync(f, "utf8");
      for (const key of SECRET_KEYS) if (text.includes(key)) leaks.push(`${f}: ${key}`);
    }
    expect(leaks).toEqual([]);
  });
});
