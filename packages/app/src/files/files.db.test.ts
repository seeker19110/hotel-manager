// T-011 — file riêng tư trên SeaweedFS + Postgres thật: magic bytes, EXIF, quét mã độc, khoá có tiền tố tổ chức,
// URL ký ≤ 5 phút, bucket riêng tư, buồng phòng xin file giấy tờ → 404 (TM-06, TM-07, IND-SAAS-003).
import { randomBytes, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import { ScannerUnavailableError } from "./clamd.ts";
import { type FileOwnerType, getFileUrl, MAX_FILE_BYTES, uploadFile } from "./files.ts";
import { eicarOnlyScanner } from "./inspect.ts";
import { ObjectStorage } from "./storage.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let ownerB: Actor;
let housekeeping: Actor;
let frontDesk: Actor;
let storage: ObjectStorage;

const deps = () => ({ storage, scanner: eicarOnlyScanner });

function seg(marker: number, payload: Uint8Array): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

/** JPEG tối thiểu có APP1 Exif chứa "GPS" — đủ để kiểm nhận dạng và bỏ metadata. */
function jpegWithExif(): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xe1, ascii("Exif\0\0GPSLatitude=21.0285;GPSLongitude=105.8542")),
    ...seg(0xda, ascii("\x01\x01\0\0?\0")),
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ]);
}

function pngChunk(type: string, data: Uint8Array): number[] {
  const len = data.length;
  return [
    len >>> 24,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ];
}
function pngWithText(): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", new Uint8Array(13)),
    ...pngChunk("tEXt", ascii("Comment\0Chup tai phong 203, SDT 0100005678")),
    ...pngChunk("IDAT", Uint8Array.from([1, 2, 3])),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
}

