// PLAN đợt 5 T-408 — EXPLAIN truy vấn nóng trên Postgres thật (DB-PERF-001): today, folio, claim outbox/notification, billing,
// danh sách audit. Cách đánh giá:
//   1. Truy vấn của hàm app (today/audit/billing) được BẮT NGUYÊN VĂN bằng log của Kysely khi chạy hàm thật (không sao chép SQL);
//      truy vấn nằm trong hàm SQL của migration/ở app mà khó gọi riêng (folio, claim outbox/notification) viết tay kèm đoạn
//      "dấu vân tay" phải còn trong mã nguồn (đổi truy vấn mà quên cập nhật ở đây → đỏ).
//   2. Mỗi truy vấn chạy `EXPLAIN (FORMAT JSON)` (không ANALYZE — không thực thi) với vai trò app_runtime trong ngữ cảnh tổ chức
//      (cùng điều kiện RLS như thật). Bảng seed nhỏ nên planner coi Seq Scan là rẻ: đặt `enable_seqscan = off` để bất kỳ Seq Scan
//      còn sót nghĩa là KHÔNG có index dùng được; không Seq Scan trên bảng thuộc danh sách "lớn" (BIG_TABLES) ở mọi nút kế hoạch.
//      Không Seq Scan CHƯA đủ (một Index Scan chỉ theo `organization_id` rồi lọc bằng Filter vẫn qua): truy vấn tra theo khoá/bộ lọc còn
//      khai CỘT CHỌN LỌC (`Expect`) và bộ đánh giá đòi cột đó nằm trong Index Cond/Recheck Cond của nút quét, trong đoạn tiền tố liên tiếp
//      của khoá index (Postgres 17 không có skip scan: cột đứng sau một cột chưa bị ràng buộc thì phải quét cả dải). Cột không có index
//      ⇒ đỏ (ca âm ở "bộ đánh giá"). Bảng thật quá nhỏ nên planner hoà giá giữa các index: truy vấn folio chạy trên bảng bóng (schema `perf`,
//      cùng cột + cùng index, 60.000 dòng đã ANALYZE) để lựa chọn index có nghĩa; audit dùng dữ liệu 30.000 dòng thật.
//      Thẻ "today"/kỳ thu là truy vấn toàn tổ chức (lọc theo trạng thái, không theo khoá): chỉ kiểm không Seq Scan.
//   2b. (T-503, DB-PERF-001) Bằng chứng kế hoạch nằm ở `docs/db/explain/<truy vấn>.txt`: mỗi truy vấn nóng có một tệp ghi bảng · kiểu quét
//      (Index/Seq Scan) · tên index · cột bị ràng buộc trong tiền tố khoá — bản chuẩn hoá của EXPLAIN, không có chi phí/số hàng/thời gian
//      (những thứ này dao động giữa các lần chạy) nên so khớp được. Test so khớp bằng `toMatchFileSnapshot`: đổi truy vấn/index làm kế
//      hoạch đổi → đỏ kèm diff; cập nhật có chủ đích bằng `pnpm vitest run --project db db-perf -u` (CI không tự ghi tệp mới).
//   3. Thêm kiểm chứng "tự nhiên" (seqscan bật) trên dữ liệu lớn hơn (30.000 dòng audit/outbox) cho ba truy vấn quét tuần tự đắt nhất.

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withTenant } from "@hm/db";
import { activateLease, createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { CompiledQuery, Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "./access/actor.ts";
import { listEvents } from "./audit/events.ts";
import { createPeriod, previewPeriod } from "./billing/billing.ts";
import { okAs, ownerOf } from "./testing/helpers.ts";
import { getSummary, listItems, TODAY_CARDS } from "./today/today.ts";

const U = "00000000-0000-4000-8000-000000000001";
let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let capturing: Kysely<unknown>;
let capturePool: pg.Pool;
const captured: { sql: string; params: unknown[] }[] = [];

/** Bảng "lớn" (tăng theo thời gian/số cơ sở): Seq Scan trên các bảng này ở truy vấn nóng là lỗi. */
const BIG_TABLES = new Set([
  "audit_events",
  "outbox",
  "notification_deliveries",
  "notifications",
  "idempotency_keys",
  "invoices",
  "invoice_lines",
  "charges",
  "payments",
  "payment_allocations",
  "journal_entries",
  "journal_lines",
  "reservations",
  "reservation_items",
  "stays",
  "leases",
  "lease_versions",
  "meter_readings",
  "bank_transactions",
  "tasks",
  "work_orders",
  "residence_notices",
  "import_rows",
  "units",
  "persons",
]);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
}

/** Một lần quét bảng bằng index: bảng, tên index, điều kiện index (Index Cond; với Bitmap là Index Cond của nút con). */
interface IndexScan {
  table: string;
  index: string;
  cond: string;
}
function indexScans(node: PlanNode, heap?: string, out: IndexScan[] = []): IndexScan[] {
  const rel = node["Relation Name"] ?? heap;
  if (node["Index Name"] && rel)
    out.push({ table: rel, index: node["Index Name"], cond: node["Index Cond"] ?? "" });
  for (const c of node.Plans ?? []) indexScans(c, node["Node Type"] === "Bitmap Heap Scan" ? rel : heap, out);
  return out;
}

/** Cột chọn lọc kỳ vọng theo bảng: `cols` phải nằm trong tiền tố liên tiếp của khoá index đang dùng và trong Index/Recheck Cond;
 *  `index` (tuỳ chọn) khẳng định đúng index (vd. index một phần). */
type Expect = Record<string, { cols?: string[]; index?: string }>;

/** Khoá (cột) của mọi index theo tên, ở mọi schema người dùng. */
async function indexKeys(): Promise<Map<string, string[]>> {
  const r = await sql<{ name: string; keys: string[] }>`
    select ic.relname::text as name,
      array(select a.attname::text from unnest((string_to_array(i.indkey::text, ' ')::int2[])[1:i.indnkeyatts]) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum order by k.ord) as keys
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = ic.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`.execute(t.admin);
  return new Map(r.rows.map((x) => [x.name, x.keys]));
}

/** Đoạn tiền tố liên tiếp của khoá index mà Index Cond ràng buộc (dừng sau cột đầu tiên chỉ bị chặn khoảng, hoặc không có điều kiện). */
function boundPrefix(keys: string[], cond: string): string[] {
  const run: string[] = [];
  for (const k of keys) {
    const m = new RegExp(`\\b${k}\\s*(=|>=|<=|<|>)\\s`).exec(cond);
    if (!m) break;
    run.push(k);
    if (m[1] !== "=") break;
  }
  return run;
}

/** Vi phạm "cột chọn lọc" của một kế hoạch (rỗng = đạt). */
function selectiveProblems(plan: PlanNode, expect: Expect, keys: Map<string, string[]>): string[] {
  const scans = indexScans(plan);
  const bad: string[] = [];
  for (const [table, want] of Object.entries(expect)) {
    const mine = scans.filter((x) => x.table === table);
    if (mine.length === 0) {
      bad.push(`${table}: không quét bằng index nào`);
      continue;
    }
    if (want.index && !mine.some((x) => x.index === want.index))
      bad.push(`${table}: dùng ${mine.map((x) => x.index).join(",")}, cần ${want.index}`);
    for (const col of want.cols ?? []) {
      const ok = mine.some((x) => boundPrefix(keys.get(x.index) ?? [], x.cond).includes(col));
      if (!ok)
        bad.push(
          `${table}.${col}: không nằm trong tiền tố Index Cond (${mine.map((x) => `${x.index}: ${x.cond || "∅"}`).join(" | ")})`,
        );
    }
  }
  return bad;
}
function seqScans(node: PlanNode, out: string[] = []): string[] {
  if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) out.push(node["Relation Name"]);
  for (const c of node.Plans ?? []) seqScans(c, out);
  return out;
}

