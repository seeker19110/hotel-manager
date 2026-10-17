// PLAN đợt 4 T-306 + đợt 5 T-408 — rào catalog CSDL sau migrate (DB-MODEL-001/002/004/005, BASE-DATA-006): đọc information_schema/pg_catalog của
// CSDL test đã chạy đủ migration, nên cột/khoá ngoại thêm bằng migration mới bị kiểm ngay.
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db.ts";
import baseline from "./schema-guards.baseline.json" with { type: "json" };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const USER_SCHEMAS = sql`table_schema not in ('pg_catalog', 'information_schema')`;

/** Ngoại lệ có lý do (khoá `schema.bảng.cột`). Rỗng = không có ngoại lệ. */
const TIMESTAMP_EXCEPTIONS: Record<string, string> = {};
const FLOAT_MONEY_EXCEPTIONS: Record<string, string> = {};

/** Cột numeric được phép — mỗi cột một lý do; cột numeric MỚI phải được duyệt ở đây (tiền luôn là bigint đồng). */
const NUMERIC_ALLOWED: Record<string, string> = {
  "public.charges.quantity":
    "Số lượng dịch vụ thập phân (numeric(18,4)); thành tiền làm tròn một lần theo DOMAIN-MODEL INV-G3",
  "public.charges.unit_price":
    "Đơn giá có phần thập phân theo đơn vị dịch vụ (numeric(18,4)); thành tiền bigint đồng — INV-G3",
  "public.invoice_lines.quantity": "Số lượng dòng phiếu (numeric(18,4)) — INV-G3",
  "public.invoice_lines.unit_price": "Đơn giá dòng phiếu (numeric(18,4)); amount của dòng là bigint — INV-G3",
  "public.service_prices.unit_price": "Bảng giá dịch vụ theo đơn vị (numeric(18,4)) — INV-G3",
  "public.meters.initial_value": "Chỉ số công tơ vật lý (kWh/m³) 3 chữ số thập phân, không phải tiền",
  "public.meter_readings.value": "Chỉ số công tơ vật lý (kWh/m³) 3 chữ số thập phân, không phải tiền",
  "public.meter_events.old_final_value": "Chỉ số công tơ vật lý khi thay công tơ, không phải tiền",
  "public.meter_events.new_initial_value": "Chỉ số công tơ vật lý khi thay công tơ, không phải tiền",
};

/** Tên cột có nghĩa tiền ⇒ kiểu bigint (số nguyên đồng). Ngoại lệ có lý do. */
const MONEY_NAME = /(^|_)(amount|balance|total|price|debit|credit|rent|cost|paid|fee)s?(_|$)/;
const MONEY_NOT_BIGINT: Record<string, string> = {
  "public.import_batches.expected_totals":
    "jsonb tổng theo loại (số nguyên đồng) — kiểm ở app/IMPORT_TOTALS_MISMATCH, không phải một giá trị tiền",
  "public.import_batches.actual_totals":
    "jsonb tổng theo loại (số nguyên đồng) — kiểm ở app/IMPORT_TOTALS_MISMATCH, không phải một giá trị tiền",
  "public.lease_settlements.fees":
    "jsonb danh sách khoản phí quyết toán, mỗi khoản số nguyên đồng; tổng quyết toán là cột bigint riêng",
  "public.reservation_items.nightly_prices":
    "jsonb giá từng đêm đã chốt lúc báo giá (số nguyên đồng); thành tiền là cột bigint riêng",
  ...Object.fromEntries(
    Object.entries(NUMERIC_ALLOWED)
      .filter(([k]) => k.endsWith("unit_price"))
      .map(([k]) => [k, "Đơn giá numeric đã duyệt ở NUMERIC_ALLOWED"]),
  ),
};

