// T-219 — POST /api/v1/import/upload (multipart) trên Postgres thật + SeaweedFS (SPEC-import S-002, S-015; TM-07):
// phiên/tổ chức/quyền, giới hạn kích thước đọc theo luồng, nhận dạng theo nội dung (không tin Content-Type), quét mã độc
// trước khi phân tích, Idempotency-Key, chéo tenant.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eicarOnlyScanner, type MalwareScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { IMPORT_LIMITS } from "../import/import.ts";
import { writeXlsx } from "../import/xlsx.ts";
import { handleImportUpload, UPLOAD_MAX_BODY_BYTES, type UploadDeps } from "./upload-route.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let storage: ObjectStorage;
let managerUser: string;
let frontDeskUser: string;
let deps: UploadDeps;

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const UNITS = "external_id,unit_code,floor,capacity\r\nU-1,101,Tầng 1,2\r\nU-2,102,Tầng 1,3\r\n";
const enc = (s: string) => new TextEncoder().encode(s);

async function addMember(org: SeededOrg, role: string): Promise<string> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  return user;
}

const as = (user: string, org: SeededOrg, key: string | null = randomUUID()): Record<string, string> => ({
  "x-test-user": user,
  "x-test-2fa": "1",
  "x-org-id": org.orgId,
  ...(key ? { "idempotency-key": key } : {}),
});

interface FormOpts {
  property?: string;
  kind?: string;
  cutoff?: string;
  extra?: Record<string, string>;
  fileName?: string;
  fileType?: string;
}
function form(bytes: Uint8Array | null, o: FormOpts = {}): FormData {
  const f = new FormData();
  f.set("property_id", o.property ?? A.propertyId);
  f.set("kind", o.kind ?? "units");
  if (o.cutoff) f.set("cutoff_on", o.cutoff);
  for (const [k, v] of Object.entries(o.extra ?? {})) f.set(k, v);
  if (bytes)
    f.set(
      "file",
      new File([new Uint8Array(bytes)], o.fileName ?? "units.csv", { type: o.fileType ?? "text/csv" }),
    );
  return f;
}
const req = (
  headers: Record<string, string>,
  body: string | FormData | null,
  extra: Record<string, string> = {},
) =>
  new Request("http://local.test/api/v1/import/upload", {
    method: "POST",
    headers: { ...headers, ...extra },
    body,
  });
// biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
const j = (r: Response): Promise<any> => r.json();

const counts = async (org: SeededOrg) =>
  (
    await sql<{ b: number; f: number }>`
      select (select count(*)::int from import_batches where organization_id = ${org.orgId}) as b,
             (select count(*)::int from files where organization_id = ${org.orgId} and owner_type = 'import_batch') as f`.execute(
      t.admin,
    )
  ).rows[0];

async function exists(key: string): Promise<boolean> {
  const res = await fetch(await storage.signedGetUrl(key, 60));
  await res.arrayBuffer();
  return res.status === 200;
}

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Trọ upload A", "rental");
  B = await seedOrg(t.admin, "Trọ upload B", "rental");
  managerUser = await addMember(A, "manager");
  frontDeskUser = await addMember(A, "front_desk");
  deps = {
    db: t.runtime,
    storage,
    scanner: eicarOnlyScanner,
    secureCookies: false,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
  };
});

afterAll(async () => {
  await t.drop();
});

