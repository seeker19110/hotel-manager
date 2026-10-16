// Token huỷ đăng ký ký số (HMAC-SHA256) cho liên kết trong email (S-010; THREAT-MODEL TM-14).
// Token = base64url(JSON {v,o,p,t,exp}) + "." + base64url(HMAC). Chỉ chứa id + loại + hạn — không email/tên. Chỉ đổi đúng một
// loại của đúng một người. Sai chữ ký/định dạng → "invalid" (NOT_FOUND, không phân biệt lý do); quá hạn → "expired" (410).
import { createHmac, timingSafeEqual } from "node:crypto";

export const UNSUBSCRIBE_TTL_DAYS = 30;
const MIN_SECRET_BYTES = 32;

export interface UnsubscribeClaims {
  orgId: string;
  personId: string;
  type: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update("unsubscribe.v1\n").update(body).digest();
}

function checkSecret(secret: string): void {
  if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error("Khoá ký token huỷ đăng ký phải ≥ 32 byte");
  }
}

export function signUnsubscribeToken(
  secret: string,
  claims: UnsubscribeClaims,
  now: Date,
  ttlDays = UNSUBSCRIBE_TTL_DAYS,
): string {
  checkSecret(secret);
  const exp = Math.floor(now.getTime() / 1000) + Math.floor(ttlDays * 86_400);
  const body = Buffer.from(
    JSON.stringify({ v: 1, o: claims.orgId, p: claims.personId, t: claims.type, exp }),
  ).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export type VerifyResult =
  | { status: "ok"; claims: UnsubscribeClaims }
  | { status: "expired" }
  | { status: "invalid" };

export function verifyUnsubscribeToken(secret: string, token: string, now: Date): VerifyResult {
  checkSecret(secret);
  if (typeof token !== "string" || token.length > 600) return { status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2) return { status: "invalid" };
  const [body, sig] = parts as [string, string];
  const want = mac(secret, body);
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return { status: "invalid" };
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: "invalid" };
  try {
    const o = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      o.v !== 1 ||
      typeof o.o !== "string" ||
      !UUID.test(o.o) ||
      typeof o.p !== "string" ||
      !UUID.test(o.p) ||
      typeof o.t !== "string" ||
      typeof o.exp !== "number"
    ) {
      return { status: "invalid" };
    }
    if (o.exp * 1000 <= now.getTime()) return { status: "expired" };
    return { status: "ok", claims: { orgId: o.o, personId: o.p, type: o.t } };
  } catch {
    return { status: "invalid" };
  }
}