interface Col {
  key: string;
  data_type: string;
  udt_name: string;
}
async function columns(): Promise<Col[]> {
  const r = await sql<Col>`
    select table_schema || '.' || table_name || '.' || column_name as key, data_type, udt_name
    from information_schema.columns
    where ${USER_SCHEMAS}
      and (table_schema, table_name) in (select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE')
    order by 1`.execute(t.admin);
  return r.rows;
}

describe("schema-guards — thời điểm luôn timestamptz (DB-MODEL-001, BASE-DATA-006)", () => {
  it("không cột `timestamp without time zone` (ngoại lệ có lý do)", async () => {
    const bad = (await columns()).filter(
      (c) => c.data_type === "timestamp without time zone" && !(c.key in TIMESTAMP_EXCEPTIONS),
    );
    expect(bad.map((c) => c.key)).toEqual([]);
  });

  it("cột tên *_at / *At (thời điểm) đều là timestamptz — không date/text/bigint", async () => {
    const bad = (await columns()).filter(
      (c) => /(_at|At)$/.test(c.key.split(".").pop() as string) && c.data_type !== "timestamp with time zone",
    );
    expect(bad.map((c) => `${c.key}: ${c.data_type}`)).toEqual([]);
  });

  it("có cột timestamptz (bảo đảm truy vấn catalog không rỗng)", async () => {
    const n = (await columns()).filter((c) => c.data_type === "timestamp with time zone").length;
    expect(n).toBeGreaterThan(100);
  });

  it("ca biên: chèn '…+07:00' đọc lại đúng tức thời UTC (không lệch múi giờ phiên)", async () => {
    for (const tz of ["UTC", "Asia/Ho_Chi_Minh", "America/Los_Angeles"]) {
      const r = await sql<{ iso: string }>`
        select to_char(('2026-10-16 09:30:00+07:00'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as iso
        from (select set_config('TimeZone', ${tz}, true)) s`.execute(t.admin);
      expect(r.rows[0]?.iso).toBe("2026-10-16T02:30:00Z");
    }
  });
});

describe("schema-guards — kiểu cột tiền (DB-MODEL-002)", () => {
  it("không cột real/double precision/money (ngoại lệ có lý do)", async () => {
    const bad = (await columns()).filter(
      (c) =>
        ["real", "double precision", "money"].includes(c.data_type) && !(c.key in FLOAT_MONEY_EXCEPTIONS),
    );
    expect(bad.map((c) => `${c.key}: ${c.data_type}`)).toEqual([]);
  });

  it("cột numeric chỉ là các cột đã duyệt kèm lý do (cột numeric MỚI → đỏ; mục thừa → đỏ)", async () => {
    const numeric = (await columns()).filter((c) => c.data_type === "numeric").map((c) => c.key);
    expect(numeric.filter((k) => !(k in NUMERIC_ALLOWED))).toEqual([]);
    expect(Object.keys(NUMERIC_ALLOWED).filter((k) => !numeric.includes(k))).toEqual([]);
    for (const reason of Object.values(NUMERIC_ALLOWED)) expect(reason.length).toBeGreaterThan(20);
  });

  it("cột có tên nghĩa tiền (amount/balance/total/price/debit/credit/rent/cost/paid/fee) là bigint", async () => {
    const bad = (await columns()).filter((c) => {
      const name = c.key.split(".").pop() as string;
      // `*_id` là khoá tham chiếu (vd. fee_invoice_id), không phải số tiền.
      return (
        MONEY_NAME.test(name) &&
        !name.endsWith("_id") &&
        c.data_type !== "bigint" &&
        !(c.key in MONEY_NOT_BIGINT)
      );
    });
    expect(bad.map((c) => `${c.key}: ${c.data_type}`)).toEqual([]);
  });
});

interface FkInfo {
  tbl: string;
  cols: string[];
}
interface IdxInfo {
  tbl: string;
  name: string;
  /** Tên cột khoá (không gồm INCLUDE); biểu thức giữ nguyên văn. */
  keys: string[];
  /** Từng khoá: opclass/collation/thứ tự (DESC, NULLS FIRST) — hai index chỉ thay thế được nhau khi khớp hết. */
  sig: string[];
  pred: string | null;
  valid: boolean;
  unique: boolean;
  hasInclude: boolean;
  am: string;
}

