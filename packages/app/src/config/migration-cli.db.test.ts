// SPEC-runtime S-005/S-006/S-007: privileges before DDL and actual migration/rollback on PostgreSQL.
import { randomUUID } from "node:crypto";
import { createTestDb, seedOrg, type TestDb } from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertMigrationRole,
  executeMigrationCommand,
  migrationMain,
} from "../../../db/src/migration-cli.ts";
import { migrations } from "../../../db/src/migrations/index.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.drop();
});

const catalog = (db: TestDb) =>
  sql`select n.nspname, c.relname, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','auth','app') order by 1, 2`.execute(db.admin);

describe("migration-cli real PostgreSQL preflight", () => {
  it.each(["runtime", "worker"] as const)(
    "%s fails before metadata DDL even when lock tables are absent",
    async (role) => {
      const isolated = await createTestDb();
      try {
        await sql`drop table kysely_migration, kysely_migration_lock`.execute(isolated.admin);
        const before = await catalog(isolated);
        await expect(executeMigrationCommand(isolated[role], { action: "up" })).rejects.toThrow(
          "MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED",
        );
        expect((await catalog(isolated)).rows).toEqual(before.rows);
        const tables = await sql`select to_regclass('public.kysely_migration') as a,
        to_regclass('public.kysely_migration_lock') as b`.execute(isolated.admin);
        expect(tables.rows).toEqual([{ a: null, b: null }]);
      } finally {
        await isolated.drop();
      }
    },
  );

  it("a BYPASSRLS role that does not own the existing schema cannot migrate", async () => {
    const role = `hm_migration_${randomUUID().replaceAll("-", "")}`;
    await sql`create role ${sql.id(role)} nologin bypassrls`.execute(t.admin);
    try {
      await sql`grant create on database ${sql.id(t.name)} to ${sql.id(role)}`.execute(t.admin);
      await sql`grant usage, create on schema public to ${sql.id(role)}`.execute(t.admin);
      await t.admin.connection().execute(async (conn) => {
        await sql`set role ${sql.id(role)}`.execute(conn);
        try {
          await expect(assertMigrationRole(conn)).rejects.toThrow("MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED");
        } finally {
          await sql`reset role`.execute(conn);
        }
      });
    } finally {
      await sql`drop owned by ${sql.id(role)}`.execute(t.admin);
      await sql`drop role ${sql.id(role)}`.execute(t.admin);
    }
  });

  it("a dedicated non-superuser owner can bootstrap and migrate only after SET ROLE app_worker is granted", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const role = `hm_migrate_${suffix}`;
    const name = `hm_migrate_${suffix}`;
    await sql`create role ${sql.id(role)} nologin nosuperuser bypassrls`.execute(t.admin);
    await sql`create database ${sql.id(name)} owner ${sql.id(role)} template template0`.execute(t.admin);
    const url = new URL(t.adminUrl);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 1 });
    const clientEnds: Promise<void>[] = [];
    pool.on("connect", (client) => {
      clientEnds.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool }),
    });
    try {
      await db.connection().execute(async (conn) => {
        await sql`set role ${sql.id(role)}`.execute(conn);
        try {
          await expect(executeMigrationCommand(conn, { action: "up" })).rejects.toThrow(
            "MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED",
          );
          const absent = await sql`select to_regclass('public.kysely_migration') as metadata`.execute(conn);
          expect(absent.rows).toEqual([{ metadata: null }]);
        } finally {
          await sql`reset role`.execute(conn);
        }
      });
      await sql`grant app_worker to ${sql.id(role)}`.execute(t.admin);
      await db.connection().execute(async (conn) => {
        await sql`set role ${sql.id(role)}`.execute(conn);
        try {
          await expect(assertMigrationRole(conn)).resolves.toBeUndefined();
          const up = await executeMigrationCommand(conn, { action: "up" });
          expect(up.migrations.map((m) => m.name)).toEqual(Object.keys(migrations));
          expect(up.migrations.every((m) => "status" in m && m.status === "Success")).toBe(true);
          const owner =
            await sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'`.execute(
              conn,
            );
          expect(owner.rows).toEqual([{ owner: "app_worker" }]);
          await expect(assertMigrationRole(conn)).resolves.toBeUndefined();
        } finally {
          await sql`reset role`.execute(conn);
        }
      });
    } finally {
      await db.destroy();
      // pg-pool removes idle clients from its list before their TCP shutdown finishes, so pool.end()/destroy()
      // can resolve first. Wait for the actual client ends and backend cleanup before removing the fixture DB.
      // FORCE here can otherwise kill a client still closing and emit an unhandled 57P01 after the test passed.
      await Promise.all(clientEnds);
      await expect
        .poll(
          async () => {
            const active = await sql<{ n: number }>`select count(*)::int as n
          from pg_stat_activity where datname = ${name}`.execute(t.admin);
            return active.rows[0]?.n;
          },
          { timeout: 5_000, interval: 50 },
        )
        .toBe(0);
      await sql`drop database ${sql.id(name)}`.execute(t.admin);
      await sql`drop role ${sql.id(role)}`.execute(t.admin);
    }
  }, 120_000);

  it("refuses an outer transaction before migration can escape its preflight", async () => {
    await t.admin.transaction().execute(async (trx) => {
      await expect(executeMigrationCommand(trx, { action: "up" })).rejects.toThrow(
        "MIGRATION_REQUIRES_AUTOCOMMIT",
      );
    });
  });

  it("status and up use the owner, report known names, and a repeated up has no work", async () => {
    await expect(assertMigrationRole(t.admin)).resolves.toBeUndefined();
    const status = await executeMigrationCommand(t.admin, { action: "status" });
    expect(status.migrations.map((m) => m.name)).toEqual(Object.keys(migrations));
    expect(status.migrations.every((m) => "applied" in m && m.applied)).toBe(true);
    expect(await executeMigrationCommand(t.admin, { action: "up" })).toEqual({
      action: "up",
      migrations: [],
    });
  });

  it("explicit down targets must be earlier applied versions; valid down can be brought up again", async () => {
    const all = Object.keys(migrations);
    await expect(executeMigrationCommand(t.admin, { action: "down", to: "missing" })).rejects.toThrow(
      "DOWN_TARGET_MUST_BE_EARLIER_APPLIED_MIGRATION",
    );
    await expect(
      executeMigrationCommand(t.admin, { action: "down", to: all.at(-1) as string }),
    ).rejects.toThrow("DOWN_TARGET_MUST_BE_EARLIER_APPLIED_MIGRATION");
    try {
      const down = await executeMigrationCommand(t.admin, { action: "down", to: all.at(-2) as string });
      expect(down.migrations).toEqual([{ name: all.at(-1), direction: "Down", status: "Success" }]);
      await expect(
        executeMigrationCommand(t.admin, { action: "down", to: all.at(-1) as string }),
      ).rejects.toThrow("DOWN_TARGET_MUST_BE_EARLIER_APPLIED_MIGRATION");
    } finally {
      await executeMigrationCommand(t.admin, { action: "up" });
    }
  });

  it("T-2618 (AUD-DATA-011): down qua 0072 bị từ chối khi còn dữ liệu platform_support — không mất lý do cấp quyền, up lại được", async () => {
    const isolated = await createTestDb();
    try {
      const seeded = await seedOrg(isolated.admin, "Trọ hỗ trợ");
      const org = seeded.orgId;
      const person = randomUUID();
      await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org}, 'Hỗ trợ')`.execute(
        isolated.admin,
      );
      await sql`insert into memberships (id, organization_id, person_id, role, all_properties, valid_from, valid_to, support_reason)
        values (${randomUUID()}, ${org}, ${person}, 'platform_support', true, now(), now() + interval '24 hours', 'Phiếu')`.execute(
        isolated.admin,
      );
      const before = await sql<{ n: number }>`select count(*)::int as n from kysely_migration`.execute(
        isolated.admin,
      );
      await expect(
        executeMigrationCommand(isolated.admin, { action: "down", to: "0071_org_background_active_only" }),
      ).rejects.toThrow("DOWN_BLOCKED_SUPPORT_DATA");
      const after = await sql<{ n: number }>`select count(*)::int as n from kysely_migration`.execute(
        isolated.admin,
      );
      expect(after.rows).toEqual(before.rows);
      // Đích là chính 0072 (0072 không bị down) ⇒ không chặn dù còn dữ liệu hỗ trợ.
      await expect(
        executeMigrationCommand(isolated.admin, { action: "down", to: "0072_support_access" }),
      ).resolves.toMatchObject({ action: "down" });
      await executeMigrationCommand(isolated.admin, { action: "up" });
      // Chỉ còn lời mời platform_support (không membership) ⇒ vẫn chặn.
      await sql`delete from memberships where role = 'platform_support'`.execute(isolated.admin);
      await sql`insert into invitations (id, organization_id, email, role, token_hash, expires_at, invited_by, support_reason)
        values (${randomUUID()}, ${org}, 'ho-tro@example.test', 'platform_support', ${Buffer.alloc(32, 7)},
                now() + interval '24 hours', ${seeded.ownerMembershipId}, 'Phiếu')`.execute(isolated.admin);
      await expect(
        executeMigrationCommand(isolated.admin, { action: "down", to: "0071_org_background_active_only" }),
      ).rejects.toThrow("DOWN_BLOCKED_SUPPORT_DATA");
      // Không còn dữ liệu hỗ trợ ⇒ down qua 0072 được, rồi up lại sạch.
      await sql`delete from invitations where role = 'platform_support'`.execute(isolated.admin);
      await expect(
        executeMigrationCommand(isolated.admin, { action: "down", to: "0071_org_background_active_only" }),
      ).resolves.toMatchObject({ action: "down" });
      await expect(executeMigrationCommand(isolated.admin, { action: "up" })).resolves.toMatchObject({
        action: "up",
      });
    } finally {
      await isolated.drop();
    }
  });

  it("CLI uses its dedicated URL and never prints passwords or raw database errors", async () => {
    const lines: string[] = [];
    const out = {
      write: (line: string) => {
        lines.push(line);
      },
    };
    expect(await migrationMain(["status"], { MIGRATION_DATABASE_URL: t.adminUrl }, out)).toBe(0);
    expect(
      await migrationMain(["up"], { MIGRATION_DATABASE_URL: t.runtimeUrl, DATABASE_URL: t.adminUrl }, out),
    ).toBe(1);
    const unreachable = new URL(t.adminUrl);
    unreachable.password = "do-not-print-this-password";
    unreachable.pathname = `/missing_${randomUUID()}`;
    expect(await migrationMain(["status"], { MIGRATION_DATABASE_URL: unreachable.href }, out)).toBe(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: true, action: "status" });
    expect(JSON.parse(lines[1] as string)).toEqual({
      ok: false,
      code: "MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED",
    });
    expect(JSON.parse(lines[2] as string)).toEqual({
      ok: false,
      code: "MIGRATION_CONNECTION_OR_DATABASE_ERROR",
    });
    for (const line of lines) {
      expect(line).not.toContain("do-not-print-this-password");
      expect(line).not.toContain("postgres://");
      expect(line).not.toContain(unreachable.pathname.slice(1));
    }
  });
});
