import { Buffer } from "node:buffer";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readXlsx, writeXlsx, XlsxError } from "./xlsx.ts";

interface TestEntry {
  name: string;
  data: string | Buffer;
  deflate?: boolean;
  /** Ghi đè kích thước giải nén khai báo (giả lập zip bomb khai dối). */
  usize?: number;
  flags?: number;
  method?: number;
}

/** Dựng ZIP thủ công trong test (độc lập với writer thật) để thử đường deflate và các file độc hại. */
function buildZip(entries: TestEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const deflate = e.deflate ?? true;
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = e.method ?? (deflate ? 8 : 0);
    const name = Buffer.from(e.name, "utf8");
    const usize = e.usize ?? raw.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const NSR = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const WORKBOOK = `<?xml version="1.0"?><workbook ${NS} ${NSR}><sheets><sheet name="Phòng" sheetId="1" r:id="rId7"/><sheet name="Khác" sheetId="2" r:id="rId8"/></sheets></workbook>`;
const RELS = (target: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId7" Type="x" Target="${target}"/></Relationships>`;

function baseEntries(sheet: string, extra: TestEntry[] = [], target = "worksheets/sheet1.xml"): TestEntry[] {
  return [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", data: RELS(target) },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    {
      name: "xl/worksheets/sheet2.xml",
      data: `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>999</v></c></row></sheetData></worksheet>`,
    },
    ...extra,
  ];
}

const SST = `<?xml version="1.0"?><sst ${NS}><si><t>Mã phòng</t></si><si><r><t xml:space="preserve">Tầng </t></r><r><rPr><b/></rPr><t>1</t></r><rPh sb="0" eb="1"><t>ghi chú âm</t></rPh></si><si><t>A &amp; B &lt;c&gt; &#65;&#x42;</t></si></sst>`;

describe("writeXlsx → readXlsx (round-trip)", () => {
  it("chuỗi tiếng Việt, ký tự XML đặc biệt, số nguyên/thập phân, ô trống giữa", () => {
    const rows: (string | number)[][] = [
      ["Mã phòng", "Giá thuê", "Ghi chú"],
      ["P101", 1580000, 'Nguyễn "Văn" <A> & B'],
      ["P102", 1250.5, ""],
      ["", "", "chỉ cột C"],
      [],
      ["Đ", 0, -500000],
      ["  khoảng trắng  ", 3, "dòng 1\r\ndòng 2\tTab"],
    ];
    const got = readXlsx(writeXlsx([{ name: "Phòng", rows }]));
    expect(got.map((r) => r.rowNo)).toEqual([1, 2, 3, 4, 6, 7]); // hàng 5 trống bị bỏ, rowNo giữ số hàng Excel
    expect(got[0]?.cells).toEqual([
      { v: "Mã phòng", numeric: false },
      { v: "Giá thuê", numeric: false },
      { v: "Ghi chú", numeric: false },
    ]);
    expect(got[1]?.cells).toEqual([
      { v: "P101", numeric: false },
      { v: "1580000", numeric: true },
      { v: 'Nguyễn "Văn" <A> & B', numeric: false },
    ]);
    // Ô trống cuối hàng không được ghi → hàng ngắn hơn; ô trống giữa được điền "".
    expect(got[2]?.cells).toEqual([
      { v: "P102", numeric: false },
      { v: "1250.5", numeric: true },
    ]);
    expect(got[3]?.cells).toEqual([
      { v: "", numeric: false },
      { v: "", numeric: false },
      { v: "chỉ cột C", numeric: false },
    ]);
    expect(got[4]?.cells).toEqual([
      { v: "Đ", numeric: false },
      { v: "0", numeric: true },
      { v: "-500000", numeric: true },
    ]);
    expect(got[5]?.cells[0]?.v).toBe("  khoảng trắng  ");
    expect(got[5]?.cells[2]?.v).toBe("dòng 1\r\ndòng 2\tTab");
  });

  it("chỉ đọc sheet đầu tiên; sheet rỗng → mảng rỗng", () => {
    const bytes = writeXlsx([
      { name: "A", rows: [["một"]] },
      { name: "B", rows: [["hai"]] },
    ]);
    expect(readXlsx(bytes)).toEqual([{ rowNo: 1, cells: [{ v: "một", numeric: false }] }]);
    expect(readXlsx(writeXlsx([{ name: "A", rows: [] }]))).toEqual([]);
  });

  it("cột xa (AA, AB) và Unicode ngoài BMP", () => {
    const row = Array.from({ length: 29 }, (_, i) => (i === 28 ? "😀 cuối" : ""));
    const got = readXlsx(writeXlsx([{ name: "A", rows: [row] }]));
    expect(got[0]?.cells.length).toBe(29);
    expect(got[0]?.cells[28]?.v).toBe("😀 cuối");
  });

  it("tên sheet: cắt 31 ký tự, thay ký tự cấm, trùng/rỗng", () => {
    const long = "Đ".repeat(40);
    const bytes = writeXlsx([{ name: long, rows: [["x"]] }]);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("sheetId");
    expect(readXlsx(bytes)).toHaveLength(1);
    expect(() =>
      writeXlsx([
        { name: "a", rows: [] },
        { name: "A", rows: [] },
      ]),
    ).toThrow(XlsxError);
    expect(() => writeXlsx([])).toThrow(XlsxError);
    expect(() => writeXlsx([{ name: "A", rows: [[Number.NaN]] }])).toThrow(XlsxError);
  });

  it("đầu ra là ZIP hợp lệ: có EOCD, CRC đúng, tên entry chuẩn", () => {
    const bytes = writeXlsx([{ name: "A", rows: [["x", 1]] }]);
    const b = Buffer.from(bytes);
    expect(b.readUInt32LE(0)).toBe(0x04034b50);
    expect(b.readUInt32LE(b.length - 22)).toBe(0x06054b50);
    expect(b.readUInt16LE(b.length - 22 + 10)).toBe(5);
    const s = b.toString("latin1");
    for (const n of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(s).toContain(n);
    }
  });

  it("đầu ra tất định", () => {
    const a = writeXlsx([{ name: "A", rows: [["x", 1]] }]);
    const b = writeXlsx([{ name: "A", rows: [["x", 1]] }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("readXlsx — file dựng tay (deflate, sharedStrings, công thức)", () => {
  const sheet = `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:D3"/><cols><col min="1" max="1" width="10"/></cols><sheetData>
    <row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve"> P1 </t></is></c><c r="B2" s="3"><v>4</v></c><c r="C2"><f>B2*2</f><v>8</v></c><c r="D2" s="5"><v>46327</v></c></row>
    <row r="3"><c r="A3" t="str"><f>CONCATENATE("=","x")</f><v>kết quả</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="e"><v>#DIV/0!</v></c><c r="D3"><f>1+1</f></c></row>
    <row r="4"><c r="A4" s="1"/><c r="B4"/></row>
    <row r="7"><c r="C7"><v>1.5E-3</v></c></row>
  </sheetData></worksheet>`;
  const bytes = buildZip(baseEntries(sheet, [{ name: "xl/sharedStrings.xml", data: SST }]));

  it("shared string (gồm rich text, bỏ chú âm), công thức chỉ lấy giá trị đã lưu, ngày seri là số", () => {
    const rows = readXlsx(bytes);
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2, 3, 7]); // hàng 4 chỉ có ô style → bị bỏ
    const [r1, r2, r3, r7] = rows;
    expect(r1?.cells).toEqual([
      { v: "Mã phòng", numeric: false },
      { v: "Tầng 1", numeric: false },
      { v: "", numeric: false },
      { v: "A & B <c> AB", numeric: false },
    ]);
    expect(r2?.cells[0]).toEqual({ v: " P1 ", numeric: false });
    expect(r2?.cells[1]).toEqual({ v: "4", numeric: true });
    expect(r2?.cells[2]).toEqual({ v: "8", numeric: true }); // C2 = B2*2: giá trị đã lưu
    expect(r2?.cells[3]).toEqual({ v: "46327", numeric: true });
    expect(r3?.cells).toEqual([
      { v: "kết quả", numeric: false },
      { v: "TRUE", numeric: false },
      { v: "#DIV/0!", numeric: false },
      { v: "", numeric: false }, // công thức chưa có giá trị lưu → rỗng, không tính lại
    ]);
    expect(r7?.cells).toEqual([
      { v: "", numeric: false },
      { v: "", numeric: false },
      { v: "0.0015", numeric: true },
    ]);
  });

  it("không có dấu vết công thức nào trong kết quả", () => {
    const dump = JSON.stringify(readXlsx(bytes));
    expect(dump).not.toContain("B2*2");
    expect(dump).not.toContain("CONCATENATE");
    expect(dump).not.toContain("1+1");
  });

  it("không có sharedStrings.xml vẫn đọc được ô số/inlineStr", () => {
    const b = buildZip(
      baseEntries(
        `<worksheet ${NS}><sheetData><row r="2"><c r="B2"><v>5</v></c></row></sheetData></worksheet>`,
      ),
    );
    expect(readXlsx(b)).toEqual([
      {
        rowNo: 2,
        cells: [
          { v: "", numeric: false },
          { v: "5", numeric: true },
        ],
      },
    ]);
  });

  it("ô không có thuộc tính r: tự nối tiếp cột/hàng", () => {
    const b = buildZip(
      baseEntries(
        `<worksheet ${NS}><sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row><c t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`,
      ),
    );
    expect(readXlsx(b).map((r) => [r.rowNo, r.cells.map((c) => c.v)])).toEqual([
      [1, ["1", "2"]],
      [2, ["x"]],
    ]);
  });

  it("target tuyệt đối /xl/... và tương đối có ..", () => {
    const sheet1 = `<worksheet ${NS}><sheetData><row r="1"><c t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>`;
    expect(readXlsx(buildZip(baseEntries(sheet1, [], "/xl/worksheets/sheet1.xml")))[0]?.cells[0]?.v).toBe(
      "ok",
    );
    expect(readXlsx(buildZip(baseEntries(sheet1, [], "../xl/worksheets/sheet1.xml")))[0]?.cells[0]?.v).toBe(
      "ok",
    );
    expect(() => readXlsx(buildZip(baseEntries(sheet1, [], "../../etc/passwd")))).toThrow(XlsxError);
  });

  it("ô số hỏng, chỉ số shared string sai, địa chỉ ô sai → XlsxError", () => {
    const bad = (cell: string) =>
      buildZip(
        baseEntries(`<worksheet ${NS}><sheetData><row r="1">${cell}</row></sheetData></worksheet>`, [
          { name: "xl/sharedStrings.xml", data: SST },
        ]),
      );
    expect(() => readXlsx(bad('<c r="A1"><v>abc</v></c>'))).toThrow(XlsxError);
    expect(() => readXlsx(bad('<c r="A1"><v>Infinity</v></c>'))).toThrow(XlsxError);
    expect(() => readXlsx(bad('<c r="A1" t="s"><v>99</v></c>'))).toThrow(XlsxError);
    expect(() => readXlsx(bad('<c r="1A"><v>1</v></c>'))).toThrow(XlsxError);
    expect(() => readXlsx(bad('<c r="ZZZ1"><v>1</v></c>'))).toThrow(XlsxError); // vượt XFD
    expect(() => readXlsx(bad('<c r="A1" t="inlineStr"><is><t>&#0;</t></is></c>'))).toThrow(XlsxError);
  });

  it("trần số ô chống phình bộ nhớ", () => {
    const b = writeXlsx([
      {
        name: "A",
        rows: [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ],
      },
    ]);
    expect(() =>
      readXlsx(b, { maxEntries: 2000, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxCells: 5 }),
    ).toThrow(XlsxError);
    expect(
      readXlsx(b, { maxEntries: 2000, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxCells: 6 }),
    ).toHaveLength(2);
  });

  it("thiếu workbook/rels/sheet → XlsxError", () => {
    expect(() => readXlsx(buildZip([{ name: "a.txt", data: "x" }]))).toThrow(XlsxError);
    const noSheet = baseEntries("<worksheet/>").filter((e) => e.name !== "xl/worksheets/sheet1.xml");
    expect(() => readXlsx(buildZip(noSheet))).toThrow(XlsxError);
  });

  it("macro và liên kết ngoài không bao giờ được mở", () => {
    const b = buildZip(
      baseEntries(
        `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
        [
          { name: "xl/vbaProject.bin", data: Buffer.from([1, 2, 3]), usize: 3 },
          { name: "xl/externalLinks/externalLink1.xml", data: "<<<không phải XML>>>" },
        ],
      ),
    );
    expect(readXlsx(b)).toHaveLength(1);
  });
});

describe("readXlsx — file độc hại / hỏng", () => {
  const limits = { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 2048 };
  const sheet = `<worksheet ${NS}><sheetData/></worksheet>`;

  it("bytes rác / quá ngắn / rỗng → XlsxError", () => {
    expect(() => readXlsx(new Uint8Array(0))).toThrow(XlsxError);
    expect(() => readXlsx(new TextEncoder().encode("đây không phải xlsx, chỉ là chữ"))).toThrow(XlsxError);
    expect(() => readXlsx(new Uint8Array(1000).fill(0x50))).toThrow(XlsxError);
    const good = writeXlsx([{ name: "A", rows: [["x"]] }]);
    expect(() => readXlsx(good.subarray(0, good.length - 30))).toThrow(XlsxError); // cắt cụt
  });

  it("entry khai kích thước lớn hơn giới hạn → XlsxError", () => {
    const b = buildZip(baseEntries(sheet, [{ name: "xl/big.bin", data: "x", usize: 10 * 1024 }]));
    expect(() => readXlsx(b, limits)).toThrow(/vượt giới hạn/);
  });

  it("tổng khai báo vượt maxTotalBytes → XlsxError", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `xl/p${i}.bin`, data: "x", usize: 900 }));
    expect(() => readXlsx(buildZip(baseEntries(sheet, entries)), limits)).toThrow(XlsxError);
  });

  it("zip bomb thật: khai nhỏ nhưng inflate vượt khai báo/giới hạn → XlsxError", () => {
    const bomb = Buffer.alloc(5 * 1024 * 1024, 0x61); // nén còn vài KB
    const lying = buildZip([
      ...baseEntries(sheet).slice(0, 3),
      { name: "xl/worksheets/sheet1.xml", data: bomb, usize: 100 },
    ]);
    expect(() => readXlsx(lying)).toThrow(XlsxError);
    const honest = buildZip([
      ...baseEntries(sheet).slice(0, 3),
      { name: "xl/worksheets/sheet1.xml", data: bomb },
    ]);
    expect(() =>
      readXlsx(honest, { maxEntries: 10, maxEntryBytes: 1024 * 1024, maxTotalBytes: 1 << 30 }),
    ).toThrow(XlsxError);
  });

  it("kích thước khai báo không khớp dữ liệu thật → XlsxError", () => {
    const entries = baseEntries(sheet);
    const lying = entries.map((e) =>
      e.name === "xl/worksheets/sheet1.xml" ? { ...e, usize: e.data.length + 5 } : e,
    );
    expect(() => readXlsx(buildZip(lying))).toThrow(XlsxError);
  });

  it("quá nhiều entry → XlsxError", () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({ name: `xl/p${i}.xml`, data: "x" }));
    expect(() => readXlsx(buildZip(entries), limits)).toThrow(/quá nhiều/);
  });

  it("tên entry chứa .. hoặc tuyệt đối/backslash → XlsxError", () => {
    for (const name of ["../x", "xl/../../x", "/etc/passwd", "xl\\evil.xml"]) {
      expect(() => readXlsx(buildZip(baseEntries(sheet, [{ name, data: "x" }])))).toThrow(XlsxError);
    }
  });

  it("mã hoá, method lạ, trùng tên → XlsxError", () => {
    expect(() => readXlsx(buildZip(baseEntries(sheet, [{ name: "xl/s.bin", data: "x", flags: 1 }])))).toThrow(
      /mã hoá/,
    );
    expect(() =>
      readXlsx(buildZip(baseEntries(sheet, [{ name: "xl/s.bin", data: "x", method: 12 }]))),
    ).toThrow(/Kiểu nén/);
    expect(() =>
      readXlsx(buildZip(baseEntries(sheet, [{ name: "xl/workbook.xml", data: WORKBOOK }]))),
    ).toThrow(/trùng/);
  });

  it("CRC sai → XlsxError", () => {
    const good = Buffer.from(writeXlsx([{ name: "A", rows: [["x"]] }]));
    const at = good.indexOf("<worksheet");
    good[at + 2] = good[at + 2] === 0x41 ? 0x42 : 0x41; // sửa 1 byte nội dung sheet (store)
    expect(() => readXlsx(new Uint8Array(good))).toThrow(/CRC/);
  });

  it("ZIP64 → XlsxError", () => {
    const b = Buffer.from(writeXlsx([{ name: "A", rows: [["x"]] }]));
    b.writeUInt16LE(0xffff, b.length - 22 + 10);
    expect(() => readXlsx(new Uint8Array(b))).toThrow(/ZIP64/);
  });

  it("đọc đúng khi Uint8Array là một lát của buffer lớn hơn (byteOffset ≠ 0)", () => {
    const good = writeXlsx([{ name: "A", rows: [["xin chào"]] }]);
    const holder = new Uint8Array(good.length + 17);
    holder.set(good, 9);
    expect(readXlsx(holder.subarray(9, 9 + good.length))[0]?.cells[0]?.v).toBe("xin chào");
  });
});
