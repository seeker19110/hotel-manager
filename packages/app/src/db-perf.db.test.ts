// PLAN đợt 5 T-408 — EXPLAIN truy vấn nóng trên Postgres thật (DB-PERF-001): today, folio, claim outbox/notification, billing,
// danh sách audit. Cách đánh giá:
//   1. Truy vấn của hàm app (today/audit/billing) được BẮT NGUYÊN VĂN bằng log của Kysely khi chạy hàm thật (không sao chép SQL);
//      truy vấn nằm trong hàm SQL của migration/ở app mà khó gọi riêng (folio, claim outbox/notification) viết tay kèm đoạn
//      "dấu vân tay" phải còn trong mã nguồn (đổi truy vấn mà quên cập nhật ở đây → đỏ).
//   2. Mỗi truy vấn chạy `EXPLAIN (FORMAT JSON)` (không ANALYZE — không thực thi) với vai trò app_runtime trong ngữ cảnh tổ chức
//      (cùng điều kiện RLS như thật). Bảng seed nhỏ nên planner coi Seq Scan là rẻ: đặt `enable_seqscan = off` để bất kỳ Seq Scan
//      còn sót nghĩa là KHÔNG có index dùng được; không Seq Scan trên bảng thuộc danh sách "lớn" (BIG_TABLES) ở mọi nút kế hoạch.
//   3. Thêm kiểm chứng "tự nhiên" (seqscan bật) trên dữ liệu lớn hơn (30.000 dòng audit/outbox) cho ba truy vấn quét tuần tự đắt nhất.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  Plans?: PlanNode[];
}
function seqScans(node: PlanNode, out: string[] = []): string[] {
  if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) out.push(node["Relation Name"]);
  for (const c of node.Plans ?? []) seqScans(c, out);
  return out;
}

async function explainAs(role: "runtime" | "admin", q: { sql: string; params: unknown[] }, seqscan: boolean) {
  const db = role === "runtime" ? t.runtime : t.admin;
  const run = async (trx: Kysely<unknown>) => {
    await sql`select set_config('enable_seqscan', ${seqscan ? "on" : "off"}, true)`.execute(trx);
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
  await sql`
    insert into audit_events (id, organization_id, property_id, occurred_at, actor_type, action, entity_type, entity_id, correlation_id)
    select gen_random_uuid(), ${A.orgId}, ${A.propertyId}, now() - (g || ' seconds')::interval, 'worker',
           'perf.event_' || chr(97 + g % 7), 'perf', gen_random_uuid(), 'perf-' || (g % 500)
    from generate_series(1, 30000) g`.execute(t.admin);
  await sql`
    insert into outbox (id, organization_id, event_type, payload, correlation_id, created_at, published_at)
    select gen_random_uuid(), ${A.orgId}, 'perf.event', '{}'::jsonb, 'perf', now() - (g || ' seconds')::interval,
           case when g % 10 = 0 then null else now() end
    from generate_series(1, 30000) g`.execute(t.admin);
  await sql`analyze`.execute(t.admin);
});

afterAll(async () => {
  await capturing?.destroy();
  await t?.drop();
});

