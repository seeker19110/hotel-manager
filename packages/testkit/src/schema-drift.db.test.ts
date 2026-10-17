// PLAN đợt 8 T-708 (DB-MIG-001) — rào lệch schema: schema chỉ đổi qua migration có phiên bản, áp bằng công cụ.
//  1. Sổ `kysely_migration` sau migrateToLatest khớp ĐÚNG khoá của `migrations` (packages/db/src/migrations/index.ts) và các file
//     `packages/db/src/migrations/*.ts` (không thừa/thiếu, đúng thứ tự) — quên đăng ký file, đăng ký tên không có file, đổi tên file
//     đã áp đều bị bắt.
//  2. Ảnh chụp schema chuẩn hoá (bảng, cột, ràng buộc, index, policy RLS, trigger, hàm, kiểu, quyền bảng) đọc từ pg_catalog sau
//     migrate so với `docs/db/schema.snapshot.txt` (toMatchFileSnapshot). Lệch (sửa tay trên CSDL, hoặc migration mới mà chưa
//     cập nhật file) → đỏ kèm diff. Cập nhật có chủ đích sau khi đã xem diff: `pnpm db:snapshot` (= vitest … schema-drift -u).
//     Ảnh chụp gồm cả chủ sở hữu (bảng, hàm, schema; role đang kết nối ghi là `<admin>`) và mọi quyền: bảng, cột, EXECUTE hàm
//     (kể cả mặc định PUBLIC khi ACL null), schema.
// GIỚI HẠN: rào này phát hiện lệch so với KẾT QUẢ CỦA MIGRATION chạy trong CI (CSDL sạch), không thấy được CSDL môi trường chung
//     (staging/prod) bị sửa tay — môi trường đó chưa có; khi có, cần chạy `schemaSnapshot` trên đó và so với file. Ảnh chụp đối
//     chiếu Postgres 17 (khác major → báo rõ, không so).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrateToLatest, migrations } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/src/migrations/", import.meta.url));
const SNAPSHOT_FILE = fileURLToPath(new URL("../../../docs/db/schema.snapshot.txt", import.meta.url));
const REGEN = "pnpm db:snapshot";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

// ───────────────────────── 1. sổ migration ↔ index.ts ↔ file ─────────────────────────

/** Tên migration theo file trong thư mục (bỏ `index.ts`, bỏ đuôi `.ts`), sắp tăng dần. */
function migrationFileNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.slice(0, -".ts".length))
    .sort();
}

/** So hai danh sách tên có thứ tự; trả mô tả từng chênh lệch (rỗng = khớp tuyệt đối, kể cả thứ tự). */
function diffNames(labelA: string, a: string[], labelB: string, b: string[]): string[] {
  const out: string[] = [];
  for (const n of a) if (!b.includes(n)) out.push(`${n}: có ở ${labelA} nhưng thiếu ở ${labelB}`);
  for (const n of b) if (!a.includes(n)) out.push(`${n}: có ở ${labelB} nhưng thiếu ở ${labelA}`);
  const dup = (xs: string[], label: string) =>
    xs.filter((n, i) => xs.indexOf(n) !== i).map((n) => `${n}: trùng trong ${label}`);
  out.push(...dup(a, labelA), ...dup(b, labelB));
  if (out.length === 0 && a.join("\n") !== b.join("\n"))
    out.push(`cùng tập tên nhưng khác thứ tự giữa ${labelA} và ${labelB}`);
  return out;
}

async function ledger(db: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{
    name: string;
  }>`select name from public.kysely_migration order by name collate "C"`.execute(db);
  return r.rows.map((x) => x.name);
}

