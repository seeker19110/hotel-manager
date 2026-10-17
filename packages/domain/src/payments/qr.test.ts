import { describe, expect, it } from "vitest";
import { QR_MAX_BYTES, qrMatrix } from "./qr.ts";
import { buildVietQr } from "./vietqr.ts";

const dim = (s: string) => qrMatrix(s).length;

describe("qrMatrix — cấu trúc ISO 18004", () => {
  it("kích thước theo phiên bản: 'HELLO' → 21 (v1); chuỗi dài hơn 14 byte → v2 (25)", () => {
    expect(dim("HELLO")).toBe(21);
    expect(dim("A".repeat(14))).toBe(21);
    expect(dim("A".repeat(15))).toBe(25);
    expect(dim("A".repeat(QR_MAX_BYTES))).toBe(57);
  });

  it("có dấu định vị ở ba góc, đường kẻ thời gian xen kẽ, ô tối cố định", () => {
    const m = qrMatrix("HELLO");
    const n = m.length;
    for (const [ox, oy] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[oy]?.[ox + i]).toBe(true);
        expect(m[oy + 6]?.[ox + i]).toBe(true);
        expect(m[oy + i]?.[ox]).toBe(true);
        expect(m[oy + i]?.[ox + 6]).toBe(true);
      }
      expect(m[oy + 3]?.[ox + 3]).toBe(true);
      expect(m[oy + 1]?.[ox + 1]).toBe(false);
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0);
      expect(m[i]?.[6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]?.[8]).toBe(true);
  });

  it("thông tin định dạng: 15 bit là từ mã BCH hợp lệ của mức M + mặt nạ (hai bản sao khớp nhau)", () => {
    const m = qrMatrix(
      buildVietQr({ bin: "970436", accountNumber: "0123456789", amount: 1_580_000, memo: "HM7Q4K2P" }),
    );
    const n = m.length;
    const copy1: boolean[] = [];
    for (let i = 0; i <= 5; i++) copy1.push(m[i]?.[8] as boolean);
    copy1.push(m[7]?.[8] as boolean, m[8]?.[8] as boolean, m[8]?.[7] as boolean);
    for (let i = 9; i < 15; i++) copy1.push(m[8]?.[14 - i] as boolean);
    const copy2: boolean[] = [];
    for (let i = 0; i < 8; i++) copy2.push(m[8]?.[n - 1 - i] as boolean);
    for (let i = 8; i < 15; i++) copy2.push(m[n - 15 + i]?.[8] as boolean);
    expect(copy2).toEqual(copy1);
    const bits = copy1.reduce((v, b, i) => v | ((b ? 1 : 0) << i), 0) ^ 0x5412;
    expect(bits >>> 13).toBe(0); // mức M = 00
    let rem = bits >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(rem & 0x3ff).toBe(bits & 0x3ff);
  });

  it("ổn định (cùng đầu vào → cùng ma trận) và khác nhau khi đầu vào khác", () => {
    const a = qrMatrix("abc");
    expect(qrMatrix("abc")).toEqual(a);
    expect(qrMatrix("abd")).not.toEqual(a);
  });

  it("rỗng / dài quá giới hạn → RangeError; UTF-8 tính theo byte", () => {
    expect(() => qrMatrix("")).toThrow(RangeError);
    expect(() => qrMatrix("a".repeat(QR_MAX_BYTES + 1))).toThrow(RangeError);
    expect(() => qrMatrix("é".repeat(107))).toThrow(RangeError); // 214 byte
    expect(dim("é".repeat(106))).toBe(57);
  });
});
