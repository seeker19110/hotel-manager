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

/**
 * event_type được khai TƯỜNG MINH là "chỉ để audit" (D-026, sửa theo review lát 7): hiện chưa có consumer và không cần có —
 * dữ liệu nguồn nằm ở bảng nghiệp vụ + `audit_events`. Relay đánh dấu đã phát mà không sinh job. Một event_type KHÔNG có
 * consumer và KHÔNG nằm ở đây thì KHÔNG bị đánh dấu đã phát (ghi `last_error = 'no_consumer'`, lùi lần thử, log
 * `outbox.no_consumer`) để worker có consumer (hoặc bản triển khai sau) vẫn nhận được và cảnh báo `hm_outbox_*` thấy.
 * Thêm event_type mới vào outbox ⇒ thêm consumer HOẶC thêm vào đây (có test chặn quên: `outbox-event-types.test.ts`).
 */
export const AUDIT_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "allocation.held",
  "approval.requested",
  "exception.opened",
  "housekeeping.task_created",
  "housekeeping.task_done",
  "housekeeping.task_verified",
  "lease.activated",
  "lease.closed",
  "lease.created",
  "lease.expiring",
  "lease.renewed",
  "lease.settled",
  "lease.signed",
  "member.mfa_reset",
  "payment.confirmed",
  "payment_claim.submitted",
  "period.locked",
  "period.unlocked",
  "reconciliation.break_opened",
  "reservation.cancelled",
  "reservation.confirmed",
  "reservation.held",
  "reservation.no_show",
  "stay.checked_in",
  "stay.checked_out",
  "stay.notice_exported",
  "stay.notice_submitted",
  "work_order.created",
]);

export const NO_CONSUMER_ERROR = "no_consumer";

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
 * chạy song song không phát trùng; `singletonKey = outbox.id` là lưới thứ hai. Gửi lỗi → ghi `last_error` + lùi lần thử
 * (`available_at`, backoff trong `app.outbox_mark`), lần sau thử lại.
 * `opts.consumed`: tập event_type có consumer ở worker này. Loại khác: nằm trong `opts.auditOnly` (mặc định
 * `AUDIT_ONLY_EVENT_TYPES`) ⇒ đánh dấu đã phát không sinh job; không nằm trong đó ⇒ KHÔNG đánh dấu đã phát, ghi
 * `no_consumer`, log `outbox.no_consumer`, lùi lần thử (không kẹt đầu hàng; worker khác có consumer vẫn nhận được).
 */
export async function relayOutbox(
  workerDb: Kysely<unknown>,
  boss: PgBoss,
  batch = 100,
  opts: {
    consumed?: ReadonlySet<string>;
    auditOnly?: ReadonlySet<string>;
    log?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<number> {
  const auditOnly = opts.auditOnly ?? AUDIT_ONLY_EVENT_TYPES;
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
      if (opts.consumed && !opts.consumed.has(r.event_type)) {
        if (auditOnly.has(r.event_type)) {
          await sql`select app.outbox_mark(${r.id}::uuid, ${null})`.execute(trx);
        } else {
          opts.log?.("outbox.no_consumer", { event_type: r.event_type, outbox_id: r.id });
          await sql`select app.outbox_mark(${r.id}::uuid, ${NO_CONSUMER_ERROR})`.execute(trx);
        }
        continue;
      }
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
