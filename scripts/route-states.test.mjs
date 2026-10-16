// Rào trạng thái cấp route (PLAN đợt 5 T-411, UX-STATE-001/005): các nhóm route chính có `error.tsx` (mọi page.tsx được bao phủ)
// và `loading.tsx` (nhóm danh sách thuần — xem lý do bên dưới), dựng trên `components/ui/state.tsx`; trang lỗi không bao giờ in
// `error.message` (có thể chứa SQL/đường dẫn).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = "apps/web/app";
// Mọi nhóm này có error.tsx. `error.tsx` giữ nguyên mã HTTP 500 của lỗi máy chủ (đã kiểm bằng probe: trang ném lỗi → 500).
const ERROR_GROUPS = [
  "",
  "portal",
  "hop-dong",
  "ky-thu",
  "thu-tien",
  "dat-phong",
  "luu-tru",
  "buong-phong",
  "su-co",
  "doi-soat",
  "phong",
  "thong-bao",
  "thong-bao-luu-tru",
  "lich-phong",
];
// `loading.tsx` bọc trang trong Suspense ⇒ Next đã stream 200 trước khi trang chạy xong, nên `notFound()` (404), lỗi máy chủ
// (500) và `redirect()` (307) của TRANG ĐÓ và mọi route con đều thành 200 (đã đo: E2E 404 phiếu lạ/thẻ lạ đỏ khi có loading
// ở gốc). Vì vậy `loading.tsx` CHỈ đặt ở nhóm danh sách thuần — không có route con `[tham-số]` và trang không gọi notFound().
const LOADING_GROUPS = ["thu-tien", "su-co", "doi-soat", "thong-bao", "thong-bao-luu-tru"];

function pages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pages(p, out);
    else if (name === "page.tsx") out.push(dir);
  }
  return out;
}
const covered = (dir, file) => {
  for (let d = dir; d.startsWith(APP); d = dirname(d)) if (existsSync(join(d, file))) return true;
  return false;
};

describe("loading/error theo route", () => {
  it.each(ERROR_GROUPS)("nhóm %j có error.tsx dùng RouteError (client component)", (g) => {
    const error = readFileSync(join(APP, g, "error.tsx"), "utf8");
    expect(error.split("\n")[0]).toBe('"use client";');
    expect(error).toMatch(/RouteError/);
  });

  it.each(LOADING_GROUPS)("nhóm %j có loading.tsx dùng RouteLoading", (g) => {
    expect(readFileSync(join(APP, g, "loading.tsx"), "utf8")).toMatch(/RouteLoading/);
  });

  it("mọi page.tsx có error.tsx bao phủ", () => {
    const ps = pages(APP);
    expect(ps.length).toBeGreaterThan(20);
    expect(ps.filter((d) => !covered(d, "error.tsx"))).toEqual([]);
  });

  it("loading.tsx không đặt ở nhóm có route con động hoặc trang gọi notFound()/redirect() (giữ nguyên mã 404/307)", () => {
    const loadings = [];
    const walkDirs = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (!statSync(p).isDirectory()) {
          if (name === "loading.tsx") loadings.push(dir);
          continue;
        }
        walkDirs(p);
      }
    };
    walkDirs(APP);
    expect(loadings.map((d) => d.slice(APP.length + 1)).sort()).toEqual([...LOADING_GROUPS].sort());
    for (const dir of loadings) {
      const subdirs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
      expect(
        subdirs.filter((n) => n.startsWith("[")),
        dir,
      ).toEqual([]);
      expect(readFileSync(join(dir, "page.tsx"), "utf8"), dir).not.toMatch(/\bnotFound\(/);
    }
  });

  it("route-state dựng trên state.tsx; lỗi chỉ hiện câu chung + mã tra cứu, không in error.message/stack", () => {
    const src = readFileSync("apps/web/components/ui/route-state.tsx", "utf8");
    expect(src).toMatch(/from "\.\/state\.tsx"/);
    expect(src).toMatch(/ErrorState/);
    expect(src).toMatch(/LoadingState/);
    expect(src).toMatch(/Thử lại/);
    const code = src
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/error\.message|error\.stack|\.stack\b/);
  });
});
