// T-212 — job nhắc hạn ở worker: lịch pg-boss idempotent và xử lý job trên Postgres thật (SPEC-notifications §5; S-007, S-013, S-020).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedIssuedInvoice, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REMINDER_JOBS, scheduleReminders, startReminderWorkers } from "./jobs.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;
const results: { job: string; created: number }[] = [];
const at = new Date("2026-10-11T02:00:00Z"); // 09:00 giờ VN

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

const ranCount = (job: string) => results.filter((r) => r.job === job).length;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Worker nhắc hạn", "rental");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("job nhắc hạn ở worker", () => {
  it("đăng ký lịch định kỳ; đăng ký lại nhiều lần vẫn mỗi job một lịch đúng cron", async () => {
    await scheduleReminders(boss);
    await scheduleReminders(boss);
    const schedules = await boss.getSchedules();
    for (const j of Object.values(REMINDER_JOBS)) {
      const mine = schedules.filter((s) => s.name === j.queue);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.cron).toBe(j.cron);
    }
    expect(Object.values(REMINDER_JOBS).map((j) => j.queue)).toEqual([
      "reminder.scanOverdue",
      "reminder.scanLeaseExpiry",
      "reminder.scanStayNotice",
    ]);
  });

  it("nhận job quét quá hạn → phát 1 sự kiện; job thứ hai (chạy lại) không phát thêm", async () => {
    const person = randomUUID();
    await sql`insert into persons (id, organization_id, full_name, email) values (${person}, ${A.orgId}, 'An', 'an@example.test')`.execute(
      t.admin,
    );
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: person,
      lines: [{ amount: 1_580_000 }],
    });
    await t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update invoices set due_on = '2026-10-10' where id = ${inv.invoiceId}`.execute(trx);
    });
    await startReminderWorkers(boss, t.worker, {
      now: () => at,
      onResult: (job, r) => results.push({ job, created: r.created }),
      pollingIntervalSeconds: 0.5,
    });
    await boss.send(REMINDER_JOBS.overdue.queue, {});
    await waitFor(() => ranCount("overdue") >= 1);
    const count = async () =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from outbox where event_type = 'invoice.overdue' and aggregate_id = ${inv.invoiceId}`.execute(
            t.admin,
          )
        ).rows[0]?.n,
      );
    expect(await count()).toBe(1);
    expect(results.find((r) => r.job === "overdue")?.created).toBeGreaterThanOrEqual(1);

    await boss.send(REMINDER_JOBS.overdue.queue, {});
    await waitFor(() => ranCount("overdue") >= 2);
    expect(await count()).toBe(1);
    expect(results.filter((r) => r.job === "overdue")[1]?.created).toBe(0);
  });

  it("nhận job hợp đồng và lưu trú khi không có việc → chạy xong, không phát gì", async () => {
    await boss.send(REMINDER_JOBS.leaseExpiry.queue, {});
    await boss.send(REMINDER_JOBS.stayNotice.queue, {});
    await waitFor(() => ranCount("leaseExpiry") >= 1 && ranCount("stayNotice") >= 1);
    expect(results.filter((r) => r.job !== "overdue").every((r) => r.created === 0)).toBe(true);
  });
});
