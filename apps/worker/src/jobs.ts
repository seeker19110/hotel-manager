// Job định kỳ của worker.
import { randomUUID } from "node:crypto";
import {
  type AutoApplyResult,
  applyBankTransaction,
  dispatchNotificationEvent,
  type EmailSender,
  NOTIFICATION_EVENT_TYPES,
  type NotificationEvent,
  type RetentionResult,
  type RetentionStorage,
  remindExpiring,
  runRetention,
  type ScanResult,
  type SendConfig,
  type SendOptions,
  type SendSummary,
  scanOverdue,
  scanStayNoticeConfig,
  sendDueEmails,
} from "@hm/app";
import { withTenant } from "@hm/db";
import { type Kysely, sql } from "kysely";
import type { PgBoss } from "pg-boss";

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

/** Queue job hạn giữ dữ liệu (T-219) và lịch chạy mặc định: 03:17 UTC hằng ngày (giờ thấp tải, lệch phút để tránh trùng giờ tròn). */
export const RETENTION_QUEUE = "retention.sweep";
export const RETENTION_CRON = "17 3 * * *";

/**
 * Đăng ký job hạn giữ chạy định kỳ qua pg-boss (`schedule` lưu trong DB nên nhiều worker không nhân đôi lịch). Gọi lại
 * nhiều lần vô hại. Handler phải được đăng ký bằng `startRetentionWorker`.
 */
export async function scheduleRetention(boss: PgBoss, cron = RETENTION_CRON): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE);
  await boss.schedule(RETENTION_QUEUE, cron, {});
}

/** Nhận job hạn giữ: mỗi lượt xoá file quá hạn + làm rỗng dòng nhập; idempotent nên retry/chạy trùng đều an toàn. */
export async function startRetentionWorker(
  boss: PgBoss,
  workerDb: Kysely<unknown>,
  storage: RetentionStorage,
  opts: {
    now?: () => Date;
    onResult?: (r: RetentionResult) => void;
    pollingIntervalSeconds?: number;
  } = {},
): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE);
  await boss.work(
    RETENTION_QUEUE,
    { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 30 },
    async () => {
      const r = await runRetention(workerDb, storage, (opts.now ?? (() => new Date()))());
      opts.onResult?.(r);
      // File lỗi storage: ném để pg-boss ghi nhận và thử lại theo chính sách queue (các file đã xoá không bị xoá lại).
      if (r.files.failed.length > 0) throw new Error(`hạn giữ: ${r.files.failed.length} file chưa xoá được`);
    },
  );
}

/**
 * Handler `notify.dispatch` cho mọi sự kiện có thông báo (`invoice.issued`, `invoice.overdue`, `lease.expiring`…): gắn vào
 * `startConsumers`. Idempotent theo `dedupe_key` nên pg-boss giao lại vẫn một thông báo (SPEC-notifications S-003).
 */
export function notificationEventHandlers(
  workerDb: Kysely<unknown>,
  now: () => Date = () => new Date(),
): Record<string, (job: NotificationEvent) => Promise<void>> {
  return Object.fromEntries(
    NOTIFICATION_EVENT_TYPES.map((type) => [
      type,
      async (job: NotificationEvent) => {
        await dispatchNotificationEvent(workerDb, job, now());
      },
    ]),
  );
}

/** Queue job gửi email tới hạn (`notify.sendEmail`) và lịch mặc định mỗi phút (khớp mức backoff nhỏ nhất 1 phút). */
export const NOTIFY_SEND_QUEUE = "notify.sendEmail";
export const NOTIFY_SEND_CRON = "* * * * *";

export async function scheduleNotificationSend(boss: PgBoss, cron = NOTIFY_SEND_CRON): Promise<void> {
  await boss.createQueue(NOTIFY_SEND_QUEUE);
  await boss.schedule(NOTIFY_SEND_QUEUE, cron, {});
}

/** Nhận job gửi email: mỗi lượt claim các delivery tới hạn rồi gửi qua `EmailSender` (production: adapter thật do chủ dự án chọn). */
export async function startNotificationSendWorker(
  boss: PgBoss,
  workerDb: Kysely<unknown>,
  sender: EmailSender,
  cfg: SendConfig,
  opts: SendOptions & { onResult?: (r: SendSummary) => void; pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await boss.createQueue(NOTIFY_SEND_QUEUE);
  await boss.work(
    NOTIFY_SEND_QUEUE,
    { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 15 },
    async () => {
      opts.onResult?.(await sendDueEmails(workerDb, sender, cfg, opts));
    },
  );
}

/**
 * Job quét nhắc hạn (T-212; SPEC-notifications §5). Mỗi job chỉ PHÁT sự kiện outbox có `dedupe_key`; relay + `notify.dispatch`
 * tạo thông báo. Lịch dày hơn nhịp nhắc (mỗi giờ/15 phút) vì ngày/khung giờ tính theo múi giờ từng cơ sở và việc chạy lại luôn
 * an toàn (không phát trùng) — job lỡ một lượt thì lượt sau bù, không mất nhắc.
 */
export const REMINDER_JOBS = {
  /** Nhắc quá hạn thanh toán: mỗi giờ (SQL chỉ chọn khi cơ sở đang trong khung giờ gửi, mặc định 08:00–20:00). */
  overdue: { queue: "reminder.scanOverdue", cron: "7 * * * *" },
  /** Nhắc hợp đồng sắp hết hạn: mỗi giờ (so ngày địa phương từng cơ sở; một nhắc mỗi mốc nhờ dedupe). */
  leaseExpiry: { queue: "reminder.scanLeaseExpiry", cron: "11 * * * *" },
  /** Hạn thông báo lưu trú: 15 phút (đề xuất SPEC). Hiện chỉ có bước cảnh báo chưa cấu hình hạn (S-020); T-207 thêm bước nhắc hạn. */
  stayNotice: { queue: "reminder.scanStayNotice", cron: "*/15 * * * *" },
} as const;

/** Đăng ký lịch các job nhắc hạn (idempotent: lịch lưu trong DB, gọi lại vô hại). */
export async function scheduleReminders(boss: PgBoss): Promise<void> {
  for (const j of Object.values(REMINDER_JOBS)) {
    await boss.createQueue(j.queue);
    await boss.schedule(j.queue, j.cron, {});
  }
}

/** Nhận job nhắc hạn. `onResult` để quan sát/test; lỗi DB ném ra để pg-boss thử lại (chạy lại an toàn). */
export async function startReminderWorkers(
  boss: PgBoss,
  workerDb: Kysely<unknown>,
  opts: {
    now?: () => Date;
    onResult?: (job: keyof typeof REMINDER_JOBS, r: ScanResult) => void;
    pollingIntervalSeconds?: number;
  } = {},
): Promise<void> {
  const clock = opts.now ?? (() => new Date());
  const handlers: Record<keyof typeof REMINDER_JOBS, (now: Date) => Promise<ScanResult>> = {
    overdue: (now) => scanOverdue(workerDb, now),
    leaseExpiry: async (now) => ({ created: await remindExpiring(workerDb, now) }),
    stayNotice: (now) => scanStayNoticeConfig(workerDb, now),
  };
  for (const [name, job] of Object.entries(REMINDER_JOBS) as [
    keyof typeof REMINDER_JOBS,
    (typeof REMINDER_JOBS)[keyof typeof REMINDER_JOBS],
  ][]) {
    await boss.createQueue(job.queue);
    await boss.work(job.queue, { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 30 }, async () => {
      opts.onResult?.(name, await handlers[name](clock()));
    });
  }
}