async function loadFks(db: Kysely<unknown>): Promise<FkInfo[]> {
  const r = await sql<{ tbl: string; cols: string[] }>`
    select c.conrelid::regclass::text as tbl,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) as cols
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname not in ('pg_catalog', 'information_schema')`.execute(db);
  return r.rows;
}

async function loadIndexes(db: Kysely<unknown>): Promise<IdxInfo[]> {
  const r = await sql<{
    tbl: string;
    name: string;
    keys: string[];
    sig: string[];
    pred: string | null;
    valid: boolean;
    unique: boolean;
    has_include: boolean;
    am: string;
  }>`
    select i.indrelid::regclass::text as tbl, ic.relname::text as name,
      array(select case when k.attnum <> 0 then a.attname::text else pg_get_indexdef(i.indexrelid, k.ord::int, true) end
            from unnest((string_to_array(i.indkey::text, ' ')::int2[])[1:i.indnkeyatts]) with ordinality k(attnum, ord)
            left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum order by k.ord) as keys,
      array(select (string_to_array(i.indclass::text, ' '))[k] || '/' || (string_to_array(i.indcollation::text, ' '))[k] || '/' || (string_to_array(i.indoption::text, ' '))[k]
            from generate_series(1, i.indnkeyatts::int) k order by k) as sig,
      pg_get_expr(i.indpred, i.indrelid) as pred,
      i.indisvalid as valid, (i.indisunique or i.indisprimary or i.indisexclusion) as "unique",
      i.indnatts > i.indnkeyatts as has_include, am.amname::text as am
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
    join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`.execute(db);
  return r.rows.map((x) => ({ ...x, hasInclude: x.has_include }));
}

/**
 * Index `ix` phục vụ tra ngược FK `fk` (cha → con) khi:
 *  (a) hợp lệ và hoặc không một phần, hoặc một phần với vị từ đúng `X IS NOT NULL` trên chính một cột FK (tra theo `X = $1` kéo theo
 *      X không NULL nên planner dùng được index một phần đó);
 *  (b) các cột FK là tiền tố (theo tập) của khoá index; hoặc index mở đầu bằng `organization_id` rồi tới các cột FK còn lại làm tiền tố
 *      (FK ghép `(organization_id, property_id, X)`: `property_id` do cha `X` quyết định nên `(organization_id, X, …)` tra đủ chính xác).
 */
function covers(ix: IdxInfo, fk: FkInfo): boolean {
  if (ix.tbl !== fk.tbl || !ix.valid) return false;
  const notNull = fk.cols.filter((c) => c !== "organization_id").map((c) => `(${c} IS NOT NULL)`);
  if (ix.pred !== null && !notNull.includes(ix.pred)) return false;
  if (fk.cols.every((c) => ix.keys.slice(0, fk.cols.length).includes(c))) return true;
  if (fk.cols.includes("organization_id") && ix.keys[0] === "organization_id") {
    const rest = fk.cols.filter((c) => c !== "organization_id");
    const key = rest.length > 1 ? rest.filter((c) => c !== "property_id") : rest;
    const after = ix.keys.slice(1, 1 + key.length);
    return key.length > 0 && key.every((c) => after.includes(c));
  }
  return false;
}

async function fksWithoutIndex(db: Kysely<unknown>): Promise<string[]> {
  const [fks, idx] = await Promise.all([loadFks(db), loadIndexes(db)]);
  return fks
    .filter((fk) => !idx.some((ix) => covers(ix, fk)))
    .map((fk) => `${fk.tbl}(${fk.cols.join(",")})`)
    .sort();
}

/** Index thừa: một index khác cùng bảng/vị từ/kiểu sắp xếp mà khoá của nó là tiền tố khoá của index kia. Index unique/PK/exclusion
 *  không bị coi là thừa (đang thực thi ràng buộc). */
