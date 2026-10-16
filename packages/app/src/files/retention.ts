// Hạn giữ dữ liệu (T-219; SPEC-import mục 4/10; ERD files.delete_after, import_rows.raw/data; INV-G7; review đợt 2 🟠3).
// Chạy bằng role `app_worker` qua hàm SECURITY DEFINER phạm vi hẹp (worker không đọc trực tiếp `files`/`import_rows`).
// - Xoá file: nhận lô (FOR UPDATE SKIP LOCKED) → xoá object → CHỈ KHI storage xác nhận (kể cả 404) mới đánh dấu `deleted_at`.
//   Lỗi storage ⇒ không đánh dấu, lần sau thử lại. Hai job song song không nhận trùng một file; crash giữa chừng ⇒ rollback
//   đánh dấu, lần sau xoá lại (xoá object là idempotent).
// - Làm rỗng dòng nhập: `raw → '{}'`, `data → NULL` cho lô committed/cancelled quá hạn; giữ số dòng, lỗi, tổng.
// Ngày "hôm nay" tính theo UTC (delete_after là `date`).
import { type Kysely, sql } from "kysely";

/** Đề xuất SPEC-import mục 10: 30 ngày sau commit/huỷ (đồng bộ `current_date + 30` ở import.ts). */
export const IMPORT_ROWS_RETENTION_DAYS = 30;
const STORAGE_TIMEOUT_MS = 15_000;
/** Storage hỏng hàng loạt: dừng sớm để không giữ khoá lâu; phần còn lại để lần sau. */
const MAX_FAILURES_PER_RUN = 5;

export interface RetentionStorage {
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface PurgeFilesResult {
  /** Số file nhận trong lần chạy. */
  claimed: number;
  /** Đã xoá object và đánh dấu. */
  deleted: number;
  /** Lỗi storage: không đánh dấu, lần sau thử lại. */
  failed: { fileId: string; error: string }[];
}

export const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Xoá object của file có `delete_after <= hôm nay (UTC)` và chưa xoá, tối đa `limit` file/lần (mặc định 100, trần 1000).
 * Khoá hàng giữ suốt transaction nên `limit` nhỏ + timeout mỗi lần gọi storage để không giữ khoá lâu.
 */
export async function purgeExpiredFiles(
  workerDb: Kysely<unknown>,
  storage: RetentionStorage,
  now: Date,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<PurgeFilesResult> {
  const today = utcDate(now);
  const correlation = `job:retention_files:${now.toISOString()}`;
  return workerDb.transaction().execute(async (trx) => {
    const claimed = await sql<{ file_id: string; storage_key: string }>`
      select file_id, storage_key from app.retention_claim_files(${today}::date, ${opts.limit ?? 100})`.execute(
      trx,
    );
    const result: PurgeFilesResult = { claimed: claimed.rows.length, deleted: 0, failed: [] };
    for (const f of claimed.rows) {
      try {
        await storage.delete(f.storage_key, {
          signal: AbortSignal.timeout(opts.timeoutMs ?? STORAGE_TIMEOUT_MS),
        });
      } catch (err) {
        result.failed.push({ fileId: f.file_id, error: err instanceof Error ? err.message : String(err) });
        if (result.failed.length >= MAX_FAILURES_PER_RUN) break;
        continue;
      }
      const marked = await sql<{ ok: boolean }>`
        select app.retention_mark_file_deleted(${f.file_id}::uuid, ${today}::date, ${now}, ${correlation}) as ok`.execute(
        trx,
      );
      if (marked.rows[0]?.ok) result.deleted++;
    }
    return result;
  });
}

export interface ScrubRowsResult {
  batches: number;
  rows: number;
}

/**
 * Làm rỗng `import_rows.raw/data` của lô committed/cancelled từ `retentionDays` ngày trước trở về trước; tối đa
 * `batchLimit` lô/lần (mặc định 50). Chạy lại không có gì để làm ⇒ 0.
 */
export async function scrubImportRows(
  workerDb: Kysely<unknown>,
  now: Date,
  opts: { retentionDays?: number; batchLimit?: number } = {},
): Promise<ScrubRowsResult> {
  const days = opts.retentionDays ?? IMPORT_ROWS_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 0) throw new RangeError("retentionDays phải là số nguyên ≥ 0");
  const before = new Date(now.getTime() - days * 86_400_000);
  const correlation = `job:retention_import_rows:${now.toISOString()}`;
  return workerDb.transaction().execute(async (trx) => {
    const r = await sql<{ o_rows: number }>`
      select o_rows from app.retention_scrub_import_rows(${before}, ${opts.batchLimit ?? 50}, ${now}, ${correlation})`.execute(
      trx,
    );
    return { batches: r.rows.length, rows: r.rows.reduce((a, b) => a + b.o_rows, 0) };
  });
}

export interface RetentionResult {
  files: PurgeFilesResult;
  importRows: ScrubRowsResult;
}

/** Một lượt hạn giữ: xoá file quá hạn rồi làm rỗng dòng nhập. Hai bước độc lập — lỗi bước 1 không chặn bước 2. */
export async function runRetention(
  workerDb: Kysely<unknown>,
  storage: RetentionStorage,
  now: Date,
  opts: { fileLimit?: number; retentionDays?: number; batchLimit?: number } = {},
): Promise<RetentionResult> {
  const files = await purgeExpiredFiles(workerDb, storage, now, {
    ...(opts.fileLimit === undefined ? {} : { limit: opts.fileLimit }),
  }).catch(
    (err): PurgeFilesResult => ({
      claimed: 0,
      deleted: 0,
      failed: [{ fileId: "*", error: err instanceof Error ? err.message : String(err) }],
    }),
  );
  const importRows = await scrubImportRows(workerDb, now, {
    ...(opts.retentionDays === undefined ? {} : { retentionDays: opts.retentionDays }),
    ...(opts.batchLimit === undefined ? {} : { batchLimit: opts.batchLimit }),
  });
  return { files, importRows };
}