/** Tệp bằng chứng kế hoạch ở `docs/db/explain/` (DB-PERF-001) — danh sách đầy đủ; test cuối đòi thư mục khớp đúng tên này. */
const EXPLAIN_DOCS = [
  "audit-list-action",
  "audit-list-actor",
  "audit-list-correlation",
  "audit-list-default",
  "audit-list-entity",
  "audit-list-property",
  "audit-list-time-range",
  "billing-preview",
  "deliveries-claim",
  "deliveries-orgs-due",
  "deliveries-sending-expired",
  "folio-charges",
  "folio-deposits",
  "folio-invoices",
  "folio-payments",
  "outbox-claim",
  "today-cards",
] as const;
type ExplainDoc = (typeof EXPLAIN_DOCS)[number];
const EXPLAIN_DIR = fileURLToPath(new URL("../../../docs/db/explain/", import.meta.url));

/**
 * Bản chuẩn hoá của một kế hoạch: mỗi lần quét một dòng `bảng · Index|Seq Scan · index (khoá) · bound=cột bị ràng buộc trong tiền tố`.
 * Gộp Index Scan/Index Only Scan/Bitmap thành "Index" (khác nhau theo visibility map/thống kê, không theo thiết kế index) và bỏ thứ tự
 * nút/kiểu join/chi phí/số hàng/tham số — chỉ giữ cái nói lên truy vấn dùng index nào, cột nào.
 * `detail = false` (truy vấn toàn tổ chức, không cột chọn lọc khai ở `expect`): bảng nhỏ nên planner hoà giá giữa các index chỉ theo
 * `organization_id` — tên index khi đó là ngẫu nhiên, ghi vào tệp sẽ dao động ⇒ chỉ giữ `bảng · Index|Seq Scan`.
 */
