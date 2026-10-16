// PLAN đợt 3 T-224 — hạn giữ dữ liệu nhập + route `import.upload` multipart trên Postgres thật + SeaweedFS
// (SPEC-import mục 10, S-001…S-003; ERD `files.delete_after`, `import_rows.raw/data`; INV-G7).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { ObjectStorage } from "../files/storage.ts";
import type { HttpDeps } from "../http/command-route.ts";
import { testServices } from "../server/services.ts";
import { okAs, ownerOf, seedMember } from "../testing/helpers.ts";
import { handleImportUpload } from "./http.ts";
import { cancelBatch } from "./import.ts";
import { IMPORT_ROW_RETENTION_DAYS, runRetention } from "./retention.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let H: Actor;
let storage: ObjectStorage;
const UNIT_CSV = new TextEncoder().encode(
  "external_id,unit_code,floor,capacity\r\nU-1,101,T1,2\r\nU-2,102,T1,2\r\n",
);

function deps(actor: Actor): HttpDeps {
  return {
    db: t.runtime,
    getSession: async () => ({ user: { id: actor.authUserId, twoFactorEnabled: true } }),
    secureCookies: false,
    services: testServices({ storage }),
  };
}

function upload(
  actor: Actor,
  fields: Record<string, string | Blob>,
  opts: { key?: string; contentType?: string } = {},
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const body = new Response(form);
  const headers = new Headers({ "x-org-id": A.orgId, "idempotency-key": opts.key ?? randomUUID() });
  return body.arrayBuffer().then((buf) => {
    headers.set("content-type", opts.contentType ?? (body.headers.get("content-type") as string));
    return handleImportUpload(
      new Request("http://localhost/api/v1/import/upload", { method: "POST", headers, body: buf }),
      deps(actor),
    );
  });
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen", "rental");
  O = await ownerOf(t, A);
  M = await seedMember(t, A, "manager");
  H = await seedMember(t, A, "housekeeping");
});

afterAll(async () => {
  await t?.drop();
});

describe("import.upload multipart", () => {
  it("manager tải CSV → 201 lô `uploaded` + file nguồn riêng tư; cùng key → cùng lô; thiếu trường/không multipart/không quyền → lỗi", async () => {
    const key = randomUUID();
    const fields = {
      file: new Blob([UNIT_CSV], { type: "text/csv" }),
      property_id: A.propertyId,
      kind: "units",
    };
    const r = await upload(M, fields, { key });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { data: { batchId: string; rows: number } };
    expect(j.data.rows).toBe(2);
    const again = (await (await upload(M, fields, { key })).json()) as { data: { batchId: string } };
    expect(again.data.batchId).toBe(j.data.batchId);
    const f = await sql<{ n: number }>`
      select count(*)::int as n from files where owner_type = 'import_batch' and owner_id = ${j.data.batchId}`.execute(
      t.admin,
    );
    expect(f.rows[0]?.n).toBe(1);

    expect((await upload(M, { property_id: A.propertyId, kind: "units" })).status).toBe(422);
    expect((await upload(M, { ...fields, property_id: "khong" })).status).toBe(422);
    expect((await upload(M, fields, { contentType: "application/json" })).status).toBe(400);
    expect((await upload(H, fields)).status).toBe(403);
    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "text/csv" });
    expect((await upload(M, { ...fields, file: big })).status).toBe(413);
  });
});

describe("hạn giữ (job)", () => {
  it(`lô huỷ quá ${IMPORT_ROW_RETENTION_DAYS} ngày → raw/data rỗng; file nguồn tới hạn → object bị xoá, files 'deleted'; chạy lại không đổi; lô mới giữ nguyên`, async () => {
    const make = async () => {
      const r = await upload(M, {
        file: new Blob([UNIT_CSV], { type: "text/csv" }),
        property_id: A.propertyId,
        kind: "units",
      });
      return ((await r.json()) as { data: { batchId: string } }).data.batchId;
    };
    const oldBatch = await make();
    const newBatch = await make();
    for (const b of [oldBatch, newBatch])
      await okAs(t, O, (ctx) => cancelBatch(ctx, { batchId: b, reason: "nhập thử" }));
    // Lô cũ: huỷ 31 ngày trước; hạn xoá file đã tới.
    await t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update import_batches set cancelled_at = now() - interval '31 days' where id = ${oldBatch}`.execute(
        trx,
      );
      await sql`update files set delete_after = current_date - 1 where owner_id = ${oldBatch}`.execute(trx);
    });
    const key = (
      await sql<{ storage_key: string }>`select storage_key from files where owner_id = ${oldBatch}`.execute(
        t.admin,
      )
    ).rows[0]?.storage_key as string;
    const url = await storage.signedGetUrl(key, 60);
    expect((await fetch(url)).status).toBe(200);

    const s = await runRetention(t.worker, storage);
    expect(s).toMatchObject({ rowsPurged: 2, filesDeleted: 1, filesFailed: 0 });
    const rows = await sql<{ batch_id: string; raw: unknown; data: unknown }>`
      select batch_id, raw, data from import_rows where batch_id in (${oldBatch}, ${newBatch}) order by batch_id, row_no`.execute(
      t.admin,
    );
    for (const r of rows.rows)
      if (r.batch_id === oldBatch) expect(r).toMatchObject({ raw: {}, data: null });
      else expect(r.raw).not.toEqual({});
    const f = await sql<{ status: string; deleted_at: Date | null }>`
      select status, deleted_at from files where owner_id = ${oldBatch}`.execute(t.admin);
    expect(f.rows[0]?.status).toBe("deleted");
    expect(f.rows[0]?.deleted_at).toBeTruthy();
    expect((await fetch(await storage.signedGetUrl(key, 60))).status).toBe(404);
    expect(await runRetention(t.worker, storage)).toMatchObject({ rowsPurged: 0, filesDeleted: 0 });
    // File lô mới (hạn 30 ngày nữa) còn nguyên.
    const fresh = await sql<{
      status: string;
    }>`select status from files where owner_id = ${newBatch}`.execute(t.admin);
    expect(fresh.rows[0]?.status).toBe("ready");
  });

  it("xoá object lỗi → không đánh dấu deleted, đếm lỗi, lượt sau thử lại", async () => {
    const id = randomUUID();
    const k = `${A.orgId}/import_batch/${id}`;
    await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, storage_key, status, delete_after)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'import_batch', 'text/csv', 10, ${"b".repeat(64)}, ${k}, 'ready',
                      current_date - 1)`.execute(t.admin);
    const broken = { delete: async () => Promise.reject(new Error("S3 503")) };
    expect(await runRetention(t.worker, broken)).toMatchObject({ filesDeleted: 0, filesFailed: 1 });
    expect(
      (await sql<{ status: string }>`select status from files where id = ${id}`.execute(t.admin)).rows[0]
        ?.status,
    ).toBe("ready");
    expect(await runRetention(t.worker, storage)).toMatchObject({ filesDeleted: 1, filesFailed: 0 });
  });

  it("vai trò runtime không gọi được hàm hạn giữ", async () => {
    await expect(sql`select app.purge_import_rows(now(), 30)`.execute(t.runtime)).rejects.toThrow(
      /permission/,
    );
    await expect(
      sql`select * from app.files_due_for_deletion(current_date, 10)`.execute(t.runtime),
    ).rejects.toThrow(/permission/);
  });
});
