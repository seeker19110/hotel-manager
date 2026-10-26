// T-2313 (CMP-AUDIT-002, IND-SAAS-009; D-128) — nhật ký hoạt động cho admin tổ chức, trên Postgres thật:
// 1. Bảng tham số: MỖI hành động nhạy cảm (đổi quyền/thành viên, phiên, MFA, cấu hình tổ chức, xuất dữ liệu, truy cập hỗ trợ, yêu
//    cầu/huỷ xoá tổ chức, truy cập của support, lần bị từ chối) gọi qua route/đường thật ⇒ sự kiện có đủ who (actor_type +
//    actor_person_id), what (action), target (entity_type + entity_id), when (occurred_at timestamptz, UTC), where (IP đã cắt /24 +
//    UA), result (outcome), reason (khi lệnh có lý do). Đăng nhập/2FA: `auth/auth-events.db.test.ts` (cùng các cột, mỗi tổ chức).
// 2. `audit.listEvents`: lọc thời gian/người/loại người/hành động/đối tượng, keyset không trùng/không sót qua nhiều trang, RLS tổ chức.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, recordSupportAccess, resolveActor } from "../access/index.ts";
import { type HttpDeps, handleCommand } from "../http/command-route.ts";
import { COMMANDS } from "../http/registry.ts";
import { testServices } from "../server/services.ts";
import { cancelOrgDeletion, requestOrgDeletion } from "../tenancy/index.ts";
import { seedMember } from "../testing/helpers.ts";
import { listEvents } from "./events.ts";

let t: TestDb;
let deps: HttpDeps;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let manager: Actor;
let frontDesk: Actor;
let housekeeping: Actor;
const P2 = randomUUID();

const UA = "Mozilla/5.0 (Nhat-ky)";
const IP = "198.51.100.42";
const CLIENT = { ip: IP, userAgent: UA };

async function run(
  name: string,
  who: Actor,
  body: unknown,
): Promise<{ status: number; correlationId: string }> {
  const def = COMMANDS[name];
  if (!def) throw new Error(name);
  const correlationId = `nk-${randomUUID()}`;
  const res = await handleCommand(
    def as never,
    new Request("http://local.test/api/v1/x/y", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-test-user": who.authUserId,
        "x-test-2fa": "1",
        "x-org-id": who.orgId,
        "x-correlation-id": correlationId,
        "user-agent": UA,
        "x-forwarded-for": IP,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, correlationId };
}

interface Row {
  actor_type: string;
  actor_person_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: Date;
  utc: boolean;
  source_ip: string | null;
  user_agent: string | null;
  outcome: string;
  reason: string | null;
}

const lastEvent = async (org: string, action: string, since: Date) =>
  (
    await sql<Row>`
      select actor_type, actor_person_id, action, entity_type, entity_id, occurred_at,
             pg_typeof(occurred_at)::text = 'timestamp with time zone' as utc, source_ip, user_agent, outcome, reason
      from audit_events where organization_id = ${org} and action = ${action} and occurred_at >= ${since}
      order by occurred_at desc, id desc limit 1`.execute(t.admin)
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS-NHAT-KY-A");
  B = await seedOrg(t.admin, "KS-NHAT-KY-B");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  manager = await seedMember(t, A, "manager", { name: "Quản lý NK" });
  frontDesk = await seedMember(t, A, "front_desk", { name: "Lễ tân NK" });
  housekeeping = await seedMember(t, A, "housekeeping", { name: "Buồng phòng NK" });
  await sql`insert into properties (id, organization_id, name, template) values (${P2}, ${A.orgId}, 'KS-NHAT-KY-A — CS2', 'hotel')`.execute(
    t.admin,
  );
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      // Phiên vừa tạo (xuất dữ liệu đòi xác thực gần đây).
      return id
        ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" }, session: { createdAt: new Date() } }
        : null;
    },
    secureCookies: false,
    services: testServices(),
  };
});
afterAll(async () => {
  await t?.drop();
});

