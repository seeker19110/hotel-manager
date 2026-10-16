// T-211 — thông báo qua outbox → pg-boss → consumer (SPEC-notifications S-001, S-002, S-003) trên Postgres + pg-boss thật.
import { randomUUID } from "node:crypto";
import { FakeEmailSender, NOTIFICATION_EVENT_TYPES, sendDueEmails } from "@hm/app";
import { createTestDb, type SeededOrg, seedIssuedInvoice, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notificationEventHandlers } from "./jobs.ts";
import { ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;
let payer: string;
const fake = new FakeEmailSender();
const CFG = { baseUrl: "https://app.hoasen.example", tokenSecret: "t".repeat(40) };

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

const notifications = async () =>
  Number((await sql<{ n: string }>`select count(*) as n from notifications`.execute(t.admin)).rows[0]?.n);

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  payer = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email) values (${payer}, ${A.orgId}, 'An', 'an@example.test')`.execute(
    t.admin,
  );
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, NOTIFICATION_EVENT_TYPES, { retryLimit: 1, retryDelay: 1, retryBackoff: false });
  await startConsumers(boss, notificationEventHandlers(t.worker), { pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("notifications: outbox.relay → notify.dispatch → email", () => {
  it("S-002: rollback sau khi ghi outbox → relay không có gì, không thông báo, không email", async () => {
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      lines: [{ amount: 1000 }],
    });
    await expect(
      t.admin.transaction().execute(async (trx) => {
        await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
                  values (${randomUUID()}, ${A.orgId}, 'invoice.issued', ${JSON.stringify({ invoice_id: inv.invoiceId })}::jsonb, 'c-rb')`.execute(
          trx,
        );
        throw new Error("lỗi trước COMMIT");
      }),
    ).rejects.toThrow(/trước COMMIT/);
    expect(await relayOutbox(t.worker, boss)).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await notifications()).toBe(0);
    expect((await sendDueEmails(t.worker, fake, CFG)).claimed).toBe(0);
    expect(fake.mailbox).toHaveLength(0);
  });

  it("S-001 + S-003: invoice.issued sau commit → 1 thông báo + 1 email; pg-boss giao lại lần 2 vẫn 1/1", async () => {
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: payer,
      lines: [{ amount: 1_580_000 }],
    });
    const outboxId = randomUUID();
    await sql`insert into outbox (id, organization_id, event_type, aggregate_type, aggregate_id, payload, correlation_id)
              values (${outboxId}, ${A.orgId}, 'invoice.issued', 'invoice', ${inv.invoiceId}, ${JSON.stringify({ invoice_id: inv.invoiceId })}::jsonb, 'c-ok')`.execute(
      t.admin,
    );
    expect(await relayOutbox(t.worker, boss)).toBe(1);
    await waitFor(async () => (await notifications()) === 1);

    // Giao lại cùng sự kiện (worker chết sau khi xử lý, trước khi ack): job thứ hai mang cùng dữ liệu.
    const job: OutboxJob = {
      organization_id: A.orgId,
      outbox_id: outboxId,
      event_type: "invoice.issued",
      aggregate_id: inv.invoiceId,
      payload: { invoice_id: inv.invoiceId },
      correlation_id: "c-ok",
    };
    await boss.send("invoice.issued", job);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await notifications()).toBe(1);

    const s1 = await sendDueEmails(t.worker, fake, CFG);
    const s2 = await sendDueEmails(t.worker, fake, CFG);
    expect([s1.sent, s2.claimed]).toEqual([1, 0]);
    expect(fake.mailbox).toHaveLength(1);
    expect(fake.mailbox[0]).toMatchObject({ to: "an@example.test", template: "invoice_issued" });
    const d = await sql<{
      status: string;
      n: string;
    }>`select status, count(*) over () as n from notification_deliveries`.execute(t.admin);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]?.status).toBe("sent");
  });
});
