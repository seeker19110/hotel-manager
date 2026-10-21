// Rào: mọi trang nhân viên đi qua khung chung `withActor` (lib/page.tsx) — đăng nhập, chọn tổ chức, MFA, người thuê → portal
// VÀ thanh điều hướng. `/phong` (trang đầu sau khi chọn tổ chức) từng tự gọi `currentActor` nên mất thanh điều hướng: người
// dùng kẹt ở đó, chỉ thoát được bằng thanh địa chỉ.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "../../app");

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pages(join(dir, e.name)) : e.name === "page.tsx" ? [join(dir, e.name)] : [],
  );
}

describe("khung trang nhân viên", () => {
  it("trang tự gọi currentActor phải dùng withActor (có thanh điều hướng)", () => {
    const offenders = pages(APP)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /\bcurrentActor\b/.test(src) && !/\bwithActor\b/.test(src);
      })
      .map((f) => relative(APP, f));
    expect(offenders).toEqual([]);
  });
});
