import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, maskString, redact, resolveAppVersion, serializeError } from "./logger.ts";

function capture() {
  const lines: string[] = [];
  return { lines, sink: { write: (l: string) => lines.push(l) } };
}

describe("logger JSON (BASE-ERR-005/006)", () => {
  it("một dòng JSON có ts, level, msg, correlation_id từ child", () => {
    const { lines, sink } = capture();
    const log = createLogger({
      sink,
      now: () => new Date("2026-10-15T00:00:00Z"),
      service: "hm-test",
      version: "1.2.3",
      env: "test",
    }).child({ correlation_id: "c-1" });
    log.info("đã tạo booking", { booking_id: "b-1" });
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "2026-10-15T00:00:00.000Z",
      level: "info",
      severity_number: 9,
      service: "hm-test",
      version: "1.2.3",
      env: "test",
      msg: "đã tạo booking",
      correlation_id: "c-1",
      booking_id: "b-1",
    });
  });

  it("lọc theo mức", () => {
    const { lines, sink } = capture();
    createLogger({ sink, level: "warn" }).info("bỏ qua");
    expect(lines).toHaveLength(0);
  });

  it("sự kiện bảo mật có category=security (SEC-LOG-001)", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).security("auth.login_failed", { email: "an.nguyen@example.com" });
    const rec = JSON.parse(lines[0] ?? "");
    expect(rec.category).toBe("security");
    expect(rec.event).toBe("auth.login_failed");
    expect(rec.level).toBe("warn");
    expect(rec.severity_number).toBe(13);
    expect(rec.email).toBe("a***@example.com");
  });
});

describe("che bí mật và dữ liệu cá nhân (BASE-ERR-007, TM-06)", () => {
  it("khoá nhạy cảm thành *** ở mọi độ sâu", () => {
    expect(
      redact({
        password: "p",
        headers: { authorization: "Bearer abc", cookie: "s=1" },
        guest: { cccd_number: "001234567890", name: "An" },
        list: [{ token: "t" }],
      }),
    ).toEqual({
      password: "***",
      headers: { authorization: "***", cookie: "***" },
      guest: { cccd_number: "***", name: "An" },
      list: [{ token: "***" }],
    });
  });

  it.each([
    ["SĐT 0912345678", "SĐT 091****678"],
    ["+84912345678", "091****678"],
    ["CCCD 001234567890", "CCCD ****7890"],
    ["email an.nguyen@example.com", "email a***@example.com"],
    ["phòng 203, 2 đêm", "phòng 203, 2 đêm"],
    ["số tiền 3580000", "số tiền 3580000"],
    ["tổng 1330254041 đ", "tổng 1330254041 đ"],
    ["CMND 123456789", "CMND ****6789"],
    ["uuid dfed37eb-4b0c-4482-8618-f9a712080629", "uuid dfed37eb-4b0c-4482-8618-f9a712080629"],
    ["uuid 6f1a2b3c-0000-4000-8000-123456789012", "uuid 6f1a2b3c-0000-4000-8000-123456789012"],
    ["ref HM0912345678X", "ref HM0912345678X"],
  ])("maskString(%s) → %s", (input, out) => {
    expect(maskString(input)).toBe(out);
  });

  it("Error → exception.type/message đã che (không còn name/message trần)", () => {
    const out = redact(new Error("khách 0912345678 lỗi")) as Record<string, string>;
    expect(out["exception.type"]).toBe("Error");
    expect(out["exception.message"]).toBe("khách 091****678 lỗi");
    expect(out.name).toBeUndefined();
  });

  it.each([
    ["Authorization: Bearer abcdef0123456789.xyz", "Authorization: Bearer ***"],
    ["postgres://hm:s3cr3tpw@db:5432/hm", "postgres://hm:***@db:5432/hm"],
    ["lỗi password=hunter2 khi nối", "lỗi password=*** khi nối"],
    ["url ?reset_token=abc123&x=1", "url ?reset_token=***&x=1"],
    ["https://example.com:8443/path", "https://example.com:8443/path"],
  ])("che bí mật trong giá trị chuỗi (SEC-SECRET-007): %s", (input, out) => {
    expect(maskString(input)).toBe(out);
  });
});

