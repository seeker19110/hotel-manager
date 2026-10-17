// Điểm công khai của module hạn giữ bảng sự kiện (ARC-MOD-005).
export { type EventPurgeOptions, type EventPurgeStats, purgeEventTables } from "./events.ts";
export {
  DELIVERY_DONE_RETENTION_DAYS,
  DELIVERY_FAILED_RETENTION_DAYS,
  IDEMPOTENCY_GRACE_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
} from "./policy.ts";
