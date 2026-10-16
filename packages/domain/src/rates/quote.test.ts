// T-203 — engine báo giá thuần (SPEC-reservation-stay S-001, S-002, S-016, S-017, S-021, Q-02, Q-03, Q-12).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { businessDateOf, weekdayOf } from "./dates.ts";
import { RateError } from "./errors.ts";
import { MAX_QUOTE_NIGHTS, type QuoteInput, quoteStay, type RatePlan } from "./quote.ts";

/** Fixture SPEC: STD ngày thường 600.000, cuối tuần 700.000; hiệu lực từ đầu năm, không thời hạn. */
const STD: RatePlan = {
  id: "rp-std-1",
  weekdayPrice: 600_000,
  weekendPrice: 700_000,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

const quote = (arrivalDate: string, departureDate: string, over: Partial<QuoteInput> = {}) =>
  quoteStay({ arrivalDate, departureDate, ratePlans: [STD], ...over });

const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RateError) return e.reason;
    throw e;
  }
  return undefined;
};

const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("quy ước thứ trong tuần", () => {
  it("0 = Chủ nhật … 6 = thứ Bảy (JS), khớp fixture 20/10/2026 là thứ Ba", () => {
    expect(weekdayOf("2026-10-20")).toBe(2);
    expect(weekdayOf("2026-10-22")).toBe(4); // thứ Năm
    expect(weekdayOf("2026-10-23")).toBe(5); // thứ Sáu
    expect(weekdayOf("2026-10-24")).toBe(6); // thứ Bảy
    expect(weekdayOf("2026-10-25")).toBe(0); // Chủ nhật
  });
});

describe("S-001 báo giá ngày thường", () => {
  it("20/10 → 22/10: 2 đêm × 600.000 = 1.200.000", () => {
    const q = quote("2026-10-20", "2026-10-22");
    expect(q.nightCount).toBe(2);
    expect(q.nights).toEqual([
      { businessDate: "2026-10-20", dayKind: "weekday", amount: 600_000, ratePlanId: "rp-std-1" },
      { businessDate: "2026-10-21", dayKind: "weekday", amount: 600_000, ratePlanId: "rp-std-1" },
    ]);
    expect(q.total).toBe(1_200_000);
  });
});

describe("S-002 ngày thường/cuối tuần theo business_date của từng đêm", () => {
  it("cuối tuần = thứ Sáu + thứ Bảy (mặc định [5,6]) → 2.000.000", () => {
    const q = quote("2026-10-22", "2026-10-25");
    expect(q.nights.map((n) => [n.businessDate, n.dayKind, n.amount])).toEqual([
      ["2026-10-22", "weekday", 600_000],
      ["2026-10-23", "weekend", 700_000],
      ["2026-10-24", "weekend", 700_000],
    ]);
    expect(q.total).toBe(2_000_000);
  });

  it("cuối tuần = thứ Bảy + Chủ nhật ([6,0]) → 1.900.000", () => {
    const q = quote("2026-10-22", "2026-10-25", { weekendNights: [6, 0] });
    expect(q.nights.map((n) => n.dayKind)).toEqual(["weekday", "weekday", "weekend"]);
    expect(q.total).toBe(1_900_000);
  });

  it("đêm Chủ nhật (đêm trước ngày đi thứ Hai) là ngày thường theo mặc định", () => {
    const q = quote("2026-10-25", "2026-10-26");
    expect(q.nights[0]?.dayKind).toBe("weekday");
    expect(q.total).toBe(600_000);
  });

  it("tập cuối tuần rỗng → mọi đêm là ngày thường; ghi đè theo bản giá thắng đầu vào", () => {
    expect(quote("2026-10-23", "2026-10-25", { weekendNights: [] }).total).toBe(1_200_000);
    const plan = { ...STD, weekendNights: [0] };
    const q = quoteStay({ arrivalDate: "2026-10-24", departureDate: "2026-10-26", ratePlans: [plan] });
    expect(q.nights.map((n) => n.dayKind)).toEqual(["weekday", "weekend"]);
    expect(q.total).toBe(1_300_000);
  });

  it("tập cuối tuần sai (ISO 7, âm, thập phân) → lỗi", () => {
    for (const bad of [[7], [-1], [1.5]]) {
      expect(reasonOf(() => quote("2026-10-20", "2026-10-22", { weekendNights: bad }))).toBe(
        "INVALID_WEEKEND_NIGHTS",
      );
    }
    expect(
      reasonOf(() => quote("2026-10-20", "2026-10-22", { ratePlans: [{ ...STD, weekendNights: [9] }] })),
    ).toBe("INVALID_WEEKEND_NIGHTS");
  });
});

