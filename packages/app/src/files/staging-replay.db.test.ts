// T-303 / review lát 7 🟡3 🟡4 — replay `stageFile` cùng Idempotency-Key: (3) so khớp cả property_id/owner_id (khác ⇒ 409);
// (4) dòng `pending_scan` đã tới/quá hạn staging (job hạn giữ có thể đang/sắp xoá object) ⇒ 409, không chốt dòng sắp bị dọn.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type StageSpec, stageFile } from "./staging.ts";

let t: TestDb;
let A: SeededOrg;
let actor: Actor;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS replay");
  const user = await seedAuthUser(t.admin, `fd+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'fd')`.execute(
    t.admin,
  );
  const mid = randomUUID();
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${mid}, ${A.orgId}, ${user}, ${person}, 'front_desk', false)`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${mid}, ${A.propertyId})`.execute(t.admin);
  actor = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
});

afterAll(async () => {
  await t?.drop();
});

const spec = (over: Partial<StageSpec> = {}): StageSpec => ({
  id: randomUUID(),
  ownerType: "work_order",
  ownerId: null,
  propertyId: A.propertyId,
  mime: "image/jpeg",
  size: 100,
  sha256: "a".repeat(64),
  exifStripped: false,
  ...over,
});

const vnDaysFromToday = (days: number) => sql`(now() at time zone 'Asia/Ho_Chi_Minh')::date + ${days}::int`;

describe("stageFile — replay khớp đủ trường (🟡3)", () => {
  it("cùng yêu cầu ⇒ pending; khác property_id ⇒ 409; khác owner_id ⇒ 409", async () => {
    const owner = randomUUID();
    const s = spec({ ownerId: owner });
    expect((await stageFile(t.runtime, actor, s)).state).toBe("new");
    expect((await stageFile(t.runtime, actor, s)).state).toBe("pending");
    await expect(stageFile(t.runtime, actor, { ...s, propertyId: null })).rejects.toMatchObject({
      status: 409,
    });
    await expect(stageFile(t.runtime, actor, { ...s, ownerId: randomUUID() })).rejects.toMatchObject({
      status: 409,
    });
    await expect(stageFile(t.runtime, actor, { ...s, ownerId: null })).rejects.toMatchObject({ status: 409 });
  });
});

describe("stageFile — dòng pending_scan hết hạn staging (🟡4)", () => {
  async function setAfter(id: string, days: number) {
    await sql`update files set delete_after = ${vnDaysFromToday(days)} where id = ${id}`.execute(t.admin);
  }

  it("delete_after = hôm nay (VN) hoặc đã qua ⇒ 409 (job hạn giữ sẽ/đang xoá object); ngày mai ⇒ vẫn chốt được", async () => {
    const s = spec();
    await stageFile(t.runtime, actor, s);
    await setAfter(s.id, 1);
    expect((await stageFile(t.runtime, actor, s)).state).toBe("pending");
    await setAfter(s.id, 0);
    await expect(stageFile(t.runtime, actor, s)).rejects.toMatchObject({ status: 409 });
    await setAfter(s.id, -3);
    await expect(stageFile(t.runtime, actor, s)).rejects.toMatchObject({ status: 409 });
  });

  it("dòng đã ready không bị coi là hết hạn dù delete_after cũ; dòng ready delete_after rỗng ⇒ done", async () => {
    const s = spec({ exifStripped: true });
    await stageFile(t.runtime, actor, s);
    await sql`update files set status = 'ready', delete_after = null where id = ${s.id}`.execute(t.admin);
    expect(await stageFile(t.runtime, actor, s)).toMatchObject({ state: "done", status: "ready" });
  });
});
