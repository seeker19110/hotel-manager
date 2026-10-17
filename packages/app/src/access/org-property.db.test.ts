// SPEC-access-and-property S-001…S-003 (org.create, property.create), S-023 (property.update + PROPERTY_IN_USE ở CSDL),
// idempotency của org.create (INV-G5) và audit + outbox cùng transaction (INV-G6). Gọi qua HTTP thật (handleUserCommand/handleCommand).
import { randomUUID } from "node:crypto";
import { createTestDb, seedAuthUser, seedLease, seedOrg, seedReservation, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpDeps, handleCommand, handleUserCommand } from "../http/command-route.ts";
import { COMMANDS, USER_COMMANDS } from "../http/registry.ts";
import { testServices } from "../server/services.ts";

let t: TestDb;
let deps: HttpDeps;

beforeAll(async () => {
  t = await createTestDb();
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") !== "0" } } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
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
  user: string | null,
  body: unknown,
  opts: { org?: string; key?: string; mfa?: boolean } = {},
): Promise<Out> {
  const req = new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": opts.key ?? randomUUID(),
      ...(user ? { "x-test-user": user, "x-test-2fa": opts.mfa === false ? "0" : "1" } : {}),
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

const newUser = () => seedAuthUser(t.admin, `u+${randomUUID().slice(0, 8)}@example.test`);
const count = async (table: string, org: string, where = sql`true`) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${org} and ${where}`.execute(
      t.admin,
    )
  ).rows[0]?.n ?? 0;

/** Người dùng mới + tổ chức của họ (đã đủ MFA như phiên thật sau khi bật). */
async function ownerWithOrg() {
  const user = await newUser();
  const r = await call("user", "org.create", user, { name: "Trọ Hoa Mai" });
  return {
    user,
    org: r.body.data?.organizationId as string,
    membership: r.body.data?.membershipId as string,
  };
}

describe("SPEC-access S-001: org.create + property.create với mặc định đúng", () => {
  it("S-001 tạo tổ chức: người tạo là owner (mọi cơ sở), audit + outbox organization.created cùng lúc", async () => {
    const user = await newUser();
    const r = await call("user", "org.create", user, { name: "  Nhà nghỉ Sao Mai  " });
    expect(r.status).toBe(201);
    const orgId = r.body.data?.organizationId as string;
    const org = await sql<{
      name: string;
      created_by: string;
    }>`select name, created_by from organizations where id = ${orgId}`.execute(t.admin);
    expect(org.rows[0]).toEqual({ name: "Nhà nghỉ Sao Mai", created_by: user });
    const m = await sql<{ role: string; status: string; all_properties: boolean; auth_user_id: string }>`
      select role, status, all_properties, auth_user_id from memberships where organization_id = ${orgId}`.execute(
      t.admin,
    );
    expect(m.rows).toEqual([{ role: "owner", status: "active", all_properties: true, auth_user_id: user }]);
    expect(
      await count("audit_events", orgId, sql`action = 'organization.created' and outcome = 'success'`),
    ).toBe(1);
    expect(await count("outbox", orgId, sql`event_type = 'organization.created'`)).toBe(1);
  });

  it("S-001 property.create không gửi múi giờ/tiền tệ → Asia/Ho_Chi_Minh, VND, giờ chốt 00:00; audit + outbox property.created", async () => {
    const { user, org } = await ownerWithOrg();
    const r = await call("org", "property.create", user, { name: "Cơ sở 1", template: "rental" }, { org });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      timezone: "Asia/Ho_Chi_Minh",
      currency: "VND",
      businessDayCutoff: "00:00",
      template: "rental",
    });
    const p = await sql<{ timezone: string; currency: string; cutoff: string }>`
      select timezone, currency, to_char(business_day_cutoff, 'HH24:MI') as cutoff from properties where id = ${r.body.data?.propertyId as string}`.execute(
      t.admin,
    );
    expect(p.rows[0]).toEqual({ timezone: "Asia/Ho_Chi_Minh", currency: "VND", cutoff: "00:00" });
    expect(await count("audit_events", org, sql`action = 'property.created'`)).toBe(1);
    expect(await count("outbox", org, sql`event_type = 'property.created'`)).toBe(1);
  });

  it("org.create: cùng Idempotency-Key + cùng thân → cùng tổ chức (1 hàng); khác tên → 422 IDEMPOTENCY_CONFLICT; người khác dùng cùng key → tổ chức riêng", async () => {
    const user = await newUser();
    const key = randomUUID();
    const a = await call("user", "org.create", user, { name: "A" }, { key });
    const b = await call("user", "org.create", user, { name: "A" }, { key });
    expect(b.status).toBe(201);
    expect(b.body.data?.organizationId).toBe(a.body.data?.organizationId);
    expect(await count("memberships", a.body.data?.organizationId as string)).toBe(1);
    const c = await call("user", "org.create", user, { name: "B" }, { key });
    expect(c.status).toBe(422);
    expect(c.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const other = await newUser();
    const d = await call("user", "org.create", other, { name: "A" }, { key });
    expect(d.status).toBe(201);
    expect(d.body.data?.organizationId).not.toBe(a.body.data?.organizationId);
  });

  it("org.create song song cùng key → một tổ chức, cả hai nhận cùng kết quả", async () => {
    const user = await newUser();
    const key = randomUUID();
    const rs = await Promise.all(
      [1, 2, 3].map(() => call("user", "org.create", user, { name: "Song song" }, { key })),
    );
    for (const r of rs) expect(r.status).toBe(201);
    expect(new Set(rs.map((r) => r.body.data?.organizationId)).size).toBe(1);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from organizations where created_by = ${user}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("org.create: không phiên → 401; tên rỗng/chỉ khoảng trắng/quá 200 ký tự/trường lạ → 422; X-Org-Id bị bỏ qua", async () => {
    expect((await call("user", "org.create", null, { name: "X" })).status).toBe(401);
    const user = await newUser();
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(201) },
      { name: "X", organization_id: randomUUID() },
      {},
    ]) {
      const r = await call("user", "org.create", user, body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    const other = await seedOrg(t.admin, "Tổ chức khác");
    const ok = await call(
      "user",
      "org.create",
      user,
      { name: "Tên Unicode: Đà Nẵng 🏨" },
      { org: other.orgId },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data?.organizationId).not.toBe(other.orgId);
  });

  it("org.create: người dùng đã có tổ chức khác vẫn tạo thêm được; mỗi tổ chức độc lập", async () => {
    const { user, org } = await ownerWithOrg();
    const r = await call("user", "org.create", user, { name: "Tổ chức thứ hai" });
    expect(r.status).toBe(201);
    expect(r.body.data?.organizationId).not.toBe(org);
  });
});

describe("SPEC-access S-002: múi giờ/giờ chốt ngày không hợp lệ", () => {
  it("S-002 timezone='GMT+7' → 422 field timezone; business_day_cutoff='25:00' → 422 field business_day_cutoff; không tạo bản ghi", async () => {
    const { user, org } = await ownerWithOrg();
    const tz = await call(
      "org",
      "property.create",
      user,
      { name: "X", template: "hotel", timezone: "GMT+7" },
      { org },
    );
    expect(tz.status).toBe(422);
    expect(tz.body.code).toBe("VALIDATION_FAILED");
    expect(tz.body.errors).toEqual([expect.objectContaining({ field: "timezone" })]);
    const cut = await call(
      "org",
      "property.create",
      user,
      { name: "X", template: "hotel", business_day_cutoff: "25:00" },
      { org },
    );
    expect(cut.status).toBe(422);
    expect(cut.body.errors).toEqual([expect.objectContaining({ field: "business_day_cutoff" })]);
    expect(await count("properties", org)).toBe(0);
  });

  it("ca biên: 'UTC' (không có dấu /), chuỗi rỗng, tên tỉnh không tồn tại, 24:00, 7:30, 12:60 đều bị từ chối; Etc/GMT-7 và 23:59 được", async () => {
    const { user, org } = await ownerWithOrg();
    for (const body of [
      { timezone: "UTC" },
      { timezone: "" },
      { timezone: "Asia/Khong_Co" },
      { business_day_cutoff: "24:00" },
      { business_day_cutoff: "7:30" },
      { business_day_cutoff: "12:60" },
      { name: "x".repeat(201) },
      { name: "  " },
    ]) {
      const r = await call(
        "org",
        "property.create",
        user,
        { name: "X", template: "rental", ...body },
        { org },
      );
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect(await count("properties", org)).toBe(0);
    const ok = await call(
      "org",
      "property.create",
      user,
      {
        name: "Đêm muộn",
        template: "hotel",
        timezone: "Etc/GMT-7",
        business_day_cutoff: "23:59",
        check_in_time: "14:00",
        check_out_time: "12:00",
      },
      { org },
    );
    expect(ok.status).toBe(201);
  });
});

describe("SPEC-access S-003: mẫu Hỗn hợp chưa được bật", () => {
  it("S-003 mixed khi cờ tắt → 409 FEATURE_DISABLED; rental/hotel vẫn tạo được; bật cờ thì mixed tạo được", async () => {
    const { user, org } = await ownerWithOrg();
    const m = await call("org", "property.create", user, { name: "Hỗn hợp", template: "mixed" }, { org });
    expect(m.status).toBe(409);
    expect(m.body.code).toBe("FEATURE_DISABLED");
    expect(await count("properties", org)).toBe(0);
    for (const template of ["rental", "hotel"]) {
      expect((await call("org", "property.create", user, { name: template, template }, { org })).status).toBe(
        201,
      );
    }
    await sql`update organizations set settings = jsonb_build_object('feature_flags', jsonb_build_object('mixed_template_enabled', true)) where id = ${org}`.execute(
      t.admin,
    );
    expect(
      (await call("org", "property.create", user, { name: "Hỗn hợp", template: "mixed" }, { org })).status,
    ).toBe(201);
  });
});

describe("quyền của property.create/update (server + RLS)", () => {
  it("chỉ owner: manager → 403; người ngoài tổ chức → 404; thiếu MFA → 403 MFA_REQUIRED; không ghi gì", async () => {
    const A = await seedOrg(t.admin, "KS quyền");
    const { seedMember } = await import("../testing/helpers.ts");
    const manager = await seedMember(t, A, "manager");
    const before = await count("properties", A.orgId);
    const r = await call(
      "org",
      "property.create",
      manager.authUserId,
      { name: "Lén", template: "rental" },
      { org: A.orgId },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FORBIDDEN");
    const outsider = await newUser();
    expect(
      (await call("org", "property.create", outsider, { name: "Lén", template: "rental" }, { org: A.orgId }))
        .status,
    ).toBe(404);
    const noMfa = await call(
      "org",
      "property.create",
      A.ownerAuthUserId,
      { name: "Lén", template: "rental" },
      { org: A.orgId, mfa: false },
    );
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.code).toBe("MFA_REQUIRED");
    expect(await count("properties", A.orgId)).toBe(before);
    const upd = await call(
      "org",
      "property.update",
      manager.authUserId,
      { property_id: A.propertyId, name: "Lén" },
      { org: A.orgId },
    );
    expect(upd.status).toBe(403);
  });
});

describe("SPEC-access S-023: đổi múi giờ/giờ chốt khi cơ sở đã có dữ liệu", () => {
  async function propertyOf(org: string, user: string) {
    const r = await call("org", "property.create", user, { name: "CS", template: "hotel" }, { org });
    return r.body.data?.propertyId as string;
  }

  it("cơ sở chưa có dữ liệu: đổi được múi giờ + giờ chốt; ghi audit property.updated chỉ các trường đổi", async () => {
    const { user, org } = await ownerWithOrg();
    const property_id = await propertyOf(org, user);
    const r = await call(
      "org",
      "property.update",
      user,
      { property_id, timezone: "Asia/Bangkok", business_day_cutoff: "04:00", name: "CS mới" },
      { org },
    );
    expect(r.status).toBe(200);
    expect((r.body.data as unknown as { changed: string[] }).changed.sort()).toEqual([
      "business_day_cutoff",
      "name",
      "timezone",
    ]);
    const a = await sql<{ before: Record<string, string>; after: Record<string, string> }>`
      select before, after from audit_events where organization_id = ${org} and action = 'property.updated'`.execute(
      t.admin,
    );
    expect(a.rows[0]?.before).toMatchObject({ timezone: "Asia/Ho_Chi_Minh", business_day_cutoff: "00:00" });
    expect(a.rows[0]?.after).toMatchObject({ timezone: "Asia/Bangkok", business_day_cutoff: "04:00" });
  });

  it("không đổi gì (cùng giá trị) → 200, changed rỗng, không audit/outbox mới", async () => {
    const { user, org } = await ownerWithOrg();
    const property_id = await propertyOf(org, user);
    const r = await call(
      "org",
      "property.update",
      user,
      { property_id, timezone: "Asia/Ho_Chi_Minh" },
      { org },
    );
    expect(r.status).toBe(200);
    expect((r.body.data as unknown as { changed: string[] }).changed).toEqual([]);
    expect(await count("audit_events", org, sql`action = 'property.updated'`)).toBe(0);
  });

  it("S-023 cơ sở đã có allocation/chứng từ: đổi timezone hoặc giờ chốt → 409 PROPERTY_IN_USE, dữ liệu UTC không đổi; đổi tên vẫn được", async () => {
    const A = await seedOrg(t.admin, "KS có dữ liệu");
    await seedReservation(t.admin, { org: A, bookerPersonId: A.ownerPersonId });
    const before = await sql<{
      created_at: Date;
      timezone: string;
    }>`select created_at, timezone from properties where id = ${A.propertyId}`.execute(t.admin);
    const own = (body: object) =>
      call(
        "org",
        "property.update",
        A.ownerAuthUserId,
        { property_id: A.propertyId, ...body },
        { org: A.orgId },
      );
    for (const body of [
      { timezone: "Asia/Bangkok" },
      { business_day_cutoff: "05:00" },
      { timezone: "Asia/Bangkok", name: "Tên khác" },
    ]) {
      const r = await own(body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.code).toBe("PROPERTY_IN_USE");
    }
    const after = await sql<{
      created_at: Date;
      timezone: string;
      name: string;
    }>`select created_at, timezone, name from properties where id = ${A.propertyId}`.execute(t.admin);
    expect(after.rows[0]?.timezone).toBe(before.rows[0]?.timezone);
    expect(after.rows[0]?.name).not.toBe("Tên khác");
    expect((await own({ name: "Chỉ đổi tên" })).status).toBe(200);
  });

  it("trigger ở CSDL chặn cả đường ghi SQL trực tiếp (không chỉ lệnh); hợp đồng cũng tính là dữ liệu; cơ sở khác tổ chức không bị ảnh hưởng", async () => {
    const A = await seedOrg(t.admin, "KS hợp đồng");
    const B = await seedOrg(t.admin, "KS rỗng");
    await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: A.ownerPersonId,
    });
    await expect(
      sql`update properties set timezone = 'Asia/Bangkok' where id = ${A.propertyId}`.execute(t.admin),
    ).rejects.toMatchObject({ hint: "PROPERTY_IN_USE" });
    await expect(
      sql`update properties set business_day_cutoff = '03:00' where id = ${A.propertyId}`.execute(t.admin),
    ).rejects.toMatchObject({ hint: "PROPERTY_IN_USE" });
    await sql`update properties set timezone = 'Asia/Bangkok' where id = ${B.propertyId}`.execute(t.admin);
    // Cùng giá trị: không phải thay đổi ⇒ không bị chặn dù đã có dữ liệu.
    await sql`update properties set timezone = timezone where id = ${A.propertyId}`.execute(t.admin);
  });

  it("property.update: cơ sở không tồn tại/của tổ chức khác → 404; không trường nào → 422; mixed khi cờ tắt → 409", async () => {
    const { user, org } = await ownerWithOrg();
    const other = await seedOrg(t.admin, "KS khác");
    const property_id = await propertyOf(org, user);
    expect(
      (await call("org", "property.update", user, { property_id: other.propertyId, name: "X" }, { org }))
        .status,
    ).toBe(404);
    expect(
      (await call("org", "property.update", user, { property_id: randomUUID(), name: "X" }, { org })).status,
    ).toBe(404);
    expect((await call("org", "property.update", user, { property_id }, { org })).status).toBe(422);
    const m = await call("org", "property.update", user, { property_id, template: "mixed" }, { org });
    expect(m.status).toBe(409);
    expect(m.body.code).toBe("FEATURE_DISABLED");
    const clear = await call("org", "property.update", user, { property_id, check_in_time: null }, { org });
    expect(clear.status).toBe(200);
  });
});
