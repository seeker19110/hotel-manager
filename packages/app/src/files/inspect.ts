// Kiểm nội dung file (TM-07): nhận dạng bằng magic bytes (không tin Content-Type/đuôi), bỏ EXIF/metadata ảnh,
// quét mã độc qua adapter. Công cụ quét thật (ClamAV…) là câu hỏi mở của SPEC-housekeeping — adapter mặc định chỉ
// nhận chữ ký EICAR để kiểm đường xử lý file bị từ chối.

export type DetectedMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export function detectMime(b: Uint8Array): DetectedMime | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

export class CorruptFileError extends Error {}

/** JPEG: bỏ mọi APP1 (Exif/XMP, chứa GPS) và APP13 (IPTC); giữ nguyên dữ liệu ảnh. */
function stripJpeg(b: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new CorruptFileError("JPEG hỏng");
    const marker = b[i + 1] as number;
    if (marker === 0xda || marker === 0xd9) {
      for (let k = i; k < b.length; k++) out.push(b[k] as number);
      return Uint8Array.from(out);
    }
    const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    if (len < 2 || i + 2 + len > b.length) throw new CorruptFileError("JPEG hỏng");
    const drop = marker === 0xe1 || marker === 0xed;
    if (!drop) for (let k = i; k < i + 2 + len; k++) out.push(b[k] as number);
    i += 2 + len;
  }
  throw new CorruptFileError("JPEG hỏng");
}

/** PNG: bỏ chunk metadata (eXIf, tEXt, iTXt, zTXt, tIME). */
function stripPng(b: Uint8Array): Uint8Array {
  const drop = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const out: number[] = Array.from(b.subarray(0, 8));
  let i = 8;
  while (i + 12 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new CorruptFileError("PNG hỏng");
    if (!drop.has(type)) for (let k = i; k < end; k++) out.push(b[k] as number);
    i = end;
    if (type === "IEND") break;
  }
  return Uint8Array.from(out);
}

/** WebP (RIFF): bỏ chunk EXIF và XMP, sửa lại kích thước RIFF. */
function stripWebp(b: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(i, i + 4));
    const len = new DataView(b.buffer, b.byteOffset + i + 4, 4).getUint32(0, true);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) throw new CorruptFileError("WebP hỏng");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push(b.subarray(i, end));
    i = end;
  }
  const size = 4 + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(8 + size);
  out.set(b.subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, size, true);
  out.set(b.subarray(8, 12), 8);
  let o = 12;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function stripImageMetadata(b: Uint8Array, mime: DetectedMime): Uint8Array {
  if (mime === "image/jpeg") return stripJpeg(b);
  if (mime === "image/png") return stripPng(b);
  if (mime === "image/webp") return stripWebp(b);
  return b;
}

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<{ clean: true } | { clean: false; reason: string }>;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Adapter tối thiểu cho dev/CI: chỉ nhận chuỗi kiểm thử EICAR. Production phải thay bằng máy quét thật. */
export const eicarOnlyScanner: MalwareScanner = {
  async scan(bytes) {
    const text = Buffer.from(bytes).toString("latin1");
    return text.includes(EICAR) ? { clean: false, reason: "EICAR-Test-Signature" } : { clean: true };
  },
};
