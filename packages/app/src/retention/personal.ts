// Job dọn/ẩn danh dữ liệu cá nhân và các bảng còn lại theo hạn giữ (T-2308; STD-PRIV-005, XC-GREEN-007; D-116 — hạn là ĐỀ XUẤT,
// chờ DPIA/pháp lý). Worker gọi hằng ngày (apps/worker, job `privacy.retention`). Mỗi bảng qua MỘT hàm SECURITY DEFINER của
// migration 0066 (app_worker không có DELETE/UPDATE trực tiếp), theo LÔ, lặp tới khi hết hoặc hết `PURGE_MAX_ROUNDS` lô. Mỗi bảng
// độc lập: một bảng lỗi không chặn các bảng khác (lỗi gom lại ném sau cùng). Thứ tự có chủ ý: giấy tờ TRƯỚC người (người chỉ ẩn
// danh khi giấy tờ đã ẩn danh). Log chỉ ghi tên bảng và tên lỗi — không ghi PII, không ghi id người.
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { drain } from "./events.ts";
import {
  AUTH_SESSION_GRACE_DAYS,
  AUTH_VERIFICATION_GRACE_DAYS,
  GUEST_LINK_GRACE_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  INBOX_RAW_RETENTION_YEARS,
  NOTIFICATION_RETENTION_DAYS,
  PERSON_RETENTION_YEARS,
  PRODUCT_EVENT_RETENTION_MONTHS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
  WORKER_HEARTBEAT_STALE_DAYS,
} from "./policy.ts";

export interface PersonalPurgeStats {
  notifications: number;
  workerHeartbeats: number;
  authSessions: number;
  authVerifications: number;
  guestAccessLinks: number;
  /** Số dòng inbox được làm rỗng `raw` (dòng giữ nguyên). */
  inboxRaw: number;
  /** Số giấy tờ được ẩn danh. */
  identityDocuments: number;
  /** Số hồ sơ người được ẩn danh. */
  persons: number;
  /** Số sự kiện sản phẩm quá hạn (RET-19) đã xoá. */
  productEvents: number;
}

export interface PersonalPurgeOptions {
  now?: Date;
  batch?: number;
  maxRounds?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Hàm CSDL (migration 0066) và tham số hạn giữ cho từng bảng — tên hàm cố định, không nhận từ bên ngoài. */
const STEPS: readonly (readonly [keyof PersonalPurgeStats, string, number])[] = [
  ["notifications", "purge_notifications", NOTIFICATION_RETENTION_DAYS],
  ["workerHeartbeats", "purge_worker_heartbeats", WORKER_HEARTBEAT_STALE_DAYS],
  ["authSessions", "purge_auth_sessions", AUTH_SESSION_GRACE_DAYS],
  ["authVerifications", "purge_auth_verifications", AUTH_VERIFICATION_GRACE_DAYS],
  ["guestAccessLinks", "purge_guest_access_links", GUEST_LINK_GRACE_DAYS],
  ["inboxRaw", "purge_inbox_raw", INBOX_RAW_RETENTION_YEARS],
  ["identityDocuments", "anonymize_identity_documents", IDENTITY_DOCUMENT_RETENTION_MONTHS],
  ["persons", "anonymize_persons", PERSON_RETENTION_YEARS],
  ["productEvents", "purge_product_events", PRODUCT_EVENT_RETENTION_MONTHS],
];

export async function purgePersonalData(
  workerDb: Kysely<unknown>,
  opts: PersonalPurgeOptions = {},
): Promise<PersonalPurgeStats> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? PURGE_BATCH;
  const maxRounds = opts.maxRounds ?? PURGE_MAX_ROUNDS;
  const log = opts.log ?? (() => {});
  const stats: PersonalPurgeStats = {
    notifications: 0,
    workerHeartbeats: 0,
    authSessions: 0,
    authVerifications: 0,
    guestAccessLinks: 0,
    inboxRaw: 0,
    identityDocuments: 0,
    persons: 0,
    productEvents: 0,
  };
  const errors: unknown[] = [];
  for (const [table, fn, keep] of STEPS) {
    try {
      stats[table] = await drain(
        async () =>
          (
            await sql<{ n: number }>`select ${sql.raw(`app.${fn}`)}(${now}, ${keep}, ${batch}) as n`.execute(
              workerDb,
            )
          ).rows[0]?.n ?? 0,
        batch,
        maxRounds,
      );
    } catch (err) {
      errors.push(err);
      log("retention.personal_purge_failed", { table, error: (err as Error).name });
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length}/${STEPS.length} bảng dọn lỗi`);
  return stats;
}
