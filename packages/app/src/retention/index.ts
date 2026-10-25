// Điểm công khai của module hạn giữ (bảng sự kiện T-505; dữ liệu cá nhân/vận hành còn lại T-2308) (ARC-MOD-005).
export { type EventPurgeOptions, type EventPurgeStats, purgeEventTables } from "./events.ts";
export {
  anonymizeExpiredPeople,
  type OperationalPurgeStats,
  type PeopleAnonymizeStats,
  purgeExpiredOperational,
  type RetentionRunOptions,
} from "./personal.ts";
export {
  AUTH_SESSION_RETENTION_DAYS,
  AUTH_VERIFICATION_RETENTION_DAYS,
  DELIVERY_DONE_RETENTION_DAYS,
  DELIVERY_FAILED_RETENTION_DAYS,
  GUEST_LINK_RETENTION_DAYS,
  IDEMPOTENCY_GRACE_DAYS,
  IDENTITY_DOCUMENT_RETENTION_MONTHS,
  INBOX_RETENTION_MONTHS,
  NOTIFICATION_RETENTION_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  PERSON_RETENTION_MONTHS,
  PRODUCT_EVENTS_RETENTION_MONTHS,
  PURGE_BATCH,
  PURGE_MAX_ROUNDS,
  WORKER_HEARTBEAT_RETENTION_DAYS,
} from "./policy.ts";
