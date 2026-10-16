import { describe, expect, it } from "vitest";
import {
  type Cell,
  csvCell,
  parseImportDate,
  parseImportDecimal,
  parseImportInt,
  parseImportText,
  parseImportVnd,
  toCsv,
} from "./values.ts";

const s = (v: string): Cell => ({ v, numeric: false });
const n = (v: number | string): Cell => ({ v: String(v), numeric: true });
const ok = <T>(value: T) => ({ ok: true, value });
const err = (code: string) => ({ ok: false, code });

describe("parseImportVnd — S-020 (13 dòng Examples)", () => {
  it.each([
    ["1580000", 1580000],
    ["0", 0],
    ["1", 1],
    ["3.000.000", 3000000],
    ["1.500", 1500],
  ])("chuỗi %j → %d", (raw, want) => {
    expect(parseImportVnd(s(raw))).toEqual(ok(want));
  });

  it.each([
    ["1.50", "NOT_INTEGER_VND"],
    ["1.5000", "NOT_INTEGER_VND"],
    ["12.34.567", "NOT_INTEGER_VND"],
    ["1.580.000,5", "NOT_INTEGER_VND"],
    ["1,500", "NOT_INTEGER_VND"],
    ["1580000,5", "NOT_INTEGER_VND"],
    ["-500000", "OUT_OF_RANGE"],
    ["", "REQUIRED"],
  ])("chuỗi %j → %s", (raw, code) => {
    expect(parseImportVnd(s(raw))).toEqual(err(code));
  });

  it("ô trống/không có ô/chỉ khoảng trắng → REQUIRED", () => {
    expect(parseImportVnd(undefined)).toEqual(err("REQUIRED"));
    expect(parseImportVnd(s("   \t"))).toEqual(err("REQUIRED"));
    expect(parseImportVnd({ v: "", numeric: true })).toEqual(err("REQUIRED"));
  });

  it("cho phép khoảng trắng hai đầu; không nhận đ/VND/dấu +/chữ", () => {
    expect(parseImportVnd(s("  1.500 "))).toEqual(ok(1500));
    for (const bad of [
      "1500đ",
      "1500 VND",
      "1.500 đ",
      "+5",
      "abc",
      "1 500",
      "1_000",
      "0x10",
      "1e3",
      "- 5",
      "--5",
    ]) {
      expect(parseImportVnd(s(bad)), bad).toEqual(err("NOT_INTEGER_VND"));
    }
  });

  it("số âm: phần còn lại hợp lệ → OUT_OF_RANGE; rác sau dấu - → NOT_INTEGER_VND", () => {
    expect(parseImportVnd(s("-1.500"))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(s("-1.5"))).toEqual(err("NOT_INTEGER_VND"));
    expect(parseImportVnd(s("-abc"))).toEqual(err("NOT_INTEGER_VND"));
  });

  it("biên MAX_SAFE_INTEGER", () => {
    expect(parseImportVnd(s("9007199254740991"))).toEqual(ok(Number.MAX_SAFE_INTEGER));
    expect(parseImportVnd(s("9007199254740992"))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(s("9".repeat(400)))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(n("9007199254740991"))).toEqual(ok(Number.MAX_SAFE_INTEGER));
    expect(parseImportVnd(n(1e21))).toEqual(err("OUT_OF_RANGE"));
  });

  it("số 0 hợp lệ; allowZero=false thì OUT_OF_RANGE", () => {
    expect(parseImportVnd(s("0"))).toEqual(ok(0));
    expect(parseImportVnd(s("0"), { allowZero: true })).toEqual(ok(0));
    expect(parseImportVnd(s("0"), { allowZero: false })).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(n(0), { allowZero: false })).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(s("5"), { allowZero: false })).toEqual(ok(5));
  });

  it("ô số XLSX: 1580000 ok; 1580000.5 và 1.234 là số lẻ (không hiểu là 1234)", () => {
    expect(parseImportVnd(n(1580000))).toEqual(ok(1580000));
    expect(parseImportVnd(n(1580000.5))).toEqual(err("NOT_INTEGER_VND"));
    expect(parseImportVnd(n(1.234))).toEqual(err("NOT_INTEGER_VND"));
    expect(parseImportVnd(n(0))).toEqual(ok(0));
    expect(parseImportVnd(n(-500000))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportVnd(n("-0"))).toEqual(ok(0));
    expect(Object.is((parseImportVnd(n("-0")) as { value: number }).value, 0)).toBe(true);
    expect(parseImportVnd(n("NaN"))).toEqual(err("NOT_INTEGER_VND"));
    expect(parseImportVnd(n("Infinity"))).toEqual(err("NOT_INTEGER_VND"));
  });

  it("số Unicode không phải ASCII không được nhận", () => {
    expect(parseImportVnd(s("１２３"))).toEqual(err("NOT_INTEGER_VND"));
  });
});

