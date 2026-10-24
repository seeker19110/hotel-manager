// Giá lưu trú ngắn hạn thuần (SPEC-reservation-stay S-001, S-002, S-008, S-016; Q-02/Q-03/Q-06/Q-10 — PLAN đợt 3 D-002).
// Một đơn vị "đêm" theo ngày kinh doanh: đêm d tính từ giờ nhận ngày d đến giờ trả ngày d+1. Giá mỗi đêm = giá cuối tuần nếu
// thứ của d thuộc `weekendNights` (ISO 1 = thứ Hai … 7 = Chủ nhật), còn lại giá ngày thường; tiền là số nguyên đồng.

import { t } from "../i18n.ts";
import { MS_PER_DAY } from "../units/units.ts";

export interface RateVersion {
  effectiveFrom: string;
  /** Gồm ngày này; null = đang hiệu lực. */
  effectiveTo: string | null;
  weekdayPrice: number;
  weekendPrice: number;
}

export interface NightPrice {
  businessDate: string;
  amount: number;
}

export type QuoteError =
  | { code: "VALIDATION_FAILED"; reason: "departure_not_after_arrival" | "invalid_date" }
  | { code: "MAX_NIGHTS_EXCEEDED"; maxNights: number }
  | { code: "RATE_NOT_CONFIGURED"; businessDate: string };

export class QuoteRuleError extends Error {
  readonly detail: QuoteError;
  constructor(detail: QuoteError) {
    super(detail.code);
    this.name = "QuoteRuleError";
    this.detail = detail;
  }
}

export const DEFAULT_WEEKEND_NIGHTS: readonly number[] = [5, 6];
export const DEFAULT_MAX_NIGHTS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(d: string): number {
  if (!DATE.test(d)) throw new QuoteRuleError({ code: "VALIDATION_FAILED", reason: "invalid_date" });
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d)
    throw new QuoteRuleError({ code: "VALIDATION_FAILED", reason: "invalid_date" });
  return t;
}

export function addDays(d: string, n: number): string {
  return new Date(parse(d) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Thứ ISO (1 = thứ Hai … 7 = Chủ nhật) của một ngày lịch. */
export function isoWeekday(d: string): number {
  const w = new Date(parse(d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Các đêm (ngày kinh doanh) của khoảng [arrival, departure). */
export function nightsOf(arrival: string, departure: string, maxNights = DEFAULT_MAX_NIGHTS): string[] {
  const a = parse(arrival);
  const b = parse(departure);
  if (b <= a) throw new QuoteRuleError({ code: "VALIDATION_FAILED", reason: "departure_not_after_arrival" });
  // Hai mốc 00:00 UTC: hiệu luôn là bội đúng của một ngày (không có giờ mùa hè ở UTC).
  const n = (b - a) / MS_PER_DAY;
  if (n > maxNights) throw new QuoteRuleError({ code: "MAX_NIGHTS_EXCEEDED", maxNights });
  return Array.from({ length: n }, (_, i) => addDays(arrival, i));
}

function rateFor(rates: readonly RateVersion[], d: string): RateVersion | undefined {
  return rates.find((r) => r.effectiveFrom <= d && (r.effectiveTo === null || d <= r.effectiveTo));
}

/** Giá từng đêm theo bản giá hiệu lực tại chính đêm đó; đêm không có giá → RATE_NOT_CONFIGURED (không đoán giá). */
export function priceNights(
  nights: readonly string[],
  rates: readonly RateVersion[],
  weekendNights: readonly number[] = DEFAULT_WEEKEND_NIGHTS,
): NightPrice[] {
  return nights.map((d) => {
    const r = rateFor(rates, d);
    if (!r) throw new QuoteRuleError({ code: "RATE_NOT_CONFIGURED", businessDate: d });
    const amount = weekendNights.includes(isoWeekday(d)) ? r.weekendPrice : r.weekdayPrice;
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new QuoteRuleError({ code: "RATE_NOT_CONFIGURED", businessDate: d });
    return { businessDate: d, amount };
  });
}

export function sumNights(prices: readonly NightPrice[]): number {
  const s = prices.reduce((acc, p) => acc + p.amount, 0);
  if (!Number.isSafeInteger(s)) throw new RangeError(t("stay.total_unsafe"));
  return s;
}

/**
 * Đổi ngày (Q-06): đêm đã có trong snapshot giữ giá cũ, đêm mới lấy giá hiện hành. Trả giá mới từng đêm và chênh lệch
 * so với tổng cũ (dương = khách trả thêm).
 */
export function repriceForDates(
  snapshot: readonly NightPrice[],
  newNights: readonly string[],
  currentRates: readonly RateVersion[],
  weekendNights: readonly number[] = DEFAULT_WEEKEND_NIGHTS,
): { prices: NightPrice[]; total: number; diff: number } {
  const old = new Map(snapshot.map((p) => [p.businessDate, p.amount]));
  const fresh = newNights.filter((d) => !old.has(d));
  const freshPrices = new Map(
    priceNights(fresh, currentRates, weekendNights).map((p) => [p.businessDate, p.amount]),
  );
  const prices = newNights.map((d) => ({
    businessDate: d,
    amount: (old.get(d) ?? freshPrices.get(d)) as number,
  }));
  const total = sumNights(prices);
  return { prices, total, diff: total - sumNights(snapshot) };
}

/** Chuẩn hoá tham số cuối tuần của cơ sở (properties.settings.weekend_nights); sai → mặc định thứ Sáu + thứ Bảy. */
export function weekendNightsSetting(v: unknown): readonly number[] {
  if (!Array.isArray(v) || v.length > 7) return DEFAULT_WEEKEND_NIGHTS;
  const ok = v.every((x) => Number.isInteger(x) && x >= 1 && x <= 7);
  return ok ? [...new Set(v as number[])].sort() : DEFAULT_WEEKEND_NIGHTS;
}

export function maxNightsSetting(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365
    ? (v as number)
    : DEFAULT_MAX_NIGHTS;
}
