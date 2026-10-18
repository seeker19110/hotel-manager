// SPEC-housekeeping-maintenance S-016: giữ riêng thẻ Orientation (D-049), bỏ mọi metadata khác.
// Bỏ metadata ảnh (TM-07): ca biên do review độc lập tái hiện — ảnh phụ nối đuôi mang GPS, byte đệm, COM,
// PNG/WebP dị dạng, cờ VP8X, hiệu năng file 10 MB.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CorruptFileError, detectMime, readTiffOrientation, stripImageMetadata } from "./inspect.ts";

const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const seg = (marker: number, data: Uint8Array) => [
  0xff,
  marker,
  (data.length + 2) >> 8,
  (data.length + 2) & 0xff,
  ...data,
];
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

function jpeg(extra: number[] = [], tail: number[] = []): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xe1, ascii("Exif\0\0GPSLatitude=21.0285")),
    ...extra,
    ...seg(0xda, ascii("\x01\x01\0\0?\0")),
    0x12,
    0xff,
    0x00, // byte 0xFF trong dữ liệu entropy (stuffed)
    0x34,
    0xff,
    0xd0, // RST0
    0x56,
    0xff,
    0xd9,
    ...tail,
  ]);
}

describe("stripImageMetadata — JPEG", () => {
  it("bỏ APP1 (Exif/GPS) và COM, giữ dữ liệu ảnh nguyên vẹn", () => {
    const out = stripImageMetadata(jpeg(seg(0xfe, ascii("SDT 0100005678"))), "image/jpeg");
    expect(text(out)).not.toMatch(/Exif|GPS|0100005678/);
    expect(text(out)).toContain("JFIF");
    expect(Array.from(out.subarray(-9))).toEqual([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]);
  });

  it("ảnh phụ nối sau EOI (MPF/gain-map mang Exif/GPS) bị cắt", () => {
    const secondary = Array.from(jpeg());
    const out = stripImageMetadata(jpeg([], secondary), "image/jpeg");
    expect(text(out)).not.toMatch(/Exif|GPS/);
    expect(Array.from(out.subarray(-2))).toEqual([0xff, 0xd9]);
    expect(out.indexOf(0xd8, 2)).toBe(-1);
  });

  it("byte đệm 0xFF trước marker là hợp lệ", () => {
    const b = Array.from(jpeg());
    b.splice(2, 0, 0xff, 0xff); // FF FF FF E0 …
    expect(text(stripImageMetadata(Uint8Array.from(b), "image/jpeg"))).toContain("JFIF");
  });

  it("nhiều scan (progressive) với DHT xen giữa được giữ", () => {
    const b = jpeg([], []);
    const withSecondScan = Uint8Array.from([
      ...Array.from(b.subarray(0, -2)),
      ...seg(0xc4, ascii("DHT")),
      ...seg(0xda, ascii("\x01\x01\0\0?\0")),
      0x77,
      0xff,
      0xd9,
    ]);
    const out = stripImageMetadata(withSecondScan, "image/jpeg");
    expect(text(out)).toContain("DHT");
    expect(out[out.length - 3]).toBe(0x77);
  });

  it("thiếu EOI hoặc marker sai → CorruptFileError", () => {
    expect(() => stripImageMetadata(jpeg().subarray(0, -2), "image/jpeg")).toThrow(CorruptFileError);
    expect(() => stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0x00, 0x01]), "image/jpeg")).toThrow(
      CorruptFileError,
    );
  });

  it("dữ liệu entropy kết thúc bằng 0xFF lẻ hoặc chỉ có 0xFF00/RST mà không có EOI → CorruptFileError", () => {
    const head = Array.from(jpeg().subarray(0, -9)); // tới hết SOS header, trước dữ liệu entropy
    const lone = Uint8Array.from([...head, 0x12, 0x34, 0xff]);
    const stuffedOnly = Uint8Array.from([...head, 0x12, 0xff, 0x00, 0xff, 0xd3, 0x56]);
    const noEntropy = Uint8Array.from(head);
    for (const bad of [lone, stuffedOnly, noEntropy]) {
      expect(() => stripImageMetadata(bad, "image/jpeg")).toThrow(CorruptFileError);
    }
  });

  it("0xFF 0xFF đệm trong dữ liệu entropy rồi EOI vẫn tìm đúng EOI", () => {
    const head = Array.from(jpeg().subarray(0, -9));
    const out = stripImageMetadata(
      Uint8Array.from([...head, 0x12, 0xff, 0xff, 0xff, 0xd9, 0xaa, 0xbb]),
      "image/jpeg",
    );
    expect(Array.from(out.subarray(-3))).toEqual([0xff, 0xff, 0xd9]);
    expect(text(out)).not.toMatch(/Exif|GPS/);
  });

  it("10 MB không chặn event loop (< 250 ms)", () => {
    const body = new Uint8Array(10 * 1024 * 1024).fill(0x11);
    const big = Uint8Array.from([...Array.from(jpeg().subarray(0, -2))]);
    const all = new Uint8Array(big.length + body.length + 2);
    all.set(big, 0);
    all.set(body, big.length);
    all.set([0xff, 0xd9], big.length + body.length);
    // Đo CPU time của chính thao tác (không phải thời gian thực): khi máy chạy nhiều bộ test song song, thời gian chờ
    // lịch CPU làm đồng hồ thực vượt ngưỡng dù thao tác không chậm hơn (lặp 3 lần ở đợt 4–5). Ngưỡng giữ nguyên 250 ms.
    const c0 = process.cpuUsage();
    stripImageMetadata(all, "image/jpeg");
    const c = process.cpuUsage(c0);
    expect((c.user + c.system) / 1000).toBeLessThan(250);
  });
});

