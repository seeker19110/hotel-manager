// TOTP RFC 6238 (SHA-1, 30 giây, 6 số) cho E2E — chỉ node:crypto, không thêm thư viện. Khoá = base32 giải mã từ otpauth URI.
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("base32 sai");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const o = (h[h.length - 1] as number) & 0x0f;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Nơi seed ghi bí mật TOTP của chủ trọ giả cho tiến trình test đọc (thư mục tạm, không vào repo). */
export function totpFile(port: number): string {
  return join(tmpdir(), `hm-e2e-${port}-totp.json`);
}
