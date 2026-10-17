// Bộ kiểm JSON Schema của testkit (dùng cho log-record.schema.json): phải ĐÚNG và ĐÓNG-KHI-LẠ, nếu không test schema log xanh giả.
import { type JsonSchema, validateJsonSchema } from "@hm/testkit/json-schema";
import { describe, expect, it } from "vitest";

const ok = (s: JsonSchema, v: unknown) => expect(validateJsonSchema(s, v)).toEqual([]);
const bad = (s: JsonSchema, v: unknown) => expect(validateJsonSchema(s, v).length).toBeGreaterThan(0);

describe("json-schema (testkit) — từ khoá", () => {
  it("type: một kiểu, mảng kiểu, integer ⊂ number, null khác 0/rỗng", () => {
    ok({ type: "string" }, "");
    bad({ type: "string" }, 0);
    ok({ type: ["string", "null"] }, null);
    bad({ type: ["string", "null"] }, 0);
    ok({ type: "number" }, 3);
    bad({ type: "integer" }, 1.5);
    bad({ type: "object" }, null);
    bad({ type: "object" }, []);
  });

  it("required không cần properties (chỗ bộ chuyển đổi của zod bỏ sót) + properties + additionalProperties", () => {
    bad({ type: "object", required: ["a"] }, {});
    ok({ type: "object", required: ["a"] }, { a: null });
    bad({ type: "object", properties: { a: { type: "string" } } }, { a: 1 });
    bad({ type: "object", properties: { a: {} }, additionalProperties: false }, { b: 1 });
    ok({ type: "object", properties: { a: {} }, additionalProperties: false }, { a: 1 });
  });

  it("enum/const (so sánh sâu), pattern (Unicode), minLength/maxLength theo điểm mã", () => {
    ok({ enum: [5, 9] }, 9);
    bad({ enum: [5, 9] }, "9");
    ok({ const: { a: [1] } }, { a: [1] });
    bad({ const: { a: [1] } }, { a: [2] });
    bad({ pattern: "^(?!0{4}$)[0-9a-f]{4}$" }, "0000");
    ok({ pattern: "^(?!0{4}$)[0-9a-f]{4}$" }, "0a00");
    ok({ maxLength: 1 }, "😀");
    bad({ maxLength: 1 }, "😀😀");
    bad({ minLength: 1 }, "");
  });

  it("minimum/maximum, items/minItems/maxItems", () => {
    bad({ minimum: 1 }, 0);
    bad({ maximum: 1 }, 2);
    bad({ items: { type: "string" } }, ["a", 1]);
    bad({ minItems: 1 }, []);
    bad({ maxItems: 1 }, [1, 2]);
  });

  it("format date-time: bắt buộc offset/Z, từ chối ngày không có thật", () => {
    const s = { type: "string", format: "date-time" };
    ok(s, "2026-10-17T00:00:00.000Z");
    ok(s, "2026-10-17T07:00:00+07:00");
    bad(s, "2026-10-17T00:00:00");
    bad(s, "2026-10-17");
    bad(s, "2026-02-30T00:00:00Z");
    bad(s, "2026-13-01T00:00:00Z");
    bad(s, "2026-10-17T24:00:00Z");
  });

  it("allOf/anyOf/oneOf/not/if-then-else/dependentRequired/$ref", () => {
    bad({ allOf: [{ type: "string" }, { minLength: 2 }] }, "a");
    ok({ anyOf: [{ type: "string" }, { type: "number" }] }, 1);
    bad({ anyOf: [{ type: "string" }, { type: "number" }] }, null);
    bad({ oneOf: [{ type: "number" }, { minimum: 0 }] }, 1); // khớp cả hai
    ok({ oneOf: [{ type: "null" }, { type: "string" }] }, null);
    bad({ not: { type: "string" } }, "x");
    // Dựng từ chuỗi JSON: biome cấm khai báo trực tiếp thuộc tính `then` (thenable) trong mã.
    const cond = JSON.parse(
      '{"if":{"required":["a"]},"then":{"required":["b"]},"else":{"required":["c"]}}',
    ) as Record<string, unknown>;
    ok(cond, { a: 1, b: 1 });
    bad(cond, { a: 1 });
    ok(cond, { c: 1 });
    bad(cond, {});
    bad({ dependentRequired: { a: ["b"] } }, { a: 1 });
    ok({ dependentRequired: { a: ["b"] } }, { b: 1 });
    bad({ $defs: { h: { const: 1 } }, properties: { x: { $ref: "#/$defs/h" } } }, { x: 2 });
  });

  it("đóng-khi-lạ: từ khoá/format/$ref chưa hỗ trợ ⇒ ném lỗi (không lặng lẽ bỏ qua)", () => {
    expect(() => validateJsonSchema({ patternProperties: {} }, {})).toThrow(/chưa hỗ trợ/);
    expect(() => validateJsonSchema({ type: "string", format: "email" }, "a@b.c")).toThrow(/format/);
    expect(() => validateJsonSchema({ $ref: "http://x/y" }, 1)).toThrow(/\$ref/);
    expect(() => validateJsonSchema({ $ref: "#/nope" }, 1)).toThrow(/không tìm thấy/);
  });
});
