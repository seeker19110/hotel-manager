// T-2313 (D-128; IND-SAAS-009, TM-12) — truy cập hỗ trợ CHỈ ĐỌC do owner cấp, trên Postgres thật qua route thật (handleCommand/
// handleQuery/handleUserCommand, phiên giả theo header như authz-matrix.db.test.ts):
// cấp (owner được, manager/kế toán bị từ chối) → nhận lời mời → đọc được (query + audit `support.accessed` kèm lý do + nguồn) →
// MỌI lệnh ghi trong registry bị 403 (duyệt registry tự động) + RLS chặn ghi ở CSDL trên mọi bảng RLS → hết hạn đúng mốc theo đồng
// hồ CSDL → thu hồi một bước. CHECK: TTL > 72 giờ, lý do rỗng. Đồng thời: hai lời cấp song song cùng email ⇒ một thắng.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listEvents } from "../audit/index.ts";
import { type HttpDeps, handleCommand, handleQuery, handleUserCommand } from "../http/command-route.ts";
import { COMMANDS, QUERIES, USER_COMMANDS } from "../http/registry.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { type Actor, resolveActor } from "./actor.ts";
import { buildInvitationMail, invitationToken } from "./invitations.ts";
import { listSupportAccess } from "./support.ts";

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
           + (select count(*) from outbox where organization_id = ${A.orgId} and payload::text like ${`%${GOOD_PASSWORD}%`})::int as n`.execute(
      t.admin,
    );
    expect(leak.rows[0]?.n).toBe(0);
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
