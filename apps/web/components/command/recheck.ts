// Lịch hỏi lại kết quả lệnh đang xử lý (SPEC-pwa S-012) — thuần, test được không cần trình duyệt.

/** Tổng thời gian tối đa hỏi lại kết quả lệnh đang xử lý (SPEC-pwa S-012, Q-01). */
export const RECHECK_BUDGET_MS = 30_000;
/** Chờ trước lần hỏi đầu tiên sau 1 s, gấp đôi mỗi lần, lần cuối cắt cho vừa tổng 30 s: 1, 2, 4, 8, 15 ⇒ hỏi ở 0, 1, 3, 7, 15, 30 s. */
export function recheckSchedule(budgetMs: number = RECHECK_BUDGET_MS, firstMs = 1_000): number[] {
  const out: number[] = [];
  let used = 0;
  for (let d = firstMs; used < budgetMs; d *= 2) {
    const wait = Math.min(d, budgetMs - used);
    out.push(wait);
    used += wait;
  }
  return out;
}
