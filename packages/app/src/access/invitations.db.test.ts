// SPEC-access-and-property S-007, S-008 (mời nhân viên + chấp nhận + INVITATION_INVALID), S-021 (idempotency của member.invite),
// S-018 (mời vai trò cao bị từ chối + audit lần bị từ chối). Gọi qua HTTP thật (handleCommand/handleUserCommand) trên Postgres thật.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpDeps, handleCommand, handleUserCommand } from "../http/command-route.ts";
import { COMMANDS, USER_COMMANDS } from "../http/registry.ts";
import { createLogger } from "../logging/logger.ts";
import { setAppLogger } from "../logging/runtime.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { assertLogRecords } from "../testing/log-schema.ts";
import { resolveActor } from "./actor.ts";
import { buildInvitationMail, invitationToken } from "./invitations.ts";

let t: TestDb;
let deps: HttpDeps;
let A: SeededOrg;
const services = testServices();

beforeAll(async () => {
  t = await createTestDb();
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
    services,
  };
  A = await seedOrg(t.admin, "Khách sạn mời nhân viên");
});
afterAll(async () => {
  await t?.drop();
});

interface Out {
  status: number;
  body: Record<string, unknown> & { data?: Record<string, string> };
}
async function call(
  kind: "user" | "org",
  name: string,
  user: string,
  body: unknown,
  opts: { org?: string; key?: string } = {},
): Promise<Out> {
  const req = new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": opts.key ?? randomUUID(),
      "x-test-user": user,
      ...(opts.org ? { "x-org-id": opts.org } : {}),
    },
    body: JSON.stringify(body),
  });
  const res =
    kind === "user"
      ? await handleUserCommand(USER_COMMANDS[name] as never, req, deps)
      : await handleCommand(COMMANDS[name] as never, req, deps);
  return { status: res.status, body: (await res.json()) as Out["body"] };
}
const invite = (user: string, body: Record<string, unknown>, opts: { key?: string; org?: string } = {}) =>
  call("org", "member.invite", user, body, { org: A.orgId, ...opts });
const accept = (user: string, token: string, key?: string) =>
  call("user", "member.acceptInvitation", user, { token }, key ? { key } : {});
const tokenOf = (invitationId: string) => invitationToken(services.invitationKey, invitationId);
const mail = () => `moi+${randomUUID().slice(0, 8)}@example.test`;
const count = async (table: string, where = sql`true`) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${A.orgId} and ${where}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? 0;
const memberCount = () => count("memberships");

