// Migration 0060 (T-610, D-035): index cho 52 FK nhóm A (cột người thao tác). Kiểm: down gỡ đúng các index đó (và chỉ chúng), up lại
// đưa về, index một phần `WHERE X IS NOT NULL` chỉ ở cột cho phép NULL, `lock_timeout` 5 s không treo + không rò sang migration sau.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";

const NAME = "0060_fk_operator_indexes";
const m0060 = () => {
  const m = migrations[NAME];
  if (!m) throw new Error(`thiếu migration ${NAME}`);
  return m;
};
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const ixfkNames = async () =>
  (
    await sql<{ indexname: string }>`select indexname from pg_indexes
      where schemaname = 'public' and indexname like 'ixfk\_%' order by indexname`.execute(t.admin)
  ).rows.map((r) => r.indexname);
const indexDef = async (name: string) =>
  (await sql<{ d: string }>`select indexdef as d from pg_indexes where indexname = ${name}`.execute(t.admin))
    .rows[0]?.d;

/** Lùi theo sổ (không đếm cứng số migration) tới khi `NAME` vừa được lùi. */
async function downThrough(name: string): Promise<string[]> {
  const undone: string[] = [];
  for (let i = 0; i < 50 && undone.at(-1) !== name; i++) {
    const res = await createMigrator(t.admin).migrateDown();
    expect(res.error).toBeUndefined();
    const n = res.results?.[0]?.migrationName;
    expect(n).toBeDefined();
    undone.push(n as string);
  }
  expect(undone.at(-1)).toBe(name);
  return undone;
}

describe("migration 0060 — index FK nhóm A", () => {
  it("up: có đủ 52 index; cột cho phép NULL → index một phần, cột NOT NULL → index thường", async () => {
    const names = await ixfkNames();
    expect(await indexDef("ixfk_tasks_done_by")).toMatch(
      /\(organization_id, done_by\) WHERE \(done_by IS NOT NULL\)/,
    );
    expect(await indexDef("ixfk_reservations_created_by")).toMatch(/\(organization_id, created_by\)$/);
    expect(names).toContain("ixfk_reservations_created_by");
  });

  it("down gỡ ĐÚNG 52 index của 0060 (index nhóm khác còn nguyên); up lại khôi phục; sổ migration vẫn liền mạch", async () => {
    const before = await ixfkNames();
    const undone = await downThrough(NAME);
    const afterDown = await ixfkNames();
    const removed = before.filter((n) => !afterDown.includes(n));
    expect(afterDown.filter((n) => !before.includes(n))).toEqual([]);
    expect(removed).toHaveLength(52);
    expect(removed).toContain("ixfk_tasks_done_by");
    expect(afterDown).toContain("ixfk_shifts_previous_shift_id"); // nhóm D của 0051 còn
    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.migrationName)).toEqual(undone.reverse());
    expect(await ixfkNames()).toEqual(before);
  }, 120_000);

  it("đợi khoá quá 5 giây thì bỏ cuộc (lock_timeout), rollback sạch; không khoá thì áp được và trả lock_timeout về giá trị cũ", async () => {
    await downThrough(NAME);
    const base = await ixfkNames();
    const holder = new pg.Client({ connectionString: t.adminUrl });
    await holder.connect();
    await holder.query("begin");
    await holder.query("lock table tasks in access exclusive mode");
    try {
      // Đồng hồ canh 12 s: migration treo chờ khoá thì test đỏ rõ ràng thay vì treo cả lượt chạy.
      const guard = new Promise<string>((resolve) => setTimeout(() => resolve("TREO > 12s"), 12_000));
      const run = t.admin
        .transaction()
        .execute((trx) => m0060().up(trx))
        .then(
          () => "ÁP ĐƯỢC",
          (e: unknown) => String(e),
        );
      expect(await Promise.race([run, guard])).toMatch(/lock timeout/);
    } finally {
      await holder.query("rollback");
      await holder.end();
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await ixfkNames()).toEqual(base); // transaction hoàn tác, không để lại index dở
    const inside = await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('lock_timeout', '7s', true)`.execute(trx);
      await m0060().up(trx);
      return (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(trx)).rows[0]?.v;
    });
    expect(inside).toBe("7s");
    expect((await ixfkNames()).length).toBe(base.length + 52);
    // Đưa CSDL về trạng thái mới nhất cho các test sau (idempotent: bản ghi sổ chưa có 0060 nên migrateToLatest áp lại).
    const down = m0060().down;
    if (!down) throw new Error("0060 thiếu down");
    await t.admin.transaction().execute((trx) => down(trx));
    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
  }, 120_000);
});
