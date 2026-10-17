// Ngân sách email theo ngày/tổ chức — circuit breaker chi phí (OPS-COST-004; PLAN đợt 8 T-709). Mọi đường gọi nhà cung cấp email
// (`sendDueEmails` — vòng gửi thông báo, và consumer `member.invited` của worker) PHẢI xin ngân sách TRƯỚC khi gọi `EmailSender.send`
// (rào: notification-budget.db.test.ts quét mã nguồn tìm đường gửi chưa qua đây).
// - Ngưỡng ở hằng trong mã (`@hm/domain`, notifications/email-budget.ts; đổi qua PR có review), không ở biến môi trường: ≥ 80% cảnh báo (log + metric, một lần/ngày/tổ chức) · ≥ 90% bóp
//   (chỉ loại bắt buộc/giao dịch — `REQUIRED_TYPES`, lời mời nhân viên — còn lại hoãn) · 100% dừng hẳn (hoãn mọi loại).
// - Hoãn KHÔNG mất: lần gửi quay lại `retrying` (không tính một lần thử) hẹn đầu ngày UTC kế tiếp; lời mời (pg-boss) ném
//   `EmailBudgetDeferredError` để job thử lại/vào dead letter (redrive sau khi sang ngày — RUNBOOK §3.12).
// - Ngày UTC (không phải ngày kinh doanh): ngân sách là chi phí hệ thống, nhà cung cấp tính hạn mức theo ngày UTC; tổ chức nhiều
//   cơ sở khác múi giờ, `business_date` thuộc cơ sở. Đếm nằm ở CSDL (`app.email_budget_take`, migration 0063): khoá hàng theo (tổ chức,
//   ngày) ⇒ nhiều worker không bao giờ cùng vượt ngân sách.
import {
  EMAIL_BUDGET_THROTTLE_PCT,
  EMAIL_BUDGET_WARN_PCT,
  EMAIL_DAILY_BUDGET_PER_ORG,
  MS_PER_DAY,
} from "@hm/domain";
import { type Kysely, sql } from "kysely";

// Giữ đường import cũ của các hằng ngưỡng.
export { EMAIL_BUDGET_THROTTLE_PCT, EMAIL_BUDGET_WARN_PCT, EMAIL_DAILY_BUDGET_PER_ORG };

export type EmailBudgetDecision = "send" | "throttled" | "stopped";
/** Mức cảnh báo cao nhất đã chạm trong ngày: 0 chưa · 1 ≥ cảnh báo · 2 ≥ bóp · 3 hết ngân sách. */
export type EmailBudgetLevel = 0 | 1 | 2 | 3;

export interface EmailBudgetResult {
  decision: EmailBudgetDecision;
  /** Số lượt đã cấp trong ngày (sau lượt này nếu `send`). */
  used: number;
  level: EmailBudgetLevel;
  /** Lượt này đưa `level` lên mức mới ⇒ ghi cảnh báo (đúng một lần mỗi mức mỗi ngày). */
  crossed: boolean;
}

export type BudgetLog = (event: string, fields: Record<string, unknown>) => void;

/** Lượt gửi bị hoãn vì ngân sách ngày đã hết (ném từ consumer pg-boss để job được thử lại, không mất). */
export class EmailBudgetDeferredError extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super("ngân sách email ngày của tổ chức đã hết — hoãn tới đầu ngày UTC kế tiếp");
    this.name = "EmailBudgetDeferredError";
    this.retryAt = retryAt;
  }
}

/** Đầu ngày UTC kế tiếp của `now` — mốc ngân sách mới. */
export function nextBudgetDayStart(now: Date): Date {
  return new Date((Math.floor(now.getTime() / MS_PER_DAY) + 1) * MS_PER_DAY);
}

/**
 * Xin một lượt gọi nhà cung cấp cho tổ chức. `required` = loại bắt buộc/giao dịch (còn được gửi ở mức bóp). Nguyên tử theo
 * (tổ chức, ngày UTC của `now`); lỗi CSDL ném lên (đóng an toàn: không gửi khi không đếm được).
 */
export async function takeEmailBudget(
  workerDb: Kysely<unknown>,
  q: { orgId: string; required: boolean; now: Date; budget?: number },
): Promise<EmailBudgetResult> {
  const r = await sql<{ decision: EmailBudgetDecision; used: number; level: number; crossed: boolean }>`
    select decision, used, level, crossed from app.email_budget_take(${q.orgId}, ${q.now}, ${q.budget ?? EMAIL_DAILY_BUDGET_PER_ORG},
      ${EMAIL_BUDGET_WARN_PCT}, ${EMAIL_BUDGET_THROTTLE_PCT}, ${q.required})`.execute(workerDb);
  const row = r.rows[0];
  if (!row) throw new Error("app.email_budget_take không trả hàng");
  return {
    decision: row.decision,
    used: row.used,
    level: row.level as EmailBudgetLevel,
    crossed: row.crossed,
  };
}

const LEVEL_EVENT: Record<1 | 2 | 3, string> = {
  1: "notification.email_budget_warn",
  2: "notification.email_budget_throttle",
  3: "notification.email_budget_exhausted",
};

/**
 * Ghi cảnh báo/sự kiện của một quyết định (không có PII: chỉ id tổ chức và số đếm). `metric` trỏ metric `/api/metrics` tương ứng
 * (`hm_email_budget_used_ratio`, `hm_email_budget_throttled_total`, `hm_email_budget_stopped_total`).
 */
export function logEmailBudget(
  log: BudgetLog,
  orgId: string,
  r: EmailBudgetResult,
  budget: number = EMAIL_DAILY_BUDGET_PER_ORG,
): void {
  const base = { org_id: orgId, used: r.used, budget, ratio: r.used / budget };
  if (r.decision === "send") {
    if (r.crossed && r.level > 0)
      log(LEVEL_EVENT[r.level as 1 | 2 | 3], { ...base, metric: "hm_email_budget_used_ratio" });
    return;
  }
  log(
    r.decision === "throttled"
      ? "notification.email_budget_deferred_throttled"
      : "notification.email_budget_deferred_stopped",
    {
      ...base,
      metric:
        r.decision === "throttled" ? "hm_email_budget_throttled_total" : "hm_email_budget_stopped_total",
    },
  );
}
