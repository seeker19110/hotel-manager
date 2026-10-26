// T-401 — relay claim → commit → `boss.send` → đánh dấu (ARC-INT-003, DB-TX-003) + lỗi vĩnh viễn không retry (BE-JOB-003)
// + dead letter đo được (BE-JOB-004). Chạy trên Postgres thật + pg-boss thật.
import { randomUUID } from "node:crypto";
import { CommandError, collectMetrics, InvalidJobPayloadError } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEAD_LETTER_QUEUE, ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;

async function addOutbox(eventType: string, n = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
              values (${id}, ${A.orgId}, ${eventType}, ${JSON.stringify({ seq: i })}::jsonb, ${`c-${i}`})`.execute(
      t.admin,
    );
  }
  return ids;
}

async function row(id: string) {
  const r = await sql<{
    published: boolean;
    attempts: number;
    last_error: string | null;
    leased: boolean;
    soon: boolean;
  }>`select published_at is not null as published, attempts, last_error,
            available_at > now() + interval '30 seconds' as leased,
            available_at <= now() + interval '10 seconds' as soon
     from outbox where id = ${id}`.execute(t.admin);
  return r.rows[0];
}

async function jobCount(name: string, id?: string): Promise<number> {
  const r = await sql<{ n: number }>`select count(*)::int as n from pgboss.job
    where name = ${name} and (${id ?? null}::uuid is null or id = ${id ?? null}::uuid)`.execute(t.admin);
  return r.rows[0]?.n ?? 0;
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Relay Claim");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["claim.demo", "perm.demo", "trans.demo"], {
    retryLimit: 2,
    retryDelay: 1,
    retryBackoff: false,
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("relay claim ngắn — gửi pg-boss NGOÀI transaction", () => {
  it("khi `boss.send` chạy: hàng đã commit lease (không bị khoá), không có phiên idle-in-transaction", async () => {
    const [id] = await addOutbox("claim.demo");
    const observed: { locked: boolean; leased: boolean; idleInTx: number }[] = [];
    const spy = {
      send: async (name: string, data: object, options: { id: string }) => {
        // Kết nối KHÁC (admin): nếu relay còn giữ transaction claim thì FOR UPDATE NOWAIT sẽ lỗi 55P03.
        const locked = await sql`select 1 from outbox where id = ${id} for update nowait`
          .execute(t.admin)
          .then(() => false)
          .catch(() => true);
        const st = await row(id as string);
        const idle = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and state like 'idle in transaction%'`.execute(t.admin);
        observed.push({ locked, leased: st?.leased ?? false, idleInTx: idle.rows[0]?.n ?? -1 });
        return boss.send(name, data, options);
      },
    } as unknown as PgBoss;
    expect(await relayOutbox(t.worker, spy)).toBe(1);
    expect(observed).toEqual([{ locked: false, leased: true, idleInTx: 0 }]);
    expect((await row(id as string))?.published).toBe(true);
    expect(await jobCount("claim.demo", id)).toBe(1);
  });

  it("sập sau khi gửi, trước khi đánh dấu: chưa hết lease ⇒ không claim lại; hết lease ⇒ claim lại, pg-boss không tạo job thứ hai", async () => {
    const [id] = await addOutbox("claim.demo");
    // Mô phỏng tiến trình chết: claim + gửi thật, KHÔNG gọi outbox_mark.
    const claimed = await sql<{ id: string }>`select id from app.outbox_claim(10, 10)`.execute(t.worker);
    expect(claimed.rows.map((r) => r.id)).toEqual([id]);
    await boss.send("claim.demo", { outbox_id: id }, { id: id as string });
    expect(await jobCount("claim.demo", id)).toBe(1);
    expect((await row(id as string))?.published).toBe(false);

    // Trong lease: relay khác không thấy hàng ⇒ không phát trùng.
    expect(await relayOutbox(t.worker, boss)).toBe(0);

    // Hết lease (giả lập bằng cách lùi đồng hồ của hàng): được claim lại, gửi lại là no-op, đánh dấu đã phát.
    await sql`update outbox set available_at = now() - interval '1 second' where id = ${id}`.execute(t.admin);
    expect(await relayOutbox(t.worker, boss)).toBe(1);
    expect((await row(id as string))?.published).toBe(true);
    expect(await jobCount("claim.demo", id)).toBe(1);
  });

  it("gửi lỗi ⇒ ghi lỗi + lùi lần thử ngắn (backoff), hàng chưa mất; lần sau gửi được", async () => {
    const [id] = await addOutbox("claim.demo");
    const failing = {
      send: async () => {
        throw new Error("pg-boss tạm hỏng");
      },
    } as unknown as PgBoss;
    expect(await relayOutbox(t.worker, failing)).toBe(1);
    const r = await row(id as string);
    expect(r).toMatchObject({ published: false, attempts: 1, last_error: "pg-boss tạm hỏng", leased: false });
    expect(r?.soon).toBe(true); // backoff 5 s thay cho lease 60 s

    await sql`update outbox set available_at = now() where id = ${id}`.execute(t.admin);
    expect(await relayOutbox(t.worker, boss)).toBe(1);
    expect((await row(id as string))?.published).toBe(true);
  });

  it("đánh dấu lỗi (CSDL chập chờn) không làm hỏng cả lượt: log `outbox.mark_failed`, hàng còn lại vẫn được xử lý", async () => {
    const [a, b] = await addOutbox("claim.demo", 2);
    const events: string[] = [];
    // workerDb giả: pool thật nhưng câu `app.outbox_mark` của hàng đầu ném lỗi (CSDL chập chờn).
    const pool = new pg.Pool({ connectionString: t.workerUrl, max: 2 });
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: typeof query }).query = async (...args: unknown[]) => {
        if (String(args[0]).includes("outbox_mark") && (args[1] as unknown[] | undefined)?.[0] === a)
          throw new Error("mất kết nối");
        return query(...args);
      };
      return client;
    };
    const flaky = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    expect(await relayOutbox(flaky, boss, 100, { log: (e) => void events.push(e) })).toBe(2);
    await flaky.destroy();
    expect(events).toContain("outbox.mark_failed");
    expect((await row(b as string))?.published).toBe(true);
    expect((await row(a as string))?.published).toBe(false); // sẽ được claim lại khi hết lease; send trùng là no-op
    await sql`update outbox set available_at = now() where id = ${a}`.execute(t.admin);
    await relayOutbox(t.worker, boss);
    expect((await row(a as string))?.published).toBe(true);
    expect(await jobCount("claim.demo", a)).toBe(1);
  });
});