function pngChunk(type: string, data: Uint8Array): number[] {
  const n = data.length;
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...ascii(type), ...data, 0, 0, 0, 0];
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("stripImageMetadata — PNG", () => {
  it("bắt buộc IHDR đầu tiên và IEND", () => {
    const junk = Uint8Array.from([...PNG_SIG, 1, 2, 3, 4, 5]);
    expect(detectMime(junk)).toBe("image/png");
    expect(() => stripImageMetadata(junk, "image/png")).toThrow(CorruptFileError);
    const noIhdr = Uint8Array.from([
      ...PNG_SIG,
      ...pngChunk("IDAT", ascii("x")),
      ...pngChunk("IEND", new Uint8Array()),
    ]);
    expect(() => stripImageMetadata(noIhdr, "image/png")).toThrow(CorruptFileError);
    const noIend = Uint8Array.from([...PNG_SIG, ...pngChunk("IHDR", new Uint8Array(13))]);
    expect(() => stripImageMetadata(noIend, "image/png")).toThrow(CorruptFileError);
  });

  it("bỏ tEXt, cắt mọi byte sau IEND", () => {
    const b = Uint8Array.from([
      ...PNG_SIG,
      ...pngChunk("IHDR", new Uint8Array(13)),
      ...pngChunk("tEXt", ascii("Comment\0SDT 0100005678")),
      ...pngChunk("IEND", new Uint8Array()),
      ...ascii("GPS sau IEND"),
    ]);
    const out = stripImageMetadata(b, "image/png");
    expect(text(out)).not.toMatch(/0100005678|GPS/);
  });
});

describe("stripImageMetadata — WebP", () => {
  it("bỏ EXIF/XMP, xoá cờ trong VP8X, sửa kích thước RIFF", () => {
    const chunk = (cc: string, data: Uint8Array) => {
      const n = data.length;
      return [
        ...ascii(cc),
        n & 0xff,
        (n >> 8) & 0xff,
        (n >> 16) & 0xff,
        n >>> 24,
        ...data,
        ...(n % 2 ? [0] : []),
      ];
    };
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF + XMP + alpha
    const body = [
      ...ascii("WEBP"),
      ...chunk("VP8X", vp8x),
      ...chunk("VP8 ", ascii("data")),
      ...chunk("EXIF", ascii("GPSLatitude")),
      ...chunk("XMP ", ascii("<x:xmpmeta/>")),
    ];
    const n = body.length;
    const b = Uint8Array.from([
      ...ascii("RIFF"),
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      n >>> 24,
      ...body,
    ]);
    const out = stripImageMetadata(b, "image/webp");
    expect(text(out)).not.toMatch(/GPS|xmpmeta/);
    expect(out[20]).toBe(0x10); // chỉ còn cờ alpha
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
  });
});

