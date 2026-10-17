// T-406 (IND-FIN-006) — đối soát hằng ngày trên Postgres thật: break mở quá SLA → audit (mỗi break một dòng/ngày, chạy lại
// không nhân bản), metric `hm_reconciliation_breaks_open` tại /api/metrics, số dư sổ cái dẫn xuất = Σ posting, phát hiện sổ trôi.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedIssuedInvoice, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, postEntry } from "../ledger/ledger.ts";
import { collectMetrics } from "../observability/metrics.ts";
import { RECONCILIATION_BREAK_SLA_HOURS, runReconciliationDaily } from "./daily.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
const NOW = new Date("2026-10-16T05:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function addBreak(
  org: SeededOrg,
  createdAt: Date,
  status: "open" | "resolved" = "open",
): Promise<string> {
  const inbox = randomUUID();
  const id = randomUUID();
  await sql`insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified,
                               process_status)
            values (${inbox}, ${org.orgId}, 'sim', 'acc', ${`ev-${inbox}`}, ${"0".repeat(64)}, '{}'::jsonb, true, 'broken')`.execute(
    t.admin,
  );
  await sql`insert into reconciliation_breaks (id, organization_id, property_id, inbox_id, reason, assignee, status, resolution,
                                               resolved_by, resolved_at, created_at)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${inbox}, 'UNMATCHED', ${org.ownerMembershipId}, ${status},
                    ${status === "resolved" ? "đã xử lý" : null}, ${status === "resolved" ? org.ownerMembershipId : null},
                    ${status === "resolved" ? createdAt : null}, ${createdAt})`.execute(t.admin);
  return id;
}

const auditRows = async (orgId: string, action: string) =>
  (
    await sql<{ entity_id: string | null; actor_type: string; correlation_id: string }>`
      select entity_id, actor_type, correlation_id from audit_events where organization_id = ${orgId} and action = ${action}
      order by created_at, id`.execute(t.admin)
  ).rows;

const metric = (s: Awaited<ReturnType<typeof collectMetrics>>, name: string) =>
  s.find((x) => x.name === name)?.value;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Đối soát A");
  B = await seedOrg(t.admin, "KS Đối soát B");
});
afterAll(async () => {
  await t?.drop();
});

describe("reconciliation-daily — không có dữ liệu", () => {
  it("không break, sổ cái rỗng: kết quả 0; metric = 0 (không NULL/NaN)", async () => {
    expect(await runReconciliationDaily(t.worker, NOW)).toEqual({
      overdue: 0,
      flagged: 0,
      ledgerDriftOrgs: 0,
    });
    const m = await collectMetrics(t.runtime, NOW);
    expect(metric(m, "hm_reconciliation_breaks_open")).toBe(0);
    expect(metric(m, "hm_reconciliation_breaks_oldest_open_age_seconds")).toBe(0);
  });
});