async function redundantIndexes(db: Kysely<unknown>): Promise<string[]> {
  const idx = (await loadIndexes(db)).filter((x) => x.valid && x.am === "btree");
  const out: string[] = [];
  for (const i of idx) {
    if (i.unique || i.hasInclude) continue;
    const j = idx.find(
      (o) =>
        o.name !== i.name &&
        o.tbl === i.tbl &&
        o.pred === i.pred &&
        o.keys.length >= i.keys.length &&
        i.keys.every((k, n) => k === o.keys[n] && i.sig[n] === o.sig[n]) &&
        (o.keys.length > i.keys.length || o.unique || o.name < i.name),
    );
    if (j) out.push(`${i.tbl}.${i.name} (${i.keys.join(",")}) ⊆ ${j.name} (${j.keys.join(",")})`);
  }
  return out.sort();
}

/** Ngoại lệ có lý do (`bảng.index`). Rỗng = không có index thừa nào được phép. */
const REDUNDANT_INDEX_ALLOWED: Record<string, string> = {};

describe("schema-guards — khoá ngoại có index hỗ trợ (DB-MODEL-004, ratchet)", () => {
  it("không có FK mới thiếu index (thêm index bằng migration mới — không thêm vào nền)", async () => {
    const missing = await fksWithoutIndex(t.admin);
    expect(missing.filter((k) => !(k in baseline.muc))).toEqual([]);
  });

  it("nền không có mục thừa: FK đã có index/đã gỡ thì xoá khỏi nền (ratchet chỉ co lại)", async () => {
    const missing = await fksWithoutIndex(t.admin);
    expect(Object.keys(baseline.muc).filter((k) => !missing.includes(k))).toEqual([]);
  });

  it("mỗi mục nền gắn một lý do đã khai", async () => {
    const reasons = baseline.ly_do as Record<string, string>;
    for (const [k, code] of Object.entries(baseline.muc)) expect(reasons[code], k).toBeDefined();
    for (const reason of Object.values(reasons)) expect(reason.length).toBeGreaterThan(40);
  });

  it("phát hiện đúng: FK không index bị bắt, thêm index đủ tiền tố thì hết, index một phần không tính", async () => {
    await sql`create table sg_parent (a int, b int, primary key (a, b))`.execute(t.admin);
    await sql`create table sg_child (id int primary key, x int, y int, constraint fk_sg foreign key (x, y) references sg_parent (a, b))`.execute(
      t.admin,
    );
    try {
      expect(await fksWithoutIndex(t.admin)).toContain("sg_child(x,y)");
      await sql`create index sg_partial on sg_child (x, y) where id > 0`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).toContain("sg_child(x,y)");
      await sql`create index sg_x on sg_child (x)`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).toContain("sg_child(x,y)"); // chỉ phủ cột đầu
      await sql`create index sg_yx on sg_child (y, x, id)`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).not.toContain("sg_child(x,y)"); // {y,x} là tiền tố theo tập
    } finally {
      await sql`drop table sg_child`.execute(t.admin);
      await sql`drop table sg_parent`.execute(t.admin);
    }
  });

  it("phát hiện đúng: index một phần `X IS NOT NULL` và `(organization_id, X…)` phủ FK ghép (organization_id, property_id, X)", async () => {
    await sql`create table sg_p (organization_id int, property_id int, id int, primary key (organization_id, property_id, id))`.execute(
      t.admin,
    );
    await sql`create table sg_c (pk int primary key, organization_id int, property_id int, x int, y int,
      constraint fk_sg_c foreign key (organization_id, property_id, x) references sg_p (organization_id, property_id, id))`.execute(
      t.admin,
    );
    try {
      const key = "sg_c(organization_id,property_id,x)";
      expect(await fksWithoutIndex(t.admin)).toContain(key);
      await sql`create index sg_c_part on sg_c (organization_id, property_id, x) where pk > 0`.execute(
        t.admin,
      );
      expect(await fksWithoutIndex(t.admin)).toContain(key); // vị từ lạ ⇒ không tính
      await sql`create index sg_c_org on sg_c (organization_id)`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).toContain(key); // thiếu cột x
      await sql`create index sg_c_wrong on sg_c (organization_id, y, x)`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).toContain(key); // x không nằm ngay sau organization_id
      await sql`create index sg_c_notnull on sg_c (organization_id, x) where x is not null`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).not.toContain(key); // (b) + vị từ X IS NOT NULL
      await sql`drop index sg_c_notnull`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).toContain(key);
      await sql`create index sg_c_plain on sg_c (organization_id, x, y)`.execute(t.admin);
      expect(await fksWithoutIndex(t.admin)).not.toContain(key);
      await sql`drop index sg_c_plain`.execute(t.admin);
      await sql`create index sg_c_xnn on sg_c (organization_id, property_id, x) where x is not null`.execute(
        t.admin,
      );
      expect(await fksWithoutIndex(t.admin)).not.toContain(key); // (a) một phần X IS NOT NULL trên đúng cột FK
    } finally {
      await sql`drop table sg_c`.execute(t.admin);
      await sql`drop table sg_p`.execute(t.admin);
    }
  });
});