/** Mời + trả {invitationId, email, token}. */
async function invited(extra: Record<string, unknown> = {}) {
  const email = mail();
  const r = await invite(A.ownerAuthUserId, {
    email,
    role: "front_desk",
    property_ids: [A.propertyId],
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const invitationId = r.body.data?.invitationId as string;
  return { email, invitationId, token: tokenOf(invitationId) };
}

describe("SPEC-access S-007: mời thành viên và chấp nhận", () => {
  it("S-007 mời front_desk phạm vi [P1] hạn mức giảm giá 100.000 → người nhận đăng nhập đúng email chấp nhận: membership active đúng vai trò/phạm vi/hạn mức; lời mời accepted và không dùng lại được", async () => {
    const { email, invitationId, token } = await invited({ limits: { discount: 100_000 } });
    const inv = await sql<{ status: string; token_hash: Buffer; expires_at: Date; created_at: Date }>`
      select status, token_hash, expires_at, created_at from invitations where id = ${invitationId}`.execute(
      t.admin,
    );
    expect(inv.rows[0]?.status).toBe("pending");
    // Hạn 7 ngày (Q-05, UTC), token chỉ lưu băm 32 byte.
    const days =
      ((inv.rows[0]?.expires_at.getTime() as number) - (inv.rows[0]?.created_at.getTime() as number)) /
      86_400_000;
    expect(days).toBeCloseTo(7, 1);
    expect(inv.rows[0]?.token_hash.length).toBe(32);

    const user = await seedAuthUser(t.admin, email.toUpperCase());
    const before = await memberCount();
    const r = await accept(user, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await memberCount()).toBe(before + 1);
    const m = await sql<{
      role: string;
      status: string;
      limits: Record<string, number>;
      all_properties: boolean;
    }>`
      select role, status, limits, all_properties from memberships where id = ${r.body.data?.membershipId as string}`.execute(
      t.admin,
    );
    expect(m.rows[0]).toEqual({
      role: "front_desk",
      status: "active",
      limits: { discount: 100_000 },
      all_properties: false,
    });
    const scopes = await sql<{
      property_id: string;
    }>`select property_id from property_scopes where membership_id = ${r.body.data?.membershipId as string}`.execute(
      t.admin,
    );
    expect(scopes.rows.map((s) => s.property_id)).toEqual([A.propertyId]);
    const after = await sql<{
      status: string;
      accepted_at: Date | null;
      membership_id: string;
    }>`select status, accepted_at, membership_id from invitations where id = ${invitationId}`.execute(
      t.admin,
    );
    expect(after.rows[0]?.status).toBe("accepted");
    expect(after.rows[0]?.accepted_at).not.toBeNull();
    expect(after.rows[0]?.membership_id).toBe(r.body.data?.membershipId);
    // Quyền tra từ membership: người mới vào được tổ chức đúng vai trò.
    const actor = await resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
    expect(actor).toMatchObject({
      role: "front_desk",
      propertyIds: [A.propertyId],
      limits: { discount: 100_000 },
    });
    // Dùng lại token (key mới) → 410, không thêm membership.
    const again = await accept(user, token);
    expect([again.status, again.body.code]).toEqual([410, "INVITATION_INVALID"]);
    expect(await memberCount()).toBe(before + 1);
    // audit + outbox cùng lúc
    expect(await count("audit_events", sql`action = 'member.invited' and entity_id = ${invitationId}`)).toBe(
      1,
    );
    expect(
      await count(
        "audit_events",
        sql`action = 'member.accepted' and entity_id = ${r.body.data?.membershipId as string}`,
      ),
    ).toBe(1);
    expect(await count("outbox", sql`event_type = 'member.invited' and aggregate_id = ${invitationId}`)).toBe(
      1,
    );
    expect(await count("outbox", sql`event_type = 'member.accepted'`)).toBeGreaterThanOrEqual(1);
  });

  it("owner/accountant không gửi phạm vi → mọi cơ sở (all_properties); owner mời owner phải không có property_ids", async () => {
    const acc = await invited({ role: "accountant", property_ids: [] });
    const u = await seedAuthUser(t.admin, acc.email);
    const r = await accept(u, acc.token);
    expect(r.status).toBe(200);
    const m = await sql<{
      all_properties: boolean;
    }>`select all_properties from memberships where id = ${r.body.data?.membershipId as string}`.execute(
      t.admin,
    );
    expect(m.rows[0]?.all_properties).toBe(true);
    const bad = await invite(A.ownerAuthUserId, {
      email: mail(),
      role: "owner",
      property_ids: [A.propertyId],
    });
    expect([bad.status, bad.body.errors]).toEqual([
      422,
      [expect.objectContaining({ field: "property_ids" })],
    ]);
    const ok = await invite(A.ownerAuthUserId, { email: mail(), role: "owner" });
    expect(ok.status).toBe(201);
  });

  it("cùng Idempotency-Key gửi lại khi chấp nhận → replay cùng membership (không 410); song song hai key khác nhau → đúng một thắng", async () => {
    const a = await invited();
    const user = await seedAuthUser(t.admin, a.email);
    const key = randomUUID();
    const r1 = await accept(user, a.token, key);
    const r2 = await accept(user, a.token, key);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r2.body.data?.membershipId).toBe(r1.body.data?.membershipId);

    const b = await invited();
    const u2 = await seedAuthUser(t.admin, b.email);
    const before = await memberCount();
    const rs = await Promise.all([1, 2, 3, 4].map(() => accept(u2, b.token)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 410, 410, 410]);
    expect(await memberCount()).toBe(before + 1);
  });
});

describe("SPEC-access S-008: lời mời hết hạn, đã dùng hoặc sai email", () => {
  async function expectInvalid(user: string, token: string) {
    const before = await memberCount();
    const r = await accept(user, token);
    expect([r.status, r.body.code]).toEqual([410, "INVITATION_INVALID"]);
    expect(await memberCount()).toBe(before);
    return r;
  }

  it("S-008 quá hạn (đúng mốc expires_at = now) → 410; trước mốc 1 giờ → chấp nhận được", async () => {
    const a = await invited();
    const u = await seedAuthUser(t.admin, a.email);
    await sql`update invitations set expires_at = now() where id = ${a.invitationId}`.execute(t.admin);
    await expectInvalid(u, a.token);
    await sql`update invitations set expires_at = now() + interval '1 hour' where id = ${a.invitationId}`.execute(
      t.admin,
    );
    expect((await accept(u, a.token)).status).toBe(200);
  });

  it("S-008 sai email (người khác đăng nhập) → 410, lời mời vẫn còn chờ cho đúng người", async () => {
    const a = await invited();
    const other = await seedAuthUser(t.admin, mail());
    await expectInvalid(other, a.token);
    const st = await sql<{
      status: string;
    }>`select status from invitations where id = ${a.invitationId}`.execute(t.admin);
    expect(st.rows[0]?.status).toBe("pending");
    const right = await seedAuthUser(t.admin, a.email);
    expect((await accept(right, a.token)).status).toBe(200);
  });

  it("S-008 đã thu hồi, token lạ, token rác, chuỗi dài → 410 (cùng một mã); không phiên → 401", async () => {
    const a = await invited();
    const u = await seedAuthUser(t.admin, a.email);
    await sql`update invitations set status = 'revoked' where id = ${a.invitationId}`.execute(t.admin);
    await expectInvalid(u, a.token);
    await expectInvalid(u, tokenOf(randomUUID()));
    await expectInvalid(u, "khong-phai-token");
    await expectInvalid(u, "x".repeat(200));
    const none = await call("user", "member.acceptInvitation", "", { token: a.token });
    expect(none.status).toBe(401);
  });

  it("đã là thành viên tổ chức → 409 DUPLICATE (không tạo membership thứ hai), lời mời còn nguyên", async () => {
    const a = await invited();
    const u = await seedAuthUser(t.admin, a.email);
    expect((await accept(u, a.token)).status).toBe(200);
    const b = await invite(A.ownerAuthUserId, {
      email: a.email,
      role: "manager",
      property_ids: [A.propertyId],
    });
    expect([b.status, b.body.code]).toEqual([409, "DUPLICATE"]);
  });
});

describe("SPEC-access S-021: idempotency của member.invite", () => {
  it("S-021 cùng key + cùng thân → cùng invitation_id, tổng số lời mời = 1; khác email cùng key → 422 IDEMPOTENCY_CONFLICT", async () => {
    const key = randomUUID();
    const email = mail();
    const body = { email, role: "housekeeping", property_ids: [A.propertyId] };
    const r1 = await invite(A.ownerAuthUserId, body, { key });
    const r2 = await invite(A.ownerAuthUserId, body, { key });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.body.data?.invitationId).toBe(r1.body.data?.invitationId);
    expect(await count("invitations", sql`email = ${email}`)).toBe(1);
    expect(
      await count(
        "outbox",
        sql`event_type = 'member.invited' and aggregate_id = ${r1.body.data?.invitationId as string}`,
      ),
    ).toBe(1);
    const r3 = await invite(A.ownerAuthUserId, { ...body, email: mail() }, { key });
    expect([r3.status, r3.body.code]).toEqual([422, "IDEMPOTENCY_CONFLICT"]);
  });

  it("bấm Mời lần nữa với key khác khi còn lời mời chờ → 409 (1 lời mời đang chờ/email+vai trò); lời mời đã quá hạn thì mời lại được và bản cũ thành expired", async () => {
    const a = await invited();
    const dup = await invite(A.ownerAuthUserId, {
      email: a.email,
      role: "front_desk",
      property_ids: [A.propertyId],
    });
    expect([dup.status, dup.body.code]).toEqual([409, "DUPLICATE"]);
    await sql`update invitations set expires_at = now() - interval '1 minute' where id = ${a.invitationId}`.execute(
      t.admin,
    );
    const again = await invite(A.ownerAuthUserId, {
      email: a.email.toUpperCase(),
      role: "front_desk",
      property_ids: [A.propertyId],
    });
    expect(again.status).toBe(201);
    expect(again.body.data?.invitationId).not.toBe(a.invitationId);
    const old = await sql<{
      status: string;
    }>`select status from invitations where id = ${a.invitationId}`.execute(t.admin);
    expect(old.rows[0]?.status).toBe("expired");
    // Token của lời mời cũ không dùng được nữa.
    const u = await seedAuthUser(t.admin, a.email);
    expect((await accept(u, a.token)).status).toBe(410);
  });
});