describe("tải lên hợp lệ", () => {
  it("manager tải CSV → 201 + batch `uploaded` + file riêng tư có hạn xoá + object trong storage + audit; Content-Type/tên file khai gian không ảnh hưởng", async () => {
    const before = await counts(A);
    const res = await handleImportUpload(
      req(as(managerUser, A), form(enc(UNITS), { fileName: "anh.png", fileType: "image/png" })),
      deps,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await j(res);
    expect(body).toMatchObject({ status: "committed", data: { rows: 2, status: "uploaded" } });
    const { batch_id, file_id } = body.data;
    const b = await sql<{ status: string; file_format: string; file_id: string; kind: string }>`
      select status, file_format, file_id, kind from import_batches where id = ${batch_id}`.execute(t.admin);
    expect(b.rows[0]).toMatchObject({ status: "uploaded", file_format: "csv", file_id, kind: "units" });
    const f = await sql<{
      mime: string;
      storage_key: string;
      delete_after: string | null;
      status: string;
      owner_id: string;
    }>`
      select mime, storage_key, delete_after::text, status, owner_id from files where id = ${file_id}`.execute(
      t.admin,
    );
    expect(f.rows[0]).toMatchObject({ mime: "text/csv", status: "ready", owner_id: batch_id });
    expect(f.rows[0]?.delete_after).not.toBeNull();
    expect(f.rows[0]?.storage_key.startsWith(`${A.orgId}/import_batch/`)).toBe(true);
    expect(await exists(f.rows[0]?.storage_key ?? "")).toBe(true);
    const audit = await sql<{ n: number }>`select count(*)::int as n from audit_events
      where action = 'import_batch.uploaded' and entity_id = ${batch_id}`.execute(t.admin);
    expect(audit.rows[0]?.n).toBe(1);
    const after = await counts(A);
    expect([after?.b, after?.f]).toEqual([(before?.b ?? 0) + 1, (before?.f ?? 0) + 1]);
  });

  it("XLSX (nhận dạng theo chữ ký ZIP) → 201, định dạng xlsx", async () => {
    const xlsx = writeXlsx([
      {
        name: "units",
        rows: [
          ["external_id", "unit_code", "floor", "capacity"],
          ["X-1", "201", "Tầng 2", "2"],
        ],
      },
    ]);
    const res = await handleImportUpload(
      req(as(managerUser, A), form(xlsx, { fileName: "a.bin", fileType: "application/octet-stream" })),
      deps,
    );
    expect(res.status).toBe(201);
    const id = (await j(res)).data.batch_id;
    const r = await sql<{
      file_format: string;
    }>`select file_format from import_batches where id = ${id}`.execute(t.admin);
    expect(r.rows[0]?.file_format).toBe("xlsx");
  });

  it("owner tải lô `leases` kèm cutoff_on; thiếu cutoff_on → 422", async () => {
    const leases =
      "external_id,unit_code,tenant_name,tenant_phone,rent_amount,deposit_amount,billing_start_on\r\nHD-1,101,Nguyễn Văn A,0912345678,3000000,3000000,2026-03-01\r\n";
    const owner = as(A.ownerAuthUserId, A);
    const ok = await handleImportUpload(
      req(owner, form(enc(leases), { kind: "leases", cutoff: "2026-11-01" })),
      deps,
    );
    expect(ok.status).toBe(201);
    const bad = await handleImportUpload(
      req(as(A.ownerAuthUserId, A), form(enc(leases), { kind: "leases" })),
      deps,
    );
    expect(bad.status).toBe(422);
    expect((await j(bad)).errors).toEqual([
      expect.objectContaining({ field: "cutoff_on", code: "REQUIRED" }),
    ]);
  });

  it("Idempotency-Key: gửi lại đúng key → cùng kết quả, không tạo thêm lô/file; cùng key khác file → 409 IDEMPOTENCY_CONFLICT", async () => {
    const key = randomUUID();
    const h = () => as(managerUser, A, key);
    const r1 = await handleImportUpload(req(h(), form(enc(UNITS))), deps);
    const before = await counts(A);
    const r2 = await handleImportUpload(req(h(), form(enc(UNITS))), deps);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await j(r2)).data.batch_id).toBe((await j(r1)).data.batch_id);
    expect(await counts(A)).toEqual(before);
    const r3 = await handleImportUpload(req(h(), form(enc(`${UNITS}U-3,103,Tầng 1,2\r\n`))), deps);
    expect(r3.status).toBe(409);
    expect((await j(r3)).code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("phiên, quyền, tổ chức", () => {
  it("không phiên → 401; thiếu Idempotency-Key → 400; không multipart → 400; không có trường file → 422", async () => {
    expect((await handleImportUpload(req({}, form(enc(UNITS))), deps)).status).toBe(401);
    const noKey = await handleImportUpload(req(as(managerUser, A, null), form(enc(UNITS))), deps);
    expect(noKey.status).toBe(400);
    expect((await j(noKey)).code).toBe("MALFORMED_REQUEST");
    const json = await handleImportUpload(
      req(as(managerUser, A), JSON.stringify({ a: 1 }), { "content-type": "application/json" }),
      deps,
    );
    expect(json.status).toBe(400);
    const nofile = await handleImportUpload(req(as(managerUser, A), form(null)), deps);
    expect(nofile.status).toBe(422);
    expect((await j(nofile)).errors).toEqual([expect.objectContaining({ field: "file", code: "REQUIRED" })]);
  });

  it("S-015: lễ tân → 403 FORBIDDEN, không tạo lô/file/object", async () => {
    const before = await counts(A);
    const res = await handleImportUpload(req(as(frontDeskUser, A), form(enc(UNITS))), deps);
    expect(res.status).toBe(403);
    expect((await j(res)).code).toBe("FORBIDDEN");
    expect(await counts(A)).toEqual(before);
  });

  it("chéo tenant: owner tổ chức B gửi property của A → 404; owner A gửi property của B → 404; manager ngoài phạm vi cơ sở → 404; không ghi gì", async () => {
    const [bA, bB] = [await counts(A), await counts(B)];
    const ownerB = await handleImportUpload(
      req(as(B.ownerAuthUserId, B), form(enc(UNITS), { property: A.propertyId })),
      deps,
    );
    expect(ownerB.status).toBe(404);
    const ownerA = await handleImportUpload(
      req(as(A.ownerAuthUserId, A), form(enc(UNITS), { property: B.propertyId })),
      deps,
    );
    expect(ownerA.status).toBe(404);
    const mgr = await handleImportUpload(
      req(as(managerUser, A), form(enc(UNITS), { property: B.propertyId })),
      deps,
    );
    expect(mgr.status).toBe(404);
    // Người của B dùng X-Org-Id của A: không phải thành viên → từ chối, không ghi.
    const wrongOrg = await handleImportUpload(req(as(B.ownerAuthUserId, A), form(enc(UNITS))), deps);
    expect([403, 404]).toContain(wrongOrg.status);
    expect([await counts(A), await counts(B)]).toEqual([bA, bB]);
  });
});

describe("kích thước (FILE_TOO_LARGE 413)", () => {
  it("file vượt giới hạn → 413, không ghi gì", async () => {
    const before = await counts(A);
    const big = new Uint8Array(IMPORT_LIMITS.bytes + 1).fill(0x41);
    const res = await handleImportUpload(req(as(managerUser, A), form(big)), deps);
    expect(res.status).toBe(413);
    expect((await j(res)).code).toBe("FILE_TOO_LARGE");
    expect(await counts(A)).toEqual(before);
  });

  it("đúng bằng giới hạn không bị 413 do kích thước (lỗi tiếp theo là nội dung)", async () => {
    const edge = new Uint8Array(IMPORT_LIMITS.bytes).fill(0x41);
    const res = await handleImportUpload(req(as(managerUser, A), form(edge)), deps);
    expect(res.status).not.toBe(413);
  });

  it("Content-Length khai báo quá trần → 413 ngay, không đọc thân", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const res = await handleImportUpload(
      new Request("http://local.test/api/v1/import/upload", {
        method: "POST",
        headers: {
          ...as(managerUser, A),
          "content-type": "multipart/form-data; boundary=zz",
          "content-length": String(UPLOAD_MAX_BODY_BYTES + 1),
        },
        body,
        duplex: "half",
      }),
      deps,
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(5);
  });

  it("thân dạng luồng không khai Content-Length, vô hạn → dừng đọc ở quanh trần, 413 (không nạp vô hạn vào bộ nhớ)", async () => {
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x41);
    const head = enc(
      '--zz\r\ncontent-disposition: form-data; name="file"; filename="a.csv"\r\ncontent-type: text/csv\r\n\r\n',
    );
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (first) {
          first = false;
          c.enqueue(head);
          return;
        }
        produced += chunk.byteLength;
        c.enqueue(chunk);
        if (produced > 200 * 1024 * 1024) c.close(); // lưới an toàn của test
      },
    });
    const res = await handleImportUpload(
      new Request("http://local.test/api/v1/import/upload", {
        method: "POST",
        headers: { ...as(managerUser, A), "content-type": "multipart/form-data; boundary=zz" },
        body,
        duplex: "half",
      }),
      deps,
    );
    expect(res.status).toBe(413);
    expect(produced).toBeLessThan(UPLOAD_MAX_BODY_BYTES + 4 * 1024 * 1024);
  });
});