describe("schema-guards — index thừa (DB-PERF-002)", () => {
  it("không index ixfk_* nào thừa: mọi FK nó phục vụ đã có index khác phục vụ (bỏ ixfk đó, đừng giữ)", async () => {
    const [fks, idx] = await Promise.all([loadFks(t.admin), loadIndexes(t.admin)]);
    const redundant: string[] = [];
    for (const ix of idx.filter((x) => x.name.startsWith("ixfk_"))) {
      const served = fks.filter((fk) => covers(ix, fk));
      const others = (fk: FkInfo) => idx.some((o) => o.name !== ix.name && covers(o, fk));
      if (served.length === 0 || served.every(others)) redundant.push(ix.name);
    }
    expect(redundant.sort()).toEqual([]);
  });

  it("không có hai index cùng bảng mà một cái là tiền tố cột của cái kia với cùng vị từ (ngoại lệ có lý do)", async () => {
    const found = await redundantIndexes(t.admin);
    expect(
      found.filter((f) => !Object.keys(REDUNDANT_INDEX_ALLOWED).some((k) => f.startsWith(`${k} `))),
    ).toEqual([]);
    for (const [k, reason] of Object.entries(REDUNDANT_INDEX_ALLOWED)) {
      expect(reason.length, k).toBeGreaterThan(20);
      expect(
        found.some((f) => f.startsWith(`${k} `)),
        `${k} không còn thừa — xoá khỏi ngoại lệ`,
      ).toBe(true);
    }
  });

  it("phát hiện đúng: tiền tố cùng vị từ bị bắt; khác vị từ, unique, khác thứ tự sắp xếp thì không", async () => {
    await sql`create table sg_r (id int primary key, a int, b int, c int)`.execute(t.admin);
    try {
      await sql`create index sg_r_a on sg_r (a)`.execute(t.admin);
      expect(await redundantIndexes(t.admin)).toEqual([]);
      await sql`create index sg_r_ab on sg_r (a, b)`.execute(t.admin);
      expect((await redundantIndexes(t.admin)).map((x) => x.split(" ")[0])).toEqual(["sg_r.sg_r_a"]);
      await sql`drop index sg_r_a`.execute(t.admin);
      await sql`create index sg_r_a_part on sg_r (a) where b > 0`.execute(t.admin);
      expect(await redundantIndexes(t.admin)).toEqual([]); // khác vị từ
      await sql`drop index sg_r_a_part`.execute(t.admin);
      await sql`create index sg_r_a_desc on sg_r (a desc)`.execute(t.admin);
      expect(await redundantIndexes(t.admin)).toEqual([]); // khác thứ tự sắp xếp
      await sql`drop index sg_r_a_desc`.execute(t.admin);
      await sql`create unique index sg_r_uq_a on sg_r (a)`.execute(t.admin);
      expect(await redundantIndexes(t.admin)).toEqual([]); // unique: đang thực thi ràng buộc
      await sql`create index sg_r_dup1 on sg_r (c)`.execute(t.admin);
      await sql`create index sg_r_dup2 on sg_r (c)`.execute(t.admin);
      expect((await redundantIndexes(t.admin)).map((x) => x.split(" ")[0])).toEqual(["sg_r.sg_r_dup2"]); // trùng hệt: chỉ một cái bị bắt
    } finally {
      await sql`drop table sg_r`.execute(t.admin);
    }
  });
});

