// BASE-ERR-006 — job worker mang trace từ outbox: `outbox.traceparent` → job pg-boss → handler chạy trong span con (cùng trace_id).
import { randomUUID } from "node:crypto";
import { createLogger } from "@hm/app";
import { assertLogRecords } from "@hm/app/testing/log-schema";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureQueues, type OutboxJob, relayOutbox, startConsumers } from "./relay.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;

const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const TP = `00-${TID}-${PARENT}-01`;

async function addOutbox(eventType: string, traceparent: string | null): Promise<string> {
  const id = randomUUID();
  await sql`insert into outbox (id, organization_id, event_type, payload, correlation_id, traceparent)
            values (${id}, ${A.orgId}, ${eventType}, '{}'::jsonb, 'c-1', ${traceparent})`.execute(t.admin);
  return id;
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Relay Trace");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await ensureQueues(boss, ["trace.demo", "trace.none"], {
    retryLimit: 0,
    retryDelay: 1,
    retryBackoff: false,
  });
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("outbox.traceparent (migration 0054)", () => {
  it.each([
    ["chữ hoa", `00-${TID.toUpperCase()}-${PARENT}-01`],
    ["trace-id toàn 0", `00-${"0".repeat(32)}-${PARENT}-01`],
    ["span-id toàn 0", `00-${TID}-${"0".repeat(16)}-01`],
    ["version khác 00", `01-${TID}-${PARENT}-01`],
    ["cờ không phải 00/01", `00-${TID}-${PARENT}-03`],
    ["rác", "không phải traceparent"],
    ["rỗng", ""],
  ])("CSDL từ chối traceparent sai dạng: %s", async (_n, v) => {
    await expect(addOutbox("trace.demo", v)).rejects.toThrow(/ck_outbox_traceparent/);
  });

  it("NULL được phép (ghi ngoài request/job)", async () => {
    await expect(addOutbox("trace.none", null)).resolves.toBeTruthy();
  });

  it("app.outbox_claim trả traceparent; relay chép vào job (null khi không có)", async () => {
    await sql`delete from outbox`.execute(t.admin);
    const a = await addOutbox("trace.demo", TP);
    const b = await addOutbox("trace.none", null);
    const sent: Record<string, OutboxJob> = {};
    const spy = {
      send: async (_n: string, data: OutboxJob) => {
        sent[data.outbox_id] = data;
        return "x";
      },
    } as unknown as PgBoss;
    expect(await relayOutbox(t.worker, spy)).toBe(2);
    expect(sent[a]?.traceparent).toBe(TP);
    expect(sent[b]?.traceparent).toBeNull();
  });
});

describe("consumer chạy job trong span con của trace outbox", () => {
  it("job có traceparent ⇒ log trong handler: cùng trace_id, span_id mới; job không có ⇒ trace mới", async () => {
    await sql`delete from outbox`.execute(t.admin);
    const lines: string[] = [];
    const log = createLogger({
      sink: { write: (l) => lines.push(l) },
      service: "hm-test",
      version: "0",
      env: "test",
    });
    const handled: string[] = [];
    const handler = async (job: OutboxJob) => {
      await new Promise((r) => setTimeout(r, 5));
      log.info("handler chạy", { outbox_id: job.outbox_id });
      handled.push(job.outbox_id);
    };
    await startConsumers(
      boss,
      { "trace.demo": handler, "trace.none": handler },
      { pollingIntervalSeconds: 0.5 },
    );
    const withTp = await addOutbox("trace.demo", TP);
    const without = await addOutbox("trace.none", null);
    expect(await relayOutbox(t.worker, boss)).toBe(2);
    await waitFor(() => handled.length === 2);
    const recs = assertLogRecords(lines, 2);
    const a = recs.find((r) => r.outbox_id === withTp);
    const b = recs.find((r) => r.outbox_id === without);
    expect(a?.trace_id).toBe(TID);
    expect(a?.span_id).not.toBe(PARENT);
    expect(b?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(b?.trace_id).not.toBe(TID);
  });
});
