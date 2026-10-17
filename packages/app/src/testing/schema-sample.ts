// Helper CHỈ cho test: sinh một đầu vào HỢP LỆ từ schema Zod (qua JSON Schema) để bộ test sinh từ registry (authz-matrix)
// đi qua bước validate và chạm tới kiểm quyền. Không phải bộ sinh ngẫu nhiên đầy đủ — chỉ cần "một giá trị đúng".
import { randomUUID } from "node:crypto";
import { z } from "zod";

type Json = Record<string, unknown>;

export interface SampleOptions {
  /** Giá trị cố định theo TÊN trường (vd `property_id` → id thật) — áp cho trường chuỗi uuid. */
  ids?: Readonly<Record<string, string>>;
  /**
   * Điền cả trường TUỲ CHỌN có tên trong `ids` (vd `property_id` lọc báo cáo) — để thử id của tổ chức khác ở mọi chỗ nhận id.
   * Nếu đầu vào thêm trường tuỳ chọn không còn hợp lệ (ràng buộc chéo) thì dùng lại bản chỉ có trường bắt buộc.
   */
  withOptionalIds?: boolean;
}

function sampleNode(node: Json, key: string, opts: SampleOptions): unknown {
  if ("const" in node) return node.const;
  if (Array.isArray(node.enum)) return node.enum[0];
  for (const k of ["anyOf", "oneOf"] as const) {
    const alts = node[k];
    if (Array.isArray(alts)) {
      const pick = (alts as Json[]).find((a) => a.type !== "null") ?? alts[0];
      return sampleNode(pick as Json, key, opts);
    }
  }
  if (Array.isArray(node.allOf)) return sampleNode(Object.assign({}, ...(node.allOf as Json[])), key, opts);
  const type = Array.isArray(node.type)
    ? ((node.type as string[]).find((t) => t !== "null") ?? "null")
    : node.type;
  switch (type) {
    case "object": {
      const props = (node.properties ?? {}) as Record<string, Json>;
      const required = new Set((node.required ?? []) as string[]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props))
        if (required.has(k) || (opts.withOptionalIds && opts.ids && k in opts.ids))
          out[k] = sampleNode(v, k, opts);
      return out;
    }
    case "array": {
      const n = Math.max(Number(node.minItems ?? 0), 0);
      const items = (node.items ?? {}) as Json;
      return Array.from({ length: n }, () => sampleNode(items, key, opts));
    }
    case "string": {
      switch (node.format) {
        case "uuid":
          return opts.ids?.[key] ?? randomUUID();
        case "date":
          return "2026-11-05";
        case "date-time":
          return "2026-11-05T08:00:00+07:00";
        case "email":
          return "khach@example.test";
        default: {
          const len = Math.min(Math.max(Number(node.minLength ?? 1), 1), Number(node.maxLength ?? 1000));
          return "a".repeat(len);
        }
      }
    }
    case "integer":
    case "number": {
      const min =
        (node.minimum as number | undefined) ?? ((node.exclusiveMinimum as number | undefined) ?? -1) + 1;
      const max = (node.maximum as number | undefined) ?? Number.MAX_SAFE_INTEGER;
      return Math.min(Math.max(min, 0), max);
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "a";
  }
}

/** Một đầu vào hợp lệ cho `schema` (kiểm lại bằng `safeParse`); `null` nếu sinh ra không qua được schema (cần đầu vào tay). */
export function sampleInput(schema: z.ZodType, opts: SampleOptions = {}): Record<string, unknown> | null {
  const js = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Json;
  const value = sampleNode(js, "", opts);
  const parsed = schema.safeParse(value);
  return parsed.success && value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Tên các thuộc tính cấp 1 của schema đối tượng (để biết trường nào nhận `*_id`, `person_id`…). */
export function topLevelFields(schema: z.ZodType): string[] {
  const js = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Json;
  return Object.keys((js.properties ?? {}) as object);
}
