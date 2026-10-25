// Điểm công khai của module `analytics` (ARC-MOD-005). Chỉ `track()` ghi sự kiện; không SDK analytics nào ngoài thư mục này.
export { analyticsActorKey, pseudonymizeActor } from "./actor.ts";
export { COMMAND_EVENTS, trackCommand } from "./commands.ts";
export {
  EVENT_NAMES,
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMAS,
  type EventName,
  type EventProps,
  isEventName,
} from "./events.ts";
export { BLACKLISTED_FIELD_WORDS, isBlacklistedField, looksLikePii } from "./pii.ts";
export {
  AnalyticsError,
  type AnalyticsSink,
  forgetAnalyticsActor,
  type TrackInput,
  track,
  validateEvent,
} from "./track.ts";
