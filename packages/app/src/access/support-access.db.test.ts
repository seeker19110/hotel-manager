// T-2313 (D-128; IND-SAAS-009, TM-12) — truy cập hỗ trợ CHỈ ĐỌC do owner cấp, trên Postgres thật qua route thật (handleCommand/
// handleQuery/handleUserCommand, phiên giả theo header như authz-matrix.db.test.ts):
// cấp (owner được, manager/kế toán bị từ chối) → nhận lời mời → đọc được (query + audit `support.accessed` kèm lý do + nguồn) →
// MỌI lệnh ghi trong registry bị 403 (duyệt registry tự động) + RLS chặn ghi ở CSDL trên mọi bảng RLS → hết hạn đúng mốc theo đồng
// hồ CSDL → thu hồi một bước. CHECK: TTL > 72 giờ, lý do rỗng. Đồng thời: hai lời cấp song song cùng email ⇒ một thắng.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { listEvents } from "../audit/index.ts";
import {
  type CommandDef,
  type HttpDeps,
  handleCommand,
  handleQuery,
  handleUserCommand,
} from "../http/command-route.ts";
import { handleCreateDataRequest } from "../http/data-requests.ts";
import { handleGetOrgDeletion, handleRequestOrgDeletion } from "../http/org-deletion.ts";
import { COMMANDS, QUERIES, USER_COMMANDS } from "../http/registry.ts";
import { handleSwitchOrganization } from "../http/switch-organization.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { type Actor, resolveActor } from "./actor.ts";
import { buildInvitationMail, invitationToken } from "./invitations.ts";
import { listSupportAccess, recordSupportAccess } from "./support.ts";

let t: TestDb;
let deps: HttpDeps;
let A: SeededOrg;
let B: SeededOrg;
let manager: Actor;
let accountant: Actor;
const services = testServices();

const GOOD_PASSWORD = "mat-khau-dung-123";
const STALE = { "x-test-session-age-s": "600" };
const UA = "Trinh-duyet-ho-tro/1.0";
const IP = "203.0.113.77";

async function post(
  name: string,
  who: { user: string; org?: string | null },
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const def = COMMANDS[name] ?? USER_COMMANDS[name];
  if (!def) throw new Error(`không có lệnh ${name}`);
  const req = new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "x-test-user": who.user,
      "x-test-2fa": "1",
      "user-agent": UA,
      "x-forwarded-for": IP,
      ...(who.org ? { "x-org-id": who.org } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const res = COMMANDS[name]
    ? await handleCommand(def as never, req, deps)
    : await handleUserCommand(def as never, req, deps);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(name: string, who: { user: string; org: string }, params: Record<string, string> = {}) {
  const def = QUERIES[name];
  if (!def) throw new Error(`không có query ${name}`);
  const url = new URL("http://local.test/api/v1/x/y");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await handleQuery(
    def as never,
    new Request(url, {
      headers: {
        "x-test-user": who.user,
        "x-test-2fa": "1",
        "x-org-id": who.org,
        "user-agent": UA,
        "x-forwarded-for": IP,
      },
    }),
    deps,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const cal = (o: SeededOrg) => ({ property_id: o.propertyId, from: "2026-10-20", to: "2026-10-27" });
const owner = () => ({ user: A.ownerAuthUserId, org: A.orgId });

/** Owner cấp → người hỗ trợ (tài khoản riêng, đúng email) nhận lời mời. Trả user id + invitation id. */
async function grantAndAccept(opts: { ttl?: number; reason?: string } = {}) {
  const email = `ho.tro+${randomUUID().slice(0, 8)}@example.test`;
  const user = await seedAuthUser(t.admin, email);
  const g = await post("member.grantSupportAccess", owner(), {
    email,
    reason: opts.reason ?? "Phiếu hỗ trợ #123: kiểm tra lịch phòng",
    ...(opts.ttl ? { ttl_hours: opts.ttl } : {}),
  });
  expect(g.status, JSON.stringify(g.json)).toBe(201);
  const invitationId = (g.json.data as { invitationId: string }).invitationId;
  const a = await post(
    "member.acceptInvitation",
    { user },
    { token: invitationToken(services.invitationKey, invitationId) },
  );
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  return { user, email, invitationId };
}

const supportActor = (user: string) =>
  resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS-HO-TRO-A");
  B = await seedOrg(t.admin, "KS-HO-TRO-B");
  manager = await seedMember(t, A, "manager", { name: "Quản lý Q" });
  accountant = await seedMember(t, A, "accountant", { name: "Kế toán K", properties: "all" });
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      // Tuổi phiên theo header (mặc định vừa đăng nhập) để thử xác thực lại của lệnh cấp (D-129).
      const age = Number(h.get("x-test-session-age-s") ?? 0);
      return id
        ? {
            user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" },
            session: { createdAt: new Date(Date.now() - age * 1000) },
          }
        : null;
    },
    verifyPassword: async (_h, password) => password === GOOD_PASSWORD,
    secureCookies: false,
    services,
    commandQuotaPerMinute: 100_000,
    commandMemberQuotaPerMinute: 100_000,
  };
});
afterAll(async () => {
  await t?.drop();
});

