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

function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * JPEG: bỏ APP1 (Exif/XMP, chứa GPS), APP13 (IPTC) và COM (chú thích tự do); giữ APP0/APP2 (ICC)/APP14 (Adobe) vì
 * ảnh hưởng hiển thị màu. Chỉ giữ ẢNH CHÍNH: mọi byte sau EOI (ảnh phụ MPF/gain-map của điện thoại — có thể mang
 * Exif/GPS riêng) bị cắt. Gom bằng subarray (không chép từng byte) để không chặn event loop với file 10 MB.
 */
function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
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
      let j = i + 2 + len;
      for (; j + 1 < b.length; j++) {
        if (b[j] !== 0xff) continue;
        const m = b[j + 1] as number;
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) continue;
        break;
      }
      if (j + 1 >= b.length) throw new CorruptFileError("JPEG thiếu EOI");
      parts.push(b.subarray(i, j));
      i = j;
      continue;
    }
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw new CorruptFileError("JPEG thiếu EOI");
}

/** PNG: bỏ chunk metadata (eXIf, tEXt, iTXt, zTXt, tIME); bắt buộc IHDR đầu tiên và kết thúc bằng IEND. */
function stripPng(b: Uint8Array): Uint8Array {
  const drop = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new CorruptFileError("PNG hỏng");
    if (first && type !== "IHDR") throw new CorruptFileError("PNG thiếu IHDR");
    first = false;
    if (!drop.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(parts);
  }
  throw new CorruptFileError("PNG thiếu IEND");
}

/** WebP (RIFF): bỏ chunk EXIF và XMP, xoá cờ tương ứng trong VP8X, sửa lại kích thước RIFF. */
function stripWebp(b: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(i, i + 4));
    const len = new DataView(b.buffer, b.byteOffset + i + 4, 4).getUint32(0, true);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) throw new CorruptFileError("WebP hỏng");
    if (fourcc === "VP8X" && len >= 1) {
      const c = Uint8Array.from(b.subarray(i, end));
      c[8] = (c[8] as number) & ~(0x08 | 0x04); // bit EXIF (0x08) và XMP (0x04)
      chunks.push(c);
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
  /**
   * `{clean:true}` = quét xong, sạch · `{clean:false}` = quét xong, nhiễm. KHÔNG quét được (không kết nối, quá hạn, máy quét báo
   * lỗi/quá giới hạn) → ném `ScanUnavailableError`: người gọi không bao giờ coi file là `ready` (D-003).
   */
  scan(bytes: Uint8Array): Promise<{ clean: true } | { clean: false; reason: string }>;
}

/** Máy quét không cho kết quả đáng tin (fail-closed): file không được sang `ready`. */
export class ScanUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanUnavailableError";
  }
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Adapter tối thiểu cho dev/CI: chỉ nhận chuỗi kiểm thử EICAR. Production phải thay bằng máy quét thật. */
export const eicarOnlyScanner: MalwareScanner = {
  async scan(bytes) {
    const text = Buffer.from(bytes).toString("latin1");
    return text.includes(EICAR) ? { clean: false, reason: "EICAR-Test-Signature" } : { clean: true };
  },
};
