// Rào AUD-XFEAT-003/005: giờ hiển thị theo múi giờ CƠ SỞ và số đi qua helper chung. `dateTime(d, timeZone)` bắt buộc múi giờ
// (typecheck chặn lời gọi thiếu); rào này chặn đường vòng: tự dựng `Intl.DateTimeFormat`/`Intl.NumberFormat` ngoài lib/format.ts
// (trước đây portal có `localTime` ghim cứng Asia/Ho_Chi_Minh, trang chỉ số gọi thẳng `Intl.NumberFormat`).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "../..");
const ALLOWED = new Set(["lib/format.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory())
      return ["node_modules", ".next", "e2e", "public"].includes(e.name) ? [] : sources(join(dir, e.name));
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [];
  });
}

describe("định dạng giờ/số theo cơ sở", () => {
  it("không tự dựng Intl.DateTimeFormat / Intl.NumberFormat ngoài lib/format.ts", () => {
    const offenders = ["app", "lib", "components"]
      .flatMap((d) => sources(join(WEB, d)))
      .map((f) => relative(WEB, f))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => /new Intl\.(DateTimeFormat|NumberFormat)\(/.test(readFileSync(join(WEB, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("dateTime bắt buộc tham số múi giờ (không có giá trị mặc định ngầm)", () => {
    const src = readFileSync(join(WEB, "lib/format.ts"), "utf8");
    expect(src).toMatch(/export const dateTime = \(d: Date, timeZone: string\) =>/);
  });
});
