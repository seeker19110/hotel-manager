// T-219 — hạn giữ dữ liệu trên Postgres thật + SeaweedFS: xoá object theo `files.delete_after`, làm rỗng `import_rows.raw/data`
// sau 30 ngày commit/huỷ, chạy lại/chạy song song không lỗi, không xoá trùng, không chạm hàng chưa tới hạn (INV-G7; SPEC-import mục 10).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { cancelBatch, downloadErrorReport, getBatch, uploadBatch } from "../import/import.ts";
import { executeCommand } from "../pipeline/command.ts";
import { getFileUrl } from "./files.ts";
import { eicarOnlyScanner } from "./inspect.ts";
import {
  IMPORT_ROWS_RETENTION_DAYS,
  purgeExpiredFiles,
  type RetentionStorage,
  runRetention,
  scrubImportRows,
  utcDate,
} from "./retention.ts";
import { ObjectStorage } from "./storage.ts";

const DAY = 86_400_000;
let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let storage: ObjectStorage;
let owner: Actor;

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const dateOf = (d: Date) => utcDate(d);

/** File `import_batch` mồ côi (chưa gắn lô) có object thật; `put=false` mô phỏng object đã mất. */
async function seedFile(
  org: SeededOrg,
  deleteAfter: string | null,
  opts: { put?: boolean; ownerId?: string; ownerType?: "import_batch" | "work_order" } = {},
) {
  const id = randomUUID();
  const ownerType = opts.ownerType ?? "import_batch";
  const key = `${org.orgId}/${ownerType}/${id}`;
  if (opts.put !== false)
    await storage.put(key, new TextEncoder().encode("external_id,unit_code\r\nU-1,101"), "text/csv");
  await sql`insert into files (id, organization_id, property_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                               uploaded_by, scanned_at, delete_after)
            values (${id}, ${org.orgId}, ${org.propertyId}, ${ownerType}, ${opts.ownerId ?? null}, 'text/csv', 10,
                    ${"a".repeat(64)}, 'ready', ${key}, ${org.ownerMembershipId}, now(), ${deleteAfter}::date)`.execute(
    t.admin,
  );
  return { id, key };
}

async function exists(key: string): Promise<boolean> {
  const res = await fetch(await storage.signedGetUrl(key, 60));
  await res.arrayBuffer();
  if (res.status !== 200 && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  return res.status === 200;
}

const deletedAt = async (id: string) =>
  (await sql<{ d: Date | null }>`select deleted_at as d from files where id = ${id}`.execute(t.admin)).rows[0]
    ?.d ?? null;

/** Lô nhập có file + 3 dòng chứa PII; `finishedAt` là lúc commit/huỷ. */
async function seedBatch(
  org: SeededOrg,
  status: "validated" | "committed" | "cancelled",
  finishedAt: Date | null,
) {
  const batchId = randomUUID();
  const file = await seedFile(org, null, { ownerId: batchId, put: false });
  const confirm = status === "committed";
  await sql`
    insert into import_batches (id, organization_id, property_id, kind, status, file_id, file_sha256, file_format, header, cutoff_on,
                                actual_totals, uploaded_by, confirmed_by, confirmed_at, committed_at, cancelled_at, cancel_reason)
    values (${batchId}, ${org.orgId}, ${org.propertyId}, 'opening_balances', ${status}, ${file.id}, ${"b".repeat(64)}, 'csv',
            '["external_id","tenant_name"]'::jsonb, '2026-11-01', '{"debt":1580000,"deposit":3000000}'::jsonb, ${org.ownerMembershipId},
            ${confirm ? org.ownerMembershipId : null}, ${confirm ? finishedAt : null}, ${status === "committed" ? finishedAt : null},
            ${status === "cancelled" ? finishedAt : null}, ${status === "cancelled" ? "nhập nhầm" : null})`.execute(
    t.admin,
  );
  for (let i = 1; i <= 3; i++) {
    const bad = i === 3;
    await sql`
      insert into import_rows (id, organization_id, property_id, batch_id, row_no, raw, external_id, row_hash, action, errors, data, target_id)
      values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${batchId}, ${i},
              ${JSON.stringify({ tenant_name: { v: "Nguyễn Văn Ánh", numeric: false }, tenant_phone: { v: "0912345678", numeric: false } })}::jsonb,
              ${`HD-${i}`}, ${"c".repeat(64)}, ${bad ? "error" : "create"},
              ${JSON.stringify(bad ? [{ column: "tenant_phone", code: "INVALID_FORMAT", message: "Sai định dạng" }] : [])}::jsonb,
              ${bad ? null : JSON.stringify({ tenant_name: "Nguyễn Văn Ánh", _note: "x" })}::jsonb,
              ${bad ? null : randomUUID()})`.execute(t.admin);
  }
  return { batchId, fileId: file.id };
}

const rowsOf = async (batchId: string) =>
  (
    await sql<{
      row_no: number;
      raw: Record<string, unknown>;
      data: unknown;
      external_id: string;
      row_hash: string;
      action: string;
      errors: { code: string }[];
      target_id: string | null;
    }>`select row_no, raw, data, external_id, row_hash, action, errors, target_id from import_rows where batch_id = ${batchId} order by row_no`.execute(
      t.admin,
    )
  ).rows;

const failingStorage = (failKeys: Set<string>, calls: string[] = []): RetentionStorage => ({
  async delete(key) {
    calls.push(key);
    if (failKeys.has(key)) throw new Error("Xoá object lỗi: HTTP 503");
    await storage.delete(key);
  },
});

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Trọ hạn giữ A", "rental");
  B = await seedOrg(t.admin, "Trọ hạn giữ B", "rental");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
});

