// SPEC-access-and-property S-018 (không tự nâng quyền + audit lần bị từ chối), S-019 (owner cuối cùng), S-022 (audit + outbox
// cùng transaction) cho member.updateRole / member.updateScope — gọi qua HTTP thật trên Postgres thật.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpDeps, handleCommand } from "../http/command-route.ts";
import { COMMANDS } from "../http/registry.ts";
import { createLogger } from "../logging/logger.ts";
import { setAppLogger } from "../logging/runtime.ts";
import { CommandError } from "../pipeline/index.ts";
import { testServices } from "../server/services.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { assertLogRecords } from "../testing/log-schema.ts";
import { resolveActor } from "./actor.ts";
import { updateMemberRole } from "./members.ts";

let t: TestDb;
let deps: HttpDeps;
let A: SeededOrg;
let P2: string;

beforeAll(async () => {
  t = await createTestDb();
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
  A = await seedOrg(t.admin, "Khách sạn đổi vai");
  P2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${P2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
    t.admin,
  );
});
afterAll(async () => {
  await t?.drop();
});

async function call(name: string, user: string, body: unknown, org = A.orgId, key = randomUUID()) {
  const res = await handleCommand(
    COMMANDS[name] as never,
    new Request("http://local.test/api/v1/x/y", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-test-user": user,
        "x-org-id": org,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown> },
  };
}
const role = (u: string, m: string, body: Record<string, unknown> = {}) =>
  call("member.updateRole", u, { membership_id: m, reason: "Điều chỉnh nhân sự", ...body });
const scope = (u: string, m: string, body: Record<string, unknown>) =>
  call("member.updateScope", u, { membership_id: m, reason: "Điều chỉnh phạm vi", ...body });

const state = async (membership: string) => {
  const m = await sql<{
    role: string;
    all_properties: boolean;
  }>`select role, all_properties from memberships where id = ${membership}`.execute(t.admin);
  const s = await sql<{
    property_id: string;
  }>`select property_id from property_scopes where membership_id = ${membership} order by property_id`.execute(
    t.admin,
  );
  return { ...m.rows[0], property_ids: s.rows.map((r) => r.property_id) };
};
const audits = async (action: string, entity?: string) =>
  (
    await sql<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string;
      outcome: string;
      correlation_id: string;
      command_id: string;
    }>`
      select before, after, reason, outcome, correlation_id, command_id from audit_events
      where organization_id = ${A.orgId} and action = ${action} ${entity ? sql`and entity_id = ${entity}` : sql``} order by occurred_at`.execute(
      t.admin,
    )
  ).rows;
