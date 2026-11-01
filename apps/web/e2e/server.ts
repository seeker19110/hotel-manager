// Server cho E2E (playwright.config.ts → webServer): Postgres 17 (TEST_DATABASE_URL hoặc cluster tạm của testkit) →
// role → migrate → seed giả → `next start`. Dừng (SIGTERM) thì xoá DB/cluster tạm. Chạy bằng `node` (bỏ kiểu TS).
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAuth,
  createServices,
  invitationKey,
  invitationToken,
  loadConfig,
  processDsarRequests,
  purgeDueOrganizations,
  unsubscribeKey,
  unsubscribeUrl,
} from "@hm/app";
import { migrateToLatest } from "@hm/db";
import { bootstrapRoles, type PgCluster, pgUrl, seedOrg, startPgCluster } from "@hm/testkit/setup";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { teeChildLog, waitClosed } from "./child-log.ts";
import { startFakeClamd, startFakeS3 } from "./fakes.ts";
import {
  authRateLimitResetAckFile,
  authRateLimitResetFile,
  INVITEE,
  INVITEE_EXPIRED_EMAIL,
  INVITEE_OTHER_EMAIL,
  inviteTokensFile,
  MAIN_ROOMS,
  ORG_HOTEL,
  ORG_MAIN,
  ORG_OTHER,
  ORG_RENTAL,
  OTHER_ROOMS,
  orgPurgeFile,
  outboxFile,
  RENTAL_OWNER,
  RENTAL_TENANT,
  SESSION_KINDS,
  SMOKE_USER,
  STAFF_TARGET,
  sessionCacheFile,
  supportTokensFile,
  unsubFile,
} from "./fixtures.ts";
import { seedHotelOrg, signUpWithTotp } from "./hotel-seed.ts";
import { seedPortal } from "./portal-seed.ts";
import { hotelTotpFile, totpFile } from "./totp.ts";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Bản sao thứ hai của web (ARC-RES-005): cùng CSDL/bí mật/kho, KHÔNG sticky — `replicas.spec.ts` đi xen kẽ hai cổng.
const REPLICA_PORT = PORT + 1;

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
  const ownerId = await signUpWithTotp(auth, RENTAL_OWNER, totpFile(PORT));

  const org = await seedOrg(db, ORG_RENTAL, "rental", ownerId);
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
            values (${tenant}, ${org.orgId}, ${RENTAL_TENANT}, '0100000001')`.execute(db);
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

/** Ba lời mời nhân viên của ORG_HOTEL (còn hạn / hết hạn / dành cho email khác); token ghi vào file cho test đọc. */
async function seedInvitations(
  db: Kysely<unknown>,
  auth: ReturnType<typeof createAuth>["auth"],
  secret: string,
): Promise<void> {
  const org = await sql<{ id: string; property_id: string; membership_id: string }>`
    select o.id, p.id as property_id, m.id as membership_id from organizations o
    join properties p on p.organization_id = o.id
    join memberships m on m.organization_id = o.id and m.role = 'owner'
    where o.name = ${ORG_HOTEL} limit 1`.execute(db);
  const o = org.rows[0];
  if (!o) throw new Error("thiếu ORG_HOTEL để seed lời mời");
  // Nhân viên buồng phòng đích của màn Thành viên (có mật khẩu để đăng nhập thật rồi bị thu hồi phiên).
  const target = await auth.api.signUpEmail({ body: STAFF_TARGET });
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email) values (${person}, ${o.id}, ${STAFF_TARGET.name}, ${STAFF_TARGET.email})`.execute(
    db,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role) values (${membership}, ${o.id}, ${target.user.id}, ${person}, 'housekeeping')`.execute(
    db,
  );
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id) values (${randomUUID()}, ${o.id}, ${membership}, ${o.property_id})`.execute(
    db,
  );
  const key = invitationKey(secret);
  const tokens: Record<string, string> = {};
  for (const [name, email, expires] of [
    ["valid", INVITEE.email, "now() + interval '7 days'"],
    ["expired", INVITEE_EXPIRED_EMAIL, "now() - interval '1 minute'"],
    ["other", INVITEE_OTHER_EMAIL, "now() + interval '7 days'"],
  ] as const) {
    const id = randomUUID();
    const token = invitationToken(key, id);
    tokens[name] = token;
    await sql`insert into invitations (id, organization_id, email, role, property_ids, token_hash, expires_at, invited_by)
              values (${id}, ${o.id}, ${email}, 'housekeeping', ${[o.property_id]}::uuid[], sha256(convert_to(${token}, 'UTF8')),
                      ${sql.raw(expires)}, ${o.membership_id})`.execute(db);
  }
  writeFileSync(inviteTokensFile(PORT), JSON.stringify(tokens), { mode: 0o600 });
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
    await seedHotelOrg(db, auth, PORT);
    await seedInvitations(db, auth, secret);
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
const appConfig = loadConfig(appEnv);
/**
 * Job `privacy.dsar` của worker (T-2311) chạy NGAY trong tiến trình E2E (server E2E không dựng worker): mỗi giây xử lý yêu cầu
 * truy cập/xoá bằng vai trò app_worker + kho object giả — `rights-access`/`rights-delete` thấy kết quả như khi có worker thật.
 */
