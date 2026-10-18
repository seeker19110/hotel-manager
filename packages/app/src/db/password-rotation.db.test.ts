// DB-SEC-004 — xoay mật khẩu role ứng dụng không downtime: diễn tập đúng các bước của docs/ops/runbooks/db-password-rotation.md
// trên Postgres 17 thật xác thực SCRAM qua TCP (cluster mặc định của test để `trust` nên không kiểm mật khẩu).
// Bản đang chạy giữ kết nối bằng login cũ trong khi bản mới vào bằng login mới (`packages/db/sql/rotate-login.sql`); tắt login cũ
// không cắt truy vấn đang chạy; login mới có đúng quyền, RLS và giới hạn thời gian của role gốc.
import { execFileSync } from "node:child_process";
import { chownSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateToLatest } from "@hm/db";
import { asPg, freePort, PG_BIN, seedOrg } from "@hm/testkit/setup";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROTATE_SQL = new URL("../../../db/sql/rotate-login.sql", import.meta.url).pathname;
const ROLES_SQL = new URL("../../../db/sql/bootstrap-roles.sql", import.meta.url).pathname;
const COMPOSE = new URL("../../../../deploy/compose.yaml", import.meta.url).pathname;

let dir: string;
let port: number;
let admin: Kysely<unknown>;
let adminPool: pg.Pool;
const pools: pg.Pool[] = [];
/** Lỗi kết nối rảnh mà pool báo (app thật ghi `pool.idle_error` rồi mở kết nối mới — apps/worker/src/runtime.ts). */
const idleErrors: { user: string; code: string | undefined }[] = [];
let orgA: string;
let orgB: string;

const pgctl = (...args: string[]) =>
  asPg(join(PG_BIN, "pg_ctl"), ["-D", join(dir, "data"), "-w", "-l", join(dir, "log"), ...args]);
