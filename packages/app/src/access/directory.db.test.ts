// `member.list` và `property.list` (SPEC-access 5.2): đúng phạm vi theo vai trò, không lộ token/băm, không lẫn tổ chức khác.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerOf, seedMember } from "../testing/helpers.ts";
import { listMembers, listProperties } from "./directory.ts";

let t: TestDb;
let A: SeededOrg;
let P2: string;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Danh mục thành viên");
  P2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${P2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
    t.admin,
  );
});
afterAll(async () => {
  await t?.drop();
});

const invite = async (
  email: string,
  role: string,
  props: string[],
  status = "pending",
  expires = "now() + interval '1 day'",
) =>
  sql`insert into invitations (id, organization_id, email, role, property_ids, token_hash, expires_at, status, invited_by)
      values (${randomUUID()}, ${A.orgId}, ${email}, ${role}, ${props}::uuid[], sha256(convert_to(${randomUUID()}, 'UTF8')),
              ${sql.raw(expires)}, ${status}, ${A.ownerMembershipId})`.execute(t.admin);

describe("member.list", () => {
  it("owner thấy mọi nhân viên (không người thuê, không đã thu hồi) kèm cơ sở; lời mời chỉ loại đang chờ và còn hạn; không lộ token", async () => {
    const fd = await seedMember(t, A, "front_desk", { name: "Lễ tân Lan" });
    const mgr = await seedMember(t, A, "manager", { name: "Quản lý Minh", properties: [P2] });
    await seedMember(t, A, "tenant", { name: "Người thuê" });
    const gone = await seedMember(t, A, "housekeeping", { name: "Đã nghỉ" });
    await sql`update memberships set status = 'revoked', revoked_at = now() where id = ${gone.membershipId}`.execute(
      t.admin,
    );
    await invite("cho@example.test", "front_desk", [A.propertyId]);
    await invite(
      "het.han@example.test",
      "front_desk",
      [A.propertyId],
      "pending",
      "now() - interval '1 second'",
    );
    await invite("da.huy@example.test", "front_desk", [A.propertyId], "revoked");
    const r = await listMembers(t.runtime, await ownerOf(t, A));
    const names = r.members.map((m) => m.fullName);
    expect(names).toEqual(expect.arrayContaining(["Lễ tân Lan", "Quản lý Minh"]));
    expect(names).not.toContain("Người thuê");
    expect(names).not.toContain("Đã nghỉ");
    expect(r.members.find((m) => m.membershipId === mgr.membershipId)?.properties).toEqual([
      { id: P2, name: "Cơ sở 2" },
    ]);
    expect(r.members.find((m) => m.membershipId === A.ownerMembershipId)).toMatchObject({
      isSelf: true,
      allProperties: true,
    });
    expect(r.members.find((m) => m.membershipId === fd.membershipId)?.isSelf).toBe(false);
    expect(r.invitations.map((i) => i.email)).toEqual(["cho@example.test"]);
    expect(JSON.stringify(r)).not.toMatch(/token/i);
  });

  it("manager chỉ thấy nhân viên cấp thấp cùng cơ sở + chính mình; lời mời của vai trò/cơ sở khác ẩn; lễ tân/kế toán bị 403", async () => {
    const mgr = await seedMember(t, A, "manager", { name: "QL cơ sở 1", properties: [A.propertyId] });
    const same = await seedMember(t, A, "housekeeping", {
      name: "Buồng cơ sở 1",
      properties: [A.propertyId],
    });
    const other = await seedMember(t, A, "maintenance", { name: "Kỹ thuật cơ sở 2", properties: [P2] });
    const acc = await seedMember(t, A, "accountant", { properties: "all" });
    await invite("cs1@example.test", "housekeeping", [A.propertyId]);
    await invite("cs2@example.test", "front_desk", [P2]);
    await invite("quanly@example.test", "manager", [A.propertyId]);
    const r = await listMembers(t.runtime, mgr);
    const ids = r.members.map((m) => m.membershipId);
    expect(ids).toContain(same.membershipId);
    expect(ids).toContain(mgr.membershipId);
    expect(ids).not.toContain(other.membershipId);
    expect(ids).not.toContain(acc.membershipId);
    expect(ids).not.toContain(A.ownerMembershipId);
    expect(r.invitations.map((i) => i.email)).toEqual(expect.arrayContaining(["cs1@example.test"]));
    expect(r.invitations.map((i) => i.email)).not.toContain("cs2@example.test");
    expect(r.invitations.map((i) => i.email)).not.toContain("quanly@example.test");
    for (const role of ["front_desk", "accountant", "housekeeping"]) {
      await expect(listMembers(t.runtime, await seedMember(t, A, role))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("manager phạm vi [P1] xem nhân viên/lời mời phạm vi [P1,P2] → chỉ thấy cơ sở P1 (không lộ tên cơ sở ngoài phạm vi); owner thấy đủ", async () => {
    const mgr = await seedMember(t, A, "manager", { name: "QL chỉ P1", properties: [A.propertyId] });
    const wide = await seedMember(t, A, "front_desk", {
      name: "Lễ tân hai cơ sở",
      properties: [A.propertyId, P2],
    });
    await invite("rong@example.test", "front_desk", [A.propertyId, P2]);
    const seen = await listMembers(t.runtime, mgr);
    const row = seen.members.find((m) => m.membershipId === wide.membershipId);
    expect(row?.properties.map((p) => p.id)).toEqual([A.propertyId]);
    const inv = seen.invitations.find((i) => i.email === "rong@example.test");
    expect(inv?.properties.map((p) => p.id)).toEqual([A.propertyId]);
    expect(JSON.stringify(seen)).not.toContain("Cơ sở 2");
    const owner = await listMembers(t.runtime, await ownerOf(t, A));
    expect(
      owner.members
        .find((m) => m.membershipId === wide.membershipId)
        ?.properties.map((p) => p.id)
        .sort(),
    ).toEqual([A.propertyId, P2].sort());
    expect(
      owner.invitations
        .find((i) => i.email === "rong@example.test")
        ?.properties.map((p) => p.id)
        .sort(),
    ).toEqual([A.propertyId, P2].sort());
  });

  it("không lẫn tổ chức khác", async () => {
    const B = await seedOrg(t.admin, "Tổ chức B");
    await seedMember(t, B, "front_desk", { name: "Lễ tân của B" });
    const r = await listMembers(t.runtime, await ownerOf(t, A));
    expect(r.members.map((m) => m.fullName)).not.toContain("Lễ tân của B");
  });
});

describe("property.list", () => {
  it("owner thấy mọi cơ sở chưa lưu trữ kèm cấu hình; nhân viên chỉ thấy cơ sở trong phạm vi; người thuê bị 403", async () => {
    await sql`update properties set check_in_time = '14:00', check_out_time = '12:00' where id = ${A.propertyId}`.execute(
      t.admin,
    );
    const all = await listProperties(t.runtime, await ownerOf(t, A));
    expect(all.map((p) => p.propertyId).sort()).toEqual([A.propertyId, P2].sort());
    expect(all.find((p) => p.propertyId === A.propertyId)).toMatchObject({
      template: "hotel",
      timezone: "Asia/Ho_Chi_Minh",
      businessDayCutoff: "00:00",
      checkInTime: "14:00",
      checkOutTime: "12:00",
      currency: "VND",
    });
    const hk = await seedMember(t, A, "housekeeping", { properties: [P2] });
    expect((await listProperties(t.runtime, hk)).map((p) => p.propertyId)).toEqual([P2]);
    await sql`update properties set archived_at = now() where id = ${P2}`.execute(t.admin);
    expect((await listProperties(t.runtime, await ownerOf(t, A))).map((p) => p.propertyId)).toEqual([
      A.propertyId,
    ]);
    await expect(listProperties(t.runtime, await seedMember(t, A, "tenant"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await sql`update properties set archived_at = null where id = ${P2}`.execute(t.admin);
  });
});
