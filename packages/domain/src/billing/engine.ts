// Engine tính tiền kỳ thu hợp đồng — THUẦN, không I/O (PLAN đợt 2 T-113; SPEC-metering-billing S-001, S-016, S-018…S-021,
// mục 10). Đầu vào là ảnh chụp đã đọc sẵn (phiên bản hợp đồng, chỉ số, đơn giá hiệu lực, số người ở); đầu ra là các dòng
// phiếu có snapshot lượng/đơn giá/quy tắc làm tròn. Mọi phép làm tròn tiền đi qua `money` (một hàm, từng dòng; tổng = Σ dòng).
import { formatVndNumber } from "../format/intl.ts";
import { t } from "../i18n.ts";
import {
  DEFAULT_ROUNDING,
  decimalSub,
  lineAmount,
  MoneyError,
  prorate,
  type RoundingRule,
  sumVnd,
} from "../money/money.ts";
import { MS_PER_DAY } from "../units/units.ts";

/** Phiên bản công thức ghi trên từng dòng phiếu (INV-G3) — đổi công thức thì tăng số này. */
export const FORMULA_VERSION = 1;

export type ProrataMode = "actual_days" | "fixed_30";
export type RevenueAccount = "REV_ROOM" | "REV_UTIL" | "REV_SERVICE" | "REV_FEE";

export interface BillingVersion {
  id: string;
  /** Ngày địa phương `YYYY-MM-DD`; `to` gồm trong hiệu lực, null = không thời hạn. */
  from: string;
  to: string | null;
  rentAmount: number;
}

export interface MeteredInput {
  serviceId: string;
  name: string;
  revenueAccount: RevenueAccount;
  /** Lượng tiêu thụ đã tính (qua chuỗi thay công tơ) dạng thập phân, hoặc cặp chỉ số đầu/cuối. */
  start?: string;
  end?: string;
  quantity?: string;
  /** Đơn giá hiệu lực tại ngày cuối kỳ; null ⇒ dịch vụ chưa có giá/chưa hiệu lực ⇒ không có dòng (S-017). */
  unitPrice: string | null;
}

export interface FixedServiceInput {
  serviceId: string;
  name: string;
  kind: "fixed_per_unit" | "per_person" | "one_time";
  revenueAccount: RevenueAccount;
  /** Số lượng theo hợp đồng (fixed_per_unit), mặc định 1. */
  quantity?: number;
  unitPrice: string | null;
}

export interface LeaseBillingInput {
  /** Kỳ thu (tháng dương lịch của cơ sở): ngày đầu và ngày cuối GỒM trong kỳ. */
  periodStart: string;
  periodEnd: string;
  /** Ngày bắt đầu tính tiền (`leases.billing_start_on`) và ngày thực trả (`moved_out_on`, gồm) nếu có. */
  billingStartOn: string;
  movedOutOn: string | null;
  versions: readonly BillingVersion[];
  metered: readonly MeteredInput[];
  services: readonly FixedServiceInput[];
  /** Số người ở có hiệu lực ngày cuối kỳ (SPEC-metering mục 10) — cho dịch vụ `per_person`. */
  occupantsAtEnd: number;
  rounding?: RoundingRule;
  prorata?: ProrataMode;
}

