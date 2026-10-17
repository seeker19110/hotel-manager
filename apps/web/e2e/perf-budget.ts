// Kiểm NGÂN SÁCH hiệu năng trang (XC-PERF-003; PLAN đợt 8 T-704) — hàm THUẦN, không I/O, dùng chung cho
// `perf-baseline.spec.ts` (E2E, số đo thật) và unit test `scripts/perf-budget.test.mjs` (dữ liệu giả: thêm 200 KB phải đỏ).
// Nguồn ngân sách: `perf/budgets.json` (cấu hình máy đọc, sống trong repo).

export interface Budget {
  max_transfer_kb: number;
  max_requests: number;
}

export interface Budgets {
  pages: Record<string, Budget>;
}

/** Số đo một trang (KB truyền tải gồm header, số request đã hoàn tất). */
export interface PageStat {
  route: string;
  requests: number;
  transfer_kb: number;
  js_kb: number;
}

export interface BudgetViolation {
  route: string;
  metric: "transfer_kb" | "requests" | "missing_budget" | "invalid_measure";
  actual: number | null;
  limit: number | null;
  message: string;
}

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** Kiểm cấu trúc `perf/budgets.json` đã parse: mọi ngân sách là số nguyên dương. Sai → ném lỗi (không đoán). */
export function parseBudgets(raw: unknown): Budgets {
  const pages = (raw as { pages?: unknown } | null)?.pages;
  if (typeof pages !== "object" || pages === null || Array.isArray(pages))
    throw new Error("perf/budgets.json: thiếu khối `pages`");
  const out: Record<string, Budget> = {};
  for (const [route, b] of Object.entries(pages)) {
    const { max_transfer_kb, max_requests } = (b ?? {}) as Partial<Budget>;
    if (!isPositiveInt(max_transfer_kb) || !isPositiveInt(max_requests))
      throw new Error(
        `perf/budgets.json: ngân sách ${route} phải là số nguyên dương (max_transfer_kb, max_requests)`,
      );
    out[route] = { max_transfer_kb, max_requests };
  }
  return { pages: out };
}

/**
 * Số đo `stat` so với ngân sách của trang: danh sách vi phạm (rỗng = đạt). Bằng đúng ngân sách vẫn đạt (≤).
 * Thiếu ngân sách cho trang, hoặc số đo không hợp lệ (NaN, âm, 0 request = phép đo hỏng) → vi phạm, không bỏ qua.
 */
export function checkPageBudget(stat: PageStat, budgets: Budgets): BudgetViolation[] {
  const { route } = stat;
  const budget = budgets.pages[route];
  if (!budget)
    return [
      {
        route,
        metric: "missing_budget",
        actual: null,
        limit: null,
        message: `thiếu ngân sách cho ${route} trong perf/budgets.json`,
      },
    ];
  const out: BudgetViolation[] = [];
  const invalid = (metric: "transfer_kb" | "requests", value: number, min: number) => {
    if (Number.isFinite(value) && value >= min) return false;
    out.push({
      route,
      metric: "invalid_measure",
      actual: Number.isFinite(value) ? value : null,
      limit: null,
      message: `${route}: số đo ${metric} không hợp lệ (${value})`,
    });
    return true;
  };
  if (!invalid("transfer_kb", stat.transfer_kb, 0) && stat.transfer_kb > budget.max_transfer_kb)
    out.push({
      route,
      metric: "transfer_kb",
      actual: stat.transfer_kb,
      limit: budget.max_transfer_kb,
      message: `${route}: ${stat.transfer_kb} KB truyền tải vượt ngân sách ${budget.max_transfer_kb} KB`,
    });
  if (!invalid("requests", stat.requests, 1) && stat.requests > budget.max_requests)
    out.push({
      route,
      metric: "requests",
      actual: stat.requests,
      limit: budget.max_requests,
      message: `${route}: ${stat.requests} request vượt ngân sách ${budget.max_requests}`,
    });
  return out;
}

/** Như `checkPageBudget` cho nhiều trang; danh sách rỗng → ném lỗi (không có số đo thì không được xanh). */
export function checkBudgets(stats: PageStat[], budgets: Budgets): BudgetViolation[] {
  if (stats.length === 0) throw new Error("không có số đo trang nào để kiểm ngân sách");
  return stats.flatMap((s) => checkPageBudget(s, budgets));
}
