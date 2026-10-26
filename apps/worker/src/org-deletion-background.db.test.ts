// D-126 (T-2312, migration 0071) — tổ chức `pending_deletion` NGỪNG xử lý nền, huỷ yêu cầu xoá thì chạy lại. Trên Postgres thật, bằng
// `app_worker` như job thật: mỗi loại job tiêu biểu bỏ qua tổ chức chờ xoá (B) nhưng vẫn chạy cho tổ chức active (A); relay không
// lấy sự kiện của B (trừ `export.requested`); thông báo/thư mời đang bay cũng bị bỏ qua. Trạng thái đổi bằng đúng đường của sản phẩm
// (`requestOrgDeletion` / `cancelOrgDeletion`).
import { randomUUID } from "node:crypto";
import {
  type Actor,
  buildInvitationMail,
  cancelOrgDeletion,
  detectOverstay,
  dispatchNotification,
  expireHeldReservations,
  generatePeriods,
  invitationKey,
  remindExpiring,
  requestOrgDeletion,
  resolveActor,
  runReconciliationDaily,
} from "@hm/app";
import {
  activateLease,
  createTestDb,
  type SeededOrg,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { type RawBuilder, sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireHolds } from "./jobs.ts";
import { ensureQueues, relayOutbox } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let boss: PgBoss;
const NOW = new Date("2027-10-01T01:00:00Z"); // 08:00 giờ VN ngày 01/10/2027

const ownerOf = (o: SeededOrg): Promise<Actor> =>
  resolveActor(t.runtime, {
    authUserId: o.ownerAuthUserId,
    orgId: o.orgId,
    twoFactorEnabled: true,
    authenticatedAt: new Date(),
    allowPendingDeletion: true,
  });

const status = async (o: SeededOrg) =>
  (await sql<{ status: string }>`select status from organizations where id = ${o.orgId}`.execute(t.admin))
    .rows[0]?.status;

async function countBy(query: (org: string) => Promise<number>): Promise<{ a: number; b: number }> {
  return { a: await query(A.orgId), b: await query(B.orgId) };
}
const count = async (q: RawBuilder<{ n: number }>): Promise<number> =>
  (await q.execute(t.admin)).rows[0]?.n ?? 0;

async function seedBackgroundData(o: SeededOrg) {
  // hold hết hạn trước NOW
  await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
            values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${o.unitId}, 'hold',
                    tstzrange('2027-10-02T07:00:00Z', '2027-10-03T05:00:00Z', '[)'), '2027-09-30T00:00:00Z')`.execute(
    t.admin,
  );
  // hợp đồng hiệu lực kết thúc 30 ngày sau NOW (nhắc hết hạn) — hết hạn từ 2027-10-31, quá hạn khi sang 11/2027
  const lease = await seedLease(t.admin, {
    orgId: o.orgId,
    propertyId: o.propertyId,
    representativePersonId: o.ownerPersonId,
    effectiveFrom: "2027-01-01",
  });
  await sql`update lease_versions set effective_to = '2027-10-31' where lease_id = ${lease.leaseId}`.execute(
    t.admin,
  );
  await activateLease(t.admin, { org: o, leaseId: lease.leaseId, effectiveFrom: "2027-01-01" });
  await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
            values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${lease.unitId}, 'lease', 'lease', ${lease.leaseId},
                    tstzrange('2027-01-01T00:00:00Z', '2027-10-31T00:00:00Z', '[)'))`.execute(t.admin);
  // break đối soát mở quá SLA
  const inbox = randomUUID();
  await sql`insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified,
                               process_status)
            values (${inbox}, ${o.orgId}, 'sim', 'acc', ${`ev-${inbox}`}, ${"0".repeat(64)}, '{}'::jsonb, true, 'broken')`.execute(
    t.admin,
  );
  await sql`insert into reconciliation_breaks (id, organization_id, property_id, inbox_id, reason, assignee, status, created_at)
            values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${inbox}, 'UNMATCHED', ${o.ownerMembershipId}, 'open',
                    '2027-09-01T00:00:00Z')`.execute(t.admin);
  // thông báo chờ gửi email
  const nid = randomUUID();
  await sql`insert into notifications (id, organization_id, property_id, recipient_person_id, type, severity, title, body, link, vars,
                                       dedupe_key)
            values (${nid}, ${o.orgId}, ${o.propertyId}, ${o.ownerPersonId}, 'invoice_issued', 'normal', 't', 'b', '/x', '{}'::jsonb,
                    ${`k-${nid}`})`.execute(t.admin);
  await sql`insert into notification_deliveries (id, organization_id, property_id, notification_id, channel, status, next_attempt_at)
            values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${nid}, 'email', 'queued', '2027-09-30T00:00:00Z')`.execute(
    t.admin,
  );
  // sự kiện outbox: một sự kiện thường + một yêu cầu xuất
  for (const type of ["test.background", "export.requested"])
    await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
              values (${randomUUID()}, ${o.orgId}, ${type}, '{}'::jsonb, 'c')`.execute(t.admin);
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nền A", "rental");
  B = await seedOrg(t.admin, "Nền B", "rental");
  await seedBackgroundData(A);
  await seedBackgroundData(B);
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["test.background", "export.requested"], {
    retryLimit: 1,
    retryDelay: 1,
    retryBackoff: false,
  });
  // B yêu cầu xoá bằng đúng đường sản phẩm; A giữ active.
  await requestOrgDeletion(t.runtime, await ownerOf(B), {
    reauthenticatedAt: new Date(),
    correlationId: "bg-test",
  });
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await t?.drop();
});

describe("job nền chỉ chọn tổ chức active", () => {
  it("điều kiện đầu: B chờ xoá, A active", async () => {
    expect(await status(A)).toBe("active");
    expect(await status(B)).toBe("pending_deletion");
  });

  it("inventory.expire_holds: nhả hold của A, giữ nguyên hold của B", async () => {
    expect(await expireHolds(t.worker, NOW)).toBe(1);
    const act = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from allocations where organization_id = ${org} and kind = 'hold' and active`,
      ),
    );
    expect(act).toEqual({ a: 0, b: 1 });
    expect(await expireHolds(t.worker, NOW)).toBe(0);
  });

  it("inventory.expire_holds (đặt chỗ giữ quá hạn): chỉ A", async () => {
    for (const o of [A, B]) {
      const r = randomUUID();
      await sql`insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, created_by, held_until)
                values (${r}, ${o.orgId}, ${o.propertyId}, ${`R-${Math.floor(Math.random() * 1e9)}`}, 'held', 'direct', ${o.ownerPersonId},
                        ${o.ownerMembershipId}, '2027-09-30T00:00:00Z')`.execute(t.admin);
      await sql`insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id,
                                               arrival_date, departure_date, guests, nightly_prices, room_total)
                values (${randomUUID()}, ${o.orgId}, ${o.propertyId}, ${r}, ${o.unitId}, ${o.roomTypeId}, '2027-10-10', '2027-10-11', 1,
                        '[{"businessDate":"2027-10-10","amount":600000}]'::jsonb, 600000)`.execute(t.admin);
    }
    expect(await expireHeldReservations(t.worker, NOW)).toBe(1);
    const held = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from reservations where organization_id = ${org} and status = 'held'`,
      ),
    );
    expect(held).toEqual({ a: 0, b: 1 });
  });

  it("billing.generate_periods: tạo kỳ cho A, không cho B", async () => {
    expect(await generatePeriods(t.worker, NOW)).toBe(1);
    const p = await countBy((org) =>
      count(
        sql<{ n: number }>`select count(*)::int as n from billing_periods where organization_id = ${org}`,
      ),
    );
    expect(p).toEqual({ a: 1, b: 0 });
  });

  it("lease.daily: nhắc hết hạn và phát hiện quá hạn chỉ cho A", async () => {
    expect(await remindExpiring(t.worker, NOW)).toBe(1);
    expect(await detectOverstay(t.worker, new Date("2027-11-05T01:00:00Z"))).toBe(1);
    const ob = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from outbox where organization_id = ${org} and event_type = 'lease.expiring'`,
      ),
    );
    expect(ob).toEqual({ a: 1, b: 0 });
    const ex = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from exceptions where organization_id = ${org} and type = 'LEASE_OVERSTAY'`,
      ),
    );
    expect(ex).toEqual({ a: 1, b: 0 });
  });

  it("reconciliation.daily: break quá SLA chỉ nhắc cho A", async () => {
    await runReconciliationDaily(t.worker, new Date("2027-10-01T01:00:00Z"), { log: () => {} });
    const au = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where organization_id = ${org} and action like 'reconciliation.%'`,
      ),
    );
    expect(au.a).toBeGreaterThan(0);
    expect(au.b).toBe(0);
  });

  it("notifications.reminders: app.reminder_orgs chỉ trả tổ chức active", async () => {
    const r = await sql<{ id: string }>`select reminder_orgs as id from app.reminder_orgs()`.execute(
      t.worker,
    );
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(A.orgId);
    expect(ids).not.toContain(B.orgId);
  });

  it("notifications.send_due: claim_due_deliveries chỉ lấy lượt gửi của A", async () => {
    const r = await sql<{ organization_id: string }>`
      select organization_id from app.claim_due_deliveries(${NOW}, 50, 10, 120, 5)`.execute(t.worker);
    expect(r.rows.map((x) => x.organization_id)).toEqual([A.orgId]);
    const q = await countBy((org) =>
      count(
        sql<{
          n: number;
        }>`select count(*)::int as n from notification_deliveries where organization_id = ${org} and status = 'queued'`,
      ),
    );
    expect(q).toEqual({ a: 0, b: 1 });
  });

  it("outbox.relay: không phát sự kiện của B (trừ export.requested), A phát đủ", async () => {
    let total = 0;
    for (let i = 0; i < 3; i++) total += await relayOutbox(t.worker, boss, 100);
    // A: test.background + export.requested + lease.expiring...; B: chỉ export.requested
    const sent = async (org: string, type: string) =>
      count(sql<{
        n: number;
      }>`select count(*)::int as n from outbox where organization_id = ${org} and event_type = ${type}
                                and published_at is not null`);
    expect(await sent(A.orgId, "test.background")).toBe(1);
    expect(await sent(A.orgId, "export.requested")).toBe(1);
    expect(await sent(B.orgId, "export.requested")).toBe(1);
    expect(await sent(B.orgId, "test.background")).toBe(0);
    const pendingB = await count(
      sql<{
        n: number;
      }>`select count(*)::int as n from outbox where organization_id = ${B.orgId} and published_at is null`,
    );
    expect(pendingB).toBeGreaterThan(0); // vẫn nằm trong outbox, không mất
    expect(total).toBeGreaterThan(0);
  });

  it("job đang bay: thông báo và thư mời của B bị bỏ qua, của A vẫn chạy", async () => {
    const invoiceOf: Record<string, string> = {};
    for (const o of [A, B]) {
      const leaseId = (
        await sql<{ id: string }>`select id from leases where organization_id = ${o.orgId} limit 1`.execute(
          t.admin,
        )
      ).rows[0]?.id as string;
      invoiceOf[o.orgId] = (
        await seedIssuedInvoice(t.admin, {
          orgId: o.orgId,
          propertyId: o.propertyId,
          payerPersonId: o.ownerPersonId,
          lines: [{ amount: 150_000 }],
          leaseId,
        })
      ).invoiceId;
    }
    const job = (o: SeededOrg) => ({
      organization_id: o.orgId,
      outbox_id: randomUUID(),
      event_type: "invoice.issued",
      aggregate_id: invoiceOf[o.orgId] as string,
      payload: { invoice_id: invoiceOf[o.orgId] },
    });
    expect(await dispatchNotification(t.worker, job(B), NOW)).toBe(0);
    expect(await dispatchNotification(t.worker, job(A), NOW)).toBeGreaterThan(0);

    const key = invitationKey("bi-mat-thu-nghiem-cua-worker-0123456789abcdef");
    const mail = async (o: SeededOrg) => {
      const id = randomUUID();
      await sql`insert into invitations (id, organization_id, email, role, property_ids, token_hash, expires_at, status, invited_by)
                values (${id}, ${o.orgId}, ${`moi+${id.slice(0, 6)}@example.test`}, 'front_desk', ${[o.propertyId]}::uuid[],
                        sha256(convert_to(${id}::text, 'UTF8')), now() + interval '7 days', 'pending', ${o.ownerMembershipId})`.execute(
        t.admin,
      );
      return buildInvitationMail(
        t.worker,
        { organization_id: o.orgId, payload: { invitation_id: id } },
        { key, baseUrl: "https://hm.example.test" },
      );
    };
    expect(await mail(B)).toBeNull();
    expect(await mail(A)).not.toBeNull();
  });
});

describe("huỷ yêu cầu xoá ⇒ job nền chạy lại cho B", () => {
  it("sau cancelOrgDeletion: relay phát nốt sự kiện của B, hold/kỳ/nhắc/gửi mail của B được xử lý", async () => {
    expect(await cancelOrgDeletion(t.runtime, await ownerOf(B), { correlationId: "bg-test" })).toBe(true);
    expect(await status(B)).toBe("active");
    await relayOutbox(t.worker, boss, 100);
    const pendingB = await count(
      sql<{
        n: number;
      }>`select count(*)::int as n from outbox where organization_id = ${B.orgId} and published_at is null`,
    );
    expect(pendingB).toBe(0);
    expect(await expireHolds(t.worker, NOW)).toBe(1);
    expect(await expireHeldReservations(t.worker, NOW)).toBe(1);
    expect(await generatePeriods(t.worker, NOW)).toBe(1);
    expect(await remindExpiring(t.worker, NOW)).toBe(1);
    const r = await sql<{ organization_id: string }>`
      select organization_id from app.claim_due_deliveries(${NOW}, 50, 10, 120, 5)`.execute(t.worker);
    expect(r.rows.map((x) => x.organization_id)).toContain(B.orgId);
  });
});
