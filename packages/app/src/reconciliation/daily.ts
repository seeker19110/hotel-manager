// Đối soát hằng ngày (PLAN đợt 5 T-406; IND-FIN-006). Chạy trong worker (vai trò app_worker), mỗi ngày:
//  1. Chênh lệch đối soát (`reconciliation_breaks`) còn MỞ quá hạn xử lý (SLA) → audit `reconciliation.break_overdue` (worker) trong
//     ngữ cảnh tổ chức của break — kế toán/owner thấy ở nhật ký; mỗi (break, ngày) đúng một dòng dù job chạy lại nhiều lần.
//  2. Số dư sổ cái dẫn xuất = Σ posting: tổ chức mà Σ nợ ≠ Σ có (trôi) → audit `ledger.drift_detected` + log lỗi. Trigger đã chặn
//     bút toán mất cân bằng nên bình thường rỗng; đây là lưới thứ hai.
// Số liệu `hm_reconciliation_breaks_open` do /api/metrics đọc trực tiếp (`app.reconciliation_metrics`), không phụ thuộc job này;
// rule cảnh báo ticket ở deploy/prometheus/alerts.yml. Đọc xuyên tổ chức qua hàm SECURITY DEFINER phạm vi hẹp (migration 0050).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

/** SLA xử lý một chênh lệch đối soát: 48 giờ kể từ lúc mở (đề xuất — chủ dự án chỉnh được khi có dữ liệu vận hành). */
export const RECONCILIATION_BREAK_SLA_HOURS = 48;
/** Trần số break xử lý mỗi lượt (phần còn lại lượt sau) — job không giữ worker quá lâu. */
const BREAK_BATCH = 1000;

export interface ReconciliationDailyResult {
  /** Break quá SLA đang mở (tất cả, kể cả đã có dòng audit hôm nay). */
  overdue: number;
  /** Số dòng audit `reconciliation.break_overdue` MỚI ghi lượt này. */
  flagged: number;
  /** Số tổ chức có sổ cái trôi. */
  ledgerDriftOrgs: number;
}

export interface ReconciliationDailyOptions {
  slaHours?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Ngày UTC `YYYY-MM-DD` — khoá "mỗi ngày một lần". */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export async function runReconciliationDaily(
  workerDb: Kysely<unknown>,
  now: Date,
  opts: ReconciliationDailyOptions = {},
): Promise<ReconciliationDailyResult> {
  const sla = opts.slaHours ?? RECONCILIATION_BREAK_SLA_HOURS;
  const correlation = `job:reconciliation.daily:${dayKey(now)}`;
  const log = opts.log ?? (() => {});

  const overdue = await sql<{
    organization_id: string;
    property_id: string;
    break_id: string;
    assignee: string;
    reason: string;
    age_hours: number;
  }>`select * from app.reconciliation_breaks_overdue(${now}, ${sla}, ${BREAK_BATCH})`.execute(workerDb);
  let flagged = 0;
  for (const b of overdue.rows) {
    const ins = await withTenant(workerDb, { orgId: b.organization_id }, (trx) =>
      sql`
        insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, correlation_id)
        select ${randomUUID()}, ${b.organization_id}, ${b.property_id}, 'worker', 'reconciliation.break_overdue',
               'reconciliation_break', ${b.break_id},
               ${JSON.stringify({ reason: b.reason, age_hours: b.age_hours, sla_hours: sla, assignee: b.assignee })}::jsonb,
               ${correlation}
        where not exists (
          select 1 from audit_events where organization_id = ${b.organization_id} and action = 'reconciliation.break_overdue'
            and entity_id = ${b.break_id} and correlation_id = ${correlation})`.execute(trx),
    );
    flagged += Number(ins.numAffectedRows ?? 0);
  }

  const drift = await sql<{ organization_id: string; debit_total: string; credit_total: string }>`
    select organization_id, debit_total::text, credit_total::text from app.ledger_drift()`.execute(workerDb);
  for (const d of drift.rows) {
    // Số tiền là số nguyên đồng (bigint → chuỗi để không mất chính xác).
    log("reconciliation.ledger_drift", {
      organization_id: d.organization_id,
      debit_total: d.debit_total,
      credit_total: d.credit_total,
    });
    await withTenant(workerDb, { orgId: d.organization_id }, (trx) =>
      sql`
        insert into audit_events (id, organization_id, actor_type, action, entity_type, after, correlation_id)
        select ${randomUUID()}, ${d.organization_id}, 'worker', 'ledger.drift_detected', 'ledger',
               ${JSON.stringify({ debit_total: d.debit_total, credit_total: d.credit_total })}::jsonb, ${correlation}
        where not exists (
          select 1 from audit_events where organization_id = ${d.organization_id} and action = 'ledger.drift_detected'
            and correlation_id = ${correlation})`.execute(trx),
    );
  }
  return { overdue: overdue.rows.length, flagged, ledgerDriftOrgs: drift.rows.length };
}
