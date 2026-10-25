// Điểm công khai của module hạn giữ bảng sự kiện (ARC-MOD-005).
export { type EventPurgeOptions, type EventPurgeStats, purgeEventTables } from "./events.ts";
export { type PersonalPurgeOptions, type PersonalPurgeStats, purgePersonalData } from "./personal.ts";
export {
  AUTH_SESSION_GRACE_DAYS,
  AUTH_VERIFICATION_GRACE_DAYS,
  DELIVERY_DONE_RETENTION_DAYS,
  DELIVERY_FAILED_RETENTION_DAYS,
  GUEST_LINK_GRACE_DAYS,
  IDEMPOTENCY_GRACE_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  INBOX_RAW_RETENTION_YEARS,
  NOTIFICATION_RETENTION_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  PERSON_RETENTION_YEARS,
  PRODUCT_EVENT_RETENTION_MONTHS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
  WORKER_HEARTBEAT_STALE_DAYS,
} from "./policy.ts";
