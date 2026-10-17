import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertBalanced, lineAmount, parseDecimal, roundVnd, sumVnd } from "./money.ts";

describe("ví dụ kế hoạch §05/§06 (tính lại bằng hàm dùng chung)", () => {
  it("phiếu trọ: 3.000.000 + 100 kWh × 3.000 + 12 m³ × 15.000 + 100.000 = 3.580.000; còn 1.580.000", () => {
    const lines = [
      lineAmount("1", "3000000"),
      lineAmount(String(1350 - 1250), "3000"),
      lineAmount("12", "15000"),
      lineAmount("1", "100000"),
    ];
    expect(lines).toEqual([3_000_000, 300_000, 180_000, 100_000]);
    const total = sumVnd(lines);
    expect(total).toBe(3_580_000);
    expect(total - 2_000_000).toBe(1_580_000);
  });

  it("khách sạn: 2 đêm × 600.000 + 80.000 + 150.000 = 1.430.000; ứng trước 500.000 → 930.000", () => {
    const total = sumVnd([lineAmount("2", "600000"), 80_000, 150_000]);
    expect(total).toBe(1_430_000);
    expect(total - 500_000).toBe(930_000);
  });
});

describe("làm tròn (IND-FIN-012) — một hàm, ca biên", () => {
  it.each([
    ["0", "3000", "HALF_UP_1", 0],
    ["1", "1", "HALF_UP_1", 1],
    ["0.5", "1", "HALF_UP_1", 1],
    ["0.49", "1", "HALF_UP_1", 0],
    ["12.345", "1000", "HALF_UP_1", 12345],
    ["1.5", "3001", "HALF_UP_1", 4502], // 4501.5 → 4502
    ["100.25", "2500", "HALF_UP_1", 250625],
    ["9001.5", "1", "HALF_UP_1", 9002],
    ["1", "1499", "HALF_UP_1000", 1000],
    ["1", "1500", "HALF_UP_1000", 2000],
    ["3.333", "1000", "HALF_UP_1000", 3000],
  ] as const)("%s × %s (%s) = %d", (q, p, rule, expected) => {
    expect(lineAmount(q, p, rule)).toBe(expected);
  });

  it("từ chối số thực/định dạng lạ, không đoán", () => {
    for (const bad of ["1e3", "1,5", "abc", "", "1.1234567891"]) expect(() => parseDecimal(bad)).toThrow();
    expect(() => sumVnd([1.5])).toThrow();
  });

  it("property: kết quả là số nguyên, sai lệch ≤ nửa đơn vị, đơn điệu theo lượng", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (qi, qf, price) => {
          const q = `${qi}.${String(qf).padStart(3, "0")}`;
          const v = lineAmount(q, String(price));
          expect(Number.isSafeInteger(v)).toBe(true);
          const exactMilli = BigInt(qi * 1000 + qf) * BigInt(price); // ×1000
          expect(Math.abs(Number(BigInt(v) * 1000n - exactMilli))).toBeLessThanOrEqual(500);
          const q2 = `${qi}.${String(Math.min(qf + 1, 999)).padStart(3, "0")}`;
          expect(lineAmount(q2, String(price))).toBeGreaterThanOrEqual(v);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("roundVnd âm: nửa đi xa số 0 (đối xứng)", () => {
    expect(roundVnd("-0.5")).toBe(-1);
    expect(roundVnd("-1499.4", "HALF_UP_1000")).toBe(-1000);
  });
});

describe("cân đối bút toán (INV-F1 tầng domain)", () => {
  it("cân → ok; lệch / 1 dòng / dòng hai phía / số thực → lỗi", () => {
    expect(() =>
      assertBalanced([
        { account: "AR", debit: 3_580_000, credit: 0 },
        { account: "REV_ROOM", debit: 0, credit: 3_000_000 },
        { account: "REV_UTIL", debit: 0, credit: 480_000 },
        { account: "REV_FEE", debit: 0, credit: 100_000 },
      ]),
    ).not.toThrow();
    expect(() => assertBalanced([{ account: "AR", debit: 1, credit: 0 }])).toThrow(/2 dòng/);
    expect(() =>
      assertBalanced([
        { account: "AR", debit: 2, credit: 0 },
        { account: "REV_FEE", debit: 0, credit: 1 },
      ]),
    ).toThrow(/lệch/);
    expect(() =>
      assertBalanced([
        { account: "AR", debit: 1, credit: 1 },
        { account: "REV_FEE", debit: 0, credit: 0 },
      ]),
    ).toThrow(/một phía/);
    expect(() =>
      assertBalanced([
        { account: "AR", debit: 1.5, credit: 0 },
        { account: "REV_FEE", debit: 0, credit: 1.5 },
      ]),
    ).toThrow(/nguyên/);
  });
});

describe("đơn giá lẻ (IND-FIN-001, ADR-0003) — không qua số thực", () => {
  it("10,001 đ × 1 → 10 đ; 10,5 đ × 1 → 11 đ (nửa lên); 0,1 × 3 = 0 (không sai số float)", () => {
    expect(lineAmount("1", "10.001")).toBe(10);
    expect(lineAmount("1", "10.5")).toBe(11);
    expect(lineAmount("3", "0.1")).toBe(0);
    expect(lineAmount("30", "0.1")).toBe(3);
    expect(lineAmount("0", "10.001")).toBe(0);
  });
});
