// Migration 0048 tạo index trên bảng lớn nhất hệ thống: phải KHÔNG xếp hàng vô hạn sau một khoá bảng (RK-021) và không để
// `lock_timeout` rò sang các migration chạy sau trong cùng transaction của migrator Kysely.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";

const NAME = "0048_fk_indexes_and_autovacuum";
const m0048 = () => {
  const m = migrations[NAME];
  if (!m) throw new Error(`thiếu migration ${NAME}`);
  return m;
};
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  // Lùi MỌI migration mới hơn 0048 (kiểm luôn `down` của chúng) rồi tới 0048, để áp lại 0048 theo ý. Lấy danh sách từ sổ migration
  // (không gõ cứng) — thêm migration mới không làm test này đỏ.
  const newer = Object.keys(migrations)
    .filter((k) => k > NAME)
    .sort()
    .reverse();
  for (const expected of [...newer, NAME]) {
    const res = await createMigrator(t.admin).migrateDown();
    expect(res.error).toBeUndefined();
    expect(res.results?.[0]?.migrationName).toBe(expected);
  }
}, 120_000);
afterAll(async () => {
  await t.drop();
});

const ixfk = async () =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from pg_indexes where schemaname = 'public' and indexname like 'ixfk\\_%'`.execute(
      t.admin,
    )
  ).rows[0]?.n;

describe("migration 0048 — khoá bảng", () => {
  it("down gỡ hết ixfk_* (khớp phần up)", async () => {
    expect(await ixfk()).toBe(0);
  });

  it("đợi khoá quá 5 giây thì bỏ cuộc (lock_timeout), không treo vô hạn; rollback sạch", async () => {
    const holder = new pg.Client({ connectionString: t.adminUrl });
    await holder.connect();
    await holder.query("begin");
    await holder.query("lock table payments in access exclusive mode");
    const started = Date.now();
    try {
      // Đồng hồ canh 12 s: nếu migration treo chờ khoá, test đỏ rõ ràng thay vì treo cả lượt chạy (khoá nhả ở finally).
      const guard = new Promise<string>((resolve) => setTimeout(() => resolve("TREO > 12s"), 12_000));
      const run = t.admin
        .transaction()
        .execute((trx) => m0048().up(trx))
        .then(
          () => "ÁP ĐƯỢC",
          (e: unknown) => String(e),
        );
      expect(await Promise.race([run, guard])).toMatch(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(12_000);
    } finally {
      await holder.query("rollback");
      await holder.end();
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await ixfk()).toBe(0); // transaction hoàn tác, không để lại index dở
  }, 30_000);

  it("không khoá thì áp được và trả lock_timeout về giá trị cũ cho migration sau trong cùng transaction", async () => {
    const before = await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(t.admin);
    const inside = await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('lock_timeout', '7s', true)`.execute(trx);
      await m0048().up(trx);
      return (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(trx)).rows[0]?.v;
    });
    expect(inside).toBe("7s");
    expect(before.rows[0]?.v).toBe("0");
    expect(await ixfk()).toBeGreaterThan(0);
  });
});
