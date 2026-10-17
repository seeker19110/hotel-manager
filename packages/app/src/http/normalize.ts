// Chuẩn hoá chuỗi đầu vào ở biên (BASE-DATA-002, UX-CONTENT-002, XC-I18N-005): Unicode NFC cho MỌI chuỗi (giá trị và khoá)
// trong thân JSON / query string TRƯỚC khi vào schema Zod. Một chỗ duy nhất (command-route) nên không schema nào quên;
// "Việt" gõ kiểu tổ hợp (NFD: e + dấu) và dựng sẵn (NFC) thành cùng một chuỗi lưu, so khớp/UNIQUE/tìm kiếm không lệch.
// Chỉ NFC (không NFKC): NFKC đổi nghĩa ký tự (vd. ký hiệu, số trên) — riêng số giấy tờ đã có NFKC ở crypto/pii.ts.

const MAX_DEPTH = 64;

/** Đệ quy chuẩn hoá NFC; kiểu khác chuỗi giữ nguyên. Quá sâu (> 64 tầng) trả nguyên — schema strict sẽ từ chối sau. */
export function nfcDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return value.normalize("NFC") as T;
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => nfcDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k.normalize("NFC")] = nfcDeep(v, depth + 1);
  return out as T;
}

const MAX_UPLOAD_NAME = 200;

/**
 * Tên file người dùng tải lên (BASE-DATA-002): NFC, bỏ phần thư mục (cả dấu gạch chéo xuôi và ngược), bỏ ký tự điều khiển/định dạng ẩn (gồm
 * ký tự đảo chiều chữ U+202E dùng giả đuôi file), cắt ≤ 200 điểm mã. Tên rỗng sau khi làm sạch → "tep". Chỉ để HIỂN THỊ/ghi vết;
 * đường dẫn object trong kho luôn do hệ thống sinh, không bao giờ lấy từ tên này.
 */
export function normalizeUploadName(raw: string): string {
  const base = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
  const cut = Array.from(cleaned).slice(0, MAX_UPLOAD_NAME).join("").normalize("NFC");
  return cut === "" ? "tep" : cut;
}
