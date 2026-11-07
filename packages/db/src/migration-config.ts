// Only the migration entry point reads MIGRATION_DATABASE_URL; never fall back to a runtime connection.
export class MigrationCliError extends Error {
  readonly code: string;
  /** Chi tiết an toàn để in (tên migration, SQLSTATE) — không message/URL của CSDL (T-2618). */
  readonly details: Readonly<Record<string, string>>;
  constructor(code: string, details: Record<string, string> = {}) {
    super(code);
    this.name = "MigrationCliError";
    this.code = code;
    this.details = details;
  }
}

export interface MigrationConfig {
  readonly databaseUrl: string;
}

export function loadMigrationConfig(env: Record<string, string | undefined>): MigrationConfig {
  const value = env.MIGRATION_DATABASE_URL;
  if (!value) throw new MigrationCliError("MIGRATION_DATABASE_URL_REQUIRED");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new MigrationCliError("MIGRATION_DATABASE_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol) || u.pathname.length <= 1)
    throw new MigrationCliError("MIGRATION_DATABASE_URL_INVALID");
  // Match the driver semantics: query host overrides the URL host; duplicate TLS options are ambiguous.
  const hosts = u.searchParams.getAll("host");
  if (u.searchParams.has("hostaddr") || hosts.length > 1)
    throw new MigrationCliError("MIGRATION_DATABASE_URL_INVALID");
  if (hosts.length && (u.hostname !== "" || !hosts[0]?.startsWith("/")))
    throw new MigrationCliError("MIGRATION_DATABASE_URL_INVALID");
  if (!u.hostname && !hosts.length) throw new MigrationCliError("MIGRATION_DATABASE_URL_INVALID");
  if (env.NODE_ENV === "production") {
    const local = hosts.length === 1 || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    const modes = u.searchParams.getAll("sslmode");
    if (!local && (modes.length !== 1 || modes[0] !== "verify-full"))
      throw new MigrationCliError("MIGRATION_DATABASE_URL_TLS_REQUIRED");
  }
  const masked = () => ({ MIGRATION_DATABASE_URL: "***" });
  return Object.freeze(
    Object.defineProperties(
      { databaseUrl: value },
      {
        toJSON: { value: masked },
        toString: { value: () => JSON.stringify(masked()) },
        [Symbol.for("nodejs.util.inspect.custom")]: { value: masked },
      },
    ),
  );
}
