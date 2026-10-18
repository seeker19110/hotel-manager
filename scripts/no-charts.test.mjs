// Điều kiện của `[~] UX-VIZ-002 — Không áp dụng` (BLUEPRINT): ứng dụng không có biểu đồ — báo cáo V1 là bảng. Rào đỏ khi
// thêm thư viện biểu đồ vào workspace hoặc vẽ `<svg>`/`<canvas>` mới trong giao diện; khi đó phải bỏ `[~]` và làm UX-VIZ-002
// (bảng dữ liệu/mô tả thay thế, không mã hoá chỉ bằng màu, tương phản ≥ 3:1 cả hai theme).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHART_LIBS =
  /^(recharts|chart\.js|react-chartjs-2|echarts|echarts-for-react|apexcharts|react-apexcharts|plotly\.js|react-plotly\.js|highcharts|victory|uplot|d3|d3-.+|@visx\/.+|@nivo\/.+|@tremor\/.+|@mui\/x-charts|@observablehq\/plot|vega|vega-lite|react-vega)$/;
// SVG không phải biểu đồ: icon (thư viện icon nội bộ) và mã QR (ảnh máy quét).
const SVG_ALLOWED = new Set(["apps/web/components/ui/icon.tsx", "apps/web/components/portal/qr-code.tsx"]);

const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((d) => readdirSync(d).map((n) => join(d, n, "package.json"))),
].filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile());

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.(tsx|ts|jsx|js|mdx)$/.test(n) && !/\.test\./.test(n)
        ? [p]
        : [];
  });

describe("UX-VIZ-002 không áp dụng: không có biểu đồ", () => {
  it("bộ nhận diện bắt đúng tên thư viện biểu đồ", () => {
    for (const n of ["recharts", "d3", "d3-scale", "@visx/shape", "@nivo/line", "chart.js"])
      expect(n).toMatch(CHART_LIBS);
    for (const n of ["next", "react", "d3x", "qrcode"]) expect(n).not.toMatch(CHART_LIBS);
  });

  it("không package nào của workspace phụ thuộc thư viện biểu đồ", () => {
    const found = manifests.flatMap((f) => {
      const pkg = JSON.parse(readFileSync(f, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      return Object.keys(deps)
        .filter((n) => CHART_LIBS.test(n))
        .map((n) => `${f}: ${n}`);
    });
    expect(found).toEqual([]);
  });

  it("giao diện không vẽ <svg>/<canvas> ngoài icon và mã QR", () => {
    const files = ["apps/web/app", "apps/web/components", "apps/web/lib"].flatMap(walk);
    const found = files.filter((f) => !SVG_ALLOWED.has(f) && /<(svg|canvas)\b/.test(readFileSync(f, "utf8")));
    expect(found).toEqual([]);
    for (const f of SVG_ALLOWED) expect(statSync(f).isFile()).toBe(true);
  });
});
