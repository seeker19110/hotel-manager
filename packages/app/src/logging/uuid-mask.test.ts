// Hồi quy: che PII không được làm hỏng UUID (lỗi tìm thấy ở T-008 — replay command trả id sai).
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskString, redact } from "./logger.ts";

describe("maskString giữ nguyên UUID", () => {
  it("mọi UUID ngẫu nhiên (property test) không bị đổi, kể cả trong object lồng", () => {
    fc.assert(
      fc.property(fc.uuid(), (u) => {
        expect(maskString(u)).toBe(u);
        expect(redact({ data: { id: u, list: [u] } })).toEqual({ data: { id: u, list: [u] } });
      }),
      { numRuns: 2000 },
    );
    for (let i = 0; i < 2000; i++) {
      const u = randomUUID();
      expect(maskString(u)).toBe(u);
    }
  });
});
