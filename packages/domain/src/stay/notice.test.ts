// Hạn thông báo lưu trú thuần — SPEC-notifications S-014, S-015 (Examples), S-020; SPEC-reservation-stay S-030.
import { describe, expect, it } from "vitest";
import { parseStayNoticeDeadline, stayNoticeDueLocal } from "./notice.ts";

const cfg = parseStayNoticeDeadline({
  domestic_cutoff: "23:00",
  domestic_next_day_before: "08:00",
  foreign_hours: 12,
});

describe("stayNoticeDueLocal", () => {
  it.each([
    ["S-014 trong nước nhận 20:10", "2026-10-15T20:10", false, "2026-10-15T23:00"],
    ["S-015 trong nước nhận 23:40 → 08:00 hôm sau", "2026-10-15T23:40", false, "2026-10-16T08:00"],
    ["đúng 23:00 tính là sau mốc", "2026-10-15T23:00", false, "2026-10-16T08:00"],
    ["S-015 nước ngoài 14:00 + 12 giờ", "2026-10-15T14:00", true, "2026-10-16T02:00"],
    ["qua cuối tháng/năm", "2026-12-31T23:30", false, "2027-01-01T08:00"],
  ])("%s", (_n, at, foreign, due) => expect(stayNoticeDueLocal(at, foreign, cfg)).toBe(due));

  it("S-020: chưa cấu hình → null (không có mặc định cứng); thiếu phần áp dụng → null", () => {
    expect(stayNoticeDueLocal("2026-10-15T20:10", false, null)).toBeNull();
    expect(
      stayNoticeDueLocal("2026-10-15T20:10", true, parseStayNoticeDeadline({ domestic_cutoff: "23:00" })),
    ).toBeNull();
    expect(
      stayNoticeDueLocal("2026-10-15T23:30", false, parseStayNoticeDeadline({ domestic_cutoff: "23:00" })),
    ).toBeNull();
  });

  it("cấu hình sai kiểu bị bỏ qua, không đoán", () => {
    expect(parseStayNoticeDeadline({ domestic_cutoff: "25:00", foreign_hours: 0 })).toBeNull();
    expect(parseStayNoticeDeadline([])).toBeNull();
    expect(parseStayNoticeDeadline({ foreign_hours: 24 })).toEqual({ foreignHours: 24 });
  });
});