function planSummary(plan: PlanNode, keys: Map<string, string[]>, detail = true): string[] {
  const lines = new Set<string>();
  for (const x of indexScans(plan)) {
    const k = keys.get(x.index) ?? [];
    lines.add(
      detail
        ? `${x.table} · Index · ${x.index} (${k.join(", ")}) · bound=${boundPrefix(k, x.cond).join(",") || "-"}`
        : `${x.table} · Index`,
    );
  }
  for (const r of seqScans(plan)) lines.add(`${r} · Seq Scan`);
  return [...lines].sort();
}

/** Nhãn đoạn: đầu câu SQL (đọc được) + 8 hex băm toàn câu đã gộp khoảng trắng (phân biệt các câu cùng đầu; đổi câu ⇒ đổi nhãn ⇒ tệp phải cập nhật). */
function queryLabel(sqlText: string): string {
  const flat = sqlText.replace(/\s+/g, " ").trim();
  return `${flat.slice(0, 90)} … #${createHash("sha1").update(flat).digest("hex").slice(0, 8)}`;
}

/** Nội dung tệp `docs/db/explain/<name>.txt`: đầu tệp giải thích cách sinh; mỗi truy vấn một đoạn (sắp theo nhãn rồi nội dung). */
function explainDocText(name: string, sections: { label: string; lines: string[] }[]): string {
  const body = sections
    .map((x) => `-- ${x.label}\n${x.lines.join("\n")}\n`)
    .sort()
    .join("\n");
  return `# EXPLAIN truy vấn nóng "${name}" (DB-PERF-001) — sinh và so khớp bởi packages/app/src/db-perf.db.test.ts.
# EXPLAIN (FORMAT JSON) trên Postgres thật, enable_seqscan = off (Seq Scan còn lại = không có index dùng được), vai trò và dữ liệu theo test.
# Mỗi dòng: bảng · kiểu quét (Index gồm Index Only/Bitmap) [· index (cột khoá) · cột bị ràng buộc trong tiền tố khoá (bound) — chỉ khi truy vấn có cột chọn lọc].
# Đổi truy vấn/index làm kế hoạch đổi → test đỏ; cập nhật có chủ đích: pnpm vitest run --project db db-perf -u

${body}`;
}

async function explainAs(
  role: "runtime" | "admin",
  q: { sql: string; params: unknown[] },
  seqscan: boolean,
  searchPath?: string,
) {
  const db = role === "runtime" ? t.runtime : t.admin;
  const run = async (trx: Kysely<unknown>) => {
    await sql`select set_config('enable_seqscan', ${seqscan ? "on" : "off"}, true)`.execute(trx);
    if (searchPath) await sql`select set_config('search_path', ${searchPath}, true)`.execute(trx);
    const r = await trx.executeQuery<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
      CompiledQuery.raw(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params),
    );
    return r.rows[0]?.["QUERY PLAN"][0]?.Plan as PlanNode;
  };
  if (role === "runtime")
    return withTenant(db, { orgId: A.orgId, actorId: A.ownerMembershipId }, (trx) => run(trx));
  return db.transaction().execute((trx) => run(trx));
}

/** Truy vấn đọc (select/with … from) trong log bắt được, bỏ trùng lặp. */
function selects(): { sql: string; params: unknown[] }[] {
  const seen = new Set<string>();
  return captured.filter((q) => {
    const s = q.sql.trimStart().toLowerCase();
    if (!(s.startsWith("select") || s.startsWith("with")) || !s.includes(" from ")) return false;
    if (seen.has(q.sql)) return false;
    seen.add(q.sql);
    return true;
  });
}

/**
 * Bảng bóng cho truy vấn folio: schema `perf` có cùng cột và cùng index (LIKE … INCLUDING INDEXES) với bảng thật, đổ 60.000 dòng rồi ANALYZE.
 * Cột NOT NULL không mặc định được điền theo kiểu (khoá tổ chức/lượt ở/đặt phòng theo phân phối chọn lọc: 1/30 hàng thuộc tổ chức A,
 * ~15 hàng mỗi lượt ở/đặt phòng). Không dùng RLS/ràng buộc CHECK/FK — chỉ để planner chọn index có nghĩa.
 */
