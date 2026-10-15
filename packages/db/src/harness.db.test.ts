// Kiểm chính bộ chạy test DB: Postgres 17, role ứng dụng không có đặc quyền vượt RLS.
import { createTestDb, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

describe("harness DB", () => {
  it("chạy PostgreSQL 17", async () => {
    const r = await sql<{ v: string }>`select current_setting('server_version_num') as v`.execute(t.admin);
    expect(Number(r.rows[0]?.v)).toBeGreaterThanOrEqual(170000);
    expect(Number(r.rows[0]?.v)).toBeLessThan(180000);
  });

  it("app_runtime/app_worker: không superuser, không BYPASSRLS (INV-G1)", async () => {
    const r = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_runtime','app_worker') order by rolname`.execute(
      t.admin,
    );
    expect(r.rows).toEqual([
      { rolname: "app_runtime", rolsuper: false, rolbypassrls: false },
      { rolname: "app_worker", rolsuper: false, rolbypassrls: false },
    ]);
  });

  it("kết nối runtime chạy dưới role app_runtime", async () => {
    const r = await sql<{ u: string }>`select current_user as u`.execute(t.runtime);
    expect(r.rows[0]?.u).toBe("app_runtime");
  });
});
