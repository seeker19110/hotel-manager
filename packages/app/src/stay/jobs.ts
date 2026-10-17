// Job nền của khách sạn (worker, actor_type=worker). Payload/kết quả chỉ id — không dữ liệu khách.
import { randomUUID } from "node:crypto";
import { withTenantRetry } from "@hm/db";
import { type Kysely, sql } from "kysely";

/**
 * Booking `held` mà hold đã hết hạn/nhả → `expired` đúng một lần (S-007, INV-I3): khoá hàng booking, kiểm lại trạng thái
 * dưới khoá (lệnh xác nhận chạy song song thắng thì bỏ qua), nhả allocation còn sót, ghi audit. Trả số booking đã chuyển.
 */
export async function expireHeldReservations(
  workerDb: Kysely<unknown>,
  now: Date,
  limit = 500,
): Promise<number> {
  const due = await sql<{ reservation_id: string; organization_id: string }>`
    select * from app.due_held_reservations(${now}, ${limit})`.execute(workerDb);
  let n = 0;
  for (const d of due.rows) {
    const changed = await withTenantRetry(workerDb, { orgId: d.organization_id }, async (trx) => {
      const r = await sql<{ allocation_id: string | null; property_id: string }>`
        select i.allocation_id, r.property_id from reservations r
        join reservation_items i on i.organization_id = r.organization_id and i.reservation_id = r.id
        left join allocations a on a.organization_id = i.organization_id and a.id = i.allocation_id
        where r.organization_id = ${d.organization_id} and r.id = ${d.reservation_id} and r.status = 'held'
          and (a.id is null or not a.active or a.expires_at <= ${now})
        for update of r`.execute(trx);
      const row = r.rows[0];
      if (!row) return false;
      if (row.allocation_id) {
        await sql`update allocations set active = false, deactivated_at = ${now}, deactivated_reason = 'expired'
                  where organization_id = ${d.organization_id} and id = ${row.allocation_id} and active`.execute(
          trx,
        );
      }
      await sql`update reservations set status = 'expired', version = version + 1
                where organization_id = ${d.organization_id} and id = ${d.reservation_id}`.execute(trx);
      await sql`insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, correlation_id)
                values (${randomUUID()}, ${d.organization_id}, ${row.property_id}, 'worker', 'reservation.expired', 'reservation',
                        ${d.reservation_id}, ${`job:expire_reservations:${now.toISOString()}`})`.execute(trx);
      return true;
    });
    if (changed) n += 1;
  }
  return n;
}
