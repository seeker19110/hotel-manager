import { describe, expect, it } from "vitest";
import {
  mapStatement,
  parseCsv,
  parseStatementDate,
  parseVndAmount,
  STATEMENT_MAX_ROWS,
} from "./statement-csv.ts";

describe("CSV", () => {
  it("BOM, ngoặc kép có dấu phân cách/xuống dòng/ngoặc kép kép, CRLF, bỏ dòng trống", () => {
    const t = '﻿Ngày;Nội dung;Số tiền\r\n01/10/2026;"a; ""b""\nc";1.580.000\r\n\r\n02/10/2026;x;-5\n';
    expect(parseCsv(t)).toEqual([
      ["Ngày", "Nội dung", "Số tiền"],
      ["01/10/2026", 'a; "b"\nc', "1.580.000"],
      ["02/10/2026", "x", "-5"],
    ]);
    expect(() => parseCsv('a,"b')).toThrow(RangeError);
  });
});

describe("số tiền VND", () => {
  it.each([
    ["1580000", 1_580_000],
    ["1.580.000", 1_580_000],
    ["1,580,000", 1_580_000],
    ["1.580.000,00", 1_580_000],
    ["1,580,000.00", 1_580_000],
    ["1 580 000 đ", 1_580_000],
    ["+2.000.000", 2_000_000],
    ["-500.000", -500_000],
    ["0", 0],
  ])("%s → %d", (raw, n) => expect(parseVndAmount(raw)).toBe(n));

  it.each(["1,5", "1.580.000,50", "abc", "", "1.58.000", "99999999999999999999"])("%s → null", (raw) =>
    expect(parseVndAmount(raw)).toBeNull(),
  );
});

describe("ngày giao dịch", () => {
  it("dd/mm/yyyy là giờ Việt Nam; ISO giữ múi giờ; ngày sai lịch → null", () => {
    expect(parseStatementDate("01/10/2026")?.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(parseStatementDate("1-10-2026 08:05")?.toISOString()).toBe("2026-10-01T01:05:00.000Z");
    expect(parseStatementDate("2026-10-01T08:05:09Z")?.toISOString()).toBe("2026-10-01T08:05:09.000Z");
    expect(parseStatementDate("29/02/2028")).not.toBeNull();
    for (const bad of ["31/02/2026", "29/02/2026", "13/13/2026", "01/10/2026 24:00", "hôm qua", ""])
      expect(parseStatementDate(bad)).toBeNull();
  });
});

describe("ánh xạ cột (S-019)", () => {
  const rows = parseCsv(
    [
      "Ngày GD,Mã GD,Nội dung,Ghi có,Ghi nợ,Số dư",
      "01/10/2026,FT26288001,TIEN PHONG HM7Q4K2P,1.580.000,,5.000.000",
      "01/10/2026,FT26288002,rut tien,,200.000,4.800.000",
      "02/10/2026,,khong ma,500.000,,5.300.000",
      "32/10/2026,FT9,x,1,,",
      "03/10/2026,FT10,x,abc,,",
      "03/10/2026,FT11,x,1.000,2.000,",
    ].join("\n"),
  );

  it("tên cột không phân biệt hoa thường; tiền ra bị bỏ; lỗi theo dòng", () => {
    const out = mapStatement(rows, {
      date: "ngày gd",
      ref: "Mã GD",
      description: "Nội dung",
      credit: "Ghi có",
      debit: "Ghi nợ",
      balance: "Số dư",
    });
    expect(out[0]).toMatchObject({
      line: 2,
      kind: "credit",
      amount: 1_580_000,
      ref: "FT26288001",
      balanceAfter: 5_000_000,
    });
    expect(out[1]).toEqual({ line: 3, kind: "skipped", why: "outflow" });
    expect(out[2]).toMatchObject({ line: 4, kind: "credit", ref: null, amount: 500_000 });
    expect(out.slice(3).map((r) => r.kind)).toEqual(["invalid", "invalid", "invalid"]);
  });

  it("ánh xạ sai: cột không có, thiếu/thừa cột số tiền, quá số dòng", () => {
    expect(() => mapStatement(rows, { date: "x", description: "Nội dung", amount: 3 })).toThrow(/ngày/);
    expect(() => mapStatement(rows, { date: 0, description: 2 })).toThrow(RangeError);
    expect(() => mapStatement(rows, { date: 0, description: 2, amount: 3, credit: 3 })).toThrow(RangeError);
    const big = [
      ["d", "n", "a"],
      ...Array.from({ length: STATEMENT_MAX_ROWS + 1 }, () => ["01/10/2026", "x", "1"]),
    ];
    expect(() => mapStatement(big, { date: 0, description: 1, amount: 2 })).toThrow(/Tối đa/);
  });
});
