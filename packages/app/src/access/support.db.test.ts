// T-2313 (IND-SAAS-009, TM-12; D-122) — truy cập hỗ trợ có lý do + thời hạn trên Postgres thật:
// owner cấp/thu hồi (`support.access_granted` / `support.access_revoked` — audit + sự kiện bảo mật); hỗ trợ CHỈ ĐỌC khi grant còn hiệu
// lực, hết hạn/thu hồi ⇒ mất quyền ở request kế tiếp; không grant ⇒ không quyền gì; mọi hành động của hỗ trợ ghi audit kèm grant + lý do;
// ràng buộc CSDL (TTL ≤ 72 giờ, lý do NOT NULL, chỉ owner, chỉ đặt thu hồi một lần, RLS theo tổ chức, chặn ghi của hỗ trợ); đồng thời.
import { randomUUID } from "node:crypto";
import { createMigrator, migrations, withTenant } from "@hm/db";
import { createTestDb, seedAuthUser } from "@hm/testkit";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRooms } from "../inventory/rooms.ts";
import { executeCommand } from "../pipeline/command.ts";
import { listReservations } from "../stay/reservations.ts";
import { codeOf, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { AccessError, type Actor, resolveActor } from "./actor.ts";
import { listProperties } from "./directory.ts";
import {
  grantSupportAccess,
  listSupportGrants,
  recordSupportAccess,
  revokeSupportAccess,
  SUPPORT_REVOKE_DEFAULT_REASON,
  supportPageAccess,
} from "./support.ts";

let h: Hotel;
const CLIENT = { ip: "198.51.100.23", userAgent: "SupportTest/1.0" };

/** Nhân viên hỗ trợ nền tảng (đăng ký trong `platform_support_users`). */
async function supportUser(
  opts: { verified?: boolean; listed?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = `ho.tro+${randomUUID().slice(0, 8)}@example.test`;
  const id = await seedAuthUser(h.t.admin, email, randomUUID(), opts.verified ?? true);
  if (opts.listed ?? true)
    await sql`insert into platform_support_users (auth_user_id) values (${id})`.execute(h.t.admin);
  return { id, email };
}

const resolve = (authUserId: string, orgId = h.org.orgId) =>
  resolveActor(h.t.runtime, { authUserId, orgId, twoFactorEnabled: true });

const grant = (actor: Actor, email: string, hours = 4, reason = "Khách báo lỗi in phiếu — ticket #42") =>
  runAs(h.t, actor, (ctx) => grantSupportAccess(ctx, { email, hours, reason }));

const audits = async (where: ReturnType<typeof sql>) =>
  (
    await sql<{
      action: string;
      actor_type: string;
      actor_person_id: string | null;
      support_grant_id: string | null;
      reason: string | null;
      outcome: string;
      entity_type: string;
      entity_id: string | null;
      source_ip: string | null;
      user_agent: string | null;
    }>`select action, actor_type, actor_person_id, support_grant_id, reason, outcome, entity_type, entity_id, source_ip, user_agent
       from audit_events where organization_id = ${h.org.orgId} and ${where} order by created_at, id`.execute(
      h.t.admin,
    )
  ).rows;

beforeAll(async () => {
  h = await seedHotel();
});
afterAll(async () => {
  await h?.t.drop();
});

describe("cấp truy cập hỗ trợ (owner)", () => {
  it("owner cấp ⇒ grant + membership platform_support (hạn = expires_at) + audit có lý do + outbox; hỗ trợ thành actor có grant", async () => {
    const u = await supportUser();
    const before = new Date();
    const r = await grant(h.owner, u.email, 6);
    expect(r.status).toBe("committed");
    if (r.status !== "committed") return;
    const g = (
      await sql<{ expires_at: Date; granted_at: Date; reason: string; granted_by: string }>`
        select expires_at, granted_at, reason, granted_by from support_grants where id = ${r.data.grantId}`.execute(
        h.t.admin,
      )
    ).rows[0];
    expect(g?.reason).toBe("Khách báo lỗi in phiếu — ticket #42");
    expect(g?.granted_by).toBe(h.owner.membershipId);
    const hours = ((g?.expires_at.getTime() ?? 0) - (g?.granted_at.getTime() ?? 0)) / 3_600_000;
    expect(hours).toBeCloseTo(6, 3);
    expect(g?.granted_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    const m = (
      await sql<{ role: string; valid_to: Date; status: string }>`
        select role, valid_to, status from memberships where id = ${r.data.membershipId}`.execute(h.t.admin)
    ).rows[0];
    expect(m).toMatchObject({ role: "platform_support", status: "active" });
    expect(m?.valid_to.getTime()).toBe(g?.expires_at.getTime());
    const a = await audits(sql`action = 'support.access_granted' and entity_id = ${r.data.grantId}`);
    expect(a).toEqual([
      expect.objectContaining({
        actor_type: "user",
        actor_person_id: h.owner.personId,
        reason: "Khách báo lỗi in phiếu — ticket #42",
        outcome: "success",
        support_grant_id: null,
      }),
    ]);
    const ob = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'support.access_granted' and aggregate_id = ${r.data.grantId}`.execute(
      h.t.admin,
    );
    expect(ob.rows[0]?.n).toBe(1);

    const s = await resolve(u.id);
    expect(s.role).toBe("platform_support");
    expect(s.mfaRequired).toBe(true);
    expect(s.supportGrant).toMatchObject({
      id: r.data.grantId,
      reason: "Khách báo lỗi in phiếu — ticket #42",
    });
    expect(s.propertyIds).toContain(h.org.propertyId);
  });

  it("hỗ trợ chưa bật MFA ⇒ MFA_REQUIRED (đọc dữ liệu tổ chức khác luôn cần MFA)", async () => {
    const u = await supportUser();
    expect((await grant(h.owner, u.email)).status).toBe("committed");
    await expect(
      resolveActor(h.t.runtime, { authUserId: u.id, orgId: h.org.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });

  it("ca từ chối: không phải owner ⇒ 403 + audit support.grant_denied; email không phải hỗ trợ/chưa xác minh ⇒ 422; giờ 0/73 ⇒ 422; lý do rỗng ⇒ 422", async () => {
    const u = await supportUser();
    for (const who of [h.manager, h.accountant, h.frontDesk, h.housekeeping])
      expect(await codeOf(grant(who, u.email))).toBe("FORBIDDEN");
    const denied = await audits(sql`action = 'support.grant_denied'`);
    expect(denied.length).toBe(4);
    expect(denied.every((x) => x.outcome === "success" && x.reason === "FORBIDDEN")).toBe(true);

    const notListed = await supportUser({ listed: false });
    const unverified = await supportUser({ verified: false });
    for (const email of [notListed.email, unverified.email, "khong.ton.tai@example.test"]) {
      const r = await grant(h.owner, email);
      expect(r).toMatchObject({ status: "failed", problem: { code: "VALIDATION_FAILED" } });
      if (r.status === "failed") expect(r.problem.errors?.[0]?.field).toBe("email");
    }
    for (const hours of [0, 73, 1.5]) {
      const r = await grant(h.owner, u.email, hours);
      expect(r).toMatchObject({ status: "failed", problem: { code: "VALIDATION_FAILED" } });
      if (r.status === "failed") expect(r.problem.errors?.[0]?.field).toBe("hours");
    }
    expect(await codeOf(grant(h.owner, u.email, 4, "   "))).toBe("VALIDATION_FAILED");
    // Biên 72 giờ: được.
    expect((await grant(h.owner, u.email, 72)).status).toBe("committed");
  });

  it("đang có truy cập còn hạn ⇒ 409; người đang là thành viên khác của tổ chức ⇒ 409", async () => {
    const u = await supportUser();
    expect((await grant(h.owner, u.email)).status).toBe("committed");
    expect(await codeOf(grant(h.owner, u.email))).toBe("INVALID_TRANSITION");
    const staffEmail = (
      await sql<{
        email: string;
      }>`select u.email from auth."user" u where u.id = ${h.manager.authUserId}`.execute(h.t.admin)
    ).rows[0]?.email as string;
    await sql`insert into platform_support_users (auth_user_id) values (${h.manager.authUserId})`.execute(
      h.t.admin,
    );
    expect(await codeOf(grant(h.owner, staffEmail))).toBe("INVALID_TRANSITION");
  });

  it("đồng thời: hai lần cấp song song cho cùng người ⇒ đúng một committed, bên kia 409; chỉ một grant", async () => {
    const u = await supportUser();
    const rs = await Promise.all([grant(h.owner, u.email), grant(h.owner, u.email), grant(h.owner, u.email)]);
    expect(rs.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(
      rs.filter((r) => r.status === "failed").map((r) => r.status === "failed" && r.problem.code),
    ).toEqual(["INVALID_TRANSITION", "INVALID_TRANSITION"]);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from support_grants g join memberships m on m.id = g.grantee_membership_id
      where m.auth_user_id = ${u.id}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBe(1);
  });
});

describe("hỗ trợ chỉ đọc khi grant còn hiệu lực", () => {
  let u: { id: string; email: string };
  let support: Actor;
  let grantId: string;

  beforeAll(async () => {
    u = await supportUser();
    const r = await grant(h.owner, u.email, 2, "Kiểm tra lịch phòng giúp chủ");
    if (r.status !== "committed") throw new Error("seed grant");
    grantId = r.data.grantId;
    support = await resolve(u.id);
  });

  it("được phép: đọc trạng thái phòng/cơ sở (calendar.read_status) trong tổ chức", async () => {
    const props = await listProperties(h.t.runtime, support);
    expect(props.map((p) => p.propertyId)).toContain(h.org.propertyId);
    const rooms = await listRooms(h.t.runtime, support);
    expect(rooms.length).toBeGreaterThan(0);
  });

  it("bị từ chối: lệnh ghi bất kỳ ⇒ 403 + audit denied mang actor_type platform_support + support_grant_id", async () => {
    const correlationId = `sup-${randomUUID()}`;
    const r = await executeCommand(
      h.t.runtime,
      support,
      {
        command: "test.command",
        idempotencyKey: randomUUID(),
        payload: { x: 1 },
        correlationId,
        client: CLIENT,
      },
      async () => ({ data: { wrote: true } }),
    );
    expect(r).toMatchObject({ status: "failed", httpStatus: 403, problem: { code: "FORBIDDEN" } });
    const a = await audits(sql`correlation_id = ${correlationId}`);
    expect(a).toEqual([
      expect.objectContaining({
        action: "command.denied",
        actor_type: "platform_support",
        actor_person_id: support.personId,
        support_grant_id: grantId,
        outcome: "denied",
        reason: "FORBIDDEN",
        source_ip: "198.51.100.0",
        user_agent: "SupportTest/1.0",
      }),
    ]);
  });

  it("bị từ chối: đọc tiền/audit/thành viên (ngoài SUPPORT_READ_ACTIONS) ⇒ AuthzError FORBIDDEN", async () => {
    const { listEvents } = await import("../audit/events.ts");
    const { listMembers } = await import("./directory.ts");
    await expect(listEvents(h.t.runtime, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listMembers(h.t.runtime, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listSupportGrants(h.t.runtime, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("CSDL chặn ghi của hỗ trợ (policy support_read_only_*) kể cả khi đi vòng app; audit_events vẫn ghi được", async () => {
    const ctx = { orgId: h.org.orgId, actorId: support.membershipId };
    await expect(
      withTenant(h.t.runtime, ctx, (trx) =>
        sql`insert into floors (id, organization_id, property_id, name) values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, 'Tầng hỗ trợ')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await withTenant(h.t.runtime, ctx, (trx) =>
      sql`update units set code = 'HACK' where organization_id = ${h.org.orgId}`.execute(trx),
    );
    expect(Number(upd.numAffectedRows)).toBe(0);
    const del = await withTenant(h.t.runtime, ctx, (trx) =>
      sql`delete from property_scopes where organization_id = ${h.org.orgId}`.execute(trx),
    );
    expect(Number(del.numAffectedRows)).toBe(0);
    // Vai trò khác không bị ảnh hưởng (policy chỉ chặn platform_support).
    const ok = await withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: h.owner.membershipId }, (trx) =>
      sql`update units set code = code where organization_id = ${h.org.orgId}`.execute(trx),
    );
    expect(Number(ok.numAffectedRows)).toBeGreaterThan(0);
  });

  it("mỗi lần xem ghi `support.accessed` kèm grant + lý do + IP/UA; actor không phải hỗ trợ ⇒ không ghi", async () => {
    const correlationId = `acc-${randomUUID()}`;
    await recordSupportAccess(h.t.runtime, support, {
      resource: "inventory.listRooms",
      client: CLIENT,
      correlationId,
    });
    await recordSupportAccess(h.t.runtime, h.owner, { resource: "x", client: CLIENT, correlationId });
    expect(await audits(sql`correlation_id = ${correlationId}`)).toEqual([
      expect.objectContaining({
        action: "support.accessed",
        actor_type: "platform_support",
        support_grant_id: grantId,
        reason: "Kiểm tra lịch phòng giúp chủ",
        entity_type: "route",
        source_ip: "198.51.100.0",
        user_agent: "SupportTest/1.0",
        outcome: "success",
      }),
    ]);
  });

  it("trang SSR: hỗ trợ mở trang ngoài /lich-phong ⇒ forbidden, không ghi; /lich-phong ⇒ đúng MỘT `support.accessed`; nhân viên ⇒ no-op", async () => {
    const before = await audits(sql`action = 'support.accessed' and support_grant_id = ${grantId}`);
    for (const page of ["/phong", "/nhat-ky", "/thu-tien", "/portal", "/lich-phong/khac", ""])
      expect(await supportPageAccess(h.t.runtime, support, { page, client: CLIENT })).toBe("forbidden");
    expect(await audits(sql`action = 'support.accessed' and support_grant_id = ${grantId}`)).toHaveLength(
      before.length,
    );
    const correlationId = `page-${randomUUID()}`;
    expect(
      await supportPageAccess(h.t.runtime, support, { page: "/lich-phong", client: CLIENT, correlationId }),
    ).toBe("allowed");
    expect(await audits(sql`correlation_id = ${correlationId}`)).toEqual([
      expect.objectContaining({
        action: "support.accessed",
        actor_type: "platform_support",
        support_grant_id: grantId,
      }),
    ]);
    expect(
      await supportPageAccess(h.t.runtime, h.owner, { page: "/phong", correlationId: `${correlationId}-o` }),
    ).toBe("not_support");
    expect(await audits(sql`correlation_id = ${`${correlationId}-o`}`)).toEqual([]);
    // Trang lịch phòng không lộ tên khách/tiền cho hỗ trợ: danh sách booking (có tên người đặt, giá) bị từ chối.
    await expect(
      listReservations(h.t.runtime, support, {
        propertyId: h.org.propertyId,
        from: "2026-01-01",
        to: "2026-01-08",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("trang SSR fail-closed: ghi audit lỗi ⇒ ném (không render)", async () => {
    const broken = { ...support, orgId: randomUUID() };
    await expect(supportPageAccess(h.t.runtime, broken, { page: "/lich-phong" })).rejects.toThrow();
    const noGrant = { ...support, supportGrant: null } as unknown as Actor;
    await expect(supportPageAccess(h.t.runtime, noGrant, { page: "/lich-phong" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("owner thu hồi một bước ⇒ request kế tiếp của hỗ trợ không còn actor (404); audit support.access_revoked; thu hồi lại ⇒ 409", async () => {
    const r = await runAs(h.t, h.owner, (ctx) => revokeSupportAccess(ctx, { grantId }));
    expect(r.status).toBe("committed");
    await expect(resolve(u.id)).rejects.toBeInstanceOf(AccessError);
    await expect(resolve(u.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await audits(sql`action = 'support.access_revoked' and entity_id = ${grantId}`)).toEqual([
      expect.objectContaining({ actor_person_id: h.owner.personId, reason: SUPPORT_REVOKE_DEFAULT_REASON }),
    ]);
    expect(await codeOf(runAs(h.t, h.owner, (ctx) => revokeSupportAccess(ctx, { grantId })))).toBe(
      "INVALID_TRANSITION",
    );
    // Actor cũ còn trong bộ nhớ (request đang chạy) vẫn không ghi được gì ở CSDL: membership đã revoked ⇒ app.actor_role() null.
    const list = await listSupportGrants(h.t.runtime, h.owner);
    expect(list.find((x) => x.grantId === grantId)?.status).toBe("revoked");
  });
});

describe("hết hạn / không grant / thu hồi song song", () => {
  /** Grant đã hết hạn (cấp 3 giờ trước, hạn 1 giờ trước) — dựng thẳng bằng admin vì CHECK không cho sửa hạn sau khi tạo. */
  async function expiredGrant(): Promise<{ user: string; grantId: string; membershipId: string }> {
    const u = await supportUser();
    const person = randomUUID();
    const membershipId = randomUUID();
    const grantId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${h.org.orgId}, 'Hỗ trợ hết hạn')`.execute(
      h.t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, valid_from, valid_to)
              values (${membershipId}, ${h.org.orgId}, ${u.id}, ${person}, 'platform_support', now() - interval '3 hours',
                      now() - interval '1 hour')`.execute(h.t.admin);
    await sql`insert into support_grants (id, organization_id, grantee_membership_id, granted_by, reason, granted_at, expires_at)
              values (${grantId}, ${h.org.orgId}, ${membershipId}, ${h.owner.membershipId}, 'Hết hạn', now() - interval '3 hours',
                      now() - interval '1 hour')`.execute(h.t.admin);
    return { user: u.id, grantId, membershipId };
  }

  it("grant hết hạn ⇒ hỗ trợ không còn actor; membership còn hạn nhưng grant hết hạn (lệch) ⇒ vẫn không", async () => {
    const e = await expiredGrant();
    await expect(resolve(e.user)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Lệch: membership còn hạn (sửa tay) nhưng grant đã hết ⇒ grant quyết định.
    await sql`update memberships set valid_to = now() + interval '1 hour' where id = ${e.membershipId}`.execute(
      h.t.admin,
    );
    await expect(resolve(e.user)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const list = await listSupportGrants(h.t.runtime, h.owner);
    expect(list.find((x) => x.grantId === e.grantId)?.status).toBe("expired");
  });

  it("sau khi hết hạn cấp lại được (membership cũ đóng hẳn, dùng lại hồ sơ người)", async () => {
    const e = await expiredGrant();
    const email = (
      await sql<{ email: string }>`select email from auth."user" where id = ${e.user}`.execute(h.t.admin)
    ).rows[0]?.email as string;
    const r = await grant(h.owner, email, 1);
    expect(r.status).toBe("committed");
    const ms = await sql<{ status: string; person_id: string }>`
      select status, person_id from memberships where auth_user_id = ${e.user} and organization_id = ${h.org.orgId}
      order by created_at`.execute(h.t.admin);
    expect(ms.rows.map((m) => m.status).sort()).toEqual(["active", "revoked"]);
    expect(new Set(ms.rows.map((m) => m.person_id)).size).toBe(1);
    expect((await resolve(e.user)).role).toBe("platform_support");
  });

  it("không grant: membership platform_support tạo tay (không có support_grants) ⇒ không phải actor", async () => {
    const u = await supportUser();
    const person = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${h.org.orgId}, 'Hỗ trợ không grant')`.execute(
      h.t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, valid_to)
              values (${randomUUID()}, ${h.org.orgId}, ${u.id}, ${person}, 'platform_support', now() + interval '1 day')`.execute(
      h.t.admin,
    );
    await expect(resolve(u.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("grant ở tổ chức A không cho quyền ở tổ chức B", async () => {
    const u = await supportUser();
    expect((await grant(h.owner, u.email)).status).toBe("committed");
    await expect(resolve(u.id, h.other.orgId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("đồng thời: hai lần thu hồi song song ⇒ một committed, một 409; manager thu hồi ⇒ 403 + audit support.revoke_denied", async () => {
    const u = await supportUser();
    const g = await grant(h.owner, u.email);
    if (g.status !== "committed") throw new Error("seed");
    expect(
      await codeOf(runAs(h.t, h.manager, (ctx) => revokeSupportAccess(ctx, { grantId: g.data.grantId }))),
    ).toBe("FORBIDDEN");
    expect(
      await audits(sql`action = 'support.revoke_denied' and entity_id = ${g.data.grantId}`),
    ).toHaveLength(1);
    const rs = await Promise.all(
      [1, 2].map(() =>
        runAs(h.t, h.owner, (ctx) =>
          revokeSupportAccess(ctx, { grantId: g.data.grantId, reason: "Xong việc" }),
        ),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual(["committed", "failed"]);
    expect(rs.find((r) => r.status === "failed")).toMatchObject({ problem: { code: "INVALID_TRANSITION" } });
    expect(
      await codeOf(runAs(h.t, h.owner, (ctx) => revokeSupportAccess(ctx, { grantId: randomUUID() }))),
    ).toBe("NOT_FOUND");
  });
});

describe("support.listGrants — quyền", () => {
  it("owner/manager/kế toán xem được (cùng tổ chức); lễ tân/buồng phòng ⇒ 403; tổ chức khác không thấy grant của A", async () => {
    for (const a of [h.owner, h.manager, h.accountant])
      expect((await listSupportGrants(h.t.runtime, a)).length).toBeGreaterThan(0);
    for (const a of [h.frontDesk, h.housekeeping])
      await expect(listSupportGrants(h.t.runtime, a)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listSupportGrants(h.t.runtime, h.ownerOther)).toEqual([]);
  });
});

describe("ràng buộc CSDL của support_grants (migration 0071)", () => {
  async function supportMembership(): Promise<string> {
    const u = await supportUser();
    const r = await grant(h.owner, u.email);
    if (r.status !== "committed") throw new Error("seed");
    return r.data.membershipId;
  }
  const insertGrant = (
    membershipId: string,
    opts: { by?: string; reason?: string | null; ttl?: string } = {},
  ) =>
    sql`insert into support_grants (id, organization_id, grantee_membership_id, granted_by, reason, expires_at)
        values (${randomUUID()}, ${h.org.orgId}, ${membershipId}, ${opts.by ?? h.owner.membershipId},
                ${"reason" in opts ? opts.reason : "lý do"}, now() + ${opts.ttl ?? "1 hour"}::interval)`.execute(
      h.t.admin,
    );
  const freshMembership = async (role = "platform_support") => {
    const u = await supportUser();
    const person = randomUUID();
    const id = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${h.org.orgId}, 'x')`.execute(
      h.t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, valid_to)
              values (${id}, ${h.org.orgId}, ${u.id}, ${person}, ${role}, now() + interval '1 day')`.execute(
      h.t.admin,
    );
    return id;
  };

  it("hạn > 72 giờ, hạn ≤ lúc cấp, lý do NULL/rỗng ⇒ CSDL từ chối; đúng 72 giờ được", async () => {
    await expect(insertGrant(await freshMembership(), { ttl: "72 hours 1 second" })).rejects.toThrow(
      /ck_support_grants_ttl/,
    );
    await expect(insertGrant(await freshMembership(), { ttl: "0 seconds" })).rejects.toThrow(
      /ck_support_grants_ttl/,
    );
    await expect(insertGrant(await freshMembership(), { reason: null })).rejects.toThrow(/null value/);
    await expect(insertGrant(await freshMembership(), { reason: "  " })).rejects.toThrow(/check constraint/);
    await expect(insertGrant(await freshMembership(), { ttl: "72 hours" })).resolves.toBeDefined();
  });

  it("người được cấp không phải platform_support / người cấp không phải owner ⇒ trigger từ chối", async () => {
    await expect(insertGrant(await freshMembership("housekeeping"))).rejects.toThrow(/platform_support/);
    await expect(insertGrant(await freshMembership(), { by: h.manager.membershipId })).rejects.toThrow(
      /owner/,
    );
  });

  it("sau khi tạo: không sửa lý do/hạn, không xoá; chỉ đặt thu hồi một lần (bởi owner)", async () => {
    const m = await supportMembership();
    const id = (
      await sql<{ id: string }>`select id from support_grants where grantee_membership_id = ${m}`.execute(
        h.t.admin,
      )
    ).rows[0]?.id as string;
    await expect(
      sql`update support_grants set reason = 'đổi' where id = ${id}`.execute(h.t.admin),
    ).rejects.toThrow(/một lần/);
    await expect(
      sql`update support_grants set expires_at = expires_at + interval '1 hour' where id = ${id}`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/một lần/);
    await expect(sql`delete from support_grants where id = ${id}`.execute(h.t.admin)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      sql`update support_grants set revoked_at = now(), revoked_by = ${h.manager.membershipId} where id = ${id}`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/owner/);
    await sql`update support_grants set revoked_at = now(), revoked_by = ${h.owner.membershipId} where id = ${id}`.execute(
      h.t.admin,
    );
    await expect(
      sql`update support_grants set revoked_at = now(), revoked_by = ${h.owner.membershipId} where id = ${id}`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/một lần/);
  });

  it("RLS: ngữ cảnh tổ chức B không thấy/không ghi grant của A; manager không ghi được (chỉ owner)", async () => {
    const m = await supportMembership();
    const seen = await withTenant(h.t.runtime, { orgId: h.other.orgId }, (trx) =>
      sql`select id from support_grants where grantee_membership_id = ${m}`.execute(trx),
    );
    expect(seen.rows).toEqual([]);
    const fresh = await freshMembership();
    await expect(
      withTenant(h.t.runtime, { orgId: h.org.orgId, actorId: h.manager.membershipId }, (trx) =>
        sql`insert into support_grants (id, organization_id, grantee_membership_id, granted_by, reason, expires_at)
            values (${randomUUID()}, ${h.org.orgId}, ${fresh}, ${h.owner.membershipId}, 'x', now() + interval '1 hour')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("audit_events: actor_type platform_support bắt buộc có support_grant_id và ngược lại", async () => {
    const ins = (actorType: string, grantId: string | null) =>
      sql`insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, correlation_id, support_grant_id)
          values (${randomUUID()}, ${h.org.orgId}, ${actorType}, ${h.owner.personId}, 'test.x', 't', 'c', ${grantId})`.execute(
        h.t.admin,
      );
    const m = await supportMembership();
    const id = (
      await sql<{ id: string }>`select id from support_grants where grantee_membership_id = ${m}`.execute(
        h.t.admin,
      )
    ).rows[0]?.id as string;
    await expect(ins("platform_support", null)).rejects.toThrow(/ck_audit_support_grant/);
    await expect(ins("user", id)).rejects.toThrow(/ck_audit_support_grant/);
    await expect(ins("platform_support", randomUUID())).rejects.toThrow(/fk_audit_support_grant/);
    await expect(ins("platform_support", id)).resolves.toBeDefined();
  });
});

describe("hàng rào: mọi bảng tổ chức có policy chỉ-đọc cho hỗ trợ (D-126)", () => {
  it("bảng public có organization_id (và organizations) — trừ bảng hỗ trợ được ghi — đủ support_read_only_insert/update/delete", async () => {
    // Policy của 0071 chỉ dựng cho bảng có lúc migrate: bảng tổ chức thêm ở migration sau phải tự thêm 3 policy này, nếu không
    // actor platform_support ghi được ở tầng CSDL (chỉ còn pipeline chặn). Test này đỏ khi quên.
    const r = await sql<{ table_name: string; n: number }>`
      select t.table_name, (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.table_name
        and p.policyname in ('support_read_only_insert','support_read_only_update','support_read_only_delete'))::int as n
      from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and (t.table_name = 'organizations' or exists (select 1 from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'organization_id'))`.execute(
      h.t.admin,
    );
    const writable = new Set<string>(["audit_events", "idempotency_keys", "outbox"]);
    // `organizations`: 0071 chỉ chặn UPDATE/DELETE (tạo tổ chức là lệnh cấp người dùng, không có ngữ cảnh hỗ trợ).
    const need = (t: string) => (t === "organizations" ? 2 : 3);
    const missing = r.rows
      .filter((x) => !writable.has(x.table_name) && x.n !== need(x.table_name))
      .map((x) => x.table_name);
    expect(r.rows.length).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });
});

describe("migration 0071 — lùi/tiến", () => {
  it("down gỡ bảng/cột/policy chỉ-đọc; up lại dựng lại; lock_timeout 5 s; ràng buộc audit NOT VALID → VALIDATE", async () => {
    const db = await createTestDb();
    try {
      const count = async () =>
        (
          await sql<{ p: number; t: number; c: number }>`
            select (select count(*) from pg_policies where policyname like 'support_read_only_%')::int as p,
                   (select count(*) from pg_tables where tablename in ('support_grants','platform_support_users'))::int as t,
                   (select count(*) from information_schema.columns
                     where table_name = 'audit_events' and column_name = 'support_grant_id')::int as c`.execute(
            db.admin,
          )
        ).rows[0];
      const up = await count();
      expect(up?.t).toBe(2);
      expect(up?.c).toBe(1);
      expect(up?.p).toBeGreaterThan(150);
      let undone: string | undefined;
      for (let i = 0; i < 20 && undone !== "0071_support_grants"; i++) {
        const res = await createMigrator(db.admin).migrateDown();
        expect(res.error).toBeUndefined();
        undone = res.results?.[0]?.migrationName;
      }
      expect(undone).toBe("0071_support_grants");
      expect(await count()).toEqual({ p: 0, t: 0, c: 0 });
      // up trong transaction của migrator: lock_timeout 5 s cục bộ rồi trả về giá trị cũ (không rò sang migration sau).
      const m0071 = migrations["0071_support_grants"];
      if (!m0071) throw new Error("thiếu migration 0071");
      const ROLLBACK = new Error("rollback");
      let inside: string | undefined;
      await db.admin
        .transaction()
        .execute(async (trx) => {
          await sql`select set_config('lock_timeout', '7s', true)`.execute(trx);
          await m0071.up(trx);
          inside = (await sql<{ v: string }>`select current_setting('lock_timeout') as v`.execute(trx))
            .rows[0]?.v;
          throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(inside).toBe("7s");
      // Đợi khoá audit_events quá 5 giây ⇒ bỏ cuộc (lock_timeout), không treo vô hạn.
      const holder = new pg.Client({ connectionString: db.adminUrl });
      await holder.connect();
      await holder.query("begin");
      await holder.query("lock table audit_events in access exclusive mode");
      try {
        const guard = new Promise<string>((resolve) => setTimeout(() => resolve("TREO > 12s"), 12_000));
        const run = db.admin
          .transaction()
          .execute((trx) => m0071.up(trx))
          .then(
            () => "ÁP ĐƯỢC",
            (e: unknown) => String(e),
          );
        expect(await Promise.race([run, guard])).toMatch(/lock timeout/);
      } finally {
        await holder.query("rollback");
        await holder.end();
        await new Promise((r) => setTimeout(r, 500));
      }
      const again = await createMigrator(db.admin).migrateToLatest();
      expect(again.error).toBeUndefined();
      expect(await count()).toEqual(up);
      // Ràng buộc audit thêm NOT VALID rồi VALIDATE ⇒ đã hợp lệ (convalidated).
      const cons = await sql<{ conname: string; convalidated: boolean }>`
        select conname, convalidated from pg_constraint where conrelid = 'public.audit_events'::regclass
          and conname in ('fk_audit_support_grant', 'ck_audit_support_grant') order by conname`.execute(
        db.admin,
      );
      expect(cons.rows).toEqual([
        { conname: "ck_audit_support_grant", convalidated: true },
        { conname: "fk_audit_support_grant", convalidated: true },
      ]);
    } finally {
      await db.drop();
    }
  }, 60_000);
});