describe("parseImportDate", () => {
  it("chuỗi yyyy-mm-dd đúng ngày lịch", () => {
    expect(parseImportDate(s("2026-10-31"))).toEqual(ok("2026-10-31"));
    expect(parseImportDate(s(" 2024-02-29 "))).toEqual(ok("2024-02-29"));
  });

  it.each(["2026-02-30", "2025-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-01-00", "0000-01-01"])(
    "ngày lịch không có thật %s → INVALID_FORMAT",
    (raw) => {
      expect(parseImportDate(s(raw))).toEqual(err("INVALID_FORMAT"));
    },
  );

  it("2000-02-29 (năm chia hết 400) hợp lệ", () => {
    expect(parseImportDate(s("2000-02-29"))).toEqual(ok("2000-02-29"));
  });

  it.each([
    "31/10/2026",
    "1/2/2026",
    "2026/10/31",
    "2026-1-5",
    "20261031",
    "2026-10-31T00:00:00",
    "46327",
    "abc",
  ])("định dạng khác %j (kể cả dd/mm/yyyy) → INVALID_FORMAT", (raw) => {
    expect(parseImportDate(s(raw))).toEqual(err("INVALID_FORMAT"));
  });

  it("rỗng → REQUIRED", () => {
    expect(parseImportDate(undefined)).toEqual(err("REQUIRED"));
    expect(parseImportDate(s(""))).toEqual(err("REQUIRED"));
  });

  it("seri Excel hệ 1900", () => {
    expect(parseImportDate(n(45658))).toEqual(ok("2025-01-01"));
    // 46023 = 2026-01-01 → +304 ngày = 2026-11-01; 46326 là 2026-10-31.
    expect(parseImportDate(n(46327))).toEqual(ok("2026-11-01"));
    expect(parseImportDate(n(46326))).toEqual(ok("2026-10-31"));
    expect(parseImportDate(n(61))).toEqual(ok("1900-03-01"));
    expect(parseImportDate(n(59))).toEqual(ok("1900-02-28"));
    expect(parseImportDate(n(1))).toEqual(ok("1900-01-01"));
    expect(parseImportDate(n(2958465))).toEqual(ok("9999-12-31"));
  });

  it("seri 60 (29/02/1900 không tồn tại) và ngoài khoảng → INVALID_FORMAT", () => {
    expect(parseImportDate(n(60))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n(0))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n(-5))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n(2958466))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n("Infinity"))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n("abc"))).toEqual(err("INVALID_FORMAT"));
  });

  it("phần lẻ (giờ) của seri bị bỏ qua bằng floor", () => {
    expect(parseImportDate(n(46327.9999))).toEqual(ok("2026-11-01"));
    expect(parseImportDate(n(0.5))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDate(n(60.5))).toEqual(err("INVALID_FORMAT"));
  });
});

