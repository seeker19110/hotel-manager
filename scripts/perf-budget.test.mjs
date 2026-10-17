// T-704: cổng ngân sách hiệu năng (XC-PERF-003) — hàm kiểm thuần `apps/web/e2e/perf-budget.ts` dùng chung với spec E2E.
// "Test cổng": dữ liệu đo thêm 200 KB JS phải ĐỎ; trong ngân sách phải XANH; spec E2E dùng lại module (không tự so sánh).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkBudgets, checkPageBudget, parseBudgets } from "../apps/web/e2e/perf-budget.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const budgets = parseBudgets(JSON.parse(read("perf/budgets.json")));
const baseline = JSON.parse(read("docs/perf/baseline-web-2026-10-17.json"));

const small = parseBudgets({ pages: { "/x": { max_transfer_kb: 200, max_requests: 12 } } });
const stat = (over = {}) => ({ route: "/x", requests: 10, transfer_kb: 150, js_kb: 120, ...over });

describe("checkPageBudget", () => {
  it("trong ngân sách → xanh", () => {
    expect(checkPageBudget(stat(), small)).toEqual([]);
  });
  it("đúng bằng ngân sách vẫn xanh (≤); hơn 1 đơn vị thì đỏ", () => {
    expect(checkPageBudget(stat({ transfer_kb: 200, requests: 12 }), small)).toEqual([]);
    expect(checkPageBudget(stat({ transfer_kb: 200.1 }), small).map((v) => v.metric)).toEqual([
      "transfer_kb",
    ]);
    expect(checkPageBudget(stat({ requests: 13 }), small).map((v) => v.metric)).toEqual(["requests"]);
  });
  it("thêm 200 KB JS vào trang đang trong ngân sách → đỏ, nêu route, số đo và ngưỡng", () => {
    const base = stat();
    const bloated = { ...base, transfer_kb: base.transfer_kb + 200, js_kb: base.js_kb + 200 };
    const v = checkPageBudget(bloated, small);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ route: "/x", metric: "transfer_kb", actual: 350, limit: 200 });
    expect(v[0].message).toContain("350 KB");
  });
  it("vượt cả hai → hai vi phạm", () => {
    expect(checkPageBudget(stat({ transfer_kb: 999, requests: 99 }), small)).toHaveLength(2);
  });
  it("trang không có ngân sách → đỏ (không bỏ qua)", () => {
    expect(checkPageBudget(stat({ route: "/lạ" }), small)).toMatchObject([
      { metric: "missing_budget", route: "/lạ" },
    ]);
  });
  it.each([
    ["NaN KB", { transfer_kb: Number.NaN }],
    ["KB âm", { transfer_kb: -1 }],
    ["Infinity KB", { transfer_kb: Number.POSITIVE_INFINITY }],
    ["0 request (phép đo hỏng)", { requests: 0 }],
    ["request NaN", { requests: Number.NaN }],
  ])("số đo không hợp lệ (%s) → đỏ", (_name, over) => {
    expect(checkPageBudget(stat(over), small).map((v) => v.metric)).toContain("invalid_measure");
  });
  it("0 KB truyền tải là số đo hợp lệ nhưng 0 request thì không", () => {
    expect(checkPageBudget(stat({ transfer_kb: 0 }), small)).toEqual([]);
  });
});

describe("checkBudgets", () => {
  it("không có số đo → ném lỗi (không xanh giả)", () => {
    expect(() => checkBudgets([], small)).toThrow(/không có số đo/);
  });
  it("gộp vi phạm của nhiều trang", () => {
    const two = parseBudgets({
      pages: {
        "/a": { max_transfer_kb: 10, max_requests: 5 },
        "/b": { max_transfer_kb: 10, max_requests: 5 },
      },
    });
    const v = checkBudgets(
      [
        { route: "/a", requests: 1, transfer_kb: 5, js_kb: 1 },
        { route: "/b", requests: 1, transfer_kb: 11, js_kb: 1 },
      ],
      two,
    );
    expect(v.map((x) => x.route)).toEqual(["/b"]);
  });
});

describe("parseBudgets", () => {
  it.each([
    ["null", null],
    ["thiếu pages", {}],
    ["pages là mảng", { pages: [] }],
    ["ngân sách 0", { pages: { "/a": { max_transfer_kb: 0, max_requests: 5 } } }],
    ["ngân sách số thực", { pages: { "/a": { max_transfer_kb: 1.5, max_requests: 5 } } }],
    ["thiếu max_requests", { pages: { "/a": { max_transfer_kb: 10 } } }],
    ["chuỗi", { pages: { "/a": { max_transfer_kb: "10", max_requests: 5 } } }],
  ])("%s → ném lỗi", (_n, raw) => {
    expect(() => parseBudgets(raw)).toThrow(/perf\/budgets\.json/);
  });
});

describe("ngân sách và baseline thật của repo", () => {
  it("mọi trang trong baseline đã đo đều xanh với perf/budgets.json", () => {
    expect(baseline.pages.length).toBeGreaterThanOrEqual(3);
    expect(checkBudgets(baseline.pages, budgets)).toEqual([]);
  });
  it("thêm 200 KB JS vào MỌI trang baseline → mọi trang đều đỏ (cổng có tác dụng ở từng route)", () => {
    const bloated = baseline.pages.map((p) => ({
      ...p,
      transfer_kb: p.transfer_kb + 200,
      js_kb: p.js_kb + 200,
    }));
    const red = checkBudgets(bloated, budgets).map((v) => v.route);
    expect([...new Set(red)].sort()).toEqual(baseline.pages.map((p) => p.route).sort());
  });
});

describe("spec E2E dùng lại module", () => {
  const spec = read("apps/web/e2e/perf-baseline.spec.ts");
  it("import checkPageBudget/parseBudgets từ ./perf-budget.ts và không tự so sánh với ngân sách", () => {
    expect(spec).toMatch(/from "\.\/perf-budget\.ts"/);
    expect(spec).toMatch(/checkPageBudget\(/);
    expect(spec).toMatch(/parseBudgets\(/);
    expect(spec).not.toMatch(/max_transfer_kb|max_requests/);
    expect(spec).not.toMatch(/budgets\.pages\[/);
  });
});