describe("CMP-AUDIT-002 — mỗi hành động nhạy cảm sinh sự kiện đủ trường", () => {
  type Case = {
    label: string;
    action: string;
    entityType: string;
    outcome?: "success" | "denied";
    reason?: string | null;
    actorType?: string;
    /** Không có đối tượng tồn tại (lần thử bị từ chối, truy cập trang/query): mục tiêu nằm ở `entity_type`/`after`. */
    noEntityId?: boolean;
    act: () => Promise<void>;
  };
  const viaRoute =
    (name: string, who: () => Actor, body: () => unknown, status = 200) =>
    async () => {
      const r = await run(name, who(), body());
      expect(r.status, name).toBe(status);
    };
  const supportInvitation: { id?: string | undefined } = {};
  const cases: Case[] = [
    {
      label: "mời thành viên",
      action: "member.invited",
      entityType: "invitation",
      reason: null,
      act: viaRoute(
        "member.invite",
        () => owner,
        () => ({
          email: `moi+${randomUUID().slice(0, 6)}@example.test`,
          role: "front_desk",
          property_ids: [A.propertyId],
        }),
        201,
      ),
    },
    {
      label: "mời vượt quyền bị từ chối (manager mời owner)",
      action: "member.invite_denied",
      entityType: "invitation",
      reason: "FORBIDDEN",
      noEntityId: true,
      act: viaRoute(
        "member.invite",
        () => manager,
        () => ({ email: "vuot.quyen@example.test", role: "owner" }),
        403,
      ),
    },
    {
      label: "lần bị từ chối chung (command.denied)",
      action: "command.denied",
      entityType: "member.invite",
      outcome: "denied",
      reason: "FORBIDDEN",
      act: async () => {
        /* sinh ở ca trên */
      },
    },
    {
      label: "đổi vai trò",
      action: "member.role_changed",
      entityType: "membership",
      reason: "Đổi ca làm việc",
      act: viaRoute(
        "member.updateRole",
        () => owner,
        () => ({
          membership_id: frontDesk.membershipId,
          role: "housekeeping",
          property_ids: [A.propertyId],
          reason: "Đổi ca làm việc",
        }),
      ),
    },
    {
      label: "đổi phạm vi cơ sở",
      action: "member.scope_changed",
      entityType: "membership",
      reason: "Chuyển cơ sở",
      act: viaRoute(
        "member.updateScope",
        () => owner,
        () => ({ membership_id: housekeeping.membershipId, property_ids: [P2], reason: "Chuyển cơ sở" }),
      ),
    },
    {
      label: "thu hồi phiên thành viên",
      action: "session.revoked",
      entityType: "membership",
      act: viaRoute(
        "session.revokeAll",
        () => owner,
        () => ({ membership_id: housekeeping.membershipId }),
      ),
    },
    {
      label: "đặt lại xác thực hai lớp",
      action: "member.mfa_reset",
      entityType: "membership",
      reason: "Mất điện thoại",
      act: viaRoute(
        "member.resetMfa",
        () => owner,
        () => ({ membership_id: manager.membershipId, reason: "Mất điện thoại" }),
      ),
    },
    {
      label: "cấu hình tổ chức (sửa cơ sở)",
      action: "property.updated",
      entityType: "property",
      act: viaRoute(
        "property.update",
        () => owner,
        () => ({ property_id: A.propertyId, check_in_time: "14:00" }),
      ),
    },
    {
      label: "xuất dữ liệu (nhật ký)",
      action: "export.requested",
      entityType: "export_job",
      act: viaRoute(
        "exports.request",
        () => owner,
        () => ({
          kind: "audit",
          format: "csv",
          filters: { from: "2026-10-01", to: "2026-10-26", action: "auth.login" },
        }),
        202,
      ),
    },
    {
      label: "cấp truy cập hỗ trợ",
      action: "support.access_granted",
      entityType: "invitation",
      reason: "Phiếu #7",
      act: async () => {
        const r = await run("member.grantSupportAccess", owner, {
          email: `ht+${randomUUID().slice(0, 6)}@example.test`,
          reason: "Phiếu #7",
        });
        expect(r.status).toBe(201);
        supportInvitation.id = (
          await sql<{ id: string }>`select id from invitations where organization_id = ${A.orgId}
            and role = 'platform_support' order by created_at desc limit 1`.execute(t.admin)
        ).rows[0]?.id;
      },
    },
    {
      label: "thu hồi truy cập hỗ trợ",
      action: "support.access_revoked",
      entityType: "invitation",
      act: async () => {
        expect(
          (await run("member.revokeSupportAccess", owner, { invitation_id: supportInvitation.id })).status,
        ).toBe(200);
      },
    },
    {
      label: "truy cập của support (trang)",
      action: "support.accessed",
      entityType: "page",
      actorType: "platform_support",
      reason: "Phiếu #8",
      act: async () => {
        const email = `ht2+${randomUUID().slice(0, 6)}@example.test`;
        const user = await seedAuthUser(t.admin, email);
        const person = randomUUID();
        const m = randomUUID();
        await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, 'Hỗ trợ H')`.execute(
          t.admin,
        );
        await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties, valid_to, support_reason)
                  values (${m}, ${A.orgId}, ${user}, ${person}, 'platform_support', true, now() + interval '1 hour', 'Phiếu #8')`.execute(
          t.admin,
        );
        const s = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
        await recordSupportAccess(t.runtime, s, { kind: "page", name: "/phong", client: CLIENT });
      },
    },
  ];
  // Xoá tổ chức chạy trên tổ chức riêng (chờ xoá khoá mọi truy cập khác của tổ chức đó).
  let C: SeededOrg;
  let ownerC: Actor;
  const orgCases: Case[] = [
    {
      label: "yêu cầu xoá tổ chức (hàm CSDL — nguồn qua trigger 0072)",
      action: "organization.deletion_requested",
      entityType: "organization",
      act: async () => {
        await requestOrgDeletion(t.runtime, ownerC, {
          reauthenticatedAt: new Date(),
          correlationId: `nk-${randomUUID()}`,
          client: CLIENT,
        });
      },
    },
    {
      label: "huỷ yêu cầu xoá tổ chức",
      action: "organization.deletion_cancelled",
      entityType: "organization",
      act: async () => {
        const c = await resolveActor(t.runtime, {
          authUserId: C.ownerAuthUserId,
          orgId: C.orgId,
          twoFactorEnabled: true,
          allowPendingDeletion: true,
        });
        expect(
          await cancelOrgDeletion(t.runtime, c, { correlationId: `nk-${randomUUID()}`, client: CLIENT }),
        ).toBe(true);
      },
    },
  ];

  beforeAll(async () => {
    C = await seedOrg(t.admin, "KS-NHAT-KY-C");
    ownerC = await resolveActor(t.runtime, {
      authUserId: C.ownerAuthUserId,
      orgId: C.orgId,
      twoFactorEnabled: true,
    });
  });

  it.each([
    ...cases.map((c) => ["A", c.label, c] as const),
    ...orgCases.map((c) => ["C", c.label, c] as const),
  ])("tổ chức %s: %s", async (org, _label, c) => {
    const since = new Date(Date.now() - 1000);
    await c.act();
    const orgId = org === "A" ? A.orgId : C.orgId;
    const e = await lastEvent(orgId, c.action, c.action === "command.denied" ? new Date(0) : since);
    expect(e, c.label).toBeDefined();
    const row = e as Row;
    expect(row.actor_type).toBe(c.actorType ?? "user");
    expect(row.actor_person_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.entity_type).toBe(c.entityType);
    if (!c.noEntityId && !["support.accessed", "command.denied"].includes(c.action))
      expect(row.entity_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.utc).toBe(true);
    expect(Math.abs(row.occurred_at.getTime() - Date.now())).toBeLessThan(120_000);
    expect(row.source_ip).toBe("198.51.100.0");
    expect(row.user_agent).toBe(UA);
    expect(row.outcome).toBe(c.outcome ?? "success");
    if (c.reason !== undefined) expect(row.reason).toBe(c.reason);
  });

  it("không client (worker/hệ thống) ⇒ GUC trống ⇒ nguồn NULL, không lấy nhầm của request trước", async () => {
    await sql`insert into audit_events (id, organization_id, actor_type, action, entity_type, correlation_id)
              values (${randomUUID()}, ${A.orgId}, 'worker', 'test.no_source', 'test', 'nk-worker')`.execute(
      t.admin,
    );
    const r = await sql<{ source_ip: string | null; user_agent: string | null }>`
      select source_ip, user_agent from audit_events where action = 'test.no_source'`.execute(t.admin);
    expect(r.rows[0]).toEqual({ source_ip: null, user_agent: null });
  });
});

