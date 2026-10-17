// T-303 (DB-TX-003, D-025) — job xuất ghi object NGOÀI transaction: kho object chậm không giữ session `idle in transaction`;
// put lỗi để lại dòng staging `pending_scan` mà job hạn giữ dọn; chạy lại job ghi đè đúng object cũ.
import { testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { ObjectStorage } from "../files/storage.ts";
import { runRetention } from "../import/retention.ts";
import { okAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { probeIdleDuring } from "../testing/idle-probe.ts";
import { getExportStatus, requestExport, runExportJob } from "./exports.ts";

let h: Hotel;

class ProbingStorage extends ObjectStorage {
  puts = 0;
  maxIdleInTx = 0;
  failPut = false;
  override async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.puts += 1;
    // Kho chậm 600 ms: trong lúc chờ, đo session idle-in-transaction của runtime/worker.
    this.maxIdleInTx = Math.max(this.maxIdleInTx, await probeIdleDuring(h.t.admin, h.t.name, 600));
    if (this.failPut) throw new Error("S3 503");
    return super.put(key, body, contentType);
  }
}
let storage: ProbingStorage;

const fresh = (a: Actor): Actor => ({ ...a, authenticatedAt: new Date() });
const deps = () => ({ db: h.t.runtime, workerDb: h.t.worker, storage });
const job = (exportId: string) => ({ organization_id: h.org.orgId, payload: { export_id: exportId } });

const filesOf = async (exportId: string) =>
  (
    await sql<{ id: string; status: string; storage_key: string; delete_after: string | null }>`
      select id, status, storage_key, delete_after::text from files
      where owner_type = 'export_job' and owner_id = ${exportId} order by created_at`.execute(h.t.admin)
  ).rows;

beforeAll(async () => {
  h = await seedHotel();
  storage = new ProbingStorage(testS3Config());
  await storage.ensureBucket();
});

afterAll(async () => {
  await h?.t.drop();
});

describe("job xuất — ghi object ngoài transaction", () => {
  it("kho object chậm: không có session idle-in-transaction suốt lúc ghi; file ready, hạn giữ 2 ngày", async () => {
    const q = await okAs(h.t, fresh(h.owner), (ctx) =>
      requestExport(ctx, { kind: "deposits", format: "csv" }),
    );
    const puts0 = storage.puts;
    expect(await runExportJob(deps(), job(q.exportId))).toBe("ready");
    expect(storage.puts).toBe(puts0 + 1);
    expect(storage.maxIdleInTx).toBe(0);
    const files = await filesOf(q.exportId);
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("ready");
    expect(files[0]?.delete_after).not.toBeNull();
    const st = await getExportStatus(h.t.runtime, fresh(h.owner), q.exportId);
    expect(st.status).toBe("ready");
  });

  it("put lỗi → job failed INTERNAL, dòng staging pending_scan còn lại; runRetention sau hạn đánh dấu deleted", async () => {
    const q = await okAs(h.t, fresh(h.owner), (ctx) =>
      requestExport(ctx, { kind: "deposits", format: "csv" }),
    );
    storage.failPut = true;
    try {
      await expect(runExportJob(deps(), job(q.exportId))).rejects.toThrow("S3 503");
    } finally {
      storage.failPut = false;
    }
    const [orphan] = await filesOf(q.exportId);
    expect(orphan?.status).toBe("pending_scan");
    expect(orphan?.delete_after).not.toBeNull();
    const late = await runRetention(h.t.worker, storage, { now: new Date(Date.now() + 5 * 86_400_000) });
    expect(late.filesFailed).toBe(0);
    expect((await filesOf(q.exportId))[0]?.status).toBe("deleted");
  });
});