// ───────── S-016 giữ riêng thẻ Orientation (D-049) ─────────
// Trình đọc Exif tối thiểu của test: đi qua IFD0 và mọi IFD con (GPS 0x8825, Exif 0x8769), trả danh sách thẻ + giá trị Orientation.
function tiffTags(tiff: Uint8Array): { tags: number[]; orientation: number | null } {
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49;
  const tags: number[] = [];
  let orientation: number | null = null;
  const walk = (off: number, depth: number) => {
    if (depth > 3 || off === 0) return;
    const n = v.getUint16(off, le);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      const tag = v.getUint16(e, le);
      tags.push(tag);
      if (tag === 0x0112) orientation = v.getUint16(e + 8, le);
      if (tag === 0x8825 || tag === 0x8769) walk(v.getUint32(e + 8, le), depth + 1);
    }
    walk(v.getUint32(off + 2 + n * 12, le), depth + 1);
  };
  walk(v.getUint32(4, le), 0);
  return { tags, orientation };
}

/** Mọi khối Exif (APP1 "Exif\0\0") trong JPEG → thẻ của từng khối. */
function jpegExifBlocks(b: Uint8Array): { tags: number[]; orientation: number | null }[] {
  const out: { tags: number[]; orientation: number | null }[] = [];
  for (let i = 2; i + 4 <= b.length; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1] as number;
    if (marker === 0xda || marker === 0xd9) break;
    const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    if (marker === 0xe1 && text(b.subarray(i + 4, i + 10)) === "Exif\0\0") {
      out.push(tiffTags(b.subarray(i + 10, i + 2 + len)));
    }
    i += 2 + len;
  }
  return out;
}

/** TIFF thật của điện thoại: Orientation + Model + DateTime + con trỏ GPS (IFD GPS có vĩ/kinh độ) + Exif IFD. `le` chọn endian. */
function phoneTiff(orientation: number, le: boolean): Uint8Array {
  const buf = new Uint8Array(512);
  const v = new DataView(buf.buffer);
  const u16 = (o: number, x: number) => v.setUint16(o, x, le);
  const u32 = (o: number, x: number) => v.setUint32(o, x, le);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  u16(2, 42);
  u32(4, 8);
  // IFD0 tại 8: 5 mục (Model 0x0110, Orientation 0x0112, DateTime 0x0132, Exif 0x8769, GPS 0x8825)
  u16(8, 5);
  const entry = (k: number, tag: number, type: number, count: number, val: number, short = false) => {
    const e = 10 + k * 12;
    u16(e, tag);
    u16(e + 2, type);
    u32(e + 4, count);
    if (short) u16(e + 8, val);
    else u32(e + 8, val);
  };
  entry(0, 0x0110, 2, 12, 200);
  entry(1, 0x0112, 3, 1, orientation, true);
  entry(2, 0x0132, 2, 20, 220);
  entry(3, 0x8769, 4, 1, 260);
  entry(4, 0x8825, 4, 1, 300);
  u32(10 + 5 * 12, 0);
  buf.set(ascii("PhoneModelX\0"), 200);
  buf.set(ascii("2026:10:17 08:30:00\0"), 220);
  u16(260, 1); // Exif IFD: 1 mục (ExifVersion)
  u16(262, 0x9000);
  u16(264, 7);
  u32(266, 4);
  buf.set(ascii("0232"), 270);
  u32(274, 0);
  u16(300, 2); // GPS IFD: 2 mục (LatRef, Lat)
  u16(302, 0x0001);
  u16(304, 2);
  u32(306, 2);
  buf.set(ascii("N\0"), 310);
  u16(314, 0x0002);
  u16(316, 5);
  u32(318, 3);
  u32(322, 340);
  u32(326, 0);
  buf.set(ascii("GPSLatitude=21.0285"), 340);
  return buf.subarray(0, 400);
}

