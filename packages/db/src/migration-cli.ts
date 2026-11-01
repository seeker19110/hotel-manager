// Run: pnpm --filter @hm/db migrate status|up|down --to <applied migration> --confirm-down
// Config and preflight run before Migrator can create its lock/metadata tables. Output never includes connection/error text.
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { loadMigrationConfig, MigrationCliError } from "./migration-config.ts";
import { migrations } from "./migrations/index.ts";
import { createMigrator } from "./migrator.ts";

export type MigrationCommand = { action: "status" | "up" } | { action: "down"; to: string };

export function parseMigrationCommand(args: readonly string[]): MigrationCommand {
  if (args.length === 1 && (args[0] === "status" || args[0] === "up")) return { action: args[0] };
  if (args.length === 4 && args[0] === "down" && args[1] === "--to" && args[3] === "--confirm-down") {
    const to = args[2] as string;
    if (Object.hasOwn(migrations, to)) return { action: "down", to };
  }
  throw new MigrationCliError("USAGE: status | up | down --to <applied migration> --confirm-down");
}

/** Existing SECURITY DEFINER functions need an owner with BYPASSRLS. Application identities must never migrate. */
export async function assertMigrationRole(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) throw new MigrationCliError("MIGRATION_REQUIRES_AUTOCOMMIT");
  const r = await sql<{ allowed: boolean }>`select (
    current_user not in ('app_runtime', 'app_worker')
    and (r.rolsuper or r.rolbypassrls)
    and (r.rolsuper or exists (
      select 1 from pg_roles a where a.rolname in ('app_runtime', 'app_worker')
        and a.rolname = 'app_worker' and pg_has_role(current_user, a.oid, 'SET')))
    and has_database_privilege(current_database(), 'CREATE')
    and has_schema_privilege('public', 'CREATE')
    and not exists (
      select 1 from pg_namespace n where n.nspname in ('auth', 'app')
        and not has_schema_privilege(n.oid, 'CREATE'))
    and not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'auth', 'app') and c.relkind in ('r','p','v','m','S','f')
        and not pg_has_role(current_user, c.relowner, 'USAGE')
        and not exists (select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))
    and not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'auth', 'app') and not pg_has_role(current_user, p.proowner, 'USAGE')
        and not exists (select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))
  ) as allowed from pg_roles r where r.rolname = current_user`.execute(db);
  if (!r.rows[0]?.allowed) throw new MigrationCliError("MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED");
}

export async function executeMigrationCommand(db: Kysely<unknown>, command: MigrationCommand) {
  await assertMigrationRole(db);
  const migrator = createMigrator(db);
  const known = await migrator.getMigrations();
  if (command.action === "status")
    return {
      action: command.action,
      migrations: known.map((m) => ({ name: m.name, applied: !!m.executedAt })),
    };
  if (command.action === "down") {
    const target = known.findIndex((m) => m.name === command.to && m.executedAt);
    const current = known.findLastIndex((m) => m.executedAt);
    if (target < 0 || target >= current)
      throw new MigrationCliError("DOWN_TARGET_MUST_BE_EARLIER_APPLIED_MIGRATION");
  }
  const result =
    command.action === "down" ? await migrator.migrateTo(command.to) : await migrator.migrateToLatest();
  if (result.error) throw new MigrationCliError("MIGRATION_FAILED");
  return {
    action: command.action,
    migrations: (result.results ?? []).map((m) => ({
      name: m.migrationName,
      direction: m.direction,
      status: m.status,
    })),
  };
}

export async function migrationMain(
  args: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  output: { write: (line: string) => void } = process.stdout,
): Promise<number> {
  let db: Kysely<unknown> | undefined;
  try {
    const command = parseMigrationCommand(args);
    const config = loadMigrationConfig(env);
    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: config.databaseUrl,
          max: 1,
          connectionTimeoutMillis: 10_000,
          application_name: "hm-migrate",
        }),
      }),
    });
    output.write(`${JSON.stringify({ ok: true, ...(await executeMigrationCommand(db, command)) })}\n`);
    return 0;
  } catch (err) {
    output.write(
      `${JSON.stringify({ ok: false, code: err instanceof MigrationCliError ? err.code : "MIGRATION_CONNECTION_OR_DATABASE_ERROR" })}\n`,
    );
    return 1;
  } finally {
    await db?.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await migrationMain();
