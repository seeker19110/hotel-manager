// Định dạng hiển thị qua Intl/CLDR (XC-I18N-003, BASE-DATA-005): tiền, số, ngày — một chỗ, không ghép chuỗi tay
// (`toLocaleString`, cắt chuỗi ngày). Thuần, không I/O. Mặc định locale `vi-VN`.
// Ký hiệu tiền: CLDR vi-VN cho VND là "₫"; sản phẩm (SPEC, E2E) hiển thị "1.430.000 đ" nên với locale `vi*` ta thay đúng phần
// *ký hiệu* của kết quả Intl bằng "đ" (dấu nhóm, dấu trừ, thứ tự vẫn do Intl quyết định). Locale khác giữ nguyên kết quả Intl.

const DISPLAY_SYMBOL_VI = "đ";

const currencyFormats = new Map<string, Intl.NumberFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function currencyFormat(locale: string): Intl.NumberFormat {
  let f = currencyFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: "currency", currency: "VND" });
    currencyFormats.set(locale, f);
  }
  return f;
}

function numberFormat(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    numberFormats.set(locale, f);
  }
  return f;
}

function dateFormat(locale: string, kind: "day" | "month"): Intl.DateTimeFormat {
  const key = `${kind}:${locale}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC", // ngày lịch thuần (không giờ) → không lệch múi giờ
      ...(kind === "day" ? { day: "2-digit" } : {}),
      month: "2-digit",
      year: "numeric",
    });
    dateFormats.set(key, f);
  }
  return f;
}

function assertWholeVnd(amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Số tiền phải là số nguyên đồng: ${amount}`);
}

/** Tiền VND nguyên đồng kèm ký hiệu: `1430000` → "1.430.000 đ" (vi-VN). Không nhận số lẻ/NaN/Infinity. */
export function formatVnd(amount: number, locale = "vi-VN"): string {
  assertWholeVnd(amount);
  const parts = currencyFormat(locale).formatToParts(amount);
  if (!/^vi(-|$)/i.test(locale)) return parts.map((p) => p.value).join("");
  return parts
    .map((p) => (p.type === "currency" ? DISPLAY_SYMBOL_VI : p.type === "literal" ? " " : p.value))
    .join("");
}

const unitPriceFormats = new Map<string, Intl.NumberFormat>();

/**
 * Đơn giá (có thể dưới 1 đồng/lẻ, cột `numeric(18,4)` — ADR-0003): tối đa 4 chữ số thập phân, bỏ số 0 thừa, kèm "đ".
 * Khác `formatVnd`: KHÔNG ép số nguyên (đơn giá không phải số tiền chứng từ; thành tiền luôn qua `lineAmount` làm tròn).
 */
export function formatVndUnitPrice(price: number, locale = "vi-VN"): string {
  if (!Number.isFinite(price)) throw new RangeError(`Đơn giá không hợp lệ: ${price}`);
  let f = unitPriceFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
    unitPriceFormats.set(locale, f);
  }
  return /^vi(-|$)/i.test(locale) ? `${f.format(price)} ${DISPLAY_SYMBOL_VI}` : `${f.format(price)} VND`;
}

/** Số tiền VND nguyên đồng KHÔNG kèm ký hiệu: `1430000` → "1.430.000" (dùng trong câu mô tả đã có đơn vị). */
export function formatVndNumber(amount: number, locale = "vi-VN"): string {
  assertWholeVnd(amount);
  return numberFormat(locale).format(amount);
}

// Nhận `YYYY-MM-DD` và cả dạng có phần giờ (`…T…`) — chỉ lấy phần ngày.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
const ISO_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

function utcDate(y: number, m: number, d: number): Date {
  const t = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC tự cuộn tháng/ngày (2026-02-31 → 03-03): kiểm khứ hồi để từ chối ngày không có thật.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d)
    throw new RangeError(`Ngày không hợp lệ: ${y}-${m}-${d}`);
  return t;
}

/** `YYYY-MM-DD` → ngày theo locale: "2026-10-05" → "05/10/2026" (vi-VN), "10/05/2026" (en-US). Ném RangeError nếu sai. */
export function formatDate(iso: string, locale = "vi-VN"): string {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`Ngày không hợp lệ: ${iso}`);
  return dateFormat(locale, "day").format(utcDate(Number(m[1]), Number(m[2]), Number(m[3])));
}

/** `YYYY-MM-DD` hoặc `YYYY-MM` → tháng/năm: "2026-10-05" → "10/2026" (kỳ thu). Ném RangeError nếu sai. */
export function formatMonth(iso: string, locale = "vi-VN"): string {
  const m = ISO_MONTH.exec(iso);
  if (!m) throw new RangeError(`Tháng không hợp lệ: ${iso}`);
  const parts = dateFormat(locale, "month").formatToParts(utcDate(Number(m[1]), Number(m[2]), 1));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("month")}/${pick("year")}`;
}