describe("reconciliation-daily — break mở quá SLA", () => {
  let overdueA: string;
  let overdueB: string;
  let fresh: string;
  let justOnSla: string;
  let resolvedOld: string;

  beforeAll(async () => {
    overdueA = await addBreak(A, hoursAgo(72));
    overdueB = await addBreak(B, hoursAgo(120));
    fresh = await addBreak(A, hoursAgo(1));
    justOnSla = await addBreak(A, hoursAgo(RECONCILIATION_BREAK_SLA_HOURS)); // đúng mốc SLA: coi là quá hạn (<=)
    resolvedOld = await addBreak(A, hoursAgo(200), "resolved");
  });

  it("ghi audit worker cho break quá hạn đúng tổ chức; break mới/đã đóng thì không; tổ chức khác không lẫn", async () => {
    const r = await runReconciliationDaily(t.worker, NOW);
    expect(r).toMatchObject({ overdue: 3, flagged: 3, ledgerDriftOrgs: 0 });
    const a = await auditRows(A.orgId, "reconciliation.break_overdue");
    expect(a.map((x) => x.entity_id).sort()).toEqual([overdueA, justOnSla].sort());
    expect(
      a.every((x) => x.actor_type === "worker" && x.correlation_id === "job:reconciliation.daily:2026-10-16"),
    ).toBe(true);
    expect((await auditRows(B.orgId, "reconciliation.break_overdue")).map((x) => x.entity_id)).toEqual([
      overdueB,
    ]);
    const all = a.map((x) => x.entity_id);
    expect(all).not.toContain(fresh);
    expect(all).not.toContain(resolvedOld);
  });

  it("chạy lại cùng ngày: đếm vẫn đủ nhưng không nhân bản audit; sang ngày mới: nhắc lại một dòng/break", async () => {
    const again = await runReconciliationDaily(t.worker, new Date(NOW.getTime() + 3_600_000));
    expect(again).toMatchObject({ overdue: 3, flagged: 0 });
    expect(await auditRows(A.orgId, "reconciliation.break_overdue")).toHaveLength(2);
    const next = await runReconciliationDaily(t.worker, new Date(NOW.getTime() + 24 * 3_600_000));
    expect(next).toMatchObject({ overdue: 3, flagged: 3 }); // break "fresh" mới 25 giờ ⇒ chưa quá hạn
    expect(await auditRows(A.orgId, "reconciliation.break_overdue")).toHaveLength(4);
  });

  it("SLA tuỳ biến: slaHours lớn hơn tuổi mọi break ⇒ không có gì quá hạn", async () => {
    const r = await runReconciliationDaily(t.worker, new Date(NOW.getTime() + 2 * 24 * 3_600_000), {
      slaHours: 10_000,
    });
    expect(r.overdue).toBe(0);
  });

  it("metric /api/metrics: số break mở (không tính đã đóng), tuổi cũ nhất; không nhãn tổ chức", async () => {
    const m = await collectMetrics(t.runtime, NOW);
    expect(metric(m, "hm_reconciliation_breaks_open")).toBe(4); // overdueA, overdueB, fresh, justOnSla
    expect(metric(m, "hm_reconciliation_breaks_oldest_open_age_seconds")).toBe(120 * 3600);
    for (const s of m.filter((x) => x.name.startsWith("hm_reconciliation_")))
      expect(s.labels ?? {}).toEqual({});
  });

  it("vai trò runtime không gọi được hàm đọc xuyên tổ chức của worker", async () => {
    await expect(
      sql`select * from app.reconciliation_breaks_overdue(${NOW}, 48, 10)`.execute(t.runtime),
    ).rejects.toThrow(/permission denied/);
    await expect(sql`select * from app.ledger_drift()`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("reconciliation-daily — số dư dẫn xuất = Σ posting (không trôi)", () => {
  it("balance() theo tài khoản bằng Σ(nợ − có) thô trên journal_lines; job không báo trôi khi mọi bút toán cân", async () => {
    const { invoiceId } = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: A.ownerPersonId,
      lines: [{ amount: 1_580_000 }],
    });
    await t.admin.transaction().execute(async (trx) => {
      for (const cr of [600_000, 980_000]) {
        await postEntry(trx, {
          orgId: A.orgId,
          propertyId: A.propertyId,
          entryType: "adjustment",
          businessDate: "2026-10-16",
          sourceDocType: "invoice",
          sourceDocId: invoiceId,
          lines: [
            { account: "DISCOUNT", debit: cr, credit: 0 },
            { account: "AR", debit: 0, credit: cr, invoiceId },
          ],
        });
      }
    });
    const derived = await withTenant(t.admin, { orgId: A.orgId }, (trx) =>
      balance(trx, { orgId: A.orgId, account: "AR", invoiceId }),
    );
    const raw = await sql<{ s: string }>`
      select coalesce(sum(debit - credit), 0)::text as s from journal_lines
      where organization_id = ${A.orgId} and account = 'AR' and invoice_id = ${invoiceId}`.execute(t.admin);
    expect(derived).toBe(0);
    expect(derived).toBe(Number(raw.rows[0]?.s));
    const total = await sql<{ d: string; c: string }>`
      select sum(debit)::text as d, sum(credit)::text as c from journal_lines where organization_id = ${A.orgId}`.execute(
      t.admin,
    );
    expect(total.rows[0]?.d).toBe(total.rows[0]?.c);
    expect((await runReconciliationDaily(t.worker, NOW)).ledgerDriftOrgs).toBe(0);
  });

  it("sổ trôi (dòng lẻ do sửa tay, bỏ qua trigger): job báo đúng tổ chức, log lỗi, ghi audit ledger.drift_detected một lần/ngày", async () => {
    const entry = randomUUID();
    await t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`insert into journal_entries (id, organization_id, property_id, entry_type, business_date, source_doc_type, source_doc_id)
                values (${entry}, ${B.orgId}, ${B.propertyId}, 'adjustment', '2026-10-16', 'invoice', ${randomUUID()})`.execute(
        trx,
      );
      await sql`insert into journal_lines (id, organization_id, property_id, entry_id, line_no, account, debit, credit)
                values (${randomUUID()}, ${B.orgId}, ${B.propertyId}, ${entry}, 1, 'REV_ROOM', 1000, 0)`.execute(
        trx,
      );
    });
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
    const r = await runReconciliationDaily(t.worker, NOW, { log });
    expect(r.ledgerDriftOrgs).toBe(1);
    expect(logs).toEqual([
      {
        event: "reconciliation.ledger_drift",
        fields: { organization_id: B.orgId, debit_total: "1000", credit_total: "0" },
      },
    ]);
    expect(await auditRows(B.orgId, "ledger.drift_detected")).toHaveLength(1);
    await runReconciliationDaily(t.worker, NOW, { log });
    expect(await auditRows(B.orgId, "ledger.drift_detected")).toHaveLength(1);
    expect(await auditRows(A.orgId, "ledger.drift_detected")).toHaveLength(0);
  });
});