describe("kiểm tra đầu vào member.invite (VALIDATION_FAILED theo trường)", () => {
  it("vai trò cấp cơ sở mà phạm vi rỗng → 422 property_ids; email sai → 422; hạn mức âm/lẻ → 422; cơ sở lạ/của tổ chức khác → 404; không tạo gì", async () => {
    const other = await seedOrg(t.admin, "Tổ chức khác mời");
    const before = await count("invitations");
    const cases: [Record<string, unknown>, number, string?][] = [
      [{ email: mail(), role: "front_desk", property_ids: [] }, 422, "property_ids"],
      [{ email: mail(), role: "front_desk" }, 422, "property_ids"],
      [{ email: "khong-phai-email", role: "front_desk", property_ids: [A.propertyId] }, 422, "email"],
      [
        { email: mail(), role: "front_desk", property_ids: [A.propertyId], limits: { discount: -1 } },
        422,
        "limits.discount",
      ],
      [
        { email: mail(), role: "front_desk", property_ids: [A.propertyId], limits: { discount: 1.5 } },
        422,
        "limits.discount",
      ],
      [{ email: mail(), role: "tenant", property_ids: [A.propertyId] }, 422, "role"],
      [{ email: mail(), role: "front_desk", property_ids: [randomUUID()] }, 404],
      [{ email: mail(), role: "front_desk", property_ids: [other.propertyId] }, 404],
    ];
    for (const [body, status, field] of cases) {
      const r = await invite(A.ownerAuthUserId, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      if (field) expect(JSON.stringify(r.body.errors), JSON.stringify(body)).toContain(field);
    }
    expect(await count("invitations")).toBe(before);
    // hạn mức 0 là hợp lệ (mọi khoản cần duyệt)
    expect(
      (
        await invite(A.ownerAuthUserId, {
          email: mail(),
          role: "front_desk",
          property_ids: [A.propertyId],
          limits: { refund: 0 },
        })
      ).status,
    ).toBe(201);
  });
});

describe("SPEC-access S-018: không tự nâng quyền khi mời", () => {
  it("S-018 manager mời accountant/manager/owner → 403 FORBIDDEN + audit_events ghi lần thử bị từ chối; không có lời mời", async () => {
    const mgr = await seedMember(t, A, "manager", { name: "Quản lý M" });
    const before = await count("invitations");
    for (const role of ["accountant", "manager", "owner"]) {
      const r = await invite(mgr.authUserId, {
        email: mail(),
        role,
        property_ids: role === "owner" ? [] : [A.propertyId],
      });
      expect([r.status, r.body.code], role).toEqual([403, "FORBIDDEN"]);
    }
    expect(await count("invitations")).toBe(before);
    const rows = await sql<{
      outcome: string;
      action: string;
      after: { role: string } | null;
      actor_person_id: string;
    }>`
      select outcome, action, after, actor_person_id from audit_events
      where organization_id = ${A.orgId} and actor_person_id = ${mgr.personId} and action in ('member.invite_denied', 'command.denied')`.execute(
      t.admin,
    );
    expect(
      rows.rows
        .filter((r) => r.action === "member.invite_denied")
        .map((r) => r.after?.role)
        .sort(),
    ).toEqual(["accountant", "manager", "owner"]);
    expect(rows.rows.filter((r) => r.action === "command.denied" && r.outcome === "denied").length).toBe(3);
  });

  it("manager mời nhân viên cấp thấp trong phạm vi của mình được; ngoài phạm vi → 404 + audit; hạn mức vượt của chính mình → 403; lễ tân không mời được", async () => {
    const p2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${p2}, ${A.orgId}, 'Cơ sở 2', 'rental')`.execute(
      t.admin,
    );
    const mgr = await seedMember(t, A, "manager", { name: "Quản lý trong P1" });
    const ok = await invite(mgr.authUserId, {
      email: mail(),
      role: "maintenance",
      property_ids: [A.propertyId],
      limits: { refund: 2_000_000 },
    });
    expect(ok.status).toBe(201);
    const outside = await invite(mgr.authUserId, { email: mail(), role: "housekeeping", property_ids: [p2] });
    expect(outside.status).toBe(404);
    const over = await invite(mgr.authUserId, {
      email: mail(),
      role: "front_desk",
      property_ids: [A.propertyId],
      limits: { discount: 1 },
    });
    expect([over.status, over.body.code]).toEqual([403, "FORBIDDEN"]);
    const fd = await seedMember(t, A, "front_desk");
    const byFd = await invite(fd.authUserId, {
      email: mail(),
      role: "housekeeping",
      property_ids: [A.propertyId],
    });
    expect(byFd.status).toBe(403);
    const denied = await count("audit_events", sql`action = 'member.invite_denied'`);
    expect(denied).toBeGreaterThanOrEqual(4);
  });
});

describe("token chỉ lưu băm; email lời mời dựng lại token ở worker (qua outbox)", () => {
  it("token không xuất hiện ở audit/outbox/idempotency/invitations; buildInvitationMail dựng link #token và trả null khi đã dùng/quá hạn", async () => {
    const a = await invited();
    for (const table of ["audit_events", "outbox", "idempotency_keys", "invitations"]) {
      const r = await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table)} t where t::text like ${`%${a.token}%`}`.execute(
        t.admin,
      );
      expect(r.rows[0]?.n, table).toBe(0);
    }
    const job = { organization_id: A.orgId, payload: { invitation_id: a.invitationId } };
    const m = await buildInvitationMail(t.admin, job, {
      key: services.invitationKey,
      baseUrl: "https://hm.example.test/",
    });
    expect(m?.to).toBe(a.email);
    expect(m?.text).toContain(`https://hm.example.test/loi-moi#token=${a.token}`);
    expect(m?.idempotencyKey).toBe(a.invitationId);
    // Xuống dòng/ký tự lạ trong tên tổ chức không chèn được header thư.
    expect(m?.subject).not.toMatch(/[\r\n]/);
    const u = await seedAuthUser(t.admin, a.email);
    expect((await accept(u, a.token)).status).toBe(200);
    expect(
      await buildInvitationMail(t.admin, job, { key: services.invitationKey, baseUrl: "https://x.test" }),
    ).toBeNull();
    const b = await invited();
    await sql`update invitations set expires_at = now() - interval '1 second' where id = ${b.invitationId}`.execute(
      t.admin,
    );
    expect(
      await buildInvitationMail(
        t.admin,
        { organization_id: A.orgId, payload: { invitation_id: b.invitationId } },
        { key: services.invitationKey, baseUrl: "https://x.test" },
      ),
    ).toBeNull();
  });
});