describe("schema-drift — sổ migration (DB-MIG-001)", () => {
  it("sau migrateToLatest: kysely_migration = khoá của `migrations` = file *.ts trong thư mục migration (đúng thứ tự, không thừa/thiếu)", async () => {
    const rows = await ledger(t.admin);
    const keys = Object.keys(migrations);
    const files = migrationFileNames(MIGRATIONS_DIR);
    expect(rows.length).toBeGreaterThan(0);
    expect(diffNames("kysely_migration", rows, "migrations (index.ts)", keys)).toEqual([]);
    expect(diffNames("migrations (index.ts)", keys, "file *.ts", files)).toEqual([]);
    // Khoá khai báo theo thứ tự tên (kysely sắp theo tên khi áp): khai sai chỗ = áp sai thứ tự trên CSDL mới.
    expect(keys).toEqual([...keys].sort());
  });

  it("migrateToLatest lần hai là no-op (idempotent): sổ không đổi", async () => {
    const before = await ledger(t.admin);
    await migrateToLatest(t.admin);
    expect(await ledger(t.admin)).toEqual(before);
  });

  it("bộ so khớp bắt được: file thừa, file thiếu, tên trùng, sai thứ tự; rỗng so rỗng thì khớp", () => {
    expect(diffNames("A", [], "B", [])).toEqual([]);
    expect(diffNames("A", ["0001_a", "0002_b"], "B", ["0001_a", "0002_b"])).toEqual([]);
    expect(diffNames("A", ["0001_a", "0002_b"], "B", ["0001_a"])).toEqual(["0002_b: có ở A nhưng thiếu ở B"]);
    expect(diffNames("A", ["0001_a"], "B", ["0001_a", "0003_c"])).toEqual(["0003_c: có ở B nhưng thiếu ở A"]);
    expect(diffNames("A", ["0001_a", "0001_a"], "B", ["0001_a"])).toEqual(["0001_a: trùng trong A"]);
    expect(diffNames("A", ["0002_b", "0001_a"], "B", ["0001_a", "0002_b"])).toEqual([
      "cùng tập tên nhưng khác thứ tự giữa A và B",
    ]);
  });
});

// ───────────────────────── 2. ảnh chụp schema chuẩn hoá ─────────────────────────

/** Schema do người dùng/migration tạo (bỏ hệ thống Postgres). */
const USER_NS = sql`n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`;
/** Đối tượng do extension sở hữu (không thuộc migration của ta) bị bỏ. */
const NOT_EXT = (oidCol: string, classid: string) =>
  sql.raw(
    `not exists (select 1 from pg_depend d where d.classid = '${classid}'::regclass and d.objid = ${oidCol} and d.deptype = 'e')`,
  );

/** Tên role đã chuẩn hoá để ảnh chụp không phụ thuộc máy: PUBLIC (oid 0), `<admin>` (role đang kết nối/migrate), còn lại theo tên. */
const roleName = (col: string) =>
  sql.raw(
    `case when ${col} = 0 then 'PUBLIC' when pg_get_userbyid(${col}) = current_user then '<admin>' else pg_get_userbyid(${col}) end`,
  );
const grantOpt = sql.raw(`case when a.is_grantable then ' (grant option)' else '' end`);

async function lines(q: ReturnType<typeof sql<{ l: string }>>, db: Kysely<unknown>): Promise<string[]> {
  return (await q.execute(db)).rows.map((r) => r.l).sort(byCodePoint);
}
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ảnh chụp schema ổn định giữa các lần chạy/máy: chỉ dùng tên (không OID), sắp theo tên, gồm chủ sở hữu (chuẩn hoá) và ACL, không thời gian/phiên bản.
 * Mỗi mục một dòng (định nghĩa nhiều dòng như hàm được gộp, thụt lề) để diff đọc được.
 */
