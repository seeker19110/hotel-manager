// Server cho E2E (playwright.config.ts → webServer): Postgres 17 (TEST_DATABASE_URL hoặc cluster tạm của testkit) →
// role → migrate → seed giả → `next start`. Dừng (SIGTERM) thì xoá DB/cluster tạm. Chạy bằng `node` (bỏ kiểu TS).
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createAuth } from "@hm/app";
import { migrateToLatest } from "@hm/db";
import { bootstrapRoles, type PgCluster, pgUrl, seedOrg, startPgCluster } from "@hm/testkit/setup";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { MAIN_ROOMS, ORG_MAIN, ORG_OTHER, OTHER_ROOMS, SMOKE_USER } from "./fixtures.ts";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function kysely(url: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 2 }) }),
  });
}

async function addUnits(
  db: Kysely<unknown>,
  orgId: string,
  propertyId: string,
  floorId: string,
  codes: string[],
) {
  for (const code of codes) {
    await sql`insert into units (id, organization_id, property_id, floor_id, code)
              values (${randomUUID()}, ${orgId}, ${propertyId}, ${floorId}, ${code})`.execute(db);
  }
}

async function addStaff(db: Kysely<unknown>, orgId: string, authUserId: string, propertyId: string) {
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email)
            values (${person}, ${orgId}, ${SMOKE_USER.name}, ${SMOKE_USER.email})`.execute(db);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${orgId}, ${authUserId}, ${person}, 'housekeeping')`.execute(db);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${orgId}, ${membership}, ${propertyId})`.execute(db);
}

async function seed(adminUrl: string, runtimeUrl: string, secret: string): Promise<void> {
  const db = kysely(adminUrl);
  const { auth, close } = createAuth({
    databaseUrl: runtimeUrl,
    secret,
    baseURL: BASE_URL,
    ipRateLimit: false,
  });
  try {
    const { user } = await auth.api.signUpEmail({ body: SMOKE_USER });
    const main = await seedOrg(db, ORG_MAIN, "hotel");
    await addUnits(
      db,
      main.orgId,
      main.propertyId,
      main.floorId,
      MAIN_ROOMS.filter((c) => c !== "101"),
    );
    const cs2 = randomUUID();
    const floor2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template)
              values (${cs2}, ${main.orgId}, ${`${ORG_MAIN} — CS2`}, 'hotel')`.execute(db);
    await sql`insert into floors (id, organization_id, property_id, name)
              values (${floor2}, ${main.orgId}, ${cs2}, 'Tầng 2')`.execute(db);
    await addUnits(db, main.orgId, cs2, floor2, OTHER_ROOMS);
    await addStaff(db, main.orgId, user.id, main.propertyId);
    const other = await seedOrg(db, ORG_OTHER, "rental");
    await addStaff(db, other.orgId, user.id, other.propertyId);
  } finally {
    await close();
    await db.destroy();
  }
}

let cluster: PgCluster | undefined;
if (!process.env.TEST_DATABASE_URL) cluster = await startPgCluster();
const serverUrl = process.env.TEST_DATABASE_URL ?? (cluster as PgCluster).adminUrl;
const dbName = `hm_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = kysely(serverUrl);
await bootstrapRoles(admin);
await sql.raw(`CREATE DATABASE ${dbName}`).execute(admin);
await admin.destroy();

const adminUrl = pgUrl(serverUrl, dbName);
const runtimeUrl = pgUrl(serverUrl, dbName, "app_runtime");
const migrator = kysely(adminUrl);
await migrateToLatest(migrator);
await migrator.destroy();
// Bí mật phiên chỉ sống trong tiến trình E2E này.
const secret = randomBytes(32).toString("base64url");
await seed(adminUrl, runtimeUrl, secret);

const next = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    APP_BASE_URL: BASE_URL,
    DATABASE_URL: runtimeUrl,
    BETTER_AUTH_SECRET: secret,
    // Smoke không dùng object storage; giá trị giả chỉ để qua validate cấu hình.
    S3_ENDPOINT: "http://127.0.0.1:9/",
    S3_BUCKET: "hm-e2e",
    S3_ACCESS_KEY_ID: "e2e",
    S3_SECRET_ACCESS_KEY: "e2e-khong-dung",
  },
});

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  next.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  try {
    const s = kysely(serverUrl);
    await sql.raw(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).execute(s);
    await s.destroy();
  } catch {
    // cluster tạm bị dừng cùng lúc — thư mục tạm sẽ bị xoá ngay sau
  }
  cluster?.stop();
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
next.on("exit", (code) => void stop(code ?? 1));
