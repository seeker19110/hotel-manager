// BASE-ERR-007 (che khoá chung) + BASE-ERR-002 (onUnexpectedError ghi đủ) — T-403.
import { describe, expect, it } from "vitest";
import { createLogger, isSensitiveKey, maskString } from "./logger.ts";
import { reportUnexpectedError } from "./unexpected.ts";

function capture() {
  const lines: string[] = [];
  const log = createLogger({
    sink: { write: (l) => lines.push(l) },
    level: "debug",
    service: "t",
    env: "test",
  });
  return { log, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("BASE-ERR-007 — khoá chung `key` bị che ở mọi độ sâu", () => {
  it.each([
    "key",
    "Key",
    "keys",
    "api_key",
    "apiKey",
    "access_key_id",
    "accessKeyId",
    "S3_ACCESS_KEY_ID",
    "privateKey",
    "private-key",
    "signing.key",
    "HM_PII_INDEX_KEY",
    "encryptionKey",
    "idempotency_key",
  ])("khoá %s → ***", (k) => {
    expect(isSensitiveKey(k)).toBe(true);
  });

  it.each([
    "keyword",
    "keywords",
    "monkey",
    "turkey",
    "keyboard",
    "hockey",
    "room_code",
    "monkeyBusiness",
    "okay",
  ])("tên thường %s không bị che nhầm", (k) => {
    expect(isSensitiveKey(k)).toBe(false);
  });

  it("log object có password/token/key lồng nhau → [REDACTED]/*** , giá trị không lọt ra", () => {
    const { log, records } = capture();
    log.info("cấu hình", {
      password: "mk-bi-mat-1",
      nested: {
        accessKeyId: "AKIAXXXXXXXXXXXXXXXX",
        privateKey: "-----BEGIN PRIVATE KEY-----abc",
        keyword: "tim-kiem",
      },
      list: [{ api_key: "k-123456789" }],
      Authorization: "Bearer tttttttttt",
    });
    const raw = JSON.stringify(records());
    for (const leak of ["mk-bi-mat-1", "AKIAXXXXXXXXXXXXXXXX", "BEGIN PRIVATE", "k-123456789", "tttttttttt"])
      expect(raw).not.toContain(leak);
    expect(raw).toContain("tim-kiem"); // khoá `keyword` giữ nguyên
    expect(raw).toContain("***");
  });

  it("chuỗi kết nối và token trong GIÁ TRỊ cũng bị che (thông điệp lỗi, URL)", () => {
    expect(maskString("kết nối postgres://app:mat-khau-db@db:5432/hm lỗi")).not.toContain("mat-khau-db");
    expect(maskString("amqp://u:p4ss@mq")).toBe("amqp://u:***@mq");
    expect(maskString("Authorization: Bearer abcdef0123456789")).not.toContain("abcdef0123456789");
    expect(maskString("thử secret=hunter2&x=1")).not.toContain("hunter2");
  });
});

describe("BASE-ERR-002 — reportUnexpectedError ghi đủ để chẩn đoán", () => {
  it("log ERROR có correlation_id, loại, thông điệp, stack, cause; bí mật trong thông điệp bị che", () => {
    const { log, records } = capture();
    const err = new RangeError("quá hạn mức tại postgres://u:pw-rat-bi-mat@db/x", {
      cause: new Error("nguyên nhân gốc"),
    });
    reportUnexpectedError(log, err, "corr-abc-12345");
    const [r] = records();
    expect(r).toMatchObject({
      level: "error",
      severity_number: 17,
      correlation_id: "corr-abc-12345",
      "exception.type": "RangeError",
    });
    expect(String(r?.["exception.message"])).toContain("quá hạn mức");
    expect(String(r?.["exception.stacktrace"])).toContain("RangeError");
    expect(r?.["exception.cause"]).toMatchObject({ "exception.message": "nguyên nhân gốc" });
    expect(JSON.stringify(r)).not.toContain("pw-rat-bi-mat");
  });

  it.each([
    ["chuỗi", "boom-string"],
    ["object", { code: "X", password: "mk-lo" }],
    ["null", null],
    ["undefined", undefined],
  ])("giá trị ném không phải Error (%s) vẫn có bản ghi kèm stack, không lộ mật khẩu", (_n, thrown) => {
    const { log, records } = capture();
    reportUnexpectedError(log, thrown, "corr-xyz-98765");
    const [r] = records();
    expect(r).toMatchObject({ level: "error", correlation_id: "corr-xyz-98765" });
    expect(String(r?.["exception.stacktrace"])).toContain("Error");
    expect(JSON.stringify(r)).not.toContain("mk-lo");
  });
});