describe("cấu hình queue thật (BE-JOB-003/004)", () => {
  it("chính sách mặc định áp vào pg-boss: 5 lần, backoff, trần 300 s, dead letter giữ 30 ngày", async () => {
    await ensureQueues(boss, ["policy.demo"]);
    const q = await sql<{
      retry_limit: number;
      retry_backoff: boolean;
      retry_delay_max: number;
      dead_letter: string;
    }>`select retry_limit, retry_backoff, retry_delay_max, dead_letter from pgboss.queue where name = 'policy.demo'`.execute(
      t.admin,
    );
    expect(q.rows[0]).toEqual({
      retry_limit: 5,
      retry_backoff: true,
      retry_delay_max: 300,
      dead_letter: DEAD_LETTER_QUEUE,
    });
    const dl = await sql<{ retention_seconds: number; deletion_seconds: number }>`
      select retention_seconds, deletion_seconds from pgboss.queue where name = ${DEAD_LETTER_QUEUE}`.execute(
      t.admin,
    );
    expect(dl.rows[0]).toEqual({ retention_seconds: 30 * 24 * 3600, deletion_seconds: 30 * 24 * 3600 });
  });
});

describe("lỗi vĩnh viễn không retry (BE-JOB-003) + dead letter đo được (BE-JOB-004)", () => {
  it("payload sai / lỗi nghiệp vụ 4xx ⇒ dead letter NGAY (1 lần chạy), job gốc hoàn tất; lỗi 5xx ⇒ vẫn retry", async () => {
    const calls = { perm: 0, trans: 0 };
    const dead: (OutboxJob & { dead_letter?: { kind: string; message: string } })[] = [];
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    await startConsumers(
      boss,
      {
        "perm.demo": async (job) => {
          calls.perm++;
          if (job.payload.seq === 0)
            throw new InvalidJobPayloadError("perm.demo", "payload sai schema ở: export_id");
          throw new CommandError("FORBIDDEN", 403, "không còn quyền");
        },
        "trans.demo": async () => {
          calls.trans++;
          throw new CommandError("SERVICE_UNAVAILABLE", 503, "đối tác bận");
        },
        [DEAD_LETTER_QUEUE]: async (job) => void dead.push(job),
      },
      { pollingIntervalSeconds: 0.5, log: (event, fields) => void events.push({ event, fields }) },
    );
    const [p0] = await addOutbox("perm.demo"); // seq 0 ⇒ InvalidJobPayloadError
    const [t0] = await addOutbox("trans.demo");
    const [p1] = await addOutbox("perm.demo"); // seq 0 cả hai (mỗi lần addOutbox bắt đầu từ 0)
    await sql`update outbox set payload = '{"seq": 1}'::jsonb where id = ${p1}`.execute(t.admin);
    expect(await relayOutbox(t.worker, boss)).toBe(3);

    await waitFor(() => dead.some((d) => d.outbox_id === p0) && dead.some((d) => d.outbox_id === p1));
    await waitFor(() => calls.trans >= 3, 30_000); // 1 lần + 2 retry rồi mới vào dead letter
    await waitFor(() => dead.some((d) => d.outbox_id === t0), 30_000);

    expect(calls.perm).toBe(2); // mỗi job lỗi vĩnh viễn chạy ĐÚNG 1 lần
    expect(calls.trans).toBe(3); // lỗi tạm: retryLimit 2 ⇒ 3 lần
    const d0 = dead.find((d) => d.outbox_id === p0);
    expect(d0?.dead_letter).toEqual({ kind: "permanent", message: "payload sai schema ở: export_id" });
    expect(dead.find((d) => d.outbox_id === p1)?.dead_letter?.kind).toBe("permanent");
    expect(dead.find((d) => d.outbox_id === t0)?.dead_letter).toBeUndefined(); // dead letter do hết lượt thử, không do phân loại
    expect(events.filter((e) => e.event === "job.permanent_failure")).toHaveLength(2);
    // Job gốc của lỗi vĩnh viễn đã hoàn tất (không kẹt retry).
    const states = () =>
      sql<{ state: string }>`select state from pgboss.job where name = 'perm.demo'`
        .execute(t.admin)
        .then((r) => r.rows.map((x) => x.state));
    // pg-boss hoàn tất job gốc sau khi handler trả về ⇒ chờ trạng thái cuối.
    await waitFor(async () => (await states()).every((x) => x === "completed"));
    expect(await states()).toEqual(["completed", "completed"]);
  });

  it("metric hm_dead_letter_jobs đếm job còn nằm trong dead letter; xử lý xong thì về 0", async () => {
    // Consumer dead letter của test ở trên còn chạy ⇒ hẹn giờ xa để job nằm lại như trên production (không ai nhận).
    await boss.send(DEAD_LETTER_QUEUE, { outbox_id: randomUUID() }, { startAfter: 3600 });
    await boss.send(DEAD_LETTER_QUEUE, { outbox_id: randomUUID() }, { startAfter: 3600 });
    const value = async () =>
      (await collectMetrics(t.runtime)).find((s) => s.name === "hm_dead_letter_jobs")?.value;
    const before = await value();
    expect(before).toBeGreaterThanOrEqual(2);
    await sql`update pgboss.job set state = 'completed', completed_on = now()
              where name = ${DEAD_LETTER_QUEUE} and state <> 'completed'`.execute(t.admin);
    expect(await value()).toBe(0);
  });
});
