// XC-UNITS-001 — API từ chối thời điểm không có offset: mọi trường `date-time` của registry (lệnh + truy vấn) và webhook phải
// nhận `…Z` / `…±hh:mm` và TỪ CHỐI chuỗi không offset, chỉ ngày, epoch. Quét tự động theo JSON Schema của từng schema đầu vào,
// nên trường thời điểm mới thêm vào registry được kiểm ngay; trường tên giống thời điểm mà khai `z.string()` trần bị chặn.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COMMANDS, QUERIES } from "./registry.ts";
import { simPayload } from "./webhook-route.ts";

type Json = { [k: string]: unknown };
interface Site {
  owner: string;
  path: (string | number)[];
}

function walk(schema: Json, path: (string | number)[], owner: string, out: Site[]): void {
  if (schema.format === "date-time") out.push({ owner, path });
  const props = schema.properties as Record<string, Json> | undefined;
  for (const [k, v] of Object.entries(props ?? {})) walk(v, [...path, k], owner, out);
  if (schema.items && typeof schema.items === "object") walk(schema.items as Json, [...path, 0], owner, out);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    for (const v of (schema[key] as Json[] | undefined) ?? []) walk(v, path, owner, out);
  }
}

function build(path: (string | number)[], leaf: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return leaf;
  return typeof head === "number" ? [build(rest, leaf)] : { [head]: build(rest, leaf) };
}

const entries: [string, z.ZodType][] = [
  ...Object.entries(COMMANDS).map(([k, d]) => [`command ${k}`, d.input] as [string, z.ZodType]),
  ...Object.entries(QUERIES).map(([k, d]) => [`query ${k}`, d.input] as [string, z.ZodType]),
  ["webhook sim", simPayload],
];

const sites: Site[] = [];
for (const [owner, schema] of entries) {
  walk(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json, [], owner, sites);
}

const issuesAt = (schema: z.ZodType, path: (string | number)[], value: unknown) => {
  const r = schema.safeParse(build(path, value));
  return r.success ? [] : r.error.issues.filter((i) => i.path.join(".") === path.join("."));
};
const schemaOf = (owner: string) => (entries.find(([o]) => o === owner) as [string, z.ZodType])[1];

describe("XC-UNITS-001 — trường thời điểm của API bắt buộc offset", () => {
  it("quét thấy các trường date-time đã biết (không quét hụt)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(9);
    const owners = new Set(sites.map((s) => s.owner));
    for (const o of [
      "command maintenance.proposeBlock",
      "command stay.markNoticeSubmitted",
      "query stay.listNotices",
      "query audit.listEvents",
      "query notifications.listMine",
      "webhook sim",
    ])
      expect(owners, o).toContain(o);
  });

  it.each(sites.map((s) => [`${s.owner} · ${s.path.join(".")}`, s] as const))("%s", (_name, s) => {
    const schema = schemaOf(s.owner);
    const naive = [
      "2026-10-13T07:14:05",
      "2026-10-13T07:14:05.123",
      "2026-10-13 07:14:05Z",
      "2026-10-13",
      "1760000000000",
      "",
    ];
    for (const v of naive)
      expect(issuesAt(schema, s.path, v).length, `phải từ chối ${JSON.stringify(v)}`).toBeGreaterThan(0);
    expect(issuesAt(schema, s.path, 1760000000000).length, "số epoch").toBeGreaterThan(0);
    for (const v of [
      "2026-10-13T07:14:05Z",
      "2026-10-13T07:14:05.123Z",
      "2026-10-13T14:14:05+07:00",
      "2026-10-13T07:14:05-00:30",
    ])
      expect(issuesAt(schema, s.path, v), `phải nhận ${v}`).toEqual([]);
  });

  it("không có trường tên giống thời điểm mà khai chuỗi trần (z.string) — phải là date-time hoặc date", () => {
    const TIME_NAME = /(_at|_on)$|^(from|to|start|end|before|after|until|since|due_before)$/;
    const loose: string[] = [];
    const walkNames = (schema: Json, path: string[], owner: string) => {
      for (const [k, v] of Object.entries((schema.properties as Record<string, Json> | undefined) ?? {})) {
        const t = v.type;
        const isString = t === "string" || (Array.isArray(t) && t.includes("string"));
        if (TIME_NAME.test(k) && isString && v.format !== "date-time" && v.format !== "date") {
          loose.push(`${owner} · ${[...path, k].join(".")}`);
        }
        walkNames(v, [...path, k], owner);
        if (v.items && typeof v.items === "object") walkNames(v.items as Json, [...path, k, "[]"], owner);
      }
    };
    for (const [owner, schema] of entries) {
      walkNames(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json, [], owner);
    }
    // Ngoại lệ tường minh (không phải thời điểm): giờ tường HH:MM theo cơ sở.
    expect(loose.filter((l) => !/domestic_cutoff|domestic_next_day_before|send_window/.test(l))).toEqual([]);
  });
});