export interface BillingLine {
  kind: "room" | "utility" | "service" | "fee";
  description: string;
  revenueAccount: RevenueAccount;
  quantity: string;
  unitPrice: string;
  amount: number;
  periodFrom: string;
  periodTo: string;
  /** Tiền thuê: thành tiền = làm tròn(unitPrice × quantity / denominator) — quantity là số ngày, unitPrice là giá tháng. */
  denominator?: number;
  leaseVersionId?: string;
  serviceId?: string;
  roundingRule: RoundingRule;
  formulaVersion: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function day(d: string): number {
  if (!DATE.test(d)) throw new MoneyError(t("billing.date_invalid", { date: d }));
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  if (new Date(ms).toISOString().slice(0, 10) !== d)
    throw new MoneyError(t("billing.date_invalid", { date: d }));
  return ms / MS_PER_DAY;
}

function iso(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysInMonth(d: string): number {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Số ngày (gồm hai đầu) của giao [a1,a2] ∩ [b1,b2]; 0 nếu rời nhau. */
function overlap(a1: number, a2: number, b1: number, b2: number): [number, number] | null {
  const s = Math.max(a1, b1);
  const e = Math.min(a2, b2);
  return s <= e ? [s, e] : null;
}

/**
 * Tiền thuê: mỗi phiên bản hiệu lực trong kỳ là một đoạn (S-021), prorata theo ngày thực của tháng, tính cả ngày đầu và
 * cuối (S-018); khoảng tính = kỳ ∩ [ngày bắt đầu tính tiền, ngày thực trả].
 */
export function rentLines(input: LeaseBillingInput): BillingLine[] {
  const rule = input.rounding ?? DEFAULT_ROUNDING;
  const ps = day(input.periodStart);
  const pe = day(input.periodEnd);
  if (pe < ps) throw new MoneyError(t("billing.period_invalid"));
  if (input.periodStart.slice(0, 7) !== input.periodEnd.slice(0, 7)) {
    throw new MoneyError(t("billing.period_not_calendar_month"));
  }
  const dim = daysInMonth(input.periodStart);
  const occ = overlap(ps, pe, day(input.billingStartOn), input.movedOutOn ? day(input.movedOutOn) : pe);
  if (!occ) return [];
  const lines: BillingLine[] = [];
  const sorted = [...input.versions].sort((a, b) => day(a.from) - day(b.from));
  const segments = sorted
    .map((v) => ({ v, seg: overlap(occ[0], occ[1], day(v.from), v.to ? day(v.to) : pe) }))
    .filter((x): x is { v: BillingVersion; seg: [number, number] } => x.seg !== null);
  // Ở trọn tháng thì tổng = giá tháng (SPEC mục 10). `fixed_30` chia 30 chỉ đúng cho tháng lẻ một đoạn; tháng trọn có đổi
  // giá giữa kỳ chia theo ngày thực (15/31 + 16/31), nếu không 31 ngày thành 15/30 + 16/30 > 1 tháng.
  const fullMonth = occ[0] === ps && occ[1] === pe;
  for (const { v, seg } of segments) {
    const days = seg[1] - seg[0] + 1;
    const mode = fullMonth && segments.length > 1 ? "actual_days" : (input.prorata ?? "actual_days");
    const amount = prorate(v.rentAmount, days, dim, mode, rule);
    const denominator = days === dim ? dim : mode === "fixed_30" ? 30 : dim;
    lines.push({
      kind: "room",
      description:
        days === dim
          ? t("billing.line_rent_full_month", {
              month: input.periodStart.slice(5, 7),
              year: input.periodStart.slice(0, 4),
            })
          : t("billing.line_rent_prorated", {
              days,
              days_in_month: dim,
              monthly_rent: formatVndNumber(v.rentAmount),
            }),
      revenueAccount: "REV_ROOM",
      quantity: String(days === dim ? denominator : Math.min(days, denominator)),
      unitPrice: String(v.rentAmount),
      amount,
      denominator,
      periodFrom: iso(seg[0]),
      periodTo: iso(seg[1]),
      leaseVersionId: v.id,
      roundingRule: rule,
      formulaVersion: FORMULA_VERSION,
    });
  }
  return lines;
}

/** Dòng theo chỉ số (S-019): lượng = cuối − đầu (thập phân chính xác) × đơn giá, làm tròn một lần. */
export function meteredLine(
  m: MeteredInput,
  period: { from: string; to: string },
  rule: RoundingRule,
): BillingLine | null {
  if (m.unitPrice === null) return null;
  const quantity = m.quantity ?? decimalSub(m.end ?? "0", m.start ?? "0");
  if (quantity.startsWith("-"))
    throw new MoneyError(t("billing.metered_quantity_negative", { name: m.name }));
  return {
    kind: "utility",
    description: m.name,
    revenueAccount: m.revenueAccount,
    quantity,
    unitPrice: m.unitPrice,
    amount: lineAmount(quantity, m.unitPrice, rule),
    periodFrom: period.from,
    periodTo: period.to,
    serviceId: m.serviceId,
    roundingRule: rule,
    formulaVersion: FORMULA_VERSION,
  };
}

/** Phiếu kỳ của một hợp đồng: tiền thuê → dòng theo chỉ số → dịch vụ cố định/theo người/một lần. Tổng = Σ dòng. */
export function computeLeaseInvoice(input: LeaseBillingInput): { lines: BillingLine[]; total: number } {
  const rule = input.rounding ?? DEFAULT_ROUNDING;
  if (!Number.isInteger(input.occupantsAtEnd) || input.occupantsAtEnd < 0)
    throw new MoneyError(t("billing.occupants_invalid"));
  const period = { from: input.periodStart, to: input.periodEnd };
  const lines = rentLines(input);
  for (const m of input.metered) {
    const l = meteredLine(m, period, rule);
    if (l) lines.push(l);
  }
  for (const s of input.services) {
    if (s.unitPrice === null) continue;
    const qty = s.kind === "per_person" ? input.occupantsAtEnd : (s.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 0)
      throw new MoneyError(t("billing.service_quantity_invalid", { name: s.name }));
    if (qty === 0) continue;
    lines.push({
      kind: s.kind === "one_time" ? "fee" : "service",
      description:
        s.kind === "per_person" ? t("billing.line_per_person", { name: s.name, count: qty }) : s.name,
      revenueAccount: s.revenueAccount,
      quantity: String(qty),
      unitPrice: s.unitPrice,
      amount: lineAmount(String(qty), s.unitPrice, rule),
      periodFrom: period.from,
      periodTo: period.to,
      serviceId: s.serviceId,
      roundingRule: rule,
      formulaVersion: FORMULA_VERSION,
    });
  }
  return { lines, total: sumVnd(lines.map((l) => l.amount)) };
}
