// Tiền VND (INV-G3, IND-FIN-001/012): số nguyên đồng; lượng/đơn giá là chuỗi thập phân → nhân CHÍNH XÁC bằng BigInt,
// rồi làm tròn MỘT lần qua MỘT hàm theo quy tắc lưu trên chứng từ. Không dùng số thực.

export const ROUNDING_RULES = ["HALF_UP_1", "HALF_UP_1000"] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];
/** Mặc định đã duyệt 2026-10-15: nửa lên đến 1 đ, từng dòng (PLAN đợt 1). */
export const DEFAULT_ROUNDING: RoundingRule = "HALF_UP_1";

export class MoneyError extends Error {
  readonly code = "VALIDATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Số thập phân chính xác: value = units / 10^scale. */
interface Dec {
  units: bigint;
  scale: number;
}

const DECIMAL = /^(-)?(\d{1,18})(?:\.(\d{1,9}))?$/;

export function parseDecimal(input: string): Dec {
  const m = DECIMAL.exec(input.trim());
  if (!m) throw new MoneyError(`Không phải số thập phân hợp lệ: "${input}"`);
  const frac = m[3] ?? "";
  const units = BigInt(`${m[2]}${frac}`) * (m[1] ? -1n : 1n);
  return { units, scale: frac.length };
}

function unitSize(rule: RoundingRule): bigint {
  return rule === "HALF_UP_1000" ? 1000n : 1n;
}

/** Làm tròn số hữu tỉ num/den (den > 0) về bội của `unit`, nửa đi xa số 0 (half up theo độ lớn). */
function roundRational(num: bigint, den: bigint, rule: RoundingRule): bigint {
  const unit = unitSize(rule);
  const d = den * unit;
  const sign = num < 0n ? -1n : 1n;
  const abs = num < 0n ? -num : num;
  const q = abs / d;
  const r = abs % d;
  const rounded = 2n * r >= d ? q + 1n : q;
  return sign * rounded * unit;
}

function toSafe(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError("Số tiền vượt giới hạn an toàn");
  }
  return Number(v);
}

/** Thành tiền = lượng × đơn giá, làm tròn theo `rule` (ví dụ kế hoạch: 100 kWh × 3.000 = 300.000). */
export function lineAmount(
  quantity: string,
  unitPrice: string,
  rule: RoundingRule = DEFAULT_ROUNDING,
): number {
  const q = parseDecimal(quantity);
  const p = parseDecimal(unitPrice);
  const den = 10n ** BigInt(q.scale + p.scale);
  return toSafe(roundRational(q.units * p.units, den, rule));
}

/** Làm tròn một giá trị thập phân (vd tỉ lệ prorata đã nhân) về đồng theo `rule`. */
export function roundVnd(value: string, rule: RoundingRule = DEFAULT_ROUNDING): number {
  const d = parseDecimal(value);
  return toSafe(roundRational(d.units, 10n ** BigInt(d.scale), rule));
}

/** Tổng các dòng đã làm tròn (quy tắc "từng dòng": tổng không làm tròn lại). */
export function sumVnd(amounts: readonly number[]): number {
  let total = 0n;
  for (const a of amounts) {
    if (!Number.isSafeInteger(a)) throw new MoneyError(`Số tiền phải là số nguyên đồng: ${a}`);
    total += BigInt(a);
  }
  return toSafe(total);
}

export function assertVnd(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new MoneyError("Số tiền phải là số nguyên đồng (VND)");
  }
}

/** Dòng bút toán sổ phụ (DOMAIN-MODEL §5). */
export const ACCOUNTS = [
  "CASH",
  "BANK",
  "AR",
  "DEPOSIT_LIAB",
  "CUSTOMER_CREDIT",
  "REV_ROOM",
  "REV_UTIL",
  "REV_SERVICE",
  "REV_FEE",
  "DISCOUNT",
  "OPENING_BALANCE",
] as const;
export type Account = (typeof ACCOUNTS)[number];

export interface PostingLine {
  account: Account;
  debit: number;
  credit: number;
}

/** INV-F1 ở tầng domain (CSDL kiểm lại): ≥ 2 dòng, mỗi dòng đúng một phía > 0, Σ Nợ = Σ Có. */
export function assertBalanced(lines: readonly PostingLine[]): void {
  if (lines.length < 2) throw new MoneyError("Bút toán cần ít nhất 2 dòng");
  for (const l of lines) {
    assertVnd(l.debit);
    assertVnd(l.credit);
    if (l.debit < 0 || l.credit < 0 || l.debit > 0 === l.credit > 0) {
      throw new MoneyError("Mỗi dòng bút toán có đúng một phía Nợ hoặc Có lớn hơn 0");
    }
  }
  if (sumVnd(lines.map((l) => l.debit)) !== sumVnd(lines.map((l) => l.credit))) {
    throw new MoneyError("Bút toán lệch: tổng Nợ khác tổng Có");
  }
}
