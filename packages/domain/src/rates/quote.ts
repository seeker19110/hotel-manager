// Engine báo giá phòng khách sạn — THUẦN, không I/O (PLAN đợt 3 T-203; SPEC-reservation-stay S-001, S-002, S-016, S-017, S-021).
// Một "đêm" = một ngày kinh doanh từ ngày đến (gồm) tới ngày đi (không gồm) (Q-02). Mỗi đêm dùng bản giá hiệu lực của CHÍNH đêm
// đó và loại ngày (thường/cuối tuần) theo `business_date` của đêm (Q-03). Giá niêm yết là giá cuối, không cộng thuế (Q-12).
// Kết quả là ảnh chụp từng đêm để lưu `reservation_items.nightly_prices` (S-021): đổi bảng giá sau đó không động tới booking đã giữ.
import { assertVnd, sumVnd } from "../money/money.ts";
import { dateOfDay, dayNumber, weekdayOf } from "./dates.ts";
import { RateError } from "./errors.ts";

/**
 * Quy ước thứ: JS `getUTCDay` — 0 = Chủ nhật, 1 = thứ Hai … 5 = thứ Sáu, 6 = thứ Bảy (không phải ISO 1..7).
 * Mặc định đêm cuối tuần = thứ Sáu + thứ Bảy (Q-03; S-002: 22/10 thứ Năm → 25/10 = 600.000 + 700.000 + 700.000 = 2.000.000).
 */
export const DEFAULT_WEEKEND_NIGHTS: readonly number[] = [5, 6];

/** Trần kỹ thuật số đêm một lần báo giá; giới hạn nghiệp vụ (Q-10, đề xuất 30) truyền qua `maxNights`. */
export const MAX_QUOTE_NIGHTS = 365;

export type DayKind = "weekday" | "weekend";

/** Bản giá theo loại phòng (`rate_plans`): ngày hiệu lực theo ngày kinh doanh, `effectiveTo` gồm, null = không thời hạn. */
export interface RatePlan {
  id: string;
  /** Giá một đêm ngày thường (đồng, > 0). */
  weekdayPrice: number;
  /** Giá một đêm cuối tuần (đồng, > 0). */
  weekendPrice: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Ghi đè tập đêm cuối tuần của bản giá này (Q-03: `rate_plans.weekend_nights`); bỏ trống → dùng của đầu vào/mặc định. */
  weekendNights?: readonly number[];
}

/** Giá một đêm đã chốt (snapshot `nightly_prices` của booking): ưu tiên hơn bảng giá cho đúng ngày đó (S-008, S-021). */
export interface NightlyRate {
  businessDate: string;
  amount: number;
  ratePlanId?: string;
}

export interface QuoteInput {
  /** Ngày kinh doanh của đêm đầu (walk-in: `businessDateOf`, S-016 b). */
  arrivalDate: string;
  /** Ngày đi (không tính đêm). Phải sau ngày đến. */
  departureDate: string;
  /** Bảng giá CỦA ĐÚNG loại phòng cần báo (bên gọi đã lọc theo `room_type_id`). */
  ratePlans?: readonly RatePlan[];
  /** Giá đã chốt theo đêm; đêm nào có ở đây thì không tra bảng giá (đổi ngày: đêm cũ giữ snapshot, đêm mới giá hiện hành). */
  nightlyRates?: readonly NightlyRate[];
  weekendNights?: readonly number[];
  /** Số đêm tối đa, mặc định và trần `MAX_QUOTE_NIGHTS`. */
  maxNights?: number;
}

export interface QuoteNight {
  businessDate: string;
  dayKind: DayKind;
  amount: number;
  ratePlanId?: string;
}

export interface Quote {
  arrivalDate: string;
  departureDate: string;
  nights: QuoteNight[];
  nightCount: number;
  /** `room_total` = Σ amount (số nguyên đồng). */
  total: number;
}

function checkWeekendNights(w: readonly number[], what: string): void {
  for (const d of w) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new RateError(
        "INVALID_WEEKEND_NIGHTS",
        `${what}: thứ trong tuần phải là số nguyên 0..6 (0 = Chủ nhật): ${d}`,
      );
    }
  }
}

