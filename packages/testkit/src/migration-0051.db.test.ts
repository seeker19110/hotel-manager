// Migration 0051 (D-035): `down` trả đúng các FK về NO ACTION + gỡ index nhóm D + hàm metric; `up` lại ra RESTRICT; 0052 đảo được.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const count = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(t.admin)).rows[0]?.n;
const fkByAction = (a: string) =>
  count(sql<{
    n: number;
  }>`select count(*)::int as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace
    where c.contype = 'f' and s.nspname = 'public' and c.confdeltype = ${a}`);
const fnExists = () =>
  count(
    sql<{
      n: number;
    }>`select count(*)::int as n from pg_proc where oid = to_regprocedure('app.db_health_metrics()')`,
  );
const dIndexes = () =>
  count(
    sql<{ n: number }>`select count(*)::int as n from pg_indexes where schemaname = 'public' and indexname in
      ('ixfk_shifts_previous_shift_id', 'ixfk_inbox_bank_transaction_id', 'ixfk_payment_allocations_entry_id')`,
  );

describe("migration 0051/0052 — down rồi up lại", () => {
  it("up: mọi FK public không trì hoãn là RESTRICT, chỉ 2 FK DEFERRABLE còn NO ACTION; hàm metric + index D có mặt", async () => {
    expect(await fkByAction("a")).toBe(2);
    expect(await fkByAction("r")).toBeGreaterThan(200);
    expect(await fnExists()).toBe(1);
    expect(await dIndexes()).toBe(3);
  });

  it("down 0052 rồi 0051: FK về NO ACTION, hàm và index D biến mất; up lại khôi phục RESTRICT", async () => {
    const m = createMigrator(t.admin);
    expect((await m.migrateDown()).results?.[0]?.migrationName).toBe("0052_files_settlement_read");
    expect((await m.migrateDown()).results?.[0]?.migrationName).toBe("0051_fk_restrict_and_indexes");
    expect(await fkByAction("a")).toBeGreaterThan(240);
    expect(await fkByAction("r")).toBe(1); // fk_memberships_auth_user: RESTRICT từ trước
    expect(await fnExists()).toBe(0);
    expect(await dIndexes()).toBe(0);
    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.migrationName)).toEqual([
      "0051_fk_restrict_and_indexes",
      "0052_files_settlement_read",
    ]);
    expect(await fkByAction("a")).toBe(2);
    expect(await dIndexes()).toBe(3);
    expect(Object.keys(migrations).slice(-2)).toEqual([
      "0051_fk_restrict_and_indexes",
      "0052_files_settlement_read",
    ]);
  });
});
