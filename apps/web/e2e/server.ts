// Server cho E2E (playwright.config.ts → webServer): Postgres 17 (TEST_DATABASE_URL hoặc cluster tạm của testkit) →
// role → migrate → seed giả → `next start`. Dừng (SIGTERM) thì xoá DB/cluster tạm. Chạy bằng `node` (bỏ kiểu TS).
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createAuth, loadConfig, unsubscribeKey, unsubscribeUrl } from "@hm/app";
import { migrateToLatest } from "@hm/db";
import { bootstrapRoles, type PgCluster, pgUrl, seedOrg, startPgCluster } from "@hm/testkit/setup";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { startFakeClamd, startFakeS3 } from "./fakes.ts";
import {
  MAIN_ROOMS,
  ORG_MAIN,
  ORG_OTHER,
  ORG_RENTAL,
  OTHER_ROOMS,
  outboxFile,
  RENTAL_OWNER,
  RENTAL_TENANT,
  SMOKE_USER,
  unsubFile,
} from "./fixtures.ts";
import { seedPortal } from "./portal-seed.ts";
import { totp, totpFile } from "./totp.ts";

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

/** Ngày đầu tháng hiện tại theo giờ Việt Nam (hợp đồng bắt đầu tính tiền trọn tháng). */
function firstOfMonthVn(): string {
  return `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)}-01`;
}

/** Chủ trọ bật TOTP thật qua Better Auth; một hợp đồng chờ ký; dịch vụ + giá + công tơ (dữ liệu giả). */
async function seedRental(db: Kysely<unknown>, auth: ReturnType<typeof createAuth>["auth"]): Promise<void> {
  const { user } = await auth.api.signUpEmail({ body: RENTAL_OWNER });
  const login = await auth.api.signInEmail({
    body: { email: RENTAL_OWNER.email, password: RENTAL_OWNER.password },
    returnHeaders: true,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const enabled = await auth.api.enableTwoFactor({
    body: { password: RENTAL_OWNER.password },
    headers: new Headers({ cookie }),
  });
  if (!("totpURI" in enabled)) throw new Error("cần TOTP");
  const secretB32 = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
  await auth.api.verifyTOTP({ body: { code: totp(secretB32) }, headers: new Headers({ cookie }) });
  writeFileSync(totpFile(PORT), JSON.stringify({ secret: secretB32 }), { mode: 0o600 });

  const org = await seedOrg(db, ORG_RENTAL, "rental", user.id);
  const start = firstOfMonthVn();
  const svc: Record<string, string> = {};
  for (const [code, name, kind, account, meter, price] of [
    ["DIEN", "Điện", "metered", "REV_UTIL", "electric", 3000],
    ["NUOC", "Nước", "metered", "REV_UTIL", "water", 15000],
    ["PHI", "Phí khác", "fixed_per_unit", "REV_FEE", null, 100000],
  ] as const) {
    const id = randomUUID();
    svc[code] = id;
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
              values (${id}, ${org.orgId}, ${org.propertyId}, ${code}, ${name}, ${kind}, ${account}, ${meter})`.execute(
      db,
    );
    await sql`insert into service_prices (id, organization_id, property_id, service_id, unit_price, effective_from)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${id}, ${price}, '2026-01-01')`.execute(
      db,
    );
  }
  for (const [kind, initial] of [
    ["electric", 1250],
    ["water", 30],
  ] as const) {
    await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${org.unitId}, ${kind}, '2026-01-01', ${initial})`.execute(
      db,
    );
  }
  const tenant = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone)
            values (${tenant}, ${org.orgId}, ${RENTAL_TENANT}, '0900000001')`.execute(db);
  const lease = randomUUID();
  const services = JSON.stringify(Object.values(svc).map((service_id) => ({ service_id, quantity: 1 })));
  await db.transaction().execute(async (trx) => {
    await sql`insert into leases (id, organization_id, property_id, unit_id, number, billing_start_on, representative_person_id)
              values (${lease}, ${org.orgId}, ${org.propertyId}, ${org.unitId}, 'HD-000001', ${start}::date, ${tenant})`.execute(
      trx,
    );
    await sql`insert into lease_versions (id, organization_id, property_id, lease_id, version_no, kind, effective_from, rent_amount,
                                          deposit_amount, services)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${lease}, 1, 'original', ${start}::date, 3000000, 3000000,
                      ${services}::jsonb)`.execute(trx);
    await sql`insert into lease_occupants (id, organization_id, property_id, lease_id, person_id, role, is_representative, from_on)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${lease}, ${tenant}, 'primary', true, ${start}::date)`.execute(
      trx,
    );
    await sql`update leases set status = 'pending_signature' where id = ${lease}`.execute(trx);
  });
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
    await seedRental(db, auth);
    const portal = await seedPortal(db);
    // Liên kết huỷ đăng ký ký số trong email nhắc quá hạn của người thuê An (SPEC-notifications S-010).
    writeFileSync(
      unsubFile(PORT),
      unsubscribeUrl(BASE_URL, unsubscribeKey(secret), {
        orgId: portal.orgId,
        personId: portal.tenantPersonId,
        type: "invoice_overdue",
      }),
      { mode: 0o600 },
    );
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

// Dịch vụ giả (portal tải ảnh): S3 trong bộ nhớ + clamd giả; OTP đăng nhập người thuê ghi vào hộp thư giả (file) cho test đọc.
const fakeS3 = await startFakeS3();
const fakeClamd = await startFakeClamd();
const outbox = outboxFile(PORT);
writeFileSync(outbox, "", { mode: 0o600 });

const appEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  APP_BASE_URL: BASE_URL,
  DATABASE_URL: runtimeUrl,
  BETTER_AUTH_SECRET: secret,
  // Object storage giả trong bộ nhớ (fakes.ts); khoá giả chỉ để qua validate cấu hình.
  S3_ENDPOINT: `http://127.0.0.1:${fakeS3.port}`,
  S3_BUCKET: "hm-e2e",
  S3_ACCESS_KEY_ID: "e2e",
  S3_SECRET_ACCESS_KEY: "e2e-khong-dung",
  // Production bắt buộc khoá PII + máy quét (T-202/T-203): khoá ngẫu nhiên chỉ sống trong tiến trình này; clamd giả (fakes.ts).
  HM_PII_KEYS: `1:${randomBytes(32).toString("base64")}`,
  HM_PII_KEY_ID: "1",
  HM_PII_INDEX_KEY: randomBytes(32).toString("base64"),
  CLAMD_HOST: "127.0.0.1",
  CLAMD_PORT: String(fakeClamd.port),
  SMTP_URL: `fake://file?path=${encodeURIComponent(outbox)}`,
};
// Hàng rào: env của server E2E phải qua đúng schema cấu hình production — thiếu biến thì dừng ngay, báo tên biến
// (thay vì đăng nhập 500 âm thầm như lần thêm khoá PII).
loadConfig(appEnv);
const next = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  stdio: "inherit",
  env: appEnv,
});

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  next.kill("SIGTERM");
  rmSync(totpFile(PORT), { force: true });
  rmSync(outbox, { force: true });
  rmSync(unsubFile(PORT), { force: true });
  fakeS3.server.close();
  fakeClamd.server.close();
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