async function member(org: SeededOrg, role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${randomUUID()}, ${org.orgId}, ${user}, ${person}, ${role}, false)`.execute(t.admin);
  const m = await sql<{ id: string }>`select id from memberships where auth_user_id = ${user}`.execute(
    t.admin,
  );
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${m.rows[0]?.id}, ${org.propertyId})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "file.test", idempotencyKey: randomUUID(), payload: { n: randomUUID() }, correlationId: "c" },
    fn,
  );
}

async function upload(actor: Actor, ownerType: FileOwnerType, bytes: Uint8Array) {
  return run(actor, async (ctx) => ({
    data: await uploadFile(ctx, deps(), { ownerType, propertyId: A.propertyId, bytes }),
  }));
}

async function urlFor(actor: Actor, fileId: string) {
  return run(actor, async (ctx) => ({ data: await getFileUrl(ctx, deps(), fileId) }));
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS file");
  B = await seedOrg(t.admin, "KS khác");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  ownerB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  housekeeping = await member(A, "housekeeping");
  frontDesk = await member(A, "front_desk");
});

afterAll(async () => {
  await t.drop();
});

describe("tải lên (TM-07)", () => {
  it("JPEG có EXIF/GPS → lưu bản đã bỏ EXIF; khoá object có tiền tố tổ chức; URL ký đọc được", async () => {
    const r = await upload(housekeeping, "work_order", jpegWithExif());
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data).toMatchObject({ status: "ready", mime: "image/jpeg" });
    const row = await sql<{ storage_key: string; exif_stripped: boolean }>`
      select storage_key, exif_stripped from files where id = ${r.data.fileId}`.execute(t.admin);
    expect(row.rows[0]?.storage_key.startsWith(`${A.orgId}/`)).toBe(true);
    expect(row.rows[0]?.exif_stripped).toBe(true);

    const u = await urlFor(owner, r.data.fileId);
    if (u.status !== "committed") throw new Error(JSON.stringify(u));
    expect(u.data.expiresIn).toBeLessThanOrEqual(300);
    expect(new URL(u.data.url).searchParams.get("X-Amz-Expires")).toBe("300");
    const body = Buffer.from(await (await fetch(u.data.url)).arrayBuffer()).toString("latin1");
    expect(body.startsWith("\xff\xd8")).toBe(true);
    expect(body).not.toContain("Exif");
    expect(body).not.toContain("GPS");
  });

  it("PNG có tEXt (lộ SĐT) → chunk metadata bị bỏ", async () => {
    const r = await upload(housekeeping, "work_order", pngWithText());
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    const u = await urlFor(owner, r.data.fileId);
    if (u.status !== "committed") throw new Error("url");
    const body = Buffer.from(await (await fetch(u.data.url)).arrayBuffer()).toString("latin1");
    expect(body).not.toContain("0100005678");
    expect(body).toContain("IDAT");
  });

  it.each([
    ["SVG giả ảnh", ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["HTML", ascii("<!doctype html><html></html>")],
    ["file thực thi ELF", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])],
    ["PDF cho phiếu sự cố (chỉ nhận ảnh)", ascii("%PDF-1.7\n%...")],
    ["JPEG hỏng (đầu đúng, thân sai)", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x50])],
  ])(
    "SPEC-housekeeping S-013: %s → 415 FILE_TYPE_NOT_ALLOWED, không lưu gì (loại theo nội dung)",
    async (_name, bytes) => {
      const before = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
      const r = await upload(housekeeping, "work_order", bytes);
      expect(r).toMatchObject({
        status: "failed",
        httpStatus: 415,
        problem: { code: "FILE_TYPE_NOT_ALLOWED" },
      });
      const after = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    },
  );

  it.each(["handover", "meter_reading", "task", "payment_claim"] as const)(
    "T-602: loại chủ %s chưa khai quyền ghi cho nhân viên → mặc định từ chối 403 (không rơi về work_order.create), kể cả chủ",
    async (ownerType) => {
      const before = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
      for (const actor of [housekeeping, owner]) {
        expect(await upload(actor, ownerType, jpegWithExif())).toMatchObject({
          status: "failed",
          httpStatus: 403,
          problem: { code: "FORBIDDEN" },
        });
      }
      const after = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    },
  );

  it("vượt 10 MB → 413 FILE_TOO_LARGE", async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set([0xff, 0xd8, 0xff], 0);
    expect(await upload(housekeeping, "work_order", big)).toMatchObject({
      status: "failed",
      httpStatus: 413,
      problem: { code: "FILE_TOO_LARGE" },
    });
  });

  it("file chứa mã độc (EICAR) → rejected, không lưu nội dung, không cấp URL", async () => {
    const eicar = Uint8Array.from([
      ...pngWithText(),
      ...ascii("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
    ]);
    const r = await upload(housekeeping, "work_order", eicar);
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.status).toBe("rejected");
    expect(await urlFor(owner, r.data.fileId)).toMatchObject({ status: "failed", httpStatus: 404 });
  });
});

describe("đọc file (TM-06)", () => {
  it("bucket riêng tư: GET không ký → 403; sửa chữ ký → 403", async () => {
    const r = await upload(housekeeping, "work_order", jpegWithExif());
    if (r.status !== "committed") throw new Error("upload");
    const u = await urlFor(owner, r.data.fileId);
    if (u.status !== "committed") throw new Error("url");
    expect((await fetch(u.data.url.split("?")[0] as string)).status).toBe(403);
    expect(
      (await fetch(u.data.url.replace(/X-Amz-Signature=[0-9a-f]{6}/, "X-Amz-Signature=000000"))).status,
    ).toBe(403);
  });

  it("ảnh giấy tờ: lễ tân xem được; buồng phòng xin URL → 404; hàng giấy tờ vô hình với buồng phòng ở CSDL", async () => {
    const r = await upload(frontDesk, "identity_document", jpegWithExif());
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect((await urlFor(frontDesk, r.data.fileId)).status).toBe("committed");
    expect(await urlFor(housekeeping, r.data.fileId)).toMatchObject({
      status: "failed",
      httpStatus: 404,
      problem: { code: "NOT_FOUND" },
    });
    const seen = await withTenant(t.runtime, { orgId: A.orgId, actorId: housekeeping.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from files where owner_type = 'identity_document'`.execute(
        trx,
      ),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });

  it("SPEC-access S-024: buồng phòng xin URL ảnh giấy tờ → 404, không cấp URL, lần từ chối vào audit (outcome=denied)", async () => {
    const r = await upload(frontDesk, "identity_document", jpegWithExif());
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    const denied = await urlFor(housekeeping, r.data.fileId);
    expect(denied).toMatchObject({ status: "failed", httpStatus: 404, problem: { code: "NOT_FOUND" } });
    expect(JSON.stringify(denied)).not.toContain("X-Amz-Signature");
    const audit = await sql<{ outcome: string; actor_person_id: string }>`
      select outcome, actor_person_id from audit_events where command_id = ${denied.commandId}`.execute(
      t.admin,
    );
    expect(audit.rows).toEqual([{ outcome: "denied", actor_person_id: housekeeping.personId }]);
  });

  it("buồng phòng không tải ảnh giấy tờ lên được (không có quyền đọc giấy tờ)", async () => {
    expect(await upload(housekeeping, "identity_document", jpegWithExif())).toMatchObject({
      status: "failed",
      httpStatus: 403,
    });
  });

  it("tổ chức khác xin URL file của A → 404", async () => {
    const r = await upload(housekeeping, "work_order", jpegWithExif());
    if (r.status !== "committed") throw new Error("upload");
    expect(await urlFor(ownerB, r.data.fileId)).toMatchObject({ status: "failed", httpStatus: 404 });
  });

  it("SPEC-housekeeping S-017: URL ký ≤ 5 phút; hết hạn → bucket từ chối; tổ chức khác → 404; không ký → 403", async () => {
    const r = await upload(housekeeping, "work_order", jpegWithExif());
    if (r.status !== "committed") throw new Error("upload");
    const u = await urlFor(owner, r.data.fileId);
    if (u.status !== "committed") throw new Error("url");
    expect(u.data.expiresIn).toBeLessThanOrEqual(300);
    expect(new URL(u.data.url).searchParams.get("X-Amz-Expires")).toBe("300");
    expect((await fetch(u.data.url)).status).toBe(200);
    expect((await fetch(u.data.url.split("?")[0] as string)).status).toBe(403);
    expect(await urlFor(ownerB, r.data.fileId)).toMatchObject({
      status: "failed",
      httpStatus: 404,
      problem: { code: "NOT_FOUND" },
    });
    // Hết hạn: ký lại cùng object với hạn 1 giây (hạn thấp nhất cho phép) rồi dùng sau mốc.
    const key = await sql<{
      storage_key: string;
    }>`select storage_key from files where id = ${r.data.fileId}`.execute(t.admin);
    const shortLived = await storage.signedGetUrl(key.rows[0]?.storage_key as string, 1);
    expect(new URL(shortLived).searchParams.get("X-Amz-Expires")).toBe("1");
    expect((await fetch(shortLived)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await fetch(shortLived)).status).toBe(403);
  });
});

