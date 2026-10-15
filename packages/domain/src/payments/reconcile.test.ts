import { describe, expect, it } from "vitest";
import {
  classifyBankTxn,
  generateMemoRef,
  MEMO_ALPHABET,
  memoCandidates,
  normalizeMemo,
} from "./reconcile.ts";

const inv = (id: string, open: number, sameProperty = true) => ({ id, open, sameProperty });

describe("mã tham chiếu", () => {
  it("HM + 6 ký tự không nhầm lẫn, khớp CHECK memo_ref", () => {
    for (let i = 0; i < 200; i++) {
      const m = generateMemoRef();
      expect(m).toMatch(/^HM[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      expect(m).toMatch(/^[A-Z0-9]{6,16}$/);
    }
    expect(MEMO_ALPHABET).not.toMatch(/[01OI]/);
    expect(generateMemoRef(() => new Uint8Array([0, 31, 32, 255, 1, 2]))).toBe("HM2Z2Z34");
  });

  it("chuẩn hoá nội dung: bỏ dấu, đ→D, hoa, bỏ ký tự lạ", () => {
    expect(normalizeMemo("Nguyễn Văn Đức chuyển tiền phòng hm7q4k2p.")).toBe(
      "NGUYENVANDUCCHUYENTIENPHONGHM7Q4K2P",
    );
  });

  it("ứng viên tìm được mã dính liền chữ khác, có cả mã dài; không có HM → rỗng", () => {
    const c = memoCandidates("MBVCB.123.TIENPHONGHM7Q4K2PTHANG10");
    expect(c).toContain("HM7Q4K2P");
    expect(c.every((x) => x.startsWith("HM") && x.length >= 6 && x.length <= 16)).toBe(true);
    expect(memoCandidates("tien phong")).toEqual([]);
    expect(memoCandidates("")).toEqual([]);
  });
});

describe("gợi ý ghép (S-020)", () => {
  it("(a) khớp đúng một phiếu, đủ tiền → khớp", () => {
    expect(classifyBankTxn(1_580_000, [inv("I1", 1_580_000)])).toEqual({
      status: "match",
      reason: null,
      allocations: [{ invoiceId: "I1", amount: 1_580_000 }],
      credit: 0,
    });
  });

  it("trả một phần vẫn là khớp (S-001)", () => {
    expect(classifyBankTxn(500_000, [inv("I1", 1_580_000)]).status).toBe("match");
  });

  it("(b) không mã → WRONG_REFERENCE, toàn bộ là tín dụng chờ", () => {
    expect(classifyBankTxn(500_000, [])).toMatchObject({
      status: "break",
      reason: "WRONG_REFERENCE",
      credit: 500_000,
    });
  });

  it("(c) hai mã → COMBINED, đề xuất trả lần lượt", () => {
    expect(classifyBankTxn(2_510_000, [inv("I1", 1_580_000), inv("I2", 930_000)])).toEqual({
      status: "break",
      reason: "COMBINED",
      allocations: [
        { invoiceId: "I1", amount: 1_580_000 },
        { invoiceId: "I2", amount: 930_000 },
      ],
      credit: 0,
    });
  });

  it("(d) trả thừa → OVERPAID: 1.580.000 + 420.000 vào CUSTOMER_CREDIT; phiếu đã tất toán → toàn bộ là tín dụng", () => {
    expect(classifyBankTxn(2_000_000, [inv("I1", 1_580_000)])).toEqual({
      status: "break",
      reason: "OVERPAID",
      allocations: [{ invoiceId: "I1", amount: 1_580_000 }],
      credit: 420_000,
    });
    expect(classifyBankTxn(100, [inv("I1", 0)])).toEqual({
      status: "break",
      reason: "OVERPAID",
      allocations: [],
      credit: 100,
    });
  });

  it("phiếu của cơ sở khác → UNMATCHED; số tiền không hợp lệ → lỗi", () => {
    expect(classifyBankTxn(100, [inv("I1", 100, false)]).reason).toBe("UNMATCHED");
    for (const a of [0, -1, 1.5]) expect(() => classifyBankTxn(a, [])).toThrow(RangeError);
  });
});