describe("S-016 qua 00:00 không tạo sai một đêm", () => {
  it("businessDateOf: trước giờ chốt thuộc ngày hôm trước, từ giờ chốt trở đi thuộc ngày đó", () => {
    expect(businessDateOf("2026-10-16T01:30", "04:00")).toBe("2026-10-15");
    expect(businessDateOf("2026-10-16T03:59", "04:00")).toBe("2026-10-15");
    expect(businessDateOf("2026-10-16T04:00", "04:00")).toBe("2026-10-16");
    expect(businessDateOf("2026-10-16 15:10:30", "04:00")).toBe("2026-10-16");
    expect(businessDateOf("2026-10-16T00:00", "00:00")).toBe("2026-10-16"); // cho thuê: không lùi ngày
  });

  it("businessDateOf lùi qua ranh tháng/năm/năm nhuận", () => {
    expect(businessDateOf("2026-11-01T02:00", "04:00")).toBe("2026-10-31");
    expect(businessDateOf("2027-01-01T00:30", "04:00")).toBe("2026-12-31");
    expect(businessDateOf("2028-03-01T00:30", "04:00")).toBe("2028-02-29");
  });

  it("businessDateOf: đầu vào sai → lỗi", () => {
    for (const bad of ["2026-10-16", "2026-10-16T24:00", "2026-02-30T10:00", "16/10/2026 01:30", ""]) {
      expect(reasonOf(() => businessDateOf(bad, "04:00"))).toBe("INVALID_DATE");
    }
    expect(reasonOf(() => businessDateOf("2026-10-16T10:00", "4h"))).toBe("INVALID_DATE");
  });

  it("(b) walk-in 16/10 01:30, đi 16/10 → đêm 15/10 (thứ Năm), 1 đêm 600.000, không lỗi ngày đi", () => {
    const arrival = businessDateOf("2026-10-16T01:30", "04:00");
    const q = quote(arrival, "2026-10-16");
    expect(q.nightCount).toBe(1);
    expect(q.nights[0]).toMatchObject({ businessDate: "2026-10-15", dayKind: "weekday", amount: 600_000 });
    expect(q.total).toBe(600_000);
  });

  it("(a) giá chỉ theo ngày kinh doanh, không theo đồng hồ: 20/10 → 22/10 vẫn đúng 2 đêm", () => {
    expect(quote("2026-10-20", "2026-10-22").nightCount).toBe(2);
  });

  it("nếu bên gọi quên đổi ngày đến về ngày kinh doanh (ngày đi = ngày đến) → lỗi rõ", () => {
    expect(reasonOf(() => quote("2026-10-16", "2026-10-16"))).toBe("DEPARTURE_NOT_AFTER_ARRIVAL");
  });
});

describe("S-017 folio ví dụ bắt buộc", () => {
  it("20/10 → 22/10 = 2 × 600.000 = 1.200.000 (REV_ROOM); + 80.000 + 150.000 = 1.430.000", () => {
    const q = quote("2026-10-20", "2026-10-22");
    expect(q.total).toBe(1_200_000);
    expect(q.total + 80_000 + 150_000).toBe(1_430_000);
  });
});

