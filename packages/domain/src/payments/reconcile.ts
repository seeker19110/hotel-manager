// Mã tham chiếu chuyển khoản và gợi ý ghép giao dịch ngân hàng ↔ phiếu (SPEC-ledger S-015, S-016, S-020). Thuần, không I/O.
// Gợi ý KHÔNG ghi tiền: chỉ webhook đã xác minh chữ ký + khớp đúng một phiếu + không vượt số còn mới tự ghi (S-016);
// mọi trường hợp khác vào hàng chờ `reconciliation_breaks` với LÝ DO (giá trị dữ liệu, không phải mã lỗi API).
import { t } from "../i18n.ts";

/** Bỏ ký tự dễ nhầm (0/O, 1/I) — 32 ký tự, 6 ký tự ngẫu nhiên ≈ 1,07 tỉ mã mỗi tổ chức (UNIQUE ở CSDL, trùng thì sinh lại). */
export const MEMO_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const MEMO_PREFIX = "HM";

export function generateMemoRef(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = random(6);
  let s = MEMO_PREFIX;
  for (const b of bytes) s += MEMO_ALPHABET[b & 31];
  return s;
}

/** Chuẩn hoá nội dung CK như ngân hàng hay làm: bỏ dấu, đ→D, viết hoa, bỏ mọi ký tự ngoài A-Z0-9. */
export function normalizeMemo(description: string): string {
  return description
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Ứng viên mã tham chiếu trong nội dung CK: mọi chuỗi con 6…16 ký tự bắt đầu bằng `HM` (ngân hàng có thể dính liền mã
 * với chữ khác). Tra CSDL bằng `memo_ref = any(...)` (index UNIQUE) — ứng viên thừa không gây khớp sai.
 */
export function memoCandidates(description: string, maxLength = 2000): string[] {
  const s = normalizeMemo(description.slice(0, maxLength));
  const out = new Set<string>();
  for (let i = s.indexOf(MEMO_PREFIX); i >= 0; i = s.indexOf(MEMO_PREFIX, i + 1)) {
    for (let len = 6; len <= 16 && i + len <= s.length; len++) out.add(s.slice(i, i + len));
  }
  return [...out];
}

export const BREAK_REASONS = [
  "WRONG_REFERENCE",
  "COMBINED",
  "OVERPAID",
  "THIRD_PARTY_PAYER",
  "UNMATCHED",
  "HASH_MISMATCH",
] as const;
export type BreakReason = (typeof BREAK_REASONS)[number];

export interface CandidateInvoice {
  id: string;
  /** Số còn phải thu (đồng, ≥ 0). */
  open: number;
  /** Phiếu cùng cơ sở với tài khoản nhận. */
  sameProperty: boolean;
}

export interface MatchSuggestion {
  status: "match" | "break";
  reason: BreakReason | null;
  /** Đề xuất phân bổ (theo thứ tự phiếu truyền vào: hạn sớm trước). */
  allocations: { invoiceId: string; amount: number }[];
  /** Phần còn lại vào CUSTOMER_CREDIT của người trả. */
  credit: number;
}

/**
 * - không mã nào khớp → WRONG_REFERENCE · mã của cơ sở khác → UNMATCHED (không tự chuyển tiền giữa cơ sở)
 * - ≥ 2 phiếu → COMBINED (đề xuất trả lần lượt) · 1 phiếu, tiền > số còn → OVERPAID (đề xuất số còn + phần thừa vào
 *   CUSTOMER_CREDIT) · 1 phiếu, tiền ≤ số còn → khớp (trả đủ hoặc một phần).
 */
export function classifyBankTxn(amount: number, invoices: readonly CandidateInvoice[]): MatchSuggestion {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError(t("reconcile.amount_not_positive"));
  if (invoices.length === 0)
    return { status: "break", reason: "WRONG_REFERENCE", allocations: [], credit: amount };
  if (invoices.some((i) => !i.sameProperty))
    return { status: "break", reason: "UNMATCHED", allocations: [], credit: amount };
  let left = amount;
  const allocations: { invoiceId: string; amount: number }[] = [];
  for (const i of invoices) {
    const a = Math.min(Math.max(i.open, 0), left);
    if (a > 0) allocations.push({ invoiceId: i.id, amount: a });
    left -= a;
  }
  if (invoices.length > 1) return { status: "break", reason: "COMBINED", allocations, credit: left };
  if (left > 0) return { status: "break", reason: "OVERPAID", allocations, credit: left };
  return { status: "match", reason: null, allocations, credit: 0 };
}