const jpegWithTiff = (tiff: Uint8Array) =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xe1, Uint8Array.from([...ascii("Exif\0\0"), ...tiff])),
    ...seg(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta GPS/>")),
    ...seg(0xda, ascii("\x01\x01\0\0?\0")),
    0x12,
    0xff,
    0xd9,
  ]);

describe("S-016 giữ thẻ Orientation, bỏ mọi metadata khác — JPEG", () => {
  for (const [orientation, le] of [
    [6, true],
    [6, false],
    [8, true],
    [8, false],
    [3, false],
  ] as const) {
    it(`Orientation ${orientation} (${le ? "II" : "MM"}) còn nguyên; GPS/model/thời điểm/Exif IFD biến mất`, () => {
      const src = jpegWithTiff(phoneTiff(orientation, le));
      expect(jpegExifBlocks(src)[0]?.tags).toEqual(expect.arrayContaining([0x0110, 0x0132, 0x8825, 0x0001]));
      const out = stripImageMetadata(src, "image/jpeg");
      const blocks = jpegExifBlocks(out);
      expect(blocks).toEqual([{ tags: [0x0112], orientation }]); // duy nhất một khối, duy nhất một thẻ
      expect(text(out)).not.toMatch(/GPS|PhoneModel|2026:10:17|0232|xmpmeta|adobe/);
      expect(text(out)).toContain("JFIF");
      expect(Array.from(out.subarray(-3))).toEqual([0x12, 0xff, 0xd9]);
    });
  }

  it("bản đầu ra ổn định: chạy lại bộ bỏ metadata trên kết quả cho đúng kết quả đó", () => {
    const once = stripImageMetadata(jpegWithTiff(phoneTiff(6, true)), "image/jpeg");
    expect(Array.from(stripImageMetadata(once, "image/jpeg"))).toEqual(Array.from(once));
  });

  it("Orientation 1 (mặc định), 0 hoặc 9 (ngoài 1–8), thiếu thẻ ⇒ không giữ khối Exif nào", () => {
    for (const o of [1, 0, 9, 0xffff]) {
      const out = stripImageMetadata(jpegWithTiff(phoneTiff(o, false)), "image/jpeg");
      expect(jpegExifBlocks(out), `o=${o}`).toEqual([]);
      expect(text(out)).not.toMatch(/Exif|GPS/);
    }
  });

  it("chỉ giữ Orientation của khối Exif ĐẦU TIÊN; khối Exif thứ hai (ảnh phụ/giả mạo) bị bỏ", () => {
    const first = Array.from(seg(0xe1, Uint8Array.from([...ascii("Exif\0\0"), ...phoneTiff(6, true)])));
    const second = seg(0xe1, Uint8Array.from([...ascii("Exif\0\0"), ...phoneTiff(8, true)]));
    const b = Array.from(jpegWithTiff(phoneTiff(6, true)));
    b.splice(2, 0, ...first, ...second);
    const blocks = jpegExifBlocks(stripImageMetadata(Uint8Array.from(b), "image/jpeg"));
    expect(blocks).toEqual([{ tags: [0x0112], orientation: 6 }]);
  });

  describe("khối Exif hỏng ⇒ không giữ gì, không ném lỗi, ảnh vẫn hợp lệ", () => {
    const good = phoneTiff(6, true);
    const patch = (fn: (v: DataView, b: Uint8Array) => void) => {
      const c = Uint8Array.from(good);
      fn(new DataView(c.buffer), c);
      return c;
    };
    const cases: [string, Uint8Array][] = [
      ["TIFF rỗng", new Uint8Array()],
      ["thiếu header (7 byte)", good.subarray(0, 7)],
      ["byte order lạ", patch((_, c) => c.set([0x58, 0x58], 0))],
      ["magic sai (43)", patch((v) => v.setUint16(2, 43, true))],
      ["offset IFD0 = 0", patch((v) => v.setUint32(4, 0, true))],
      ["offset IFD0 < 8", patch((v) => v.setUint32(4, 4, true))],
      ["offset IFD0 = 0xFFFFFFFF", patch((v) => v.setUint32(4, 0xffffffff, true))],
      ["offset IFD0 ngoài khối", patch((v) => v.setUint32(4, 100000, true))],
      ["offset IFD0 sát cuối (không đủ 2 byte đếm)", patch((v) => v.setUint32(4, 399, true))],
      ["số mục 0xFFFF tràn khối", patch((v) => v.setUint16(8, 0xffff, true))],
      ["IFD0 bị cắt giữa chừng", good.subarray(0, 30)],
      ["kiểu thẻ Orientation sai (LONG)", patch((v) => v.setUint16(10 + 12 + 2, 4, true))],
      ["đếm giá trị Orientation = 2", patch((v) => v.setUint32(10 + 12 + 4, 2, true))],
      ["endian khai báo MM nhưng dữ liệu little-endian", patch((_, c) => c.set([0x4d, 0x4d], 0))],
    ];
    for (const [name, tiff] of cases) {
      it(name, () => {
        expect(readTiffOrientation(tiff)).toBeNull();
        const out = stripImageMetadata(jpegWithTiff(tiff), "image/jpeg");
        expect(jpegExifBlocks(out)).toEqual([]);
        expect(text(out)).not.toMatch(/Exif|GPS|PhoneModel/);
        expect(text(out)).toContain("JFIF");
        expect(Array.from(out.subarray(-2))).toEqual([0xff, 0xd9]);
      });
    }

    it("APP1 chỉ có tiền tố Exif (không TIFF), hoặc không phải Exif ⇒ bỏ", () => {
      for (const data of [ascii("Exif\0\0"), ascii("Exif\0"), ascii("Exifxx"), ascii("hello")]) {
        const out = stripImageMetadata(
          Uint8Array.from([0xff, 0xd8, ...seg(0xe1, data), 0xff, 0xd9]),
          "image/jpeg",
        );
        expect(Array.from(out)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
      }
    });
  });
});

describe("S-016 giữ Orientation — PNG eXIf", () => {
  const png = (exif: Uint8Array | null) =>
    Uint8Array.from([
      ...PNG_SIG,
      ...pngChunk("IHDR", new Uint8Array(13)),
      ...(exif ? pngChunk("eXIf", exif) : []),
      ...pngChunk("tEXt", ascii("Comment\0SDT 0100005678")),
      ...pngChunk("IDAT", ascii("pixels")),
      ...pngChunk("IEND", new Uint8Array()),
    ]);
  const chunks = (b: Uint8Array) => {
    const out: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
    for (let i = 8; i < b.length; ) {
      const v = new DataView(b.buffer, b.byteOffset + i);
      const len = v.getUint32(0);
      const body = b.subarray(i + 4, i + 8 + len);
      out.push({
        type: text(b.subarray(i + 4, i + 8)),
        data: b.subarray(i + 8, i + 8 + len),
        // CRC thật: chunk do test dựng có CRC 0 nên chỉ kiểm chunk eXIf ta tạo
        crcOk: v.getUint32(8 + len) === crc32(body),
      });
      i += 12 + len;
    }
    return out;
  };

  for (const [o, le] of [
    [6, true],
    [8, false],
  ] as const) {
    it(`Orientation ${o}: dựng lại eXIf chỉ một thẻ, CRC đúng, đứng trước IDAT; tEXt vẫn bị bỏ`, () => {
      const out = stripImageMetadata(png(phoneTiff(o, le)), "image/png");
      const cs = chunks(out);
      expect(cs.map((c) => c.type)).toEqual(["IHDR", "eXIf", "IDAT", "IEND"]);
      const exif = cs[1] as (typeof cs)[number];
      expect(exif.crcOk).toBe(true);
      expect(tiffTags(exif.data)).toEqual({ tags: [0x0112], orientation: o });
      expect(text(out)).not.toMatch(/GPS|PhoneModel|0100005678/);
    });
  }

  it("eXIf hỏng, Orientation 1 hoặc không có eXIf ⇒ không có chunk eXIf", () => {
    const bad = phoneTiff(6, true);
    new DataView(bad.buffer, bad.byteOffset).setUint32(4, 0xffffffff, true);
    for (const exif of [bad, phoneTiff(1, true), new Uint8Array(), null]) {
      const cs = chunks(stripImageMetadata(png(exif), "image/png"));
      expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    }
  });
});

describe("S-016 giữ Orientation — WebP EXIF", () => {
  const chunk = (cc: string, data: Uint8Array) => {
    const n = data.length;
    return [
      ...ascii(cc),
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      n >>> 24,
      ...data,
      ...(n % 2 ? [0] : []),
    ];
  };
  const webp = (opts: { exif: Uint8Array | null; vp8x: boolean }) => {
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x08 | 0x04 | 0x10;
    const body = [
      ...ascii("WEBP"),
      ...(opts.vp8x ? chunk("VP8X", vp8x) : []),
      ...chunk("VP8 ", ascii("data")),
      ...(opts.exif ? chunk("EXIF", opts.exif) : []),
      ...chunk("XMP ", ascii("<x:xmpmeta GPS/>")),
    ];
    const n = body.length;
    return Uint8Array.from([
      ...ascii("RIFF"),
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      n >>> 24,
      ...body,
    ]);
  };
  const exifChunkOf = (b: Uint8Array): Uint8Array | null => {
    for (let i = 12; i + 8 <= b.length; ) {
      const len = new DataView(b.buffer, b.byteOffset + i + 4).getUint32(0, true);
      if (text(b.subarray(i, i + 4)) === "EXIF") return b.subarray(i + 8, i + 8 + len);
      i += 8 + len + (len % 2);
    }
    return null;
  };

  for (const [o, le, prefix] of [
    [6, true, false],
    [8, false, false],
    [6, true, true],
  ] as const) {
    it(`Orientation ${o}${prefix ? " (EXIF có tiền tố Exif\\0\\0)" : ""}: dựng lại chunk EXIF một thẻ, giữ cờ EXIF, xoá cờ XMP, RIFF đúng`, () => {
      const tiff = phoneTiff(o, le);
      const src = webp({
        exif: prefix ? Uint8Array.from([...ascii("Exif\0\0"), ...tiff]) : tiff,
        vp8x: true,
      });
      const out = stripImageMetadata(src, "image/webp");
      expect(out[20]).toBe(0x08 | 0x10); // EXIF + alpha, không XMP
      expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
      const exif = exifChunkOf(out) as Uint8Array;
      expect(tiffTags(exif)).toEqual({ tags: [0x0112], orientation: o });
      expect(text(out)).not.toMatch(/GPS|PhoneModel|xmpmeta/);
    });
  }

  it("EXIF hỏng, Orientation 1, không có EXIF hoặc không có VP8X ⇒ không chunk EXIF, cờ EXIF tắt", () => {
    const bad = phoneTiff(6, true);
    new DataView(bad.buffer, bad.byteOffset).setUint16(8, 0xffff, true);
    const cases = [
      webp({ exif: bad, vp8x: true }),
      webp({ exif: phoneTiff(1, true), vp8x: true }),
      webp({ exif: null, vp8x: true }),
      webp({ exif: phoneTiff(6, true), vp8x: false }),
    ];
    for (const [i, src] of cases.entries()) {
      const out = stripImageMetadata(src, "image/webp");
      expect(exifChunkOf(out), `ca ${i}`).toBeNull();
      if (i < 3) expect(out[20]).toBe(0x10);
      expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
    }
  });
});
