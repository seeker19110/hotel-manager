// T-2314 (D-130, IND-SAAS-008) — fair-share theo tổ chức trên Postgres thật + pg-boss thật:
//  · `app.outbox_claim` lấy vòng tròn, trần `p_per_org` hàng/tổ chức/lượt: A dồn 5×N (và 10.000) sự kiện, B có 1 ⇒ lượt claim ĐẦU đã
//    có sự kiện của B; B xong trong ≤ 1 lượt bất kể backlog của A;
//  · relay gửi job kèm `group.id = organization_id`; consumer chạy tối đa 1 job/tổ chức cùng lúc ⇒ job của B không chờ hết backlog A.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSUMER_GROUP_CONCURRENCY,
  ensureQueues,
  type OutboxJob,
  RELAY_PER_ORG,
  relayOutbox,
  startConsumers,
} from "./relay.ts";

let t: TestDb;
let boss: PgBoss;
const N = RELAY_PER_ORG;

beforeAll(async () => {
  t = await createTestDb();
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["fair.demo", "fair.consume"], {
    retryLimit: 0,
    retryDelay: 1,
    retryBackoff: false,
  });
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await t?.drop();
});

/** `count` sự kiện của tổ chức, cũ hơn mọi sự kiện thêm sau (created_at lùi theo `ageSeconds`). */
async function backlog(org: SeededOrg, eventType: string, count: number, ageSeconds = 3600): Promise<void> {
  await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id, created_at)
            select gen_random_uuid(), ${org.orgId}, ${eventType}, jsonb_build_object('seq', g), 'fair',
                   now() - make_interval(secs => ${ageSeconds}) + make_interval(secs => g / 1000.0)
            from generate_series(1, ${count}) g`.execute(t.admin);
}
async function one(org: SeededOrg, eventType: string): Promise<string> {
  const id = randomUUID();
  await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
            values (${id}, ${org.orgId}, ${eventType}, '{}'::jsonb, 'fair-b')`.execute(t.admin);
  return id;
}
async function clear(...orgs: SeededOrg[]) {
  for (const o of orgs) await sql`delete from outbox where organization_id = ${o.orgId}`.execute(t.admin);
}
const claim = async (limit: number, perOrg = N) =>
  (
    await sql<{
      id: string;
      organization_id: string;
    }>`select id, organization_id from app.outbox_claim(${limit}, ${perOrg})`.execute(t.worker)
  ).rows;

describe("app.outbox_claim — vòng tròn có trần mỗi tổ chức", () => {
  it("A có 5×N sự kiện cũ hơn, B có 1 ⇒ lượt claim đầu (lô N) đã có sự kiện của B, A tối đa N hàng", async () => {
    const A = await seedOrg(t.admin, "Fair A");
    const B = await seedOrg(t.admin, "Fair B");
    await backlog(A, "fair.demo", 5 * N);
    const b = await one(B, "fair.demo");
    const rows = await claim(N);
    expect(rows.map((r) => r.id)).toContain(b);
    expect(rows.filter((r) => r.organization_id === A.orgId).length).toBeLessThanOrEqual(N);
    expect(rows).toHaveLength(N);
    // Thứ tự trả về theo vòng: B nằm trong vòng đầu (vị trí ≤ số tổ chức có việc).
    expect(rows.findIndex((r) => r.id === b)).toBeLessThan(2);
    await clear(A, B);
  });

  it("lô lớn: mỗi tổ chức không quá p_per_org; tổ chức đơn lẻ vẫn lấy theo thứ tự cũ nhất trước", async () => {
    const A = await seedOrg(t.admin, "Fair A2");
    const B = await seedOrg(t.admin, "Fair B2");
    await backlog(A, "fair.demo", 5 * N);
    await backlog(B, "fair.demo", 3, 60);
    const rows = await claim(100);
    expect(rows.filter((r) => r.organization_id === A.orgId)).toHaveLength(N);
    expect(rows.filter((r) => r.organization_id === B.orgId)).toHaveLength(3);
    // Lượt sau: hàng đã lease không bị lấy lại; A tiếp tục N hàng kế.
    const next = await claim(100);
    expect(next.filter((r) => r.organization_id === A.orgId)).toHaveLength(N);
    expect(next.some((r) => rows.some((x) => x.id === r.id))).toBe(false);
    await clear(A, B);
  });

  it("A dồn 10.000 sự kiện: B vẫn được lấy ngay lượt đầu, claim vẫn nhanh", async () => {
    const A = await seedOrg(t.admin, "Fair A3");
    const B = await seedOrg(t.admin, "Fair B3");
    await backlog(A, "fair.demo", 10_000);
    const b = await one(B, "fair.demo");
    await sql`analyze outbox`.execute(t.admin);
    const started = performance.now();
    const rows = await claim(100);
    const ms = performance.now() - started;
    expect(rows.map((r) => r.id)).toContain(b);
    expect(ms).toBeLessThan(2_000);
    await clear(A, B);
  });

  it("p_per_org/p_limit ngoài miền được kẹp (≤ 0 ⇒ 1); hai relay song song không lấy trùng", async () => {
    const A = await seedOrg(t.admin, "Fair A4");
    await backlog(A, "fair.demo", 30);
    expect(await claim(0, 0)).toHaveLength(1);
    const [x, y] = await Promise.all([claim(100, 15), claim(100, 15)]);
    const ids = [...(x ?? []), ...(y ?? [])].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    await clear(A);
  });
});

