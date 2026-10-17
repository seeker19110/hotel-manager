// PLAN đợt 3 T-216 — người thuê vào portal trên Postgres thật + Better Auth thật (SPEC-portal S-005, S-012…S-015;
// D-005, D-011, D-016).
import { randomUUID } from "node:crypto";
import {
  activateLease,
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedLease,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError, type Actor, listMyOrganizations, resolveActor } from "../access/actor.ts";
import { type Auth, createAuth } from "../auth/auth.ts";
import { actorFromRequest } from "../http/command-route.ts";
import { dispatchNotification } from "../notifications/dispatch.ts";
import { updateSettings } from "../notifications/preferences.ts";
import { testServices } from "../server/services.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { inviteTenant, revokeTenantAccess } from "./access.ts";

const BASE = "http://localhost:3000";
let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let hk: Actor;
let auth: Auth;
let closeAuth: () => Promise<void>;
const otps = new Map<string, string>();

async function tenantPerson(org: SeededOrg, name: string): Promise<{ personId: string; leaseId: string }> {
  const personId = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${org.orgId}, ${name})`.execute(
    t.admin,
  );
  const { leaseId } = await seedLease(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: personId,
    effectiveFrom: "2026-09-01",
  });
  await t.admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}'
              where lease_id = ${leaseId}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${leaseId}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${leaseId}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${leaseId}, 'move_in', '2026-09-01', ${org.ownerMembershipId},
                      now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${leaseId}`.execute(trx);
  });
  return { personId, leaseId };
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Khách sạn Mai");
  owner = await ownerOf(t, A);
  hk = await seedMember(t, A, "housekeeping");
  const created = createAuth({
    databaseUrl: t.runtimeUrl,
    secret: "s".repeat(48),
    baseURL: BASE,
    ipRateLimit: false,
    sendSignInOtp: async (email, otp) => {
      otps.set(email, otp);
    },
  });
  auth = created.auth;
  closeAuth = created.close;
});

afterAll(async () => {
  await closeAuth?.();
  await t?.drop();
});

