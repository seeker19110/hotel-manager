// Rào chống lặp lỗi đường lệnh sai: `useCommand` là NƠI DUY NHẤT thêm tiền tố `/api/v1/` (use-command.ts), nên mọi `path=` của
// `CommandForm` và đối số literal của `useCommand(...)` phải là `module/command` — không `/` đầu, không `api/`. Đường sai (vd
// "/api/v1/exports/x") gọi `/api/v1//api/v1/…` ⇒ 308, và còn lặng lẽ bỏ lưới kiểm schema phía client (`checkCommandInput` tra theo tên).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, USER_COMMANDS } from "@hm/app";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Mọi đường literal truyền cho CommandForm / useCommand trong apps/web (động `path={x}` bị bỏ qua). */
function literalPaths(): { file: string; path: string }[] {
  const out: { file: string; path: string }[] = [];
  for (const dir of ["app", "components"])
    for (const file of sources(join(WEB, dir))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<CommandForm\b[^>]*?\bpath=\{?["']([^"']+)["']/g))
        out.push({ file, path: m[1] as string });
      for (const m of src.matchAll(/\buseCommand(?:<[^>(]*>)?\(\s*["']([^"']+)["']/g))
        out.push({ file, path: m[1] as string });
    }
  return out;
}

describe("đường lệnh của CommandForm/useCommand", () => {
  const found = literalPaths();

  it("quét thấy các đường literal (rào không rỗng)", () => {
    expect(found.length).toBeGreaterThan(20);
  });

  it("không bắt đầu bằng `/` hay `api/` (tiền tố do useCommand thêm)", () => {
    const bad = found.filter((f) => /^(\/|api\/)/.test(f.path));
    expect(bad).toEqual([]);
  });

  it("là `module/command` có trong danh mục lệnh (`COMMANDS`/`USER_COMMANDS` của `@hm/app`)", () => {
    const known = (name: string) => Object.hasOwn(COMMANDS, name) || Object.hasOwn(USER_COMMANDS, name);
    const bad = found.filter((f) => !known(f.path.replace("/", ".")));
    expect(bad).toEqual([]);
  });
});
