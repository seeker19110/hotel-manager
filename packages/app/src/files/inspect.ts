// Kiểm nội dung file (TM-07): nhận dạng bằng magic bytes (không tin Content-Type/đuôi), bỏ EXIF/metadata ảnh,
// quét mã độc qua adapter. Công cụ quét thật (ClamAV…) là câu hỏi mở của SPEC-housekeeping — adapter mặc định chỉ
// nhận chữ ký EICAR để kiểm đường xử lý file bị từ chối.

import { crc32 } from "node:zlib";

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

function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

// ───────── Giữ riêng thẻ Orientation (SPEC-housekeeping-maintenance S-016, D-049) ─────────
// Điện thoại chụp dọc lưu pixel nằm ngang + Exif Orientation 6/8…; bỏ hết Exif thì ảnh hiển thị lệch chiều. Ta KHÔNG giữ khối Exif gốc:
// đọc đúng một giá trị Orientation (1–8) rồi DỰNG khối TIFF mới chỉ có thẻ đó — GPS, model máy, thời điểm chụp, thumbnail, MakerNote
// và mọi thẻ khác không bao giờ được sao chép. Phân tích hỏng/lạ ở bất kỳ bước nào ⇒ null ⇒ không giữ gì (fail-closed).

const ORIENTATION_TAG = 0x0112;
const TYPE_SHORT = 3;
const IFD_ENTRY_BYTES = 12;

/** Giá trị Orientation (2–8) trong khối TIFF (header `II*\0`/`MM\0*` + IFD0); null nếu thiếu, bằng 1 (mặc định), hoặc khối hỏng. */
export function readTiffOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return null;
  const ifd = view.getUint32(4, little);
  // IFD0 nằm sau header 8 byte; số mục + mọi mục phải nằm trọn trong khối (so bằng số học không tràn: ifd ≤ 2^32 − 1).
  if (ifd < 8 || ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  if (ifd + 2 + count * IFD_ENTRY_BYTES > tiff.length) return null;
  for (let n = 0; n < count; n++) {
    const e = ifd + 2 + n * IFD_ENTRY_BYTES;
    if (view.getUint16(e, little) !== ORIENTATION_TAG) continue;
    // Chỉ chấp nhận đúng dạng chuẩn: SHORT, đếm 1 (giá trị nằm ngay trong 2 byte đầu của trường giá trị).
    if (view.getUint16(e + 2, little) !== TYPE_SHORT || view.getUint32(e + 4, little) !== 1) return null;
    const v = view.getUint16(e + 8, little);
    return v >= 2 && v <= 8 ? v : null;
  }
  return null;
}

/** Khối TIFF tối thiểu (big-endian): header + IFD0 một mục Orientation + không có IFD kế. 26 byte. */
function buildTiffOrientation(orientation: number): Uint8Array {
  const t = new Uint8Array(26);
  const v = new DataView(t.buffer);
  t.set([0x4d, 0x4d], 0); // "MM"
  v.setUint16(2, 42);
  v.setUint32(4, 8); // IFD0 ngay sau header
  v.setUint16(8, 1); // một mục
  v.setUint16(10, ORIENTATION_TAG);
  v.setUint16(12, TYPE_SHORT);
  v.setUint32(14, 1);
  v.setUint16(18, orientation);
  // 20–21 đệm của trường giá trị, 22–25 offset IFD kế = 0
  return t;
}

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  return b.length >= prefix.length && prefix.every((x, i) => b[i] === x);
}

/** Dữ liệu APP1 (sau 2 byte độ dài) → Orientation nếu là Exif hợp lệ. */
function orientationFromApp1(data: Uint8Array): number | null {
  return startsWith(data, EXIF_ID) ? readTiffOrientation(data.subarray(EXIF_ID.length)) : null;
}

/** Đoạn APP1 Exif chỉ chứa Orientation. */
function buildJpegExif(orientation: number): Uint8Array {
  const tiff = buildTiffOrientation(orientation);
  const len = 2 + EXIF_ID.length + tiff.length;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...EXIF_ID, ...tiff]);
}

/**
 * JPEG: bỏ APP1 (Exif/XMP, chứa GPS), APP13 (IPTC) và COM (chú thích tự do); giữ APP0/APP2 (ICC)/APP14 (Adobe) vì
 * ảnh hưởng hiển thị màu. Riêng thẻ Orientation của Exif đầu tiên được dựng lại thành APP1 tối thiểu (xem trên). Chỉ giữ ẢNH CHÍNH: mọi byte sau EOI (ảnh phụ MPF/gain-map của điện thoại — có thể mang
 * Exif/GPS riêng) bị cắt. Gom bằng subarray (không chép từng byte) để không chặn event loop với file 10 MB.
 */
