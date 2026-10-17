// BE-API-008 (D-043): 409 IDEMPOTENCY_IN_PROGRESS — lần đầu cùng Idempotency-Key còn đang xử lý (chưa commit).
export const IN_PROGRESS_CODE = "IDEMPOTENCY_IN_PROGRESS";

const DEFAULT_MS = 1_000;
const MAX_S = 10;

/** `Retry-After` (giây) → ms để đợi trước khi tra kết quả; thiếu/sai/<1 ⇒ 1 giây; kẹp tối đa 10 giây. */
export function retryAfterMs(header: string | null): number {
  const n = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.ceil(n), MAX_S) * 1_000 : DEFAULT_MS;
}
