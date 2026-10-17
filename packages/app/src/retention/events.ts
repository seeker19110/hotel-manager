// Job dọn bảng sự kiện theo chính sách hạn giữ (PLAN đợt 6 T-505; XC-GREEN-007, ARC-RES-009). Worker gọi định kỳ (apps/worker).
// Xoá qua hàm SECURITY DEFINER của migration 0056 (app_worker không có DELETE trực tiếp): theo LÔ, lặp tới khi hết hoặc hết
// `PURGE_MAX_ROUNDS` lô. Mỗi bảng độc lập: một bảng lỗi không chặn các bảng khác (lỗi gom lại ném sau cùng).
// `audit_events` KHÔNG nằm ở đây: bảng append-only (INV-G4), không xoá ở pilot (SPEC-audit-reporting Q-09).
import { daysToMs } from "@hm/domain";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  DELIVERY_DONE_RETENTION_DAYS,
  DELIVERY_FAILED_RETENTION_DAYS,
  IDEMPOTENCY_GRACE_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
} from "./policy.ts";

export interface EventPurgeStats {
  outbox: number;
  idempotencyKeys: number;
  notificationDeliveries: number;
}

export interface EventPurgeOptions {
  now?: Date;
  batch?: number;
  maxRounds?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Gọi `step` (trả số hàng đã xoá) lặp tới khi lô không đầy hoặc hết số lô. */
async function drain(step: () => Promise<number>, batch: number, maxRounds: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const n = await step();
    total += n;
    if (n < batch) break;
  }
  return total;
}

export async function purgeEventTables(
  workerDb: Kysely<unknown>,
  opts: EventPurgeOptions = {},
): Promise<EventPurgeStats> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? PURGE_BATCH;
  const maxRounds = opts.maxRounds ?? PURGE_MAX_ROUNDS;
  const log = opts.log ?? (() => {});
  const count = async (q: Promise<{ rows: { n: number }[] }>) => q.then((r) => r.rows[0]?.n ?? 0);
  const stats: EventPurgeStats = { outbox: 0, idempotencyKeys: 0, notificationDeliveries: 0 };
  const errors: unknown[] = [];
  const run = async (table: keyof EventPurgeStats, step: () => Promise<number>) => {
    try {
      stats[table] = await drain(step, batch, maxRounds);
    } catch (err) {
      errors.push(err);
      log("retention.events_purge_failed", { table, error: (err as Error).name });
    }
  };
  await run("outbox", () =>
    count(
      sql<{ n: number }>`
        select app.purge_outbox(${now}, ${OUTBOX_PUBLISHED_RETENTION_DAYS}, ${batch}) as n`.execute(workerDb),
    ),
  );
  await run("idempotencyKeys", () =>
    count(
      sql<{ n: number }>`
        select app.purge_idempotency_keys(${new Date(now.getTime() - daysToMs(IDEMPOTENCY_GRACE_DAYS))}, ${batch}) as n`.execute(
        workerDb,
      ),
    ),
  );
  await run("notificationDeliveries", () =>
    count(
      sql<{ n: number }>`
        select app.purge_notification_deliveries(${now}, ${DELIVERY_DONE_RETENTION_DAYS}, ${DELIVERY_FAILED_RETENTION_DAYS}, ${batch}) as n`.execute(
        workerDb,
      ),
    ),
  );
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length}/3 bảng dọn lỗi`);
  return stats;
}
