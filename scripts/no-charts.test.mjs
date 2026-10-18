// Điều kiện của `[~] UX-VIZ-002 — Không áp dụng` (BLUEPRINT): ứng dụng không có biểu đồ — báo cáo V1 là bảng. Rào đỏ khi
// thêm thư viện biểu đồ vào workspace hoặc vẽ `<svg>`/`<canvas>` mới trong giao diện; khi đó phải bỏ `[~]` và làm UX-VIZ-002
// (bảng dữ liệu/mô tả thay thế, không mã hoá chỉ bằng màu, tương phản ≥ 3:1 cả hai theme).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tên gói đã biết (kèm biến thể `-…`) + mẫu chung cho mọi gói có đoạn tên chart(s)/plot(s)/sparkline(s)/graph… (thư viện
// biểu đồ tự vẽ SVG/canvas bên trong nên quét `<svg>` không bắt được — tên gói là lớp chặn chính).
const CHART_LIBS = new RegExp(
  "^(?:" +
    [
      "recharts",
      "chart\\.js",
      "react-chartjs-2",
      "echarts",
      "echarts-for-react",
      "echarts-gl",
      "apexcharts",
      "react-apexcharts",
      "plotly\\.js",
      "react-plotly\\.js",
      "highcharts",
      "victory",
      "uplot",
      "d3",
      "chartist",
      "c3",
      "billboard\\.js",
      "zingchart",
      "lightweight-charts",
      "@visx\\/.+",
      "@nivo\\/.+",
      "@tremor\\/.+",
      "@mui\\/x-charts",
      "@observablehq\\/plot",
      "vega",
      "vega-lite",
      "react-vega",
      "@antv\\/.+",
      "@unovis\\/.+",
      "@amcharts\\/.+",
    ].join("|") +
    ")(?:-.+)?$" +
    "|(?:^|[@/.-])(?:charts?|chartjs|plots?|sparklines?|vchart|graphs?)(?:[/.-]|$)",
);
// SVG không phải biểu đồ: icon (thư viện icon nội bộ) và mã QR (ảnh máy quét).
const SVG_ALLOWED = new Set(["apps/web/components/ui/icon.tsx", "apps/web/components/portal/qr-code.tsx"]);

// Dạng vẽ: SVG/canvas, và biểu đồ không dùng SVG — thanh độ rộng theo dữ liệu (`style={…}`: cả app hiện không có style
// inline), `<meter>`/`<progress>`, phần tử `role="img"`.
const DRAWN = /<(?:svg|canvas|meter|progress)\b|\bstyle=\{|role=["']img/;

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
      : /\.(tsx|ts|jsx|js|mjs|cjs|mts|mdx)$/.test(n) && !/\.test\./.test(n)
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
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      };
      return Object.keys(deps)
        .filter((n) => CHART_LIBS.test(n))
        .map((n) => `${f}: ${n}`);
    });
    expect(found).toEqual([]);
  });

  it("bộ quét giao diện bắt biểu đồ SVG/canvas và biểu đồ vẽ bằng div/CSS", () => {
    for (const t of [
      "<svg viewBox>",
      "<canvas />",
      "<meter value={1} />",
      "<progress />",
      'role="img"',
      "style={{ width }}",
    ])
      expect(t).toMatch(DRAWN);
    expect('<table className="report">').not.toMatch(DRAWN);
  });

  it("giao diện không vẽ <svg>/<canvas>, thanh style/meter/progress, role=img ngoài icon và mã QR", () => {
    const files = ["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/src"].flatMap(walk);
    const found = files.filter((f) => !SVG_ALLOWED.has(f) && DRAWN.test(readFileSync(f, "utf8")));
    expect(found).toEqual([]);
    for (const f of SVG_ALLOWED) expect(statSync(f).isFile()).toBe(true);
  });
});
