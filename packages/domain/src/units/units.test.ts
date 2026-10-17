import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MIB,
  daysToMs,
  epochSeconds,
  hoursToMinutes,
  hoursToMs,
  kibToBytes,
  MS_PER_DAY,
  mibToBytes,
  minutesToMs,
  minutesToSeconds,
  msToSeconds,
  SECONDS_PER_DAY,
  secondsToMs,
  VN_UTC_OFFSET_MS,
} from "./units.ts";

describe("units — hằng và hàm đổi đơn vị", () => {
  it("giá trị chuẩn: 1 ngày = 86.400.000 ms = 86.400 s; 1 MiB = 1.048.576 byte", () => {
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(SECONDS_PER_DAY).toBe(86_400);
    expect(BYTES_PER_MIB).toBe(1_048_576);
    expect(VN_UTC_OFFSET_MS).toBe(25_200_000);
  });

  it("đổi qua lại cho cả 0 và số lớn", () => {
    expect(secondsToMs(0)).toBe(0);
    expect(minutesToMs(1)).toBe(60_000);
    expect(hoursToMs(2)).toBe(7_200_000);
    expect(daysToMs(3)).toBe(259_200_000);
    expect(hoursToMinutes(48)).toBe(2880);
    expect(minutesToSeconds(5)).toBe(300);
    expect(kibToBytes(64)).toBe(65_536);
    expect(mibToBytes(10)).toBe(10_485_760);
    expect(mibToBytes(0)).toBe(0);
  });

  it("ms → giây làm tròn XUỐNG; mốc epoch theo giây bỏ phần lẻ mili-giây", () => {
    expect(msToSeconds(999)).toBe(0);
    expect(msToSeconds(1000)).toBe(1);
    expect(msToSeconds(1999)).toBe(1);
    expect(epochSeconds(new Date("2026-10-16T00:00:00.999Z"))).toBe(
      Date.parse("2026-10-16T00:00:00Z") / 1000,
    );
  });
});
