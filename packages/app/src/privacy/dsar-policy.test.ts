// PLAN T-2311 (CMP-VN-007, CMP-INTL-007; D-123) — hạn DSAR theo vùng (một nơi) và ngưỡng xác thực lại: thuần, không I/O.
import { describe, expect, it } from "vitest";
import { isRecentReauth } from "./dsar.ts";
import {
  DSAR_DAYS,
  DSAR_DEFAULT_REGION,
  DSAR_REAUTH_MAX_AGE_SECONDS,
  DSAR_REGIONS,
  DSAR_TYPES,
  dsarDays,
  dsarDueAt,
  isDsarRegion,
} from "./dsar-policy.ts";

describe("dsar_days theo vùng (D-123)", () => {
  it("VN: xoá 3, truy cập 10, hạn chế 3; EU/UK/SG/TH 30; CA 45", () => {
    expect(DSAR_DAYS.VN).toEqual({ access: 10, delete: 3, restrict: 3 });
    for (const r of ["EU", "UK", "SG", "TH"] as const)
      expect(DSAR_DAYS[r]).toEqual({ access: 30, delete: 30, restrict: 30 });
    expect(DSAR_DAYS.CA).toEqual({ access: 45, delete: 45, restrict: 45 });
    expect(DSAR_DEFAULT_REGION).toBe("VN");
  });

  it("mọi vùng có đủ mọi loại, số nguyên dương", () => {
    for (const r of DSAR_REGIONS)
      for (const ty of DSAR_TYPES) {
        const d = dsarDays(r, ty);
        expect(Number.isInteger(d) && d > 0, `${r}/${ty}`).toBe(true);
      }
  });

  it("due_at = mốc nhận + đúng N × 24 giờ (UTC), kể cả qua cuối tháng/năm nhuận", () => {
    const at = new Date("2028-02-27T23:30:00.000Z");
    expect(dsarDueAt(at, "VN", "delete").toISOString()).toBe("2028-03-01T23:30:00.000Z");
    expect(dsarDueAt(at, "VN", "access").toISOString()).toBe("2028-03-08T23:30:00.000Z");
    expect(dsarDueAt(at, "CA", "access").toISOString()).toBe("2028-04-12T23:30:00.000Z");
  });

  it("isDsarRegion chỉ nhận mã đã khai (phân biệt hoa thường)", () => {
    expect(isDsarRegion("VN")).toBe(true);
    expect(isDsarRegion("vn")).toBe(false);
    expect(isDsarRegion("")).toBe(false);
    expect(isDsarRegion("US")).toBe(false);
  });
});

describe("xác thực lại cho xoá tài khoản (≤ 5 phút)", () => {
  const now = new Date("2026-10-25T10:00:00.000Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  it("trong 300 giây (kể cả đúng biên) ⇒ được; quá ⇒ không", () => {
    expect(DSAR_REAUTH_MAX_AGE_SECONDS).toBe(300);
    expect(isRecentReauth(ago(0), now)).toBe(true);
    expect(isRecentReauth(ago(300), now)).toBe(true);
    expect(isRecentReauth(ago(301), now)).toBe(false);
  });
  it("thiếu, null, ngày hỏng, hoặc ở tương lai quá 1 phút ⇒ không", () => {
    expect(isRecentReauth(undefined, now)).toBe(false);
    expect(isRecentReauth(null, now)).toBe(false);
    expect(isRecentReauth(new Date(Number.NaN), now)).toBe(false);
    expect(isRecentReauth(ago(-59), now)).toBe(true);
    expect(isRecentReauth(ago(-61), now)).toBe(false);
  });
});
