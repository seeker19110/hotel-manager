// Job hợp đồng chạy trong worker (role app_worker): nhắc hết hạn không gửi lặp (SPEC-lease S-014) và phát hiện ở quá hạn
// chưa bàn giao trả (S-015, INV-I4 — không tự kết thúc allocation, mở ngoại lệ cho quản lý). Đọc xuyên tổ chức qua hàm
// SECURITY DEFINER phạm vi hẹp; ghi trong ngữ cảnh từng tổ chức; chạy lại bao nhiêu lần cũng một hiệu lực.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

export const DEFAULT_REMINDER_DAYS = [30, 7, 0] as const;

/** Nhắc hết hạn: một outbox `lease.expiring` mỗi (hợp đồng, phiên bản, mốc ngày) nhờ `dedupe_key`. Trả số bản ghi mới. */
export async function remindExpiring(
  workerDb: Kysely<unknown>,
  now: Date,
  days: readonly number[] = DEFAULT_REMINDER_DAYS,
): Promise<number> {
  const due = await sql<{
    organization_id: string;
    property_id: string;
    lease_id: string;
    version_no: number;
    effective_to: string;
    days_left: number;
  }>`select organization_id, property_id, lease_id, version_no, effective_to::text, days_left
     from app.leases_expiring(${now}, ${[...days]}::int[])`.execute(workerDb);
  let created = 0;
  for (const r of due.rows) {
    const key = `lease.expiring:${r.lease_id}:${r.version_no}:${r.days_left}`;
    const ins = await withTenant(workerDb, { orgId: r.organization_id }, (trx) =>
      sql<{ id: string }>`
        insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                            dedupe_key)
        values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'lease.expiring', 'lease', ${r.lease_id},
                ${JSON.stringify({ lease_id: r.lease_id, version_no: r.version_no, days_left: r.days_left, effective_to: r.effective_to })}::jsonb,
                ${`job:lease.remindExpiring:${now.toISOString()}`}, ${key})
        on conflict do nothing`.execute(trx),
    );
    created += Number(ins.numAffectedRows ?? 0);
  }
  return created;
}

/** Quá hạn chưa bàn giao trả: ngoại lệ `LEASE_OVERSTAY` (một cái đang mở mỗi allocation), ghi rõ allocation bị đụng. */
export async function detectOverstay(workerDb: Kysely<unknown>, now: Date): Promise<number> {
  const rows = await sql<{
    organization_id: string;
    property_id: string;
    lease_id: string;
    allocation_id: string;
    related_allocation_id: string | null;
  }>`select * from app.leases_overstaying(${now})`.execute(workerDb);
  let opened = 0;
  for (const r of rows.rows) {
    await withTenant(workerDb, { orgId: r.organization_id }, async (trx) => {
      const id = randomUUID();
      const ins = await sql<{ id: string }>`
        insert into exceptions (id, organization_id, property_id, type, allocation_id, related_allocation_id)
        values (${id}, ${r.organization_id}, ${r.property_id}, 'LEASE_OVERSTAY', ${r.allocation_id}, ${r.related_allocation_id})
        on conflict do nothing returning id`.execute(trx);
      if (!ins.rows[0]) return;
      opened++;
      const correlation = `job:lease.detectOverstay:${now.toISOString()}`;
      await sql`
        insert into audit_events (id, organization_id, property_id, actor_type, action, entity_type, entity_id, after, correlation_id)
        values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'worker', 'exception.opened', 'exception', ${id},
                ${JSON.stringify({ type: "LEASE_OVERSTAY", lease_id: r.lease_id, related_allocation_id: r.related_allocation_id })}::jsonb,
                ${correlation})`.execute(trx);
      await sql`
        insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                            dedupe_key)
        values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'exception.opened', 'exception', ${id},
                ${JSON.stringify({ exception_id: id, type: "LEASE_OVERSTAY", lease_id: r.lease_id })}::jsonb, ${correlation},
                ${`exception.opened:${id}`})`.execute(trx);
    });
  }
  return opened;
}
