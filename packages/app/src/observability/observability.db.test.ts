// PLAN đợt 3 T-225 — /api/metrics + /api/ready trên Postgres thật + SeaweedFS (BASE-OBS-*; D-021).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { collectMetrics, handleMetrics, handleReady, metricsToken } from "./metrics.ts";

let t: TestDb;
let A: SeededOrg;
let storage: ObjectStorage;
const SECRET = "test-secret-at-least-32-characters-long!!";
const NOW = new Date("2026-10-16T05:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS Mai");
  // Outbox: 2 chưa phát (1 đã thử lỗi, cũ 10 phút), 1 đã phát.
  for (const [ago, attempts, published] of [
    [600, 2, false],
    [60, 0, false],
    [30, 0, true],
  ] as const)
    await sql`insert into outbox (id, organization_id, event_type, aggregate_type, payload, correlation_id, created_at, attempts,
                                  published_at)
              values (${randomUUID()}, ${A.orgId}, 'test.event', 'test', '{}'::jsonb, 'c-obs',
                      ${new Date(NOW.getTime() - ago * 1000)}, ${attempts}, ${published ? NOW : null})`.execute(
      t.admin,
    );
  // Một lần gửi email đã dead.
  const n = randomUUID();
  await sql`insert into notifications (id, organization_id, recipient_person_id, type, title, body, vars, dedupe_key)
            values (${n}, ${A.orgId}, ${A.ownerPersonId}, 'export_ready', 't', 'b', '{}'::jsonb, ${`obs:${n}`})`.execute(
    t.admin,
  );
  const d = randomUUID();
  await sql`insert into notification_deliveries (id, organization_id, notification_id, channel, status, next_attempt_at)
            values (${d}, ${A.orgId}, ${n}, 'email', 'queued', now())`.execute(t.admin);
  await sql`update notification_deliveries set status = 'sending', attempts = 6, locked_until = now() where id = ${d}`.execute(
    t.admin,
  );
  await sql`update notification_deliveries set status = 'dead', locked_until = null where id = ${d}`.execute(
    t.admin,
  );
  await sql`select app.worker_heartbeat('worker-1', ${new Date(NOW.getTime() - 15_000)})`.execute(t.worker);
});

afterAll(async () => {
  await t?.drop();
});

const value = (samples: Awaited<ReturnType<typeof collectMetrics>>, name: string, label?: [string, string]) =>
  samples.find((s) => s.name === name && (!label || s.labels?.[label[0]] === label[1]))?.value;

describe("số liệu", () => {
  it("outbox chưa phát 2, cũ nhất 600 giây, 1 đang lỗi; notification_dead_total 1; nhịp worker 15 giây; không nhãn tổ chức", async () => {
    const s = await collectMetrics(t.runtime, NOW);
    expect(value(s, "hm_up")).toBe(1);
    expect(value(s, "hm_outbox_unpublished")).toBe(2);
    expect(value(s, "hm_outbox_oldest_unpublished_age_seconds")).toBe(600);
    expect(value(s, "hm_outbox_failing")).toBe(1);
    expect(value(s, "notification_dead_total")).toBe(1);
    expect(value(s, "hm_notification_deliveries", ["status", "dead"])).toBe(1);
    expect(value(s, "hm_notification_deliveries", ["status", "sent"])).toBe(0);
    expect(value(s, "hm_export_jobs", ["status", "failed"])).toBe(0);
    expect(value(s, "hm_worker_heartbeat_age_seconds", ["worker", "worker-1"])).toBe(15);
    expect(JSON.stringify(s)).not.toContain(A.orgId);
  });

  it("GET /api/metrics có token → 200 text/plain Prometheus; sai token → 401", async () => {
    const ok = await handleMetrics(
      new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${metricsToken(SECRET)}` } }),
      { db: t.runtime, secret: SECRET },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const body = await ok.text();
    expect(body).toContain("# TYPE notification_dead_total counter\nnotification_dead_total 1\n");
    expect(body).toMatch(/^hm_outbox_unpublished 2$/m);
    const bad = await handleMetrics(
      new Request("http://x/api/metrics", { headers: { authorization: "Bearer sai" } }),
      { db: t.runtime, secret: SECRET },
    );
    expect(bad.status).toBe(401);
  });

  it("vai trò runtime không ghi được nhịp worker, không đọc trực tiếp bảng nhịp", async () => {
    await expect(sql`select app.worker_heartbeat('x', now())`.execute(t.runtime)).rejects.toThrow(
      /permission/,
    );
    await expect(sql`select * from worker_heartbeats`.execute(t.runtime)).rejects.toThrow(/permission/);
  });
});

describe("/api/ready", () => {
  it("CSDL + SeaweedFS + máy quét → 200 ready; kho trỏ sai bucket → 503 storage fail", async () => {
    const ok = await handleReady({ db: t.runtime, storage, scanner: eicarOnlyScanner });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      status: "ready",
      checks: { database: "ok", storage: "ok", scanner: "ok" },
    });
    const wrong = new ObjectStorage({ ...testS3Config(), bucket: `khong-co-${randomUUID().slice(0, 8)}` });
    const bad = await handleReady({ db: t.runtime, storage: wrong, scanner: eicarOnlyScanner });
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({
      status: "not_ready",
      checks: { storage: "fail", database: "ok" },
    });
  });
});
