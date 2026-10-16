// Job định kỳ của worker.
import { randomUUID } from "node:crypto";
import {
  type AutoApplyResult,
  applyBankTransaction,
  type RetentionResult,
  type RetentionStorage,
  runRetention,
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
