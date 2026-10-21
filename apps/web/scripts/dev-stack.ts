// Môi trường DEV một lệnh (`pnpm dev:up`): Postgres 17 BỀN ở `.dev/pg` (giữ dữ liệu giữa các lần chạy) → role → migrate →
// seed dữ liệu giả MỘT lần → S3/clamd giả → `next dev` (+ worker khi có `--worker`). Không dùng dữ liệu thật, không gọi
// dịch vụ ngoài; thư OTP ghi vào hộp thư giả `.dev/outbox.jsonl`. Xoá sạch: `pnpm dev:up --reset`.
// Mã TOTP hiện tại của chủ khách sạn giả: `pnpm dev:up --totp`. Chạy bằng `node` (Node 24 bỏ kiểu TS).
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAuth, loadConfig } from "@hm/app";
import { migrateToLatest } from "@hm/db";
import { asPg, bootstrapRoles, PG_BIN, pgUrl } from "@hm/testkit/setup";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { startFakeClamd, startFakeS3 } from "../e2e/fakes.ts";
import { HOTEL_HK, HOTEL_OWNER, ORG_HOTEL, ORG_PORTAL, PORTAL_TENANT } from "../e2e/fixtures.ts";
import { seedHotelOrg } from "../e2e/hotel-seed.ts";
import { seedPortal } from "../e2e/portal-seed.ts";
import { hotelTotpFile, totp } from "../e2e/totp.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const DEV_DIR = join(ROOT, ".dev");
const PG_DIR = join(DEV_DIR, "pg");
const PG_DATA = join(PG_DIR, "data");
const SECRETS = join(DEV_DIR, "secrets.json");
const ACCOUNTS = join(DEV_DIR, "accounts.json");
const OUTBOX = join(DEV_DIR, "outbox.jsonl");
const PG_PORT = Number(process.env.DEV_PG_PORT ?? 54329);
const PORT = Number(process.env.DEV_PORT ?? 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = "hm_dev";
const args = new Set(process.argv.slice(2));
const isRoot = process.getuid?.() === 0;

function kysely(url: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 2 }) }),
  });
}

/** Thư mục cluster thuộc user `postgres` khi chạy dưới root (initdb/pg_ctl từ chối root). */
function ownByPostgres(path: string): void {
  if (!isRoot) return;
  const id = (flag: string) => Number(execFileSync("id", [flag, "postgres"], { encoding: "utf8" }).trim());
  chownSync(path, id("-u"), id("-g"));
}

function pgRunning(): boolean {
  try {
    asPg(join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "status"]);
    return true;
  } catch {
    return false;
  }
}

function startPg(): void {
  mkdirSync(PG_DIR, { recursive: true, mode: 0o700 });
  // user `postgres` cần đi qua `.dev/` (chỉ quyền x — không liệt kê/đọc được bí mật 0600 bên trong).
  if (isRoot) chmodSync(DEV_DIR, 0o711);
  ownByPostgres(PG_DIR);
  if (!existsSync(join(PG_DATA, "PG_VERSION"))) {
    asPg(join(PG_BIN, "initdb"), [
      "-D",
      PG_DATA,
      "-U",
      "postgres",
      "--auth=trust",
      "-E",
      "UTF8",
      "--locale=C.UTF-8",
    ]);
  }
  if (pgRunning()) return;
  const opts = [
    `-p ${PG_PORT}`,
    "-c listen_addresses=127.0.0.1",
    `-c unix_socket_directories=${PG_DIR}`,
  ].join(" ");
  asPg(join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "-o", opts, "-w", "-l", join(PG_DIR, "log"), "start"]);
}

function stopPg(): void {
  if (existsSync(join(PG_DATA, "PG_VERSION")) && pgRunning())
    asPg(join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "-m", "fast", "-w", "stop"]);
}

interface Secrets {
  betterAuth: string;
}
function secrets(): Secrets {
  if (existsSync(SECRETS)) return JSON.parse(readFileSync(SECRETS, "utf8")) as Secrets;
  const s: Secrets = { betterAuth: randomBytes(32).toString("base64url") };
  writeFileSync(SECRETS, JSON.stringify(s), { mode: 0o600 });
  return s;
}

interface Accounts {
  hotelOwner: { email: string; password: string; totpSecret: string };
  hotelHousekeeping: { email: string; password: string };
  portalTenant: { email: string };
}

