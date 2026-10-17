// Hồi quy D-027: tên lệnh trong registry phải qua CHECK `idempotency_keys.command` của CSDL (0003) — `roomType.create`
// từng luôn trả 422 vì đoạn đầu có chữ hoa. Đọc ràng buộc thật từ catalog, không chép regex.
import { createTestDb, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS } from "./registry.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.drop();
});

describe("tên lệnh registry ↔ CHECK idempotency_keys.command", () => {
  it("mọi lệnh khớp regex của CSDL; key registry = tên lệnh", async () => {
    const def = (
      await sql<{ def: string }>`
        select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'idempotency_keys'::regclass and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%command ~%'`.execute(t.admin)
    ).rows[0]?.def;
    const pattern = def?.match(/command ~ '((?:[^']|'')+)'/)?.[1]?.replaceAll("''", "'");
    expect(pattern).toBeTruthy();
    const names = Object.values(COMMANDS).map((c) => c.command);
    expect(names.length).toBeGreaterThan(50);
    const bad = (
      await sql<{ n: string }>`
        select n from unnest(${names}::text[]) as n where not (n ~ ${pattern as string})`.execute(t.admin)
    ).rows.map((r) => r.n);
    expect(bad).toEqual([]);
    for (const [key, c] of Object.entries(COMMANDS)) expect(c.command).toBe(key);
  });
});