describe("loại file (FILE_TYPE_NOT_ALLOWED 415) và quét mã độc", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]);
  const cases: [string, Uint8Array][] = [
    ["PNG đội lốt .csv", png],
    ["PDF văn bản", enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")],
    ["thực thi Windows (MZ + NUL)", Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0])],
    ["ELF", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0])],
    ["CSV không phải UTF-8 (Latin-1)", Uint8Array.from([0x61, 0x2c, 0xe9, 0x0d, 0x0a, 0x31, 0x2c, 0xe9])],
    [
      "ZIP/XLSX hỏng",
      Uint8Array.from([
        0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
        23, 24,
      ]),
    ],
    ["NUL trong văn bản", enc("external_id,unit_code\u0000\r\nU-1,101")],
  ];
  for (const [name, bytes] of cases) {
    it(`${name} → 415, không ghi gì`, async () => {
      const before = await counts(A);
      const res = await handleImportUpload(
        req(as(managerUser, A), form(bytes, { fileType: "text/csv", fileName: "x.csv" })),
        deps,
      );
      expect(res.status).toBe(415);
      expect((await j(res)).code).toBe("FILE_TYPE_NOT_ALLOWED");
      expect(await counts(A)).toEqual(before);
    });
  }

  it("EICAR (dạng CSV) → 415 do quét, TRƯỚC khi phân tích tiêu đề; không có hàng file/lô/object", async () => {
    const before = await counts(A);
    const res = await handleImportUpload(
      req(as(managerUser, A), form(enc(`external_id,unit_code,floor,capacity\r\n${EICAR},101,T1,2\r\n`))),
      deps,
    );
    expect(res.status).toBe(415);
    const body = await j(res);
    expect(body.code).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(JSON.stringify(body)).not.toContain("EICAR-STANDARD");
    expect(await counts(A)).toEqual(before);
  });

  it("EICAR đứng một mình (không có tiêu đề hợp lệ) vẫn là 415 chứ không phải 422", async () => {
    const res = await handleImportUpload(req(as(managerUser, A), form(enc(EICAR))), deps);
    expect(res.status).toBe(415);
  });

  it("máy quét lỗi/không có (fail-closed) → 500 INTERNAL, không lưu gì, không lộ chi tiết", async () => {
    const broken: MalwareScanner = {
      async scan() {
        throw new Error("clamd: connection refused 10.0.0.7:3310");
      },
    };
    const before = await counts(A);
    const errors: unknown[] = [];
    const res = await handleImportUpload(req(as(managerUser, A), form(enc(UNITS))), {
      ...deps,
      scanner: broken,
      onUnexpectedError: (e) => errors.push(e),
    });
    expect(res.status).toBe(500);
    const body = await j(res);
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("10.0.0.7");
    expect(errors).toHaveLength(1);
    expect(await counts(A)).toEqual(before);
  });
});

