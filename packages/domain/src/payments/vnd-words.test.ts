import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { vndInWords } from "./vnd-words.ts";

// Bản THAM CHIẾU: thuật toán + từ vựng viết thẳng như trước khi chuyển từ vựng sang catalog domain (D-107). Đầu ra của
// `vndInWords` (từ vựng qua t()) phải trùng TỪNG BYTE với bản này trên mọi số — đổi catalog làm lệch câu đọc thì đỏ.
const REF_DIGIT = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"] as const;
const REF_SCALE = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ", "triệu tỷ"] as const;
function refGroup(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const out: string[] = [];
  if (h > 0 || full) out.push(`${REF_DIGIT[h]} trăm`);
  if (t === 0) {
    if (u > 0) out.push(h > 0 || full ? "lẻ" : "", REF_DIGIT[u] as string);
  } else if (t === 1) {
    out.push("mười");
    if (u > 0) out.push(u === 5 ? "lăm" : (REF_DIGIT[u] as string));
  } else {
    out.push(`${REF_DIGIT[t]} mươi`);
    if (u === 1) out.push("mốt");
    else if (u === 4) out.push("tư");
    else if (u === 5) out.push("lăm");
    else if (u > 0) out.push(REF_DIGIT[u] as string);
  }
  return out.filter(Boolean).join(" ");
}
function refWords(amount: number): string {
  if (amount === 0) return "không đồng";
  const groups: number[] = [];
  for (let n = amount; n > 0; n = Math.floor(n / 1000)) groups.push(n % 1000);
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as number;
    if (g === 0) continue;
    parts.push(refGroup(g, i < groups.length - 1), REF_SCALE[i] as string);
  }
  return `${parts.filter(Boolean).join(" ")} đồng`;
}

describe("vndInWords", () => {
  it.each([
    [0, "không đồng"],
    [1, "một đồng"],
    [5, "năm đồng"],
    [10, "mười đồng"],
    [15, "mười lăm đồng"],
    [21, "hai mươi mốt đồng"],
    [24, "hai mươi tư đồng"],
    [25, "hai mươi lăm đồng"],
    [105, "một trăm lẻ năm đồng"],
    [110, "một trăm mười đồng"],
    [1_000, "một nghìn đồng"],
    [1_580_000, "một triệu năm trăm tám mươi nghìn đồng"],
    [3_580_000, "ba triệu năm trăm tám mươi nghìn đồng"],
    [3_000_000, "ba triệu đồng"],
    [2_000_000, "hai triệu đồng"],
    [1_005_000, "một triệu không trăm lẻ năm nghìn đồng"],
    [1_000_001, "một triệu không trăm lẻ một đồng"],
    [100_000, "một trăm nghìn đồng"],
    [2_500_000_000, "hai tỷ năm trăm triệu đồng"],
  ])("%d → %s", (n, words) => {
    expect(vndInWords(n)).toBe(words);
  });

  it("âm / không nguyên / NaN → RangeError", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => vndInWords(bad)).toThrow(RangeError);
  });

  it("đầu ra trùng từng byte bản tham chiếu viết thẳng: 0–2000, mốc nhóm, cực đại, ngẫu nhiên (D-107)", () => {
    for (let n = 0; n <= 2000; n++) expect(vndInWords(n), String(n)).toBe(refWords(n));
    for (const n of [
      1_000_000_000_000,
      1_000_000_000_000_000,
      1_001_001_001_001_001,
      2_014_105_021_000,
      999_999_999_999_999,
      Number.MAX_SAFE_INTEGER,
      101_000_000,
      1_000_010,
      1_100_015,
      20_000_004,
    ])
      expect(vndInWords(n), String(n)).toBe(refWords(n));
    expect(vndInWords(1_000_000_000_000)).toBe("một nghìn tỷ đồng");
    expect(vndInWords(1_000_000_000_000_000)).toBe("một triệu tỷ đồng");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => vndInWords(n) === refWords(n)),
      { numRuns: 2000 },
    );
  });

  it("thông điệp lỗi giữ nguyên câu chữ", () => {
    expect(() => vndInWords(-1)).toThrow(new RangeError("Số tiền phải là số nguyên đồng ≥ 0"));
  });
});
