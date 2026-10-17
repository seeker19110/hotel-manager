// T-504 (BE-REL-006) — giới hạn tần suất tải file/nhập liệu: bộ đếm trong Postgres dùng chung giữa các pool (instance), vượt ⇒
// 429 RATE_LIMITED + Retry-After TRƯỚC khi đọc thân/quét/ghi object. Hạn mức theo thành viên rồi theo tổ chức.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectStorage } from "../files/storage.ts";
import { testServices } from "../server/services.ts";
import type { HttpDeps } from "./command-route.ts";
import { handleFileUpload } from "./file-upload.ts";
import { handleImportUpload } from "./import-upload.ts";
import {
  FILE_UPLOAD_PER_MEMBER_PER_MINUTE,
  FILE_UPLOAD_PER_ORG_PER_MINUTE,
  IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE,
  IMPORT_UPLOAD_PER_ORG_PER_MINUTE,
} from "./rate-limit.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let second: Kysely<unknown>;
let storage: ObjectStorage;
let userA2: string;

// JPEG tối thiểu hợp lệ (SOI, JFIF, SOS, EOI) — cùng mẫu file-upload.db.test.ts.
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

const depsFor = (db: Kysely<unknown>, uploadRateLimit?: HttpDeps["uploadRateLimit"]): HttpDeps => ({
  db,
  getSession: async (h) => {
    const id = h.get("x-test-user");
    return id ? { user: { id, twoFactorEnabled: true } } : null;
  },
  secureCookies: false,
  services: testServices({ storage }),
  ...(uploadRateLimit ? { uploadRateLimit } : {}),
});

function fileReq(org: SeededOrg, user: string): Request {
  return new Request(
    `http://local.test/api/v1/files/upload?owner_type=work_order&property_id=${org.propertyId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": randomUUID(),
        "x-test-user": user,
        "x-org-id": org.orgId,
      },
      body: Buffer.from(JPEG),
    },
  );
}

/** Multipart hỏng: bị từ chối 400 SAU bước giới hạn ⇒ phân biệt được lượt "qua cổng" (400) và lượt bị chặn (429). */
function importReq(org: SeededOrg, user: string): Request {
  return new Request("http://local.test/api/v1/import/upload", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=xxx",
      "idempotency-key": randomUUID(),
      "x-test-user": user,
      "x-org-id": org.orgId,
    },
    body: "không phải multipart",
  });
}

async function seedStaff(org: SeededOrg, role: string): Promise<string> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  const m = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${m}, ${org.orgId}, ${user}, ${person}, ${role}, false)`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${org.orgId}, ${m}, ${org.propertyId})`.execute(t.admin);
  return user;
}

const fileCount = async (org: SeededOrg): Promise<number> =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from files where organization_id = ${org.orgId}`.execute(t.admin)
  ).rows[0]?.n ?? 0;

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Rate limit A");
  B = await seedOrg(t.admin, "Rate limit B");
  userA2 = await seedStaff(A, "front_desk");
  second = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: t.runtimeUrl, max: 10 }) }),
  });
});

afterAll(async () => {
  await second?.destroy();
  await t?.drop();
});

describe("hằng hạn mức", () => {
  it("hữu hạn, đủ rộng cho thao tác tay, nhập liệu chặt hơn tải ảnh, tổ chức ≥ thành viên", () => {
    expect(FILE_UPLOAD_PER_MEMBER_PER_MINUTE).toBeGreaterThanOrEqual(10);
    expect(FILE_UPLOAD_PER_MEMBER_PER_MINUTE).toBeLessThanOrEqual(120);
    expect(IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE).toBeLessThan(FILE_UPLOAD_PER_MEMBER_PER_MINUTE);
    expect(IMPORT_UPLOAD_PER_ORG_PER_MINUTE).toBeGreaterThanOrEqual(IMPORT_UPLOAD_PER_MEMBER_PER_MINUTE);
    expect(FILE_UPLOAD_PER_ORG_PER_MINUTE).toBeGreaterThanOrEqual(FILE_UPLOAD_PER_MEMBER_PER_MINUTE);
  });
});

