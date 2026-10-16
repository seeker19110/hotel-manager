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