describe("S-021 snapshot và hiệu lực theo đêm", () => {
  it("đổi bảng giá không ảnh hưởng booking đã giữ; booking mới báo giá mới", () => {
    const held = quote("2026-10-20", "2026-10-22");
    expect(held.total).toBe(1_200_000);
    const raised: RatePlan = { ...STD, weekdayPrice: 650_000 };
    // Booking đã giữ: dựng lại từ snapshot, bảng giá mới không được dùng.
    const rebuilt = quoteStay({
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      ratePlans: [raised],
      nightlyRates: held.nights.map((n) => ({
        businessDate: n.businessDate,
        amount: n.amount,
        ...(n.ratePlanId === undefined ? {} : { ratePlanId: n.ratePlanId }),
      })),
    });
    expect(rebuilt).toEqual(held);
    // Booking mới: 650.000/đêm.
    expect(
      quoteStay({ arrivalDate: "2026-10-20", departureDate: "2026-10-22", ratePlans: [raised] }).total,
    ).toBe(1_300_000);
  });

  it("đổi ngày (S-008): đêm cũ giữ snapshot, đêm mới lấy giá hiện hành → chênh +650.000", () => {
    const snapshot = [
      { businessDate: "2026-10-20", amount: 600_000 },
      { businessDate: "2026-10-21", amount: 600_000 },
    ];
    const q = quoteStay({
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-23",
      ratePlans: [{ ...STD, weekdayPrice: 650_000 }],
      nightlyRates: snapshot,
    });
    expect(q.nights.map((n) => n.amount)).toEqual([600_000, 600_000, 650_000]);
    expect(q.total - 1_200_000).toBe(650_000);
  });

  it("đổi bảng giá giữa kỳ: mỗi đêm dùng bản hiệu lực của đêm đó, kể cả ngày biên", () => {
    const old: RatePlan = { ...STD, id: "old", effectiveTo: "2026-10-21" };
    const next: RatePlan = { ...STD, id: "new", weekdayPrice: 650_000, effectiveFrom: "2026-10-22" };
    const q = quote("2026-10-20", "2026-10-24", { ratePlans: [next, old] });
    expect(q.nights.map((n) => [n.businessDate, n.amount, n.ratePlanId])).toEqual([
      ["2026-10-20", 600_000, "old"],
      ["2026-10-21", 600_000, "old"],
      ["2026-10-22", 650_000, "new"],
      ["2026-10-23", 700_000, "new"],
    ]);
    expect(q.total).toBe(2_550_000);
  });

  it("không có giá cho một đêm (trước hiệu lực / hết hạn / không có bản giá) → lỗi, không đoán", () => {
    const late: RatePlan = { ...STD, effectiveFrom: "2026-10-21" };
    expect(reasonOf(() => quote("2026-10-20", "2026-10-22", { ratePlans: [late] }))).toBe(
      "NO_RATE_FOR_NIGHT",
    );
    const ended: RatePlan = { ...STD, effectiveTo: "2026-10-20" };
    expect(reasonOf(() => quote("2026-10-20", "2026-10-22", { ratePlans: [ended] }))).toBe(
      "NO_RATE_FOR_NIGHT",
    );
    expect(reasonOf(() => quoteStay({ arrivalDate: "2026-10-20", departureDate: "2026-10-22" }))).toBe(
      "NO_RATE_FOR_NIGHT",
    );
    expect(reasonOf(() => quote("2026-10-20", "2026-10-22", { ratePlans: [] }))).toBe("NO_RATE_FOR_NIGHT");
  });

  it("hai bản giá chồng hiệu lực trong một đêm → lỗi mơ hồ", () => {
    const dup: RatePlan = { ...STD, id: "dup" };
    expect(reasonOf(() => quote("2026-10-20", "2026-10-21", { ratePlans: [STD, dup] }))).toBe(
      "AMBIGUOUS_RATE",
    );
  });

  it("snapshot trùng ngày / giá âm / không phải số nguyên → lỗi; giá 0 hợp lệ (tặng đêm)", () => {
    const night = { businessDate: "2026-10-20", amount: 0 };
    expect(quote("2026-10-20", "2026-10-21", { nightlyRates: [night], ratePlans: [] }).total).toBe(0);
    expect(reasonOf(() => quote("2026-10-20", "2026-10-21", { nightlyRates: [night, night] }))).toBe(
      "AMBIGUOUS_RATE",
    );
    expect(
      reasonOf(() => quote("2026-10-20", "2026-10-21", { nightlyRates: [{ ...night, amount: -1 }] })),
    ).toBe("INVALID_RATE_PLAN");
    expect(() => quote("2026-10-20", "2026-10-21", { nightlyRates: [{ ...night, amount: 1.5 }] })).toThrow();
  });

  it("bản giá không hợp lệ: giá ≤ 0, không nguyên, hiệu lực ngược", () => {
    for (const bad of [
      { ...STD, weekdayPrice: 0 },
      { ...STD, weekendPrice: -5 },
      { ...STD, weekdayPrice: 600_000.5 },
      { ...STD, effectiveFrom: "2026-10-10", effectiveTo: "2026-10-09" },
    ]) {
      expect(reasonOf(() => quote("2026-10-20", "2026-10-21", { ratePlans: [bad] }))).toBe(
        "INVALID_RATE_PLAN",
      );
    }
  });
});