const dsarDb = kysely(pgUrl(serverUrl, dbName, "app_worker"));
const dsarStorage = createServices(appConfig).storage;
let dsarRunning = false;
const dsarTimer = setInterval(() => {
  if (dsarRunning) return;
  dsarRunning = true;
  processDsarRequests(dsarDb, { storage: dsarStorage })
    .catch((e: unknown) => process.stderr.write(`[e2e-server] privacy.dsar lỗi: ${String(e)}\n`))
    .finally(() => {
      dsarRunning = false;
    });
}, 1_000);
/**
 * Job `tenancy.purge` (T-2312) theo TÍN HIỆU của spec (`orgPurgeFile`): đẩy mốc yêu cầu/hạn xoá của tổ chức được nêu lùi 31 ngày
 * (admin — thay cho chờ 30 ngày thật) rồi chạy purge bằng app_worker + kho giả, như worker thật khi tới hạn. Không tín hiệu ⇒ không
 * làm gì (tổ chức chờ xoá của spec khác không bị purge ngoài ý muốn).
 */
const purgeAdmin = kysely(adminUrl);

// D-138: 1 worker/project; reset chỉ được spec yêu cầu TRƯỚC scenario trên DB tạm do server này tạo.
// Không thêm HTTP endpoint, không tắt/nới limiter, không đụng login_throttle hoặc dữ liệu tài khoản.
const authResetSignal = authRateLimitResetFile(PORT);
const authResetAck = authRateLimitResetAckFile(PORT);
const authResetAckPending = `${authResetAck}.tmp`;
const authResetSignalPending = `${authResetSignal}.tmp`;
rmSync(authResetSignal, { force: true });
rmSync(authResetAck, { force: true });
rmSync(authResetAckPending, { force: true });
rmSync(authResetSignalPending, { force: true });
const acknowledgeAuthReset = (nonce: string, ok: boolean) => {
  writeFileSync(authResetAckPending, JSON.stringify({ nonce, ok }), { mode: 0o600 });
  renameSync(authResetAckPending, authResetAck);
};
let authResetRunning = false;
const authResetTimer = setInterval(() => {
  if (authResetRunning || !existsSync(authResetSignal)) return;
  const nonce = readFileSync(authResetSignal, "utf8").trim();
  rmSync(authResetSignal, { force: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) return;
  authResetRunning = true;
  sql<{ buckets: number; max_count: number }>`
    with removed as (delete from auth."rateLimit" returning "count")
    select count(*)::integer as buckets, coalesce(max("count"), 0)::integer as max_count from removed`
    .execute(purgeAdmin)
    .then((result) => {
      const counts = result.rows[0];
      process.stdout.write(
        `[e2e-server] auth fixture reset buckets=${counts?.buckets ?? 0} max_count=${counts?.max_count ?? 0}\n`,
      );
      acknowledgeAuthReset(nonce, true);
    })
    .catch(() => {
      process.stderr.write("[e2e-server] auth fixture reset failed\n");
      acknowledgeAuthReset(nonce, false);
    })
    .finally(() => {
      authResetRunning = false;
    });
}, 100);

const purgeSignal = orgPurgeFile(PORT);
let purgeRunning = false;
const purgeTimer = setInterval(() => {
  if (purgeRunning || !existsSync(purgeSignal)) return;
  purgeRunning = true;
  (async () => {
    const ids = readFileSync(purgeSignal, "utf8")
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => /^[0-9a-f-]{36}$/.test(x));
    rmSync(purgeSignal, { force: true });
    for (const id of ids)
      await sql`update organizations
                set deletion_requested_at = deletion_requested_at - interval '31 days',
                    deletion_due_at = deletion_due_at - interval '31 days'
                where id = ${id}::uuid and status = 'pending_deletion'`.execute(purgeAdmin);
    if (ids.length > 0) await purgeDueOrganizations(dsarDb, { storage: dsarStorage });
  })()
    .catch((e: unknown) => process.stderr.write(`[e2e-server] tenancy.purge lỗi: ${String(e)}\n`))
    .finally(() => {
      purgeRunning = false;
    });
}, 1_000);
/**
 * Lời mời truy cập hỗ trợ (T-2313, D-128) thay cho email của worker (server E2E không gửi thư lời mời): mỗi giây ghi token của lời mời
 * hỗ trợ đang chờ vào `supportTokensFile` (`{ email: token }`, quyền 0600) — token dẫn xuất từ khoá chỉ server có, như email thật.
 */
