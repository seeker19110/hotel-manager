// SEC-LOG-001 "lỗi TLS/chứng chỉ backend": nhận diện theo mã lỗi (đi theo cause/errors) và phát đúng một sự kiện bảo mật.
import { describe, expect, it } from "vitest";
import { assertLogRecords } from "../testing/log-schema.ts";
import { createLogger } from "./logger.ts";
import { reportBackendTlsError, tlsFailureCode } from "./tls-errors.ts";
import { reportUnexpectedError } from "./unexpected.ts";

const withCode = (code: string, msg = "x") => Object.assign(new Error(msg), { code });
const capture = () => {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger({ sink: { write: (l) => lines.push(l) }, service: "t", version: "0", env: "test" }),
  };
};

describe("tls-errors — tlsFailureCode", () => {
  it.each([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
  ])("%s ⇒ nhận diện", (code) => {
    expect(tlsFailureCode(withCode(code))).toBe(code);
  });

  it("đi theo cause (fetch bọc lỗi) và AggregateError.errors", () => {
    const e = new TypeError("fetch failed", { cause: withCode("CERT_HAS_EXPIRED") });
    expect(tlsFailureCode(e)).toBe("CERT_HAS_EXPIRED");
    expect(tlsFailureCode(new AggregateError([new Error("a"), withCode("HOSTNAME_MISMATCH")]))).toBe(
      "HOSTNAME_MISMATCH",
    );
  });

  it("không phải TLS ⇒ null (ECONNREFUSED, thông điệp nhắc 'certificate' nhưng không có mã, null, chuỗi, vòng cause)", () => {
    expect(tlsFailureCode(withCode("ECONNREFUSED"))).toBeNull();
    expect(tlsFailureCode(new Error("certificate has expired"))).toBeNull();
    expect(tlsFailureCode(null)).toBeNull();
    expect(tlsFailureCode("CERT_HAS_EXPIRED")).toBeNull();
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(tlsFailureCode(a)).toBeNull();
  });

  it("cause quá sâu (> 5 tầng) bị bỏ qua, không đệ quy vô hạn", () => {
    let e: unknown = withCode("CERT_HAS_EXPIRED");
    for (let i = 0; i < 8; i++) e = new Error("bọc", { cause: e });
    expect(tlsFailureCode(e)).toBeNull();
  });
});

describe("tls-errors — sự kiện backend.tls_error", () => {
  it("lỗi TLS ⇒ một bản ghi hợp lệ: outcome failure, reason = mã, target backend; không lộ thông điệp/tên máy", () => {
    const { lines, log } = capture();
    const done = reportBackendTlsError(withCode("CERT_HAS_EXPIRED", "cert of db.internal.example expired"), {
      backend: "postgres",
      log,
      correlationId: "corr-12345678",
    });
    expect(done).toBe(true);
    const [r] = assertLogRecords(lines, 1);
    expect(r).toMatchObject({
      event: "backend.tls_error",
      category: "security",
      outcome: "failure",
      reason: "CERT_HAS_EXPIRED",
      target: { type: "backend", id: "postgres" },
      correlation_id: "corr-12345678",
    });
    expect(lines[0]).not.toContain("db.internal.example");
  });

  it("lỗi thường ⇒ không ghi gì, trả false", () => {
    const { lines, log } = capture();
    expect(reportBackendTlsError(new Error("x"), { backend: "s3", log })).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it("reportUnexpectedError với lỗi TLS ghi cả sự kiện bảo mật lẫn log lỗi", () => {
    const { lines, log } = capture();
    reportUnexpectedError(
      log,
      new TypeError("fetch failed", { cause: withCode("DEPTH_ZERO_SELF_SIGNED_CERT") }),
      "corr-12345678",
    );
    const recs = assertLogRecords(lines, 2);
    expect(recs.map((r) => r.msg)).toEqual(["backend.tls_error", "lỗi không dự kiến"]);
  });
});
