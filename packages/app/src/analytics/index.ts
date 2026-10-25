// Điểm công khai của module analytics sản phẩm (ARC-MOD-005; PLAN T-2309). Module khác chỉ gửi sự kiện qua `track`.
export { type CommandTrackSource, trackCommand } from "./command.ts";
export {
  CORE_TASKS,
  type CoreTask,
  EVENTS,
  type EventName,
} from "./events.ts";
export {
  type AnalyticsDb,
  type ConsentCheck,
  type ConsentEnv,
  type ConsentQuery,
  configureAnalytics,
  type DropReason,
  denyAllConsent,
  resetAnalytics,
  type TrackContext,
  type TrackOptions,
  type TrackResult,
  track,
} from "./track.ts";
export { AnalyticsValidationError } from "./validate.ts";
