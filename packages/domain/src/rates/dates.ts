// Ngày kinh doanh thuần (không múi giờ, không I/O) — SPEC-reservation-stay S-002, S-016, INV-G2.
// Ngày là chuỗi `YYYY-MM-DD` (ngày địa phương của cơ sở); phép tính đi qua số ngày kể từ epoch UTC để không dính giờ hè/múi giờ máy.
import { RateError } from "./errors.ts";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** Số ngày kể từ 1970-01-01 của ngày `YYYY-MM-DD`; ngày không có thật (30/02) → lỗi. */
export function dayNumber(date: string): number {
  const m = DATE.exec(date);
  if (!m) throw new RateError("INVALID_DATE", `Ngày không hợp lệ: "${date}"`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(t).toISOString().slice(0, 10) !== date) {
    throw new RateError("INVALID_DATE", `Ngày không hợp lệ: "${date}"`);
  }
  return t / DAY_MS;
}

export function dateOfDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Thứ trong tuần theo quy ước JS `Date#getUTCDay`: 0 = Chủ nhật, 1 = thứ Hai … 5 = thứ Sáu, 6 = thứ Bảy.
 * (Không dùng ISO 1..7.) 20/10/2026 là thứ Ba = 2 (fixture SPEC-reservation).
 */
export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

/**
 * Ngày kinh doanh của một thời điểm ĐỊA PHƯƠNG đã quy đổi (hàm không đọc múi giờ): trước giờ chốt thì thuộc ngày hôm
 * trước (S-016 b: 16/10 01:30, chốt 04:00 → 15/10). `localDateTime` dạng `YYYY-MM-DDTHH:MM[:SS]` (cho phép dấu cách thay `T`);
 * `cutoff` dạng `HH:MM` (`properties.business_day_cutoff`, khách sạn 04:00, cho thuê 00:00 = không lùi ngày).
 */
export function businessDateOf(localDateTime: string, cutoff: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::[0-5]\d(?:\.\d+)?)?$/.exec(localDateTime);
  if (!m) throw new RateError("INVALID_DATE", `Thời điểm địa phương không hợp lệ: "${localDateTime}"`);
  const [date, time] = [m[1] as string, m[2] as string];
  if (!TIME.test(time)) throw new RateError("INVALID_DATE", `Giờ không hợp lệ: "${localDateTime}"`);
  if (!TIME.test(cutoff)) throw new RateError("INVALID_DATE", `Giờ chốt ngày không hợp lệ: "${cutoff}"`);
  const day = dayNumber(date);
  // `HH:MM` so sánh chuỗi đúng thứ tự thời gian.
  return time < cutoff ? dateOfDay(day - 1) : date;
}