const staffCount = async (orgId: string) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from memberships where organization_id = ${orgId} and role <> 'tenant' and status = 'active'`.execute(
      t.admin,
    )
  ).rows[0]?.n;

describe("S-014 mời người thuê, không tính quota nhân viên", () => {
  it("tạo tài khoản auth theo email + membership tenant gắn person_id; mời lại cùng kết quả; thông báo lời mời qua outbox", async () => {
    const an = await tenantPerson(A, "Người thuê An");
    const before = await staffCount(A.orgId);
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: an.personId, email: " An.Nguyen@Example.test " }),
    );
    expect(r.created).toBe(true);
    const m = await sql<{ role: string; person_id: string; status: string; email: string }>`
      select m.role, m.person_id, m.status, u.email from memberships m join auth."user" u on u.id = m.auth_user_id
      where m.id = ${r.membershipId}`.execute(t.admin);
    expect(m.rows[0]).toEqual({
      role: "tenant",
      person_id: an.personId,
      status: "active",
      email: "an.nguyen@example.test",
    });
    expect(await staffCount(A.orgId)).toBe(before);
    const again = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: an.personId, email: "an.nguyen@example.test" }),
    );
    expect(again).toEqual({ membershipId: r.membershipId, created: false });
    const ob = await sql<{ id: string; organization_id: string; payload: Record<string, unknown> }>`
      select id, organization_id, payload from outbox where event_type = 'portal.tenant_invited' and aggregate_id = ${r.membershipId}`.execute(
      t.admin,
    );
    expect(ob.rows).toHaveLength(1);
    const row = ob.rows[0] as (typeof ob.rows)[number];
    await dispatchNotification(t.worker, {
      organization_id: row.organization_id,
      outbox_id: row.id,
      event_type: "portal.tenant_invited",
      aggregate_id: r.membershipId,
      payload: row.payload,
    });
    const n = await sql<{ type: string; title: string }>`
      select type, title from notifications where recipient_person_id = ${an.personId}`.execute(t.admin);
    expect(n.rows).toEqual([
      { type: "account_security", title: "Nhà trọ Hoa Sen mời bạn vào cổng người thuê" },
    ]);
  });

  it("buồng phòng → 403; người không đứng hợp đồng → 404; tổ chức khác → 404; email đã là nhân viên của tổ chức → 409", async () => {
    const binh = await tenantPerson(A, "Người thuê Bình");
    expect(
      await codeOf(
        runAs(t, hk, (ctx) => inviteTenant(ctx, { personId: binh.personId, email: "binh@example.test" })),
      ),
    ).toBe("NOT_FOUND");
    const stranger = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${stranger}, ${A.orgId}, 'Không thuê')`.execute(
      t.admin,
    );
    expect(
      await codeOf(
        runAs(t, owner, (ctx) => inviteTenant(ctx, { personId: stranger, email: "x@example.test" })),
      ),
    ).toBe("NOT_FOUND");
    const ownerB = await ownerOf(t, B);
    expect(
      await codeOf(
        runAs(t, ownerB, (ctx) => inviteTenant(ctx, { personId: binh.personId, email: "binh@example.test" })),
      ),
    ).toBe("NOT_FOUND");
    const staffEmail = (
      await sql<{ email: string }>`select email from auth."user" where id = ${hk.authUserId}`.execute(t.admin)
    ).rows[0]?.email as string;
    expect(
      await codeOf(
        runAs(t, owner, (ctx) => inviteTenant(ctx, { personId: binh.personId, email: staffEmail })),
      ),
    ).toBe("DUPLICATE");
    expect(
      await codeOf(
        runAs(t, owner, (ctx) => inviteTenant(ctx, { personId: binh.personId, email: "khong-hop-le" })),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("Đăng nhập OTP email (D-011, D-016)", () => {
  it("người thuê nhận mã → đăng nhập → resolveActor tenant; OTP lưu băm; mã sai 3 lần thì mã đúng cũng hết hiệu lực", async () => {
    const c = await tenantPerson(A, "Người thuê Cúc");
    await okAs(t, owner, (ctx) => inviteTenant(ctx, { personId: c.personId, email: "cuc@example.test" }));
    expect(
      (await post("/email-otp/send-verification-otp", { email: "cuc@example.test", type: "sign-in" })).status,
    ).toBe(200);
    const otp = otps.get("cuc@example.test") as string;
    expect(otp).toMatch(/^\d{6}$/);
    const stored = await sql<{ value: string }>`
      select value from auth.verification where identifier like ${"%cuc@example.test%"}`.execute(t.admin);
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(stored.rows.every((r) => !r.value.includes(otp))).toBe(true);
    const ok = await post("/sign-in/email-otp", { email: "cuc@example.test", otp });
    expect(ok.status).toBe(200);
    const s = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(ok) }) });
    const actor = await resolveActor(t.runtime, {
      authUserId: s?.user.id,
      orgId: A.orgId,
      twoFactorEnabled: Boolean(s?.user.twoFactorEnabled),
    });
    expect(actor).toMatchObject({ role: "tenant", personId: c.personId });
    // Mã sai 3 lần → mã đúng cũng bị từ chối.
    otps.clear();
    await post("/email-otp/send-verification-otp", { email: "cuc@example.test", type: "sign-in" });
    const otp2 = otps.get("cuc@example.test") as string;
    const wrong = otp2 === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++)
      expect((await post("/sign-in/email-otp", { email: "cuc@example.test", otp: wrong })).ok).toBe(false);
    expect((await post("/sign-in/email-otp", { email: "cuc@example.test", otp: otp2 })).ok).toBe(false);
  });

  it("nhân viên / email lạ: không gửi mã, không tạo tài khoản, đăng nhập OTP bị từ chối như mã sai; luồng OTP khác bị tắt", async () => {
    otps.clear();
    const staffEmail = `quanly.${randomUUID().slice(0, 6)}@example.test`;
    const uid = await seedAuthUser(t.admin, staffEmail);
    const p = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${p}, ${A.orgId}, 'Quản lý')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
              values (${randomUUID()}, ${A.orgId}, ${uid}, ${p}, 'owner', true)`.execute(t.admin);
    for (const email of [staffEmail, "khong-ton-tai@example.test"]) {
      expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
      expect(otps.has(email)).toBe(false);
      const r = await post("/sign-in/email-otp", { email, otp: "123456" });
      expect(r.ok).toBe(false);
    }
    const users = await sql<{
      n: number;
    }>`select count(*)::int as n from auth."user" where email = 'khong-ton-tai@example.test'`.execute(
      t.admin,
    );
    expect(users.rows[0]?.n).toBe(0);
    expect(
      (await post("/email-otp/send-verification-otp", { email: staffEmail, type: "forget-password" })).status,
    ).toBe(404);
    expect((await post("/email-otp/request-password-reset", { email: staffEmail })).status).toBe(404);
  });
});

describe("S-005 người thuê gọi API nhân viên", () => {
  it("lệnh cấu hình của nhân viên → 403", async () => {
    const d = await tenantPerson(A, "Người thuê Dung");
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: d.personId, email: "dung@example.test" }),
    );
    const uid = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    const tenant = await resolveActor(t.runtime, {
      authUserId: uid,
      orgId: A.orgId,
      twoFactorEnabled: false,
    });
    expect(await codeOf(runAs(t, tenant, (ctx) => updateSettings(ctx, { propertyId: A.propertyId })))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("S-012/S-013 hai ngữ cảnh", () => {
  it("một người: quản lý ở B + người thuê ở A → listMyOrganizations có cả hai; tab gửi ngữ cảnh cũ khác cookie → 409 CONTEXT_CHANGED", async () => {
    const chi = await tenantPerson(A, "Chi");
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: chi.personId, email: "chi@example.test" }),
    );
    const uid = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    const pB = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${pB}, ${B.orgId}, 'Chi')`.execute(
      t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${randomUUID()}, ${B.orgId}, ${uid}, ${pB}, 'manager')`.execute(t.admin);
    const orgs = await listMyOrganizations(t.runtime, uid);
    expect(orgs.map((o) => [o.organizationName, o.role]).sort()).toEqual([
      ["Khách sạn Mai", "manager"],
      ["Nhà trọ Hoa Sen", "tenant"],
    ]);
    // Có vai trò nhân viên ⇒ không còn đăng nhập OTP được (luôn mật khẩu + TOTP cho mọi ngữ cảnh).
    otps.clear();
    await post("/email-otp/send-verification-otp", { email: "chi@example.test", type: "sign-in" });
    expect(otps.has("chi@example.test")).toBe(false);
    const deps = {
      db: t.runtime,
      getSession: async () => ({ user: { id: uid, twoFactorEnabled: true } }),
      secureCookies: false,
      services: testServices(),
    } as unknown as Parameters<typeof actorFromRequest>[1];
    const req = (header: string, cookie: string) =>
      new Request(`${BASE}/api/v1/x/y`, {
        method: "POST",
        headers: { "x-org-context": header, cookie: `hm_org=${cookie}` },
      });
    const changed = await actorFromRequest(req(A.orgId, B.orgId), deps, "test-corr-0001");
    expect(changed instanceof Response && changed.status).toBe(409);
    expect(changed instanceof Response && ((await changed.json()) as { code: string }).code).toBe(
      "CONTEXT_CHANGED",
    );
    const same = await actorFromRequest(req(B.orgId, B.orgId), deps, "test-corr-0002");
    expect(same).toMatchObject({ orgId: B.orgId, role: "manager" });
  });
});

describe("S-015 thu hồi / hết hạn xem lại", () => {
  it("quản lý thu hồi → resolveActor 404, không còn trong danh sách tổ chức; thu hồi lại idempotent; buồng phòng không thu hồi được", async () => {
    const e = await tenantPerson(A, "Người thuê Em");
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: e.personId, email: "em@example.test" }),
    );
    const uid = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    // Buồng phòng không đọc được membership người thuê (RLS) → 404 theo quy ước "không đọc được thì không lộ".
    expect(
      await codeOf(runAs(t, hk, (ctx) => revokeTenantAccess(ctx, { membershipId: r.membershipId }))),
    ).toBe("NOT_FOUND");
    await okAs(t, owner, (ctx) =>
      revokeTenantAccess(ctx, { membershipId: r.membershipId, reason: "Đã chuyển đi" }),
    );
    await expect(
      resolveActor(t.runtime, { authUserId: uid, orgId: A.orgId, twoFactorEnabled: false }),
    ).rejects.toBeInstanceOf(AccessError);
    expect(await listMyOrganizations(t.runtime, uid)).toEqual([]);
    expect(
      (await okAs(t, owner, (ctx) => revokeTenantAccess(ctx, { membershipId: r.membershipId }))).status,
    ).toBe("revoked");
    // Sau thu hồi: mời lại được (membership mới).
    const again = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: e.personId, email: "em@example.test" }),
    );
    expect(again.created).toBe(true);
  });

  it("hợp đồng closed → còn xem lại theo tenant_readonly_days (Q-04); 0 ngày → hết ngay → 404", async () => {
    const g = await tenantPerson(A, "Người thuê Giang");
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: g.personId, email: "giang@example.test" }),
    );
    const uid = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    // Đóng hợp đồng: bỏ qua các bước quyết toán (đã có test riêng) — tắt tạm trigger chặn trong transaction admin;
    // trigger hạn xem lại (đang kiểm) vẫn chạy.
    const close = async (leaseId: string) =>
      t.admin.transaction().execute(async (trx) => {
        await sql`alter table leases disable trigger trg_leases_close`.execute(trx);
        await sql`alter table leases disable trigger trg_leases_guard`.execute(trx);
        await sql`update leases set status = 'closed' where id = ${leaseId}`.execute(trx);
        await sql`set constraints all immediate`.execute(trx);
        await sql`alter table leases enable trigger trg_leases_close`.execute(trx);
        await sql`alter table leases enable trigger trg_leases_guard`.execute(trx);
      });
    await close(g.leaseId);
    const v = await sql<{ days: number }>`
      select round(extract(epoch from (valid_to - now())) / 86400)::int as days from memberships where id = ${r.membershipId}`.execute(
      t.admin,
    );
    expect(v.rows[0]?.days).toBe(30);
    expect(
      (await resolveActor(t.runtime, { authUserId: uid, orgId: A.orgId, twoFactorEnabled: false })).role,
    ).toBe("tenant");

    await sql`update organizations set settings = settings || '{"tenant_readonly_days": 0}'::jsonb where id = ${A.orgId}`.execute(
      t.admin,
    );
    const h2 = await tenantPerson(A, "Người thuê Hà");
    const r2 = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: h2.personId, email: "ha@example.test" }),
    );
    const uid2 = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r2.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    await close(h2.leaseId);
    await expect(
      resolveActor(t.runtime, { authUserId: uid2, orgId: A.orgId, twoFactorEnabled: false }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Hợp đồng mới cho cùng người → quyền portal có lại, không phải thu hồi + mời lại (review lát 4).
    const again = await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: h2.personId,
      effectiveFrom: "2026-11-01",
    });
    await activateLease(t.admin, { org: A, leaseId: again.leaseId });
    expect(
      (await resolveActor(t.runtime, { authUserId: uid2, orgId: A.orgId, twoFactorEnabled: false })).role,
    ).toBe("tenant");
    await sql`update organizations set settings = settings - 'tenant_readonly_days' where id = ${A.orgId}`.execute(
      t.admin,
    );
  });
});

describe("RLS: người thuê không đọc dữ liệu nội bộ của tổ chức (0039)", () => {
  it("sổ cái, giao dịch ngân hàng, audit, outbox, lịch phòng, lời mời, kết quả lệnh/ membership của người khác, file người khác → 0 dòng; nhân viên vẫn đọc", async () => {
    const k = await tenantPerson(A, "Người thuê Khoa");
    const r = await okAs(t, owner, (ctx) =>
      inviteTenant(ctx, { personId: k.personId, email: "khoa@example.test" }),
    );
    const uid = (
      await sql<{
        u: string;
      }>`select auth_user_id as u from memberships where id = ${r.membershipId}`.execute(t.admin)
    ).rows[0]?.u as string;
    const tenant = await resolveActor(t.runtime, {
      authUserId: uid,
      orgId: A.orgId,
      twoFactorEnabled: false,
    });
    // Dữ liệu nội bộ có thật trong tổ chức: file bàn giao, audit/outbox (từ lời mời), idempotency của owner.
    await sql`insert into files (id, organization_id, property_id, owner_type, storage_key, mime, size_bytes, sha256, status, exif_stripped,
                                 uploaded_by)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'handover', ${`${A.orgId}/handover/${randomUUID()}`}, 'image/jpeg',
                      10, ${"a".repeat(64)}, 'ready', true, ${A.ownerMembershipId})`.execute(t.admin);
    await runAs(t, owner, async () => ({}), { key: randomUUID(), command: "x.y", payload: {} });
    const tables = [
      "journal_entries",
      "journal_lines",
      "bank_transactions",
      "inbox",
      "audit_events",
      "allocations",
      "blocks",
      "invitations",
      "property_scopes",
      "files",
    ];
    const { withTenant } = await import("@hm/db");
    const asTenant = await withTenant(
      t.runtime,
      { orgId: A.orgId, actorId: tenant.membershipId },
      async (trx) => {
        const out: Record<string, number> = {};
        for (const tb of tables)
          out[tb] =
            (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(tb)}`.execute(trx)).rows[0]
              ?.n ?? -1;
        out.memberships_others = (
          await sql<{
            n: number;
          }>`select count(*)::int as n from memberships where person_id <> ${tenant.personId}`.execute(trx)
        ).rows[0]?.n as number;
        out.idempotency_others = (
          await sql<{
            n: number;
          }>`select count(*)::int as n from idempotency_keys where actor_person_id <> ${tenant.personId}`.execute(
            trx,
          )
        ).rows[0]?.n as number;
        return out;
      },
    );
    expect(Object.values(asTenant).every((n) => n === 0)).toBe(true);
    const asOwner = await withTenant(
      t.runtime,
      { orgId: A.orgId, actorId: owner.membershipId },
      async (trx) => ({
        audit: (await sql<{ n: number }>`select count(*)::int as n from audit_events`.execute(trx)).rows[0]
          ?.n,
        files: (await sql<{ n: number }>`select count(*)::int as n from files`.execute(trx)).rows[0]?.n,
        memberships: (await sql<{ n: number }>`select count(*)::int as n from memberships`.execute(trx))
          .rows[0]?.n,
      }),
    );
    expect(asOwner.audit).toBeGreaterThan(0);
    expect(asOwner.files).toBeGreaterThan(0);
    expect(asOwner.memberships).toBeGreaterThan(1);
    // Lệnh của người thuê vẫn ghi được audit/outbox/idempotency của chính mình.
    const own = await runAs(
      t,
      tenant,
      async (ctx) => {
        await ctx.audit({ action: "portal.viewed", entityType: "person", entityId: tenant.personId });
        return {};
      },
      { key: randomUUID(), command: "portal.x", payload: {} },
    );
    expect(own.status).toBe("committed");
  });
});
