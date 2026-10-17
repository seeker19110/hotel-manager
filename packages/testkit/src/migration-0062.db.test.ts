// Migration 0062 (T-605, SPEC-access-and-property): trigger PROPERTY_IN_USE + hàm `app.invitation_by_token` + bảng `auth.revoked_session`.
// Kiểm: down (lùi theo sổ tới 0062) gỡ trigger/hàm/bảng mà GIỮ dữ liệu nghiệp vụ (cơ sở, đặt phòng); sau down đổi múi giờ cơ sở đã
// có dữ liệu được (chứng tỏ trigger đã gỡ); up lại dựng lại đúng và chặn lại; 0062 đứng sau 0060 trong sổ `migrations`/`kysely_migration`.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import { seedOrg, seedReservation } from "./factory.ts";

const NAME = "0062_access_property";
const PREV = "0060_fk_operator_indexes";
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const exists = async (q: string) =>
  (await sql<{ ok: boolean }>`select ${sql.raw(q)} is not null as ok`.execute(t.admin)).rows[0]?.ok === true;
const objects = async () => ({
  checkFn: await exists("to_regprocedure('app.check_property_not_in_use()')"),
  tokenFn: await exists("to_regprocedure('app.invitation_by_token(bytea)')"),
  table: await exists("to_regclass('auth.revoked_session')"),
  trigger:
    (
      await sql<{ n: number }>`select count(*)::int as n from pg_trigger
        where tgname = 'trg_properties_in_use' and not tgisinternal`.execute(t.admin)
    ).rows[0]?.n === 1,
});

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

describe("migration 0062 — truy cập & cơ sở", () => {
  it("up: có trigger, hai hàm và bảng auth.revoked_session; 0062 đứng SAU 0060 trong sổ migration (so thứ tự, không +1)", async () => {
    expect(await objects()).toEqual({ checkFn: true, tokenFn: true, table: true, trigger: true });
    const keys = Object.keys(migrations);
    expect(keys.indexOf(NAME)).toBeGreaterThan(keys.indexOf(PREV));
    expect(keys.indexOf(PREV)).toBeGreaterThanOrEqual(0);
    const ledger = (
      await sql<{ name: string }>`select name from kysely_migration order by name`.execute(t.admin)
    ).rows.map((r) => r.name);
    expect(ledger.indexOf(NAME)).toBeGreaterThan(ledger.indexOf(PREV));
    expect(ledger.indexOf(PREV)).toBeGreaterThanOrEqual(0);
  });

  it("down gỡ trigger + hàm + bảng nhưng GIỮ dữ liệu (cơ sở, đặt phòng); up lại dựng lại và chặn lại; sổ liền mạch", async () => {
    const org = await seedOrg(t.admin, "KS test migration 0062");
    await seedReservation(t.admin, { org, bookerPersonId: org.ownerPersonId });
    await expect(
      sql`update properties set timezone = 'Asia/Bangkok' where id = ${org.propertyId}`.execute(t.admin),
    ).rejects.toMatchObject({ hint: "PROPERTY_IN_USE" });

    const undone = await downThrough(NAME);
    expect(await objects()).toEqual({ checkFn: false, tokenFn: false, table: false, trigger: false });
    // Dữ liệu nghiệp vụ còn nguyên; không còn trigger nên đổi múi giờ cơ sở đã có đặt phòng được.
    const kept = await sql<{ p: number; r: number }>`
      select (select count(*)::int from properties where id = ${org.propertyId}) as p,
             (select count(*)::int from reservations where property_id = ${org.propertyId}) as r`.execute(
      t.admin,
    );
    expect(kept.rows[0]).toEqual({ p: 1, r: 1 });
    await sql`update properties set timezone = 'Asia/Bangkok' where id = ${org.propertyId}`.execute(t.admin);
    await sql`update properties set timezone = 'Asia/Ho_Chi_Minh' where id = ${org.propertyId}`.execute(
      t.admin,
    );

    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.migrationName)).toEqual(undone.reverse());
    expect(await objects()).toEqual({ checkFn: true, tokenFn: true, table: true, trigger: true });
    await expect(
      sql`update properties set timezone = 'Asia/Bangkok' where id = ${org.propertyId}`.execute(t.admin),
    ).rejects.toMatchObject({ hint: "PROPERTY_IN_USE" });
  }, 120_000);
});
