// PLAN đợt 4 T-306 + đợt 5 T-408 — rào catalog CSDL sau migrate (DB-MODEL-001/002/004/005, BASE-DATA-006): đọc information_schema/pg_catalog của
// CSDL test đã chạy đủ migration, nên cột/khoá ngoại thêm bằng migration mới bị kiểm ngay.
import { sql } from "kysely";
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

describe("schema-guards — khoá ngoại có index hỗ trợ (DB-MODEL-004, ratchet)", () => {
  async function fksWithoutIndex(): Promise<string[]> {
    const r = await sql<{ tbl: string; cols: string; indexed: boolean }>`
      select c.conrelid::regclass::text as tbl,
        (select string_agg(a.attname::text, ',' order by k.ord)
           from unnest(c.conkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
        -- Có index hợp lệ, không một phần, mà các cột FK là tiền tố (theo tập) của khoá index.
        exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indisvalid and i.indpred is null
            and (string_to_array(i.indkey::text, ' ')::int[])[1:cardinality(c.conkey)] @> c.conkey::int[]
        ) as indexed
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname not in ('pg_catalog', 'information_schema')`.execute(t.admin);
    return r.rows
      .filter((x) => !x.indexed)
      .map((x) => `${x.tbl}(${x.cols})`)
      .sort();
  }

  it("không có FK mới thiếu index (thêm index bằng migration mới — không thêm vào nền)", async () => {
    const missing = await fksWithoutIndex();
    expect(missing.filter((k) => !(k in baseline.muc))).toEqual([]);
  });

  it("nền không có mục thừa: FK đã có index/đã gỡ thì xoá khỏi nền (ratchet chỉ co lại)", async () => {
    const missing = await fksWithoutIndex();
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
      expect(await fksWithoutIndex()).toContain("sg_child(x,y)");
      await sql`create index sg_partial on sg_child (x, y) where id > 0`.execute(t.admin);
      expect(await fksWithoutIndex()).toContain("sg_child(x,y)");
      await sql`create index sg_x on sg_child (x)`.execute(t.admin);
      expect(await fksWithoutIndex()).toContain("sg_child(x,y)"); // chỉ phủ cột đầu
      await sql`create index sg_yx on sg_child (y, x, id)`.execute(t.admin);
      expect(await fksWithoutIndex()).not.toContain("sg_child(x,y)"); // {y,x} là tiền tố theo tập
    } finally {
      await sql`drop table sg_child`.execute(t.admin);
      await sql`drop table sg_parent`.execute(t.admin);
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