async function seedOnce(adminUrl: string, runtimeUrl: string, secret: string): Promise<void> {
  const db = kysely(adminUrl);
  const { auth, close } = createAuth({
    databaseUrl: runtimeUrl,
    secret,
    baseURL: BASE_URL,
    ipRateLimit: false,
  });
  try {
    const n = await sql<{ n: number }>`select count(*)::int as n from organizations`.execute(db);
    if ((n.rows[0]?.n ?? 0) > 0) return;
    console.log("[dev] seed dữ liệu giả lần đầu…");
    await seedHotelOrg(db, auth, PORT);
    await seedPortal(db);
    const totpSecret = (JSON.parse(readFileSync(hotelTotpFile(PORT), "utf8")) as { secret: string }).secret;
    rmSync(hotelTotpFile(PORT), { force: true });
    const accounts: Accounts = {
      hotelOwner: { email: HOTEL_OWNER.email, password: HOTEL_OWNER.password, totpSecret },
      hotelHousekeeping: { email: HOTEL_HK.email, password: HOTEL_HK.password },
      portalTenant: { email: PORTAL_TENANT.email },
    };
    writeFileSync(ACCOUNTS, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  } finally {
    await close();
    await db.destroy();
  }
}

function printAccounts(): void {
  if (!existsSync(ACCOUNTS)) return;
  const a = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as Accounts;
  console.log(`
[dev] Tài khoản giả (chỉ CSDL dev):
  Chủ "${ORG_HOTEL}": ${a.hotelOwner.email} / ${a.hotelOwner.password} — mã TOTP: pnpm dev:up --totp
  Buồng phòng: ${a.hotelHousekeeping.email} / ${a.hotelHousekeeping.password}
  Người thuê "${ORG_PORTAL}": ${a.portalTenant.email} — đăng nhập OTP, mã ghi ở .dev/outbox.jsonl
  Mở ${BASE_URL}
`);
}

if (args.has("--totp")) {
  const a = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as Accounts;
  console.log(totp(a.hotelOwner.totpSecret));
  process.exit(0);
}
if (args.has("--reset")) {
  stopPg();
  rmSync(DEV_DIR, { recursive: true, force: true });
  console.log("[dev] đã xoá .dev/ (CSDL, bí mật, tài khoản giả)");
  process.exit(0);
}
if (args.has("--stop")) {
  stopPg();
  console.log("[dev] đã dừng Postgres dev");
  process.exit(0);
}

mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
startPg();
const serverUrl = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`;
const admin = kysely(serverUrl);
await bootstrapRoles(admin);
const exists = await sql`select 1 from pg_database where datname = ${DB_NAME}`.execute(admin);
if (exists.rows.length === 0) await sql.raw(`CREATE DATABASE ${DB_NAME}`).execute(admin);
await admin.destroy();

const adminUrl = pgUrl(serverUrl, DB_NAME);
const runtimeUrl = pgUrl(serverUrl, DB_NAME, "app_runtime");
const migrator = kysely(adminUrl);
await migrateToLatest(migrator);
await migrator.destroy();
const { betterAuth } = secrets();
await seedOnce(adminUrl, runtimeUrl, betterAuth);

// S3 giả trong bộ nhớ (ảnh tải lên mất khi dừng) + clamd giả (chỉ chặn chuỗi EICAR) — không cần SeaweedFS/ClamAV.
const fakeS3 = await startFakeS3();
const fakeClamd = await startFakeClamd();
if (!existsSync(OUTBOX)) writeFileSync(OUTBOX, "", { mode: 0o600 });

const appEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  APP_BASE_URL: BASE_URL,
  DATABASE_URL: runtimeUrl,
  BETTER_AUTH_SECRET: betterAuth,
  S3_ENDPOINT: `http://127.0.0.1:${fakeS3.port}`,
  S3_BUCKET: "hm-dev",
  S3_ACCESS_KEY_ID: "dev",
  S3_SECRET_ACCESS_KEY: "dev-khong-dung",
  CLAMD_HOST: "127.0.0.1",
  CLAMD_PORT: String(fakeClamd.port),
  SMTP_URL: `fake://file?path=${encodeURIComponent(OUTBOX)}`,
};
loadConfig(appEnv);

const children = [
  spawn(
    "pnpm",
    ["--filter", "@hm/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: appEnv,
    },
  ),
];
if (args.has("--worker")) {
  children.push(
    spawn("node", ["apps/worker/src/index.ts"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...appEnv, WORKER_DATABASE_URL: pgUrl(serverUrl, DB_NAME, "app_worker") },
    }),
  );
}
printAccounts();

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  fakeS3.server.close();
  fakeClamd.server.close();
  // Postgres dev chạy tiếp (dữ liệu bền); dừng hẳn: `pnpm dev:up --stop`.
  process.exit(code);
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
for (const c of children) c.on("exit", (code) => stop(code ?? 1));