const SHADOW: Record<string, Record<string, string>> = {
  charges: { stay_id: "stay" },
  payments: { reservation_id: "stay", purpose: "'receivable'" },
  invoices: { stay_id: "stay", kind: "'folio'" },
  deposits: { reservation_id: "unique" },
};
async function buildShadowTables() {
  await sql`create schema perf`.execute(t.admin);
  for (const [table, special] of Object.entries(SHADOW)) {
    await sql
      .raw(`create table perf.${table} (like public.${table} including defaults including indexes)`)
      .execute(t.admin);
    const cols = await sql<{ column_name: string; data_type: string }>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and is_nullable = 'NO' and column_default is null
        and is_generated = 'NEVER' order by ordinal_position`.execute(t.admin);
    const value = (c: { column_name: string; data_type: string }): string => {
      if (c.column_name === "organization_id")
        return `case when g % 30 = 0 then '${A.orgId}'::uuid else gen_random_uuid() end`;
      const sp = special[c.column_name];
      if (sp === "stay")
        return `case when g % 4000 = 0 then '${U}'::uuid else md5((g % 4000)::text)::uuid end`;
      if (sp === "unique") return "md5(g::text)::uuid";
      if (sp) return sp;
      switch (c.data_type) {
        case "uuid":
          return "gen_random_uuid()";
        case "text":
        case "character varying":
          return "'x' || g";
        case "bigint":
        case "integer":
        case "smallint":
        case "numeric":
          return "g";
        case "date":
          return "current_date + (g % 3650)";
        case "timestamp with time zone":
          return "now()";
        case "boolean":
          return "false";
        case "jsonb":
          return "'{}'::jsonb";
        default:
          throw new Error(`bảng bóng ${table}: chưa hỗ trợ kiểu ${c.data_type} của cột ${c.column_name}`);
      }
    };
    const names = cols.rows.map((c) => c.column_name);
    for (const k of Object.keys(special))
      if (!names.includes(k)) {
        names.push(k);
        cols.rows.push({ column_name: k, data_type: "uuid" });
      }
    await sql
      .raw(
        `insert into perf.${table} (${names.map((n) => `"${n}"`).join(", ")})
         select ${cols.rows.map(value).join(", ")} from generate_series(1, 60000) g`,
      )
      .execute(t.admin);
    await sql.raw(`analyze perf.${table}`).execute(t.admin);
  }
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Perf", "hotel");
  owner = await ownerOf(t, A);
  capturePool = new pg.Pool({ connectionString: t.runtimeUrl, max: 2 });
  capturing = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: capturePool }),
    log(e) {
      if (e.level === "query") captured.push({ sql: e.query.sql, params: [...e.query.parameters] });
    },
  });

  // Dữ liệu vừa đủ để các nhánh truy vấn chạy: một hợp đồng đang thuê + kỳ thu, vài sự kiện audit/outbox.
  const rep = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${rep}, ${A.orgId}, 'Người thuê perf')`.execute(
    t.admin,
  );
  const { leaseId } = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    representativePersonId: rep,
    effectiveFrom: "2026-11-01",
  });
  await activateLease(t.admin, { org: A, leaseId, effectiveFrom: "2026-11-01" });

  // Dữ liệu lớn hơn cho kiểm chứng tự nhiên: 30.000 audit + 30.000 outbox (10% chưa phát) + 3 tổ chức nền.
  // 1% sự kiện thuộc cơ sở A và do người dùng (chủ) thao tác — còn lại là sự kiện cấp tổ chức của worker — để lọc theo cơ sở/người
  // thật sự chọn lọc (planner mới có lý do dùng index thay vì quét theo thời gian rồi lọc).
  await sql`
    insert into audit_events (id, organization_id, property_id, occurred_at, actor_type, actor_person_id, action, entity_type, entity_id, correlation_id)
    select gen_random_uuid(), ${A.orgId}, case when g % 100 = 0 then ${A.propertyId}::uuid end, now() - (g || ' seconds')::interval,
           case when g % 100 = 0 then 'user' else 'worker' end, case when g % 100 = 0 then ${A.ownerPersonId}::uuid end,
           'perf.event_' || chr(97 + g % 7), 'perf', gen_random_uuid(), 'perf-' || (g % 500)
    from generate_series(1, 30000) g`.execute(t.admin);
  await sql`
    insert into outbox (id, organization_id, event_type, payload, correlation_id, created_at, published_at)
    select gen_random_uuid(), ${A.orgId}, 'perf.event', '{}'::jsonb, 'perf', now() - (g || ' seconds')::interval,
           case when g % 10 = 0 then null else now() end
    from generate_series(1, 30000) g`.execute(t.admin);
  await sql`analyze`.execute(t.admin);
  await buildShadowTables();
});

afterAll(async () => {
  await capturing?.destroy();
  await t?.drop();
});

