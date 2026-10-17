// Rào nhãn nút xác nhận (PLAN đợt 5 T-411, UX-STATE-008): mọi `confirm=` ở trang đều đi kèm `confirmLabel=` (động từ + đối tượng),
// hộp xác nhận không còn nhãn chung "Đồng ý", và E2E không gọi `confirmAction` mà thiếu nhãn mong đợi.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next" || n === "test-results") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const WEB = "apps/web";

describe("nhãn nút xác nhận", () => {
  it("mỗi trang dùng confirm= đều có confirmLabel= tương ứng (đúng số lượng)", () => {
    const bad = [];
    for (const f of walk(join(WEB, "app"))) {
      const src = readFileSync(f, "utf8");
      const a = (src.match(/\bconfirm=/g) ?? []).length;
      const b = (src.match(/\bconfirmLabel=/g) ?? []).length;
      if (a !== b) bad.push(`${f}: confirm=${a} confirmLabel=${b}`);
    }
    expect(bad).toEqual([]);
  });

  it("hộp xác nhận không có nút chung 'Đồng ý'; nút = nhãn đã điền; E2E luôn truyền nhãn", () => {
    const form = readFileSync(join(WEB, "components/command/command-form.tsx"), "utf8");
    expect(form).not.toMatch(/Đồng ý/);
    expect(form).toMatch(/onClick=\{onConfirm\}>\{asking\}/);
    const calls = walk(join(WEB, "e2e"))
      .filter((f) => f.endsWith(".spec.ts"))
      .flatMap((f) => (readFileSync(f, "utf8").match(/confirmAction\(page\)/g) ?? []).map(() => f));
    expect(calls).toEqual([]);
  });
});
