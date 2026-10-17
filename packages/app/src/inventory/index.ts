// Điểm công khai của module `inventory` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export {
  type AvailableRoom,
  CALENDAR_MAX_DAYS,
  type Calendar,
  type CalendarInput,
  type CalendarRoom,
  type CalendarSegment,
  getCalendar,
  searchAvailability,
} from "./calendar.ts";
export {
  openException,
  openRelocationForNextBooking,
  recordWorkerExceptionOpened,
  resolveOverstayExceptions,
} from "./exceptions.ts";
export {
  approveBlock,
  assertNoOpenOverstay,
  confirmHold,
  createHold,
  endBlock,
  getUnitStatus,
  type Interval,
  lockUnit,
  proposeBlock,
  resizeAllocation,
  setUnitAvailability,
} from "./inventory.ts";
export { detectOverdue } from "./jobs.ts";
export { archiveUnit, createUnit } from "./units.ts";
