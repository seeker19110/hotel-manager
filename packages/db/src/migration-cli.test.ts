// SPEC-runtime S-004/S-006/S-007: dedicated config, explicit commands, safe CLI errors.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { failureDetails, migrationMain, parseMigrationCommand } from "./migration-cli.ts";
import { loadMigrationConfig } from "./migration-config.ts";
import { migrations } from "./migrations/index.ts";

const NAME = Object.keys(migrations)[0] as string;
const URL_WITH_SECRET = "postgres://migration:private-password@localhost/hotel";

describe("migration-cli config and intent", () => {
  it("requires a dedicated URL, never falling back to runtime or worker credentials", () => {
    for (const env of [
      {},
      { DATABASE_URL: URL_WITH_SECRET },
      { WORKER_DATABASE_URL: URL_WITH_SECRET },
      { MIGRATION_DATABASE_URL: "" },
    ])
      expect(() => loadMigrationConfig(env)).toThrow("MIGRATION_DATABASE_URL_REQUIRED");
    const config = loadMigrationConfig({ MIGRATION_DATABASE_URL: URL_WITH_SECRET });
    expect(config.databaseUrl).toBe(URL_WITH_SECRET);
    for (const logged of [JSON.stringify(config), String(config), inspect(config)]) {
      expect(logged).not.toContain("private-password");
      expect(logged).not.toContain("postgres://");
      expect(logged).toContain("***");
    }
  });

  it.each([
    "not a URL",
    "https://u:secret@db/hotel",
    "postgres://localhost",
    "postgres:///hotel",
    "postgres://localhost/hotel?host=remote",
    "postgres:///hotel?host=remote",
    "postgres:///hotel?host=/tmp&host=/var/run",
    "postgres://localhost/hotel?hostaddr=10.0.0.1",
  ])("rejects invalid or driver-ambiguous URL without exposing it: %s", (url) => {
    expect(() => loadMigrationConfig({ MIGRATION_DATABASE_URL: url })).toThrow(
      "MIGRATION_DATABASE_URL_INVALID",
    );
  });

  it.each([
    "postgres://db/hotel",
    "postgres://db/hotel?sslmode=require",
    "postgres://db/hotel?sslmode=verify-full&sslmode=disable",
  ])("production remote DB must verify TLS: %s", (url) => {
    expect(() => loadMigrationConfig({ MIGRATION_DATABASE_URL: url, NODE_ENV: "production" })).toThrow(
      "MIGRATION_DATABASE_URL_TLS_REQUIRED",
    );
  });

  it.each([
    "postgres://db/hotel?sslmode=verify-full",
    "postgres://localhost/hotel",
    "postgres://127.0.0.1/hotel",
    "postgres://[::1]/hotel",
    "postgres:///hotel?host=/var/run/postgresql",
  ])("accepts verified remote TLS or explicit local transport: %s", (url) => {
    expect(loadMigrationConfig({ MIGRATION_DATABASE_URL: url, NODE_ENV: "production" }).databaseUrl).toBe(
      url,
    );
  });

  it("status/up are explicit; down requires a known target and confirmation", () => {
    expect(parseMigrationCommand(["status"])).toEqual({ action: "status" });
    expect(parseMigrationCommand(["up"])).toEqual({ action: "up" });
    expect(parseMigrationCommand(["down", "--to", NAME, "--confirm-down"])).toEqual({
      action: "down",
      to: NAME,
    });
    for (const args of [
      [],
      ["down"],
      ["up", "extra"],
      ["down", "--to", NAME],
      ["down", "--to", "NO_MIGRATIONS", "--confirm-down"],
      ["down", "--to", "__proto__", "--confirm-down"],
    ])
      expect(() => parseMigrationCommand(args)).toThrow("USAGE:");
  });

  it("CLI exits nonzero and emits only safe structured errors on invalid args or config", async () => {
    const lines: string[] = [];
    const out = {
      write: (line: string) => {
        lines.push(line);
      },
    };
    expect(await migrationMain([], { MIGRATION_DATABASE_URL: URL_WITH_SECRET }, out)).toBe(1);
    expect(await migrationMain(["status"], {}, out)).toBe(1);
    expect(
      await migrationMain(["up"], { MIGRATION_DATABASE_URL: "https://u:private-password@db/hotel" }, out),
    ).toBe(1);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ ok: false });
      expect(line).not.toContain("private-password");
      expect(line).not.toContain("postgres://");
    }
  });

  it("T-2618 (AUD-CODE-003): MIGRATION_FAILED kèm tên migration lỗi + SQLSTATE, không message/URL", () => {
    const err = Object.assign(new Error("check constraint violated at postgres://u:secret@h/db"), {
      code: "23514",
      severity: "ERROR",
    });
    const details = failureDetails({
      error: err,
      results: [
        { migrationName: "0071_org_background_active_only", status: "Success" },
        { migrationName: "0072_support_access", status: "Error" },
        { migrationName: "0073_plan_quotas_fair_share", status: "NotExecuted" },
      ],
    });
    expect(details).toEqual({ migration: "0072_support_access", sqlstate: "23514" });
    expect(JSON.stringify(details)).not.toContain("secret");
    expect(failureDetails({ error: Object.assign(new Error("x"), { code: "ECONNRESET" }) })).toEqual({});
    // errno 5 chữ của Node không phải SQLSTATE (review 🟢3).
    expect(failureDetails({ error: Object.assign(new Error("x"), { code: "EPIPE" }) })).toEqual({});
    expect(failureDetails({ error: new Error("x"), results: [] })).toEqual({});
  });
});
