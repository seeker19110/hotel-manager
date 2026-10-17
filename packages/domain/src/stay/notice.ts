// Hạn thông báo lưu trú (SPEC-notifications S-014, S-015, S-020; SPEC-reservation-stay S-030, Q-13 — D-002): KHÔNG có mặc
// định cứng; cơ sở tự cấu hình. Tính trên giờ địa phương của cơ sở (chuỗi `YYYY-MM-DDTHH:MM`), app đổi sang UTC theo múi giờ.
// Cấu hình `notification_settings.stay_notice_deadline`:
//   { "domestic_cutoff": "23:00", "domestic_next_day_before": "08:00", "foreign_hours": 12 }
// Khách trong nước: nhận trước giờ `domestic_cutoff` → hạn = `domestic_cutoff` cùng ngày; từ giờ đó trở đi → hạn =
// `domestic_next_day_before` ngày hôm sau. Khách nước ngoài: hạn = giờ nhận + `foreign_hours` giờ. Thiếu phần cấu hình
// tương ứng → null (không nhắc, vẫn xuất/đánh dấu được).
import { hoursToMinutes, MINUTES_PER_DAY, minutesToMs } from "../units/units.ts";

export interface StayNoticeDeadline {
  domesticCutoff?: string;
  domesticNextDayBefore?: string;
  foreignHours?: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Đọc cấu hình từ jsonb; sai kiểu → coi như chưa cấu hình phần đó (không đoán). */
export function parseStayNoticeDeadline(v: unknown): StayNoticeDeadline | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: StayNoticeDeadline = {};
  if (typeof o.domestic_cutoff === "string" && HHMM.test(o.domestic_cutoff))
    out.domesticCutoff = o.domestic_cutoff;
  if (typeof o.domestic_next_day_before === "string" && HHMM.test(o.domestic_next_day_before))
    out.domesticNextDayBefore = o.domestic_next_day_before;
  if (
    Number.isInteger(o.foreign_hours) &&
    (o.foreign_hours as number) >= 1 &&
    (o.foreign_hours as number) <= 168
  )
    out.foreignHours = o.foreign_hours as number;
  return Object.keys(out).length > 0 ? out : null;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return hoursToMinutes(h) + m;
}

function shiftLocal(localIso: string, addMinutes: number): string {
  const t = Date.parse(`${localIso}:00Z`) + minutesToMs(addMinutes);
  return new Date(t).toISOString().slice(0, 16);
}

/** Hạn (giờ địa phương `YYYY-MM-DDTHH:MM`) hoặc null khi cơ sở chưa cấu hình phần áp dụng. */
export function stayNoticeDueLocal(
  checkInLocal: string,
  isForeign: boolean,
  cfg: StayNoticeDeadline | null,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(checkInLocal))
    throw new RangeError("giờ nhận phòng không hợp lệ");
  if (!cfg) return null;
  if (isForeign) {
    if (cfg.foreignHours === undefined) return null;
    return shiftLocal(checkInLocal, hoursToMinutes(cfg.foreignHours));
  }
  if (!cfg.domesticCutoff) return null;
  const day = checkInLocal.slice(0, 10);
  const at = minutes(checkInLocal.slice(11, 16));
  if (at < minutes(cfg.domesticCutoff)) return `${day}T${cfg.domesticCutoff}`;
  if (!cfg.domesticNextDayBefore) return null;
  return `${shiftLocal(`${day}T00:00`, MINUTES_PER_DAY).slice(0, 10)}T${cfg.domesticNextDayBefore}`;
}
