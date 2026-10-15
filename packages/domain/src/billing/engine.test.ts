// T-113 — engine tính tiền thuần (SPEC-metering-billing S-001, S-016, S-018…S-021).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lineAmount, prorate } from "../money/money.ts";
import { computeLeaseInvoice, daysInMonth, type LeaseBillingInput, rentLines } from "./engine.ts";

const base = (over: Partial<LeaseBillingInput> = {}): LeaseBillingInput => ({
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  billingStartOn: "2026-01-01",
  movedOutOn: null,
  versions: [{ id: "v1", from: "2026-01-01", to: null, rentAmount: 3_000_000 }],
  metered: [],
  services: [],
  occupantsAtEnd: 1,
  ...over,
});

describe("S-001 kỳ chuẩn 3.580.000 đ", () => {
  it("tiền thuê + điện 100 × 3.000 + nước 12 × 15.000 + phí khác 100.000", () => {
    const r = computeLeaseInvoice(
      base({
        metered: [
          {
            serviceId: "e",
            name: "Điện",
            revenueAccount: "REV_UTIL",
            start: "1250",
            end: "1350",
            unitPrice: "3000",
          },
          { serviceId: "w", name: "Nước", revenueAccount: "REV_UTIL", quantity: "12", unitPrice: "15000" },
        ],
        services: [
          {
            serviceId: "f",
            name: "Phí khác",
            kind: "fixed_per_unit",
            revenueAccount: "REV_FEE",
            unitPrice: "100000",
          },
        ],
      }),
    );
    expect(r.lines.map((l) => [l.kind, l.revenueAccount, l.quantity, l.unitPrice, l.amount])).toEqual([
      ["room", "REV_ROOM", "31", "3000000", 3_000_000],
      ["utility", "REV_UTIL", "100", "3000", 300_000],
      ["utility", "REV_UTIL", "12", "15000", 180_000],
      ["service", "REV_FEE", "1", "100000", 100_000],
    ]);
    expect(r.total).toBe(3_580_000);
    expect(r.lines.every((l) => l.roundingRule === "HALF_UP_1" && l.formulaVersion === 1)).toBe(true);
  });
});

describe("S-016, S-017 phí theo người, một lần, chưa hiệu lực", () => {
  it("rác 2 × 20.000; làm chìa 50.000 REV_FEE; wifi chưa có giá → không dòng", () => {
    const r = computeLeaseInvoice(
      base({
        occupantsAtEnd: 2,
        services: [
          {
            serviceId: "r",
            name: "Rác",
            kind: "per_person",
            revenueAccount: "REV_SERVICE",
            unitPrice: "20000",
          },
          {
            serviceId: "k",
            name: "Làm chìa",
            kind: "one_time",
            revenueAccount: "REV_FEE",
            unitPrice: "50000",
          },
          {
            serviceId: "wifi",
            name: "Wifi",
            kind: "fixed_per_unit",
            revenueAccount: "REV_SERVICE",
            unitPrice: null,
          },
        ],
      }),
    );
    const svc = r.lines.filter((l) => l.kind !== "room");
    expect(svc.map((l) => [l.description, l.kind, l.revenueAccount, l.amount])).toEqual([
      ["Rác (2 người)", "service", "REV_SERVICE", 40_000],
      ["Làm chìa", "fee", "REV_FEE", 50_000],
    ]);
  });
});

describe("S-018 prorata kỳ lẻ (Scenario Outline)", () => {
  it.each([
    [3_000_000, 31, 31, 3_000_000],
    [3_000_000, 15, 31, 1_451_613],
    [3_000_000, 10, 31, 967_742],
    [3_000_000, 1, 31, 96_774],
    [3_000_000, 14, 28, 1_500_000],
    [2_500_000, 1, 28, 89_286],
    [3_000_000, 29, 29, 3_000_000],
    [3_000_000, 15, 30, 1_500_000],
    [0, 10, 31, 0],
    [1, 1, 31, 0],
    [1, 16, 31, 1],
  ])("giá %d, %d/%d ngày → %d", (gia, ngay, thang, tien) => {
    expect(prorate(gia, ngay, thang)).toBe(tien);
  });

  it("bắt đầu 17/10 và trả 10/10 qua engine (ngày đầu, ngày cuối đều tính)", () => {
    expect(rentLines(base({ billingStartOn: "2026-10-17" }))[0]).toMatchObject({
      amount: 1_451_613,
      quantity: "15",
      denominator: 31,
      periodFrom: "2026-10-17",
      periodTo: "2026-10-31",
    });
    expect(rentLines(base({ movedOutOn: "2026-10-10" }))[0]).toMatchObject({
      amount: 967_742,
      periodTo: "2026-10-10",
    });
    expect(rentLines(base({ billingStartOn: "2026-11-05" }))).toEqual([]);
    expect(rentLines(base({ prorata: "fixed_30", billingStartOn: "2026-10-17" }))[0]?.amount).toBe(1_500_000);
  });
});

