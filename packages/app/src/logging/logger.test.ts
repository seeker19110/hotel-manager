import { describe, expect, it } from "vitest";
import { createLogger, maskString, redact } from "./logger.js";

function capture() {
  const lines: string[] = [];
  return { lines, sink: { write: (l: string) => lines.push(l) } };
}

describe("logger JSON (BASE-ERR-005/006)", () => {
  it("một dòng JSON có ts, level, msg, correlation_id từ child", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, now: () => new Date("2026-10-15T00:00:00Z") }).child({
      correlation_id: "c-1",
    });
    log.info("đã tạo booking", { booking_id: "b-1" });
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "2026-10-15T00:00:00.000Z",
      level: "info",
      msg: "đã tạo booking",
      correlation_id: "c-1",
      booking_id: "b-1",
    });
  });

  it("lọc theo mức", () => {
    const { lines, sink } = capture();
    createLogger({ sink, level: "warn" }).info("bỏ qua");
    expect(lines).toHaveLength(0);
  });

  it("sự kiện bảo mật có category=security (SEC-LOG-001)", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).security("auth.login_failed", { email: "an.nguyen@example.com" });
    const rec = JSON.parse(lines[0] ?? "");
    expect(rec.category).toBe("security");
    expect(rec.level).toBe("warn");
    expect(rec.email).toBe("a***@example.com");
  });
});

describe("che bí mật và dữ liệu cá nhân (BASE-ERR-007, TM-06)", () => {
  it("khoá nhạy cảm thành *** ở mọi độ sâu", () => {
    expect(
      redact({
        password: "p",
        headers: { authorization: "Bearer abc", cookie: "s=1" },
        guest: { cccd_number: "001234567890", name: "An" },
        list: [{ token: "t" }],
      }),
    ).toEqual({
      password: "***",
      headers: { authorization: "***", cookie: "***" },
      guest: { cccd_number: "***", name: "An" },
      list: [{ token: "***" }],
    });
  });

  it.each([
    ["SĐT 0912345678", "SĐT 091****678"],
    ["+84912345678", "091****678"],
    ["CCCD 001234567890", "CCCD ****7890"],
    ["email an.nguyen@example.com", "email a***@example.com"],
    ["phòng 203, 2 đêm", "phòng 203, 2 đêm"],
    ["số tiền 3580000", "số tiền 3580000"],
    ["tổng 1330254041 đ", "tổng 1330254041 đ"],
    ["CMND 123456789", "CMND ****6789"],
  ])("maskString(%s) → %s", (input, out) => {
    expect(maskString(input)).toBe(out);
  });

  it("Error chỉ giữ tên và message đã che", () => {
    expect(redact(new Error("khách 0912345678 lỗi"))).toEqual({
      name: "Error",
      message: "khách 091****678 lỗi",
    });
  });
});