const supportKey = invitationKey(secret);
const supportFile = supportTokensFile(PORT);
let supportRunning = false;
const supportTimer = setInterval(() => {
  if (supportRunning) return;
  supportRunning = true;
  sql<{ id: string; email: string }>`
    select id, email from invitations where role = 'platform_support' and status = 'pending' and expires_at > now()`
    .execute(purgeAdmin)
    .then((r) =>
      writeFileSync(
        supportFile,
        JSON.stringify(Object.fromEntries(r.rows.map((x) => [x.email, invitationToken(supportKey, x.id)]))),
        { mode: 0o600 },
      ),
    )
    .catch((e: unknown) => process.stderr.write(`[e2e-server] token hỗ trợ lỗi: ${String(e)}\n`))
    .finally(() => {
      supportRunning = false;
    });
}, 1_000);
const replicaEnv: NodeJS.ProcessEnv = { ...appEnv, APP_BASE_URL: `http://127.0.0.1:${REPLICA_PORT}` };
loadConfig(replicaEnv);
/**
 * Log của app (stdout/stderr của `next start`) vừa in ra như cũ vừa ghi vào `e2e-logs/server-<cổng>.log` để CI quét PII
 * sau lượt E2E (CMP-PRIV-008, `scripts/pii-log-scan.mjs`). Thư mục nằm ngoài `test-results/` vì Playwright xoá thư mục đó
 * lúc bắt đầu chạy; đã có trong .gitignore.
 */
const LOG_DIR = join(import.meta.dirname, "..", "e2e-logs");
const startNext = (port: number, env: NodeJS.ProcessEnv) => {
  mkdirSync(LOG_DIR, { recursive: true });
  const child = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: ["inherit", "pipe", "pipe"],
    env,
  });
  return { child, closed: teeChildLog(child, join(LOG_DIR, `server-${port}.log`)).closed };
};
const { child: next, closed: nextClosed } = startNext(PORT, appEnv);
// Lighthouse CI (lighthouserc.json) chỉ đo server chính: E2E_NO_REPLICA=1 bỏ bản sao thứ hai cho đỡ tranh CPU (chỉ dùng ở đây).
const replicaRun = process.env.E2E_NO_REPLICA === "1" ? undefined : startNext(REPLICA_PORT, replicaEnv);
const replica = replicaRun?.child;

/** Dấu hiệu RIÊNG của server chính (lhci `startServerReadyPattern`): "Ready in" của Next in cả cho bản sao nên không đủ. */
const READY_MARKER = "E2E_SERVER_READY";
async function announceReady(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!stopping && Date.now() < deadline) {
    // Cổng chưa nghe → fetch từ chối → `null` → thử lại.
    const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) }).then(
      (res) => res,
      () => null,
    );
    if (r?.ok) {
      process.stdout.write(`${READY_MARKER} ${BASE_URL}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(dsarTimer);
  clearInterval(purgeTimer);
  clearInterval(supportTimer);
  clearInterval(authResetTimer);
  rmSync(authResetSignal, { force: true });
  rmSync(authResetAck, { force: true });
  rmSync(authResetAckPending, { force: true });
  rmSync(authResetSignalPending, { force: true });
  rmSync(purgeSignal, { force: true });
  rmSync(supportFile, { force: true });
  next.kill("SIGTERM");
  replica?.kill("SIGTERM");
  rmSync(totpFile(PORT), { force: true });
  rmSync(hotelTotpFile(PORT), { force: true });
  rmSync(outbox, { force: true });
  rmSync(unsubFile(PORT), { force: true });
  rmSync(inviteTokensFile(PORT), { force: true });
  for (const kind of SESSION_KINDS) rmSync(sessionCacheFile(PORT, kind), { force: true });
  fakeS3.server.close();
  fakeClamd.server.close();
  // Chờ Next đóng stdio và log ghi xong: thoát sớm thì mất dòng log cuối, bộ quét PII không thấy (CMP-PRIV-008).
  const closedInTime = await waitClosed([nextClosed, ...(replicaRun ? [replicaRun.closed] : [])], 10_000);
  if (!closedInTime)
    process.stderr.write("[e2e-server] tiến trình Next chưa đóng sau 10 s — log có thể thiếu dòng cuối\n");
  await purgeAdmin
    .destroy()
    .catch((e: unknown) => process.stderr.write(`[e2e-server] đóng pool tenancy.purge lỗi: ${String(e)}\n`));
  await dsarDb
    .destroy()
    .catch((e: unknown) => process.stderr.write(`[e2e-server] đóng pool privacy.dsar lỗi: ${String(e)}\n`));
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
void announceReady();