/** Cột số giấy tờ đã mã hoá (D-004) — bytes giả đúng định dạng (byte đầu = key_id), test file không cần khoá thật. */
const encCols = () => ({ enc: Buffer.concat([Buffer.from([1]), randomBytes(40)]), hash: randomBytes(32) });

describe("giấy tờ nhận dạng (INV-G7)", () => {
  it("chỉ lưu bản mã hoá + 4 số cuối; buồng phòng không thấy hàng; ẩn danh xoá số, băm và ảnh", async () => {
    const id = randomUUID();
    const c = encCols();
    await withTenant(t.runtime, { orgId: A.orgId, actorId: frontDesk.membershipId }, (trx) =>
      sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number_enc,
                                          doc_number_key_id, doc_number_hash, doc_number_last4)
          values (${id}, ${A.orgId}, ${A.propertyId}, ${A.ownerPersonId}, 'cccd', ${c.enc}, 1, ${c.hash}, '7890')`.execute(
        trx,
      ),
    );
    const hk = await withTenant(t.runtime, { orgId: A.orgId, actorId: housekeeping.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from identity_documents`.execute(trx),
    );
    expect(hk.rows[0]?.n).toBe(0);
    await expect(
      sql`update identity_documents set anonymized_at = now() where id = ${id}`.execute(t.admin),
    ).rejects.toThrow(/ck_identity_documents_anonymized/);
    await sql`update identity_documents set anonymized_at = now(), doc_number_enc = null, doc_number_key_id = null,
                     doc_number_hash = null, doc_number_last4 = null where id = ${id}`.execute(t.admin);
    const after = await sql<{
      n: Buffer | null;
      m: string | null;
    }>`select doc_number_enc as n, doc_number_last4 as m from identity_documents where id = ${id}`.execute(
      t.admin,
    );
    expect(after.rows[0]).toEqual({ n: null, m: null });
  });
});