const outbox = async (type: string, aggregate: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from outbox where organization_id = ${A.orgId} and event_type = ${type} and aggregate_id = ${aggregate}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? 0;

describe("SPEC-access S-018: không tự nâng quyền", () => {
  it("S-018 manager M phạm vi [P1]: tự đổi vai thành owner / mở rộng phạm vi sang P2 / đổi người khác → 403 FORBIDDEN, không thay đổi gì, audit ghi lần thử bị từ chối", async () => {
    const m = await seedMember(t, A, "manager", { name: "Quản lý M" });
    const fd = await seedMember(t, A, "front_desk", { name: "Lễ tân L" });
    const before = { m: await state(m.membershipId), fd: await state(fd.membershipId) };

    const self = await role(m.authUserId, m.membershipId, { role: "owner" });
    expect([self.status, self.body.code]).toEqual([403, "FORBIDDEN"]);
    const widen = await scope(m.authUserId, m.membershipId, { property_ids: [A.propertyId, P2] });
    expect([widen.status, widen.body.code]).toEqual([403, "FORBIDDEN"]);
    const other = await role(m.authUserId, fd.membershipId, { role: "manager" });
    expect([other.status, other.body.code]).toEqual([403, "FORBIDDEN"]);
    expect({ m: await state(m.membershipId), fd: await state(fd.membershipId) }).toEqual(before);

    const denied = await sql<{
      action: string;
      entity_id: string;
      after: Record<string, unknown>;
      actor_person_id: string;
    }>`
      select action, entity_id, after, actor_person_id from audit_events
      where organization_id = ${A.orgId} and actor_person_id = ${m.personId}
        and action in ('member.role_change_denied', 'member.scope_change_denied') order by action, entity_id`.execute(
      t.admin,
    );
    expect(denied.rows.map((r) => [r.action, r.entity_id, r.after])).toEqual(
      expect.arrayContaining([
        ["member.role_change_denied", m.membershipId, { requested_role: "owner" }],
        [
          "member.scope_change_denied",
          m.membershipId,
          { property_ids: [A.propertyId, P2], all_properties: false },
        ],
        ["member.role_change_denied", fd.membershipId, { requested_role: "manager" }],
      ]),
    );
    // audit chung của pipeline cho mỗi lần bị từ chối (outcome = denied)
    const generic = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where organization_id = ${A.orgId} and actor_person_id = ${m.personId}
        and action = 'command.denied' and outcome = 'denied' and entity_type in ('member.updateRole', 'member.updateScope')`.execute(
      t.admin,
    );
    expect(generic.rows[0]?.n).toBe(3);
  });

  it("mọi vai trò khác owner đều bị 403 (kế toán, lễ tân, buồng phòng, kỹ thuật)", async () => {
    const target = await seedMember(t, A, "housekeeping");
    for (const r of ["accountant", "front_desk", "housekeeping", "maintenance"]) {
      const u = await seedMember(t, A, r);
      expect((await role(u.authUserId, target.membershipId, { role: "manager" })).status, r).toBe(403);
      expect((await scope(u.authUserId, target.membershipId, { property_ids: [P2] })).status, r).toBe(403);
    }
    expect((await state(target.membershipId)).role).toBe("housekeeping");
  });

  it("người ngoài tổ chức → 404 (không lộ); thành viên tổ chức khác chỉ thấy 404 với id của tổ chức mình", async () => {
    const B = await seedOrg(t.admin, "Tổ chức B");
    const x = await role(B.ownerAuthUserId, A.ownerMembershipId, { role: "owner" });
    expect(x.status).toBe(404);
    const y = await role(B.ownerAuthUserId, A.ownerMembershipId, { role: "owner" }, B.orgId);
    expect(y.status).toBe(404); // membership của A không thấy được từ B
  });
});

describe("member.updateRole — owner đổi vai/phạm vi hợp lệ + S-022", () => {
  it("S-022 owner đổi front_desk → manager: đúng 1 audit (trước/sau, lý do, correlation_id) + 1 outbox; quyền mới có hiệu lực ở request kế tiếp", async () => {
    const fd = await seedMember(t, A, "front_desk", { name: "Lễ tân L2" });
    const r = await role(A.ownerAuthUserId, fd.membershipId, { role: "manager", reason: "Thăng chức" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ role: "manager", changed: true });
    const a = await audits("member.role_changed", fd.membershipId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      before: { role: "front_desk", all_properties: false, property_ids: [A.propertyId] },
      after: { role: "manager", all_properties: false, property_ids: [A.propertyId] },
      reason: "Thăng chức",
      outcome: "success",
    });
    expect(a[0]?.correlation_id.length).toBeGreaterThan(5);
    expect(await outbox("member.role_changed", fd.membershipId)).toBe(1);
    const actor = await resolveActor(t.runtime, {
      authUserId: fd.authUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(actor.role).toBe("manager");
    // Cùng Idempotency-Key gửi lại: không audit/outbox thứ hai.
    const key = randomUUID();
    const g = await seedMember(t, A, "housekeeping");
    await role(A.ownerAuthUserId, g.membershipId, { role: "maintenance" }, A.orgId, key);
    await role(A.ownerAuthUserId, g.membershipId, { role: "maintenance" }, A.orgId, key);
    expect(await outbox("member.role_changed", g.membershipId)).toBe(1);
  });

  it("S-022 lỗi sau khi ghi memberships (tiêm lỗi) → vai trò không đổi, không audit, không outbox", async () => {
    const fd = await seedMember(t, A, "front_desk");
    const owner = await ownerOf(t, A);
    const r = await runAs(
      t,
      owner,
      async (ctx) => {
        await updateMemberRole(ctx, { membershipId: fd.membershipId, role: "manager", reason: "Thử" });
        throw new CommandError("VALIDATION_FAILED", 422, "Lỗi tiêm");
      },
      { command: "member.updateRole" },
    );
    expect(r.status).toBe("failed");
    expect((await state(fd.membershipId)).role).toBe("front_desk");
    expect(await audits("member.role_changed", fd.membershipId)).toHaveLength(0);
    expect(await outbox("member.role_changed", fd.membershipId)).toBe(0);
  });

  it("ca biên phạm vi: owner→manager cần danh sách cơ sở (422); manager→accountant giữ cơ sở; accountant→owner = mọi cơ sở; cùng vai trò = không đổi (changed=false, không audit)", async () => {
    const acc = await seedMember(t, A, "accountant", { properties: "all" });
    const noScope = await role(A.ownerAuthUserId, acc.membershipId, { role: "front_desk" });
    expect([noScope.status, JSON.stringify(noScope.body.errors)]).toEqual([
      422,
      expect.stringContaining("property_ids"),
    ]);
    expect((await state(acc.membershipId)).role).toBe("accountant");
    const fd = await role(A.ownerAuthUserId, acc.membershipId, { role: "front_desk", property_ids: [P2] });
    expect(fd.status).toBe(200);
    expect(await state(acc.membershipId)).toEqual({
      role: "front_desk",
      all_properties: false,
      property_ids: [P2],
    });
    const back = await role(A.ownerAuthUserId, acc.membershipId, { role: "accountant" });
    expect(back.status).toBe(200);
    expect(await state(acc.membershipId)).toEqual({
      role: "accountant",
      all_properties: false,
      property_ids: [P2],
    }); // giữ phạm vi đã thu hẹp
    const noop = await role(A.ownerAuthUserId, acc.membershipId, { role: "accountant" });
    expect(noop.body.data).toMatchObject({ changed: false });
    expect(await audits("member.role_changed", acc.membershipId)).toHaveLength(2);
    const own = await role(A.ownerAuthUserId, acc.membershipId, { role: "owner" });
    expect(own.status).toBe(200);
    expect(await state(acc.membershipId)).toEqual({ role: "owner", all_properties: true, property_ids: [] });
    const bad = await role(A.ownerAuthUserId, acc.membershipId, {
      role: "manager",
      property_ids: [randomUUID()],
    });
    expect(bad.status).toBe(404);
  });

  it("đích không đổi được: đã thu hồi/không tồn tại → 404; người thuê → 409; thiếu/quá dài lý do → 422", async () => {
    const gone = await seedMember(t, A, "front_desk");
    await sql`update memberships set status = 'revoked', revoked_at = now() where id = ${gone.membershipId}`.execute(
      t.admin,
    );
    expect((await role(A.ownerAuthUserId, gone.membershipId, { role: "manager" })).status).toBe(404);
    expect((await role(A.ownerAuthUserId, randomUUID(), { role: "manager" })).status).toBe(404);
    const tenant = await seedMember(t, A, "tenant");
    expect((await role(A.ownerAuthUserId, tenant.membershipId, { role: "manager" })).status).toBe(409);
    const fd = await seedMember(t, A, "front_desk");
    expect((await role(A.ownerAuthUserId, fd.membershipId, { role: "manager", reason: "   " })).status).toBe(
      422,
    );
    expect(
      (await role(A.ownerAuthUserId, fd.membershipId, { role: "manager", reason: "x".repeat(501) })).status,
    ).toBe(422);
    expect((await role(A.ownerAuthUserId, fd.membershipId, { role: "platform_support" })).status).toBe(422);
    expect((await state(fd.membershipId)).role).toBe("front_desk");
  });
});

describe("SPEC-access S-019: owner cuối cùng không tự hạ quyền", () => {
  it("S-019 owner duy nhất tự hạ vai trò → 409 LAST_OWNER, membership giữ nguyên; có owner thứ hai thì hạ được", async () => {
    const B = await seedOrg(t.admin, "Chỉ một owner");
    const own = await call(
      "member.updateRole",
      B.ownerAuthUserId,
      { membership_id: B.ownerMembershipId, role: "manager", property_ids: [B.propertyId], reason: "Tự hạ" },
      B.orgId,
    );
    expect([own.status, own.body.code]).toEqual([409, "LAST_OWNER"]);
    expect(
      (
        await sql<{ role: string }>`select role from memberships where id = ${B.ownerMembershipId}`.execute(
          t.admin,
        )
      ).rows[0]?.role,
    ).toBe("owner");
    const second = await seedMember(t, B, "front_desk");
    expect(
      (
        await call(
          "member.updateRole",
          B.ownerAuthUserId,
          { membership_id: second.membershipId, role: "owner", reason: "Thêm owner" },
          B.orgId,
        )
      ).status,
    ).toBe(200);
    const down = await call(
      "member.updateRole",
      B.ownerAuthUserId,
      { membership_id: B.ownerMembershipId, role: "manager", property_ids: [B.propertyId], reason: "Tự hạ" },
      B.orgId,
    );
    expect(down.status).toBe(200);
  });

  it("hai owner hạ nhau song song (cả hai đã xác thực là owner trước khi lệnh chạy) → đúng một thành công, lệnh còn lại 409 LAST_OWNER; tổ chức còn một owner", async () => {
    const B = await seedOrg(t.admin, "Hai owner");
    const o2 = await seedMember(t, B, "front_desk");
    await call(
      "member.updateRole",
      B.ownerAuthUserId,
      { membership_id: o2.membershipId, role: "owner", reason: "Thêm" },
      B.orgId,
    );
    const actor1 = await ownerOf(t, B);
    const actor2 = await resolveActor(t.runtime, {
      authUserId: o2.authUserId,
      orgId: B.orgId,
      twoFactorEnabled: true,
    });
    expect(actor2.role).toBe("owner");
    const demote = (actor: typeof actor1, target: string) =>
      runAs(
        t,
        actor,
        (ctx) =>
          updateMemberRole(ctx, {
            membershipId: target,
            role: "manager",
            propertyIds: [B.propertyId],
            reason: "Hạ",
          }),
        {
          command: "member.updateRole",
        },
      );
    const [x, y] = await Promise.all([demote(actor1, o2.membershipId), demote(actor2, B.ownerMembershipId)]);
    expect([x.status, y.status].sort()).toEqual(["committed", "failed"]);
    const failed = x.status === "failed" ? x : y;
    expect(failed.status === "failed" && failed.problem.code).toBe("LAST_OWNER");
    const owners = await sql<{
      n: number;
    }>`select count(*)::int as n from memberships where organization_id = ${B.orgId} and role = 'owner' and status = 'active'`.execute(
      t.admin,
    );
    expect(owners.rows[0]?.n).toBe(1);
  });
});

describe("member.updateScope", () => {
  it("owner thu hẹp/mở rộng phạm vi: một audit + một outbox + trước/sau; mọi cơ sở chỉ cho kế toán; cùng phạm vi = không đổi", async () => {
    const fd = await seedMember(t, A, "front_desk");
    const r = await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [A.propertyId, P2] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await state(fd.membershipId)).property_ids.sort()).toEqual([A.propertyId, P2].sort());
    const a = await audits("member.scope_changed", fd.membershipId);
    expect(a).toHaveLength(1);
    expect(a[0]?.before).toEqual({ all_properties: false, property_ids: [A.propertyId] });
    expect(a[0]?.reason).toBe("Điều chỉnh phạm vi");
    expect(await outbox("member.scope_changed", fd.membershipId)).toBe(1);
    const narrow = await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [P2] });
    expect(narrow.status).toBe(200);
    expect((await state(fd.membershipId)).property_ids).toEqual([P2]);
    // actor của lễ tân chỉ thấy P2 từ request kế tiếp
    const actor = await resolveActor(t.runtime, {
      authUserId: fd.authUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(actor.propertyIds).toEqual([P2]);
    expect((await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [P2] })).body.data).toMatchObject(
      { changed: false },
    );
    expect(
      (await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [], all_properties: true })).status,
    ).toBe(422);
    expect((await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [] })).status).toBe(422);
    const acc = await seedMember(t, A, "accountant", { properties: [A.propertyId] });
    expect(
      (await scope(A.ownerAuthUserId, acc.membershipId, { property_ids: [], all_properties: true })).status,
    ).toBe(200);
    expect(await state(acc.membershipId)).toEqual({
      role: "accountant",
      all_properties: true,
      property_ids: [],
    });
    expect(
      (
        await scope(A.ownerAuthUserId, acc.membershipId, {
          property_ids: [A.propertyId],
          all_properties: true,
        })
      ).status,
    ).toBe(422);
  });

  it("owner luôn mọi cơ sở (422); cơ sở lạ/tổ chức khác → 404; thành viên khác tổ chức → 404", async () => {
    const other = await seedOrg(t.admin, "Tổ chức khác");
    expect(
      (await scope(A.ownerAuthUserId, A.ownerMembershipId, { property_ids: [A.propertyId] })).status,
    ).toBe(422);
    const fd = await seedMember(t, A, "front_desk");
    expect(
      (await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [other.propertyId] })).status,
    ).toBe(404);
    expect(
      (await scope(A.ownerAuthUserId, other.ownerMembershipId, { property_ids: [A.propertyId] })).status,
    ).toBe(404);
    expect((await state(fd.membershipId)).property_ids).toEqual([A.propertyId]);
  });
});

describe("sự kiện bảo mật đổi vai/quyền (SEC-LOG-001)", () => {
  it("member.role_changed và member.scope_changed chỉ khi thay đổi thật (sau commit); lần bị từ chối ⇒ authz.denied", async () => {
    const lines: string[] = [];
    setAppLogger(
      createLogger({
        sink: { write: (l) => lines.push(l) },
        service: "hm-test",
        version: "0.0.0",
        env: "test",
      }),
    );
    try {
      const fd = await seedMember(t, A, "front_desk");
      const mgr = await seedMember(t, A, "manager");
      await role(A.ownerAuthUserId, fd.membershipId, { role: "manager" });
      await role(A.ownerAuthUserId, fd.membershipId, { role: "manager" }); // không đổi ⇒ không phát
      await scope(A.ownerAuthUserId, fd.membershipId, { property_ids: [A.propertyId, P2] });
      await role(mgr.authUserId, fd.membershipId, { role: "owner" }); // bị từ chối
      assertLogRecords(lines);
      const events = lines.map(
        (l) => JSON.parse(l) as { event: string; target: { id: string | null } | null; outcome: string },
      );
      const names = events.map((e) => `${e.event}:${e.outcome}`);
      expect(names.filter((n) => n === "member.role_changed:success")).toHaveLength(1);
      expect(names.filter((n) => n === "member.scope_changed:success")).toHaveLength(1);
      expect(names.filter((n) => n === "authz.denied:denied")).toHaveLength(1);
      expect(events.find((e) => e.event === "member.role_changed")?.target?.id).toBe(fd.membershipId);
    } finally {
      setAppLogger(undefined);
    }
  });
});