describe("audit.listEvents — lọc, keyset, RLS tổ chức", () => {
  const seeded: string[] = [];
  const base = Date.parse("2026-09-01T00:00:00Z");
  beforeAll(async () => {
    // 30 sự kiện ở A (3 người × 2 hành động × thời điểm khác nhau, có 5 cặp trùng thời điểm để thử ranh trang) + 5 ở B.
    for (let i = 0; i < 30; i++) {
      const id = randomUUID();
      seeded.push(id);
      const who = [owner.personId, manager.personId, frontDesk.personId][i % 3];
      const at = new Date(base + Math.floor(i / 2) * 60_000).toISOString();
      await sql`insert into audit_events (id, organization_id, occurred_at, actor_type, actor_person_id, action, entity_type,
                                          entity_id, correlation_id)
                values (${id}, ${A.orgId}, ${at}, 'user', ${who}, ${i % 2 ? "member.invited" : "property.updated"},
                        ${i % 2 ? "invitation" : "property"}, ${randomUUID()}, 'nk-seed')`.execute(t.admin);
    }
    for (let i = 0; i < 5; i++)
      await sql`insert into audit_events (id, organization_id, occurred_at, actor_type, actor_person_id, action, entity_type, correlation_id)
                values (${randomUUID()}, ${B.orgId}, ${new Date(base + i * 60_000).toISOString()}, 'user', ${B.ownerPersonId},
                        'member.invited', 'invitation', 'nk-seed')`.execute(t.admin);
  });
  const window = { from: new Date(base), to: new Date(base + 3_600_000) };

  it("keyset: đi hết bằng trang 7 ⇒ đủ 30, không trùng, đúng thứ tự giảm dần (occurred_at, id)", async () => {
    const got: { id: string; at: number }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await listEvents(t.runtime, owner, { ...window, limit: 7, ...(cursor ? { cursor } : {}) });
      got.push(...r.items.map((e) => ({ id: e.id, at: e.occurredAt.getTime() })));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(got.map((g) => g.id).sort()).toEqual([...seeded].sort());
    for (let i = 1; i < got.length; i++)
      expect((got[i - 1] as { at: number }).at).toBeGreaterThanOrEqual((got[i] as { at: number }).at);
  });

  it("lọc người / hành động / loại đối tượng / thời gian; kết hợp nhiều bộ lọc", async () => {
    const n = async (f: Parameters<typeof listEvents>[2]) =>
      (await listEvents(t.runtime, owner, { ...window, limit: 200, ...f })).items.length;
    expect(await n({ actorPersonId: manager.personId })).toBe(10);
    expect(await n({ action: "member.invited" })).toBe(15);
    expect(await n({ entityType: "property" })).toBe(15);
    expect(await n({ action: "member.invited", actorPersonId: owner.personId })).toBe(5);
    expect(await n({ from: new Date(base + 10 * 60_000), to: new Date(base + 12 * 60_000) })).toBe(4);
    expect(await n({ actorType: "platform_support" })).toBe(0);
    await expect(listEvents(t.runtime, owner, { actorType: "khac" })).rejects.toMatchObject({ status: 422 });
    await expect(listEvents(t.runtime, owner, { cursor: "rac" })).rejects.toMatchObject({ status: 422 });
  });

  it("RLS tổ chức: owner/manager A không thấy sự kiện của B; owner B chỉ thấy 5 của B", async () => {
    for (const a of [owner, manager]) {
      const r = await listEvents(t.runtime, a, { ...window, limit: 200 });
      expect(r.items.every((e) => seeded.includes(e.id))).toBe(true);
    }
    const ownerB = await resolveActor(t.runtime, {
      authUserId: B.ownerAuthUserId,
      orgId: B.orgId,
      twoFactorEnabled: true,
    });
    const rb = await listEvents(t.runtime, ownerB, { ...window, limit: 200 });
    expect(rb.items).toHaveLength(5);
    expect(rb.items.some((e) => seeded.includes(e.id))).toBe(false);
  });

  it("phân quyền: lễ tân/buồng phòng bị 403 (vai không có audit.read)", async () => {
    for (const a of [frontDesk, housekeeping])
      await expect(listEvents(t.runtime, a, window)).rejects.toMatchObject({ status: 403 });
  });
});
