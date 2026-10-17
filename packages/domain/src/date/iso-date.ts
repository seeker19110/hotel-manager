// Ngày dạng `YYYY-MM-DD` từ đầu vào không tin cậy (query string…): đúng khuôn VÀ là ngày lịch có thật (round-trip).
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `true` khi `value` là ngày lịch hợp lệ `YYYY-MM-DD` (loại 2026-13-45, 2026-02-30; năm 0000 không hợp lệ). */
export function isIsoDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Trả `value` nếu là ngày hợp lệ, ngược lại `fallback` (không bao giờ ném). */
export function isoDateOr(value: string | undefined | null, fallback: string): string {
  return value != null && isIsoDate(value) ? value : fallback;
}
