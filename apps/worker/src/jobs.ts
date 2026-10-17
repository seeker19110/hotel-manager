// Job định kỳ của worker.
import { randomUUID } from "node:crypto";
import {
  type AutoApplyResult,
  applyBankTransaction,
  buildInvitationMail,
  createLogger,
  dispatchNotification,
  type EmailSender,
  type ExportJobDeps,
  expireExports,
  type Logger,
  NOTIFY_EVENT_TYPES,
  runExportJob,
} from "@hm/app";
import { withTenantRetry } from "@hm/db";
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
    await withTenantRetry(workerDb, { orgId: r.organization_id }, (trx) =>
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
export function notifyHandlers(
  workerDb: Kysely<unknown>,
  logger: Logger = createLogger({ bindings: { component: "notify.dispatch" } }),
): Record<string, (job: OutboxJob) => Promise<void>> {
  return Object.fromEntries(
    NOTIFY_EVENT_TYPES.map((type) => [
      type,
      async (job: OutboxJob) => {
        await dispatchNotification(workerDb, job, new Date(), (event, fields) => logger.warn(event, fields));
      },
    ]),
  );
}

/**
 * `exports.run` (SPEC-audit-reporting S-015, S-017, S-018): handler cho sự kiện outbox `export.requested` — worker dựng lại
 * quyền của người yêu cầu lúc chạy; giao lại không chạy lần hai (job không còn `queued`).
 */
export function exportHandlers(deps: ExportJobDeps): Record<string, (job: OutboxJob) => Promise<void>> {
  return {
    "export.requested": async (job: OutboxJob) => {
      await runExportJob(deps, job);
    },
  };
}

/** Job định kỳ (T-225 lập lịch): bản xuất quá hạn tải ⇒ `expired`. */
export function expireExportsJob(workerDb: Kysely<unknown>): () => Promise<number> {
  return () => expireExports(workerDb);
}

/** Nhịp worker (T-225): ghi `worker_heartbeats` — metric `hm_worker_heartbeat_age_seconds` cảnh báo worker treo/chết. */
export async function workerHeartbeat(
  workerDb: Kysely<unknown>,
  name: string,
  now: Date = new Date(),
): Promise<void> {
  await sql`select app.worker_heartbeat(${name}, ${now})`.execute(workerDb);
}

/** event_type outbox mà consumer lời mời nhân viên xử lý. */
export const INVITATION_EVENT_TYPES = ["member.invited"] as const;

/**
 * `member.invited` (SPEC-access S-007): gửi email lời mời nhân viên. Token dựng lại từ khoá + id lời mời (không lưu ở đâu);
 * lời mời đã dùng/thu hồi/quá hạn thì bỏ qua. Khoá idempotency của email = id lời mời ⇒ pg-boss giao lại không gửi hai thư.
 * Lỗi tạm thời ném lại để pg-boss thử lại theo chính sách queue; địa chỉ không hợp lệ (vĩnh viễn) chỉ ghi log.
 */
export function invitationHandlers(
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  opts: { key: Buffer; baseUrl: string },
  logger: Logger = createLogger({ bindings: { component: "member.invitation" } }),
): Record<string, (job: OutboxJob) => Promise<void>> {
  return {
    "member.invited": async (job: OutboxJob) => {
      const mail = await buildInvitationMail(workerDb, job, opts);
      if (!mail) {
        logger.info("invitation.mail_skipped", { outbox_id: job.outbox_id, reason: "not_pending" });
        return;
      }
      try {
        await sender.send(mail);
      } catch (err) {
        if ((err as { kind?: string }).kind === "permanent") {
          logger.warn("invitation.mail_rejected", { outbox_id: job.outbox_id, reason: "RECIPIENT_INVALID" });
          return;
        }
        throw err;
      }
    },
  };
}