/** Kiểm các truy vấn: không Seq Scan trên bảng lớn (seqscan tắt ⇒ phải có index dùng được) và, nếu khai `expect`, đúng cột chọn lọc. */
async function expectIndexed(
  queries: { sql: string; params: unknown[] }[],
  role: "runtime" | "admin" = "runtime",
  opts: { expect?: Expect; searchPath?: string; doc?: ExplainDoc } = {},
) {
  expect(queries.length).toBeGreaterThan(0);
  const keys = opts.expect || opts.doc ? await indexKeys() : new Map<string, string[]>();
  const bad: string[] = [];
  const sections: { label: string; lines: string[] }[] = [];
  for (const q of queries) {
    const plan = await explainAs(role, q, false, opts.searchPath);
    if (opts.doc)
      sections.push({ label: queryLabel(q.sql), lines: planSummary(plan, keys, Boolean(opts.expect)) });
    const hit = seqScans(plan).filter((r) => BIG_TABLES.has(r));
    const head = q.sql.replace(/\s+/g, " ").slice(0, 160);
    if (hit.length > 0) bad.push(`${hit.join(",")} ← ${head}`);
    if (opts.expect) for (const p of selectiveProblems(plan, opts.expect, keys)) bad.push(`${p} ← ${head}`);
  }
  expect(bad).toEqual([]);
  if (opts.doc)
    await expect(explainDocText(opts.doc, sections)).toMatchFileSnapshot(`${EXPLAIN_DIR}${opts.doc}.txt`);
}

describe("db-perf — bộ đánh giá", () => {
  it("bắt được Seq Scan khi KHÔNG có index (rào không rỗng): bảng tạm không index + seqscan tắt vẫn Seq Scan", async () => {
    await sql`create table perf_probe (a int, b int)`.execute(t.admin);
    try {
      const plan = await explainAs(
        "admin",
        { sql: "select * from perf_probe where a = $1", params: [1] },
        false,
      );
      expect(seqScans(plan)).toEqual(["perf_probe"]);
      await sql`create index perf_probe_a on perf_probe (a)`.execute(t.admin);
      const withIdx = await explainAs(
        "admin",
        { sql: "select * from perf_probe where a = $1", params: [1] },
        false,
      );
      expect(seqScans(withIdx)).toEqual([]);
    } finally {
      await sql`drop table perf_probe`.execute(t.admin);
    }
  });
});

describe("db-perf — bộ đánh giá cột chọn lọc (ca âm)", () => {
  const Q = { sql: "select * from perf_probe2 where organization_id = $1 and b = $2", params: [U, 1] };
  const problems = async (expect: Expect) =>
    selectiveProblems(await explainAs("admin", Q, false), expect, await indexKeys());

  it("index chỉ theo organization_id: KHÔNG Seq Scan nhưng cột lọc không có trong Index Cond ⇒ đỏ", async () => {
    await sql`create table perf_probe2 (organization_id uuid, a int, b int)`.execute(t.admin);
    try {
      await sql`create index perf_probe2_org on perf_probe2 (organization_id)`.execute(t.admin);
      const plan = await explainAs("admin", Q, false);
      expect(seqScans(plan)).toEqual([]); // rào cũ chấp nhận kế hoạch này
      expect(await problems({ perf_probe2: { cols: ["organization_id"] } })).toEqual([]);
      expect(await problems({ perf_probe2: { cols: ["b"] } })).toEqual([
        expect.stringContaining("perf_probe2.b: không nằm trong tiền tố Index Cond"),
      ]);
      await sql`drop index perf_probe2_org`.execute(t.admin);
      await sql`create index perf_probe2_org_b on perf_probe2 (organization_id, b)`.execute(t.admin);
      expect(
        await problems({ perf_probe2: { cols: ["organization_id", "b"], index: "perf_probe2_org_b" } }),
      ).toEqual([]);
      expect(await problems({ perf_probe2: { index: "perf_probe2_org" } })).toEqual([
        expect.stringContaining("cần perf_probe2_org"),
      ]);
      // Cột chọn lọc đứng sau một cột chưa bị ràng buộc: Index Cond có mặt nhưng phải quét cả dải (không skip scan) ⇒ đỏ.
      await sql`drop index perf_probe2_org_b`.execute(t.admin);
      await sql`create index perf_probe2_org_a_b on perf_probe2 (organization_id, a, b)`.execute(t.admin);
      expect(await problems({ perf_probe2: { cols: ["b"] } })).toEqual([
        expect.stringContaining("perf_probe2.b: không nằm trong tiền tố Index Cond"),
      ]);
    } finally {
      await sql`drop table perf_probe2`.execute(t.admin);
    }
  });

  it("bảng không được quét bằng index nào (khai nhầm bảng) ⇒ đỏ; cột chặn khoảng: dừng tiền tố sau nó", async () => {
    expect(
      selectiveProblems({ "Node Type": "Seq Scan", "Relation Name": "x" }, { x: { cols: ["a"] } }, new Map()),
    ).toEqual(["x: không quét bằng index nào"]);
    expect(
      boundPrefix(
        ["organization_id", "occurred_at", "id"],
        "((organization_id = 'x') AND (occurred_at >= 'y') AND (id = 'z'))",
      ),
    ).toEqual(["organization_id", "occurred_at"]);
    expect(boundPrefix(["organization_id", "id"], "(id = 'z')")).toEqual([]);
  });
});

