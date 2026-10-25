// Chống PII trong thuộc tính sự kiện (PM-METRIC-005). Hai lớp độc lập với schema:
//  1. danh sách đen TÊN trường — tên trường nói lên dữ liệu người (email, phone, name, address, note, token…) bị từ chối dù giá trị là gì;
//  2. quét GIÁ TRỊ (chuỗi và số) bằng regex email / số điện thoại Việt Nam — khớp là từ chối.
// Thông báo lỗi KHÔNG chứa giá trị (không để PII đi vào log/stack trace); chỉ nêu tên trường.

/** Từ (tách theo snake_case/camelCase) khiến tên trường bị cấm. */
export const BLACKLISTED_FIELD_WORDS: ReadonlySet<string> = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "tel",
  "telephone",
  "zalo",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "surname",
  "address",
  "street",
  "note",
  "notes",
  "memo",
  "comment",
  "message",
  "description",
  "text",
  "token",
  "password",
  "passwd",
  "secret",
  "cookie",
  "session",
  "ip",
  "ua",
  "useragent",
  "cccd",
  "cmnd",
  "passport",
  "dob",
  "birth",
  "birthday",
  "nationality",
  "iban",
  "card",
  "account",
  "gender",
  "plate",
]);

function words(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Tên trường bị cấm? (từ nào của tên nằm trong danh sách đen, hoặc ghép liền các từ trùng một mục như `full_name` → `fullname`). */
export function isBlacklistedField(field: string): boolean {
  const w = words(field);
  if (w.some((x) => BLACKLISTED_FIELD_WORDS.has(x))) return true;
  return BLACKLISTED_FIELD_WORDS.has(w.join(""));
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** SĐT VN: di động 0[35789]xxxxxxxx, cố định 02xxxxxxxxx, hoặc +84/84 thay số 0. Quét sau khi bỏ khoảng trắng, dấu chấm, gạch, ngoặc. */
const VN_PHONE_RE = /(?:\+?84|0)(?:[35789]\d{8}|2\d{9})/;

/** Giá trị trông như PII (email hoặc SĐT VN)? Chỉ nhận chuỗi/số; kiểu khác không phải thuộc tính hợp lệ nên trả false (schema từ chối ở bước khác). */
export function looksLikePii(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const s = String(value);
  if (EMAIL_RE.test(s)) return true;
  // Số nguyên làm mất số 0 đầu (0912345678 → 912345678): vẫn là SĐT.
  if (typeof value === "number" && /^(?:[35789]\d{8}|2\d{9})$/.test(s)) return true;
  return VN_PHONE_RE.test(s.replace(/[\s.\-()]/g, ""));
}