describe("parseImportDecimal", () => {
  it("chuỗi hợp lệ và chuẩn hoá", () => {
    expect(parseImportDecimal(s("1250.500"))).toEqual(ok("1250.5"));
    expect(parseImportDecimal(s("007"))).toEqual(ok("7"));
    expect(parseImportDecimal(s("0"))).toEqual(ok("0"));
    expect(parseImportDecimal(s("0.000"))).toEqual(ok("0"));
    expect(parseImportDecimal(s("12.345"))).toEqual(ok("12.345"));
    expect(parseImportDecimal(s(" 3.10 "))).toEqual(ok("3.1"));
    expect(parseImportDecimal(s("1000"))).toEqual(ok("1000"));
    expect(parseImportDecimal(s("00.5"))).toEqual(ok("0.5"));
  });

  it("quá số chữ số thập phân / dấu phẩy / chữ → INVALID_FORMAT", () => {
    for (const bad of ["1.2345", "1,5", "1.", ".5", "abc", "1.2.3", "1e3", "+1", "1 000"]) {
      expect(parseImportDecimal(s(bad)), bad).toEqual(err("INVALID_FORMAT"));
    }
  });

  it("âm → OUT_OF_RANGE (chuỗi và ô số)", () => {
    expect(parseImportDecimal(s("-1.5"))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportDecimal(n(-0.5))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportDecimal(s("-abc"))).toEqual(err("INVALID_FORMAT"));
  });

  it("ô số: tối đa 3 chữ số thập phân, kiểm bằng chuỗi", () => {
    expect(parseImportDecimal(n(1250.5))).toEqual(ok("1250.5"));
    expect(parseImportDecimal(n(1250))).toEqual(ok("1250"));
    expect(parseImportDecimal(n(0.125))).toEqual(ok("0.125"));
    expect(parseImportDecimal(n(0.1234))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDecimal(n(0.1 + 0.2))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDecimal(n(1e-7))).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDecimal(n(1e21))).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportDecimal(n("-0"))).toEqual(ok("0"));
    expect(parseImportDecimal(n("Infinity"))).toEqual(err("INVALID_FORMAT"));
  });

  it("maxDecimals tuỳ chọn, kể cả 0", () => {
    expect(parseImportDecimal(s("1.25"), 2)).toEqual(ok("1.25"));
    expect(parseImportDecimal(s("1.255"), 2)).toEqual(err("INVALID_FORMAT"));
    expect(parseImportDecimal(s("12"), 0)).toEqual(ok("12"));
    expect(parseImportDecimal(s("1.5"), 0)).toEqual(err("INVALID_FORMAT"));
  });

  it("rỗng → REQUIRED", () => {
    expect(parseImportDecimal(undefined)).toEqual(err("REQUIRED"));
    expect(parseImportDecimal(s("  "))).toEqual(err("REQUIRED"));
  });
});

describe("parseImportInt", () => {
  it("số nguyên trong khoảng, gồm hai biên", () => {
    expect(parseImportInt(s("1"), 1, 20)).toEqual(ok(1));
    expect(parseImportInt(s("20"), 1, 20)).toEqual(ok(20));
    expect(parseImportInt(n(5), 1, 20)).toEqual(ok(5));
    expect(parseImportInt(s(" 7 "), 1, 20)).toEqual(ok(7));
  });

  it("ngoài khoảng → OUT_OF_RANGE", () => {
    expect(parseImportInt(s("0"), 1, 20)).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportInt(s("21"), 1, 20)).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportInt(s("-3"), 1, 20)).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportInt(s("-3"), -5, 5)).toEqual(ok(-3));
    expect(parseImportInt(n(1e21), 1, 20)).toEqual(err("OUT_OF_RANGE"));
    expect(parseImportInt(s("9".repeat(30)), 1, 20)).toEqual(err("OUT_OF_RANGE"));
  });

  it("không phải số nguyên → INVALID_FORMAT", () => {
    for (const bad of ["1.5", "1,5", "abc", "2 người", "0x2", "1e1"]) {
      expect(parseImportInt(s(bad), 1, 20), bad).toEqual(err("INVALID_FORMAT"));
    }
    expect(parseImportInt(n(2.5), 1, 20)).toEqual(err("INVALID_FORMAT"));
    expect(parseImportInt(n("NaN"), 1, 20)).toEqual(err("INVALID_FORMAT"));
  });

  it("rỗng → REQUIRED", () => {
    expect(parseImportInt(undefined, 1, 20)).toEqual(err("REQUIRED"));
    expect(parseImportInt(s(""), 1, 20)).toEqual(err("REQUIRED"));
  });
});

