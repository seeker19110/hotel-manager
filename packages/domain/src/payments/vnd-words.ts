// Đọc số tiền VND thành chữ cho trình đọc màn hình (SPEC-portal §5: "một triệu năm trăm tám mươi nghìn đồng").
// Chỉ phục vụ hiển thị/aria-label; số tiền thật luôn là số nguyên đồng. Âm/không nguyên → RangeError.

const DIGIT = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"] as const;
const SCALE = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ", "triệu tỷ"] as const;

/** Đọc nhóm 3 chữ số `n` (0–999). `full`: nhóm không phải nhóm đầu → đọc cả "không trăm" và "lẻ". */
function readGroup(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const out: string[] = [];
  if (h > 0 || full) out.push(`${DIGIT[h]} trăm`);
  if (t === 0) {
    if (u > 0) out.push(h > 0 || full ? "lẻ" : "", DIGIT[u] as string);
  } else if (t === 1) {
    out.push("mười");
    if (u > 0) out.push(u === 5 ? "lăm" : (DIGIT[u] as string));
  } else {
    out.push(`${DIGIT[t]} mươi`);
    if (u === 1) out.push("mốt");
    else if (u === 4) out.push("tư");
    else if (u === 5) out.push("lăm");
    else if (u > 0) out.push(DIGIT[u] as string);
  }
  return out.filter(Boolean).join(" ");
}

export function vndInWords(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Số tiền phải là số nguyên đồng ≥ 0");
  if (amount === 0) return "không đồng";
  const groups: number[] = [];
  for (let n = amount; n > 0; n = Math.floor(n / 1000)) groups.push(n % 1000);
  if (groups.length > SCALE.length) throw new RangeError("Số tiền quá lớn để đọc");
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as number;
    if (g === 0) continue;
    parts.push(readGroup(g, i < groups.length - 1), SCALE[i] as string);
  }
  return `${parts.filter(Boolean).join(" ")} đồng`;
}
