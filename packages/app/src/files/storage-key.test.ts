// BASE-SEC-007 — khoá object không thoát được bucket/thư mục: `../`, đoạn rỗng, `\`, NUL, quá dài đều bị chặn ở biên kho.
import { describe, expect, it } from "vitest";
import { stagedKey } from "./staging.ts";
import { assertSafeObjectKey, ObjectStorage, StorageError } from "./storage.ts";

const ORG = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

// Cổng đóng: nếu khoá xấu lọt qua kiểm tra thì lỗi sẽ là lỗi mạng, không phải "không hợp lệ".
const storage = new ObjectStorage({
  endpoint: "http://127.0.0.1:9",
  region: "test",
  bucket: "bucket-test",
  accessKeyId: "AKIATEST",
  secretAccessKey: "khoa-bi-mat-test",
  resilience: { maxRetries: 0, timeoutMs: 200 },
});

const BAD = [
  "",
  "../bucket-khac/x",
  "a/../../bucket-khac/x",
  "a/..",
  "..",
  ".",
  "a/./b",
  "/tuyet-doi/x",
  "a//b",
  "a/b/",
  "a\\..\\b",
  "a/b\u0000c",
  "a/b\nc",
  `a/${"x".repeat(1100)}`,
  "a/\u007fb",
];

describe("assertSafeObjectKey", () => {
  it.each(BAD)("chặn khoá %j", (key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(StorageError);
  });

  it.each([
    stagedKey(ORG, "tenant_doc", ID),
    "a/b.c/d-e_f",
    "tên-có-dấu/tệp 1.jpg",
    "a/..b/c..",
    "a/.hidden/x",
  ])("nhận khoá hợp lệ %j", (key) => {
    expect(() => assertSafeObjectKey(key)).not.toThrow();
  });

  it("ca biên độ dài: đúng 1000 byte được, 1001 byte bị chặn (đếm byte UTF-8, không đếm ký tự)", () => {
    expect(() => assertSafeObjectKey("x".repeat(1000))).not.toThrow();
    expect(() => assertSafeObjectKey("x".repeat(1001))).toThrow(StorageError);
    expect(() => assertSafeObjectKey("é".repeat(500))).not.toThrow();
    expect(() => assertSafeObjectKey("é".repeat(501))).toThrow(StorageError);
  });
});

describe("ObjectStorage chặn khoá thoát bucket trước khi gọi mạng", () => {
  it.each(["../bucket-khac/x", "a/../../b", "a//b"])("put/delete/signedGetUrl từ chối %j", async (key) => {
    const body = new Uint8Array([1]);
    await expect(storage.put(key, body, "image/jpeg")).rejects.toThrow(/không hợp lệ/);
    await expect(storage.delete(key)).rejects.toThrow(/không hợp lệ/);
    await expect(storage.signedGetUrl(key)).rejects.toThrow(/không hợp lệ/);
  });

  it("khoá hợp lệ ký URL nằm đúng dưới bucket", async () => {
    const url = new URL(await storage.signedGetUrl(stagedKey(ORG, "tenant_doc", ID)));
    expect(url.pathname).toBe(`/bucket-test/${ORG}/tenant_doc/${ID}`);
  });
});
