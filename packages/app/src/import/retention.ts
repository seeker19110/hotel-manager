// PLAN đợt 3 T-224 — hạn giữ dữ liệu nhập + file hết hạn (SPEC-import mục 10: xoá file nguồn 30 ngày sau commit/huỷ;
// ERD `files.delete_after`, `import_rows.raw/data`; INV-G7). Worker gọi định kỳ (T-225 lập lịch).
// - File: object xoá TRƯỚC, đánh dấu `deleted` SAU (xoá lỗi ⇒ để lượt sau thử lại; đánh dấu lỗi ⇒ lượt sau xoá lại —
//   xoá object là idempotent). File đã `deleted` không cấp URL ký nữa (getFileUrl chỉ cấp cho `ready`).
// - Dòng nhập: làm rỗng `raw`/`data` (PII) của lô đã commit/huỷ quá `IMPORT_ROW_RETENTION_DAYS` ngày (ngày giờ cơ sở).
import { VN_UTC_OFFSET_MS } from "@hm/domain";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { ObjectStorage } from "../files/index.ts";

export const IMPORT_ROW_RETENTION_DAYS = 30;
const BATCH = 200;

export interface RetentionStats {
  rowsPurged: number;
  filesDeleted: number;
  filesFailed: number;
}

/** Ngày hôm nay theo giờ Việt Nam (mốc so với `files.delete_after`, vốn ghi bằng current_date của CSDL). */
function vnToday(now: Date): string {
  return new Date(now.getTime() + VN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export async function runRetention(
  workerDb: Kysely<unknown>,
  storage: Pick<ObjectStorage, "delete">,
  opts: { now?: Date; log?: (event: string, fields: Record<string, unknown>) => void } = {},
): Promise<RetentionStats> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const today = vnToday(now);
  // Hạn là `delete_after <= today` (VN) — dòng staging `pending_scan` tới hạn là đủ điều kiện xoá; `stageFile` (replay) dùng cùng
  // phép so này để từ chối chốt lại dòng sắp bị dọn (review lát 7 🟡4).
  const purged = await sql<{ n: number }>`
    select app.purge_import_rows(${now}, ${IMPORT_ROW_RETENTION_DAYS}) as n`.execute(workerDb);
  const stats: RetentionStats = { rowsPurged: purged.rows[0]?.n ?? 0, filesDeleted: 0, filesFailed: 0 };
  // Đã thử trong lượt này (xoá lỗi hoặc đánh dấu không đổi) — không lặp vô hạn trên cùng file.
  const seen = new Set<string>();
  for (;;) {
    const due = await sql<{ id: string; organization_id: string; storage_key: string }>`
      select * from app.files_due_for_deletion(${today}::date, ${BATCH})`.execute(workerDb);
    const todo = due.rows.filter((f) => !seen.has(f.id));
    if (todo.length === 0) break;
    for (const f of todo) {
      seen.add(f.id);
      try {
        await storage.delete(f.storage_key);
        const m = await sql<{
          ok: boolean;
        }>`select app.mark_file_deleted(${f.id}::uuid, ${today}::date) as ok`.execute(workerDb);
        if (m.rows[0]?.ok) stats.filesDeleted += 1;
      } catch (err) {
        stats.filesFailed += 1;
        log("retention.file_delete_failed", {
          file_id: f.id,
          org_id: f.organization_id,
          error: (err as Error).name,
        });
      }
    }
    if (due.rows.length < BATCH) break;
  }
  return stats;
}