describe("trường biểu mẫu (422)", () => {
  const post = (f: FormData) => handleImportUpload(req(as(managerUser, A), f), deps);
  it("property_id không phải UUID; loại không hỗ trợ; reservations chưa mở; trường lạ; hai phần `file`; file rỗng; chỉ có tiêu đề", async () => {
    expect((await post(form(enc(UNITS), { property: "abc" }))).status).toBe(422);
    expect((await post(form(enc(UNITS), { kind: "payroll" }))).status).toBe(422);
    const res = await post(form(enc(UNITS), { kind: "reservations" }));
    expect(res.status).toBe(422);
    expect((await j(res)).errors).toEqual([
      expect.objectContaining({ field: "kind", code: "NOT_SUPPORTED_YET" }),
    ]);
    const extra = await post(form(enc(UNITS), { extra: { evil: "1" } }));
    expect(extra.status).toBe(422);
    const two = form(enc(UNITS));
    two.append("file", new File([enc(UNITS)], "b.csv", { type: "text/csv" }));
    expect((await post(two)).status).toBe(422);
    const empty = await post(form(new Uint8Array(0)));
    expect(empty.status).toBe(422);
    const headerOnly = await post(form(enc("external_id,unit_code,floor,capacity\r\n")));
    expect(headerOnly.status).toBe(422);
    const noCols = await post(form(enc("a,b\r\n1,2\r\n")));
    expect(noCols.status).toBe(422);
  });

  it("tên file không đi vào khoá object (khoá ngẫu nhiên theo tổ chức)", async () => {
    const res = await handleImportUpload(
      req(as(managerUser, A), form(enc(UNITS), { fileName: "../../etc/passwd" })),
      deps,
    );
    expect(res.status).toBe(201);
    const key = (
      await sql<{
        storage_key: string;
      }>`select storage_key from files where id = ${(await j(res)).data.file_id}`.execute(t.admin)
    ).rows[0]?.storage_key;
    expect(key).toMatch(new RegExp(`^${A.orgId}/import_batch/[0-9a-f-]{36}$`));
  });
});
