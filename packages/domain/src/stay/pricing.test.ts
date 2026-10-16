// T-204 — giá đêm thuần: SPEC-reservation-stay S-001, S-002 (Scenario Outline), S-008 (đổi ngày), S-016 (đêm theo ngày kinh doanh).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  isoWeekday,
  maxNightsSetting,
  nightsOf,
  priceNights,
  QuoteRuleError,
  type RateVersion,
  repriceForDates,
  sumNights,
  weekendNightsSetting,
} from "./pricing.ts";

const STD: RateVersion[] = [
  { effectiveFrom: "2026-01-01", effectiveTo: null, weekdayPrice: 600_000, weekendPrice: 700_000 },
];

describe("S-001/S-002 báo giá", () => {
  it("20/10/2026 là thứ Ba (fixture SPEC)", () => expect(isoWeekday("2026-10-20")).toBe(2));

  it("S-001: 20/10 → 22/10 = 2 đêm × 600.000 = 1.200.000", () => {
    const p = priceNights(nightsOf("2026-10-20", "2026-10-22"), STD);
    expect(p).toEqual([
      { businessDate: "2026-10-20", amount: 600_000 },
      { businessDate: "2026-10-21", amount: 600_000 },
    ]);
    expect(sumNights(p)).toBe(1_200_000);
  });

  it.each([
    ["đêm thứ Sáu + thứ Bảy (Q-03)", [5, 6], 2_000_000],
    ["đêm thứ Bảy + Chủ nhật", [6, 7], 1_900_000],
  ])("S-002 %s: 22/10 (thứ Năm) → 25/10 (Chủ nhật)", (_n, weekend, total) => {
    expect(sumNights(priceNights(nightsOf("2026-10-22", "2026-10-25"), STD, weekend))).toBe(total);
  });

  it("đêm không có bảng giá → RATE_NOT_CONFIGURED nêu đúng đêm", () => {
    const rates: RateVersion[] = [
      {
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-10-20",
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
      },
    ];
    expect(() => priceNights(nightsOf("2026-10-20", "2026-10-22"), rates)).toThrow(
      expect.objectContaining({ detail: { code: "RATE_NOT_CONFIGURED", businessDate: "2026-10-21" } }),
    );
  });

  it("đổi bảng giá giữa kỳ: mỗi đêm theo bản hiệu lực của chính đêm đó", () => {
    const rates: RateVersion[] = [
      {
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-10-20",
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
      },
      { effectiveFrom: "2026-10-21", effectiveTo: null, weekdayPrice: 650_000, weekendPrice: 750_000 },
    ];
    expect(sumNights(priceNights(nightsOf("2026-10-20", "2026-10-22"), rates))).toBe(1_250_000);
  });
});

describe("số đêm", () => {
  it("ngày đi phải sau ngày đến; ngày sai định dạng/không tồn tại", () => {
    for (const [a, b] of [
      ["2026-10-22", "2026-10-22"],
      ["2026-10-22", "2026-10-21"],
      ["2026-02-30", "2026-03-02"],
      ["20/10/2026", "2026-10-22"],
    ])
      expect(() => nightsOf(a as string, b as string)).toThrow(QuoteRuleError);
  });

  it("30 đêm được, 31 đêm → MAX_NIGHTS_EXCEEDED (Q-10)", () => {
    expect(nightsOf("2026-10-01", "2026-10-31")).toHaveLength(30);
    expect(() => nightsOf("2026-10-01", "2026-11-01")).toThrow(
      expect.objectContaining({ detail: { code: "MAX_NIGHTS_EXCEEDED", maxNights: 30 } }),
    );
  });

  it("qua cuối tháng/năm và năm nhuận", () => {
    expect(nightsOf("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29"]);
    expect(nightsOf("2026-12-31", "2027-01-01")).toEqual(["2026-12-31"]);
  });

  it("thuộc tính: tổng = Σ từng đêm; số đêm = hiệu ngày; mọi đêm là ngày ngày thường hoặc cuối tuần", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 30 }), (offset, n) => {
        const a = addDays("2026-01-01", offset);
        const nights = nightsOf(a, addDays(a, n));
        const p = priceNights(nights, STD);
        expect(nights).toHaveLength(n);
        expect(sumNights(p)).toBe(p.reduce((s, x) => s + x.amount, 0));
        for (const x of p) expect([600_000, 700_000]).toContain(x.amount);
      }),
    );
  });
});

describe("S-008 đổi ngày (Q-06)", () => {
  const snapshot = [
    { businessDate: "2026-10-20", amount: 600_000 },
    { businessDate: "2026-10-21", amount: 600_000 },
  ];
  it("kéo dài thêm 1 đêm: đêm cũ giữ snapshot, đêm mới giá hiện hành, chênh +600.000", () => {
    const newRates: RateVersion[] = [
      { effectiveFrom: "2026-01-01", effectiveTo: null, weekdayPrice: 650_000, weekendPrice: 750_000 },
    ];
    const r = repriceForDates(snapshot, nightsOf("2026-10-20", "2026-10-23"), STD);
    expect(r.diff).toBe(600_000);
    const r2 = repriceForDates(snapshot, nightsOf("2026-10-20", "2026-10-23"), newRates);
    expect(r2.prices.map((p) => p.amount)).toEqual([600_000, 600_000, 650_000]);
    expect(r2.diff).toBe(650_000);
  });
  it("rút ngắn: chênh âm, đêm còn lại giữ giá cũ", () => {
    const r = repriceForDates(snapshot, nightsOf("2026-10-20", "2026-10-21"), []);
    expect(r).toEqual({
      prices: [{ businessDate: "2026-10-20", amount: 600_000 }],
      total: 600_000,
      diff: -600_000,
    });
  });
});

describe("tham số cơ sở", () => {
  it("weekend_nights sai → mặc định [5, 6]; hợp lệ → chuẩn hoá", () => {
    expect(weekendNightsSetting(undefined)).toEqual([5, 6]);
    expect(weekendNightsSetting([0, 8])).toEqual([5, 6]);
    expect(weekendNightsSetting(["5"])).toEqual([5, 6]);
    expect(weekendNightsSetting([7, 6, 6])).toEqual([6, 7]);
    expect(weekendNightsSetting([])).toEqual([]);
  });
  it("max_nights sai → 30", () => {
    expect(maxNightsSetting(undefined)).toBe(30);
    expect(maxNightsSetting(0)).toBe(30);
    expect(maxNightsSetting(14)).toBe(14);
  });
});
