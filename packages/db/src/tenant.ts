import { type IsolationLevel, type Kysely, sql, type Transaction } from "kysely";
import {
  isTransientTxError,
  type RetryDeps,
  type RetryPolicy,
  retryAsync,
  WORKER_TX_RETRY,
} from "./retry.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  orgId: string;
  actorId?: string;
}

/** Điểm duy nhất của mã dự án mở transaction có đặt mức cô lập (DB-TX-002: rào `tx-guards` cấm `setIsolationLevel` ở nơi khác). */
async function runTenantTx<DB, T>(
  db: Kysely<DB>,
  ctx: TenantContext,
  fn: (trx: Transaction<DB>) => Promise<T>,
  isolationLevel?: IsolationLevel,
): Promise<T> {
  if (!UUID.test(ctx.orgId)) throw new Error("orgId không phải UUID");
  if (ctx.actorId !== undefined && !UUID.test(ctx.actorId)) throw new Error("actorId không phải UUID");
  const builder = isolationLevel ? db.transaction().setIsolationLevel(isolationLevel) : db.transaction();
  return builder.execute(async (trx) => {
    await sql`select set_config('app.org_id', ${ctx.orgId}, true)`.execute(trx);
    if (ctx.actorId) await sql`select set_config('app.actor_id', ${ctx.actorId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Chạy `fn` trong một transaction với ngữ cảnh tổ chức (`SET LOCAL app.org_id`) — RLS lớp 1 (INV-G1).
 * `orgId` phải lấy từ membership đã xác minh ở server, không từ client. KHÔNG tự thử lại: nơi cần chịu 40001/40P01 dùng
 * `withTenantRetry` (worker/job) hoặc `executeCommand` (request ghi). `fn` không được gọi mạng (rào `tx-guards`, DB-TX-003).
 */
export async function withTenant<DB, T>(
  db: Kysely<DB>,
  ctx: TenantContext,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return runTenantTx(db, ctx, fn);
}

export interface TenantRetryOptions extends RetryDeps {
  /** Mặc định `WORKER_TX_RETRY`. */
  policy?: RetryPolicy;
  /** Mức cô lập; `repeatable read`/`serializable` BẮT BUỘC đi qua helper này để được bọc retry (DB-TX-002). */
  isolationLevel?: IsolationLevel;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Như `withTenant` nhưng chạy lại TOÀN BỘ transaction (transaction mới, `fn` chạy lại từ đầu) khi gặp SQLSTATE 40001/40P01,
 * lùi mũ + jitter, có trần số lần và tổng thời gian (DB-TX-002). Lỗi khác (vĩnh viễn) ném ngay. `fn` chỉ được chạm CSDL — không
 * mạng, không tác dụng phụ ngoài (rào `tx-guards`) — nên chạy lại an toàn; đổi biến ngoài thì phải đặt lại ở đầu `fn`.
 */
export async function withTenantRetry<DB, T>(
  db: Kysely<DB>,
  ctx: TenantContext,
  fn: (trx: Transaction<DB>) => Promise<T>,
  opts: TenantRetryOptions = {},
): Promise<T> {
  const { policy = WORKER_TX_RETRY, isolationLevel, onRetry, ...deps } = opts;
  return retryAsync(() => runTenantTx(db, ctx, fn, isolationLevel), {
    policy,
    classify: isTransientTxError,
    ...(onRetry ? { onRetry } : {}),
    ...deps,
  });
}
