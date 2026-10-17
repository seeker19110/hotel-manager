// Hàng rào D-026 (sửa theo review lát 7): mọi event_type mà mã ứng dụng ghi vào outbox phải có consumer ở worker HOẶC được
// khai tường minh trong AUDIT_ONLY_EVENT_TYPES. Quên cả hai ⇒ sự kiện nằm mãi ở outbox (không bị đánh dấu đã phát) và báo động.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BANK_TXN_RECEIVED, NOTIFY_EVENT_TYPES } from "@hm/app";
import { describe, expect, it } from "vitest";
import { INVITATION_EVENT_TYPES } from "./jobs.ts";
import { AUDIT_ONLY_EVENT_TYPES } from "./relay.ts";

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/app/src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** event_type ghi vào outbox: `eventType: "x.y"` (pipeline lệnh), `values (…, 'x.y', …)` của INSERT trực tiếp, hằng/đối số của helper. */
function emittedEventTypes(): Set<string> {
  const out = new Set<string>();
  const files = walk(APP_SRC).filter(
    (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/testing/"),
  );
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/eventType:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) out.add(m[1] as string);
    // INSERT trực tiếp: `insert into outbox (…) values (${…}, ${…}, 'x.y', …`
    for (const m of src.matchAll(/insert into outbox[^`]*?values\s*\([^`]*?'([a-z_]+(?:\.[a-z_]+)+)'/gi))
      out.add(m[1] as string);
    // helper nội bộ nhận event_type làm đối số (auto-apply: outbox(trx, org, prop, "payment.confirmed", …))
    for (const m of src.matchAll(/\boutbox\(\s*trx,[^"`]*?"([a-z_]+(?:\.[a-z_]+)+)"/g))
      out.add(m[1] as string);
    for (const m of src.matchAll(/export const [A-Z_]+ = "([a-z_]+\.[a-z_]+)"/g)) {
      if (/BANK_TXN_RECEIVED|BREAK_OPENED/.test(m[0])) out.add(m[1] as string);
    }
  }
  return out;
}

const CONSUMED = new Set<string>([
  ...NOTIFY_EVENT_TYPES,
  ...INVITATION_EVENT_TYPES,
  "export.requested",
  BANK_TXN_RECEIVED,
]);

describe("outbox — mọi event_type có consumer hoặc được khai 'chỉ để audit'", () => {
  const emitted = emittedEventTypes();

  it("bắt được các event_type đã biết (rào không rỗng)", () => {
    for (const known of [
      "invoice.issued",
      "lease.expiring",
      "exception.opened",
      "payment.confirmed",
      BANK_TXN_RECEIVED,
    ])
      expect(emitted.has(known), known).toBe(true);
    expect(emitted.size).toBeGreaterThan(25);
  });

  it("không event_type nào bị bỏ rơi", () => {
    const orphan = [...emitted].filter((t) => !CONSUMED.has(t) && !AUDIT_ONLY_EVENT_TYPES.has(t)).sort();
    expect(orphan).toEqual([]);
  });

  it("danh sách audit-only không chứa loại đã có consumer và không chứa loại không ai phát", () => {
    expect([...AUDIT_ONLY_EVENT_TYPES].filter((t) => CONSUMED.has(t))).toEqual([]);
    expect([...AUDIT_ONLY_EVENT_TYPES].filter((t) => !emitted.has(t)).sort()).toEqual([]);
  });
});
