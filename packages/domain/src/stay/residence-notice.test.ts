import { describe, expect, it } from "vitest";
import {
  buildNoticeCsv,
  MAX_NOTICE_COLUMNS,
  type NoticeGuest,
  type NoticeStay,
  parseNoticeTemplate,
} from "./residence-notice.ts";

const STAY: NoticeStay = {
  unitCode: "203",
  checkedInLocal: "2026-10-15 20:10",
  departureDate: "2026-10-17",
  isForeign: false,
};
const VN: NoticeGuest = {
  fullName: "Nguyễn Văn A",
  nationality: null,
  docType: "cccd",
  docNumber: "079123456789",
};

describe("parseNoticeTemplate", () => {
  it("nhận mẫu hợp lệ, chuẩn hoá trường tuỳ chọn", () => {
    expect(parseNoticeTemplate({ columns: ["full_name", "doc_number"] })).toEqual({
      columns: ["full_name", "doc_number"],
      foreignColumns: [],
      required: [],
    });
    expect(
      parseNoticeTemplate({
        columns: ["full_name"],
        foreign_columns: ["nationality", "passport_number"],
        required: ["full_name", "passport_number"],
      }),
    ).toMatchObject({ foreignColumns: ["nationality", "passport_number"] });
  });

  it.each([
    ["null", null],
    ["mảng", []],
    ["rỗng", {}],
    ["columns rỗng", { columns: [] }],
    ["khoá lạ trong mẫu", { columns: ["full_name"], phone_column: true }],
    ["trường ngoài danh mục (SĐT)", { columns: ["full_name", "phone"] }],
    ["trường ngoài danh mục (số tiền)", { columns: ["full_name", "amount"] }],
    ["trùng cột", { columns: ["full_name", "full_name"] }],
    ["cột nước ngoài trùng cột chung", { columns: ["full_name"], foreign_columns: ["full_name"] }],
    ["required ngoài cột", { columns: ["full_name"], required: ["doc_number"] }],
    ["không phải chuỗi", { columns: [1] }],
    ["quá nhiều cột", { columns: Array.from({ length: MAX_NOTICE_COLUMNS + 1 }, () => "stt") }],
    ["chuỗi", "full_name"],
  ])("từ chối mẫu không hợp lệ: %s", (_n, raw) => {
    expect(parseNoticeTemplate(raw)).toBeNull();
  });
});

describe("buildNoticeCsv", () => {
  const T = parseNoticeTemplate({
    columns: ["stt", "full_name", "doc_type", "doc_number", "unit_code"],
    foreign_columns: ["nationality", "passport_number"],
    required: ["full_name", "doc_number", "passport_number"],
  });
  if (!T) throw new Error("mẫu thử phải hợp lệ");

  it("một dòng mỗi người, tiêu đề tiếng Việt, BOM + CRLF; không có cột ngoài mẫu (không SĐT/tiền)", () => {
    const { csv, missing } = buildNoticeCsv(T, STAY, [VN]);
    expect(missing).toEqual([]);
    expect(csv).toBe(
      "﻿STT,Họ và tên,Loại giấy tờ,Số giấy tờ,Số phòng\r\n1,Nguyễn Văn A,cccd,079123456789,203",
    );
    expect(csv).not.toMatch(/phone|điện thoại|amount|tiền/i);
  });

  it("khách nước ngoài: thêm quốc tịch + số hộ chiếu theo mẫu (S-030)", () => {
    const foreign: NoticeGuest = {
      fullName: "John Smith",
      nationality: "US",
      docType: "passport",
      docNumber: "X1234567",
    };
    const r = buildNoticeCsv(T, { ...STAY, isForeign: true }, [foreign]);
    expect(r.columns).toEqual([
      "stt",
      "full_name",
      "doc_type",
      "doc_number",
      "unit_code",
      "nationality",
      "passport_number",
    ]);
    expect(r.csv.split("\r\n")[1]).toBe("1,John Smith,passport,X1234567,203,US,X1234567");
    expect(r.missing).toEqual([]);
  });

  it("thiếu số giấy tờ → danh sách trường thiếu theo guests[i]; trường nước ngoài chỉ bắt buộc với khách nước ngoài", () => {
    const noDoc: NoticeGuest = { ...VN, docNumber: null, docType: null };
    const child: NoticeGuest = {
      fullName: "Bé B",
      nationality: "VN",
      docType: "other",
      docNumber: "GS-0001",
    };
    const r = buildNoticeCsv(T, { ...STAY, isForeign: true }, [child, noDoc]);
    // `passport_number` (cột nước ngoài) không bắt buộc với khách VN; `doc_number` thiếu của người thứ hai thì bắt buộc.
    expect(r.missing).toEqual([{ path: "guests[1].doc_number", field: "doc_number" }]);
  });

  it("khách nước ngoài thiếu hộ chiếu → thiếu passport_number", () => {
    const f: NoticeGuest = { fullName: "Jane", nationality: "FR", docType: "other", docNumber: "ID-12345" };
    const r = buildNoticeCsv(T, { ...STAY, isForeign: true }, [f]);
    expect(r.missing).toEqual([{ path: "guests[0].passport_number", field: "passport_number" }]);
  });

  it("chống formula injection và quote: tên bắt đầu bằng = + - @, có dấu phẩy/ngoặc kép/xuống dòng, Unicode", () => {
    const names = [
      '=HYPERLINK("http://x")',
      "+84 912",
      "-1+1",
      "@SUM(A1)",
      'Lê "Bảo", Jr',
      "Trần\nVăn",
      "\tTab",
      "Đặng Thị Ánh",
    ];
    const guests = names.map((n) => ({ ...VN, fullName: n }));
    const lines = buildNoticeCsv(T, STAY, guests).csv;
    expect(lines).toContain("'=HYPERLINK");
    expect(lines).toContain(",'+84 912,");
    expect(lines).toContain(",'-1+1,");
    expect(lines).toContain(",'@SUM(A1),");
    expect(lines).toContain('"Lê ""Bảo"", Jr"');
    expect(lines).toContain('"Trần\nVăn"');
    expect(lines).toContain("'\tTab");
    expect(lines).toContain("Đặng Thị Ánh");
    // Không ô nào bắt đầu bằng ký tự công thức trần.
    for (const row of lines.split("\r\n").slice(1)) expect(row).not.toMatch(/^\d+,[=+\-@]/);
  });

  it("danh sách khách rỗng → chỉ có tiêu đề, không thiếu trường", () => {
    const r = buildNoticeCsv(T, STAY, []);
    expect(r.csv.split("\r\n")).toHaveLength(1);
    expect(r.missing).toEqual([]);
  });
});
