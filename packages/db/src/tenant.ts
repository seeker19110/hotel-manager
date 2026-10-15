import { type Kysely, sql, type Transaction } from "kysely";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chạy `fn` trong một transaction với ngữ cảnh tổ chức (`SET LOCAL app.org_id`) — RLS lớp 1 (INV-G1).
 * `orgId` phải lấy từ membership đã xác minh ở server, không từ client.
 */
export async function withTenant<DB, T>(
  db: Kysely<DB>,
  ctx: { orgId: string; actorId?: string },
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.orgId)) throw new Error("orgId không phải UUID");
  if (ctx.actorId !== undefined && !UUID.test(ctx.actorId)) throw new Error("actorId không phải UUID");
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${ctx.orgId}, true)`.execute(trx);
    if (ctx.actorId) await sql`select set_config('app.actor_id', ${ctx.actorId}, true)`.execute(trx);
    return fn(trx);
  });
}
