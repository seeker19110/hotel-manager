// Kiểm hợp lệ payload analytics (PLAN T-2309; PM-METRIC-005/006): tên trong danh sách, phiên bản có thật, đủ/đúng/không thừa khoá,
// khoá không thuộc danh sách đen PII (cả tiếng Việt/viết tắt), giá trị chuỗi/số không giống email/SĐT Việt Nam.
// Hàm thuần — không I/O, không log giá trị.
// Thông điệp lỗi viết bằng tiếng Anh và KHÔNG chứa giá trị payload (giá trị sai có thể chính là PII); chỉ nêu tên khoá/mã lỗi.
import type { EventRegistry, PropDef } from "./events.ts";

export type AnalyticsErrorCode =
  | "unknown_event"
  | "unknown_version"
  | "invalid_props"
  | "pii_key"
  | "pii_value"
  | "unknown_prop"
  | "missing_prop"
  | "invalid_type"
  | "invalid_context";

export class AnalyticsValidationError extends Error {
  readonly code: AnalyticsErrorCode;
  readonly field: string | undefined;
  constructor(code: AnalyticsErrorCode, message: string, field?: string) {
    super(message);
    this.name = "AnalyticsValidationError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Từ khoá (tách snake_case/camelCase, chữ thường) cấm làm khoá thuộc tính: định danh người, liên hệ, vị trí, bí mật, văn bản tự do.
 * Khớp THEO TỪ nên `property_id` không dính `ip`/`name`; từ ghép viết liền (`fullname`) kiểm ở `PII_KEY_FRAGMENTS`.
 */
export const PII_KEY_TOKENS: ReadonlySet<string> = new Set([
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
  "username",
  "address",
  "addr",
  "street",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "otp",
  "note",
  "notes",
  "comment",
  "comments",
  "remark",
  "memo",
  "reason",
  "description",
  "message",
  "msg",
  "body",
  "text",
  "ip",
  "ua",
  "agent",
  "cookie",
  "session",
  "cccd",
  "cmnd",
  "passport",
  "dob",
  "birth",
  "birthday",
  "nationality",
  "gender",
  "iban",
  "card",
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "location",
  "zip",
  "postcode",
  "postal",
  // Tiếng Việt không dấu + viết tắt (khoá kiểu `sdt`, `ten_khach`, `cmt`): SĐT, tên, giấy tờ, mã số thuế, số tài khoản.
  "sdt",
  "ten",
  "cmt",
  "hochieu",
  "dienthoai",
  "sodienthoai",
  "hoten",
  "diachi",
  "bienso",
  "mst",
  "masothue",
  "stk",
  "sotaikhoan",
]);
/**
 * Cụm từ tiếng Việt viết tách (`so_dien_thoai`, `soDienThoai`, `ho_ten`…): khớp khi các từ đứng LIỀN NHAU trong khoá — không ghép
 * chuỗi rồi tìm chuỗi con (tránh báo nhầm qua ranh giới từ, vd. `photo_tenant`).
 */
const PII_KEY_PHRASES: readonly (readonly string[])[] = [
  ["dien", "thoai"],
  ["ho", "ten"],
  ["dia", "chi"],
  ["ho", "chieu"],
  ["bien", "so"],
  ["ma", "so", "thue"],
  ["so", "tai", "khoan"],
];
const PII_KEY_FRAGMENTS = [
  "fullname",
  "firstname",
  "lastname",
  "phonenumber",
  "emailaddress",
  "useragent",
  "ipaddress",
  "idnumber",
  "docnumber",
  "accountnumber",
  "bankaccount",
  "accesstoken",
  "refreshtoken",
] as const;

const keyTokens = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const hasPhrase = (tokens: readonly string[], phrase: readonly string[]): boolean =>
  tokens.some((_, i) => phrase.every((w, j) => tokens[i + j] === w));

/** Khoá thuộc danh sách đen PII? (theo từ, cụm từ tiếng Việt liền nhau, hoặc từ ghép tiếng Anh viết liền). */
export function isPiiKey(key: string): boolean {
  const tokens = keyTokens(key);
  if (tokens.some((t) => PII_KEY_TOKENS.has(t))) return true;
  if (PII_KEY_PHRASES.some((ph) => hasPhrase(tokens, ph))) return true;
  const joined = tokens.join("");
  return PII_KEY_FRAGMENTS.some((f) => joined.includes(f));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Email: `phần@miền.đuôi` ở bất kỳ vị trí nào trong chuỗi. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/**
 * SĐT Việt Nam: `0` hoặc `+84`/`84` rồi di động (đầu số 3/5/7/8/9 + 8 chữ số) hoặc bàn (mã vùng 2xx + 8 chữ số, tổng 11 chữ số với số 0),
 * cho phép ngăn cách khoảng trắng/chấm/gạch/ngoặc.
 */
const PHONE_RE = /(?<![\w])(?:\+?84|0)[\s.()-]*(?:[35789](?:[\s.()-]*\d){8}|2(?:[\s.()-]*\d){9})(?!\d)/;

/** Chuỗi giống email/SĐT VN? (chuỗi đúng dạng uuid không bao giờ bị coi là PII — uuid có thể chứa dãy số trông như SĐT). */
export function looksLikePii(value: string): boolean {
  if (UUID_RE.test(value)) return false;
  return EMAIL_RE.test(value) || PHONE_RE.test(value);
}

/**
 * Số giống SĐT VN (số học mất số 0 đầu): 9 chữ số di động `[35789]xxxxxxxx`, 10 chữ số bàn `2xxxxxxxxx`, kèm/không kèm `84`;
 * hoặc dạng chuỗi của số khớp `looksLikePii`. Số thuộc tính hợp lệ luôn < 10^8 (`assertRegistrySafe`) nên không báo nhầm.
 */
const NUMERIC_PHONE_RE = /^(?:84)?(?:[35789]\d{8}|2\d{9})$/;
export function looksLikePiiNumber(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const s = String(Math.abs(value));
  return looksLikePii(s) || NUMERIC_PHONE_RE.test(s);
}
/** Cận trên (loại trừ) cho thuộc tính số nguyên của registry: 10^8 đủ chứa SĐT 9 chữ số (không số 0 đầu). */
export const INT_PROP_MAX_EXCLUSIVE = 100_000_000;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function typeOk(def: PropDef, v: unknown): boolean {
  const t = def.type;
  if (t.kind === "uuid") return isUuid(v);
  if (t.kind === "enum") return typeof v === "string" && t.values.includes(v);
  return typeof v === "number" && Number.isSafeInteger(v) && v >= t.min && v <= t.max;
}

export interface ValidatedEvent {
  name: string;
  version: number;
  props: Record<string, string | number>;
}

/**
 * Kiểm một sự kiện theo `registry`. `version` mặc định = `current` của sự kiện; phiên bản cũ vẫn kiểm theo hình dạng của chính nó.
 * Thứ tự: tên → phiên bản → dạng object → khoá (PII trước, rồi khoá lạ) → giá trị PII → khoá thiếu → kiểu/cận.
 * Giá trị `undefined` coi như vắng mặt (JSON bỏ qua); `null` là sai kiểu.
 */
export function validateEvent(
  registry: EventRegistry,
  name: string,
  props: unknown,
  version?: number,
): ValidatedEvent {
  const def = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!def)
    throw new AnalyticsValidationError("unknown_event", "event name is not in the analytics allowlist");
  const v = version ?? def.current;
  const schema = Object.hasOwn(def.versions, v) ? def.versions[v] : undefined;
  if (!schema)
    throw new AnalyticsValidationError("unknown_version", `event ${name} has no schema version ${v}`);
  if (!isPlainObject(props))
    throw new AnalyticsValidationError("invalid_props", `props of ${name} must be a plain object`);
  const keys = Object.keys(props).filter((k) => props[k] !== undefined);
  for (const k of keys)
    if (isPiiKey(k))
      throw new AnalyticsValidationError("pii_key", `prop key "${k}" is on the PII denylist`, k);
  for (const k of keys)
    if (!Object.hasOwn(schema.props, k))
      throw new AnalyticsValidationError("unknown_prop", `prop "${k}" is not in the schema of ${name}`, k);
  for (const k of keys) {
    const val = props[k];
    if (
      (typeof val === "string" && looksLikePii(val)) ||
      (typeof val === "number" && looksLikePiiNumber(val))
    )
      throw new AnalyticsValidationError("pii_value", `prop "${k}" value looks like an email or phone`, k);
  }
  const out: Record<string, string | number> = {};
  for (const [k, def2] of Object.entries(schema.props)) {
    const val = props[k];
    if (val === undefined) {
      if (def2.required) throw new AnalyticsValidationError("missing_prop", `prop "${k}" is required`, k);
      continue;
    }
    if (!typeOk(def2, val))
      throw new AnalyticsValidationError("invalid_type", `prop "${k}" has the wrong type or range`, k);
    out[k] = val as string | number;
  }
  return { name, version: v, props: out };
}

/**
 * Rà chính registry (lỗi lập trình ⇒ ném): tên đúng dạng `doi_tuong.hanh_dong`, `current` có thật, khoá thuộc tính snake_case không
 * thuộc danh sách đen PII, giá trị enum không giống PII, cận số nguyên hợp lệ. Gọi lúc nạp module `EVENTS` và trong test.
 */
export function assertRegistrySafe(registry: EventRegistry): void {
  const bad = (msg: string): never => {
    throw new Error(`analytics registry: ${msg}`);
  };
  for (const [name, def] of Object.entries(registry)) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) bad(`event name "${name}" must be object.action`);
    if (!Object.hasOwn(def.versions, def.current))
      bad(`${name}: current version ${def.current} is not defined`);
    for (const [ver, schema] of Object.entries(def.versions)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(schema.addedOn)) bad(`${name} v${ver}: addedOn must be YYYY-MM-DD`);
      for (const [key, p] of Object.entries(schema.props)) {
        if (!/^[a-z][a-z0-9_]*$/.test(key)) bad(`${name}.${key}: key must be snake_case`);
        if (isPiiKey(key)) bad(`${name}.${key}: key is on the PII denylist`);
        if (p.type.kind === "enum") {
          for (const value of p.type.values)
            if (looksLikePii(value) || !/^[a-z0-9_]+$/.test(value))
              bad(`${name}.${key}: enum value "${value}"`);
        }
        if (p.type.kind === "int" && !(Number.isSafeInteger(p.type.min) && p.type.min <= p.type.max))
          bad(`${name}.${key}: invalid integer range`);
        // Cận đủ rộng để chứa SĐT (9 chữ số) ⇒ một số "đếm" có thể bị dùng chở PII: từ chối ngay ở registry.
        if (
          p.type.kind === "int" &&
          (p.type.max >= INT_PROP_MAX_EXCLUSIVE || p.type.min <= -INT_PROP_MAX_EXCLUSIVE)
        )
          bad(`${name}.${key}: integer range must stay below 10^8 (could carry a phone number)`);
      }
    }
  }
}