describe("không để object mồ côi (INV-G7)", () => {
  /** Storage thật nhưng ghi lại khoá đã put; `failAfterPut` mô phỏng lỗi sau khi object đã ghi (mạng đứt, lỗi sau đó). */
  function spyStorage(failAfterPut: boolean) {
    const puts: string[] = [];
    const s = {
      ensureBucket: () => storage.ensureBucket(),
      delete: (key: string) => storage.delete(key),
      signedGetUrl: (key: string, sec?: number) => storage.signedGetUrl(key, sec),
      async put(key: string, body: Uint8Array, type: string) {
        await storage.put(key, body, type);
        puts.push(key);
        if (failAfterPut) throw new Error("mất kết nối sau khi ghi object");
      },
    } as unknown as ObjectStorage;
    return { s, puts };
  }

  it("cơ sở không tồn tại → 404 trước khi ghi object", async () => {
    const { s, puts } = spyStorage(false);
    const r = await run(owner, async (ctx) => ({
      data: await uploadFile(
        ctx,
        { storage: s, scanner: eicarOnlyScanner },
        { ownerType: "identity_document", propertyId: randomUUID(), bytes: jpegWithExif() },
      ),
    }));
    expect(r).toMatchObject({ status: "failed", httpStatus: 404 });
    expect(puts).toEqual([]);
  });

  it("lỗi sau khi đã ghi object → transaction rollback và object bị xoá", async () => {
    const { s, puts } = spyStorage(true);
    await expect(
      run(owner, async (ctx) => ({
        data: await uploadFile(
          ctx,
          { storage: s, scanner: eicarOnlyScanner },
          { ownerType: "identity_document", propertyId: A.propertyId, bytes: jpegWithExif() },
        ),
      })),
    ).rejects.toThrow("mất kết nối");
    expect(puts).toHaveLength(1);
    const res = await fetch(await storage.signedGetUrl(puts[0] as string, 60));
    expect(res.status).toBe(404);
    const rows = await sql<{
      n: number;
    }>`select count(*)::int as n from files where storage_key = ${puts[0]}`.execute(t.admin);
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("id file không phải UUID → 404 (không lộ lỗi 500)", async () => {
    expect(await urlFor(owner, "abc")).toMatchObject({ status: "failed", httpStatus: 404 });
  });

  it("loại chủ chưa khai báo quyền đọc (export_job) → 404 kể cả owner", async () => {
    const id = randomUUID();
    await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'export_job', 'application/pdf', 10, ${"a".repeat(64)},
                      'ready', ${`${A.orgId}/export_job/${id}`})`.execute(t.admin);
    expect(await urlFor(owner, id)).toMatchObject({ status: "failed", httpStatus: 404 });
  });
});

describe("RLS giấy tờ theo phạm vi cơ sở (review T-011)", () => {
  it("lễ tân chỉ được giao CS1 không thấy giấy tờ/ảnh giấy tờ của CS2 kể cả truy vấn thẳng; owner thấy", async () => {
    const cs2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${cs2}, ${A.orgId}, 'KS file — CS2', 'hotel')`.execute(
      t.admin,
    );
    const docId = randomUUID();
    const fileId = randomUUID();
    const c2 = encCols();
    await sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number_enc,
                                              doc_number_key_id, doc_number_hash, doc_number_last4)
              values (${docId}, ${A.orgId}, ${cs2}, ${A.ownerPersonId}, 'passport', ${c2.enc}, 1, ${c2.hash}, '4567')`.execute(
      t.admin,
    );
    await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key, exif_stripped)
              values (${fileId}, ${A.orgId}, ${cs2}, 'identity_document', 'image/jpeg', 10, ${"b".repeat(64)}, 'ready',
                      ${`${A.orgId}/identity_document/${fileId}`}, true)`.execute(t.admin);
    const count = (actor: Actor) =>
      withTenant(t.runtime, { orgId: A.orgId, actorId: actor.membershipId }, async (trx) => {
        const d = await sql<{
          n: number;
        }>`select count(*)::int as n from identity_documents where id = ${docId}`.execute(trx);
        const f = await sql<{ n: number }>`select count(*)::int as n from files where id = ${fileId}`.execute(
          trx,
        );
        return [d.rows[0]?.n, f.rows[0]?.n];
      });
    expect(await count(frontDesk)).toEqual([0, 0]);
    expect(await count(owner)).toEqual([1, 1]);
    // Lễ tân cũng không ghi được giấy tờ vào cơ sở ngoài phạm vi.
    await expect(
      withTenant(t.runtime, { orgId: A.orgId, actorId: frontDesk.membershipId }, (trx) =>
        sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number_enc,
                                            doc_number_key_id, doc_number_hash, doc_number_last4)
            values (${randomUUID()}, ${A.orgId}, ${cs2}, ${A.ownerPersonId}, 'cccd', ${c2.enc}, 1, ${c2.hash}, '9999')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("loại chủ chưa khai báo quyền đọc (export_job) vô hình ở CSDL, kể cả owner", async () => {
    const id = randomUUID();
    await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, status, storage_key)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'export_job', 'application/pdf', 10, ${"c".repeat(64)},
                      'ready', ${`${A.orgId}/export_job/${id}`})`.execute(t.admin);
    const n = await withTenant(t.runtime, { orgId: A.orgId, actorId: owner.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from files where id = ${id}`.execute(trx),
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});

describe("máy quét không dùng được (D-003, T-203)", () => {
  it("clamd lỗi/không trả lời → 503 SERVICE_UNAVAILABLE, không có hàng files, không có object", async () => {
    const before = await sql<{
      n: number;
    }>`select count(*)::int as n from files where organization_id = ${A.orgId}`.execute(t.admin);
    const puts: string[] = [];
    const down = {
      storage: {
        ensureBucket: () => storage.ensureBucket(),
        delete: (k: string) => storage.delete(k),
        put: async (k: string, b: Uint8Array, m: string) => {
          puts.push(k);
          return storage.put(k, b, m);
        },
        signedGetUrl: (k: string, s: number) => storage.signedGetUrl(k, s),
      } as unknown as ObjectStorage,
      scanner: {
        scan: async () => {
          throw new ScannerUnavailableError("không kết nối được clamd");
        },
      },
    };
    const key = randomUUID();
    // 5xx không lưu kết quả theo Idempotency-Key: gửi lại cùng key được khi clamd hoạt động lại (route HTTP trả 503).
    await expect(
      executeCommand(
        t.runtime,
        housekeeping,
        { command: "files.upload", idempotencyKey: key, payload: { k: key }, correlationId: "c" },
        async (ctx) => ({
          data: await uploadFile(ctx, down, {
            ownerType: "work_order",
            propertyId: A.propertyId,
            bytes: jpegWithExif(),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    const stored = await sql<{
      n: number;
    }>`select count(*)::int as n from idempotency_keys where key = ${key}`.execute(t.admin);
    expect(stored.rows[0]?.n).toBe(0);
    const after = await sql<{
      n: number;
    }>`select count(*)::int as n from files where organization_id = ${A.orgId}`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(puts).toEqual([]);
  });
});
