// Migration 0061 (T-604, SPEC-inventory S-017): hàm worker `app.stays_overdue` — `down` gỡ đúng hàm (lùi theo sổ, không đếm cứng),
// `up` dựng lại; chỉ vai trò app_worker được gọi (hàm SECURITY DEFINER đọc xuyên tổ chức, phạm vi hẹp).
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import { seedOrg } from "./factory.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const fnExists = async () =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from pg_proc where oid = to_regprocedure('app.stays_overdue(timestamptz)')`.execute(
      t.admin,
    )
  ).rows[0]?.n;

describe("migration 0061 — app.stays_overdue", () => {
  it("up: hàm có mặt; worker gọi được (trả hàng rỗng khi chưa có lượt ở); runtime không có quyền thực thi", async () => {
    expect(await fnExists()).toBe(1);
    const r = await sql`select * from app.stays_overdue(now())`.execute(t.worker);
    expect(r.rows).toEqual([]);
    await expect(sql`select * from app.stays_overdue(now())`.execute(t.runtime)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("down (lùi theo sổ tới 0061) gỡ hàm và giữ nguyên dữ liệu; up lại dựng lại hàm; 0061 đứng sau 0060 trong sổ", async () => {
    const org = await seedOrg(t.admin, "KS lùi 0061");
    const m = createMigrator(t.admin);
    for (let guard = 0; guard < 50; guard++) {
      const r = await m.migrateDown();
      expect(r.error).toBeUndefined();
      if (r.results?.[0]?.migrationName === "0061_stays_overdue") break;
    }
    expect(await fnExists()).toBe(0);
    await expect(sql`select * from app.stays_overdue(now())`.execute(t.worker)).rejects.toMatchObject({
      code: "42883", // hàm không còn
    });
    const kept = await sql<{
      n: number;
    }>`select count(*)::int as n from properties where id = ${org.propertyId}`.execute(t.admin);
    expect(kept.rows[0]?.n).toBe(1);

    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.[0]?.migrationName).toBe("0061_stays_overdue");
    expect(await fnExists()).toBe(1);
    expect((await sql`select * from app.stays_overdue(now())`.execute(t.worker)).rows).toEqual([]);
    const keys = Object.keys(migrations);
    expect(keys.indexOf("0061_stays_overdue")).toBe(keys.indexOf("0060_fk_operator_indexes") + 1);
  });
});