function checkPlan(p: RatePlan): void {
  for (const [name, v] of [
    ["weekdayPrice", p.weekdayPrice],
    ["weekendPrice", p.weekendPrice],
  ] as const) {
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new RateError("INVALID_RATE_PLAN", `Bản giá ${p.id}: ${name} phải là số nguyên đồng > 0`);
    }
  }
  const from = dayNumber(p.effectiveFrom);
  if (p.effectiveTo !== null && dayNumber(p.effectiveTo) < from) {
    throw new RateError("INVALID_RATE_PLAN", `Bản giá ${p.id}: effectiveTo trước effectiveFrom`);
  }
  if (p.weekendNights) checkWeekendNights(p.weekendNights, `Bản giá ${p.id}`);
}

/** Bản giá hiệu lực của ngày kinh doanh `day`; không có → lỗi, nhiều hơn một → lỗi (không đoán). */
function planFor(plans: readonly RatePlan[], date: string, day: number): RatePlan {
  const hit = plans.filter(
    (p) => dayNumber(p.effectiveFrom) <= day && (p.effectiveTo === null || day <= dayNumber(p.effectiveTo)),
  );
  const [first, second] = hit;
  if (!first) throw new RateError("NO_RATE_FOR_NIGHT", `Không có giá hiệu lực cho đêm ${date}`);
  if (second) throw new RateError("AMBIGUOUS_RATE", `Có nhiều bản giá cùng hiệu lực cho đêm ${date}`);
  return first;
}

/**
 * Báo giá lưu trú theo từng đêm (S-001, S-002). Lỗi (`RateError`, 422): ngày sai; ngày đi ≤ ngày đến; quá `maxNights`;
 * đêm không có giá hiệu lực hoặc có nhiều giá; bản giá/tập cuối tuần không hợp lệ. Không bao giờ trả giá đoán.
 */
export function quoteStay(input: QuoteInput): Quote {
  const start = dayNumber(input.arrivalDate);
  const end = dayNumber(input.departureDate);
  if (end <= start) {
    throw new RateError(
      "DEPARTURE_NOT_AFTER_ARRIVAL",
      `Ngày đi (${input.departureDate}) phải sau ngày đến (${input.arrivalDate})`,
    );
  }
  const max = input.maxNights ?? MAX_QUOTE_NIGHTS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_QUOTE_NIGHTS) {
    throw new RateError("INVALID_LIMIT", `maxNights phải là số nguyên 1..${MAX_QUOTE_NIGHTS}`);
  }
  if (end - start > max) {
    throw new RateError("STAY_TOO_LONG", `Tối đa ${max} đêm một lần báo giá, yêu cầu ${end - start} đêm`);
  }

  const baseWeekend = input.weekendNights ?? DEFAULT_WEEKEND_NIGHTS;
  checkWeekendNights(baseWeekend, "weekendNights");
  const plans = input.ratePlans ?? [];
  for (const p of plans) checkPlan(p);

  const fixed = new Map<number, NightlyRate>();
  for (const r of input.nightlyRates ?? []) {
    assertVnd(r.amount);
    if (r.amount < 0) throw new RateError("INVALID_RATE_PLAN", `Giá đêm ${r.businessDate} không được âm`);
    const k = dayNumber(r.businessDate);
    if (fixed.has(k)) throw new RateError("AMBIGUOUS_RATE", `Đêm ${r.businessDate} có hai giá đã chốt`);
    fixed.set(k, r);
  }

  const nights: QuoteNight[] = [];
  for (let day = start; day < end; day++) {
    const businessDate = dateOfDay(day);
    const snap = fixed.get(day);
    if (snap) {
      const kind = baseWeekend.includes(weekdayOf(businessDate)) ? "weekend" : "weekday";
      nights.push({
        businessDate,
        dayKind: kind,
        amount: snap.amount,
        ...(snap.ratePlanId === undefined ? {} : { ratePlanId: snap.ratePlanId }),
      });
      continue;
    }
    const plan = planFor(plans, businessDate, day);
    const weekend = (plan.weekendNights ?? baseWeekend).includes(weekdayOf(businessDate));
    nights.push({
      businessDate,
      dayKind: weekend ? "weekend" : "weekday",
      amount: weekend ? plan.weekendPrice : plan.weekdayPrice,
      ratePlanId: plan.id,
    });
  }

  return {
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    nights,
    nightCount: nights.length,
    total: sumVnd(nights.map((n) => n.amount)),
  };
}
