// Hạn lưu dữ liệu cá nhân/vận hành còn lại (PLAN T-2308; STD-PRIV-005, XC-GREEN-007; D-116). Worker gọi hằng ngày (job
// `privacy.retention`, apps/worker). Mọi thao tác đi qua hàm SECURITY DEFINER của migration 0066 (app_worker không có
// DELETE/UPDATE trực tiếp): theo LÔ, lặp tới khi hết hoặc hết `PURGE_MAX_ROUNDS` lô. Mỗi bảng độc lập: một bảng lỗi không chặn
// bảng khác (lỗi gom lại ném sau cùng, log nêu tên bảng — không log dữ liệu).
// - `purgeExpiredOperational`: XOÁ thông báo, nhịp worker, phiên đăng nhập, mã xác minh, liên kết khách quá hạn.
// - `anonymizeExpiredPeople`: ẨN DANH giấy tờ nhận dạng rồi tới hồ sơ người (thứ tự có chủ đích: người chỉ được ẩn danh khi mọi
//   giấy tờ của họ đã ẩn danh). Không xoá hàng: FK RESTRICT từ sổ tiền/hợp đồng, giữ id đối chiếu chứng từ (INV-G7).
import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";
import { drain } from "./events.ts";
import {
  AUTH_SESSION_RETENTION_DAYS,
  AUTH_VERIFICATION_RETENTION_DAYS,
  GUEST_LINK_RETENTION_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  NOTIFICATION_RETENTION_DAYS,
  PERSON_RETENTION_MONTHS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
  WORKER_HEARTBEAT_RETENTION_DAYS,
} from "./policy.ts";

export interface RetentionRunOptions {
  now?: Date;
  batch?: number;
  maxRounds?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface OperationalPurgeStats {
  notifications: number;
  workerHeartbeats: number;
  authSessions: number;
  authVerifications: number;
  guestAccessLinks: number;
}

export interface PeopleAnonymizeStats {
  identityDocuments: number;
  persons: number;
}

/** Một lô của một bảng: gọi hàm CSDL tương ứng (tên hàm viết tĩnh — không ghép chuỗi SQL). */
type Step = (now: Date, batch: number) => RawBuilder<{ n: number }>;

/** Chạy lần lượt từng bảng (không song song: một kết nối/lượt, khoá ngắn); bảng lỗi ghi log + gom lỗi, bảng sau vẫn chạy. */
async function runTables<K extends string>(
  workerDb: Kysely<unknown>,
  plan: readonly (readonly [K, Step])[],
  opts: RetentionRunOptions,
  failEvent: string,
): Promise<Record<K, number>> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? PURGE_BATCH;
  const maxRounds = opts.maxRounds ?? PURGE_MAX_ROUNDS;
  const log = opts.log ?? (() => {});
  const stats = Object.fromEntries(plan.map(([k]) => [k, 0])) as Record<K, number>;
  const errors: unknown[] = [];
  for (const [key, step] of plan) {
    try {
      stats[key] = await drain(
        async () => (await step(now, batch).execute(workerDb)).rows[0]?.n ?? 0,
        batch,
        maxRounds,
      );
    } catch (err) {
      errors.push(err);
      log(failEvent, { table: key, error: (err as Error).name });
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, `retention: ${errors.length}/${plan.length} tables failed`);
  return stats;
}

export function purgeExpiredOperational(
  workerDb: Kysely<unknown>,
  opts: RetentionRunOptions = {},
): Promise<OperationalPurgeStats> {
  return runTables<keyof OperationalPurgeStats>(
    workerDb,
    [
      [
        "notifications",
        (now, batch) =>
          sql`select app.purge_notifications(${now}, ${NOTIFICATION_RETENTION_DAYS}, ${batch}) as n`,
      ],
      [
        "workerHeartbeats",
        (now, batch) =>
          sql`select app.purge_worker_heartbeats(${now}, ${WORKER_HEARTBEAT_RETENTION_DAYS}, ${batch}) as n`,
      ],
      [
        "authSessions",
        (now, batch) =>
          sql`select app.purge_auth_sessions(${now}, ${AUTH_SESSION_RETENTION_DAYS}, ${batch}) as n`,
      ],
      [
        "authVerifications",
        (now, batch) =>
          sql`select app.purge_auth_verifications(${now}, ${AUTH_VERIFICATION_RETENTION_DAYS}, ${batch}) as n`,
      ],
      [
        "guestAccessLinks",
        (now, batch) =>
          sql`select app.purge_guest_access_links(${now}, ${GUEST_LINK_RETENTION_DAYS}, ${batch}) as n`,
      ],
    ],
    opts,
    "retention.operational_purge_failed",
  );
}

export function anonymizeExpiredPeople(
  workerDb: Kysely<unknown>,
  opts: RetentionRunOptions = {},
): Promise<PeopleAnonymizeStats> {
  return runTables<keyof PeopleAnonymizeStats>(
    workerDb,
    [
      [
        "identityDocuments",
        (now, batch) =>
          sql`select app.anonymize_identity_documents(${now}, ${IDENTITY_DOCUMENT_RETENTION_MONTHS}, ${batch}) as n`,
      ],
      [
        "persons",
        (now, batch) => sql`select app.anonymize_persons(${now}, ${PERSON_RETENTION_MONTHS}, ${batch}) as n`,
      ],
    ],
    opts,
    "retention.anonymize_failed",
  );
}