afterAll(async () => {
  await t.drop();
});

describe("xoá file theo delete_after", () => {
  it("xoá file tới hạn (kể cả đúng hôm nay) của mọi tổ chức; giữ file chưa tới hạn và file không có hạn; audit worker", async () => {
    const now = new Date();
    const today = dateOf(now);
    const past = await seedFile(A, dateOf(addDays(now, -3)));
    const edge = await seedFile(B, today);
    const future = await seedFile(A, dateOf(addDays(now, 1)));
    const noDeadline = await seedFile(B, null);

    const r = await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(r.failed).toEqual([]);
    expect(r.deleted).toBeGreaterThanOrEqual(2);

    for (const f of [past, edge]) {
      expect(await deletedAt(f.id)).not.toBeNull();
      expect(await exists(f.key)).toBe(false);
    }
    for (const f of [future, noDeadline]) {
      expect(await deletedAt(f.id)).toBeNull();
      expect(await exists(f.key)).toBe(true);
    }
    const audit = await sql<{ organization_id: string; actor_type: string }>`
      select organization_id, actor_type from audit_events where action = 'file.retention_deleted' and entity_id in (${past.id}, ${edge.id})
      order by entity_id`.execute(t.admin);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((a) => a.actor_type === "worker")).toBe(true);
    expect(new Set(audit.rows.map((a) => a.organization_id))).toEqual(new Set([A.orgId, B.orgId]));
  });

  it("file đã xoá theo hạn giữ không còn được cấp URL (NOT_FOUND), file chưa tới hạn vẫn cấp", async () => {
    const now = new Date();
    // Loại `work_order` là loại được cấp URL (import_batch thì không) — để phép thử có ý nghĩa.
    const gone = await seedFile(A, dateOf(addDays(now, -1)), { ownerType: "work_order" });
    const kept = await seedFile(A, dateOf(addDays(now, 5)), { ownerType: "work_order" });
    const url = (fileId: string) =>
      executeCommand(
        t.runtime,
        owner,
        { command: "file.url", idempotencyKey: randomUUID(), payload: { fileId }, correlationId: "c" },
        async (ctx) => ({ data: await getFileUrl(ctx, { storage, scanner: eicarOnlyScanner }, fileId) }),
      );
    expect(await url(gone.id)).toMatchObject({ status: "committed" }); // trước khi xoá: cấp được
    await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(await url(gone.id)).toMatchObject({
      status: "failed",
      httpStatus: 404,
      problem: { code: "NOT_FOUND" },
    });
    expect(await url(kept.id)).toMatchObject({ status: "committed" });
  });

  it("chạy lại ngay: 0 file, không lỗi; không có gì tới hạn: 0", async () => {
    const now = new Date();
    await seedFile(A, dateOf(addDays(now, -1)));
    const first = await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    const again = await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(again).toEqual({ claimed: 0, deleted: 0, failed: [] });
  });

  it("lỗi storage → không đánh dấu, file khác vẫn xoá; lần sau thử lại và xong", async () => {
    const now = new Date();
    const bad = await seedFile(A, dateOf(addDays(now, -2)));
    const good = await seedFile(A, dateOf(addDays(now, -2)));
    const calls: string[] = [];
    const r1 = await purgeExpiredFiles(t.worker, failingStorage(new Set([bad.key]), calls), now, {
      limit: 1000,
    });
    expect(r1.failed.map((f) => f.fileId)).toContain(bad.id);
    expect(r1.failed[0]?.error).toContain("503");
    expect(await deletedAt(bad.id)).toBeNull();
    expect(await exists(bad.key)).toBe(true);
    expect(await deletedAt(good.id)).not.toBeNull();
    expect(await exists(good.key)).toBe(false);

    const r2 = await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(r2.failed).toEqual([]);
    expect(await deletedAt(bad.id)).not.toBeNull();
    expect(await exists(bad.key)).toBe(false);
  });

  it("object đã mất (404) coi như đã xoá → đánh dấu", async () => {
    const now = new Date();
    const gone = await seedFile(A, dateOf(addDays(now, -1)), { put: false });
    const r = await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(r.failed).toEqual([]);
    expect(await deletedAt(gone.id)).not.toBeNull();
  });

  it("storage treo → huỷ theo timeout, không đánh dấu", async () => {
    const now = new Date();
    const f = await seedFile(A, dateOf(addDays(now, -1)));
    const hanging: RetentionStorage = {
      delete: (_k, o) =>
        new Promise((_, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("quá thời gian")))),
    };
    const r = await purgeExpiredFiles(t.worker, hanging, now, { limit: 1000, timeoutMs: 50 });
    expect(r.failed.some((x) => x.fileId === f.id)).toBe(true);
    expect(await deletedAt(f.id)).toBeNull();
    await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    expect(await deletedAt(f.id)).not.toBeNull();
  });

  it("giới hạn lô: limit nhỏ chỉ nhận đúng limit; các lượt sau lấy nốt", async () => {
    const now = new Date();
    await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 }); // dọn tồn của test trước
    const files = [];
    for (let i = 0; i < 7; i++) files.push(await seedFile(i % 2 ? A : B, dateOf(addDays(now, -1))));
    const r1 = await purgeExpiredFiles(t.worker, storage, now, { limit: 3 });
    expect(r1).toMatchObject({ claimed: 3, deleted: 3 });
    const r2 = await purgeExpiredFiles(t.worker, storage, now, { limit: 3 });
    const r3 = await purgeExpiredFiles(t.worker, storage, now, { limit: 3 });
    expect([r2.deleted, r3.deleted]).toEqual([3, 1]);
    for (const f of files) expect(await deletedAt(f.id)).not.toBeNull();
  });

  it("hai (bốn) job chạy song song: mỗi object bị xoá đúng một lần, không lỗi", async () => {
    const now = new Date();
    await purgeExpiredFiles(t.worker, storage, now, { limit: 1000 });
    const files = [];
    for (let i = 0; i < 20; i++) files.push(await seedFile(i % 2 ? A : B, dateOf(addDays(now, -1))));
    const calls: string[] = [];
    const store = failingStorage(new Set(), calls);
    const loop = async () => {
      let deleted = 0;
      for (;;) {
        const r = await purgeExpiredFiles(t.worker, store, now, { limit: 4 });
        if (r.claimed === 0) return deleted;
        expect(r.failed).toEqual([]);
        deleted += r.deleted;
      }
    };
    const counts = await Promise.all([loop(), loop(), loop(), loop()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(20);
    expect(calls).toHaveLength(20);
    expect(new Set(calls).size).toBe(20);
    for (const f of files) expect(await deletedAt(f.id)).not.toBeNull();
    const audits = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where action = 'file.retention_deleted' and entity_id = any(${files.map((f) => f.id)}::uuid[])`.execute(
      t.admin,
    );
    expect(audits.rows[0]?.n).toBe(20);
  });

  it("job (app_worker) không đọc/sửa trực tiếp bảng files; hàm đánh dấu từ chối file chưa tới hạn", async () => {
    const now = new Date();
    const future = await seedFile(A, dateOf(addDays(now, 5)));
    // Không ngữ cảnh tổ chức: RLS (hoặc quyền bảng) chặn cả đọc lẫn sửa.
    await expect(sql`select id from files`.execute(t.worker)).rejects.toThrow();
    await expect(
      sql`update files set deleted_at = now() where id = ${future.id}`.execute(t.worker),
    ).rejects.toThrow();
    const r = await sql<{
      ok: boolean;
    }>`select app.retention_mark_file_deleted(${future.id}::uuid, ${dateOf(now)}::date, ${now}, 'x') as ok`.execute(
      t.worker,
    );
    expect(r.rows[0]?.ok).toBe(false);
    expect(await deletedAt(future.id)).toBeNull();
  });
});

describe("làm rỗng import_rows.raw/data", () => {
  it("lô committed/cancelled ≥ 30 ngày bị làm rỗng; lô mới hơn và lô chưa chốt giữ nguyên; số liệu tổng hợp còn", async () => {
    const now = new Date();
    const old = await seedBatch(A, "committed", addDays(now, -45));
    const exactly30 = await seedBatch(B, "committed", addDays(now, -IMPORT_ROWS_RETENTION_DAYS));
    const cancelled = await seedBatch(A, "cancelled", addDays(now, -31));
    const recent = await seedBatch(A, "committed", addDays(now, -29));
    const justUnder = await seedBatch(A, "cancelled", new Date(now.getTime() - 30 * DAY + 1000));
    const pending = await seedBatch(A, "validated", null);
    await sql`update import_batches set created_at = now() - interval '200 days' where id = ${pending.batchId}`.execute(
      t.admin,
    );

    const r = await scrubImportRows(t.worker, now);
    expect(r.batches).toBe(3);
    expect(r.rows).toBe(9);

    for (const b of [old, exactly30, cancelled]) {
      const rows = await rowsOf(b.batchId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.raw).toEqual({});
        expect(row.data).toBeNull();
        expect(row.external_id).toMatch(/^HD-\d$/); // dữ liệu đối soát còn
        expect(row.row_hash).toMatch(/^c{64}$/);
      }
      expect(rows.map((x) => x.action)).toEqual(["create", "create", "error"]);
      expect(rows[2]?.errors[0]?.code).toBe("INVALID_FORMAT");
      expect(rows[0]?.target_id).not.toBeNull();
    }
    for (const b of [recent, justUnder, pending]) {
      for (const row of await rowsOf(b.batchId)) {
        expect(row.raw).not.toEqual({});
      }
    }
    // Audit: một sự kiện mỗi lô, actor worker.
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'import_batch.rows_purged' and actor_type = 'worker'
        and entity_id = any(${[old.batchId, exactly30.batchId, cancelled.batchId]}::uuid[])`.execute(t.admin);
    expect(audit.rows[0]?.n).toBe(3);
  });

  it("chạy lại / chạy song song: không lỗi, không xử lý lại lô đã rỗng; mỗi dòng được làm rỗng đúng một lần", async () => {
    const now = new Date();
    await scrubImportRows(t.worker, now);
    const batches = [];
    for (let i = 0; i < 6; i++)
      batches.push(await seedBatch(i % 2 ? A : B, i % 3 ? "committed" : "cancelled", addDays(now, -40)));
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => scrubImportRows(t.worker, now, { batchLimit: 2 })),
    );
    // Các job song song có thể bỏ sót lô đang bị khoá; vòng sau lấy nốt — tổng cuối cùng đúng một lần mỗi lô.
    let rows = results.reduce((a, r) => a + r.rows, 0);
    let nb = results.reduce((a, r) => a + r.batches, 0);
    for (;;) {
      const r = await scrubImportRows(t.worker, now, { batchLimit: 2 });
      if (r.batches === 0) break;
      rows += r.rows;
      nb += r.batches;
    }
    expect(nb).toBe(6);
    expect(rows).toBe(18);
    for (const b of batches) for (const row of await rowsOf(b.batchId)) expect(row.raw).toEqual({});
    const audits = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'import_batch.rows_purged'
        and entity_id = any(${batches.map((b) => b.batchId)}::uuid[])`.execute(t.admin);
    expect(audits.rows[0]?.n).toBe(6);
    expect(await scrubImportRows(t.worker, now)).toEqual({ batches: 0, rows: 0 });
  });

  it("tham số retentionDays; giá trị sai → RangeError", async () => {
    const now = new Date();
    const b = await seedBatch(A, "committed", addDays(now, -5));
    const emptied = async () => (await rowsOf(b.batchId)).every((r) => Object.keys(r.raw).length === 0);
    await scrubImportRows(t.worker, now);
    expect(await emptied()).toBe(false);
    await scrubImportRows(t.worker, now, { retentionDays: 7 });
    expect(await emptied()).toBe(false);
    await scrubImportRows(t.worker, now, { retentionDays: 5 });
    expect(await emptied()).toBe(true);
    await expect(scrubImportRows(t.worker, now, { retentionDays: -1 })).rejects.toThrow(RangeError);
  });

  it("lô vẫn xem được tổng/trạng thái/lỗi; báo cáo lỗi không vỡ khi mất giá trị gốc", async () => {
    const now = new Date();
    const b = await seedBatch(A, "committed", addDays(now, -60));
    await scrubImportRows(t.worker, now);
    const view = await getBatch(t.runtime, owner, { batchId: b.batchId });
    expect(view).toMatchObject({
      status: "committed",
      actual_totals: { debt: 1580000, deposit: 3000000 },
      counts: { create: 2, error: 1 },
    });
    expect(view.errors).toEqual([expect.objectContaining({ row: 3, code: "INVALID_FORMAT" })]);
    const report = await downloadErrorReport(t.runtime, owner, { batchId: b.batchId });
    expect(report.csv).toContain("INVALID_FORMAT");
    expect(report.csv).not.toContain("0912345678");
  });

  it("dòng của lô chưa chốt không thể bị làm rỗng qua đường khác (hàng rào bất biến giữ nguyên)", async () => {
    const now = new Date();
    const b = await seedBatch(A, "committed", addDays(now, -60));
    await expect(
      sql`update import_rows set external_id = 'X' where batch_id = ${b.batchId}`.execute(t.admin),
    ).rejects.toThrow(/bất biến/);
  });
});

describe("tích hợp: tải lên → huỷ → quá hạn", () => {
  const run = <T>(fn: Parameters<typeof executeCommand<T>>[3]) =>
    executeCommand<T>(
      t.runtime,
      owner,
      {
        command: "import.test",
        idempotencyKey: randomUUID(),
        payload: { k: randomUUID() },
        correlationId: "c-ret",
      },
      fn,
    );

  it("file nguồn có hạn ngay khi tải lên (90 ngày), huỷ đặt còn 30 ngày; sau 31 ngày object mất và dòng rỗng", async () => {
    const csv = new TextEncoder().encode(
      "external_id,unit_code,floor,capacity\r\nU-1,301,Tầng 3,2\r\nU-2,302,Tầng 3,2",
    );
    const up = await run(async (ctx) => ({
      data: await uploadBatch(
        ctx,
        { storage, scanner: eicarOnlyScanner },
        { propertyId: A.propertyId, kind: "units", bytes: csv },
      ),
    }));
    if (up.status !== "committed") throw new Error(JSON.stringify(up.problem));
    const { batchId, fileId } = up.data;
    const f = await sql<{ delete_after: string; storage_key: string }>`
      select delete_after::text, storage_key from files where id = ${fileId}`.execute(t.admin);
    const today = dateOf(new Date());
    expect(f.rows[0]?.delete_after).toBe(dateOf(addDays(new Date(`${today}T00:00:00Z`), 90)));
    const key = f.rows[0]?.storage_key ?? "";
    expect(await exists(key)).toBe(true);

    const c = await run(async (ctx) => ({ data: await cancelBatch(ctx, { batchId, reason: "nhập nhầm" }) }));
    expect(c.status).toBe("committed");
    const f2 = await sql<{
      delete_after: string;
    }>`select delete_after::text from files where id = ${fileId}`.execute(t.admin);
    expect(f2.rows[0]?.delete_after).toBe(dateOf(addDays(new Date(`${today}T00:00:00Z`), 30)));

    // Chưa tới hạn: không đụng.
    const early = await runRetention(t.worker, storage, addDays(new Date(), 29));
    expect(early.files.failed).toEqual([]);
    expect(await exists(key)).toBe(true);
    expect((await rowsOf(batchId)).every((r) => Object.keys(r.raw).length > 0)).toBe(true);

    const later = await runRetention(t.worker, storage, addDays(new Date(), 31));
    expect(later.files.failed).toEqual([]);
    expect(later.files.deleted).toBeGreaterThanOrEqual(1);
    expect(later.importRows.batches).toBeGreaterThanOrEqual(1);
    expect(await exists(key)).toBe(false);
    expect(await deletedAt(fileId)).not.toBeNull();
    expect((await rowsOf(batchId)).every((r) => Object.keys(r.raw).length === 0 && r.data === null)).toBe(
      true,
    );
  });

  it("runRetention: storage hỏng không chặn bước làm rỗng dòng nhập", async () => {
    const now = new Date();
    const f = await seedFile(A, dateOf(addDays(now, -1)));
    const b = await seedBatch(A, "committed", addDays(now, -40));
    const r = await runRetention(t.worker, failingStorage(new Set([f.key])), now);
    expect(r.files.failed.some((x) => x.fileId === f.id)).toBe(true);
    expect(r.importRows.batches).toBeGreaterThanOrEqual(1);
    expect((await rowsOf(b.batchId)).every((x) => Object.keys(x.raw).length === 0)).toBe(true);
    expect(await deletedAt(f.id)).toBeNull();
  });
});
