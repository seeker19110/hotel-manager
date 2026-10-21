// T-202 (D-004): mã hoá số giấy tờ tầng app — AES-256-GCM có key_id, AAD ràng hàng, blind index, xoay khoá.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPiiCipher,
  devKeyring,
  last4,
  maskDocNumber,
  normalizeDocNumber,
  PiiKeyError,
  parseKeyring,
} from "./pii.ts";

const k = () => randomBytes(32).toString("base64");

describe("parseKeyring", () => {
  it("đọc nhiều khoá, chọn khoá ghi theo id", () => {
    const ring = parseKeyring(`1:${k()}, 2:${k()}`, 2, k());
    expect(ring.currentKeyId).toBe(2);
    expect([...ring.keys.keys()]).toEqual([1, 2]);
  });

  it.each([
    ["sai định dạng", "abc", 1],
    ["khoá ngắn", `1:${randomBytes(16).toString("base64")}`, 1],
    ["id ngoài 1…255", `0:${k()}`, 0],
    ["trùng id", `1:${k()},1:${k()}`, 1],
    ["khoá ghi không có", `1:${k()}`, 2],
  ])("%s → PiiKeyError, thông điệp không chứa khoá", (_n, keys, id) => {
    let err: unknown;
    try {
      parseKeyring(keys as string, id as number, k());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PiiKeyError);
    for (const part of (keys as string).split(",")) {
      const secret = part.split(":")[1];
      if (secret) expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("createPiiCipher", () => {
  const ring = parseKeyring(`1:${k()}`, 1, k());
  const pii = createPiiCipher(ring);

  it("mã hoá ngẫu nhiên (IV mới mỗi lần), giải mã đúng, ciphertext không chứa số rõ", () => {
    const a = pii.encrypt("001234567890", "row-1");
    const b = pii.encrypt("001234567890", "row-1");
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a.toString("latin1")).not.toContain("001234567890");
    expect(pii.decrypt(a, "row-1")).toBe("001234567890");
  });

  it("tráo sang hàng khác (AAD khác) hoặc sửa 1 byte → không giải mã được", () => {
    const c = pii.encrypt("B1234567", "row-1");
    expect(() => pii.decrypt(c, "row-2")).toThrow(PiiKeyError);
    const bad = Buffer.from(c);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => pii.decrypt(bad, "row-1")).toThrow(PiiKeyError);
    expect(() => pii.decrypt(Buffer.alloc(5), "row-1")).toThrow(PiiKeyError);
  });

  it("AUD-SEC-002: cipher/decipher GCM ghim authTagLength 16 (không nhận tag ngắn nếu sau này đổi cách cắt buffer)", () => {
    const src = readFileSync(new URL("./pii.ts", import.meta.url), "utf8");
    const calls = src.match(/create(?:Dec|C)ipheriv\("aes-256-gcm"[^;]*;/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatch(/authTagLength: TAG_BYTES/);
  });

  it("sai khoá (keyring khác) → không giải mã được", () => {
    const other = createPiiCipher(parseKeyring(`1:${k()}`, 1, k()));
    expect(() => other.decrypt(pii.encrypt("001234567890", "r"), "r")).toThrow(PiiKeyError);
  });

  it("xoay khoá: keyring mới vẫn đọc bản cũ theo key_id, ghi bằng khoá mới", () => {
    const k1 = k();
    const old = createPiiCipher(parseKeyring(`1:${k1}`, 1, k()));
    const c1 = old.encrypt("001234567890", "r");
    const rotated = createPiiCipher(parseKeyring(`1:${k1},2:${k()}`, 2, k()));
    expect(rotated.decrypt(c1, "r")).toBe("001234567890");
    const c2 = rotated.encrypt("001234567890", "r");
    expect(rotated.keyIdOf(c2)).toBe(2);
    expect(() => old.decrypt(c2, "r")).toThrow(/key_id=2/);
  });

  it("blind index tất định theo (tổ chức, loại, số); khác tổ chức/loại → khác", () => {
    const a = pii.blindIndex("org-a", "cccd", "001234567890");
    expect(a.equals(pii.blindIndex("org-a", "cccd", "001234567890"))).toBe(true);
    expect(a.equals(pii.blindIndex("org-b", "cccd", "001234567890"))).toBe(false);
    expect(a.equals(pii.blindIndex("org-a", "passport", "001234567890"))).toBe(false);
    expect(a.length).toBe(32);
  });

  it("devKeyring tất định (dev/test), khác mọi khoá ngẫu nhiên", () => {
    const d1 = createPiiCipher(devKeyring());
    const d2 = createPiiCipher(devKeyring());
    expect(d2.decrypt(d1.encrypt("X12345", "r"), "r")).toBe("X12345");
  });
});

describe("chuẩn hoá và che", () => {
  it.each([
    ["001 234 567 890", "001234567890"],
    ["b1234567", "B1234567"],
    ["C-123.456/7", "C1234567"],
    ["１２３４５６", "123456"],
  ])("%s → %s", (raw, out) => expect(normalizeDocNumber(raw)).toBe(out));

  it.each(["", "123", "x".repeat(31), "12345<script>", "12345\u0000"])("không hợp lệ: %j", (raw) =>
    expect(normalizeDocNumber(raw)).toBeNull(),
  );

  it("chỉ hiển thị 4 ký tự cuối", () => {
    expect(maskDocNumber(last4("001234567890"))).toBe("****7890");
    expect(maskDocNumber(null)).toBeNull();
  });
});