describe("db-perf — today (S-006…S-008)", () => {
  it("getSummary + listItems cho mọi thẻ: truy vấn thật không Seq Scan trên bảng lớn", async () => {
    captured.length = 0;
    await getSummary(capturing, owner, {});
    for (const card of TODAY_CARDS) await listItems(capturing, owner, { card });
    const qs = selects();
    expect(qs.length).toBeGreaterThanOrEqual(TODAY_CARDS.length);
    await expectIndexed(qs, "runtime", { doc: "today-cards" });
  });
});

describe("db-perf — danh sách audit (S-004, S-005)", () => {
  /** Truy vấn danh sách của một lần gọi `listEvents` (select đọc `audit_events`). */
  async function auditQuery(filter: Parameters<typeof listEvents>[2]) {
    captured.length = 0;
    await listEvents(capturing, owner, filter);
    const q = selects().find((x) => x.sql.includes("from audit_events"));
    if (!q) throw new Error("không bắt được truy vấn audit_events");
    return q;
  }
  const base = { limit: 50 };
  const entityId = randomUUID();
  // Mỗi bộ lọc khai cột chọn lọc phải nằm trong Index Cond. Mặc định (không lọc): quét có thứ tự theo (organization_id, occurred_at DESC) + LIMIT.
  const AUDIT_CASES: {
    name: string;
    filter: Parameters<typeof listEvents>[2] | (() => Parameters<typeof listEvents>[2]);
    expect: Expect;
    doc: ExplainDoc;
  }[] = [
    {
      name: "mặc định",
      filter: base,
      expect: { audit_events: { index: "ix_audit_org_time" } },
      doc: "audit-list-default",
    },
    {
      name: "cơ sở",
      filter: () => ({ ...base, propertyId: A.propertyId }),
      expect: { audit_events: { cols: ["property_id"], index: "ix_audit_property_time" } },
      doc: "audit-list-property",
    },
    {
      name: "đối tượng",
      filter: { ...base, entityType: "perf", entityId },
      expect: { audit_events: { cols: ["entity_type", "entity_id"] } },
      doc: "audit-list-entity",
    },
    {
      name: "hành động",
      filter: { ...base, action: "perf.event_b" },
      expect: { audit_events: { cols: ["action"] } },
      doc: "audit-list-action",
    },
    {
      name: "người thao tác",
      filter: () => ({ ...base, actorPersonId: A.ownerPersonId }),
      expect: { audit_events: { cols: ["actor_person_id"] } },
      doc: "audit-list-actor",
    },
    {
      name: "correlation",
      filter: { ...base, correlationId: "perf-1" },
      expect: { audit_events: { cols: ["correlation_id"] } },
      doc: "audit-list-correlation",
    },
    {
      name: "khoảng thời gian",
      filter: { ...base, from: new Date(Date.now() - 3_600_000), to: new Date() },
      expect: { audit_events: { cols: ["occurred_at"] } },
      doc: "audit-list-time-range",
    },
  ];
  for (const c of AUDIT_CASES)
    it(`bộ lọc ${c.name}: không Seq Scan và dùng index theo cột chọn lọc`, async () => {
      const q = await auditQuery(typeof c.filter === "function" ? c.filter() : c.filter);
      await expectIndexed([q], "runtime", { expect: c.expect, doc: c.doc });
    });

  it("tự nhiên (seqscan bật, 30.000 dòng): danh sách mặc định và theo hành động dùng index, không Seq Scan audit_events", async () => {
    captured.length = 0;
    await listEvents(capturing, owner, { limit: 50 });
    await listEvents(capturing, owner, { limit: 50, action: "perf.event_b" });
    for (const q of selects()) {
      const plan = await explainAs("runtime", q, true);
      expect(seqScans(plan), q.sql.slice(0, 120)).not.toContain("audit_events");
    }
  });
});