describe("bản ghi log: trường chuẩn, an toàn (BASE-ERR-006/008)", () => {
  const fixed = { now: () => new Date("2026-10-15T00:00:00Z"), service: "s", version: "v", env: "e" };

  it("severity_number theo OTel: debug 5, info 9, warn 13, error 17", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: "debug", ...fixed });
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    expect(lines.map((l) => JSON.parse(l).severity_number)).toEqual([5, 9, 13, 17]);
  });

  it("chuỗi chứa CR/LF/ký tự điều khiển vẫn là MỘT bản ghi JSON, không tách thành dòng log giả", () => {
    const { lines, sink } = capture();
    const evil = 'ok\n[ERROR] fake\r\n{"level":"error"}\u2028x';
    createLogger({ sink, ...fixed }).info(evil, { note: evil, "khoá\nlạ": evil });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    const rec = JSON.parse(lines[0] ?? "");
    expect(rec.msg).toBe(evil);
    expect(rec.level).toBe("info");
  });

  it("trường do mã gọi truyền không ghi đè ts/level/service/msg (chống giả mạo bản ghi)", () => {
    const { lines, sink } = capture();
    createLogger({ sink, ...fixed }).info("thật", {
      ts: "1999-01-01T00:00:00Z",
      level: "debug",
      service: "giả",
      severity_number: 1,
      msg: "giả",
    });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      ts: "2026-10-15T00:00:00.000Z",
      level: "info",
      service: "s",
      severity_number: 9,
      msg: "thật",
    });
  });

  it("child giữ service/version/env", () => {
    const { lines, sink } = capture();
    createLogger({ sink, ...fixed })
      .child({ component: "x" })
      .info("m");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      service: "s",
      version: "v",
      env: "e",
      component: "x",
    });
  });

  it("lỗi truyền qua `err` → exception.type/message/stacktrace ở cấp bản ghi, che PII và bí mật", () => {
    const { lines, sink } = capture();
    class PaymentError extends Error {
      override name = "PaymentError";
    }
    const e = new PaymentError("khách 0912345678 lỗi, Bearer abcdef0123456789");
    createLogger({ sink, ...fixed }).error("thanh toán lỗi", { err: e });
    const rec = JSON.parse(lines[0] ?? "");
    expect(rec["exception.type"]).toBe("PaymentError");
    expect(rec["exception.message"]).toBe("khách 091****678 lỗi, Bearer ***");
    expect(rec["exception.stacktrace"]).toContain("PaymentError");
    expect(rec["exception.stacktrace"]).not.toContain("0912345678");
    expect(rec.err).toBeUndefined();
  });

  it("lỗi bọc lỗi: exception.cause đệ quy, chặn ở 5 tầng; cause không phải Error vẫn được che", () => {
    const inner = new Error("gốc 001234567890");
    const wrapped = new Error("bọc", { cause: new Error("giữa", { cause: inner }) });
    const out = serializeError(wrapped);
    const mid = out["exception.cause"] as Record<string, unknown>;
    expect(mid["exception.message"]).toBe("giữa");
    expect((mid["exception.cause"] as Record<string, unknown>)["exception.message"]).toBe("gốc ****7890");
    let deep: Error = new Error("đáy");
    for (let i = 0; i < 9; i++) deep = new Error(`tầng ${i}`, { cause: deep });
    expect(JSON.stringify(serializeError(deep))).toContain("[depth]");
    expect(serializeError(new Error("x", { cause: "email a.b@example.com" }))["exception.cause"]).toBe(
      "email a***@example.com",
    );
  });

  it("Error không có stack vẫn ghi được (không ném lỗi)", () => {
    const e = new Error("không stack");
    e.stack = undefined as unknown as string;
    expect(serializeError(e)).toEqual({ "exception.type": "Error", "exception.message": "không stack" });
  });
});

describe("phiên bản (không hard-code)", () => {
  it("APP_VERSION ưu tiên; không có thì đọc package.json gốc của sản phẩm; không tìm thấy → 0.0.0", () => {
    expect(resolveAppVersion({ APP_VERSION: "9.9.9" }, "/")).toBe("9.9.9");
    const root = mkdtempSync(join(tmpdir(), "hm-ver-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hotel-manager", version: "1.4.0" }));
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@hm/web", version: "0.0.0" }));
    expect(resolveAppVersion({}, nested)).toBe("1.4.0");
    const noVersion = mkdtempSync(join(tmpdir(), "hm-ver-"));
    writeFileSync(join(noVersion, "package.json"), JSON.stringify({ name: "hotel-manager" }));
    expect(resolveAppVersion({}, noVersion)).toBe("0.0.0");
    expect(resolveAppVersion({}, mkdtempSync(join(tmpdir(), "hm-ver-")))).toBe("0.0.0");
  });

  it("mặc định của logger = version của package.json gốc repo này (hoặc 0.0.0 khi chưa đặt)", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    const saved = process.env.APP_VERSION;
    delete process.env.APP_VERSION;
    try {
      const { lines, sink } = capture();
      createLogger({ sink }).info("m");
      expect(JSON.parse(lines[0] ?? "").version).toBe(pkg.version ?? "0.0.0");
    } finally {
      if (saved !== undefined) process.env.APP_VERSION = saved;
    }
  });
});