function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let keptOrientation = false;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new CorruptFileError("JPEG hỏng");
    // Byte đệm 0xFF trước marker là hợp lệ (ITU T.81 B.1.1.2).
    while (i < b.length && b[i] === 0xff && b[i + 1] === 0xff) i++;
    if (i + 1 >= b.length) break;
    const marker = b[i + 1] as number;
    if (marker === 0xd9) {
      parts.push(b.subarray(i, i + 2));
      return concat(parts);
    }
    if (i + 4 > b.length) break;
    const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    if (len < 2 || i + 2 + len > b.length) throw new CorruptFileError("JPEG hỏng");
    if (marker === 0xda) {
      // Dữ liệu entropy sau SOS: tìm EOI thật (0xFF 0xD9; 0xFF00 và RSTn là dữ liệu). Có thể có nhiều scan (progressive).
      // `indexOf` chạy native: nhảy thẳng tới từng 0xFF thay vì duyệt từng byte trong JS (10 MB entropy ≈ vài ms, kể cả
      // khi mã bị đo coverage v8 — vòng từng byte bị chèn bộ đếm nhánh nên chậm gấp nhiều lần).
      let j = i + 2 + len;
      while (j + 1 < b.length) {
        const f = b.indexOf(0xff, j);
        if (f < 0 || f + 1 >= b.length) {
          j = b.length;
          break;
        }
        j = f;
        const m = b[j + 1] as number;
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
          j++;
          continue;
        }
        break;
      }
      if (j + 1 >= b.length) throw new CorruptFileError("JPEG thiếu EOI");
      parts.push(b.subarray(i, j));
      i = j;
      continue;
    }
    if (marker === 0xe1 && !keptOrientation) {
      const o = orientationFromApp1(b.subarray(i + 4, i + 2 + len));
      if (o !== null) {
        parts.push(buildJpegExif(o));
        keptOrientation = true;
      }
    }
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw new CorruptFileError("JPEG thiếu EOI");
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * PNG: bỏ chunk metadata (eXIf, tEXt, iTXt, zTXt, tIME); bắt buộc IHDR đầu tiên và kết thúc bằng IEND. eXIf đầu tiên được dựng lại
 * chỉ với Orientation (đúng vị trí cũ, trước IDAT).
 */
function stripPng(b: Uint8Array): Uint8Array {
  const drop = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let first = true;
  let keptOrientation = false;
  while (i + 12 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new CorruptFileError("PNG hỏng");
    if (first && type !== "IHDR") throw new CorruptFileError("PNG thiếu IHDR");
    first = false;
    if (type === "eXIf" && !keptOrientation) {
      const o = readTiffOrientation(b.subarray(i + 8, i + 8 + len));
      if (o !== null) {
        parts.push(pngChunk("eXIf", buildTiffOrientation(o)));
        keptOrientation = true;
      }
    }
    if (!drop.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(parts);
  }
  throw new CorruptFileError("PNG thiếu IEND");
}

/** Orientation của chunk EXIF đầu tiên trong WebP (có thể kèm tiền tố "Exif\0\0" ở file cũ); null nếu không có/hỏng. */
function webpOrientation(b: Uint8Array): number | null {
  let hasVp8x = false;
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(i, i + 4));
    const len = new DataView(b.buffer, b.byteOffset + i + 4, 4).getUint32(0, true);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) return null;
    if (fourcc === "VP8X" && len >= 1) hasVp8x = true;
    if (fourcc === "EXIF") {
      // Cờ EXIF nằm ở VP8X: không có VP8X đứng trước thì không có chỗ khai ⇒ không giữ gì.
      if (!hasVp8x) return null;
      const data = b.subarray(i + 8, i + 8 + len);
      return readTiffOrientation(startsWith(data, EXIF_ID) ? data.subarray(EXIF_ID.length) : data);
    }
    i = end;
  }
  return null;
}

/**
 * WebP (RIFF): bỏ chunk EXIF và XMP, xoá cờ tương ứng trong VP8X, sửa lại kích thước RIFF. Có Orientation hợp lệ ⇒ dựng lại một
 * chunk EXIF tối thiểu ở vị trí cũ và giữ cờ EXIF.
 */
function stripWebp(b: Uint8Array): Uint8Array {
  const orientation = webpOrientation(b);
  const chunks: Uint8Array[] = [];
  let wroteExif = false;
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(i, i + 4));
    const len = new DataView(b.buffer, b.byteOffset + i + 4, 4).getUint32(0, true);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) throw new CorruptFileError("WebP hỏng");
    if (fourcc === "VP8X" && len >= 1) {
      const c = Uint8Array.from(b.subarray(i, end));
      // Cờ EXIF (0x08) chỉ giữ khi sẽ ghi lại chunk Orientation; cờ XMP (0x04) luôn xoá.
      c[8] = ((c[8] as number) & ~(0x08 | 0x04)) | (orientation !== null ? 0x08 : 0);
      chunks.push(c);
    } else if (fourcc === "EXIF" && orientation !== null && !wroteExif) {
      const tiff = buildTiffOrientation(orientation);
      const c = new Uint8Array(8 + tiff.length);
      c.set(Buffer.from("EXIF", "latin1"), 0);
      new DataView(c.buffer).setUint32(4, tiff.length, true);
      c.set(tiff, 8);
      chunks.push(c);
      wroteExif = true;
    } else if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push(b.subarray(i, end));
    i = end;
  }
  if (chunks.length === 0) throw new CorruptFileError("WebP hỏng");
  const size = 4 + chunks.reduce((s, c) => s + c.length, 0);
  const head = Uint8Array.from(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, size, true);
  return concat([head, ...chunks]);
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