describe("db-perf — billing (S-001, kỳ thu)", () => {
  it("previewPeriod trên kỳ có hợp đồng đang thuê: truy vấn thật không Seq Scan trên bảng lớn", async () => {
    const { billingPeriodId } = await okAs(t, owner, (ctx) =>
      createPeriod(ctx, { propertyId: A.propertyId, month: "2026-11" }),
    );
    captured.length = 0;
    await previewPeriod(capturing, owner, { billingPeriodId });
    const qs = selects();
    expect(qs.length).toBeGreaterThan(3);
    await expectIndexed(qs, "runtime", { doc: "billing-preview" });
  });
});

// Truy vấn nằm trong hàm SQL/mã khó gọi riêng: viết tay, kèm dấu vân tay phải còn trong nguồn.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("db-perf — folio (S-017)", () => {
  const FOLIO: {
    name: string;
    table: string;
    col: string;
    sql: string;
    print: string[];
    doc: ExplainDoc;
  }[] = [
    {
      name: "khoản phí theo lượt ở",
      doc: "folio-charges",
      table: "charges",
      col: "stay_id",
      sql: "select id from charges where organization_id = $1 and stay_id = $2 order by business_date, created_at",
      print: ["from charges where organization_id =", "and stay_id ="],
    },
    {
      name: "thanh toán theo đặt phòng",
      doc: "folio-payments",
      table: "payments",
      col: "reservation_id",
      sql: "select id from payments where organization_id = $1 and reservation_id = $2 and purpose = 'receivable' order by created_at",
      print: ["where organization_id =", "and reservation_id =", "and purpose = 'receivable'"],
    },
    {
      name: "phiếu folio của lượt ở",
      doc: "folio-invoices",
      table: "invoices",
      col: "stay_id",
      sql: "select id from invoices where organization_id = $1 and stay_id = $2 and kind = 'folio'",
      print: ["where organization_id =", "and stay_id =", "and kind = 'folio'"],
    },
    {
      name: "cọc theo đặt phòng",
      doc: "folio-deposits",
      table: "deposits",
      col: "reservation_id",
      sql: "select id from deposits where organization_id = $1 and reservation_id = $2",
      print: ["from deposits where organization_id =", "and reservation_id ="],
    },
  ];
  it("dấu vân tay còn trong stay/folio.ts và mỗi truy vấn có index", async () => {
    const src = read("./stay/folio.ts");
    for (const f of FOLIO) for (const part of f.print) expect(src, f.name).toContain(part);
    // Bảng bóng (perf) + cột chọn lọc: org-only Index Scan + Filter không còn qua được.
    for (const f of FOLIO)
      await expectIndexed([{ sql: f.sql, params: [A.orgId, U] }], "admin", {
        expect: { [f.table]: { cols: [f.col] } },
        searchPath: "perf, public",
        doc: f.doc,
      });
  });
});

describe("db-perf — claim outbox và thông báo (worker)", () => {
  it("app.outbox_claim: dấu vân tay khớp định nghĩa ĐANG DÙNG (0047: available_at + lease) và truy vấn dùng index một phần", async () => {
    const def = (
      await sql<{
        d: string;
      }>`select pg_get_functiondef('app.outbox_claim(integer)'::regprocedure) as d`.execute(t.admin)
    ).rows[0]?.d as string;
    for (const part of [
      "WHERE o.published_at IS NULL AND o.available_at <= now()",
      "ORDER BY o.created_at, o.id",
      "FOR UPDATE SKIP LOCKED",
      "SET available_at = now() + interval '60 seconds'",
    ])
      expect(def, part).toContain(part);
    await expectIndexed(
      [
        {
          sql: "select o.id from outbox o where o.published_at is null and o.available_at <= now() order by o.created_at, o.id limit 100 for update skip locked",
          params: [],
        },
      ],
      "admin",
      { expect: { outbox: { index: "ix_outbox_unpublished" } }, doc: "outbox-claim" },
    );
  });

  it("app.claim_due_deliveries: dấu vân tay trong định nghĩa đang dùng và hai truy vấn bên trong dùng index", async () => {
    const def = (
      await sql<{
        d: string;
      }>`select pg_get_functiondef('app.claim_due_deliveries(timestamptz,integer,integer,integer,integer)'::regprocedure) as d`.execute(
        t.admin,
      )
    ).rows[0]?.d as string;
    expect(def).toContain("WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now");
    expect(def).toContain(
      "WHERE d.organization_id = o.organization_id AND d.status IN ('queued','retrying')",
    );
    const now = new Date();
    const DELIVERIES: { sql: string; params: unknown[]; cols: string[]; index: string; doc: ExplainDoc }[] = [
      {
        // Quét mọi tổ chức bằng Index Only Scan toàn index (điều kiện thời gian không ở đầu khoá — chủ ý, worker liệt kê tổ chức có việc).
        sql: "select distinct d.organization_id from notification_deliveries d where d.status in ('queued','retrying') and d.next_attempt_at <= $1::timestamptz",
        params: [now],
        cols: [],
        index: "ix_notification_deliveries_org_due",
        doc: "deliveries-orgs-due",
      },
      {
        sql: `select d.id from notification_deliveries d
              where d.organization_id = $1 and d.status in ('queued','retrying') and d.next_attempt_at <= $2::timestamptz
              order by d.next_attempt_at, d.id limit 50`,
        params: [A.orgId, now],
        cols: ["organization_id", "next_attempt_at"],
        index: "ix_notification_deliveries_org_due",
        doc: "deliveries-claim",
      },
      {
        sql: "select d.id from notification_deliveries d where d.status = 'sending' and d.locked_until < $1::timestamptz",
        params: [now],
        cols: ["locked_until"],
        index: "ix_notification_deliveries_sending",
        doc: "deliveries-sending-expired",
      },
    ];
    for (const d of DELIVERIES)
      await expectIndexed([{ sql: d.sql, params: d.params }], "admin", {
        expect: { notification_deliveries: { cols: d.cols, index: d.index } },
        doc: d.doc,
      });
  });

  it("tự nhiên (seqscan bật, 30.000 dòng): claim outbox chỉ đọc hàng chưa phát bằng index, không Seq Scan outbox", async () => {
    const plan = await explainAs(
      "admin",
      {
        sql: "select o.id from outbox o where o.published_at is null order by o.created_at, o.id limit 100",
        params: [],
      },
      true,
    );
    expect(seqScans(plan)).not.toContain("outbox");
  });
});

