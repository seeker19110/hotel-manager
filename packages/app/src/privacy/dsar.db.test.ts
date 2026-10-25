// T-2311 (STD-PRIV-004, CMP-RIGHTS-007, CMP-INTL-007, CMP-PRIV-005, CMP-VN-007; D-120, D-124) — DSAR trên Postgres thật: hạn theo vùng,
// xuất đủ phần và không lộ dữ liệu người khác, xoá lan mọi kho (truy vấn từng kho sau xoá) nhưng GIỮ đồng ý + chứng từ có lý do, xác thực
// lại ≤ 5 phút (401 REAUTH_REQUIRED), owner duy nhất bị chặn (kể cả hai owner xoá song song), hạn chế xử lý làm `track()` bỏ qua, metric
// quá hạn, quyền của hàm/bảng (runtime vs worker).
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedOrg,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsActorKey, forgetAnalyticsActor, pseudonymizeActor, track } from "../analytics/index.ts";
import { handleDsarGet, handleDsarPost } from "../http/dsar-route.ts";
import { setAppLogger } from "../logging/index.ts";
import { collectMetrics } from "../observability/metrics.ts";
import {
  DSAR_DEFAULT_REGION,
  DsarError,
  dsarDays,
  dsarDueAt,
  dsarStatus,
  exportPersonalData,
  grantConsent,
  normalizeDsarRegion,
  processDsarErasures,
  requestAccountDeletion,
  setProcessingRestriction,
} from "./index.ts";

const BASE = "http://localhost:3000";
const KEY = analyticsActorKey("k".repeat(48));
const H = 3_600_000;

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS DSAR A");
  B = await seedOrg(t.admin, "Nhà trọ DSAR B", "rental");
});
afterAll(async () => {
  await t?.drop();
});

const fresh = () => new Date(Date.now() - 30_000);
const sink = () => ({ db: t.runtime, actorKey: KEY });
const forget = (u: string) => forgetAnalyticsActor(t.worker, KEY, u);

async function user(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@example.test`;
  const id = await seedAuthUser(t.admin, email);
  await sql`insert into auth.account ("accountId", "providerId", "userId", password, "updatedAt")
            values (${id}, 'credential', ${id}, 'hash-gia', now())`.execute(t.admin);
  await sql`insert into auth."session" (token, "userId", "expiresAt", "updatedAt", "ipAddress", "userAgent")
            values (${`tok-${randomUUID()}`}, ${id}, now() + interval '1 day', now(), '203.0.113.9', 'UA thử')`.execute(
    t.admin,
  );
  return { id, email };
}

async function member(
  org: SeededOrg,
  userId: string,
  role: string,
  name: string,
): Promise<{ personId: string }> {
  const personId = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email, phone)
            values (${personId}, ${org.orgId}, ${name}, ${`nguoi-${personId.slice(0, 8)}@example.test`}, '0900000001')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${randomUUID()}, ${org.orgId}, ${userId}, ${personId}, ${role}, ${role === "owner"})`.execute(
    t.admin,
  );
  return { personId };
}

async function eventsOf(userId: string): Promise<number> {
  const r = await sql<{
    n: number;
  }>`select count(*)::int as n from product_events where actor_key = ${pseudonymizeActor(KEY, userId)}`.execute(
    t.admin,
  );
  return r.rows[0]?.n ?? 0;
}

const count = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(t.admin)).rows[0]?.n ?? 0;

