// T-2314 (D-130, IND-SAAS-008) — fair-share theo tổ chức trên Postgres thật + pg-boss thật:
//  · `app.outbox_claim` lấy vòng tròn ưu tiên ≤ `p_per_org` hàng/tổ chức rồi LẤP ĐẦY `p_limit` theo thứ tự cũ (D-132): A dồn 5×N (và
//    10.000) sự kiện, B có 1 ⇒ lượt claim ĐẦU đã có sự kiện của B; tổ chức đơn lẻ vẫn xả đủ lô; trong một tổ chức giữ thứ tự;
//  · relay gửi job kèm `group.id = organization_id`; consumer chạy tuần tự (localConcurrency 1) ⇒ thứ tự sự kiện trong tổ chức giữ
//    như trước T-2314 (fair-share bảo đảm ở bước claim).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureQueues, type OutboxJob, RELAY_PER_ORG, relayOutbox, startConsumers } from "./relay.ts";

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

/** Thứ tự `seq` (payload) của các hàng `rows` thuộc tổ chức `org` theo đúng thứ tự trả về. */
async function seqs(rows: { id: string; organization_id: string }[], org: SeededOrg): Promise<number[]> {
  const ids = rows.filter((r) => r.organization_id === org.orgId).map((r) => r.id);
  const m = new Map(
    (
      await sql<{
        id: string;
        seq: number;
      }>`select id, (payload->>'seq')::int as seq from outbox where id = any(${ids}::uuid[])`.execute(t.admin)
    ).rows.map((r) => [r.id, r.seq]),
  );
  return ids.map((id) => m.get(id) as number);
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("app.outbox_claim — vòng tròn ưu tiên mỗi tổ chức + lấp đầy lô", () => {
  it("một tổ chức 1.000 hàng ⇒ lượt claim đầu trả ĐỦ p_limit, đúng thứ tự cũ nhất trước; lượt sau nối tiếp liền mạch", async () => {
    const A = await seedOrg(t.admin, "Fair đơn lẻ");
    await backlog(A, "fair.demo", 1_000);
    const first = await claim(100);
    expect(first).toHaveLength(100);
    expect(await seqs(first, A)).toEqual(range(1, 100));
    const second = await claim(100);
    expect(await seqs(second, A)).toEqual(range(101, 200));
    await clear(A);
  });

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

  it("lô lớn: vòng tròn trước (≤ p_per_org mỗi tổ chức), phần còn lại lấp theo thứ tự cũ; trong tổ chức là tiền tố liên tục", async () => {
    const A = await seedOrg(t.admin, "Fair A2");
    const B = await seedOrg(t.admin, "Fair B2");
    const C = await seedOrg(t.admin, "Fair C2");
    await backlog(A, "fair.demo", 20 * N);
    await backlog(B, "fair.demo", 3, 60);
    await backlog(C, "fair.demo", 5 * N, 1800);
    const rows = await claim(100);
    expect(rows).toHaveLength(100);
    // Phần vòng tròn đứng đầu: N của A, 3 của B, N của C (vòng 1 có cả 3 tổ chức).
    expect(new Set(rows.slice(0, 3).map((r) => r.organization_id))).toEqual(
      new Set([A.orgId, B.orgId, C.orgId]),
    );
    expect(rows.filter((r) => r.organization_id === B.orgId)).toHaveLength(3);
    // Lấp đầy 100 − (N + 3 + N) theo created_at: A cũ nhất ⇒ phần lấp thuộc A (C mới hơn mọi hàng A).
    const a = await seqs(rows, A);
    expect(a).toEqual(range(1, 100 - 3 - N));
    expect(await seqs(rows, C)).toEqual(range(1, N));
    expect(await seqs(rows, B)).toEqual([1, 2, 3]);
    // Lượt sau: hàng đã lease không bị lấy lại; A, C nối tiếp liền mạch.
    const next = await claim(100);
    expect(next.some((r) => rows.some((x) => x.id === r.id))).toBe(false);
    expect((await seqs(next, A))[0]).toBe(a.length + 1);
    expect((await seqs(next, C))[0]).toBe(N + 1);
    for (const o of [A, C]) {
      const s2 = await seqs(next, o);
      expect(s2).toEqual(range(s2[0] as number, (s2[0] as number) + s2.length - 1));
    }
    await clear(A, B, C);
  });

  // Tốc độ claim không đo bằng đồng hồ (chập chờn khi CI chạy song song): kế hoạch truy vấn được ghim ở db-perf
  // (`docs/db/explain/outbox-claim.txt`, `outbox-claim-fill.txt`).
  it("A dồn 10.000 sự kiện: B vẫn được lấy ngay lượt đầu, lô vẫn đầy", async () => {
    const A = await seedOrg(t.admin, "Fair A3");
    const B = await seedOrg(t.admin, "Fair B3");
    await backlog(A, "fair.demo", 10_000);
    const b = await one(B, "fair.demo");
    await sql`analyze outbox`.execute(t.admin);
    const rows = await claim(100);
    expect(rows.map((r) => r.id)).toContain(b);
    expect(rows).toHaveLength(100);
    await clear(A, B);
  });

  it("p_per_org/p_limit ngoài miền được kẹp (≤ 0 ⇒ 1; > 1000 ⇒ 1000); hai relay song song không lấy trùng, cùng nhau đủ backlog", async () => {
    const A = await seedOrg(t.admin, "Fair A4");
    const B = await seedOrg(t.admin, "Fair B4");
    await backlog(A, "fair.demo", 30);
    expect(await claim(0, 0)).toHaveLength(1);
    await backlog(B, "fair.demo", 1_200, 600);
    expect(await claim(5_000, 5_000)).toHaveLength(1_000);
    await clear(A, B);
    await backlog(A, "fair.demo", 300);
    await backlog(B, "fair.demo", 300, 600);
    const [x, y] = await Promise.all([claim(250, 15), claim(250, 15)]);
    const ids = [...(x ?? []), ...(y ?? [])].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(500);
    await clear(A, B);
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

  it("consumer tuần tự: job xen kẽ hai tổ chức, thời gian xử lý khác nhau ⇒ mỗi tổ chức xong đúng thứ tự gửi, không chạy chồng", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const done: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const handler = async (job: OutboxJob) => {
      const org = job.organization_id;
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Job đầu chậm nhất: chạy song song sẽ làm job sau của cùng tổ chức xong trước.
      const seq = Number(job.payload.seq);
      await new Promise((r) => setTimeout(r, seq === 1 ? 400 : 20));
      running--;
      done.push(`${org === A ? "A" : "B"}${seq}`);
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
    for (let i = 1; i <= 4; i++) {
      await send(A, i);
      await send(B, i);
    }
    await startConsumers(boss, { "fair.consume": handler }, { pollingIntervalSeconds: 0.5 });
    const end = Date.now() + 30_000;
    while (done.length < 8 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(done).toHaveLength(8);
    expect(done.filter((d) => d.startsWith("A"))).toEqual(["A1", "A2", "A3", "A4"]);
    expect(done.filter((d) => d.startsWith("B"))).toEqual(["B1", "B2", "B3", "B4"]);
    expect(maxRunning).toBe(1);
  });
});
