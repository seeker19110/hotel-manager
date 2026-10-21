// Mã hoá dữ liệu cá nhân nhạy cảm tầng app (D-004, ERD `identity_documents`): AES-256-GCM, khoá có `key_id` để xoay;
// blind index HMAC-SHA256 để tra trùng mà không giải mã. CSDL, bản sao lưu và log chỉ thấy ciphertext/băm.
// Định dạng ciphertext: key_id (1 byte) ‖ iv (12) ‖ tag (16) ‖ dữ liệu. AAD ràng ciphertext vào đúng hàng (không tráo hàng).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class PiiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiKeyError";
  }
}

export interface PiiKeyring {
  /** Khoá ghi hiện hành. */
  currentKeyId: number;
  /** Mọi khoá còn đọc được (gồm khoá hiện hành) — xoay khoá: thêm khoá mới, đổi `currentKeyId`, mã hoá lại dần. */
  keys: ReadonlyMap<number, Buffer>;
  /** Khoá blind index — KHÔNG xoay cùng khoá mã hoá (đổi = tính lại toàn bộ index). */
  indexKey: Buffer;
}

function decodeKey(b64: string, name: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== KEY_BYTES) throw new PiiKeyError(`${name}: khoá phải là ${KEY_BYTES} byte base64`);
  return k;
}

/**
 * Dựng keyring từ env: `HM_PII_KEYS` = "1:<base64>,2:<base64>", `HM_PII_KEY_ID` = id ghi, `HM_PII_INDEX_KEY` = base64.
 * Lỗi chỉ nêu tên biến, không bao giờ in khoá.
 */
export function parseKeyring(keys: string, currentKeyId: number, indexKey: string): PiiKeyring {
  const map = new Map<number, Buffer>();
  for (const part of keys.split(",")) {
    const m = /^\s*(\d{1,3}):([A-Za-z0-9+/=]+)\s*$/.exec(part);
    if (!m) throw new PiiKeyError("HM_PII_KEYS: sai định dạng (id:base64,…)");
    const id = Number(m[1]);
    if (id < 1 || id > 255) throw new PiiKeyError("HM_PII_KEYS: key_id phải trong 1…255");
    if (map.has(id)) throw new PiiKeyError("HM_PII_KEYS: trùng key_id");
    map.set(id, decodeKey(m[2] as string, "HM_PII_KEYS"));
  }
  if (!map.has(currentKeyId)) throw new PiiKeyError("HM_PII_KEY_ID: không có trong HM_PII_KEYS");
  return { currentKeyId, keys: map, indexKey: decodeKey(indexKey, "HM_PII_INDEX_KEY") };
}

/**
 * Keyring CHỈ cho dev/test: dẫn xuất tất định từ nhãn công khai (không phải bí mật, không dùng production —
 * schema env bắt buộc khoá thật khi NODE_ENV=production).
 */
export function devKeyring(): PiiKeyring {
  const derive = (label: string) => createHash("sha256").update(`hotel-manager:dev-only:${label}`).digest();
  return { currentKeyId: 1, keys: new Map([[1, derive("pii-key-1")]]), indexKey: derive("pii-index") };
}

export interface PiiCipher {
  encrypt(plaintext: string, aad: string): Buffer;
  decrypt(ciphertext: Uint8Array, aad: string): string;
  /** Băm định danh cho tra cứu: theo tổ chức (không đối chiếu chéo tổ chức) + loại + giá trị chuẩn hoá. */
  blindIndex(orgId: string, kind: string, value: string): Buffer;
  keyIdOf(ciphertext: Uint8Array): number;
}

export function createPiiCipher(ring: PiiKeyring): PiiCipher {
  return {
    encrypt(plaintext, aad) {
      const key = ring.keys.get(ring.currentKeyId) as Buffer;
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      c.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return Buffer.concat([Buffer.from([ring.currentKeyId]), iv, c.getAuthTag(), body]);
    },
    decrypt(ciphertext, aad) {
      const buf = Buffer.from(ciphertext);
      if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new PiiKeyError("ciphertext hỏng");
      const key = ring.keys.get(buf[0] as number);
      if (!key) throw new PiiKeyError(`không có khoá key_id=${buf[0]}`);
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 1 + IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      d.setAAD(Buffer.from(aad, "utf8"));
      d.setAuthTag(buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
      try {
        return Buffer.concat([d.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
      } catch {
        // Sai khoá, sai AAD (tráo hàng) hoặc dữ liệu bị sửa — không phân biệt để không lộ thông tin.
        throw new PiiKeyError("không giải mã được");
      }
    },
    blindIndex(orgId, kind, value) {
      return createHmac("sha256", ring.indexKey).update(`${orgId}\n${kind}\n${value}`, "utf8").digest();
    },
    keyIdOf(ciphertext) {
      return ciphertext[0] as number;
    },
  };
}

/** Chuẩn hoá số giấy tờ: bỏ khoảng trắng/gạch/chấm, chữ hoa. Không hợp lệ → null. */
export function normalizeDocNumber(raw: string): string | null {
  const n = raw
    .normalize("NFKC")
    .replace(/[\s.\-/]/g, "")
    .toUpperCase();
  return /^[0-9A-Z]{5,30}$/.test(n) ? n : null;
}

/** Chỉ phần được phép hiển thị/ghi audit (4 ký tự cuối). */
export function last4(normalized: string): string {
  return normalized.slice(-4);
}

export function maskDocNumber(lastFour: string | null): string | null {
  return lastFour === null ? null : `****${lastFour}`;
}

export function sameIndex(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
