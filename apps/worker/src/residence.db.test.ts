// T-207 — job `reminder.scanStayNotice` ở worker nhắc hạn thông báo lưu trú (SPEC-notifications S-014, S-016, S-021) qua pg-boss thật.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REMINDER_JOBS, startReminderWorkers } from "./jobs.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;
let now = new Date("2026-10-20T14:00:00Z"); // 21:00 giờ VN
const results: { job: string; created: number }[] = [];
let noticeId: string;

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}
const ran = () => results.filter((r) => r.job === "stayNotice").length;
const events = async () =>
  (
    await sql<{ phase: string }>`select payload ->> 'phase' as phase from outbox
      where event_type = 'stay_notice.reminder' and aggregate_id = ${noticeId} order by created_at`.execute(
      t.admin,
    )
  ).rows.map((r) => r.phase);

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Worker lưu trú", "hotel");
  const booker = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${booker}, ${A.orgId}, 'Khách')`.execute(
    t.admin,
  );
  const { seedReservation } = await import("@hm/testkit");
  const r = await seedReservation(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    bookerPersonId: booker,
    unitId: A.unitId,
    roomTypeId: A.roomTypeId,
    arrivalDate: "2026-10-20",
    departureDate: "2026-10-21",
  });
  const stayId = randomUUID();
  await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id, checked_in_at)
            values (${stayId}, ${A.orgId}, ${A.propertyId}, ${r.itemId}, ${A.unitId}, 'in_house', ${booker}, '2026-10-20T13:00:00Z')`.execute(
    t.admin,
  );
  noticeId = randomUUID();
  // hạn 23:00 giờ VN = 16:00Z
  await sql`insert into residence_notices (id, organization_id, property_id, stay_id, due_at)
            values (${noticeId}, ${A.orgId}, ${A.propertyId}, ${stayId}, '2026-10-20T16:00:00Z')`.execute(
    t.admin,
  );
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await startReminderWorkers(boss, t.worker, {
    now: () => now,
    onResult: (job, res) => results.push({ job, created: res.created }),
    pollingIntervalSeconds: 0.5,
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("residence: job nhắc hạn thông báo lưu trú ở worker", () => {
  it("job nhận → phát nhắc đầu; chạy lại không phát thêm; gần hạn → Khẩn; đã nộp → dừng", async () => {
    await boss.send(REMINDER_JOBS.stayNotice.queue, {});
    await waitFor(() => ran() >= 1);
    expect(await events()).toEqual(["due"]);

    await boss.send(REMINDER_JOBS.stayNotice.queue, {});
    await waitFor(() => ran() >= 2);
    expect(await events()).toEqual(["due"]);
    expect(results.filter((r) => r.job === "stayNotice")[1]?.created).toBe(0);

    now = new Date("2026-10-20T15:45:00Z"); // còn 15 phút
    await boss.send(REMINDER_JOBS.stayNotice.queue, {});
    await waitFor(() => ran() >= 3);
    expect(await events()).toEqual(["due", "urgent"]);

    // đã nộp (ghi bằng admin) → quá hạn cũng không còn nhắc
    const m = await sql<{
      id: string;
    }>`select id from memberships where organization_id = ${A.orgId} limit 1`.execute(t.admin);
    await sql`update residence_notices set status = 'submitted', submitted_at = '2026-10-20T15:50:00Z', submitted_by = ${m.rows[0]?.id},
              channel = 'online' where id = ${noticeId}`.execute(t.admin);
    now = new Date("2026-10-20T17:00:00Z");
    await boss.send(REMINDER_JOBS.stayNotice.queue, {});
    await waitFor(() => ran() >= 4);
    expect(await events()).toEqual(["due", "urgent"]);
  });
});