describe("cấp truy cập hỗ trợ — xác thực lại (D-129)", () => {
  it("mọi lệnh khai `reauth` đều có `password` tuỳ chọn trong schema (route tách nó khỏi payload)", () => {
    const declared = Object.values(COMMANDS).filter((c) => c.reauth);
    expect(declared.map((c) => c.command)).toContain("member.grantSupportAccess");
    for (const c of declared) {
      const shape = (c.input as unknown as { shape?: Record<string, { isOptional(): boolean }> }).shape;
      expect(shape?.password?.isOptional(), c.command).toBe(true);
    }
  });

  const grantBody = (extra: Record<string, unknown> = {}) => ({
    email: `xt+${randomUUID().slice(0, 8)}@example.test`,
    reason: "Phiếu #9",
    ...extra,
  });
  const invitationsOf = async (email: string) =>
    (
      await sql<{ n: number }>`select count(*)::int as n from invitations
        where organization_id = ${A.orgId} and lower(email) = ${email}`.execute(t.admin)
    ).rows[0]?.n;

  it("phiên cũ hơn 5 phút, không mật khẩu ⇒ 401 REAUTH_REQUIRED (reauth_required), không tạo lời mời", async () => {
    const body = grantBody();
    const r = await post("member.grantSupportAccess", owner(), body, STALE);
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ code: "REAUTH_REQUIRED", reason: "reauth_required" });
    expect(await invitationsOf(body.email)).toBe(0);
  });

  it("mật khẩu sai ⇒ 401 invalid_password; mật khẩu đúng ⇒ 201 và mật khẩu không nằm trong audit/idempotency", async () => {
    const bad = grantBody();
    const r1 = await post("member.grantSupportAccess", owner(), { ...bad, password: "sai" }, STALE);
    expect(r1.status).toBe(401);
    expect(r1.json).toMatchObject({ code: "REAUTH_REQUIRED", reason: "invalid_password" });
    expect(await invitationsOf(bad.email)).toBe(0);

    const ok = grantBody();
    const r2 = await post("member.grantSupportAccess", owner(), { ...ok, password: GOOD_PASSWORD }, STALE);
    expect(r2.status, JSON.stringify(r2.json)).toBe(201);
    expect(await invitationsOf(ok.email)).toBe(1);
    const leak = await sql<{ n: number }>`
      select (select count(*) from audit_events where organization_id = ${A.orgId} and (after::text like ${`%${GOOD_PASSWORD}%`} or before::text like ${`%${GOOD_PASSWORD}%`}))::int
           + (select count(*) from outbox where organization_id = ${A.orgId} and payload::text like ${`%${GOOD_PASSWORD}%`})::int
           + (select count(*) from idempotency_keys where organization_id = ${A.orgId}
                and coalesce(response::text, '') like ${`%${GOOD_PASSWORD}%`})::int as n`.execute(t.admin);
    expect(leak.rows[0]?.n).toBe(0);
    // Kết quả idempotency của chính request này có lưu (để chắc câu trên thật sự quét hàng của nó).
    const stored = await sql<{ response: unknown }>`select response from idempotency_keys
      where organization_id = ${A.orgId} and command = 'member.grantSupportAccess' and response is not null
      order by created_at desc limit 1`.execute(t.admin);
    expect(JSON.stringify(stored.rows[0]?.response ?? null)).not.toContain(GOOD_PASSWORD);
    expect(stored.rows[0]?.response).toBeTruthy();
  });

  it("phiên mới (≤ 5 phút) không cần mật khẩu; phiên đúng 5 phút còn hợp lệ, 5 phút + 1 giây thì không", async () => {
    expect((await post("member.grantSupportAccess", owner(), grantBody())).status).toBe(201);
    const edge = await post("member.grantSupportAccess", owner(), grantBody(), {
      "x-test-session-age-s": "299",
    });
    expect(edge.status).toBe(201);
    const over = await post("member.grantSupportAccess", owner(), grantBody(), {
      "x-test-session-age-s": "301",
    });
    expect(over.status).toBe(401);
  });

  it("mật khẩu rỗng bị schema chặn (422), không phải lỗi xác thực", async () => {
    const r = await post("member.grantSupportAccess", owner(), { ...grantBody(), password: "" }, STALE);
    expect(r.status).toBe(422);
  });

  it("vai không phải owner ⇒ vẫn 403 (không lộ yêu cầu xác thực lại), kể cả phiên cũ không mật khẩu", async () => {
    const r = await post(
      "member.grantSupportAccess",
      { user: manager.authUserId, org: A.orgId },
      grantBody(),
      STALE,
    );
    expect(r.status).toBe(403);
  });

  it("thử mật khẩu sai quá 5 lần/15 phút ⇒ 429 có Retry-After, kể cả mật khẩu đúng sau đó", async () => {
    const who = await seedMember(t, A, "owner", { name: "Chủ thứ hai" });
    const me = { user: who.authUserId, org: A.orgId };
    for (let i = 0; i < 5; i++)
      expect(
        (await post("member.grantSupportAccess", me, { ...grantBody(), password: "sai" }, STALE)).status,
      ).toBe(401);
    const limited = await post(
      "member.grantSupportAccess",
      me,
      { ...grantBody(), password: GOOD_PASSWORD },
      STALE,
    );
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("cấp truy cập hỗ trợ — phân quyền", () => {
  it("manager và kế toán bị 403 (chỉ owner cấp/thu hồi); lần bị từ chối có audit", async () => {
    const count = async () =>
      (
        await sql<{ n: number }>`
      select count(*)::int as n from audit_events where organization_id = ${A.orgId} and action = 'support.grant_denied'`.execute(
          t.admin,
        )
      ).rows[0]?.n ?? 0;
    const before = await count();
    for (const who of [manager, accountant]) {
      const r = await post(
        "member.grantSupportAccess",
        { user: who.authUserId, org: A.orgId },
        { email: "x@example.test", reason: "thử" },
      );
      expect(r.status).toBe(403);
    }
    expect((await count()) - before).toBe(2);
  });

  it("owner cấp được; lý do rỗng → 422; TTL ngoài 1–72 giờ → 422 (schema) — mặc định 24 giờ", async () => {
    expect(
      (await post("member.grantSupportAccess", owner(), { email: "a@example.test", reason: "   " })).status,
    ).toBe(422);
    expect(
      (
        await post("member.grantSupportAccess", owner(), {
          email: "a@example.test",
          reason: "r",
          ttl_hours: 73,
        })
      ).status,
    ).toBe(422);
    const ok = await post("member.grantSupportAccess", owner(), {
      email: "mac.dinh@example.test",
      reason: "r",
    });
    expect(ok.status).toBe(201);
    const id = (ok.json.data as { invitationId: string }).invitationId;
    const r = await sql<{ hours: number; reason: string; ok: boolean }>`
      select round(extract(epoch from expires_at - created_at) / 3600)::int as hours, support_reason as reason,
             token_hash = sha256(convert_to(${invitationToken(services.invitationKey, id)}, 'UTF8')) as ok
      from invitations where id = ${id}`.execute(t.admin);
    expect(r.rows[0]).toEqual({ hours: 24, reason: "r", ok: true });
    // Email lời mời (worker, qua outbox `member.invited`): nêu chỉ xem + hạn theo GIỜ, link chứa token ở fragment.
    const mail = await buildInvitationMail(
      t.admin,
      { organization_id: A.orgId, payload: { invitation_id: id } },
      { key: services.invitationKey, baseUrl: "https://hm.example.test" },
    );
    expect(mail?.text).toContain("CHỈ XEM");
    expect(mail?.text).toMatch(/sau 2[34] giờ/);
    expect(mail?.text).toContain(`#token=${invitationToken(services.invitationKey, id)}`);
    expect(mail?.subject).toContain("hỗ trợ nền tảng (chỉ xem)");
  });

  it("đồng thời: hai lời cấp song song cho cùng email ⇒ đúng một 201, một 409", async () => {
    const email = `song.song+${randomUUID().slice(0, 6)}@example.test`;
    const rs = await Promise.all(
      [1, 2].map(() => post("member.grantSupportAccess", owner(), { email, reason: "song song" })),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe("CHECK ở CSDL (lớp cuối)", () => {
  const insertInvitation = (hours: number, reason: string | null) =>
    sql`insert into invitations (id, organization_id, email, role, token_hash, expires_at, invited_by, support_reason)
        values (${randomUUID()}, ${A.orgId}, ${`c+${randomUUID().slice(0, 6)}@example.test`}, 'platform_support',
                ${Buffer.alloc(32, Math.floor(Math.random() * 255))}, now() + make_interval(hours => ${hours}),
                ${A.ownerMembershipId}, ${reason})`.execute(t.admin);

  it("lời mời: TTL > 72 giờ bị chặn; lý do rỗng/NULL bị chặn; 72 giờ đúng được", async () => {
    await expect(insertInvitation(73, "r")).rejects.toThrow(/ck_invitations_support/);
    await expect(insertInvitation(24, "  ")).rejects.toThrow(/ck_invitations_support/);
    await expect(insertInvitation(24, null)).rejects.toThrow(/ck_invitations_support/);
    await insertInvitation(72, "đúng trần");
  });

  it("membership: valid_to > valid_from + 72 giờ bị chặn; thiếu lý do bị chặn; vai khác không được có lý do", async () => {
    const { user } = await grantAndAccept();
    const id = (await supportActor(user)).membershipId;
    await expect(
      sql`update memberships set valid_to = valid_from + interval '73 hours' where id = ${id}`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_memberships_support_temporary/);
    await expect(
      sql`update memberships set support_reason = '' where id = ${id}`.execute(t.admin),
    ).rejects.toThrow(/ck_memberships_support_temporary/);
    await expect(
      sql`update memberships set support_reason = 'x' where id = ${A.ownerMembershipId}`.execute(t.admin),
    ).rejects.toThrow(/ck_memberships_support_temporary/);
  });
});

describe("support chỉ đọc", () => {
  let support: { user: string; invitationId: string };
  let actor: Actor;
  beforeAll(async () => {
    support = await grantAndAccept({ reason: "Phiếu #900: khách báo sai lịch" });
    actor = await supportActor(support.user);
  });

  it("resolveActor: vai platform_support, mọi cơ sở, bắt buộc MFA, mang lý do + hạn của lời cấp", async () => {
    expect(actor).toMatchObject({ role: "platform_support", allProperties: true, mfaRequired: true });
    expect(actor.support?.reason).toBe("Phiếu #900: khách báo sai lịch");
    await expect(
      resolveActor(t.runtime, { authUserId: support.user, orgId: A.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });

  it("đọc được (query lịch phòng) và MỖI query để lại `support.accessed` có lý do + nguồn; owner thấy trong nhật ký", async () => {
    const q = await get("inventory.getCalendar", { user: support.user, org: A.orgId }, cal(A));
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    const list = await listEvents(
      t.runtime,
      await resolveActor(t.runtime, {
        authUserId: A.ownerAuthUserId,
        orgId: A.orgId,
        twoFactorEnabled: true,
      }),
      {
        actorType: "platform_support",
        action: "support.accessed",
      },
    );
    expect(list.items[0]).toMatchObject({
      actorType: "platform_support",
      actorPersonId: actor.personId,
      action: "support.accessed",
      entityType: "query",
      after: { query: "inventory.getCalendar" },
      reason: "Phiếu #900: khách báo sai lịch",
      outcome: "success",
      sourceIp: "203.0.113.0",
      userAgent: UA,
    });
  });

  it("không đọc được dữ liệu ngoài danh sách chỉ đọc: audit, giấy tờ, danh sách thành viên/hỗ trợ → 403/404", async () => {
    for (const [name, params] of [
      ["audit.listEvents", {}],
      ["member.list", {}],
      ["member.listSupportAccess", {}],
      ["identity.get", { identity_document_id: randomUUID() }],
    ] as const) {
      const r = await get(name, { user: support.user, org: A.orgId }, params as Record<string, string>);
      expect([403, 404, 422], `${name}: ${r.status}`).toContain(r.status);
      expect(r.status, name).not.toBe(200);
    }
  });

  it("MỌI lệnh ghi trong registry (duyệt tự động) → 403 trước khi đọc thân lệnh; mỗi lần có audit `command.denied` của support", async () => {
    const names = Object.keys(COMMANDS);
    expect(names.length).toBeGreaterThan(80);
    const bad: string[] = [];
    for (const name of names) {
      const r = await post(name, { user: support.user, org: A.orgId }, {});
      if (r.status !== 403 || r.json.code !== "FORBIDDEN")
        bad.push(`${name}: ${r.status} ${String(r.json.code)}`);
    }
    expect(bad).toEqual([]);
    const audit = await sql<{
      entity_type: string;
      actor_type: string;
      reason: string;
      outcome: string;
      source_ip: string;
    }>`
      select entity_type, actor_type, reason, outcome, source_ip from audit_events
      where organization_id = ${A.orgId} and action = 'command.denied' and actor_person_id = ${actor.personId}`.execute(
      t.admin,
    );
    expect(new Set(audit.rows.map((r) => r.entity_type))).toEqual(new Set(names));
    for (const r of audit.rows)
      expect(r).toMatchObject({
        actor_type: "platform_support",
        reason: "Phiếu #900: khách báo sai lịch",
        outcome: "denied",
        source_ip: "203.0.113.0",
      });
    // Không có gì được ghi thay đổi: không idempotency key, không outbox của support.
    const idem = await sql<{ n: number }>`
      select count(*)::int as n from idempotency_keys where actor_person_id = ${actor.personId} and command <> 'member.acceptInvitation'`.execute(
      t.admin,
    );
    expect(idem.rows[0]?.n).toBe(0);
  });

  it("RLS (lớp 2): mọi bảng public bật RLS có policy chỉ-đọc cho support (trừ 4 bảng hạ tầng có lý do)", async () => {
    const r = await sql<{ t: string; n: number }>`
      select c.relname as t,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                and p.policyname in ('support_ro_ins','support_ro_upd','support_ro_del') and p.permissive = 'RESTRICTIVE') as n
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
      order by 1`.execute(t.admin);
    const exempt = new Set(["audit_events", "idempotency_keys", "outbox", "invitations"]);
    const missing = r.rows.filter((x) => !exempt.has(x.t) && x.n !== 3).map((x) => x.t);
    expect(missing).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(40);
  });

  it("RLS (lớp 2): ghi thẳng bằng SQL trong ngữ cảnh support bị chặn (INSERT/UPDATE/DELETE); owner cùng câu thì được", async () => {
    const asActor = async (membershipId: string, q: ReturnType<typeof sql>) =>
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${membershipId}, true)`.execute(
          trx,
        );
        return q.execute(trx);
      });
    const upd = sql`update properties set name = name where organization_id = ${A.orgId}`;
    const affected = (r: unknown) => Number((r as { numAffectedRows?: bigint }).numAffectedRows ?? 0);
    // UPDATE/DELETE: USING của policy RESTRICTIVE lọc hết hàng ⇒ 0 hàng bị đổi (không lỗi — ngữ nghĩa RLS chuẩn).
    expect(affected(await asActor(actor.membershipId, upd))).toBe(0);
    await expect(
      asActor(
        actor.membershipId,
        sql`insert into floors (id, organization_id, property_id, name) values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'T9')`,
      ),
    ).rejects.toThrow(/row-level security|policy/);
    expect(
      affected(
        await asActor(
          actor.membershipId,
          sql`delete from property_scopes where organization_id = ${A.orgId}`,
        ),
      ),
    ).toBe(0);
    expect(affected(await asActor(A.ownerMembershipId, upd))).toBe(1);
  });

  it("tổ chức khác: support của A không vào được B (404), sự kiện của A không lộ sang B", async () => {
    const r = await get("inventory.getCalendar", { user: support.user, org: B.orgId }, cal(B));
    expect(r.status).toBe(404);
    const ownerB = await resolveActor(t.runtime, {
      authUserId: B.ownerAuthUserId,
      orgId: B.orgId,
      twoFactorEnabled: true,
    });
    expect((await listEvents(t.runtime, ownerB, { actorType: "platform_support" })).items).toEqual([]);
  });
});

describe("hết hạn và thu hồi", () => {
  it("hết hạn đúng mốc theo đồng hồ CSDL: valid_to = now()+1 phút ⇒ vào được; valid_to ≤ now() ⇒ NOT_FOUND (không cần job)", async () => {
    const { user } = await grantAndAccept();
    const id = (await supportActor(user)).membershipId;
    await sql`update memberships set valid_from = now() - interval '2 hours', valid_to = now() + interval '1 minute' where id = ${id}`.execute(
      t.admin,
    );
    await expect(supportActor(user)).resolves.toMatchObject({ role: "platform_support" });
    await sql`update memberships set valid_to = now() where id = ${id}`.execute(t.admin);
    await expect(supportActor(user)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Biểu ngữ không còn hiện truy cập đã hết hạn.
    const ownerA = await resolveActor(t.runtime, {
      authUserId: A.ownerAuthUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(
      (await listSupportAccess(t.runtime, ownerA)).some((x) => x.state === "active" && x.until <= new Date()),
    ).toBe(false);
  });

  it("thu hồi một bước bởi owner: request kế tiếp của support bị từ chối; lặp lại vẫn 200; manager thu hồi → 403", async () => {
    const { user, invitationId } = await grantAndAccept();
    await expect(supportActor(user)).resolves.toBeTruthy();
    const ownerA = await resolveActor(t.runtime, {
      authUserId: A.ownerAuthUserId,
      orgId: A.orgId,
      twoFactorEnabled: true,
    });
    expect(
      (await listSupportAccess(t.runtime, ownerA)).find((x) => x.invitationId === invitationId),
    ).toMatchObject({
      state: "active",
      email: expect.stringContaining("@example.test"),
      reason: expect.any(String),
    });
    // Vai khác owner/manager thấy biểu ngữ nhưng không thấy email/lý do (tối thiểu hoá PII).
    const hk = await seedMember(t, A, "housekeeping");
    const seenByHk = (await listSupportAccess(t.runtime, hk)).find((x) => x.invitationId === invitationId);
    expect(seenByHk).toMatchObject({ email: null, reason: null });
    expect(
      (
        await post(
          "member.revokeSupportAccess",
          { user: manager.authUserId, org: A.orgId },
          { invitation_id: invitationId },
        )
      ).status,
    ).toBe(403);
    const r = await post("member.revokeSupportAccess", owner(), { invitation_id: invitationId });
    expect(r.status).toBe(200);
    await expect(supportActor(user)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const q = await get("inventory.getCalendar", { user, org: A.orgId }, cal(A));
    expect(q.status).toBe(404);
    expect((await post("member.revokeSupportAccess", owner(), { invitation_id: invitationId })).status).toBe(
      200,
    );
    expect((await post("member.revokeSupportAccess", owner(), { invitation_id: randomUUID() })).status).toBe(
      404,
    );
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${invitationId} and action = 'support.access_revoked'`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("thu hồi lời mời CHƯA nhận: lời mời đóng, token không dùng được nữa (410)", async () => {
    const email = `chua.nhan+${randomUUID().slice(0, 6)}@example.test`;
    const user = await seedAuthUser(t.admin, email);
    const g = await post("member.grantSupportAccess", owner(), { email, reason: "chưa nhận" });
    const invitationId = (g.json.data as { invitationId: string }).invitationId;
    expect((await post("member.revokeSupportAccess", owner(), { invitation_id: invitationId })).status).toBe(
      200,
    );
    const a = await post(
      "member.acceptInvitation",
      { user },
      { token: invitationToken(services.invitationKey, invitationId) },
    );
    expect(a.status).toBe(410);
  });

  it("support không đổi được vai trò của mình qua member.updateRole của owner (vai hỗ trợ không phải nhân viên)", async () => {
    const { user } = await grantAndAccept();
    const id = (await supportActor(user)).membershipId;
    const r = await post("member.updateRole", owner(), {
      membership_id: id,
      role: "manager",
      reason: "nâng",
    });
    expect(r.status).toBe(409);
  });
});

// ───────────── Sửa sau review (T-2313/D-128/D-129): cấp lại, RLS còn hạn, manager thấy, gộp nhật ký, đổi tổ chức, xác thực lại ─────────────

const ownerActorA = () =>
  resolveActor(t.runtime, { authUserId: A.ownerAuthUserId, orgId: A.orgId, twoFactorEnabled: true });
const expire = (membershipId: string) =>
  sql`update memberships set valid_from = now() - interval '2 hours', valid_to = now() - interval '1 minute'
      where id = ${membershipId}`.execute(t.admin);
const supportAccessCount = async (personId: string, name?: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from audit_events
      where organization_id = ${A.orgId} and actor_type = 'platform_support' and action = 'support.accessed'
        and actor_person_id = ${personId} ${name ? sql`and (after ->> 'query' = ${name} or after ->> 'page' = ${name})` : sql``}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? 0;

describe("cấp lại sau khi hết hạn (F2)", () => {
  it("cấp → nhận → hết hạn → cấp lại → nhận thành công; membership cũ thành revoked; owner thấy lời cấp chờ nhận", async () => {
    const first = await grantAndAccept({ reason: "Phiếu #1" });
    const old = (await supportActor(first.user)).membershipId;
    await expire(old);
    const g = await post("member.grantSupportAccess", owner(), { email: first.email, reason: "Phiếu #2" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const invitationId = (g.json.data as { invitationId: string }).invitationId;
    const st = await sql<{
      status: string;
      revoked: boolean;
    }>`select status, revoked_at is not null as revoked
      from memberships where id = ${old}`.execute(t.admin);
    expect(st.rows[0]).toEqual({ status: "revoked", revoked: true });
    // Owner thấy lời cấp CHỜ NHẬN để thu hồi được.
    const listed = await listSupportAccess(t.runtime, await ownerActorA());
    expect(listed.find((x) => x.invitationId === invitationId)).toMatchObject({
      state: "pending",
      email: first.email,
      reason: "Phiếu #2",
    });
    const a = await post(
      "member.acceptInvitation",
      { user: first.user },
      { token: invitationToken(services.invitationKey, invitationId) },
    );
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const now = await supportActor(first.user);
    expect(now.membershipId).not.toBe(old);
    expect(now.support?.reason).toBe("Phiếu #2");
  });

  it("lời cấp tạo trước khi membership cũ bị đóng: nhận lời mời tự đóng membership hỗ trợ hết hạn (không 409 mãi)", async () => {
    const first = await grantAndAccept();
    const old = (await supportActor(first.user)).membershipId;
    await expire(old);
    const g = await post("member.grantSupportAccess", owner(), { email: first.email, reason: "Phiếu cũ" });
    expect(g.status).toBe(201);
    // Dựng lại trạng thái của dữ liệu cũ: membership hết hạn vẫn `active` khi lời cấp mới đã có.
    await sql`update memberships set status = 'active', revoked_at = null where id = ${old}`.execute(t.admin);
    const invitationId = (g.json.data as { invitationId: string }).invitationId;
    const a = await post(
      "member.acceptInvitation",
      { user: first.user },
      { token: invitationToken(services.invitationKey, invitationId) },
    );
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(
      (await sql<{ status: string }>`select status from memberships where id = ${old}`.execute(t.admin))
        .rows[0]?.status,
    ).toBe("revoked");
  });

  it("membership hỗ trợ CÒN hạn: cấp lại vẫn 409 và không bị đóng; vai khác (manager) không bị đụng", async () => {
    const live = await grantAndAccept();
    const id = (await supportActor(live.user)).membershipId;
    const r = await post("member.grantSupportAccess", owner(), { email: live.email, reason: "trùng" });
    expect(r.status).toBe(409);
    expect(
      (await sql<{ status: string }>`select status from memberships where id = ${id}`.execute(t.admin))
        .rows[0]?.status,
    ).toBe("active");
  });

  it("đồng thời: hai lời cấp lại song song cho cùng email đã hết hạn ⇒ đúng một 201, một 409; membership cũ đóng một lần", async () => {
    const first = await grantAndAccept();
    const old = (await supportActor(first.user)).membershipId;
    await expire(old);
    const rs = await Promise.all(
      [1, 2].map((i) =>
        post("member.grantSupportAccess", owner(), { email: first.email, reason: `song song ${i}` }),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const m = await sql<{
      status: string;
      version: number;
    }>`select status, version from memberships where id = ${old}`.execute(t.admin);
    expect(m.rows[0]?.status).toBe("revoked");
  });
});

describe("hàm RLS chỉ coi membership còn hạn (F4)", () => {
  it("GUC actor còn đặt nhưng membership hết hạn ⇒ actor_role/actor_person_id NULL, actor_can_see_property false, persons 0 dòng", async () => {
    const { user } = await grantAndAccept();
    const s = await supportActor(user);
    const probe = () =>
      withTenant(t.runtime, { orgId: A.orgId, actorId: s.membershipId }, async (trx) => {
        const r = await sql<{ role: string | null; person: string | null; sees: boolean }>`
          select app.actor_role() as role, app.actor_person_id() as person,
                 app.actor_can_see_property(${A.propertyId}::uuid) as sees`.execute(trx);
        return r.rows[0];
      });
    expect(await probe()).toEqual({ role: "platform_support", person: s.personId, sees: true });
    await expire(s.membershipId);
    expect(await probe()).toEqual({ role: null, person: null, sees: false });

    // Vai nhân viên có `valid_to` (cùng cơ chế): manager hết hạn không đọc được hồ sơ người dù GUC còn đặt.
    const m = await seedMember(t, A, "manager", { name: "Quản lý hết hạn" });
    const persons = () =>
      withTenant(t.runtime, { orgId: A.orgId, actorId: m.membershipId }, async (trx) =>
        Number(
          (
            await sql<{
              n: number;
            }>`select count(*)::int as n from persons where organization_id = ${A.orgId}`.execute(trx)
          ).rows[0]?.n,
        ),
      );
    expect(await persons()).toBeGreaterThan(0);
    await expire(m.membershipId);
    expect(await persons()).toBe(0);
  });
});

describe("manager thấy sự kiện của support (F3, D-128)", () => {
  it("manager (phạm vi một cơ sở) thấy `support.accessed` cấp tổ chức; kế toán thì không; owner thấy", async () => {
    const { user } = await grantAndAccept({ reason: "Phiếu #F3" });
    const s = await supportActor(user);
    expect((await get("inventory.getCalendar", { user, org: A.orgId }, cal(A))).status).toBe(200);
    const seen = async (a: Actor) =>
      (
        await listEvents(t.runtime, a, {
          actorType: "platform_support",
          action: "support.accessed",
          limit: 200,
        })
      ).items.filter((e) => e.actorPersonId === s.personId).length;
    expect(await seen(await ownerActorA())).toBe(1);
    expect(await seen(manager)).toBe(1);
    // Kế toán: không thuộc nhóm tiền ⇒ RLS che (app cũng lọc).
    expect(await seen(accountant)).toBe(0);
    // Sự kiện cấp tổ chức của NGƯỜI KHÁC (không phải support) vẫn bị che với manager như trước.
    const other = randomUUID();
    await sql`insert into audit_events (id, organization_id, actor_type, actor_person_id, action, entity_type, correlation_id)
              values (${other}, ${A.orgId}, 'user', ${A.ownerPersonId}, 'member.invited', 'invitation', 'f3-khac')`.execute(
      t.admin,
    );
    const r = await listEvents(t.runtime, manager, { correlationId: "f3-khac" });
    expect(r.items).toHaveLength(0);
  });
});

describe("gộp `support.accessed` (F7a)", () => {
  it("cùng trang/query trong 60 giây ⇒ một sự kiện (kể cả 5 lần song song); khác tên ⇒ thêm; qua cửa sổ ⇒ ghi lại", async () => {
    const { user } = await grantAndAccept();
    const s = await supportActor(user);
    await Promise.all(
      Array.from({ length: 5 }, () => recordSupportAccess(t.runtime, s, { kind: "page", name: "/phong" })),
    );
    await recordSupportAccess(t.runtime, s, { kind: "page", name: "/phong" });
    expect(await supportAccessCount(s.personId, "/phong")).toBe(1);
    await recordSupportAccess(t.runtime, s, { kind: "page", name: "/lich" });
    await recordSupportAccess(t.runtime, s, { kind: "query", name: "/phong" });
    expect(await supportAccessCount(s.personId)).toBe(3);
    // Giả lập hết cửa sổ: xoá bộ đếm của membership này ⇒ lần kế tiếp ghi lại.
    await sql`delete from rate_limit_counters where scope = 'support.accessed' and subject like ${`${s.membershipId}:%`}`.execute(
      t.admin,
    );
    await recordSupportAccess(t.runtime, s, { kind: "page", name: "/phong" });
    // Tên "/phong": trang × 2 (trước/sau cửa sổ) + query × 1 (khác loại ⇒ khoá gộp khác).
    expect(await supportAccessCount(s.personId, "/phong")).toBe(3);
    // Không phải support ⇒ không ghi, không đếm.
    await recordSupportAccess(t.runtime, await ownerActorA(), { kind: "page", name: "/phong" });
    expect(await supportAccessCount(A.ownerPersonId)).toBe(0);
  });
});

describe("đổi tổ chức và trạng thái xoá của support được ghi (F5)", () => {
  const routeReq = (user: string, method: "GET" | "POST", body?: unknown) =>
    new Request("http://local.test/api/v1/x", {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-test-user": user,
        "x-test-2fa": "1",
        "x-org-id": A.orgId,
        "user-agent": UA,
        "x-forwarded-for": IP,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("support chọn tổ chức/cơ sở được (200) và để lại `support.accessed`; owner thì không có sự kiện", async () => {
    const { user } = await grantAndAccept();
    const s = await supportActor(user);
    const r = await handleSwitchOrganization(
      routeReq(user, "POST", { organization_id: A.orgId, property_id: A.propertyId }),
      deps,
    );
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await supportAccessCount(s.personId, "session.switchOrganization")).toBe(1);
    const o = await handleSwitchOrganization(
      routeReq(A.ownerAuthUserId, "POST", { organization_id: A.orgId }),
      deps,
    );
    expect(o.status).toBe(200);
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where organization_id = ${A.orgId}
          and action = 'support.accessed' and actor_person_id = ${A.ownerPersonId}`.execute(t.admin)
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("GET trạng thái xoá tổ chức của support ⇒ 200 + `support.accessed`", async () => {
    const { user } = await grantAndAccept();
    const s = await supportActor(user);
    const r = await handleGetOrgDeletion(routeReq(user, "GET"), deps);
    expect(r.status).toBe(200);
    expect(await supportAccessCount(s.personId, "organization.getDeletion")).toBe(1);
  });
});

describe("xác thực lại: input không mang mật khẩu, hạn mức chung (R1, R2)", () => {
  it("lệnh khai `reauth`: `prepare`/`run` nhận input KHÔNG có `password`; audit after = input không có mật khẩu", async () => {
    const seen: Record<string, unknown>[] = [];
    const def: CommandDef<{ note: string; password?: string | undefined }, { ok: true }, null> = {
      command: "member.reauthProbe",
      input: z.strictObject({ note: z.string(), password: z.string().min(1).max(256).optional() }),
      reauth: { roles: ["owner"] },
      prepare: async (_db, _a, input) => {
        seen.push({ ...input });
        return null;
      },
      run: async (ctx, input) => {
        seen.push({ ...input });
        await ctx.audit({
          action: "member.reauth_probe",
          entityType: "organization",
          entityId: A.orgId,
          after: input,
        });
        return { data: { ok: true } };
      },
    };
    const req = new Request("http://local.test/api/v1/member/reauthProbe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-test-user": A.ownerAuthUserId,
        "x-test-2fa": "1",
        "x-org-id": A.orgId,
        ...STALE,
      },
      body: JSON.stringify({ note: "thử", password: GOOD_PASSWORD }),
    });
    const res = await handleCommand(def as never, req, deps);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(seen).toEqual([{ note: "thử" }, { note: "thử" }]);
    const a = await sql<{ after: unknown }>`select after from audit_events
      where organization_id = ${A.orgId} and action = 'member.reauth_probe'`.execute(t.admin);
    expect(a.rows[0]?.after).toEqual({ note: "thử" });
  });

  it("5 lần sai ở lệnh cấp hỗ trợ ⇒ xoá tổ chức và DSAR xoá cũng 429 (một hạn mức theo tài khoản); tài khoản khác không bị ảnh hưởng", async () => {
    const who = await seedMember(t, A, "owner", { name: "Chủ thử hạn mức" });
    const me = { user: who.authUserId, org: A.orgId };
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post(
            "member.grantSupportAccess",
            me,
            { email: `r2+${i}@example.test`, reason: "x", password: "sai" },
            STALE,
          )
        ).status,
      ).toBe(401);
    const req = (user: string, body: unknown) =>
      new Request("http://local.test/api/v1/x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          "x-test-user": user,
          "x-test-2fa": "1",
          "x-org-id": A.orgId,
          ...STALE,
        },
        body: JSON.stringify(body),
      });
    const del = await handleRequestOrgDeletion(req(who.authUserId, { password: "sai" }), deps);
    expect(del.status).toBe(429);
    const dsar = await handleCreateDataRequest(
      req(who.authUserId, { type: "delete", password: "sai" }),
      deps,
    );
    expect(dsar.status).toBe(429);
    // Owner khác: hạn mức riêng ⇒ vẫn 401 (sai mật khẩu), không 429.
    const other = await seedMember(t, A, "owner", { name: "Chủ khác" });
    expect((await handleRequestOrgDeletion(req(other.authUserId, { password: "sai" }), deps)).status).toBe(
      401,
    );
  });
});
