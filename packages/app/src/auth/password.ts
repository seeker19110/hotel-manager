// Băm mật khẩu Argon2id (BE-AUTH-001; D-031/ADR-0002) gắn vào Better Auth (`emailAndPassword.password.{hash,verify}`).
// Dùng `crypto.argon2` dựng sẵn của Node ≥ 24.7 (không thêm phụ thuộc/binary native). Node chỉ trả Buffer thô nên
// module này tự lo mã hoá PHC chuẩn và so sánh hằng thời gian. Tham số theo OWASP Password Storage Cheat Sheet
// (Argon2id m=19 MiB, t=2, p=1; xác minh 2026-10-16).
//
// Băm cũ của Better Auth (scrypt, dạng `saltHex:keyHex`) vẫn xác minh được qua `better-auth/crypto` (export công khai
// của chính thư viện, đúng hàm đã tạo ra băm đó) — việc băm lại sang Argon2id làm ở `auth.ts` sau khi xác minh đúng.
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { verifyPassword as verifyLegacyScrypt } from "better-auth/crypto";

const argon2Async = promisify(argon2);

export interface Argon2Params {
  /** Bộ nhớ, KiB. */
  m: number;
  /** Số vòng (passes). */
  t: number;
  /** Độ song song. */
  p: number;
}

/** Tham số hiện hành (OWASP). Đổi ở đây ⇒ băm cũ tự được băm lại ở lần đăng nhập kế (`needsRehash`). */
export const ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({ m: 19456, t: 2, p: 1 });
const SALT_BYTES = 16;
const TAG_BYTES = 32;

// Trần chống DoS: băm lưu trong CSDL là dữ liệu không tin cậy (nhập tay/khôi phục sao lưu hỏng) — không cho
// một dòng `m=4194304` làm cạn bộ nhớ máy chủ.
const MAX_M = 65536;
const MAX_T = 10;
const MAX_P = 4;
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const MIN_TAG_BYTES = 16;
const MAX_TAG_BYTES = 64;

const PHC_RE = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
// Dạng băm mặc định của Better Auth 1.7.9: salt 16 byte hex + ":" + khoá scrypt 64 byte hex.
const LEGACY_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

// NFKC giống hàm mặc định của Better Auth để cùng một mật khẩu gõ ở bàn phím khác nhau vẫn khớp.
const normalize = (password: string): string => password.normalize("NFKC");
const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");

async function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> {
  return (await argon2Async("argon2id", {
    message: normalize(password),
    nonce: salt,
    parallelism: params.p,
    tagLength,
    memory: params.m,
    passes: params.t,
  })) as Buffer;
}

/** Mã hoá PHC từ salt cho trước — tách ra để khoá vector kiểm thử; sản phẩm dùng `hashPassword` (salt ngẫu nhiên). */
export async function argon2idPhc(
  password: string,
  salt: Buffer,
  params: Argon2Params = ARGON2_PARAMS,
): Promise<string> {
  const key = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${b64(salt)}$${b64(key)}`;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2idPhc(password, randomBytes(SALT_BYTES));
}

interface ParsedPhc {
  params: Argon2Params;
  salt: Buffer;
  key: Buffer;
}

function parsePhc(hash: string): ParsedPhc | null {
  const m = PHC_RE.exec(hash);
  if (!m) return null;
  const params = { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) };
  // Argon2: m ≥ 8·p; ngoài khoảng hợp lý ⇒ từ chối TRƯỚC khi tốn tài nguyên.
  if (params.p < 1 || params.p > MAX_P || params.t < 1 || params.t > MAX_T) return null;
  if (params.m < 8 * params.p || params.m > MAX_M) return null;
  const salt = Buffer.from(m[4] ?? "", "base64");
  const key = Buffer.from(m[5] ?? "", "base64");
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) return null;
  if (key.length < MIN_TAG_BYTES || key.length > MAX_TAG_BYTES) return null;
  return { params, salt, key };
}

/** Xác minh mật khẩu với băm đã lưu (Argon2id PHC hoặc scrypt cũ của Better Auth). Không bao giờ ném: băm lạ ⇒ false. */
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    if (typeof hash !== "string" || typeof password !== "string") return false;
    if (hash.startsWith("$argon2id$")) {
      const parsed = parsePhc(hash);
      if (!parsed) return false;
      const actual = await derive(password, parsed.salt, parsed.params, parsed.key.length);
      return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
    }
    if (LEGACY_RE.test(hash)) return await verifyLegacyScrypt({ hash, password });
    return false;
  } catch {
    return false;
  }
}

/** Băm đã lưu cần được băm lại: không phải Argon2id đúng tham số hiện hành (scrypt cũ, hoặc tham số lỗi thời). */
export function needsRehash(hash: string): boolean {
  const parsed = parsePhc(hash);
  if (!parsed) return true;
  const { m, t, p } = parsed.params;
  return (
    m !== ARGON2_PARAMS.m ||
    t !== ARGON2_PARAMS.t ||
    p !== ARGON2_PARAMS.p ||
    parsed.salt.length !== SALT_BYTES ||
    parsed.key.length !== TAG_BYTES
  );
}
