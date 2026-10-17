// T-504 (BE-FILE-005, IND-SAAS-003, TM-06) — URL ký của file: chỉ cấp sau khi kiểm quyền; người ngoài phạm vi (tổ chức khác,
// cùng tổ chức nhưng không có quyền/ngoài cơ sở) nhận 404 NOT_FOUND (không phân biệt "không có" với "không có quyền" —
// API-CONTRACT §2) và KHÔNG có URL nào lọt ra; URL đã hết hạn bị SeaweedFS từ chối 403.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import { getFileUrl, uploadFile } from "./files.ts";
import { eicarOnlyScanner } from "./inspect.ts";
import { ObjectStorage } from "./storage.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let storage: ObjectStorage;
let ownerA: Actor;
let ownerB: Actor;
let frontDeskA: Actor;
let housekeepingA: Actor;
let otherPropertyStaffA: Actor;
let fileId: string;
let storageKey: string;

const deps = () => ({ storage, scanner: eicarOnlyScanner });

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

async function member(org: SeededOrg, role: string, propertyId: string | null): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  const m = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${m}, ${org.orgId}, ${user}, ${person}, ${role}, false)`.execute(t.admin);
  if (propertyId)
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${m}, ${propertyId})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

const run = <T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) =>
  executeCommand<T>(
    t.runtime,
    actor,
    { command: "file.test", idempotencyKey: randomUUID(), payload: { n: randomUUID() }, correlationId: "c" },
    fn,
  );

const urlFor = (actor: Actor, id: string) =>
  run(actor, async (ctx) => ({ data: await getFileUrl(ctx, deps(), id) }));

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "KS URL ký A");
  B = await seedOrg(t.admin, "KS URL ký B");
  ownerA = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  ownerB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  frontDeskA = await member(A, "front_desk", A.propertyId);
  housekeepingA = await member(A, "housekeeping", A.propertyId);
  // Cùng tổ chức A, nhưng chỉ được gán một cơ sở KHÁC (cơ sở thứ hai của A).
  const p2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${p2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
    t.admin,
  );
  otherPropertyStaffA = await member(A, "front_desk", p2);
  const r = await run(frontDeskA, async (ctx) => ({
    data: await uploadFile(ctx, deps(), {
      ownerType: "identity_document",
      propertyId: A.propertyId,
      bytes: JPEG,
    }),
  }));
  if (r.status !== "committed") throw new Error(JSON.stringify(r));
  fileId = r.data.fileId;
  const row = await sql<{ storage_key: string }>`select storage_key from files where id = ${fileId}`.execute(
    t.admin,
  );
  storageKey = row.rows[0]?.storage_key as string;
});

afterAll(async () => {
  await t?.drop();
});

describe("xin URL ký file của tổ chức A (BE-FILE-005)", () => {
  it("người có quyền (lễ tân cơ sở đó) nhận URL đọc được", async () => {
    const r = await urlFor(frontDeskA, fileId);
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect((await fetch(r.data.url)).status).toBe(200);
  });

  it.each([
    ["người B (tổ chức khác, owner)", () => ownerB],
    ["cùng tổ chức nhưng buồng phòng (không có quyền xem giấy tờ)", () => housekeepingA],
    ["cùng tổ chức, vai trò đủ quyền nhưng chỉ được gán cơ sở khác", () => otherPropertyStaffA],
  ])("%s → 404 NOT_FOUND, thân lỗi không chứa URL/khoá object", async (_name, who) => {
    const r = await urlFor(who(), fileId);
    expect(r).toMatchObject({ status: "failed", httpStatus: 404, problem: { code: "NOT_FOUND" } });
    const text = JSON.stringify(r);
    expect(text).not.toContain("X-Amz");
    expect(text).not.toContain(storageKey);
  });

  it("id không phải UUID / không tồn tại → 404 (cùng hình dạng với ngoài phạm vi, không lộ khác biệt)", async () => {
    for (const id of ["khong-phai-uuid", randomUUID(), ""])
      expect(await urlFor(ownerA, id), id).toMatchObject({ status: "failed", httpStatus: 404 });
  });

  it("ownerB không đọc được object của A kể cả khi đoán đúng khoá: URL không ký → 403 từ kho", async () => {
    expect((await fetch(`${(await storage.signedGetUrl(storageKey, 60)).split("?")[0]}`)).status).toBe(403);
  });
});

describe("URL ký hết hạn (TM-06)", () => {
  it("hết hạn → SeaweedFS trả 403; trước hạn cùng URL đó → 200 (chứng minh 403 là do hết hạn, không do ký sai)", async () => {
    const url = await storage.signedGetUrl(storageKey, 1);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("1");
    expect((await fetch(url)).status).toBe(200);
    // X-Amz-Date chính xác tới giây: chờ quá hạn + dư 1,5 s lệch đồng hồ làm tròn.
    await new Promise((r) => setTimeout(r, 3500));
    expect((await fetch(url)).status).toBe(403);
  }, 30_000);

  it("ca biên: ttl ≤ 0 hoặc quá trần bị kẹp (tối thiểu 1 s, tối đa 300 s) — không bao giờ cấp URL sống lâu hơn trần", async () => {
    expect(new URL(await storage.signedGetUrl(storageKey, 0)).searchParams.get("X-Amz-Expires")).toBe("1");
    expect(new URL(await storage.signedGetUrl(storageKey, 86_400)).searchParams.get("X-Amz-Expires")).toBe(
      "300",
    );
  });
});
