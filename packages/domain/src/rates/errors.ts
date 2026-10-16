// Lỗi xác thực của engine báo giá (SPEC-reservation-stay S-002, S-016): luôn ánh xạ `422 VALIDATION_FAILED`; `reason` để
// lệnh/UI phân biệt nguyên nhân mà không bóc thông điệp.
export const RATE_ERROR_REASONS = [
  "INVALID_DATE",
  "DEPARTURE_NOT_AFTER_ARRIVAL",
  "STAY_TOO_LONG",
  "NO_RATE_FOR_NIGHT",
  "AMBIGUOUS_RATE",
  "INVALID_RATE_PLAN",
  "INVALID_WEEKEND_NIGHTS",
  "INVALID_LIMIT",
] as const;
export type RateErrorReason = (typeof RATE_ERROR_REASONS)[number];

export class RateError extends Error {
  readonly code = "VALIDATION_FAILED" as const;
  readonly reason: RateErrorReason;
  constructor(reason: RateErrorReason, message: string) {
    super(message);
    this.name = "RateError";
    this.reason = reason;
  }
}