/** Kiểm các truy vấn đã bắt: không Seq Scan trên bảng lớn (seqscan tắt ⇒ phải có index dùng được). */
async function expectIndexed(
  queries: { sql: string; params: unknown[] }[],
  role: "runtime" | "admin" = "runtime",
) {
  expect(queries.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const q of queries) {
    const plan = await explainAs(role, q, false);
    const hit = seqScans(plan).filter((r) => BIG_TABLES.has(r));
    if (hit.length > 0) bad.push(`${hit.join(",")} ← ${q.sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  expect(bad).toEqual([]);
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

describe("db-perf — today (S-006…S-008)", () => {
  it("getSummary + listItems cho mọi thẻ: truy vấn thật không Seq Scan trên bảng lớn", async () => {
    captured.length = 0;
    await getSummary(capturing, owner, {});
    for (const card of TODAY_CARDS) await listItems(capturing, owner, { card });
    const qs = selects();
    expect(qs.length).toBeGreaterThanOrEqual(TODAY_CARDS.length);
    await expectIndexed(qs);
  });
});

describe("db-perf — danh sách audit (S-004, S-005)", () => {
  it("các bộ lọc thường dùng (mặc định, cơ sở, đối tượng, hành động, người, correlation, khoảng thời gian): có index", async () => {
    captured.length = 0;
    const entityId = randomUUID();
    const base = { limit: 50 };
    await listEvents(capturing, owner, base);
    await listEvents(capturing, owner, { ...base, propertyId: A.propertyId });
    await listEvents(capturing, owner, { ...base, entityType: "perf", entityId });
    await listEvents(capturing, owner, { ...base, action: "perf.event_b" });
    await listEvents(capturing, owner, { ...base, actorPersonId: A.ownerPersonId });
    await listEvents(capturing, owner, { ...base, correlationId: "perf-1" });
    await listEvents(capturing, owner, {
      ...base,
      from: new Date(Date.now() - 3_600_000),
      to: new Date(),
    });
    await expectIndexed(selects());
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
    await expectIndexed(qs);
  });
});

// Truy vấn nằm trong hàm SQL/mã khó gọi riêng: viết tay, kèm dấu vân tay phải còn trong nguồn.
const MIGRATIONS = new URL("../../db/src/migrations/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const U = "00000000-0000-4000-8000-000000000001";

describe("db-perf — folio (S-017)", () => {
  const FOLIO = [
    {
      name: "khoản phí theo lượt ở",
      sql: "select id from charges where organization_id = $1 and stay_id = $2 order by business_date, created_at",
      print: ["from charges where organization_id =", "and stay_id ="],
    },
    {
      name: "thanh toán theo đặt phòng",
      sql: "select id from payments where organization_id = $1 and reservation_id = $2 and purpose = 'receivable' order by created_at",
      print: ["where organization_id =", "and reservation_id =", "and purpose = 'receivable'"],
    },
    {
      name: "phiếu folio của lượt ở",
      sql: "select id from invoices where organization_id = $1 and stay_id = $2 and kind = 'folio'",
      print: ["where organization_id =", "and stay_id =", "and kind = 'folio'"],
    },
    {
      name: "cọc theo đặt phòng",
      sql: "select id from deposits where organization_id = $1 and reservation_id = $2",
      print: ["from deposits where organization_id =", "and reservation_id ="],
    },
  ];
  it("dấu vân tay còn trong stay/folio.ts và mỗi truy vấn có index", async () => {
    const src = read("./stay/folio.ts");
    for (const f of FOLIO) for (const part of f.print) expect(src, f.name).toContain(part);
    await expectIndexed(FOLIO.map((f) => ({ sql: f.sql, params: [A.orgId, U] })));
  });
});

describe("db-perf — claim outbox và thông báo (worker)", () => {
  it("app.outbox_claim: dấu vân tay trong migration 0003 và truy vấn dùng index (không Seq Scan outbox)", async () => {
    const mig = readFileSync(new URL("0003_command_pipeline.ts", MIGRATIONS), "utf8");
    expect(mig).toContain("FROM outbox o WHERE o.published_at IS NULL\n    ORDER BY o.created_at, o.id");
    await expectIndexed(
      [
        {
          sql: "select o.id from outbox o where o.published_at is null order by o.created_at, o.id limit 100",
          params: [],
        },
      ],
      "admin",
    );
  });

  it("app.claim_due_deliveries: dấu vân tay trong migration 0037 và hai truy vấn bên trong dùng index", async () => {
    const mig = readFileSync(new URL("0037_notification_claim_fixes.ts", MIGRATIONS), "utf8");
    expect(mig).toContain("WHERE d.status IN ('queued','retrying') AND d.next_attempt_at <= p_now");
    expect(mig).toContain(
      "WHERE d.organization_id = o.organization_id AND d.status IN ('queued','retrying')",
    );
    await expectIndexed(
      [
        {
          sql: "select distinct d.organization_id from notification_deliveries d where d.status in ('queued','retrying') and d.next_attempt_at <= $1::timestamptz",
          params: [new Date()],
        },
        {
          sql: `select d.id from notification_deliveries d
              where d.organization_id = $1 and d.status in ('queued','retrying') and d.next_attempt_at <= $2::timestamptz
              order by d.next_attempt_at, d.id limit 50`,
          params: [A.orgId, new Date()],
        },
        {
          sql: "select d.id from notification_deliveries d where d.status = 'sending' and d.locked_until < $1::timestamptz",
          params: [new Date()],
        },
      ],
      "admin",
    );
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
