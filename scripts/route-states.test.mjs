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
  "thanh-vien",
  "co-so",
];
// `loading.tsx` bọc trang trong Suspense ⇒ Next đã stream 200 trước khi trang chạy xong, nên `notFound()` (404), lỗi máy chủ
// (500) và `redirect()` (307) của TRANG ĐÓ và mọi route con đều thành 200 (đã đo: E2E 404 phiếu lạ/thẻ lạ đỏ khi có loading
// ở gốc). Vì vậy `loading.tsx` CHỈ đặt ở nhóm danh sách thuần — không có route con `[tham-số]` và trang không gọi notFound().
// `dat-phong/moi`, `luu-tru/moi`, `portal/{dien-nuoc,hop-dong,yeu-cau}` là trang lá, cùng tiêu chí: không route con động, không notFound()/redirect().
const LOADING_GROUPS = [
  "thu-tien",
  "su-co",
  "doi-soat",
  "thong-bao",
  "thong-bao-luu-tru",
  "dat-phong/moi",
  "luu-tru/moi",
  "thanh-vien",
  "co-so",
  "portal/dien-nuoc",
  "portal/hop-dong",
  "portal/yeu-cau",
];

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

// ---------------------------------------------------------------------------------------------------------------------
// Rào đếm màn thiếu trạng thái (PLAN đợt 6 T-506, UX-STATE-001): mọi màn dữ liệu có đủ 4 trạng thái — đang tải, rỗng, lỗi,
// mặc định — và số màn thiếu phải bằng 0. Blueprint viết cho Storybook (4 story); dự án dựng bằng Server Component nên 4 trạng
// thái là: (1) lỗi = `error.tsx` bao phủ (RouteError, không lộ chi tiết); (2) đang tải = `loading.tsx` bao phủ, TRỪ khi
// loading sẽ làm mã 404/500/307 thành 200 (D-032: trang có route con `[tham-số]`, gọi notFound()/redirect(), hoặc gốc app);
// (3) rỗng = có `EmptyState` (danh sách) hoặc `notFound()`/`redirect()` (trang chi tiết: không có bản ghi → 404, không phải
// khung trống); (4) mặc định = chính nội dung trang. Component client tự tải dữ liệu (useEffect + fetch) phải tự có
// LoadingState + ErrorState.

/** Màn "dữ liệu" = đọc dữ liệu qua `@hm/app` (kể cả khung `withActor`/`withPortal`). */
const isDataPage = (text) => /withActor|withPortal|from "@hm\/app"/.test(text);

/** Loading bị D-032 miễn: loading sẽ nuốt mã HTTP của trang/route con. */
const loadingExempt = ({ dir, text, hasDynamicChild }) =>
  dir === APP || hasDynamicChild || /\bnotFound\(|\bredirect\(/.test(text);

/** Danh sách trạng thái còn thiếu của một màn dữ liệu (rỗng = đủ). */
function missingStates({ dir, text, hasError, hasLoading, hasDynamicChild }) {
  const missing = [];
  if (!hasError) missing.push("error");
  if (!hasLoading && !loadingExempt({ dir, text, hasDynamicChild })) missing.push("loading");
  if (!/\bEmptyState\b|\bnotFound\(|\bredirect\(/.test(text)) missing.push("empty");
  return missing;
}

const hasDynamicDescendant = (dir) =>
  readdirSync(dir).some((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() && (n.startsWith("[") || hasDynamicDescendant(p));
  });

function dataPageReport() {
  return pages(APP)
    .map((dir) => ({ dir, text: readFileSync(join(dir, "page.tsx"), "utf8") }))
    .filter((p) => isDataPage(p.text))
    .map((p) => ({
      page: p.dir.slice(APP.length + 1) || "(gốc)",
      missing: missingStates({
        ...p,
        hasError: covered(p.dir, "error.tsx"),
        hasLoading: covered(p.dir, "loading.tsx"),
        hasDynamicChild: hasDynamicDescendant(p.dir),
      }),
    }));
}

function clientFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) clientFiles(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("đủ 4 trạng thái cho mọi màn dữ liệu (UX-STATE-001): số màn thiếu = 0", () => {
  it("bộ đếm bắt đúng: màn thiếu error/loading/empty được báo; màn bị D-032 miễn loading thì không", () => {
    const ok = {
      dir: `${APP}/x`,
      text: "<EmptyState/>",
      hasError: true,
      hasLoading: true,
      hasDynamicChild: false,
    };
    expect(missingStates(ok)).toEqual([]);
    expect(missingStates({ ...ok, hasError: false })).toEqual(["error"]);
    expect(missingStates({ ...ok, hasLoading: false })).toEqual(["loading"]);
    expect(missingStates({ ...ok, text: "<p>danh sách</p>" })).toEqual(["empty"]);
    expect(missingStates({ ...ok, hasError: false, hasLoading: false, text: "" })).toEqual([
      "error",
      "loading",
      "empty",
    ]);
    // D-032: có route con động / notFound() / redirect() / gốc ⇒ không đòi loading
    expect(missingStates({ ...ok, hasLoading: false, hasDynamicChild: true })).toEqual([]);
    expect(missingStates({ ...ok, hasLoading: false, text: "notFound()" })).toEqual([]);
    expect(missingStates({ ...ok, hasLoading: false, text: "<EmptyState/> redirect('/x')" })).toEqual([]);
    expect(missingStates({ ...ok, hasLoading: false, dir: APP })).toEqual([]);
    // chữ "EmptyStateless" không phải EmptyState
    expect(missingStates({ ...ok, text: "EmptyStateless" })).toEqual(["empty"]);
  });

  it("quét thật: có ≥ 25 màn dữ liệu và không màn nào thiếu trạng thái", () => {
    const report = dataPageReport();
    expect(report.length).toBeGreaterThanOrEqual(25);
    const missing = report
      .filter((r) => r.missing.length > 0)
      .map((r) => `${r.page}: thiếu ${r.missing.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("trang không phải màn dữ liệu chỉ là form đăng nhập/offline/huỷ đăng ký/liên kết khách/lời mời (tự tải phía client)", () => {
    const nonData = pages(APP)
      .filter((d) => !isDataPage(readFileSync(join(d, "page.tsx"), "utf8")))
      .map((d) => d.slice(APP.length + 1))
      .sort();
    expect(nonData).toEqual([
      "bao-mat",
      "dang-ky",
      "dang-nhap",
      "dang-nhap/nguoi-thue",
      "huy-dang-ky",
      "khach/luot-o/[id]",
      "loi-moi",
      "offline",
    ]);
  });

  it("component client tự tải dữ liệu khi mở (useEffect + timedFetch) có LoadingState và ErrorState", () => {
    const selfFetching = [...clientFiles(APP), ...clientFiles("apps/web/components")].filter((p) => {
      const t = readFileSync(p, "utf8");
      return /useEffect/.test(t) && /timedFetch\(/.test(t);
    });
    expect(selfFetching.length).toBeGreaterThanOrEqual(1);
    for (const p of selfFetching) {
      const t = readFileSync(p, "utf8");
      expect(t, p).toMatch(/\bLoadingState\b/);
      expect(t, p).toMatch(/\bErrorState\b/);
    }
  });
});
