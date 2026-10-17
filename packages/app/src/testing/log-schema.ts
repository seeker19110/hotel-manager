// Helper CHỈ cho test: đối chiếu bản ghi log với JSON Schema chung `logging/log-record.schema.json` (BASE-ERR-006).
// Mọi test bắt log (sink/setAppLogger) gọi `assertLogRecords(lines)` ⇒ không có dòng log nào lọt ra mà không qua schema.
import { readFileSync } from "node:fs";
import { type JsonSchema, validateJsonSchema } from "@hm/testkit/json-schema";

const schema = JSON.parse(
  readFileSync(new URL("../logging/log-record.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

/** Schema dùng chung (để test đối chiếu mẫu sai trực tiếp). */
export const LOG_RECORD_SCHEMA: JsonSchema = schema;

/** Lỗi schema của một bản ghi đã parse (rỗng = hợp lệ). */
export function logRecordErrors(record: unknown): string[] {
  const errors = validateJsonSchema(schema, record).map((e) => `${e.path || "/"}: ${e.message}`);
  // Điều JSON Schema không biểu diễn được: với sự kiện bảo mật `msg` phải trùng `event`.
  const r = record as { category?: unknown; msg?: unknown; event?: unknown } | null;
  if (r && typeof r === "object" && r.category === "security" && r.msg !== r.event) {
    errors.push("/msg: sự kiện bảo mật phải có msg = event");
  }
  return errors;
}

/**
 * Mỗi phần tử là MỘT dòng log (chuỗi JSON một dòng): parse + kiểm schema, ném lỗi nêu dòng sai. Trả các bản ghi đã parse.
 * `expectAtLeast`: số bản ghi tối thiểu (chặn test "xanh" chỉ vì không có gì được kiểm).
 */
export function assertLogRecords(lines: readonly string[], expectAtLeast = 0): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  lines.forEach((line, i) => {
    if (line.includes("\n")) throw new Error(`log #${i} không phải một dòng: ${JSON.stringify(line)}`);
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new Error(`log #${i} không phải JSON: ${line.slice(0, 200)}`);
    }
    const errors = logRecordErrors(rec);
    if (errors.length > 0)
      throw new Error(`log #${i} sai schema (${errors.join("; ")}): ${line.slice(0, 300)}`);
    out.push(rec as Record<string, unknown>);
  });
  if (out.length < expectAtLeast) throw new Error(`cần ≥ ${expectAtLeast} bản ghi log, chỉ có ${out.length}`);
  return out;
}
