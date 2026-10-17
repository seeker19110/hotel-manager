// XC-I18N-003 — định dạng tiền/số/ngày qua Intl: vi-VN giữ "đ" theo SPEC; en-US theo CLDR; ca biên 0, âm, lẻ, ngày không có thật.
import { describe, expect, it } from "vitest";
import { formatDate, formatMonth, formatVnd, formatVndNumber, formatVndUnitPrice } from "./intl.ts";

describe("formatVnd", () => {
  it("vi-VN: nhóm nghìn bằng dấu chấm, ký hiệu 'đ' cách một dấu cách thường", () => {
    expect(formatVnd(1_430_000)).toBe("1.430.000 đ");
    expect(formatVnd(1_234_568)).toBe("1.234.568 đ");
    expect(formatVnd(10_001)).toBe("10.001 đ");
  });

  it("0, số nhỏ, âm", () => {
    expect(formatVnd(0)).toBe("0 đ");
    expect(formatVnd(5)).toBe("5 đ");
    expect(formatVnd(-1000)).toBe("-1.000 đ");
  });

  it("không có khoảng trắng không ngắt (NBSP) trong kết quả — khớp so sánh văn bản của E2E", () => {
    expect(formatVnd(1_430_000)).not.toMatch(/[  ]/);
  });

  it("locale khác giữ nguyên kết quả CLDR (en-US: ₫1,430,000)", () => {
    expect(formatVnd(1_430_000, "en-US")).toBe("₫1,430,000");
  });

  it("từ chối số lẻ, NaN, Infinity, ngoài khoảng an toàn (tiền luôn nguyên đồng)", () => {
    for (const bad of [10.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => formatVnd(bad)).toThrow(RangeError);
      expect(() => formatVndNumber(bad)).toThrow(RangeError);
    }
  });
});

describe("formatVndNumber", () => {
  it("không kèm ký hiệu", () => {
    expect(formatVndNumber(3000)).toBe("3.000");
    expect(formatVndNumber(0)).toBe("0");
    expect(formatVndNumber(1_234_567, "en-US")).toBe("1,234,567");
  });
});

describe("formatVndUnitPrice", () => {
  it("đơn giá nguyên và lẻ đến 4 chữ số thập phân, bỏ số 0 thừa", () => {
    expect(formatVndUnitPrice(3500)).toBe("3.500 đ");
    expect(formatVndUnitPrice(3500.5)).toBe("3.500,5 đ");
    expect(formatVndUnitPrice(0.1235)).toBe("0,1235 đ");
    expect(formatVndUnitPrice(0)).toBe("0 đ");
  });

  it("locale khác: ghi mã VND, không dùng ký hiệu 'đ'; NaN/Infinity bị từ chối", () => {
    expect(formatVndUnitPrice(3500.5, "en-US")).toBe("3,500.5 VND");
    expect(() => formatVndUnitPrice(Number.NaN)).toThrow(RangeError);
    expect(() => formatVndUnitPrice(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatDate / formatMonth", () => {
  it("vi-VN: dd/mm/yyyy và mm/yyyy, đủ hai chữ số", () => {
    expect(formatDate("2026-10-13")).toBe("13/10/2026");
    expect(formatDate("2026-01-05")).toBe("05/01/2026");
    expect(formatMonth("2026-01-05")).toBe("01/2026");
    expect(formatMonth("2026-10")).toBe("10/2026");
  });

  it("en-US: 10/13/2026", () => {
    expect(formatDate("2026-10-13", "en-US")).toBe("10/13/2026");
    expect(formatMonth("2026-10-13", "en-US")).toBe("10/2026");
  });

  it("ngày nhuận và biên năm; không lệch múi giờ (UTC)", () => {
    expect(formatDate("2028-02-29")).toBe("29/02/2028");
    expect(formatDate("2026-12-31")).toBe("31/12/2026");
    expect(formatDate("2026-01-01")).toBe("01/01/2026");
  });

  it("từ chối ngày không có thật hoặc sai dạng (không cuộn sang tháng sau)", () => {
    expect(() => formatDate("2026-02-30")).toThrow(RangeError);
    expect(() => formatDate("2027-02-29")).toThrow(RangeError);
    expect(() => formatDate("2026-13-01")).toThrow(RangeError);
    expect(() => formatDate("")).toThrow(RangeError);
    expect(() => formatDate("13/10/2026")).toThrow(RangeError);
    expect(() => formatMonth("2026-13")).toThrow(RangeError);
    expect(() => formatMonth("abc")).toThrow(RangeError);
  });
});
