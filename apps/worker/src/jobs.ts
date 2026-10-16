// Job định kỳ của worker.
import { randomUUID } from "node:crypto";
import {
  type AutoApplyResult,
  applyBankTransaction,
  dispatchNotification,
  NOTIFY_EVENT_TYPES,
} from "@hm/app";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import type { OutboxJob } from "./relay.ts";

/**
 * Nhả hold hết hạn (INV-I3) — xuyên tổ chức qua `app.expire_holds` (SKIP LOCKED, mỗi hold đúng một lần), rồi ghi
 * audit `allocation.hold_expired` (actor_type=worker) trong ngữ cảnh từng tổ chức. Trả số hold đã nhả.
 */
export async function expireHolds(workerDb: Kysely<unknown>, now: Date, limit = 1000): Promise<number> {
  const released = await sql<{ allocation_id: string; organization_id: string }>`
    select * from app.expire_holds(${now}, ${limit})`.execute(workerDb);
  for (const r of released.rows) {
    await withTenant(workerDb, { orgId: r.organization_id }, (trx) =>
      sql`insert into audit_events (id, organization_id, actor_type, action, entity_type, entity_id, correlation_id)
          values (${randomUUID()}, ${r.organization_id}, 'worker', 'allocation.hold_expired', 'allocation', ${r.allocation_id},
                  ${`job:expire_holds:${now.toISOString()}`})`.execute(trx),
    );
  }
  return released.rows.length;
}

/**
 * Handler `bank_transaction.received` (SPEC-ledger S-016): tự ghép/ghi tiền trong worker. Giao lại nhiều lần vẫn một
 * hiệu lực (khoá theo giao dịch + UNIQUE payments.bank_transaction_id); payload chỉ có id.
 */
export function bankTransactionReceivedHandler(workerDb: Kysely<unknown>) {
  return async (job: {
    organization_id: string;
    payload: Record<string, unknown>;
  }): Promise<AutoApplyResult> => {
    const id = job.payload.bank_transaction_id;
    if (typeof id !== "string") throw new Error("payload thiếu bank_transaction_id");
    return applyBankTransaction(workerDb, job.organization_id, id);
  };
}

/**
 * `notify.dispatch` (SPEC-notifications S-001…S-003): handler cho từng sự kiện outbox sinh thông báo — đăng ký với
 * `startConsumers` theo `NOTIFY_EVENT_TYPES`; dedupe ở CSDL nên pg-boss giao lại vẫn một thông báo.
 */
export function notifyHandlers(workerDb: Kysely<unknown>): Record<string, (job: OutboxJob) => Promise<void>> {
  return Object.fromEntries(
    NOTIFY_EVENT_TYPES.map((type) => [
      type,
      async (job: OutboxJob) => {
        await dispatchNotification(workerDb, job);
      },
    ]),
  );
}