describe("ca biên đầu vào", () => {
  it("ngày đi trước hoặc bằng ngày đến → lỗi", () => {
    expect(reasonOf(() => quote("2026-10-22", "2026-10-22"))).toBe("DEPARTURE_NOT_AFTER_ARRIVAL");
    expect(reasonOf(() => quote("2026-10-22", "2026-10-20"))).toBe("DEPARTURE_NOT_AFTER_ARRIVAL");
  });

  it("ngày không hợp lệ (định dạng, 30/02, rỗng) → lỗi", () => {
    for (const bad of ["", "2026-02-30", "20/10/2026", "2026-1-5", "2026-10-20T10:00"]) {
      expect(reasonOf(() => quote(bad, "2026-11-01"))).toBe("INVALID_DATE");
      expect(reasonOf(() => quote("2026-10-01", bad))).toBe("INVALID_DATE");
    }
  });

  it("đúng 365 đêm được báo; 366 đêm → STAY_TOO_LONG", () => {
    expect(quote("2026-01-01", "2027-01-01").nightCount).toBe(MAX_QUOTE_NIGHTS);
    expect(reasonOf(() => quote("2026-01-01", "2027-01-02"))).toBe("STAY_TOO_LONG");
  });

  it("maxNights nghiệp vụ (Q-10 đề xuất 30) chặn sớm hơn; giá trị sai → lỗi", () => {
    expect(quote("2026-10-01", "2026-10-31", { maxNights: 30 }).nightCount).toBe(30);
    expect(reasonOf(() => quote("2026-10-01", "2026-11-01", { maxNights: 30 }))).toBe("STAY_TOO_LONG");
    for (const bad of [0, -1, 1.5, 366]) {
      expect(reasonOf(() => quote("2026-10-01", "2026-10-02", { maxNights: bad }))).toBe("INVALID_LIMIT");
    }
  });

  it("qua ranh tháng, năm và ngày nhuận 29/02/2028 (thứ Ba) đủ số đêm, đúng ngày", () => {
    const q = quote("2028-02-27", "2028-03-02");
    expect(q.nights.map((n) => n.businessDate)).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    const y = quote("2026-12-30", "2027-01-02");
    expect(y.nights.map((n) => n.businessDate)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("giá lớn vẫn là số nguyên đồng, không làm tròn: 365 đêm × 4.000.000", () => {
    const rich: RatePlan = { ...STD, weekdayPrice: 4_000_000, weekendPrice: 4_000_000 };
    expect(quote("2026-01-01", "2027-01-01", { ratePlans: [rich] }).total).toBe(1_460_000_000);
  });

  it("ratePlanId chỉ có khi nguồn giá có id (snapshot không id → không có khoá)", () => {
    const q = quote("2026-10-20", "2026-10-21", {
      ratePlans: [],
      nightlyRates: [{ businessDate: "2026-10-20", amount: 1 }],
    });
    expect(q.nights[0]).toEqual({ businessDate: "2026-10-20", dayKind: "weekday", amount: 1 });
    expect("ratePlanId" in (q.nights[0] ?? {})).toBe(false);
  });
});

describe("property test (fast-check)", () => {
  const dateArb = fc.integer({ min: 0, max: 3000 }).map((n) => addDays("2024-01-01", n));
  const nightsArb = fc.integer({ min: 1, max: 120 });
  const priceArb = fc.integer({ min: 1, max: 50_000_000 });
  const weekendArb = fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 7 });

  // Một hoặc hai bản giá liền kề, điểm đổi giá ở ngày `cut` bất kỳ (kể cả ngoài khoảng).
  const plansArb = fc
    .record({
      a: priceArb,
      b: priceArb,
      c: priceArb,
      d: priceArb,
      cutOffset: fc.integer({ min: -5, max: 130 }),
    })
    .map(({ a, b, c, d, cutOffset }) => (start: string): RatePlan[] => [
      {
        id: "p1",
        weekdayPrice: a,
        weekendPrice: b,
        effectiveFrom: "2000-01-01",
        effectiveTo: addDays(start, cutOffset - 1),
      },
      {
        id: "p2",
        weekdayPrice: c,
        weekendPrice: d,
        effectiveFrom: addDays(start, cutOffset),
        effectiveTo: null,
      },
    ]);

  it("Σ đêm = total; mọi amount ≥ 0 nguyên; số đêm = số ngày giữa hai mốc; đêm liên tiếp đúng thứ tự", () => {
    fc.assert(
      fc.property(dateArb, nightsArb, plansArb, weekendArb, (start, n, mk, weekend) => {
        const end = addDays(start, n);
        const q = quoteStay({
          arrivalDate: start,
          departureDate: end,
          ratePlans: mk(start),
          weekendNights: weekend,
        });
        expect(q.nightCount).toBe(n);
        expect(q.nights).toHaveLength(n);
        expect(q.total).toBe(q.nights.reduce((s, x) => s + x.amount, 0));
        q.nights.forEach((x, i) => {
          expect(Number.isSafeInteger(x.amount) && x.amount >= 0).toBe(true);
          expect(x.businessDate).toBe(addDays(start, i));
          expect(x.dayKind).toBe(weekend.includes(weekdayOf(x.businessDate)) ? "weekend" : "weekday");
        });
      }),
      { numRuns: 1000 },
    );
  });

  it("thêm một đêm vào cuối không đổi giá các đêm trước", () => {
    fc.assert(
      fc.property(dateArb, nightsArb, plansArb, weekendArb, (start, n, mk, weekend) => {
        const base = { arrivalDate: start, ratePlans: mk(start), weekendNights: weekend };
        const short = quoteStay({ ...base, departureDate: addDays(start, n) });
        const long = quoteStay({ ...base, departureDate: addDays(start, n + 1) });
        expect(long.nights.slice(0, n)).toEqual(short.nights);
        expect(long.total - short.total).toBe(long.nights[n]?.amount);
      }),
      { numRuns: 1000 },
    );
  });

  it("báo giá từ snapshot cho đúng kết quả cũ dù bảng giá đã đổi hoàn toàn (S-021)", () => {
    fc.assert(
      fc.property(dateArb, nightsArb, plansArb, weekendArb, priceArb, (start, n, mk, weekend, other) => {
        const end = addDays(start, n);
        const first = quoteStay({
          arrivalDate: start,
          departureDate: end,
          ratePlans: mk(start),
          weekendNights: weekend,
        });
        const changed: RatePlan = {
          id: "z",
          weekdayPrice: other,
          weekendPrice: other,
          effectiveFrom: "2000-01-01",
          effectiveTo: null,
        };
        const again = quoteStay({
          arrivalDate: start,
          departureDate: end,
          ratePlans: [changed],
          weekendNights: weekend,
          nightlyRates: first.nights.map((x) => ({
            businessDate: x.businessDate,
            amount: x.amount,
            ratePlanId: x.ratePlanId ?? "",
          })),
        });
        expect(again.total).toBe(first.total);
        expect(again.nights.map((x) => x.amount)).toEqual(first.nights.map((x) => x.amount));
      }),
      { numRuns: 500 },
    );
  });

  it("ngày đi ≤ ngày đến luôn là lỗi; khoảng > 365 đêm luôn là lỗi", () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: 0, max: 400 }), (start, back) => {
        expect(reasonOf(() => quote(start, addDays(start, -back)))).toBe("DEPARTURE_NOT_AFTER_ARRIVAL");
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(dateArb, fc.integer({ min: 366, max: 2000 }), (start, n) => {
        expect(reasonOf(() => quote(start, addDays(start, n)))).toBe("STAY_TOO_LONG");
      }),
      { numRuns: 300 },
    );
  });

  it("businessDateOf: luôn là ngày đó hoặc hôm trước, và đơn điệu theo giờ", () => {
    const hhmm = fc
      .integer({ min: 0, max: 1439 })
      .map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    fc.assert(
      fc.property(dateArb, hhmm, hhmm, (d, t, cutoff) => {
        const r = businessDateOf(`${d}T${t}`, cutoff);
        expect(r).toBe(t < cutoff ? addDays(d, -1) : d);
      }),
      { numRuns: 500 },
    );
  });
});
