// T-008 — outbox relay → pg-boss: không phát trùng khi nhiều relay chạy song song, job mang organization_id
// (IND-SAAS-003), handler lỗi được retry rồi vào dead letter.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_ONLY_EVENT_TYPES,
  DEAD_LETTER_QUEUE,
  ensureQueues,
  type OutboxJob,
  relayOutbox,
  startConsumers,
} from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let boss: PgBoss;

async function addOutbox(orgId: string, eventType: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id)
              values (${id}, ${orgId}, ${eventType}, ${JSON.stringify({ seq: i })}::jsonb, ${`c-${i}`})`.execute(
      t.admin,
    );
  }
  return ids;
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Relay A");
  B = await seedOrg(t.admin, "Relay B");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["person.created"], { retryLimit: 0, retryDelay: 1, retryBackoff: false });
  await ensureQueues(boss, ["demo.failing"], { retryLimit: 2, retryDelay: 1, retryBackoff: false });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("relay outbox", () => {
  it("3 relay chạy song song → mỗi hàng phát đúng 1 lần, handler nhận đúng organization_id", async () => {
    const idsA = await addOutbox(A.orgId, "person.created", 5);
    const idsB = await addOutbox(B.orgId, "person.created", 3);
    const seen: OutboxJob[] = [];
    await startConsumers(
      boss,
      { "person.created": async (job) => void seen.push(job) },
      { pollingIntervalSeconds: 0.5 },
    );

    const counts = await Promise.all([
      relayOutbox(t.worker, boss),
      relayOutbox(t.worker, boss),
      relayOutbox(t.worker, boss),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
    expect(await relayOutbox(t.worker, boss)).toBe(0);

    await waitFor(() => seen.length >= 8);
    await new Promise((r) => setTimeout(r, 600));
    expect(seen).toHaveLength(8);
    expect(new Set(seen.map((j) => j.outbox_id))).toEqual(new Set([...idsA, ...idsB]));
    for (const j of seen) expect(j.organization_id).toBe(idsA.includes(j.outbox_id) ? A.orgId : B.orgId);

    const pending = await sql<{
      n: number;
    }>`select count(*)::int as n from outbox where published_at is null`.execute(t.admin);
    expect(pending.rows[0]?.n).toBe(0);
  });

  it("payload chỉ mang id/số — worker không cần đọc dữ liệu cá nhân", async () => {
    const r = await sql<{ payload: Record<string, unknown> }>`select payload from outbox limit 1`.execute(
      t.admin,
    );
    expect(
      Object.values(r.rows[0]?.payload ?? {}).every((v) => typeof v !== "string" || !/@|\s/.test(v)),
    ).toBe(true);
  });

  it("handler lỗi → retry 2 lần rồi vào dead letter, nguồn nghiệp vụ không bị xoá", async () => {
    const [id] = await addOutbox(A.orgId, "demo.failing", 1);
    let attempts = 0;
    const dead: OutboxJob[] = [];
    await startConsumers(
      boss,
      {
        "demo.failing": async () => {
          attempts++;
          throw new Error("đối tác không phản hồi");
        },
        [DEAD_LETTER_QUEUE]: async (job) => void dead.push(job),
      },
      { pollingIntervalSeconds: 0.5 },
    );
    expect(await relayOutbox(t.worker, boss)).toBe(1);
    await waitFor(() => dead.length === 1, 20_000);
    expect(attempts).toBe(3);
    expect(dead[0]?.outbox_id).toBe(id);
    const src = await sql<{ n: number }>`select count(*)::int as n from outbox where id = ${id}`.execute(
      t.admin,
    );
    expect(src.rows[0]?.n).toBe(1);
  });

  it("app_worker không SELECT/UPDATE trực tiếp outbox — chỉ qua hàm claim/mark", async () => {
    await expect(
      t.worker.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
        return sql`select count(*) from outbox`.execute(trx);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("sự kiện chưa có consumer (review lát 7 🟠2, D-026)", () => {
  async function row(id: string) {
    const r = await sql<{
      published: boolean;
      attempts: number;
      last_error: string | null;
      delayed: boolean;
    }>`select published_at is not null as published, attempts, last_error, available_at > now() as delayed
       from outbox where id = ${id}`.execute(t.admin);
    return r.rows[0];
  }

  it("2 worker: một có handler `foo.bar`, một không ⇒ worker không handler KHÔNG làm mất sự kiện; worker có handler nhận được sau đó", async () => {
    const [foo] = await addOutbox(A.orgId, "foo.bar", 1);
    const [later] = await addOutbox(A.orgId, "person.created", 1);
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const log = (event: string, fields: Record<string, unknown>) => void events.push({ event, fields });

    // Worker X: chỉ có consumer person.created (đã đăng ký ở phần trên) — không có foo.bar.
    const seen: OutboxJob[] = [];
    await startConsumers(
      boss,
      { "person.created": async (job) => void seen.push(job) },
      { pollingIntervalSeconds: 0.5 },
    ).catch(() => {}); // đã đăng ký ở test trước: bỏ qua
    await relayOutbox(t.worker, boss, 100, { consumed: new Set(["person.created"]), log });

    const afterX = await row(foo as string);
    expect(afterX?.published).toBe(false); // KHÔNG đánh dấu đã phát
    expect(afterX?.last_error).toBe("no_consumer");
    expect(afterX?.attempts).toBe(1);
    expect(afterX?.delayed).toBe(true); // lùi lần thử ⇒ không kẹt đầu hàng
    expect(events).toContainEqual({
      event: "outbox.no_consumer",
      fields: expect.objectContaining({ event_type: "foo.bar", outbox_id: foo }),
    });
    // hàng cũ hơn chưa xử lý được không chặn hàng sau nó
    expect((await row(later as string))?.published).toBe(true);
    // lượt kế tiếp không đụng lại hàng đang lùi
    expect(await relayOutbox(t.worker, boss, 100, { consumed: new Set(["person.created"]), log })).toBe(0);

    // Worker Y: có handler foo.bar. Hết thời gian lùi ⇒ nhận và phát.
    await ensureQueues(boss, ["foo.bar"], { retryLimit: 0, retryDelay: 1, retryBackoff: false });
    const got: OutboxJob[] = [];
    await startConsumers(
      boss,
      { "foo.bar": async (job) => void got.push(job) },
      { pollingIntervalSeconds: 0.5 },
    );
    await sql`update outbox set available_at = now() where id = ${foo}`.execute(t.admin);
    expect(await relayOutbox(t.worker, boss, 100, { consumed: new Set(["foo.bar"]), log })).toBe(1);
    await waitFor(() => got.some((j) => j.outbox_id === foo));
    expect((await row(foo as string))?.published).toBe(true);
  });

  it("event_type khai trong danh sách 'chỉ để audit' ⇒ đánh dấu đã phát, không sinh job, không log no_consumer", async () => {
    const [id] = await addOutbox(A.orgId, "audit.only", 1);
    const events: string[] = [];
    await relayOutbox(t.worker, boss, 100, {
      consumed: new Set(["person.created"]),
      auditOnly: new Set(["audit.only"]),
      log: (e) => void events.push(e),
    });
    expect((await row(id as string))?.published).toBe(true);
    expect(events).not.toContain("outbox.no_consumer");
    const jobs = await sql<{
      n: number;
    }>`select count(*)::int as n from pgboss.job where name = 'audit.only'`.execute(t.admin);
    expect(jobs.rows[0]?.n).toBe(0);
  });

  it("lỗi gửi (boss.send ném) cũng lùi lần thử: không kẹt đầu hàng, không mất", async () => {
    const [bad] = await addOutbox(A.orgId, "never.queued", 1); // không có queue ⇒ boss.send lỗi
    await relayOutbox(t.worker, boss, 100);
    const r = await row(bad as string);
    expect(r?.published).toBe(false);
    expect(r?.last_error).toBeTruthy();
    expect(r?.delayed).toBe(true);
  });

  it("danh sách audit-only là hằng khai tường minh, không chứa loại có consumer", () => {
    for (const consumed of [
      "invoice.issued",
      "work_order.status_changed",
      "portal.tenant_invited",
      "export.requested",
    ])
      expect(AUDIT_ONLY_EVENT_TYPES.has(consumed)).toBe(false);
    expect(AUDIT_ONLY_EVENT_TYPES.size).toBeGreaterThan(10);
  });
});
