// T-2619 (AUD-XFEAT-007): ngày trên URL /nhat-ky phải là ngày lịch có thật — hình dạng đúng chưa đủ (`2026-13-01` ném RangeError ở
// addDays, `2026-02-30` lặng lẽ thành 03-02 trong truy vấn nhưng bộ lọc xuất vẫn là 02-30).
import { describe, expect, it } from "vitest";
import { addDays, isCalendarDate } from "../lib/format.ts";

describe("isCalendarDate", () => {
  it("nhận ngày có thật, kể cả 29/2 năm nhuận", () => {
    for (const d of ["2026-11-06", "2024-02-29", "2000-02-29", "1999-12-31", "2026-01-01"])
      expect(isCalendarDate(d), d).toBe(true);
  });
  it("từ chối tháng/ngày không có thật, sai hình dạng, giá trị không phải chuỗi", () => {
    for (const d of [
      "2026-13-01",
      "2026-00-10",
      "2026-02-30",
      "2025-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-11-6",
      "2026-11-06T00:00",
      " 2026-11-06",
      "",
    ])
      expect(isCalendarDate(d), d).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(["2026-11-06"])).toBe(false);
  });
  it("ngày đã qua kiểm thì addDays không ném và giữ đúng lịch", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