describe("POST /api/v1/files/upload — giới hạn tần suất", () => {
  it("hai pool dùng chung bộ đếm thành viên: lượt vượt ⇒ 429 + Retry-After, không ghi file; thành viên khác cùng tổ chức vẫn tải được", async () => {
    const userA1 = await seedStaff(A, "manager");
    const limits = { perMember: 2, perOrg: 1000 };
    const before = await fileCount(A);
    expect((await handleFileUpload(fileReq(A, userA1), depsFor(t.runtime, limits))).status).toBe(201);
    expect((await handleFileUpload(fileReq(A, userA1), depsFor(second, limits))).status).toBe(201);
    for (const db of [t.runtime, second]) {
      const res = await handleFileUpload(fileReq(A, userA1), depsFor(db, limits));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    }
    expect(await fileCount(A)).toBe(before + 2);
    // Người khác cùng tổ chức: bộ đếm thành viên riêng.
    expect((await handleFileUpload(fileReq(A, userA2), depsFor(second, limits))).status).toBe(201);
  });

  it("hạn mức TỔ CHỨC: nhiều thành viên cùng đẩy tổng vượt ⇒ 429 dù từng người chưa tới hạn riêng", async () => {
    const orgLimit = await seedStaff(A, "manager");
    const other = await seedStaff(A, "front_desk");
    // Scope khác với test trước? Cùng scope `file_upload:org` của A nên đã có lượt; đo bằng dòng đếm thật.
    const used = (
      await sql<{ n: number }>`select coalesce(sum(hits), 0)::int as n from rate_limit_counters
        where scope = 'file_upload:org' and subject = ${A.orgId}`.execute(t.admin)
    ).rows[0]?.n as number;
    const limits = { perMember: 1000, perOrg: used + 2 };
    expect((await handleFileUpload(fileReq(A, orgLimit), depsFor(t.runtime, limits))).status).toBe(201);
    expect((await handleFileUpload(fileReq(A, other), depsFor(second, limits))).status).toBe(201);
    const res = await handleFileUpload(fileReq(A, orgLimit), depsFor(second, limits));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  it("tổ chức B không bị ảnh hưởng khi A bão hoà (bộ đếm theo tổ chức/thành viên)", async () => {
    const userB = await seedStaff(B, "manager");
    const res = await handleFileUpload(fileReq(B, userB), depsFor(t.runtime, { perMember: 2, perOrg: 2 }));
    expect(res.status).toBe(201);
  });

  it("chưa đăng nhập → 401 và KHÔNG tốn bộ đếm (kiểm quyền trước giới hạn)", async () => {
    const before = await sql<{ n: number }>`select count(*)::int as n from rate_limit_counters`.execute(
      t.admin,
    );
    const req = new Request("http://local.test/api/v1/files/upload?owner_type=work_order", {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: Buffer.from(JPEG),
    });
    expect((await handleFileUpload(req, depsFor(t.runtime, { perMember: 1, perOrg: 1 }))).status).toBe(401);
    const after = await sql<{ n: number }>`select count(*)::int as n from rate_limit_counters`.execute(
      t.admin,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe("POST /api/v1/import/upload — giới hạn tần suất", () => {
  it("hai pool dùng chung bộ đếm: lượt qua cổng bị 400 (multipart hỏng), lượt vượt ⇒ 429 + Retry-After trước khi đọc thân", async () => {
    const owner = A.ownerAuthUserId;
    const limits = { perMember: 2, perOrg: 1000 };
    expect((await handleImportUpload(importReq(A, owner), depsFor(t.runtime, limits))).status).toBe(400);
    expect((await handleImportUpload(importReq(A, owner), depsFor(second, limits))).status).toBe(400);
    for (const db of [t.runtime, second]) {
      const res = await handleImportUpload(importReq(A, owner), depsFor(db, limits));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
    }
  });
});