/** Chạy rotate-login.sql bằng psql đúng như runbook (biến -v base/login); trả exit code. */
function rotate(base: string, login: string): number {
  const file = join(dir, "rotate-login.sql");
  try {
    asPg(join(PG_BIN, "psql"), [
      "-X",
      "-q",
      "-h",
      dir,
      "-p",
      String(port),
      "-U",
      "postgres",
      "-v",
      `base=${base}`,
      "-v",
      `login=${login}`,
      "-f",
      file,
    ]);
    return 0;
  } catch (e) {
    return Number(/exit (\d+)/.exec(String(e))?.[1] ?? 1);
  }
}
const tcpPool = (user: string, password: string) => {
  const p = new pg.Pool({
    host: "127.0.0.1",
    port,
    user,
    password,
    database: "postgres",
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  p.on("error", (e: Error & { code?: string }) => idleErrors.push({ user, code: e.code }));
  pools.push(p);
  return p;
};
/** Số tổ chức nhìn thấy trong ngữ cảnh `org` (RLS) + statement_timeout của phiên. */
async function probe(c: pg.PoolClient | pg.Pool, org: string): Promise<{ orgs: string[]; timeout: string }> {
  const client = "release" in c ? c : await c.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [org]);
    const r = await client.query<{ id: string }>("select id from organizations order by id");
    const t = await client.query<{ statement_timeout: string }>("show statement_timeout");
    await client.query("commit");
    return { orgs: r.rows.map((x) => x.id), timeout: t.rows[0]?.statement_timeout ?? "" };
  } finally {
    if (!("release" in c)) client.release();
  }
}
const setPassword = (role: string, pw: string) =>
  sql.raw(`SET password_encryption = 'scram-sha-256'; ALTER ROLE ${role} PASSWORD '${pw}'`).execute(admin);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hm-pgrot-"));
  copyFileSync(ROTATE_SQL, join(dir, "rotate-login.sql"));
  copyFileSync(ROLES_SQL, join(dir, "bootstrap-roles.sql"));
  if (process.getuid?.() === 0) {
    const id = (flag: string) => Number(execFileSync("id", [flag, "postgres"], { encoding: "utf8" }).trim());
    chownSync(dir, id("-u"), id("-g"));
  }
  port = await freePort();
  asPg(join(PG_BIN, "initdb"), [
    "-D",
    join(dir, "data"),
    "-U",
    "postgres",
    "--auth-local=trust",
    "--auth-host=scram-sha-256",
    "-E",
    "UTF8",
    "--locale=C.UTF-8",
  ]);
  pgctl(
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir} -c fsync=off -c password_encryption=scram-sha-256`,
    "start",
  );
  asPg(join(PG_BIN, "psql"), [
    "-X",
    "-q",
    "-h",
    dir,
    "-p",
    String(port),
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    join(dir, "bootstrap-roles.sql"),
  ]);
  adminPool = new pg.Pool({ host: dir, port, user: "postgres", database: "postgres", max: 2 });
  admin = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await migrateToLatest(admin);
  orgA = (await seedOrg(admin, "Rotation A")).orgId;
  orgB = (await seedOrg(admin, "Rotation B")).orgId;
  await setPassword("app_runtime", "old-pass-not-a-secret");
}, 120_000);

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => {});
  await admin?.destroy();
  if (dir) {
    try {
      pgctl("stop", "-m", "fast");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("DB-SEC-004 — xoay mật khẩu role ứng dụng không downtime", () => {
  it("mật khẩu thật được kiểm (SCRAM): sai mật khẩu → từ chối", async () => {
    await expect(tcpPool("app_runtime", "sai").query("select 1")).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it("luân phiên login: bản cũ và bản mới chạy song song, tắt login cũ không cắt truy vấn đang chạy, RLS + timeout giữ nguyên", async () => {
    const old = tcpPool("app_runtime", "old-pass-not-a-secret");
    const held = await old.connect(); // kết nối của bản đang chạy, giữ suốt quá trình xoay
    expect(await probe(held, orgA)).toEqual({ orgs: [orgA], timeout: "15s" });

    // Bước 1–2 của runbook: tạo login mới + đặt mật khẩu mới.
    expect(rotate("app_runtime", "app_runtime_b")).toBe(0);
    await setPassword("app_runtime_b", "new-pass-not-a-secret");
    const fresh = tcpPool("app_runtime_b", "new-pass-not-a-secret");
    // Bước 3: bản mới vào bằng login mới — cùng quyền, cùng RLS (chỉ thấy tổ chức của mình), cùng statement_timeout.
    expect(await probe(fresh, orgA)).toEqual({ orgs: [orgA], timeout: "15s" });
    expect(await probe(fresh, orgB)).toEqual({ orgs: [orgB], timeout: "15s" });
    // Bản cũ vẫn mở kết nối MỚI được trong lúc triển khai lần lượt.
    expect((await probe(tcpPool("app_runtime", "old-pass-not-a-secret"), orgA)).orgs).toEqual([orgA]);

    // Bước 4: mọi bản đã chuyển → tắt login cũ. Kết nối đang mở vẫn chạy; kết nối mới bằng login cũ bị từ chối.
    await sql.raw("ALTER ROLE app_runtime NOLOGIN").execute(admin);
    expect(await probe(held, orgA)).toEqual({ orgs: [orgA], timeout: "15s" });
    await expect(tcpPool("app_runtime", "old-pass-not-a-secret").query("select 1")).rejects.toThrow(
      /not permitted to log in/,
    );
    expect((await probe(fresh, orgA)).orgs).toEqual([orgA]);
    held.release();
  });

  it("lần xoay kế tiếp quay về _a; dọn phiên của login cũ sau khi triển khai xong", async () => {
    expect(rotate("app_runtime", "app_runtime_a")).toBe(0);
    await setPassword("app_runtime_a", "next-pass-not-a-secret");
    const next = tcpPool("app_runtime_a", "next-pass-not-a-secret");
    expect(await probe(next, orgB)).toEqual({ orgs: [orgB], timeout: "15s" });
    await sql.raw("ALTER ROLE app_runtime_b NOLOGIN").execute(admin);
    const killed = await sql<{ n: number }>`select count(*)::int as n from (
        select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app_runtime_b') t`.execute(
      admin,
    );
    // Pool của bản cũ còn kết nối rảnh bằng app_runtime_b → bị cắt (57P01), pool báo lỗi rảnh; bản mới không bị ảnh hưởng.
    expect(killed.rows[0]?.n).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => idleErrors.filter((e) => e.user === "app_runtime_b").map((e) => e.code))
      .toContain("57P01");
    expect(idleErrors.filter((e) => e.user !== "app_runtime_b")).toEqual([]);
    expect((await probe(next, orgA)).orgs).toEqual([orgA]);
  });

  it("login luân phiên không có quyền vượt role gốc: không superuser/BYPASSRLS/CREATEROLE/REPLICATION; phiên chạy bằng role gốc", async () => {
    const r = await sql<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication from pg_roles where rolname like 'app_runtime_%' order by rolname`.execute(
      admin,
    );
    const none = { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolreplication: false };
    expect(r.rows).toEqual([
      { rolname: "app_runtime_a", ...none },
      { rolname: "app_runtime_b", ...none },
    ]);
    const c = await tcpPool("app_runtime_a", "next-pass-not-a-secret").connect();
    try {
      // `ALTER ROLE … SET role = <base>`: quyền, RLS, sở hữu đối tượng theo role gốc; đăng nhập theo login.
      const who = await c.query<{ cu: string; su: string }>("select current_user as cu, session_user as su");
      expect(who.rows[0]).toEqual({ cu: "app_runtime", su: "app_runtime_a" });
      // Không nhảy sang role nào khác ngoài role gốc, kể cả superuser.
      await expect(c.query("set role postgres")).rejects.toThrow(/permission denied/);
      await expect(c.query("set role app_worker")).rejects.toThrow(/permission denied/);
    } finally {
      c.release();
    }
    // Không ADMIN OPTION: login không cấp tiếp được quyền của role gốc.
    const g = await sql<{ admin_option: boolean; set_option: boolean }>`
      select m.admin_option, m.set_option from pg_auth_members m
      join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
      where r.rolname = 'app_runtime' and u.rolname = 'app_runtime_a'`.execute(admin);
    expect(g.rows).toEqual([{ admin_option: false, set_option: true }]);
  });

  it("đối tượng do login tạo thuộc role gốc: bảng trong schema pgboss tạo bằng app_worker_a vẫn sửa được bằng app_worker_b sau lần xoay", async () => {
    await setPassword("app_worker", "w-old-pass-not-a-secret");
    expect(rotate("app_worker", "app_worker_a")).toBe(0);
    await setPassword("app_worker_a", "w-a-pass-not-a-secret");
    const a = await tcpPool("app_worker_a", "w-a-pass-not-a-secret").connect();
    try {
      await a.query("create table pgboss.rot_probe (id int)");
      const owner = await a.query<{ o: string }>(
        "select tableowner as o from pg_tables where schemaname = 'pgboss' and tablename = 'rot_probe'",
      );
      expect(owner.rows[0]?.o).toBe("app_worker");
    } finally {
      a.release();
    }
    // Xoay sang _b, tắt _a: pg-boss (đổi lược đồ khi nâng phiên bản) vẫn ALTER được bảng đã có.
    expect(rotate("app_worker", "app_worker_b")).toBe(0);
    await setPassword("app_worker_b", "w-b-pass-not-a-secret");
    await sql.raw("ALTER ROLE app_worker_a NOLOGIN").execute(admin);
    const b = await tcpPool("app_worker_b", "w-b-pass-not-a-secret").connect();
    try {
      await b.query("alter table pgboss.rot_probe add column note text");
      await b.query("drop table pgboss.rot_probe");
      const t = await b.query<{ statement_timeout: string }>("show statement_timeout");
      expect(t.rows[0]?.statement_timeout).toBe("2min");
    } finally {
      b.release();
    }
  });

  it("script từ chối base/login lạ (không tạo role, psql exit ≠ 0)", async () => {
    expect(rotate("app_runtime", "app_runtime_c")).not.toBe(0);
    expect(rotate("postgres", "postgres_a")).not.toBe(0);
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_roles where rolname in ('app_runtime_c','postgres_a')`.execute(
      admin,
    );
    expect(r.rows[0]?.n).toBe(0);
  });

  it("log truy vấn không in tham số: compose đặt log_statement=none và cắt tham số trong log (kể cả khi lỗi)", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    for (const s of [
      "log_statement=none",
      "log_parameter_max_length=0",
      "log_parameter_max_length_on_error=0",
    ])
      expect(compose).toContain(`- ${s}`);
    expect(compose).not.toMatch(/log_statement=(all|mod)/);
  });
});
