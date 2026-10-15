// Job định kỳ của worker.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";

/**
 * Nhả hold hết hạn (INV-I3) — xuyên tổ chức qua `app.expire_holds` (SKIP LOCKED, mỗi hold đúng một lần), rồi ghi
 * audit `allocation.expired` (actor_type=worker) trong ngữ cảnh từng tổ chức. Trả số hold đã nhả.
 */
export async function expireHolds(workerDb: Kysely<unknown>, now: Date, limit = 1000): Promise<number> {
  const released = await sql<{ allocation_id: string; organization_id: string }>`
    select * from app.expire_holds(${now}, ${limit})`.execute(workerDb);
  for (const r of released.rows) {
    await withTenant(workerDb, { orgId: r.organization_id }, (trx) =>
      sql`insert into audit_events (id, organization_id, actor_type, action, entity_type, entity_id, correlation_id)
          values (${randomUUID()}, ${r.organization_id}, 'worker', 'allocation.expired', 'allocation', ${r.allocation_id},
                  ${`job:expire_holds:${now.toISOString()}`})`.execute(trx),
    );
  }
  return released.rows.length;
}
