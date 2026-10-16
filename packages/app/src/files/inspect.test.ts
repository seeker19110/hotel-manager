// Bỏ metadata ảnh (TM-07): ca biên do review độc lập tái hiện — ảnh phụ nối đuôi mang GPS, byte đệm, COM,
// PNG/WebP dị dạng, cờ VP8X, hiệu năng file 10 MB.
import { describe, expect, it } from "vitest";
import { CorruptFileError, detectMime, stripImageMetadata } from "./inspect.ts";

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

  it("10 MB không chặn event loop (< 250 ms)", () => {
    const body = new Uint8Array(10 * 1024 * 1024).fill(0x11);
    const big = Uint8Array.from([...Array.from(jpeg().subarray(0, -2))]);
    const all = new Uint8Array(big.length + body.length + 2);
    all.set(big, 0);
    all.set(body, big.length);
    all.set([0xff, 0xd9], big.length + body.length);
    const t0 = performance.now();
    stripImageMetadata(all, "image/jpeg");
    expect(performance.now() - t0).toBeLessThan(250);
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
