import { describe, expect, it } from "vitest";
import { bankBin, buildVietQr, crc16CcittFalse } from "./vietqr.ts";

// Chuỗi mẫu (nguồn thứ cấp, CRC tự tính lại khớp — docs/research/2026-10-15-vietqr.md).
const B =
  "00020101021238540010A00000072701240006970423011001234567890208QRIBFTTA530370454061500005802VN62120808DH123456630479AB";
const C = "00020101021138540010A00000072701240006970407011096020919960208QRIBFTTA53037045802VN630434A0";

describe("VietQR (S-015)", () => {
  it("CRC-16/CCITT-FALSE: check value chuẩn 123456789 → 29B1", () => {
    expect(crc16CcittFalse("123456789")).toBe("29B1");
  });

  it("tái tạo đúng chuỗi mẫu động có nội dung và mẫu tĩnh", () => {
    expect(
      buildVietQr({ bin: "970423", accountNumber: "0123456789", amount: 150_000, memo: "DH123456" }),
    ).toBe(B);
    expect(buildVietQr({ bin: "970407", accountNumber: "9602091996" })).toBe(C);
  });

  it("CRC của chuỗi mẫu có dấu cách trong nội dung", () => {
    const a =
      "00020101021238540010A00000072701240006970436011010175956000208QRIBFTTA530370454061800005802VN62230819thanh toan don hang6304";
    expect(crc16CcittFalse(a)).toBe("70FA");
  });

  it("từ chối đầu vào sai: số tiền 0/âm/lẻ, nội dung có dấu/ký tự lạ hoặc quá dài, BIN sai", () => {
    const base = { bin: "970436", accountNumber: "1017595600" };
    for (const amount of [0, -1, 10.5, 10_000_000_000_000])
      expect(() => buildVietQr({ ...base, amount })).toThrow(RangeError);
    for (const memo of ["tien phong", "HM7Q4K2P|x", "A".repeat(26), ""])
      expect(() => buildVietQr({ ...base, memo })).toThrow(RangeError);
    expect(() => buildVietQr({ ...base, bin: "97043" })).toThrow(RangeError);
    const q = buildVietQr({ ...base, amount: 1_580_000, memo: "HM7Q4K2P" });
    expect(q).toContain("540715800005802VN62120808HM7Q4K2P6304");
    expect(q.slice(-4)).toBe(crc16CcittFalse(q.slice(0, -4)));
  });

  it("BIN: mã ngắn đã xác minh hoặc chính BIN; mã lạ → null (không đoán)", () => {
    expect(bankBin("VCB")).toBe("970436");
    expect(bankBin("970422")).toBe("970422");
    expect(bankBin("XYZ")).toBeNull();
  });
});
