// T-219 — job hạn giữ trong worker: đăng ký lịch pg-boss (idempotent) và xử lý job trên Postgres thật + SeaweedFS.
import { randomUUID } from "node:crypto";
import { ObjectStorage, type RetentionResult } from "@hm/app";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETENTION_CRON, RETENTION_QUEUE, scheduleRetention, startRetentionWorker } from "./jobs.ts";

let t: TestDb;
let A: SeededOrg;
let boss: PgBoss;
let storage: ObjectStorage;

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("quá thời gian chờ");
}

async function dueFile(): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = `${A.orgId}/import_batch/${id}`;
  await storage.put(key, new TextEncoder().encode("a,b\r\n1,2"), "text/csv");
  await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key, uploaded_by,
                               scanned_at, delete_after)
            values (${id}, ${A.orgId}, ${A.propertyId}, 'import_batch', 'text/csv', 8, ${"d".repeat(64)}, 'ready', ${key},
                    ${A.ownerMembershipId}, now(), (now() at time zone 'utc')::date - 1)`.execute(t.admin);
  return { id, key };
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Worker hạn giữ", "rental");
  boss = new PgBoss({ connectionString: t.adminUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await t.drop();
});

describe("job hạn giữ ở worker", () => {
  it("đăng ký lịch định kỳ; đăng ký lại nhiều lần vẫn một lịch", async () => {
    await scheduleRetention(boss);
    await scheduleRetention(boss);
    const schedules = (await boss.getSchedules()).filter((s) => s.name === RETENTION_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe(RETENTION_CRON);
  });

  it("nhận job → xoá file quá hạn; job thứ hai không lỗi, không xoá gì thêm", async () => {
    const results: RetentionResult[] = [];
    await startRetentionWorker(boss, t.worker, storage, {
      onResult: (r) => results.push(r),
      pollingIntervalSeconds: 0.5,
    });
    const f = await dueFile();
    await boss.send(RETENTION_QUEUE, {});
    await waitFor(() => results.some((r) => r.files.deleted >= 1));
    const row = await sql<{
      deleted_at: Date | null;
    }>`select deleted_at from files where id = ${f.id}`.execute(t.admin);
    expect(row.rows[0]?.deleted_at).not.toBeNull();
    const res = await fetch(await storage.signedGetUrl(f.key, 60));
    await res.arrayBuffer();
    expect(res.status).toBe(404);

    const n = results.length;
    await boss.send(RETENTION_QUEUE, {});
    await waitFor(() => results.length > n);
    expect(results.slice(n).every((r) => r.files.deleted === 0 && r.files.failed.length === 0)).toBe(true);
  });
});
