import { describe, expect, it } from "vitest";
import { propertyDefaults } from "./defaults.ts";

describe("propertyDefaults (D-002/D-005)", () => {
  it("khách sạn: nhận 14:00, trả 12:00, giờ chốt ngày 04:00, giữ phòng 15 phút", () => {
    expect(propertyDefaults("hotel")).toEqual({
      businessDayCutoff: "04:00",
      checkInTime: "14:00",
      checkOutTime: "12:00",
      holdTtlMinutes: 15,
    });
  });

  it("trọ: giờ chốt 00:00, không có giờ nhận/trả phòng", () => {
    expect(propertyDefaults("rental")).toMatchObject({
      businessDayCutoff: "00:00",
      checkInTime: null,
      checkOutTime: null,
    });
  });

  it("hỗn hợp theo mốc khách sạn; mỗi lần gọi trả bản sao độc lập", () => {
    const a = propertyDefaults("mixed");
    a.holdTtlMinutes = 99;
    expect(propertyDefaults("mixed")).toEqual(propertyDefaults("hotel"));
  });
});