describe("hạn trả lời theo vùng (CMP-INTL-007, CMP-VN-007)", () => {
  const at = new Date("2026-10-25T00:00:00Z");
  it.each([
    ["VN", "delete", 72],
    ["VN", "access", 72],
    ["EU", "access", 30 * 24],
    ["UK", "delete", 30 * 24],
    ["CA", "access", 45 * 24],
    ["SG", "restrict", 30 * 24],
    ["TH", "access", 30 * 24],
    [DSAR_DEFAULT_REGION, "access", 72],
    ["ZZ", "delete", 72],
    ["", "access", 72],
  ] as const)("%s/%s → %i giờ", (region, kind, hours) => {
    expect(dsarDueAt(kind, at, region).getTime() - at.getTime()).toBe(hours * H);
  });
  it("chuẩn hoá vùng: chữ thường/khoảng trắng ⇒ mã; lạ/null ⇒ DEFAULT; dsar_days đúng số ngày", () => {
    expect(normalizeDsarRegion(" eu ")).toBe("EU");
    expect(normalizeDsarRegion(null)).toBe(DSAR_DEFAULT_REGION);
    expect(normalizeDsarRegion("__proto__")).toBe(DSAR_DEFAULT_REGION);
    expect(dsarDays("access", "CA")).toBe(45);
    expect(dsarDays("delete")).toBe(3);
  });
  it("yêu cầu ghi vào CSDL dùng DEFAULT (chặt nhất) và due_at = received_at + 72 giờ", async () => {
    const u = await user("han");
    const now = new Date("2026-10-25T08:00:00Z");
    await exportPersonalData(t.runtime, { userId: u.id, authenticatedAt: now, analyticsActor: null, now });
    const r = await sql<{ region: string; received_at: Date; due_at: Date; status: string }>`
      select region, received_at, due_at, status from dsar_requests where subject_user_id = ${u.id}`.execute(
      t.admin,
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as { region: string; received_at: Date; due_at: Date; status: string };
    expect(row.region).toBe("DEFAULT");
    expect(row.status).toBe("completed");
    expect(row.due_at.getTime() - row.received_at.getTime()).toBe(72 * H);
  });
});

describe("truy cập — xuất dữ liệu của CHÍNH mình (STD-PRIV-004 rights-access)", () => {
  it("đủ phần: tài khoản, phương thức đăng nhập, phiên, thành viên mọi tổ chức, đồng ý, sự kiện; không lộ dữ liệu người khác", async () => {
    const u = await user("xuat");
    const v = await user("nguoi-khac");
    await member(A, u.id, "manager", "Quan Ly Xuat");
    await member(B, u.id, "front_desk", "Le Tan Xuat");
    await member(A, v.id, "front_desk", "Nguoi Khac Bi Mat");
    for (const x of [u, v])
      await grantConsent(t.runtime, { subjectId: x.id, purpose: "product_analytics", channel: "settings" });
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: u.id, props: {} });
    await track(sink(), { event: "organization.registered", orgId: B.orgId, userId: u.id, props: {} });
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: v.id, props: {} });

    const out = await exportPersonalData(t.runtime, {
      userId: u.id,
      authenticatedAt: fresh(),
      analyticsActor: pseudonymizeActor(KEY, u.id),
    });
    expect(out.format).toBe("hm-dsar-access/1");
    expect(out.account?.email).toBe(u.email);
    expect(out.login_methods).toEqual([expect.objectContaining({ provider: "credential" })]);
    expect(out.sessions).toHaveLength(1);
    expect(out.memberships.map((m) => [m.organization_name, m.role, m.person.full_name]).sort()).toEqual([
      ["KS DSAR A", "manager", "Quan Ly Xuat"],
      ["Nhà trọ DSAR B", "front_desk", "Le Tan Xuat"],
    ]);
    expect(out.consents).toEqual([
      expect.objectContaining({ purpose: "product_analytics", action: "grant" }),
    ]);
    expect(out.analytics).toEqual({
      pseudonymous: true,
      total: 2,
      by_event: [expect.objectContaining({ event: "organization.registered", count: 2 })],
    });
    expect(out.dsar_requests[0]).toEqual(expect.objectContaining({ kind: "access", status: "completed" }));
    const text = JSON.stringify(out);
    expect(text).not.toContain(v.email);
    expect(text).not.toContain(v.id);
    expect(text).not.toContain("Nguoi Khac Bi Mat");
    expect(text).not.toContain("hash-gia"); // không xuất băm mật khẩu
    expect(text).not.toContain("tok-"); // không xuất token phiên

    // RLS: ngữ cảnh người khác không thấy yêu cầu của u.
    const seen = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.auth_user_id', ${v.id}, true)`.execute(trx);
      return (await sql`select 1 from dsar_requests where subject_user_id = ${u.id}`.execute(trx)).rows
        .length;
    });
    expect(seen).toBe(0);
  });

  it("chưa xác thực lại (> 5 phút, thiếu, ở tương lai) ⇒ 401 REAUTH_REQUIRED, không ghi yêu cầu", async () => {
    const u = await user("reauth");
    for (const at of [new Date(Date.now() - 6 * 60_000), undefined, new Date(Date.now() + 10 * 60_000)]) {
      const err = await exportPersonalData(t.runtime, {
        userId: u.id,
        authenticatedAt: at,
        analyticsActor: null,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DsarError);
      expect((err as DsarError).code).toBe("REAUTH_REQUIRED");
      expect((err as DsarError).status).toBe(401);
    }
    const del = await requestAccountDeletion(t.runtime, {
      userId: u.id,
      authenticatedAt: new Date(Date.now() - 301_000),
      confirmEmail: u.email,
    }).catch((e: unknown) => e);
    expect((del as DsarError).code).toBe("REAUTH_REQUIRED");
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from dsar_requests where subject_user_id = ${u.id}`,
      ),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth."session" where "userId" = ${u.id}`),
    ).toBe(1);
  });
});