describe("db-perf — autovacuum riêng cho bảng ghi nhiều (DB-PERF-008)", () => {
  it("outbox/idempotency_keys/notification_deliveries/notifications/inbox dọn sớm; audit_events/journal_lines theo số hàng chèn", async () => {
    const r = await sql<{ t: string; opts: string[] | null }>`
      select c.relname as t, c.reloptions as opts from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = any(${[
        "outbox",
        "idempotency_keys",
        "notification_deliveries",
        "notifications",
        "inbox",
        "audit_events",
        "journal_lines",
      ]})`.execute(t.admin);
    const byTable = Object.fromEntries(r.rows.map((x) => [x.t, x.opts ?? []]));
    for (const tbl of ["outbox", "idempotency_keys", "notification_deliveries", "notifications", "inbox"])
      expect(byTable[tbl], tbl).toContain("autovacuum_vacuum_scale_factor=0.02");
    for (const tbl of ["audit_events", "journal_lines"])
      expect(byTable[tbl], tbl).toContain("autovacuum_vacuum_insert_scale_factor=0.05");
    const on = await sql<{
      setting: string;
    }>`select setting from pg_settings where name = 'autovacuum'`.execute(t.admin);
    expect(on.rows[0]?.setting).toBe("on");
  });
});

describe("db-perf — bằng chứng EXPLAIN ở docs/db/explain (DB-PERF-001)", () => {
  it("thư mục có đúng các tệp .txt đã khai (không thiếu, không mồ côi) và mỗi tệp có đầu giải thích + ít nhất một dòng quét", () => {
    const files = readdirSync(EXPLAIN_DIR)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    expect(files).toEqual(EXPLAIN_DOCS.map((n) => `${n}.txt`));
    for (const f of files) {
      const text = readFileSync(`${EXPLAIN_DIR}${f}`, "utf8");
      expect(text, f).toContain("(DB-PERF-001)");
      expect(text, f).toMatch(/^[a-z_]+ · (Index|Seq Scan)/m);
    }
  });

  it("bản chuẩn hoá bỏ chi phí/số hàng và thứ tự nút: hai kế hoạch cùng quét index nhưng khác join/chi phí cho cùng nội dung", () => {
    const scan = (n: string, rows: number): PlanNode =>
      ({
        "Node Type": "Index Scan",
        "Relation Name": "t",
        "Index Name": n,
        "Index Cond": "(a = 1)",
        "Plan Rows": rows,
      }) as PlanNode;
    const keys = new Map([["ix_t_a", ["a"]]]);
    const a = planSummary(
      { "Node Type": "Nested Loop", Plans: [scan("ix_t_a", 1), scan("ix_t_a", 99)] },
      keys,
    );
    const b = planSummary({ "Node Type": "Hash Join", Plans: [scan("ix_t_a", 7)] }, keys);
    expect(a).toEqual(b);
    expect(a).toEqual(["t · Index · ix_t_a (a) · bound=a"]);
    expect(planSummary({ "Node Type": "Seq Scan", "Relation Name": "u" }, keys)).toEqual(["u · Seq Scan"]);
  });
});
