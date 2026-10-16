// Job quét nhắc hạn chạy trong worker (role app_worker) — SPEC-notifications S-007, S-008, S-013, S-020.
// - `scanOverdue` (`reminder.scanOverdue`): phiếu còn nợ đã tới mốc nhắc quá hạn → outbox `invoice.overdue`. Đọc xuyên tổ chức
//   bằng hàm SECURITY DEFINER `app.invoices_overdue` (đã loại mốc có sự kiện); ghi trong ngữ cảnh từng tổ chức với `dedupe_key`
//   `invoice.overdue:{phiếu}:{mốc}` nên chạy lại/chạy song song không phát trùng. Phiếu đã tất toán không bao giờ được chọn;
//   consumer (`dispatch.ts`) và lúc gửi email (`SETTLED`) kiểm lại số dư — ba lớp (S-008).
// - Nhắc hết hạn hợp đồng (`reminder.scanLeaseExpiry`) = `remindExpiring` ở `lease/jobs.ts` (một đường duy nhất, S-013).
// - `scanStayNoticeConfig`: cảnh báo cơ sở có khách đang ở mà chưa cấu hình hạn thông báo lưu trú (S-020), mỗi cơ sở mỗi ngày
//   kinh doanh tối đa một sự kiện. Phần nhắc hạn/quá hạn (S-014…S-016, S-021) đọc `residence_notices` nên thuộc T-207.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

const BATCH = 500;
const MAX_BATCHES = 20;

export interface ScanResult {
  /** Số sự kiện outbox mới phát lượt này (chạy lại ⇒ 0). */
  created: number;
}

/** `reminder.scanOverdue`: phát `invoice.overdue { invoice_id, business_date, milestone, days_overdue }` cho phiếu tới mốc. */
export async function scanOverdue(workerDb: Kysely<unknown>, now: Date): Promise<ScanResult> {
  let created = 0;
  // Mỗi vòng chỉ nhận các phiếu CHƯA có sự kiện (hàm SQL loại trừ) nên tập kết quả co dần; trần vòng chặn vòng lặp vô hạn.
  for (let i = 0; i < MAX_BATCHES; i++) {
    const due = await sql<{
      organization_id: string;
      property_id: string;
      invoice_id: string;
      days_overdue: number;
      milestone: number;
      business_date: string;
    }>`select organization_id, property_id, invoice_id, days_overdue, milestone, business_date::text
       from app.invoices_overdue(${now}, ${BATCH})`.execute(workerDb);
    let batchNew = 0;
    for (const r of due.rows) {
      const ins = await withTenant(workerDb, { orgId: r.organization_id }, (trx) =>
        sql`insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                                dedupe_key)
            values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'invoice.overdue', 'invoice', ${r.invoice_id},
                    ${JSON.stringify({
                      invoice_id: r.invoice_id,
                      business_date: r.business_date,
                      milestone: r.milestone,
                      days_overdue: r.days_overdue,
                    })}::jsonb,
                    ${`job:reminder.scanOverdue:${now.toISOString()}`}, ${`invoice.overdue:${r.invoice_id}:${r.milestone}`})
            on conflict do nothing`.execute(trx),
      );
      batchNew += Number(ins.numAffectedRows ?? 0);
    }
    created += batchNew;
    // Hết dữ liệu, hoặc cả lô đều đã có người khác phát (song song) ⇒ dừng.
    if (due.rows.length < BATCH || batchNew === 0) break;
  }
  return { created };
}

/** S-020: một sự kiện `stay_notice.unconfigured { property_id, business_date }` mỗi cơ sở mỗi ngày kinh doanh. */
export async function scanStayNoticeConfig(workerDb: Kysely<unknown>, now: Date): Promise<ScanResult> {
  const rows = await sql<{
    organization_id: string;
    property_id: string;
    business_date: string;
    in_house: number;
  }>`
    select organization_id, property_id, business_date::text, in_house from app.stay_notice_unconfigured(${now})`.execute(
    workerDb,
  );
  let created = 0;
  for (const r of rows.rows) {
    const ins = await withTenant(workerDb, { orgId: r.organization_id }, (trx) =>
      sql`insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                              dedupe_key)
          values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'stay_notice.unconfigured', 'property', ${r.property_id},
                  ${JSON.stringify({ property_id: r.property_id, business_date: r.business_date })}::jsonb,
                  ${`job:reminder.scanStayNoticeConfig:${now.toISOString()}`},
                  ${`stay_notice.unconfigured:${r.property_id}:${r.business_date}`})
          on conflict do nothing`.execute(trx),
    );
    created += Number(ins.numAffectedRows ?? 0);
  }
  return { created };
}