describe("xoá tài khoản — lan mọi kho, giữ phần nghĩa vụ pháp lý (CMP-RIGHTS-007, CMP-PRIV-005)", () => {
  it("pha 1 + pha 2: phiên/mật khẩu/2FA/analytics/thành viên/hồ sơ hết; đồng ý + chứng từ + hồ sơ gắn chứng từ còn, có lý do", async () => {
    const u = await user("xoa");
    const v = await user("giu-nguyen");
    const inA = await member(A, u.id, "manager", "Quan Ly Xoa");
    const inB = await member(B, u.id, "front_desk", "Khach No Tien");
    await member(A, v.id, "front_desk", "Nguoi Van O Lai");
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: B.orgId,
      propertyId: B.propertyId,
      payerPersonId: inB.personId,
      lines: [{ amount: 150_000 }],
    });
    await sql`insert into auth."twoFactor" (secret, "backupCodes", "userId") values ('s', 'c', ${u.id})`.execute(
      t.admin,
    );
    for (const x of [u, v])
      await grantConsent(t.runtime, { subjectId: x.id, purpose: "product_analytics", channel: "settings" });
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: u.id, props: {} });
    await track(sink(), { event: "organization.registered", orgId: B.orgId, userId: u.id, props: {} });
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: v.id, props: {} });
    await setProcessingRestriction(t.runtime, { userId: u.id, active: true });
    const consentsBefore = await count(
      sql<{ n: number }>`select count(*)::int as n from consent_records where subject_user_id = ${u.id}`,
    );

    // Gõ lại email: khác hoa thường/khoảng trắng vẫn khớp; sai ⇒ 422, không đổi gì.
    const wrong = await requestAccountDeletion(t.runtime, {
      userId: u.id,
      authenticatedAt: fresh(),
      confirmEmail: v.email,
    }).catch((e: unknown) => e);
    expect((wrong as DsarError).code).toBe("CONFIRMATION_MISMATCH");
    expect((wrong as DsarError).status).toBe(422);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth."session" where "userId" = ${u.id}`),
    ).toBe(1);

    const r = await requestAccountDeletion(t.runtime, {
      userId: u.id,
      authenticatedAt: fresh(),
      confirmEmail: `  ${u.email.toUpperCase()} `,
    });
    expect(r.created).toBe(true);
    expect(r.revokedSessions).toBe(1);
    // Pha 1 xong ngay: không phiên, không mật khẩu, không 2FA, email/tên không định danh, dấu vết phiên đã thu hồi.
    const id = u.id;
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth."session" where "userId" = ${id}`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth.account where "userId" = ${id}`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth."twoFactor" where "userId" = ${id}`),
    ).toBe(0);
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from auth.revoked_session where user_id = ${id}`,
      ),
    ).toBe(1);
    const au = await sql<{
      name: string;
      email: string;
    }>`select name, email from auth."user" where id = ${id}`.execute(t.admin);
    expect(au.rows[0]).toEqual({ name: "—", email: `deleted-${id}@deleted.invalid` });
    // Gửi lại (bấm hai lần) ⇒ cùng yêu cầu, không tạo thêm.
    const again = await requestAccountDeletion(t.runtime, {
      userId: id,
      authenticatedAt: fresh(),
      confirmEmail: "x",
    });
    expect(again).toEqual(expect.objectContaining({ requestId: r.requestId, created: false }));

    // Pha 2 (worker).
    const s1 = await processDsarErasures(t.worker, { forgetAnalytics: forget });
    expect(s1.failed).toBe(0);
    expect(s1.completed).toBeGreaterThanOrEqual(1);
    // Analytics: hết của u, của v còn.
    expect(await eventsOf(id)).toBe(0);
    expect(await eventsOf(v.id)).toBe(1);
    // Thành viên: mọi tổ chức đã kết thúc, có audit worker ở từng tổ chức.
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from memberships where auth_user_id = ${id} and status <> 'revoked'`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where correlation_id = ${`dsar:${r.requestId}`}
                           and actor_type = 'worker' and action = 'membership.revoked'`,
      ),
    ).toBe(2);
    // Hồ sơ người: không gắn chứng từ ⇒ ẩn danh; gắn phiếu thu ⇒ GIỮ (nghĩa vụ kế toán).
    const pa = await sql<{
      full_name: string;
      email: string | null;
      phone: string | null;
      anonymized_at: Date | null;
    }>`
      select full_name, email, phone, anonymized_at from persons where id = ${inA.personId}`.execute(t.admin);
    expect(pa.rows[0]).toEqual(expect.objectContaining({ full_name: "—", email: null, phone: null }));
    expect(pa.rows[0]?.anonymized_at).not.toBeNull();
    const pb = await sql<{
      full_name: string;
    }>`select full_name from persons where id = ${inB.personId}`.execute(t.admin);
    expect(pb.rows[0]?.full_name).toBe("Khach No Tien");
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from invoices where id = ${inv.invoiceId}`),
    ).toBe(1);
    // Đồng ý: GIỮ nguyên (bằng chứng, D-124). Hạn chế xử lý: xoá.
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from consent_records where subject_user_id = ${id}`,
      ),
    ).toBe(consentsBefore);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from processing_restrictions where subject_user_id = ${id}`,
      ),
    ).toBe(0);
    // Yêu cầu đóng với result không PII, liệt kê kho giữ lại + lý do.
    const req = await sql<{ status: string; completed_at: Date | null; result: Record<string, unknown> }>`
      select status, completed_at, result from dsar_requests where id = ${r.requestId}`.execute(t.admin);
    const row = req.rows[0] as { status: string; completed_at: Date | null; result: Record<string, unknown> };
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
    expect(row.result.erased).toEqual(
      expect.objectContaining({
        product_events: 2,
        memberships_ended: 2,
        persons_anonymized: 1,
        processing_restrictions: 1,
      }),
    );
    expect(row.result.retained).toEqual(
      expect.arrayContaining([
        { store: "consent_records", rows: consentsBefore, reason: "legal_obligation_consent_proof" },
        { store: "persons", rows: 1, reason: "accounting_records_retention" },
      ]),
    );
    expect(row.result.outside_repo).toEqual([{ store: "backups", reason: "expires_per_RET_10" }]);
    const resultText = JSON.stringify(row.result);
    for (const pii of [u.email, "Quan Ly Xoa", "Khach No Tien", id]) expect(resultText).not.toContain(pii);
    // Người khác không bị đụng.
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from auth."session" where "userId" = ${v.id}`),
    ).toBe(1);
    // Chạy lại: idempotent.
    const s2 = await processDsarErasures(t.worker, { forgetAnalytics: forget });
    expect(s2).toEqual({ completed: 0, failed: 0 });
  });

  it("owner active DUY NHẤT bị chặn (409 SOLE_OWNER, không ghi gì); có owner thứ hai thì được", async () => {
    const solo = await seedOrg(t.admin, "KS một chủ");
    await sql`insert into auth.account ("accountId", "providerId", "userId", password, "updatedAt")
              values (${solo.ownerAuthUserId}, 'credential', ${solo.ownerAuthUserId}, 'h', now())`.execute(
      t.admin,
    );
    const email = (
      await sql<{ email: string }>`select email from auth."user" where id = ${solo.ownerAuthUserId}`.execute(
        t.admin,
      )
    ).rows[0]?.email as string;
    expect((await dsarStatus(t.runtime, solo.ownerAuthUserId)).soleOwnerOrgs).toBe(1);
    const err = await requestAccountDeletion(t.runtime, {
      userId: solo.ownerAuthUserId,
      authenticatedAt: fresh(),
      confirmEmail: email,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DsarError);
    expect((err as DsarError).code).toBe("SOLE_OWNER");
    expect((err as DsarError).status).toBe(409);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from auth.account where "userId" = ${solo.ownerAuthUserId}`,
      ),
    ).toBe(1);
    const co = await user("dong-chu");
    await member(solo, co.id, "owner", "Dong Chu");
    expect((await dsarStatus(t.runtime, solo.ownerAuthUserId)).soleOwnerOrgs).toBe(0);
    const ok = await requestAccountDeletion(t.runtime, {
      userId: solo.ownerAuthUserId,
      authenticatedAt: fresh(),
      confirmEmail: email,
    });
    expect(ok.created).toBe(true);
    // Owner còn lại giờ là duy nhất (người kia đang chờ xoá không tính).
    expect((await dsarStatus(t.runtime, co.id)).soleOwnerOrgs).toBe(1);
    expect((await processDsarErasures(t.worker, { forgetAnalytics: forget })).failed).toBe(0);
  });

  it("đồng thời: hai owner của cùng tổ chức xoá song song ⇒ đúng một được, người kia 409; worker không vi phạm 'còn owner'", async () => {
    const org = await seedOrg(t.admin, "KS hai chủ");
    const o1 = { id: org.ownerAuthUserId };
    const o1mail = (
      await sql<{ email: string }>`select email from auth."user" where id = ${o1.id}`.execute(t.admin)
    ).rows[0]?.email as string;
    const o2 = await user("chu-hai");
    await member(org, o2.id, "owner", "Chu Hai");
    const results = await Promise.allSettled([
      requestAccountDeletion(t.runtime, { userId: o1.id, authenticatedAt: fresh(), confirmEmail: o1mail }),
      requestAccountDeletion(t.runtime, { userId: o2.id, authenticatedAt: fresh(), confirmEmail: o2.email }),
    ]);
    const ok = results.filter((x) => x.status === "fulfilled");
    const bad = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(((bad[0] as PromiseRejectedResult).reason as DsarError).code).toBe("SOLE_OWNER");
    expect((await processDsarErasures(t.worker, { forgetAnalytics: forget })).failed).toBe(0);
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from memberships
                           where organization_id = ${org.orgId} and role = 'owner' and status = 'active'`,
      ),
    ).toBe(1);
  });
});

describe("xoá tài khoản — lúc thực hiện đã thành owner duy nhất", () => {
  it("worker đánh yêu cầu `rejected` kèm lý do (không ném mỗi lượt, không kẹt quá hạn); membership giữ nguyên", async () => {
    const org = await seedOrg(t.admin, "KS chủ còn lại");
    const o1 = { id: org.ownerAuthUserId };
    const o1mail = (
      await sql<{ email: string }>`select email from auth."user" where id = ${o1.id}`.execute(t.admin)
    ).rows[0]?.email as string;
    const o2 = await user("chu-roi-di");
    await member(org, o2.id, "owner", "Chu Roi Di");
    // Lúc yêu cầu: còn owner khác ⇒ được nhận.
    const ok = await requestAccountDeletion(t.runtime, {
      userId: o1.id,
      authenticatedAt: fresh(),
      confirmEmail: o1mail,
    });
    expect(ok.created).toBe(true);
    // Trước khi worker chạy, owner kia rời đi ⇒ o1 thành owner duy nhất.
    await sql`update memberships set status = 'revoked', revoked_at = now()
              where organization_id = ${org.orgId} and auth_user_id = ${o2.id}`.execute(t.admin);
    const stats = await processDsarErasures(t.worker, { forgetAnalytics: forget });
    expect(stats.failed).toBe(0);
    const req = await sql<{ status: string; completed: boolean; result: { rejected_reason?: string } }>`
      select status, completed_at is not null as completed, result from dsar_requests
      where subject_user_id = ${o1.id} and kind = 'delete'`.execute(t.admin);
    expect(req.rows).toEqual([
      {
        status: "rejected",
        completed: true,
        result: expect.objectContaining({ rejected_reason: "last_owner" }),
      },
    ]);
    // Không còn trong hàng đợi; lượt sau không lỗi.
    expect((await processDsarErasures(t.worker, { forgetAnalytics: forget })).failed).toBe(0);
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from memberships
                           where organization_id = ${org.orgId} and role = 'owner' and status = 'active'`,
      ),
    ).toBe(1);
  });
});