describe("relayOutbox + consumer — B không chờ backlog của A", () => {
  it("relay lượt đầu đã gửi job của B, job mang group_id = tổ chức", async () => {
    const A = await seedOrg(t.admin, "Relay A");
    const B = await seedOrg(t.admin, "Relay B");
    await backlog(A, "fair.demo", 5 * N);
    const b = await one(B, "fair.demo");
    const n = await relayOutbox(t.worker, boss, N, { consumed: new Set(["fair.demo"]) });
    expect(n).toBe(N);
    const job = await sql<{
      group_id: string | null;
    }>`select group_id from pgboss.job where name = 'fair.demo' and id = ${b}`.execute(t.admin);
    expect(job.rows[0]?.group_id).toBe(B.orgId);
    const published = await sql<{
      n: number;
    }>`select count(*)::int as n from outbox where id = ${b} and published_at is not null`.execute(t.admin);
    expect(published.rows[0]?.n).toBe(1);
  });

  it("consumer: A có 5 job chậm xếp trước, B có 1 ⇒ B xong trước khi A xong job thứ 2; A không bao giờ chạy > 1 job cùng lúc", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const done: string[] = [];
    const running = new Map<string, number>();
    let maxA = 0;
    const handler = async (job: OutboxJob) => {
      const org = job.organization_id;
      running.set(org, (running.get(org) ?? 0) + 1);
      if (org === A) maxA = Math.max(maxA, running.get(org) ?? 0);
      await new Promise((r) => setTimeout(r, org === A ? 700 : 10));
      running.set(org, (running.get(org) ?? 1) - 1);
      done.push(org === A ? `A${String(job.payload.seq)}` : "B");
    };
    const send = (org: string, seq: number) =>
      boss.send(
        "fair.consume",
        {
          organization_id: org,
          outbox_id: randomUUID(),
          event_type: "fair.consume",
          aggregate_id: null,
          payload: { seq },
          correlation_id: "c",
        },
        { group: { id: org } },
      );
    for (let i = 1; i <= 5; i++) await send(A, i);
    await send(B, 1);
    await startConsumers(boss, { "fair.consume": handler }, { pollingIntervalSeconds: 0.5 });
    const end = Date.now() + 30_000;
    while (done.length < 6 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(done).toHaveLength(6);
    expect(done.indexOf("B")).toBeLessThanOrEqual(1);
    expect(maxA).toBeLessThanOrEqual(CONSUMER_GROUP_CONCURRENCY);
  });
});