describe("sự kiện bảo mật của lời mời (SEC-LOG-001)", () => {
  it("member.invited, member.accepted và invitation.rejected (mỗi lý do một mã) — không ghi token/email", async () => {
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
      const a = await invited();
      const u = await seedAuthUser(t.admin, a.email);
      await accept(await seedAuthUser(t.admin, mail()), a.token); // sai email
      await accept(u, a.token);
      await accept(u, a.token); // đã dùng
      await accept(u, "token-la");
      const events = lines.map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            outcome: string;
            reason: string | null;
            target: { id: string | null } | null;
          },
      );
      assertLogRecords(lines);
      const of = (e: string) => events.filter((x) => x.event === e);
      expect(of("member.invited")).toHaveLength(1);
      expect(of("member.invited")[0]?.target?.id).toBe(a.invitationId);
      expect(of("member.accepted")).toHaveLength(1);
      expect(
        of("invitation.rejected")
          .map((x) => x.reason)
          .sort(),
      ).toEqual(["email_mismatch", "status_accepted", "unknown_token"]);
      for (const l of lines) {
        expect(l).not.toContain(a.token);
        expect(l).not.toContain(a.email);
      }
    } finally {
      setAppLogger(undefined);
    }
  });
});

describe("lời mời không hợp lệ: đúng một sự kiện invitation.rejected, route không ghi thêm denied", () => {
  it("token lạ / sai email / đã dùng → mỗi lần đúng một sự kiện bảo mật (invitation.rejected), 410 INVITATION_INVALID", async () => {
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
      const a = await invited();
      const u = await seedAuthUser(t.admin, a.email);
      lines.length = 0;
      for (const [user, token] of [
        [u, "token-la-khong-ton-tai"],
        [await seedAuthUser(t.admin, mail()), a.token],
      ] as const) {
        const r = await accept(user, token);
        expect([r.status, r.body.code]).toEqual([410, "INVITATION_INVALID"]);
      }
      const events = lines
        .map((l) => JSON.parse(l) as { category?: string; event: string; reason: string | null })
        .filter((r) => r.category === "security");
      expect(events.map((e) => [e.event, e.reason])).toEqual([
        ["invitation.rejected", "unknown_token"],
        ["invitation.rejected", "email_mismatch"],
      ]);
    } finally {
      setAppLogger(undefined);
    }
  });
});
