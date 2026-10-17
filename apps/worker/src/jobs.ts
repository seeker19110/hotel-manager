// Job định kỳ của worker.
import { createHash, randomUUID } from "node:crypto";
import {
  type AutoApplyResult,
  applyBankTransaction,
  buildInvitationMail,
  createLogger,
  dispatchNotification,
  EMAIL_DAILY_BUDGET_PER_ORG,
  EmailBudgetDeferredError,
  type EmailSender,
  type ExportJobDeps,
  expireExports,
  type Logger,
  logEmailBudget,
  NOTIFY_EVENT_TYPES,
  nextBudgetDayStart,
  runExportJob,
  takeEmailBudget,
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

/**
 * Id job xếp lại khi hoãn vì ngân sách: UUID dẫn xuất (SHA-256, dạng v8) từ `outbox_id` + mốc hẹn — cùng đầu vào cho cùng id nên
 * handler chạy lại (hoàn tất job gốc lỗi giữa chừng) gửi lại là no-op ở pg-boss; khác mốc (hoãn thêm ngày nữa) cho id khác.
 */
export function deferredJobId(outboxId: string, retryAt: Date): string {
  const h = createHash("sha256").update(`budget-defer:${outboxId}:${retryAt.toISOString()}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** event_type outbox mà consumer lời mời nhân viên xử lý. */
export const INVITATION_EVENT_TYPES = ["member.invited"] as const;

/**
 * `member.invited` (SPEC-access S-007): gửi email lời mời nhân viên. Token dựng lại từ khoá + id lời mời (không lưu ở đâu);
 * lời mời đã dùng/thu hồi/quá hạn thì bỏ qua. Khoá idempotency của email = id lời mời ⇒ pg-boss giao lại không gửi hai thư.
 * Lỗi tạm thời ném lại để pg-boss thử lại theo chính sách queue; địa chỉ không hợp lệ (vĩnh viễn) chỉ ghi log.
 * Ngân sách email ngày/tổ chức (OPS-COST-004): lời mời là loại giao dịch (còn được gửi ở mức bóp 90%); hết ngân sách (100%) ⇒ KHÔNG
 * gọi nhà cung cấp, xếp lại CHÍNH job này (`opts.requeue`, pg-boss `startAfter` = đầu ngày UTC kế tiếp, id dẫn xuất ổn định từ
 * `outbox_id` + mốc ⇒ chạy lại handler không tạo job thứ hai) rồi hoàn tất job hiện tại: không tiêu lượt thử/dead letter, tự gửi sau khi
 * sang ngày. Không có `requeue` (test/đường khác) ⇒ ném `EmailBudgetDeferredError` để pg-boss thử lại theo chính sách queue.
 */
export function invitationHandlers(
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  opts: {
    key: Buffer;
    baseUrl: string;
    now?: () => Date;
    dailyBudget?: number;
    /** Xếp lại job với `startAfter`; `id` ổn định theo (outbox_id, mốc) để gọi lại là no-op. */
    requeue?: (job: OutboxJob, startAfter: Date, id: string) => Promise<void>;
  },
  logger: Logger = createLogger({ bindings: { component: "member.invitation" } }),
): Record<string, (job: OutboxJob) => Promise<void>> {
  return {
    "member.invited": async (job: OutboxJob) => {
      const mail = await buildInvitationMail(workerDb, job, opts);
      if (!mail) {
        logger.info("invitation.mail_skipped", { outbox_id: job.outbox_id, reason: "not_pending" });
        return;
      }
      const now = opts.now?.() ?? new Date();
      const budget = opts.dailyBudget ?? EMAIL_DAILY_BUDGET_PER_ORG;
      const grant = await takeEmailBudget(workerDb, {
        orgId: job.organization_id,
        required: true,
        now,
        budget,
      });
      logEmailBudget((e, f) => logger.warn(e, f), job.organization_id, grant, budget);
      if (grant.decision !== "send") {
        const retryAt = nextBudgetDayStart(now);
        if (!opts.requeue) throw new EmailBudgetDeferredError(retryAt);
        await opts.requeue(job, retryAt, deferredJobId(job.outbox_id, retryAt));
        logger.warn("invitation.mail_deferred", {
          outbox_id: job.outbox_id,
          retry_at: retryAt.toISOString(),
        });
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
