// SPEC-pwa S-012: lịch hỏi lại kết quả lệnh — 1, 2, 4, 8, 15 s (tổng đúng 30 s); ca biên ngân sách nhỏ/0.
import { describe, expect, it } from "vitest";
import { RECHECK_BUDGET_MS, recheckSchedule } from "../components/command/recheck.ts";

describe("recheckSchedule", () => {
  it("mặc định: 1, 2, 4, 8 rồi phần còn lại (15) — tổng 30 s", () => {
    expect(recheckSchedule()).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(recheckSchedule().reduce((a, b) => a + b, 0)).toBe(RECHECK_BUDGET_MS);
  });
  it("ngân sách nhỏ bị cắt đúng; 0 ⇒ không chờ", () => {
    expect(recheckSchedule(2500)).toEqual([1000, 1500]);
    expect(recheckSchedule(500)).toEqual([500]);
    expect(recheckSchedule(0)).toEqual([]);
  });
});