describe("hạn chế xử lý (restrict) — track() bỏ qua actor", () => {
  it("bật ⇒ không ghi sự kiện dù đã đồng ý; bấm lại cùng trạng thái không sinh yêu cầu; tắt ⇒ ghi lại", async () => {
    const u = await user("han-che");
    await grantConsent(t.runtime, { subjectId: u.id, purpose: "product_analytics", channel: "settings" });
    const on = await setProcessingRestriction(t.runtime, { userId: u.id, active: true });
    expect(on).toEqual(expect.objectContaining({ active: true, changed: true }));
    expect((await setProcessingRestriction(t.runtime, { userId: u.id, active: true })).changed).toBe(false);
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: u.id, props: {} });
    expect(await eventsOf(u.id)).toBe(0);
    expect((await dsarStatus(t.runtime, u.id)).restricted).toBe(true);
    await setProcessingRestriction(t.runtime, { userId: u.id, active: false });
    await track(sink(), { event: "organization.registered", orgId: A.orgId, userId: u.id, props: {} });
    expect(await eventsOf(u.id)).toBe(1);
    const reqs = await sql<{ kind: string; status: string; result: { active: boolean } }>`
      select kind, status, result from dsar_requests where subject_user_id = ${u.id} order by received_at, id`.execute(
      t.admin,
    );
    expect(reqs.rows.map((x) => [x.kind, x.status, x.result.active])).toEqual([
      ["restrict", "completed", true],
      ["restrict", "completed", false],
    ]);
  });

  it("bật/tắt song song cùng người ⇒ trạng thái cuối nhất quán, mỗi lần đổi đúng một yêu cầu", async () => {
    const u = await user("song-song");
    await Promise.all([
      setProcessingRestriction(t.runtime, { userId: u.id, active: true }),
      setProcessingRestriction(t.runtime, { userId: u.id, active: true }),
      setProcessingRestriction(t.runtime, { userId: u.id, active: true }),
    ]);
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from dsar_requests where subject_user_id = ${u.id}`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from processing_restrictions where subject_user_id = ${u.id}`,
      ),
    ).toBe(1);
  });
});

