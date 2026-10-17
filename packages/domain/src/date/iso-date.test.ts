import { describe, expect, it } from "vitest";
import { isIsoDate, isoDateOr } from "./iso-date.ts";

describe("isIsoDate / isoDateOr (đầu vào query không tin cậy)", () => {
  it("nhận ngày có thật, kể cả 29/02 năm nhuận và biên năm", () => {
    for (const v of ["2026-10-17", "2028-02-29", "2026-12-31", "2026-01-01"]) expect(isIsoDate(v)).toBe(true);
  });
  it("loại tháng/ngày ngoài khoảng, ngày không tồn tại, sai khuôn, rỗng, Unicode", () => {
    for (const v of [
      "2026-13-45",
      "2026-00-10",
      "2026-02-30",
      "2027-02-29",
      "2026-1-5",
      "",
      "２０２６-10-17",
      "2026-10-17x",
      "0000-00-00",
    ])
      expect(isIsoDate(v)).toBe(false);
  });
  it("isoDateOr dùng fallback khi thiếu/null/không hợp lệ", () => {
    expect(isoDateOr("2026-10-20", "2026-10-17")).toBe("2026-10-20");
    for (const v of [undefined, null, "", "2026-13-45", "abc"])
      expect(isoDateOr(v, "2026-10-17")).toBe("2026-10-17");
  });
});
