// POST /api/v1/files/upload trên Postgres thật + object storage thật (SPEC-portal S-008, Q-07): người thuê tải ảnh sự cố.
import { randomUUID } from "node:crypto";
import {
  activateLease,
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedLease,
  seedOrg,
  type TestDb,
  testS3Config,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../files/files.ts";
import { ObjectStorage } from "../files/storage.ts";
import { testServices } from "../server/services.ts";
import type { HttpDeps } from "./command-route.ts";
import { handleFileUpload } from "./file-upload.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let tenantUser: string;
let deps: HttpDeps;

// JPEG tối thiểu hợp lệ (SOI, JFIF, SOS, EOI).
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  16,
  ...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  0xff,
  0xda,
  0,
  8,
  1,
  1,
  0,
  0,
  0x3f,
  0,
  0x12,
  0x34,
  0xff,
  0xd9,
]);

function upload(
  query: string,
  body: Uint8Array | null,
  headers: Record<string, string> = {},
  user: string | null = tenantUser,
): Request {
  return new Request(`http://local.test/api/v1/files/upload?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "idempotency-key": randomUUID(),
      ...(user ? { "x-test-user": user } : {}),
      "x-org-id": A.orgId,
      ...headers,
    },
    ...(body ? { body: Buffer.from(body) } : {}),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
const j = (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ khác");
  const storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'An')`.execute(
    t.admin,
  );
  const lease = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    representativePersonId: person,
    effectiveFrom: "2026-09-01",
  });
  await activateLease(t.admin, { org: A, leaseId: lease.leaseId, effectiveFrom: "2026-09-01" });
  tenantUser = await seedAuthUser(t.admin, `${randomUUID().slice(0, 8)}@example.test`);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${randomUUID()}, ${A.orgId}, ${tenantUser}, ${person}, 'tenant')`.execute(t.admin);
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      // Nhân viên (owner…) bắt buộc 2FA; người thuê không.
      return id ? { user: { id, twoFactorEnabled: id !== tenantUser } } : null;
    },
    secureCookies: false,
    services: testServices({ storage }),
  };
});

afterAll(async () => {
  await t?.drop();
});

describe("tải ảnh qua HTTP", () => {
  it("người thuê tải JPEG → 201 ready; gửi lại cùng Idempotency-Key → cùng fileId, chỉ một file", async () => {
    const key = randomUUID();
    const q = `owner_type=work_order&property_id=${A.propertyId}`;
    const r1 = await handleFileUpload(upload(q, JPEG, { "idempotency-key": key }), deps);
    expect(r1.status).toBe(201);
    const d1 = await j(r1);
    expect(d1).toMatchObject({ status: "committed", data: { status: "ready", mime: "image/jpeg" } });
    const r2 = await handleFileUpload(upload(q, JPEG, { "idempotency-key": key }), deps);
    expect((await j(r2)).data.fileId).toBe(d1.data.fileId);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from files where id = ${d1.data.fileId}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
    // Cùng key, nội dung khác → 422.
    const other = new Uint8Array([...JPEG, 0]);
    const r3 = await handleFileUpload(upload(q, other, { "idempotency-key": key }), deps);
    expect(r3.status).toBe(422);
  });

  it("ca biên: không phiên 401; thiếu key 400; owner_type lạ 422; rỗng 422; không phải ảnh 415; quá 10 MB 413", async () => {
    const q = `owner_type=work_order&property_id=${A.propertyId}`;
    expect((await handleFileUpload(upload(q, JPEG, {}, null), deps)).status).toBe(401);
    expect(
      (await handleFileUpload(upload(q, JPEG, { "idempotency-key": "khong-phai-uuid" }), deps)).status,
    ).toBe(400);
    expect(
      (await handleFileUpload(upload(`owner_type=identity_document&property_id=${A.propertyId}`, JPEG), deps))
        .status,
    ).toBe(422);
    expect((await handleFileUpload(upload(q, new Uint8Array()), deps)).status).toBe(422);
    const text = await handleFileUpload(upload(q, new TextEncoder().encode("khong phai anh")), deps);
    expect(text.status).toBe(415);
    expect((await j(text)).code).toBe("FILE_TYPE_NOT_ALLOWED");
    const big = await handleFileUpload(upload(q, new Uint8Array(MAX_FILE_BYTES + 1)), deps);
    expect(big.status).toBe(413);
    expect((await j(big)).code).toBe("FILE_TOO_LARGE");
  });

  it("T-602: lease_settlement — chủ tải JPEG → 201 ready (owner_type lease_settlement); người thuê → 403, không ghi file", async () => {
    const q = `owner_type=lease_settlement&property_id=${A.propertyId}`;
    const ok = await handleFileUpload(upload(q, JPEG, {}, A.ownerAuthUserId), deps);
    expect(ok.status).toBe(201);
    const d = await j(ok);
    expect(d).toMatchObject({ status: "committed", data: { status: "ready", mime: "image/jpeg" } });
    const row = await sql<{
      owner_type: string;
    }>`select owner_type from files where id = ${d.data.fileId}`.execute(t.admin);
    expect(row.rows[0]?.owner_type).toBe("lease_settlement");
    const before = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
    expect((await handleFileUpload(upload(q, JPEG), deps)).status).toBe(403);
    const after = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("cơ sở không có hợp đồng của mình (tổ chức khác) → 404, không ghi file", async () => {
    const before = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
    const r = await handleFileUpload(upload(`owner_type=work_order&property_id=${B.propertyId}`, JPEG), deps);
    expect(r.status).toBe(404);
    const after = await sql<{ n: number }>`select count(*)::int as n from files`.execute(t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("X-Org-Context khác tổ chức đang chọn → 409 CONTEXT_CHANGED, không ghi file", async () => {
    const r = await handleFileUpload(
      upload(`owner_type=work_order&property_id=${A.propertyId}`, JPEG, { "x-org-context": B.orgId }),
      deps,
    );
    expect(r.status).toBe(409);
    expect((await j(r)).code).toBe("CONTEXT_CHANGED");
  });
});