describe("S-019 dòng theo chỉ số (Scenario Outline)", () => {
  it.each([
    ["1250", "1350", "3000", "100", 300_000],
    ["1250", "1250", "3000", "0", 0],
    ["1250", "1251", "1", "1", 1],
    ["100.5", "112.7", "15000", "12.2", 183_000],
    ["1250", "1253", "3000.5", "3", 9_002],
  ])("đầu %s, cuối %s, đơn giá %s → lượng %s, %d đ", (dau, cuoi, gia, luong, tien) => {
    const r = computeLeaseInvoice(
      base({
        versions: [],
        metered: [
          { serviceId: "e", name: "Điện", revenueAccount: "REV_UTIL", start: dau, end: cuoi, unitPrice: gia },
        ],
      }),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ quantity: luong, amount: tien });
  });

  it("chỉ số cuối < đầu → lỗi (không âm)", () => {
    expect(() =>
      computeLeaseInvoice(
        base({
          metered: [
            {
              serviceId: "e",
              name: "Điện",
              revenueAccount: "REV_UTIL",
              start: "10",
              end: "9",
              unitPrice: "1",
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe("S-021 đổi giá giữa kỳ", () => {
  it("3.000.000 đến 14/11, 3.300.000 từ 15/11 → 1.400.000 + 1.760.000 = 3.160.000, mỗi dòng ghi phiên bản", () => {
    const lines = rentLines(
      base({
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
        versions: [
          { id: "v2", from: "2026-11-15", to: null, rentAmount: 3_300_000 },
          { id: "v1", from: "2026-01-01", to: "2026-11-14", rentAmount: 3_000_000 },
        ],
      }),
    );
    expect(lines.map((l) => [l.leaseVersionId, l.amount, l.periodFrom, l.periodTo])).toEqual([
      ["v1", 1_400_000, "2026-11-01", "2026-11-14"],
      ["v2", 1_760_000, "2026-11-15", "2026-11-30"],
    ]);
  });
});

describe("S-020 property test (fast-check ≥ 1.000 bộ)", () => {
  const month = fc.integer({ min: 0, max: 47 }).map((i) => {
    const y = 2026 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, "0");
    return `${y}-${m}`;
  });

  it("tổng = Σ dòng; mọi dòng nguyên ≥ 0; trọn tháng = giá; prorata ≤ giá và không giảm theo số ngày", () => {
    fc.assert(
      fc.property(
        month,
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom("HALF_UP_1" as const, "HALF_UP_1000" as const),
        (ym, rent, startDay, kwh, people, rounding) => {
          const dim = daysInMonth(`${ym}-01`);
          const sd = Math.min(startDay, dim);
          const r = computeLeaseInvoice({
            periodStart: `${ym}-01`,
            periodEnd: `${ym}-${String(dim).padStart(2, "0")}`,
            billingStartOn: `${ym}-${String(sd).padStart(2, "0")}`,
            movedOutOn: null,
            versions: [{ id: "v", from: "2026-01-01", to: null, rentAmount: rent }],
            metered: [
              {
                serviceId: "e",
                name: "Điện",
                revenueAccount: "REV_UTIL",
                quantity: String(kwh),
                unitPrice: "3500.5",
              },
            ],
            services: [
              {
                serviceId: "r",
                name: "Rác",
                kind: "per_person",
                revenueAccount: "REV_SERVICE",
                unitPrice: "20000",
              },
            ],
            occupantsAtEnd: people,
            rounding,
          });
          expect(r.total).toBe(r.lines.reduce((s, l) => s + l.amount, 0));
          for (const l of r.lines) expect(Number.isSafeInteger(l.amount) && l.amount >= 0).toBe(true);
          const room = r.lines.find((l) => l.kind === "room");
          if (sd === 1 && rounding === "HALF_UP_1") expect(room?.amount).toBe(rent);
          const days = dim - sd + 1;
          expect(prorate(rent, days, dim)).toBeLessThanOrEqual(rent);
          if (days > 1) expect(prorate(rent, days, dim)).toBeGreaterThanOrEqual(prorate(rent, days - 1, dim));
          expect(lineAmount(String(kwh), "3500.5")).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("money: trừ thập phân, kiểm số chữ số thập phân", () => {
  it.each([
    ["112.7", "100.5", "12.2"],
    ["1350", "1250", "100"],
    ["10", "10.001", "-0.001"],
    ["0.1", "0.1", "0"],
  ])("%s − %s = %s", async (a, b, c) => {
    const { decimalSub } = await import("../money/money.ts");
    expect(decimalSub(a, b)).toBe(c);
  });
  it("hasMaxDecimals", async () => {
    const { hasMaxDecimals } = await import("../money/money.ts");
    expect([
      hasMaxDecimals(12.345, 3),
      hasMaxDecimals(12.3456, 3),
      hasMaxDecimals(1e21, 3),
      hasMaxDecimals(Number.NaN, 3),
    ]).toEqual([true, false, true, false]);
  });
});
