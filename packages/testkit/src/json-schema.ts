// Bộ kiểm JSON Schema (draft 2020-12, tập con) cho test — không thêm phụ thuộc. Cố ý ĐÓNG-KHI-LẠ: từ khoá không biết ⇒ ném lỗi
// (không lặng lẽ bỏ qua như một số bộ chuyển đổi — vd `required` không kèm `properties` bị bỏ), nên schema log không thể
// "xanh giả" vì một từ khoá không được kiểm. Dùng cho `log-record.schema.json` (BASE-ERR-006).
//
// Hỗ trợ: type (một hoặc mảng), enum, const, required, properties, additionalProperties (bool | schema), items, minItems,
// maxItems, minLength, maxLength (theo điểm mã), minimum, maximum, pattern, format `date-time` (RFC 3339, BẮT BUỘC offset/Z),
// allOf, anyOf, oneOf, not, if/then/else, dependentRequired, $ref cục bộ (`#/...`). Chú thích (title, description, $comment,
// $schema, $id, $defs, default, examples) được bỏ qua.

export type JsonSchema = boolean | { [keyword: string]: unknown };

export interface JsonSchemaError {
  /** Đường dẫn JSON Pointer tới giá trị sai (rỗng = gốc). */
  path: string;
  message: string;
}

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "$defs",
  "default",
  "examples",
]);
const KNOWN = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "$ref",
]);

// RFC 3339 §5.6 date-time: offset (`Z` hoặc ±hh:mm) bắt buộc.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isDateTime(v: string): boolean {
  const m = DATE_TIME.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 60) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d >= 1 && d <= days;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#")) throw new Error(`$ref ngoài tài liệu chưa hỗ trợ: ${ref}`);
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof node !== "object" || node === null || !(key in node))
      throw new Error(`$ref không tìm thấy: ${ref}`);
    node = (node as Record<string, unknown>)[key];
  }
  return node as JsonSchema;
}

function check(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: string,
  out: JsonSchemaError[],
): void {
  if (typeof schema === "boolean") {
    if (!schema) out.push({ path, message: "schema `false` từ chối mọi giá trị" });
    return;
  }
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k) && !ANNOTATIONS.has(k)) throw new Error(`Từ khoá JSON Schema chưa hỗ trợ: ${k}`);
  }
  const err = (message: string) => out.push({ path, message });
  const sub = (s: JsonSchema, v: unknown, p: string, o: JsonSchemaError[]) => check(root, s, v, p, o);
  const passes = (s: JsonSchema) => {
    const tmp: JsonSchemaError[] = [];
    sub(s, value, path, tmp);
    return tmp.length === 0;
  };

  if (typeof schema.$ref === "string") sub(resolveRef(root, schema.$ref), value, path, out);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(t, value)))
      err(`kiểu ${typeOf(value)} không thuộc ${types.join("|")}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    err(`giá trị ${JSON.stringify(value)} không thuộc enum`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) err(`phải bằng ${JSON.stringify(schema.const)}`);

  if (typeof value === "string") {
    const len = [...value].length;
    if (typeof schema.minLength === "number" && len < schema.minLength) err(`ngắn hơn ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && len > schema.maxLength) err(`dài hơn ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      err(`không khớp pattern ${schema.pattern}`);
    }
    if (schema.format !== undefined) {
      if (schema.format !== "date-time") throw new Error(`format chưa hỗ trợ: ${String(schema.format)}`);
      if (!isDateTime(value)) err("không phải date-time RFC 3339 có offset");
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) err(`nhỏ hơn ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) err(`lớn hơn ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      err(`ít hơn ${schema.minItems} phần tử`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      err(`nhiều hơn ${schema.maxItems} phần tử`);
    if (schema.items !== undefined) {
      for (const [i, v] of value.entries()) sub(schema.items as JsonSchema, v, `${path}/${i}`, out);
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(obj, r)) err(`thiếu trường bắt buộc "${r}"`);
    }
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [k, s] of Object.entries(props)) {
      if (Object.hasOwn(obj, k)) sub(s, obj[k], `${path}/${k}`, out);
    }
    if (schema.additionalProperties !== undefined) {
      for (const k of Object.keys(obj)) {
        if (Object.hasOwn(props, k)) continue;
        sub(schema.additionalProperties as JsonSchema, obj[k], `${path}/${k}`, out);
      }
    }
    const dep = schema.dependentRequired as Record<string, string[]> | undefined;
    for (const [k, needs] of Object.entries(dep ?? {})) {
      if (!Object.hasOwn(obj, k)) continue;
      for (const n of needs) if (!Object.hasOwn(obj, n)) err(`"${k}" kéo theo "${n}" nhưng thiếu`);
    }
  }

  for (const s of (schema.allOf as JsonSchema[] | undefined) ?? []) sub(s, value, path, out);
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).some(passes))
    err("không khớp nhánh anyOf nào");
  if (Array.isArray(schema.oneOf)) {
    const n = (schema.oneOf as JsonSchema[]).filter(passes).length;
    if (n !== 1) err(`khớp ${n} nhánh oneOf (cần đúng 1)`);
  }
  if (schema.not !== undefined && passes(schema.not as JsonSchema)) err("khớp schema `not`");
  if (schema.if !== undefined) {
    if (passes(schema.if as JsonSchema)) {
      if (schema.then !== undefined) sub(schema.then as JsonSchema, value, path, out);
    } else if (schema.else !== undefined) {
      sub(schema.else as JsonSchema, value, path, out);
    }
  }
}

/** Danh sách lỗi (rỗng = hợp lệ). Ném `Error` nếu schema dùng từ khoá chưa hỗ trợ. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaError[] {
  const out: JsonSchemaError[] = [];
  check(schema, schema, value, "", out);
  return out;
}
