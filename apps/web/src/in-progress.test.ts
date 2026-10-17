// BE-API-008 (D-043): client đợi Retry-After của 409 IDEMPOTENCY_IN_PROGRESS rồi tra kết quả (không gửi payload mới).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IN_PROGRESS_CODE, retryAfterMs } from "../components/command/in-progress.ts";

describe("retryAfterMs", () => {
  it("giây hợp lệ → ms; làm tròn lên; kẹp 10 giây", () => {
    expect(retryAfterMs("1")).toBe(1_000);
    expect(retryAfterMs("2.1")).toBe(3_000);
    expect(retryAfterMs("999")).toBe(10_000);
  });
  it("ca biên: thiếu/rỗng/0/âm/chữ/vô cực → 1 giây", () => {
    for (const bad of [null, "", "  ", "0", "-3", "abc", "Infinity", "NaN"])
      expect(retryAfterMs(bad), String(bad)).toBe(1_000);
  });
});

describe("use-command xử lý IDEMPOTENCY_IN_PROGRESS", () => {
  it("mã khớp server và hook tra kết quả (check) thay vì gửi lại payload", () => {
    expect(IN_PROGRESS_CODE).toBe("IDEMPOTENCY_IN_PROGRESS");
    const src = readFileSync(new URL("../components/command/use-command.ts", import.meta.url), "utf8");
    expect(src).toMatch(/IN_PROGRESS_CODE\)\s*return check\(\{ waitMs: retryAfterMs\(/);
  });
});
