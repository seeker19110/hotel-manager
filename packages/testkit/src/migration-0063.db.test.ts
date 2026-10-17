// Migration 0063 (T-709, OPS-COST-004): bảng `email_budget_days` + hàm `app.email_budget_take`/`app.email_budget_metrics`.
// Kiểm: down (lùi theo sổ tới 0063) gỡ bảng + hàm mà GIỮ dữ liệu nghiệp vụ; up lại dựng lại và hàm chạy đúng; 0063 đứng sau 0062.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import { seedOrg } from "./factory.ts";

const NAME = "0063_email_budget";
const PREV = "0062_access_property";
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
  table: await exists("to_regclass('public.email_budget_days')"),
  take: await exists(
    "to_regprocedure('app.email_budget_take(uuid, timestamptz, integer, integer, integer, boolean)')",
  ),
  metrics: await exists("to_regprocedure('app.email_budget_metrics(timestamptz, integer)')"),
});

describe("migration 0063 — ngân sách email ngày", () => {
  it("up: có bảng + 2 hàm; RLS bật + FORCE; 0063 đứng liền sau 0062 trong sổ", async () => {
    expect(await objects()).toEqual({ table: true, take: true, metrics: true });
    const rls = await sql<{ rls: boolean; force: boolean }>`
      select relrowsecurity as rls, relforcerowsecurity as force from pg_class where oid = 'public.email_budget_days'::regclass`.execute(
      t.admin,
    );
    expect(rls.rows[0]).toEqual({ rls: true, force: true });
    const keys = Object.keys(migrations);
    expect(keys.indexOf(NAME)).toBe(keys.indexOf(PREV) + 1);
  });

  it("down gỡ bảng + hàm, GIỮ dữ liệu nghiệp vụ; up lại dựng lại và hàm chạy đúng (ngày UTC, quyết định)", async () => {
    const org = await seedOrg(t.admin, "KS lùi 0063");
    const take = (now: string) =>
      sql<{ decision: string; used: number; level: number; crossed: boolean }>`
        select * from app.email_budget_take(${org.orgId}, ${now}::timestamptz, 10, 80, 90, false)`.execute(
        t.worker,
      );
    expect((await take("2026-10-16T23:59:59Z")).rows[0]).toEqual({
      decision: "send",
      used: 1,
      level: 0,
      crossed: false,
    });

    let undone: string | undefined;
    for (let i = 0; i < 50 && undone !== NAME; i++) {
      const res = await createMigrator(t.admin).migrateDown();
      expect(res.error).toBeUndefined();
      undone = res.results?.[0]?.migrationName;
    }
    expect(undone).toBe(NAME);
    expect(await objects()).toEqual({ table: false, take: false, metrics: false });
    const kept = await sql<{
      n: number;
    }>`select count(*)::int as n from properties where id = ${org.propertyId}`.execute(t.admin);
    expect(kept.rows[0]?.n).toBe(1);

    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.migrationName)).toContain(NAME);
    expect(await objects()).toEqual({ table: true, take: true, metrics: true });
    // Ranh giới ngày UTC: 23:59:59 và 00:00:00 hôm sau là hai bộ đếm riêng (bảng mới rỗng sau up).
    expect((await take("2026-10-16T23:59:59Z")).rows[0]?.used).toBe(1);
    expect((await take("2026-10-17T00:00:00Z")).rows[0]?.used).toBe(1);
    expect((await take("2026-10-17T00:00:01Z")).rows[0]?.used).toBe(2);
  });
});