async function schemaSnapshot(db: Kysely<unknown>): Promise<string> {
  const section = async (title: string, rows: string[]) =>
    `## ${title} (${rows.length})\n${rows.join("\n")}\n`;

  const ver = Number(
    (await sql<{ v: string }>`select current_setting('server_version_num') as v`.execute(db)).rows[0]?.v,
  );
  if (Math.floor(ver / 10000) !== 17)
    throw new Error(
      `Ảnh chụp schema chỉ đối chiếu trên Postgres 17 (server_version_num=${ver}): chạy ${REGEN} và test trên PG17 (docker compose/CI).`,
    );

  const schemas = await lines(
    sql<{
      l: string;
    }>`select n.nspname || ' owner=' || ${roleName("n.nspowner")} as l from pg_namespace n where ${USER_NS} and ${NOT_EXT("n.oid", "pg_namespace")}`,
    db,
  );
  const extensions = await lines(
    sql<{ l: string }>`select extname as l from pg_extension where extname <> 'plpgsql'`,
    db,
  );
  const types = await lines(
    sql<{ l: string }>`
      select n.nspname || '.' || t.typname || ' ' ||
        case t.typtype
          when 'e' then 'enum(' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) || ')'
          when 'd' then 'domain ' || format_type(t.typbasetype, t.typtypmod) || case when t.typnotnull then ' not null' else '' end
            || coalesce(' default ' || t.typdefault, '')
          else t.typtype::text end as l
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where ${USER_NS} and t.typtype in ('e', 'd') and ${NOT_EXT("t.oid", "pg_type")}`,
    db,
  );
  const tables = await lines(
    sql<{ l: string }>`
      select n.nspname || '.' || c.relname || ' owner=' || ${roleName("c.relowner")} || ' ' ||
        case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view' when 'm' then 'matview' when 'f' then 'foreign table' end
        || case when c.relpersistence = 'u' then ' unlogged' else '' end
        || case when c.relrowsecurity then ' rls' else '' end
        || case when c.relforcerowsecurity then ' force-rls' else '' end
        || coalesce(' options(' || (select string_agg(o, ',' order by o collate "C") from unnest(c.reloptions) o) || ')', '') as l
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where ${USER_NS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition and ${NOT_EXT("c.oid", "pg_class")}`,
    db,
  );
  const columns = await lines(
    sql<{ l: string }>`
      select n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || case when a.attnotnull then ' not null' else '' end
        || case a.attidentity when 'a' then ' identity(always)' when 'd' then ' identity(by default)' else '' end
        || case a.attgenerated when 's' then ' generated(' || pg_get_expr(d.adbin, d.adrelid) || ')' else
             coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') end as l
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where ${USER_NS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped
        and ${NOT_EXT("c.oid", "pg_class")}`,
    db,
  );
  // contype 'n' (NOT NULL có tên, Postgres 18+) đã nằm ở cột `not null` nên bỏ để ảnh chụp không đổi theo phiên bản.
  const constraints = await lines(
    sql<{ l: string }>`
      select n.nspname || '.' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid, true) as l
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where ${USER_NS} and k.contype <> 'n' and ${NOT_EXT("c.oid", "pg_class")}`,
    db,
  );
  const indexes = await lines(
    sql<{
      l: string;
    }>`select schemaname || '.' || tablename || ' ' || indexname || ' :: ' || indexdef as l from pg_indexes
      where schemaname !~ '^pg_' and schemaname <> 'information_schema'`,
    db,
  );
  const policies = await lines(
    sql<{ l: string }>`
      select schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd
        || ' to ' || array_to_string(roles, ',')
        || coalesce(' using (' || qual || ')', '') || coalesce(' check (' || with_check || ')', '') as l
      from pg_policies where schemaname !~ '^pg_' and schemaname <> 'information_schema'`,
    db,
  );
  const triggers = await lines(
    sql<{ l: string }>`
      select n.nspname || '.' || c.relname || ' ' || pg_get_triggerdef(g.oid, true) as l
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where ${USER_NS} and not g.tgisinternal and ${NOT_EXT("c.oid", "pg_class")}`,
    db,
  );
  // Hàm/thủ tục: định nghĩa đầy đủ (gồm SET search_path, SECURITY DEFINER, thân hàm), gộp thành một mục nhiều dòng.
  const functions = (
    await sql<{ k: string; d: string }>`
      select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner=' || ${roleName("p.proowner")} as k, pg_get_functiondef(p.oid) as d
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${USER_NS} and p.prokind in ('f', 'p') and ${NOT_EXT("p.oid", "pg_proc")}`.execute(db)
  ).rows
    .map((r) => `-- ${r.k}\n${r.d.trimEnd()}`)
    .sort(byCodePoint);
  // Quyền (ACL) — ACL null = mặc định của Postgres (acldefault), nên EXECUTE mặc định của PUBLIC trên hàm cũng nằm trong ảnh chụp.
  // Mỗi dòng: loại đối tượng · tên · role được cấp · quyền (· grant option). Chủ sở hữu ở mục tương ứng; `<admin>` = role migrate.
  const grants = [
    ...(await lines(
      sql<{ l: string }>`
        select 'table ' || n.nspname || '.' || c.relname || ' ' || ${roleName("a.grantee")} || ' ' || a.privilege_type || ${grantOpt} as l
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where ${USER_NS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${NOT_EXT("c.oid", "pg_class")}`,
      db,
    )),
    ...(await lines(
      sql<{ l: string }>`
        select 'column ' || n.nspname || '.' || c.relname || '.' || t.attname || ' ' || ${roleName("a.grantee")} || ' ' || a.privilege_type || ${grantOpt} as l
        from pg_attribute t
        join pg_class c on c.oid = t.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(t.attacl) a
        where ${USER_NS} and t.attacl is not null and not t.attisdropped and ${NOT_EXT("c.oid", "pg_class")}`,
      db,
    )),
    ...(await lines(
      sql<{ l: string }>`
        select 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || ${roleName("a.grantee")} || ' ' || a.privilege_type || ${grantOpt} as l
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where ${USER_NS} and p.prokind in ('f', 'p') and ${NOT_EXT("p.oid", "pg_proc")}`,
      db,
    )),
    ...(await lines(
      sql<{ l: string }>`
        select 'schema ' || n.nspname || ' ' || ${roleName("a.grantee")} || ' ' || a.privilege_type || ${grantOpt} as l
        from pg_namespace n
        cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        where ${USER_NS} and ${NOT_EXT("n.oid", "pg_namespace")}`,
      db,
    )),
  ].sort(byCodePoint);

  const header = `# Ảnh chụp schema CSDL sau migrateToLatest (DB-MIG-001) — SINH và so khớp bởi packages/testkit/src/schema-drift.db.test.ts.
# Đọc từ pg_catalog (tên, không OID; sắp theo tên; chủ sở hữu chuẩn hoá <admin> = role migrate; chỉ Postgres 17). Schema đổi (migration mới) mà file này không đổi theo → test đỏ.
# Cập nhật có chủ đích SAU KHI xem diff và xác nhận đúng ý migration: ${REGEN}
`;
  return `${header}
${await section("schemas", schemas)}
${await section("extensions", extensions)}
${await section("types (enum, domain)", types)}
${await section("tables", tables)}
${await section("columns", columns)}
${await section("constraints", constraints)}
${await section("indexes", indexes)}
${await section("policies (RLS)", policies)}
${await section("triggers", triggers)}
${await section("functions", functions)}
${await section("grants (bảng, cột, hàm, schema)", grants)}`;
}

