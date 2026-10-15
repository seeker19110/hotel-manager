import type { Kysely } from "kysely";
import { type MigrationResultSet, Migrator } from "kysely/migration";
import { migrations } from "./migrations/index.ts";

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: "kysely_migration",
    migrationLockTableName: "kysely_migration_lock",
  });
}

function unwrap(result: MigrationResultSet): void {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === "Error");
    throw new Error(`Migration lỗi${failed ? ` ở ${failed.migrationName}` : ""}: ${String(result.error)}`);
  }
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<void> {
  unwrap(await createMigrator(db).migrateToLatest());
}

/** Lùi hết migration (kiểm `down` chạy được — DB-MIG-009). */
export async function migrateDownAll(db: Kysely<unknown>): Promise<void> {
  const migrator = createMigrator(db);
  for (;;) {
    const res = await migrator.migrateDown();
    unwrap(res);
    if (!res.results || res.results.length === 0) return;
  }
}
