// Outbox relay (INV-G6, ARCHITECTURE bước 8): hàng outbox chưa phát → job pg-boss (mỗi event_type một queue)
// → handler. Job mang organization_id (IND-SAAS-003); retry có backoff; quá giới hạn → dead letter.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";

export const DEAD_LETTER_QUEUE = "outbox.dead_letter";

export interface OutboxJob {
  organization_id: string;
  outbox_id: string;
  event_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string;
}

export interface QueuePolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = { retryLimit: 5, retryDelay: 5, retryBackoff: true };

/** pg-boss queue name: chữ thường, số, `.`/`_`/`-` — event_type đã đúng dạng `a.b`. */
export async function ensureQueues(
  boss: PgBoss,
  eventTypes: readonly string[],
  policy = DEFAULT_QUEUE_POLICY,
): Promise<void> {
  await boss.createQueue(DEAD_LETTER_QUEUE);
  for (const name of eventTypes) {
    await boss.createQueue(name, { ...policy, deadLetter: DEAD_LETTER_QUEUE });
  }
}

/**
 * Chuyển tối đa `batch` hàng chưa phát sang pg-boss qua `app.outbox_claim` (FOR UPDATE SKIP LOCKED) nên nhiều relay
 * chạy song song không phát trùng; `singletonKey = outbox.id` là lưới thứ hai. Gửi lỗi → ghi `last_error`, lần sau thử lại.
 */
export async function relayOutbox(workerDb: Kysely<unknown>, boss: PgBoss, batch = 100): Promise<number> {
  return workerDb.transaction().execute(async (trx) => {
    const rows = await sql<{
      id: string;
      organization_id: string;
      event_type: string;
      aggregate_id: string | null;
      payload: Record<string, unknown>;
      correlation_id: string;
    }>`select * from app.outbox_claim(${batch})`.execute(trx);
    for (const r of rows.rows) {
      const job: OutboxJob = {
        organization_id: r.organization_id,
        outbox_id: r.id,
        event_type: r.event_type,
        aggregate_id: r.aggregate_id,
        payload: r.payload,
        correlation_id: r.correlation_id,
      };
      let error: string | null = null;
      try {
        await boss.send(r.event_type, job, { singletonKey: r.id });
      } catch (err) {
        error = String((err as Error).message);
      }
      await sql`select app.outbox_mark(${r.id}::uuid, ${error})`.execute(trx);
    }
    return rows.rows.length;
  });
}

export type EventHandler = (job: OutboxJob) => Promise<void>;

/** Đăng ký handler cho từng event_type. Handler phải idempotent theo `outbox_id` (job có thể chạy lại khi retry). */
export async function startConsumers(
  boss: PgBoss,
  handlers: Readonly<Record<string, EventHandler>>,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  for (const [name, handler] of Object.entries(handlers)) {
    await boss.work<OutboxJob>(
      name,
      { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        for (const j of jobs) await handler(j.data);
      },
    );
  }
}
