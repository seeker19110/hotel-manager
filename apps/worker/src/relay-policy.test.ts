// BE-JOB-003 (T-401): phân loại lỗi job + chính sách retry mặc định.
import { CommandError, InvalidJobPayloadError } from "@hm/app";
import { describe, expect, it } from "vitest";
import { DEAD_LETTER_RETENTION_SECONDS, DEFAULT_QUEUE_POLICY, isPermanentJobError } from "./relay.ts";

describe("isPermanentJobError", () => {
  it("payload sai và lỗi nghiệp vụ 4xx là vĩnh viễn", () => {
    expect(isPermanentJobError(new InvalidJobPayloadError("x", "sai"))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 410, 413, 422])
      expect(isPermanentJobError(new CommandError("X", status, "m")), String(status)).toBe(true);
  });
  it("lỗi tạm (5xx, 408, 429, lỗi mạng/không có mã, giá trị lạ) ⇒ được retry", () => {
    for (const status of [408, 429, 500, 502, 503, 504])
      expect(isPermanentJobError(new CommandError("X", status, "m")), String(status)).toBe(false);
    expect(isPermanentJobError(new Error("ECONNRESET"))).toBe(false);
    expect(isPermanentJobError(Object.assign(new Error("x"), { status: "404" }))).toBe(false);
    for (const v of [null, undefined, "lỗi", 404, {}]) expect(isPermanentJobError(v)).toBe(false);
  });
});

describe("chính sách queue mặc định", () => {
  it("3–5 lần thử, backoff mũ, trần chờ tường minh; dead letter giữ lâu hơn 14 ngày của queue gốc", () => {
    expect(DEFAULT_QUEUE_POLICY.retryLimit).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_QUEUE_POLICY.retryLimit).toBeLessThanOrEqual(5);
    expect(DEFAULT_QUEUE_POLICY.retryBackoff).toBe(true);
    expect(DEFAULT_QUEUE_POLICY.retryDelayMax).toBe(300);
    expect(DEAD_LETTER_RETENTION_SECONDS).toBeGreaterThan(14 * 24 * 3600);
  });
});
