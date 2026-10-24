// Đọc số tiền VND thành chữ cho trình đọc màn hình (SPEC-portal §5: "một triệu năm trăm tám mươi nghìn đồng").
// Chỉ phục vụ hiển thị/aria-label; số tiền thật luôn là số nguyên đồng. Âm/không nguyên → RangeError.
// Từ vựng (chữ số, trăm/mươi/mười, lẻ/mốt/tư/lăm, tên nhóm, "đồng") lấy từ catalog domain (XC-I18N-001, D-107); thuật toán
// ghép từ bằng dấu cách giữ nguyên — đầu ra trùng từng byte với bản viết thẳng trước đây (vnd-words.test.ts).
import { t } from "../i18n.ts";

const DIGIT = [
  t("vnd_words.digit_0"),
  t("vnd_words.digit_1"),
  t("vnd_words.digit_2"),
  t("vnd_words.digit_3"),
  t("vnd_words.digit_4"),
  t("vnd_words.digit_5"),
  t("vnd_words.digit_6"),
  t("vnd_words.digit_7"),
  t("vnd_words.digit_8"),
  t("vnd_words.digit_9"),
] as const;
const SCALE = [
  "",
  t("vnd_words.scale_thousand"),
  t("vnd_words.scale_million"),
  t("vnd_words.scale_billion"),
  t("vnd_words.scale_trillion"),
  t("vnd_words.scale_quadrillion"),
] as const;
const HUNDRED = t("vnd_words.hundred");
const TEN = t("vnd_words.ten");
const TENS = t("vnd_words.tens");
const ODD = t("vnd_words.odd");
const ONE_AFTER_TENS = t("vnd_words.one_after_tens");
const FOUR_AFTER_TENS = t("vnd_words.four_after_tens");
const FIVE_AFTER_TENS = t("vnd_words.five_after_tens");
const CURRENCY = t("vnd_words.currency");

/** Đọc nhóm 3 chữ số `n` (0–999). `full`: nhóm không phải nhóm đầu → đọc cả "không trăm" và "lẻ". */
function readGroup(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const tn = Math.floor((n % 100) / 10);
  const u = n % 10;
  const out: string[] = [];
  if (h > 0 || full) out.push(`${DIGIT[h]} ${HUNDRED}`);
  if (tn === 0) {
    if (u > 0) out.push(h > 0 || full ? ODD : "", DIGIT[u] as string);
  } else if (tn === 1) {
    out.push(TEN);
    if (u > 0) out.push(u === 5 ? FIVE_AFTER_TENS : (DIGIT[u] as string));
  } else {
    out.push(`${DIGIT[tn]} ${TENS}`);
    if (u === 1) out.push(ONE_AFTER_TENS);
    else if (u === 4) out.push(FOUR_AFTER_TENS);
    else if (u === 5) out.push(FIVE_AFTER_TENS);
    else if (u > 0) out.push(DIGIT[u] as string);
  }
  return out.filter(Boolean).join(" ");
}

export function vndInWords(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(t("vnd_words.amount_invalid"));
  if (amount === 0) return `${DIGIT[0]} ${CURRENCY}`;
  const groups: number[] = [];
  for (let n = amount; n > 0; n = Math.floor(n / 1000)) groups.push(n % 1000);
  if (groups.length > SCALE.length) throw new RangeError(t("vnd_words.too_large"));
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as number;
    if (g === 0) continue;
    parts.push(readGroup(g, i < groups.length - 1), SCALE[i] as string);
  }
  return `${parts.filter(Boolean).join(" ")} ${CURRENCY}`;
}