describe("schema-drift — ảnh chụp schema ↔ docs/db/schema.snapshot.txt (DB-MIG-001)", () => {
  it(`schema sau migrate khớp file đã commit; lệch → đỏ kèm diff. Cập nhật có chủ đích: ${REGEN}`, async () => {
    const actual = await schemaSnapshot(t.admin);
    try {
      await expect(actual).toMatchFileSnapshot(SNAPSHOT_FILE);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Schema CSDL lệch docs/db/schema.snapshot.txt (DB-MIG-001). Nếu thay đổi là CÓ CHỦ ĐÍCH (migration mới), xem diff rồi chạy \`${REGEN}\` và commit file; ` +
          `nếu KHÔNG (sửa tay trên CSDL / migration đã áp bị sửa) thì hoàn lại thay đổi.\n${msg}`,
        { cause: e },
      );
    }
  });

  it("ảnh chụp ổn định: hai lần chụp liên tiếp giống hệt; có đủ các mục chính (không rỗng)", async () => {
    const a = await schemaSnapshot(t.admin);
    expect(await schemaSnapshot(t.admin)).toBe(a);
    for (const h of [
      "## tables",
      "## columns",
      "## constraints",
      "## indexes",
      "## policies (RLS)",
      "## triggers",
      "## functions",
    ]) {
      expect(a).toContain(h);
      expect(a).not.toMatch(new RegExp(`${h.replace(/[()]/g, "\\$&")} \\(0\\)`));
    }
    // Không rò tên DB test (ngẫu nhiên mỗi lần chạy).
    expect(a).not.toMatch(/hm_t_[0-9a-f]{16}/);
  });

  it("ảnh chụp NHẠY với lệch schema: cột / RLS / index / hàm (thêm và sửa thân) / trigger / chủ sở hữu / GRANT cột, EXECUTE, schema", async () => {
    const base = await schemaSnapshot(t.admin);
    // DB riêng cho phần phá hoại để không ảnh hưởng test khác trong file.
    const probe = await createTestDb();
    try {
      const admin = probe.admin;
      const run = async (q: string) => void (await sql.raw(q).execute(admin));
      const snap = () => schemaSnapshot(admin);
      /** Chạy `change`, ảnh chụp PHẢI đổi (và chứa `marker` nếu có); chạy `undo`, ảnh chụp PHẢI về đúng bản gốc. */
      const sensitive = async (what: string, change: string[], undo: string[] | null, marker?: string) => {
        for (const q of change) await run(q);
        const changed = await snap();
        expect(changed, `${what}: ảnh chụp không đổi`).not.toBe(base);
        if (marker) expect(changed, `${what}: thiếu dấu vết`).toContain(marker);
        if (!undo) return; // ACL đi theo chủ sở hữu nên không hoàn lại nguyên trạng được — chỉ kiểm có đổi
        for (const q of undo) await run(q);
        expect(await snap(), `${what}: hoàn lại mà ảnh chụp không về bản gốc`).toBe(base);
      };
      expect(await snap()).toBe(base); // hai DB cùng template ⇒ cùng ảnh chụp
      const tbl = (
        await sql<{
          t: string;
        }>`select quote_ident(schemaname) || '.' || quote_ident(tablename) as t from pg_policies order by 1 limit 1`.execute(
          admin,
        )
      ).rows[0]?.t as string;
      expect(tbl).toBeDefined();
      const schema = tbl.split(".")[0] as string;

      await sensitive(
        "thêm cột",
        [`alter table ${tbl} add column drift_probe int`],
        [`alter table ${tbl} drop column drift_probe`],
        "drift_probe integer",
      );
      await sensitive(
        "tắt RLS",
        [`alter table ${tbl} disable row level security`],
        [`alter table ${tbl} enable row level security`],
      );
      await sensitive(
        "thêm index",
        [`create index drift_probe_idx on ${tbl} ((1))`],
        [`drop index ${schema}.drift_probe_idx`],
        "drift_probe_idx",
      );

      // Hàm mới, rồi sửa thân hàm CÓ SẴN (CREATE OR REPLACE: thêm một dòng chú thích vào thân) — cả hai phải làm ảnh chụp đổi.
      await sensitive(
        "thêm hàm",
        ["create function public.drift_probe_fn() returns int language sql as 'select 1'"],
        ["drop function public.drift_probe_fn()"],
        "public.drift_probe_fn()",
      );
      const fn = (
        await sql<{
          id: string;
          def: string;
        }>`select p.oid::regprocedure::text as id, pg_get_functiondef(p.oid) as def
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
          where n.nspname = 'app' and p.prokind = 'f' and l.lanname in ('sql', 'plpgsql') order by 1 limit 1`.execute(
          admin,
        )
      ).rows[0];
      expect(fn).toBeDefined();
      const def = fn?.def ?? "";
      const end = def.lastIndexOf("$function$");
      expect(end).toBeGreaterThan(0);
      const edited = `${def.slice(0, end)}\n-- drift_probe_body\n${def.slice(end)}`;
      await sensitive("sửa thân hàm có sẵn", [edited], [def], "drift_probe_body");

      await sensitive(
        "thêm trigger",
        [
          "create function public.drift_probe_trg() returns trigger language plpgsql as 'begin return null; end'",
          `create trigger drift_probe_trg after insert on ${tbl} for each statement execute function public.drift_probe_trg()`,
        ],
        [`drop trigger drift_probe_trg on ${tbl}`, "drop function public.drift_probe_trg()"],
        "drift_probe_trg",
      );

      // GRANT: cột, EXECUTE hàm (cho role cụ thể và PUBLIC), thu hồi EXECUTE mặc định của PUBLIC, quyền schema.
      await sensitive(
        "GRANT cột",
        ["grant update (debit, credit) on public.journal_lines to app_runtime"],
        ["revoke update (debit, credit) on public.journal_lines from app_runtime"],
        "column public.journal_lines.debit app_runtime UPDATE",
      );
      await sensitive(
        "GRANT EXECUTE hàm cho role",
        ["grant execute on function app.outbox_claim(integer) to app_runtime"],
        ["revoke execute on function app.outbox_claim(integer) from app_runtime"],
      );
      await sensitive(
        "thu hồi EXECUTE của PUBLIC",
        ["revoke execute on function app.current_org() from public"],
        ["grant execute on function app.current_org() to public"],
      );
      await sensitive(
        "GRANT CREATE trên schema",
        ["grant create on schema public to app_runtime"],
        ["revoke create on schema public from app_runtime"],
        "schema public app_runtime CREATE",
      );
      await sensitive(
        "đổi chủ sở hữu bảng",
        [`alter table ${tbl} owner to app_worker`],
        null,
        `${tbl} owner=app_worker`,
      );
    } finally {
      await probe.drop();
    }
  });
});