describe("metric quá hạn hm_dsar_overdue (CMP-INTL-007)", () => {
  const overdue = async () =>
    (await collectMetrics(t.runtime)).find((s) => s.name === "hm_dsar_overdue")?.value ?? Number.NaN;
  it("chỉ đếm yêu cầu chưa xong đã qua due_at; không nhãn", async () => {
    const before = await overdue();
    expect(Number.isFinite(before)).toBe(true);
    const u = await user("qua-han");
    await sql`insert into dsar_requests (subject_user_id, kind, region, received_at, due_at)
              values (${u.id}, 'delete', 'VN', now() - interval '4 days', now() - interval '1 day'),
                     (${u.id}, 'access', 'VN', now() - interval '1 hour', now() + interval '71 hours')`.execute(
      t.admin,
    );
    await sql`insert into dsar_requests (subject_user_id, kind, region, received_at, due_at, completed_at, status)
              values (${u.id}, 'access', 'EU', now() - interval '40 days', now() - interval '10 days', now(), 'completed')`.execute(
      t.admin,
    );
    expect(await overdue()).toBe(before + 1);
    const s = (await collectMetrics(t.runtime)).find((x) => x.name === "hm_dsar_overdue");
    expect(s?.labels).toEqual({});
  });
});

describe("quyền: runtime chỉ của mình, worker chỉ qua hàm", () => {
  it("runtime không gọi được hàm xoá của worker, không UPDATE dsar_requests; worker không đọc bảng trực tiếp", async () => {
    const id = randomUUID();
    await expect(sql`select app.dsar_complete_erasure(${id}::uuid, 0)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`select * from app.dsar_open_erasures(1)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`update dsar_requests set status = 'completed'`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`select * from dsar_requests`.execute(t.worker)).rejects.toThrow(/permission denied/);
    await expect(sql`select * from processing_restrictions`.execute(t.worker)).rejects.toThrow(
      /permission denied/,
    );
    // Không ngữ cảnh người dùng ⇒ hàm của runtime không trả gì.
    expect((await sql`select * from app.dsar_my_memberships()`.execute(t.runtime)).rows).toEqual([]);
    expect(
      (await sql<{ n: number }>`select app.dsar_sole_owner_orgs() as n`.execute(t.runtime)).rows[0]?.n,
    ).toBe(0);
    // Ghi yêu cầu cho người khác bị RLS chặn.
    const u = await user("rls");
    const v = await user("rls-khac");
    await expect(
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.auth_user_id', ${u.id}, true)`.execute(trx);
        await sql`insert into dsar_requests (subject_user_id, kind, region, due_at)
                  values (${v.id}, 'access', 'VN', now() + interval '1 day')`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("API /api/v1/privacy/dsar — chủ thể = phiên", () => {
  const deps = (createdAt: Date) => ({
    db: t.runtime,
    services: { analyticsKey: KEY },
    getSession: async (h: Headers) => {
      const id = h.get("x-test-user");
      return id ? { user: { id }, session: { createdAt } } : null;
    },
  });
  const post = (who: string | undefined, body: unknown, createdAt = fresh()) =>
    handleDsarPost(
      new Request(`${BASE}/api/v1/privacy/dsar`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}) },
        body: JSON.stringify(body),
      }),
      deps(createdAt),
    );

  it("không phiên ⇒ 401; phiên cũ ⇒ 401 REAUTH_REQUIRED; thân lạ ⇒ 422; xuất ⇒ tệp JSON đính kèm", async () => {
    expect((await handleDsarGet(new Request(`${BASE}/api/v1/privacy/dsar`), deps(fresh()))).status).toBe(401);
    expect((await post(undefined, { action: "access" })).status).toBe(401);
    const u = await user("api");
    const old = await post(u.id, { action: "access" }, new Date(Date.now() - 10 * 60_000));
    expect(old.status).toBe(401);
    expect(((await old.json()) as { code: string }).code).toBe("REAUTH_REQUIRED");
    expect((await post(u.id, { action: "access", user_id: randomUUID() })).status).toBe(422);
    const events: string[] = [];
    setAppLogger(
      new Proxy({} as never, {
        get: (_t, k) => (k === "security" ? (e: string) => events.push(e) : () => undefined),
      }),
    );
    let res: Response;
    try {
      res = await post(u.id, { action: "access" });
    } finally {
      setAppLogger(undefined);
    }
    expect(res.status).toBe(200);
    expect(events).toContain("privacy.dsar_requested");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="du-lieu-ca-nhan-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(((await res.json()) as { account: { email: string } }).account.email).toBe(u.email);
    const st = await handleDsarGet(
      new Request(`${BASE}/api/v1/privacy/dsar`, { headers: { "x-test-user": u.id } }),
      deps(fresh()),
    );
    expect(((await st.json()) as { requests: { kind: string }[] }).requests.map((r) => r.kind)).toEqual([
      "access",
    ]);
  });

  it("xoá qua API ⇒ 202 received; owner duy nhất ⇒ 409 SOLE_OWNER kèm số tổ chức", async () => {
    const u = await user("api-xoa");
    const res = await post(u.id, { action: "delete", confirm_email: u.email });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("received");
    const solo = await seedOrg(t.admin, "KS API một chủ");
    const mail = (
      await sql<{ email: string }>`select email from auth."user" where id = ${solo.ownerAuthUserId}`.execute(
        t.admin,
      )
    ).rows[0]?.email as string;
    const blocked = await post(solo.ownerAuthUserId, { action: "delete", confirm_email: mail });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual(expect.objectContaining({ code: "SOLE_OWNER", sole_owner_orgs: 1 }));
  });
});
