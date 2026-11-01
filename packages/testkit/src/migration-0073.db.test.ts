// Migration 0073 (T-2314, D-130/D-132): down gỡ sạch (cột plan, trigger hạn mức + guard INSERT, plan_limits, outbox_claim 2 tham số)
// và khôi phục `invitation_by_token` của 0062; `outbox_claim(integer)` của 0071 giữ nguyên cả khi up (expand → contract: worker N−1
// gọi một tham số vẫn chạy — job schema-compat); up lại đưa về trạng thái mới nhất.
import { createMigrator, migrations } from "@hm/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";

const NAME = "0073_plan_quotas_fair_share";
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const state = async () =>
  (
    await sql<{
      plan_col: boolean;
      claim2: boolean;
      claim1: boolean;
      limits: boolean;
      insert_guard: boolean;
      token_cols: string;
    }>`select
      exists (select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'plan') as plan_col,
      to_regprocedure('app.outbox_claim(integer, integer)') is not null as claim2,
      to_regprocedure('app.outbox_claim(integer)') is not null as claim1,
      to_regprocedure('app.plan_limits(text)') is not null as limits,
      exists (select 1 from pg_trigger where tgname = 'trg_organizations_plan_insert') as insert_guard,
      (select pg_get_function_result('app.invitation_by_token(bytea)'::regprocedure)) as token_cols`.execute(
      t.admin,
    )
  ).rows[0];

describe("migration 0073 — down/up", () => {
  it("down khôi phục trạng thái 0072; up lại đưa về mới nhất", async () => {
    expect(await state()).toMatchObject({
      plan_col: true,
      claim2: true,
      claim1: true,
      limits: true,
      insert_guard: true,
    });
    expect((await state())?.token_cols).toContain("plan text");
    // Revert later migrations in dependency order first: 0073 is not necessarily the latest schema.
    const later = Object.keys(migrations)
      .filter((name) => name > NAME)
      .sort();
    const migrator = createMigrator(t.admin);
    const target = await migrator.migrateTo(NAME);
    expect(target.error).toBeUndefined();
    expect(target.results?.map((result) => result.migrationName) ?? []).toEqual([...later].reverse());
    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe(NAME);
    const after = await state();
    expect(after).toMatchObject({
      plan_col: false,
      claim2: false,
      claim1: true,
      limits: false,
      insert_guard: false,
    });
    expect(after?.token_cols).not.toContain("plan");
    // Quyền giữ như 0062/0071.
    const grants = await sql<{ a: boolean; b: boolean }>`select
      has_function_privilege('app_runtime', 'app.invitation_by_token(bytea)', 'execute') as a,
      has_function_privilege('app_worker', 'app.outbox_claim(integer)', 'execute') as b`.execute(t.admin);
    expect(grants.rows[0]).toEqual({ a: true, b: true });
    const up = await createMigrator(t.admin).migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.map((result) => result.migrationName)).toEqual([NAME, ...later]);
    expect(await state()).toMatchObject({ plan_col: true, claim2: true, claim1: true, insert_guard: true });
  }, 120_000);

  it("tương thích N−1: worker cũ gọi `outbox_claim(p_limit)` một tham số vẫn chạy (không mơ hồ với hàm hai tham số)", async () => {
    // Hàm hai tham số không có DEFAULT ⇒ lời gọi một tham số chỉ khớp hàm của 0071; hai tham số khớp hàm mới.
    await expect(sql`select * from app.outbox_claim(10)`.execute(t.worker)).resolves.toBeDefined();
    await expect(sql`select * from app.outbox_claim(10, 10)`.execute(t.worker)).resolves.toBeDefined();
    const defaults = await sql<{ n: number }>`select pronargdefaults::int as n from pg_proc
      where oid = 'app.outbox_claim(integer, integer)'::regprocedure`.execute(t.admin);
    expect(defaults.rows[0]?.n).toBe(0);
  });
});