describe("schema-guards — ràng buộc toàn vẹn (DB-MODEL-004 ON DELETE, DB-MODEL-005)", () => {
  /** Mọi FK còn lại dùng NO ACTION (mặc định, chặn xoá cha còn con). Chỉ hai ngoại lệ, mỗi cái một lý do. */
  const FK_DELETE_ALLOWED: Record<string, string> = {
    fk_memberships_auth_user:
      "RESTRICT: không xoá tài khoản đăng nhập khi còn membership (ẩn danh hoá thay vì xoá).",
    account_userId_fkey:
      "CASCADE (Better Auth): tài khoản liên kết thuộc về người dùng đăng nhập, hết người dùng thì hết.",
    session_userId_fkey: "CASCADE (Better Auth): phiên đăng nhập chỉ tồn tại khi còn người dùng.",
    twoFactor_userId_fkey:
      "CASCADE (Better Auth): bí mật TOTP gắn với người dùng, xoá người dùng phải xoá luôn.",
    fk_property_scopes_memberships:
      "CASCADE: phạm vi cơ sở chỉ là bảng nối của membership, hết membership thì hết phạm vi.",
  };

  it("hành động ON DELETE khác NO ACTION chỉ ở các FK đã khai kèm lý do (không CASCADE/SET NULL lén vào dữ liệu tiền/tồn)", async () => {
    const r = await sql<{ name: string }>`
      select conname as name from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and c.confdeltype <> 'a' and n.nspname not in ('pg_catalog', 'information_schema')`.execute(
      t.admin,
    );
    const names = r.rows.map((x) => x.name).sort();
    expect(names).toEqual(Object.keys(FK_DELETE_ALLOWED).sort());
    for (const reason of Object.values(FK_DELETE_ALLOWED)) expect(reason.length).toBeGreaterThan(20);
  });

  it("cột trạng thái/loại/phương thức (status, kind, type, method, role, purpose, source, severity, priority) đều có CHECK ∈ tập", async () => {
    const r = await sql<{ key: string }>`
      select c.table_name || '.' || c.column_name as key
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.column_name in ('status', 'kind', 'type', 'method', 'role', 'purpose', 'source', 'severity', 'priority')
        and c.table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
        and not exists (
          select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
          where k.contype = 'c' and k.conrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
            and a.attname = c.column_name)
      order by 1`.execute(t.admin);
    expect(r.rows.map((x) => x.key)).toEqual([]);
  });

  it("số CHECK trong schema không giảm (bất biến đơn giản nằm ở CSDL, không chuyển sang app)", async () => {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace
      where c.contype = 'c' and s.nspname = 'public'`.execute(t.admin);
    expect(r.rows[0]?.n).toBeGreaterThanOrEqual(375);
  });

  it("số cột NULL theo bảng khớp nền ratchet (cột NULL mới/bớt phải sửa nền có chủ đích)", async () => {
    const r = await sql<{ t: string; n: number }>`
      select table_name as t, count(*)::int as n from information_schema.columns
      where table_schema = 'public' and is_nullable = 'YES'
        and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
      group by 1 order by 1`.execute(t.admin);
    const actual = Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
    expect(actual).toEqual(baseline.nullable);
  });
});