describe("parseImportText", () => {
  it("trim, giữ nguyên nội dung (công thức chỉ là dữ liệu)", () => {
    expect(parseImportText(s("  Phòng 101 "))).toEqual(ok("Phòng 101"));
    expect(parseImportText(s('=HYPERLINK("x")'))).toEqual(ok('=HYPERLINK("x")'));
    expect(parseImportText(s("+84 912"))).toEqual(ok("+84 912"));
  });

  it("rỗng: required → REQUIRED, không required → chuỗi rỗng", () => {
    expect(parseImportText(undefined)).toEqual(err("REQUIRED"));
    expect(parseImportText(s("   "))).toEqual(err("REQUIRED"));
    expect(parseImportText(s(""), 500, false)).toEqual(ok(""));
    expect(parseImportText(undefined, 500, false)).toEqual(ok(""));
  });

  it("biên 500 ký tự", () => {
    expect(parseImportText(s("a".repeat(500)))).toEqual(ok("a".repeat(500)));
    expect(parseImportText(s("a".repeat(501)))).toEqual(err("TOO_LONG"));
    expect(parseImportText(s("ab"), 1)).toEqual(err("TOO_LONG"));
  });

  it("đếm theo code point, không theo UTF-16", () => {
    const emoji = "😀".repeat(500); // 1000 đơn vị UTF-16, 500 code point
    expect(parseImportText(s(emoji))).toEqual(ok(emoji));
    expect(parseImportText(s(`${emoji}😀`))).toEqual(err("TOO_LONG"));
    expect(parseImportText(s("Nguyễn Văn Ạ"), 12)).toEqual(ok("Nguyễn Văn Ạ"));
  });
});

describe("csvCell / toCsv — S-018", () => {
  it("chuỗi bắt đầu bằng ký tự công thức được thêm tiền tố '", () => {
    expect(csvCell('=HYPERLINK("http://x","bấm")')).toBe(`"'=HYPERLINK(""http://x"",""bấm"")"`);
    expect(csvCell("+84 912")).toBe("'+84 912");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe(`"'\r=1"`);
  });

  it("ký tự công thức không ở đầu thì giữ nguyên", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell(" =1")).toBe(" =1");
  });

  it("số giữ kiểu số (không tiền tố), kể cả âm; null → rỗng", () => {
    expect(csvCell(-500000)).toBe("-500000");
    expect(csvCell(1580000)).toBe("1580000");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("bọc ngoặc kép khi chứa dấu phẩy, chấm phẩy, ngoặc kép, xuống dòng", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('nói "ok"')).toBe('"nói ""ok"""');
    expect(csvCell("dòng1\ndòng2")).toBe('"dòng1\ndòng2"');
    expect(csvCell("Nguyễn Văn Ạ")).toBe("Nguyễn Văn Ạ");
  });

  it("toCsv: BOM đầu, nối bằng , và CRLF", () => {
    const out = toCsv([
      ["dòng", "tên", "số dư"],
      [2, "=1+1", -500000],
      [3, null, 0],
    ]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("dòng,tên,số dư\r\n2,'=1+1,-500000\r\n3,,0");
    expect(toCsv([])).toBe("﻿");
  });
});
