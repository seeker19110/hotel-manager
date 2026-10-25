// IND-SAAS-008 (D-123) — fair-share worker theo tổ chức: tổ chức A xếp nhiều job không chặn job của tổ chức B.
// Đo THỨ TỰ tương đối (job của B xong khi A còn bao nhiêu job chưa xong), không so thời gian tuyệt đối. Postgres + pg-boss thật.
import { randomUUID } from "node:crypto";
import { PLANS } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureQueues, jobGroup, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

const A_JOBS = 50;
const WORK_MS = 120;
const LOCAL = 4;

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let boss: PgBoss;

async function addOutbox(org: SeededOrg, eventType: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
              values (${randomUUID()}, ${org.orgId}, ${eventType}, ${JSON.stringify({ seq: i })}::jsonb, ${`c-${i}`})`.execute(
      t.admin,
    );
  }
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("quá thời gian chờ");
}

interface Run {
  /** Số job của A đã xong tại thời điểm job của B xong. */
  aDoneWhenBDone: number;
  maxConcurrentA: number;
  aDone: number;
}

/** A xếp A_JOBS job TRƯỚC, B xếp 1 job SAU; chạy consumer với trần/tổ chức cho trước. */
async function scenario(queue: string, groupConcurrency: { default: number }): Promise<Run> {
  await ensureQueues(boss, [queue], { retryLimit: 0, retryDelay: 1, retryBackoff: false });
  await addOutbox(A, queue, A_JOBS);
  await addOutbox(B, queue, 1);
  expect(await relayOutbox(t.worker, boss, 200)).toBe(A_JOBS + 1);

  let aDone = 0;
  let aRunning = 0;
  let maxConcurrentA = 0;
  let aDoneWhenBDone = -1;
  await startConsumers(
    boss,
    {
      [queue]: async (job: OutboxJob) => {
        const isA = job.organization_id === A.orgId;
        if (isA) {
          aRunning++;
          maxConcurrentA = Math.max(maxConcurrentA, aRunning);
        }
        await new Promise((r) => setTimeout(r, WORK_MS));
        if (isA) {
          aRunning--;
          aDone++;
        } else {
          aDoneWhenBDone = aDone;
        }
      },
    },
    { pollingIntervalSeconds: 0.5, localConcurrency: LOCAL, groupConcurrency },
  );
  await until(() => aDone === A_JOBS && aDoneWhenBDone >= 0);
  return { aDoneWhenBDone, maxConcurrentA, aDone };
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Fair A");
  B = await seedOrg(t.admin, "Fair B");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await t?.drop();
});

describe("fair-share worker theo tổ chức", () => {
  it("jobGroup: nhóm = tổ chức, bậc = id gói", () => {
    expect(jobGroup(A.orgId)).toEqual({ id: A.orgId, tier: PLANS.standard.id });
  });

  it("A xếp 50 job trước, B 1 job sau: job của B xong khi A còn ≥ 80% hàng", async () => {
    const r = await scenario("fair.capped", { default: PLANS.standard.jobConcurrency });
    expect(r.aDone).toBe(A_JOBS);
    // Trần mềm (xem `startConsumers`): hai luồng lấy job cùng lúc có thể cùng lọt qua trần, nhưng không quá số luồng.
    expect(r.maxConcurrentA).toBeLessThanOrEqual(LOCAL);
    // B chỉ chờ lượt thăm dò kế tiếp, không chờ hết hàng của A.
    expect(r.aDoneWhenBDone).toBeLessThan(A_JOBS / 5);
  }, 90_000);

  it("đối chứng: không có trần mỗi tổ chức (trần = số luồng) thì B xếp sau toàn bộ hàng của A", async () => {
    const r = await scenario("fair.uncapped", { default: LOCAL });
    expect(r.maxConcurrentA).toBe(LOCAL);
    expect(r.aDoneWhenBDone).toBeGreaterThan(A_JOBS / 2);
  }, 90_000);
});
