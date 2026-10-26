// PLAN T-2311 (STD-PRIV-004, CMP-VN-007, CMP-INTL-007, CMP-RIGHTS-007, CMP-PRIV-005; D-123; migration 0069) — quyền chủ thể trên
// Postgres thật, bằng vai trò `app_runtime` (tạo/đọc yêu cầu, RLS theo người dùng) và `app_worker` (xử lý) như chạy thật:
// hạn `due_at` theo vùng; xoá cần xác thực lại; một yêu cầu mở cùng loại (kể cả đồng thời); owner duy nhất bị chặn; worker xoá ⇒ truy
// vấn TỪNG kho (auth.user/session/account/twoFactor/verification/login_throttle, membership, product_events, files, gói truy cập) và
// phần GIỮ (hoá đơn, sổ, audit, consent_records, persons) còn nguyên; gói truy cập chỉ chứa dữ liệu của chính mình, tải qua URL ký,
// hết hạn thì object bị xoá; RLS A không thấy của B; metric quá hạn; hạn chế ⇒ `trackCommand` không ghi; handler HTTP được phép/bị chặn.
import { createHash, randomUUID } from "node:crypto";
import { withUserContext } from "@hm/db";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedOrg,
  type TestDb,
  testS3Config,
} from "@hm/testkit";
import { type RawBuilder, sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveActor } from "../access/actor.ts";
import { configureAnalytics, resetAnalytics } from "../analytics/index.ts";
import { createPeriod } from "../billing/billing.ts";
import { ObjectStorage } from "../files/index.ts";
import {
  type DataRequestDeps,
  handleCreateDataRequest,
  handleDownloadDataRequest,
  handleListDataRequests,
} from "../http/data-requests.ts";
import { collectMetrics } from "../observability/metrics.ts";
import { executeCommand } from "../pipeline/command.ts";
import { testServices } from "../server/services.ts";
import {
  createAnalyticsConsentCheck,
  createDsarRequest,
  DSAR_DAYS,
  DSAR_REGIONS,
  DSAR_TYPES,
  DsarError,
  dsarDownloadUrl,
  dsarObjectKey,
  dsarOverview,
  expireDsarResults,
  grantConsent,
  hasConsent,
  processDsarRequests,
} from "./index.ts";

let t: TestDb;
let storage: ObjectStorage;
let A: SeededOrg;

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  A = await seedOrg(t.admin, "Nhà trọ Quyền Chủ Thể", "rental");
});
afterAll(async () => {
  await t?.drop();
});
afterEach(() => resetAnalytics());

const DAY_S = 86_400;
const now = () => new Date();
const newUser = (email = `u-${randomUUID()}@example.com`) => seedAuthUser(t.admin, email);

/** Kho giả đếm thao tác (khi không cần S3 thật). */
function fakeStorage() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    puts,
    deletes,
    async put(key: string, body: Uint8Array) {
      puts.push(key);
      objects.set(key, body);
    },
    async delete(key: string) {
      deletes.push(key);
      objects.delete(key);
    },
  };
}

const q = async <T>(query: RawBuilder<T>) => (await query.execute(t.admin)).rows;
/** Xử lý hết yêu cầu còn treo của các test trước (worker nhận việc toàn hệ thống) để số đếm của test sau là của riêng nó. */
const drain = () => processDsarRequests(t.worker, { storage: fakeStorage() });

const reqRow = async (id: string) =>
  (
    await sql<{
      status: string;
      type: string;
      result_summary: Record<string, unknown> | null;
      legal_retention_note: string | null;
      result_file_key: string | null;
      completed_at: Date | null;
    }>`select status, type, result_summary, legal_retention_note, result_file_key, completed_at
       from dsar_requests where id = ${id}`.execute(t.admin)
  ).rows[0];

/** Người dùng là thành viên (vai trò tuỳ chọn) của tổ chức, có hồ sơ người; trả id membership + person. */
async function addMember(org: SeededOrg, userId: string, role: string, name: string, email: string) {
  const personId = randomUUID();
  const membershipId = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, email, phone)
            values (${personId}, ${org.orgId}, ${name}, ${email}, '0100000099')`.execute(t.admin);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membershipId}, ${org.orgId}, ${userId}, ${personId}, ${role}, ${role === "owner"})`.execute(
    t.admin,
  );
  return { personId, membershipId };
}

describe("dsar_requests — cấu trúc + hạn theo vùng (migration 0069, dsar-policy.ts)", () => {
  it("CHECK region/type của CSDL khớp đúng danh sách trong mã", async () => {
    const defs = (
      await sql<{ def: string }>`
        select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'public.dsar_requests'::regclass and c.contype = 'c'`.execute(t.admin)
    ).rows.map((r) => r.def);
    const values = (col: string) =>
      [...(defs.find((d) => d.startsWith(`CHECK ((${col} = ANY`)) ?? "").matchAll(/'([A-Za-z_]+)'::text/g)]
        .map((m) => m[1])
        .sort();
    expect(values("region")).toEqual([...DSAR_REGIONS].sort());
    expect(values("type")).toEqual([...DSAR_TYPES].sort());
  });

  it.each([
    ["VN", "access", 10],
    ["VN", "delete", 3],
    ["VN", "restrict", 3],
    ["EU", "access", 30],
    ["UK", "delete", 30],
    ["CA", "access", 45],
    ["SG", "access", 30],
    ["TH", "restrict", 30],
  ] as const)(
    "vùng %s, loại %s ⇒ due_at = requested_at + %i ngày (đúng theo DSAR_DAYS)",
    async (region, type, days) => {
      expect(DSAR_DAYS[region][type]).toBe(days);
      const u = await newUser();
      const r = await createDsarRequest(t.runtime, u, { type, region, reauthenticatedAt: now() });
      expect(r.status).toBe("created");
      expect(r.request.region).toBe(region);
      const x = await sql<{ secs: number }>`
      select extract(epoch from due_at - requested_at)::int as secs from dsar_requests where id = ${r.request.id}`.execute(
        t.admin,
      );
      expect(x.rows[0]?.secs).toBe(days * DAY_S);
    },
  );

  it("vùng mặc định là VN; truy cập/xoá vào hàng đợi `verified`, hạn chế đóng `completed` ngay", async () => {
    const u = await newUser();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    expect(a.request).toMatchObject({ region: "VN", status: "verified", type: "access", completedAt: null });
    const r = await createDsarRequest(t.runtime, u, { type: "restrict" });
    expect(r.request.status).toBe("completed");
    expect(r.request.completedAt).toBeInstanceOf(Date);
  });
});

describe("tạo yêu cầu — xác thực lại, idempotent, owner duy nhất, hạn mức", () => {
  it("xoá: không có/quá 5 phút/ở tương lai ⇒ REAUTH_REQUIRED, không ghi hàng; vừa xác thực lại ⇒ tạo", async () => {
    const u = await newUser();
    const at = now();
    for (const reauthenticatedAt of [
      undefined,
      null,
      new Date(at.getTime() - 301_000),
      new Date(at.getTime() + 120_000),
      new Date(Number.NaN),
    ])
      await expect(
        createDsarRequest(t.runtime, u, {
          type: "delete",
          now: at,
          ...(reauthenticatedAt === undefined ? {} : { reauthenticatedAt }),
        }),
      ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from dsar_requests where subject_user_id = ${u}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    // Biên: đúng 300 giây vẫn được.
    const ok = await createDsarRequest(t.runtime, u, {
      type: "delete",
      reauthenticatedAt: new Date(at.getTime() - 300_000),
      now: at,
    });
    expect(ok.status).toBe("created");
  });

  it("truy cập/hạn chế không cần xác thực lại (chỉ phiên)", async () => {
    const u = await newUser();
    expect((await createDsarRequest(t.runtime, u, { type: "access" })).status).toBe("created");
    expect((await createDsarRequest(t.runtime, u, { type: "restrict" })).status).toBe("created");
  });

  it("một yêu cầu mở cùng loại: gửi lại (kể cả 6 lần đồng thời) trả cùng yêu cầu; khác loại thì tạo riêng", async () => {
    const u = await newUser();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => createDsarRequest(t.runtime, u, { type: "access" })),
    );
    expect(new Set(rs.map((r) => r.request.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === "created")).toHaveLength(1);
    const del = await createDsarRequest(t.runtime, u, { type: "delete", reauthenticatedAt: now() });
    expect(del.request.id).not.toBe(rs[0]?.request.id);
    // Hạn chế: đã bật rồi ⇒ trả yêu cầu đã bật cờ, không thêm hàng.
    const r1 = await createDsarRequest(t.runtime, u, { type: "restrict" });
    const r2 = await createDsarRequest(t.runtime, u, { type: "restrict" });
    expect(r2).toMatchObject({ status: "existing", request: { id: r1.request.id } });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from dsar_requests where subject_user_id = ${u}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(3);
  });

  it("CSDL chặn hai yêu cầu mở cùng loại kể cả khi bỏ qua tầng ứng dụng (index unique một phần)", async () => {
    const u = await newUser();
    await createDsarRequest(t.runtime, u, { type: "access" });
    await expect(
      sql`insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at)
          values (${randomUUID()}, ${u}, 'access', 'verified', 'VN', now() + interval '1 day', now())`.execute(
        t.admin,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("owner active DUY NHẤT của một tổ chức ⇒ LAST_OWNER; có owner thứ hai thì được", async () => {
    const v = await newUser();
    const C = await seedOrg(t.admin, "Nhà nghỉ Chủ Duy Nhất", "rental", v);
    await expect(
      createDsarRequest(t.runtime, v, { type: "delete", reauthenticatedAt: now() }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
    const w = await newUser();
    await addMember(C, w, "owner", "Chủ thứ hai", `w-${randomUUID()}@example.com`);
    expect((await createDsarRequest(t.runtime, v, { type: "delete", reauthenticatedAt: now() })).status).toBe(
      "created",
    );
  });

  it("vượt 10 lần tạo mới/giờ ⇒ RATE_LIMITED (lượt gửi lại yêu cầu đang mở không tính)", async () => {
    const u = await newUser();
    await sql`insert into rate_limit_counters (scope, subject, window_start, hits)
              values ('dsar.request', ${u}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 10)`.execute(
      t.admin,
    );
    const err = await createDsarRequest(t.runtime, u, { type: "access" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DsarError);
    expect(err).toMatchObject({ code: "RATE_LIMITED" });
    expect((err as DsarError).retryAfter).toBeGreaterThan(0);
  });
});

describe("RLS theo người dùng (app.user_id)", () => {
  it("A không đọc được yêu cầu/cờ hạn chế của B; không ghi được hàng mang id của B; thiếu ngữ cảnh ⇒ lỗi", async () => {
    const a = await newUser();
    const b = await newUser();
    const rb = await createDsarRequest(t.runtime, b, { type: "restrict" });
    const seen = await withUserContext(t.runtime, a, async (trx) => ({
      req: (await sql`select id from dsar_requests where id = ${rb.request.id}`.execute(trx)).rows.length,
      flag: (await sql`select 1 from processing_restrictions where subject_user_id = ${b}`.execute(trx)).rows
        .length,
    }));
    expect(seen).toEqual({ req: 0, flag: 0 });
    expect((await dsarOverview(t.runtime, a)).requests).toEqual([]);
    await expect(
      withUserContext(t.runtime, a, (trx) =>
        sql`insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at)
            values (${randomUUID()}, ${b}, 'access', 'verified', 'VN', now() + interval '1 day', now())`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(sql`select count(*) from dsar_requests`.execute(t.runtime)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("app_runtime không UPDATE/DELETE được; không tự tạo yêu cầu `completed` cho truy cập/xoá; không đặt khoá gói", async () => {
    const a = await newUser();
    const r = await createDsarRequest(t.runtime, a, { type: "access" });
    await withUserContext(t.runtime, a, async (trx) => {
      await expect(
        sql`update dsar_requests set status = 'completed' where id = ${r.request.id}`.execute(trx),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await withUserContext(t.runtime, a, async (trx) => {
      await expect(
        sql`delete from dsar_requests where id = ${r.request.id}`.execute(trx),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await withUserContext(t.runtime, a, async (trx) => {
      await expect(
        sql`insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at, completed_at)
            values (${randomUUID()}, ${a}, 'delete', 'completed', 'VN', now() + interval '1 day', now(), now())`.execute(
          trx,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await withUserContext(t.runtime, a, async (trx) => {
      await expect(
        sql`insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at, result_file_key)
            values (${randomUUID()}, ${a}, 'restrict', 'completed', 'VN', now() + interval '1 day', now(), 'x')`.execute(
          trx,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    // Worker không đọc/ghi bảng trực tiếp — chỉ qua hàm.
    await expect(sql`select count(*) from dsar_requests`.execute(t.worker)).rejects.toMatchObject({
      code: "42501",
    });
    // Hàm của worker không cấp cho app_runtime.
    await expect(sql`select * from app.dsar_claim(now(), 15, 1)`.execute(t.runtime)).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("worker — xoá tài khoản lan mọi kho, giữ phần nghĩa vụ pháp lý (D-123)", () => {
  it("auth/phiên/membership/analytics/file bị xoá-ẩn danh-thu hồi; hoá đơn/sổ/audit/consent/persons còn nguyên", async () => {
    await drain();
    const email = `xoa-${randomUUID()}@example.com`;
    const u = await newUser(email);
    const B = await seedOrg(t.admin, "Khách sạn Đồng Chủ", "hotel");
    const tenant = await addMember(A, u, "tenant", "Người thuê Sẽ Xoá", email);
    const coOwner = await addMember(B, u, "owner", "Đồng chủ Sẽ Xoá", email);
    // Kho xác thực: 2 phiên, mật khẩu, TOTP, OTP chờ, bộ đếm khoá đăng nhập.
    const tokens = [`tok-${randomUUID()}`, `tok-${randomUUID()}`];
    for (const tok of tokens)
      await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId")
                values (${randomUUID()}, now() + interval '1 day', ${tok}, now(), ${u})`.execute(t.admin);
    await sql`insert into auth.account (id, "accountId", "providerId", "userId", password, "updatedAt")
              values (${randomUUID()}, ${u}, 'credential', ${u}, 'bam-mat-khau-gia', now())`.execute(t.admin);
    await sql`insert into auth."twoFactor" (id, secret, "backupCodes", "userId")
              values (${randomUUID()}, 'bi-mat-gia', 'ma-du-phong-gia', ${u})`.execute(t.admin);
    await sql`insert into auth.verification (id, identifier, value, "expiresAt")
              values (${randomUUID()}, ${`sign-in-otp-${email}`}, 'bam-otp:0', now() + interval '5 minutes')`.execute(
      t.admin,
    );
    const otherOtp = `sign-in-otp-khac-${randomUUID()}@example.com`;
    await sql`insert into auth.verification (id, identifier, value, "expiresAt")
              values (${randomUUID()}, ${otherOtp}, 'bam-otp:0', now() + interval '5 minutes')`.execute(
      t.admin,
    );
    const emailHash = createHash("sha256").update(email).digest();
    await sql`insert into auth.login_throttle (email_hash, failures) values (${emailHash}, 2)`.execute(
      t.admin,
    );
    // Analytics của người này (và của người khác — không đụng).
    for (let i = 0; i < 3; i++)
      await sql`insert into product_events (id, organization_id, name, schema_version, actor_user_id)
                values (${randomUUID()}, ${A.orgId}, 'billing_period.created', 1, ${u})`.execute(t.admin);
    await sql`insert into product_events (id, organization_id, name, schema_version, actor_user_id)
              values (${randomUUID()}, ${A.orgId}, 'billing_period.created', 1, ${A.ownerAuthUserId})`.execute(
      t.admin,
    );
    // Bản xuất (file riêng) do chính người này yêu cầu ở B.
    const jobId = randomUUID();
    const fileId = randomUUID();
    const key = `${B.orgId}/export_job/${fileId}`;
    await sql`insert into files (id, organization_id, owner_type, owner_id, mime, size_bytes, sha256, status, storage_key,
                                 uploaded_by, scanned_at, delete_after)
              values (${fileId}, ${B.orgId}, 'export_job', ${jobId}, 'text/csv', 10, ${"a".repeat(64)}, 'ready', ${key},
                      ${coOwner.membershipId}, now(), current_date + 3)`.execute(t.admin);
    await sql`insert into export_jobs (id, organization_id, kind, format, requested_by, scope_snapshot, status, file_key,
                                       expires_at, completed_at)
              values (${jobId}, ${B.orgId}, 'receivables', 'csv', ${coOwner.membershipId}, '{}', 'ready', ${key},
                      now() + interval '15 minutes', now())`.execute(t.admin);
    // Phần phải GIỮ: hoá đơn + bút toán của người thuê, audit, đồng ý.
    const inv = await seedIssuedInvoice(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      payerPersonId: tenant.personId,
      lines: [{ amount: 1_500_000 }],
    });
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "signup" });
    const kept = async () =>
      (
        await sql<{ inv: number; jl: number; audit: number; consent: number; person: string; total: string }>`
          select (select count(*)::int from invoices where id = ${inv.invoiceId}) as inv,
                 (select count(*)::int from journal_lines where invoice_id = ${inv.invoiceId}) as jl,
                 (select count(*)::int from audit_events where organization_id in (${A.orgId}, ${B.orgId})
                    and action <> 'member.account_deleted') as audit,
                 (select count(*)::int from consent_records where subject_user_id = ${u}) as consent,
                 (select full_name from persons where id = ${tenant.personId}) as person,
                 (select total::text from invoices where id = ${inv.invoiceId}) as total`.execute(t.admin)
      ).rows[0];
    const before = await kept();
    // Có cả yêu cầu truy cập đang mở ⇒ bị đóng `rejected` khi tài khoản bị xoá (không xuất dữ liệu đã ẩn danh).
    const access = await createDsarRequest(t.runtime, u, { type: "access" });
    const del = await createDsarRequest(t.runtime, u, { type: "delete", reauthenticatedAt: now() });
    const fake = fakeStorage();

    const logs: unknown[] = [];
    const run = await processDsarRequests(t.worker, { storage: fake, log: (e, f) => logs.push([e, f]) });
    expect(logs.filter((l) => (l as string[])[0] !== "dsar.run")).toEqual([]);
    expect(run.deleted).toBe(1);
    expect(run.failed).toBe(0);

    const user = (
      await q(sql<{ email: string; name: string; image: string | null; ev: boolean }>`
      select email, name, image, "emailVerified" as ev from auth."user" where id = ${u}`)
    )[0];
    expect(user?.email).toMatch(/^deleted\+[0-9a-f-]{36}@deleted\.invalid$/);
    expect(user?.email).not.toContain(email.split("@")[0] as string);
    expect(user?.name).toBe("***");
    expect(user?.ev).toBe(false);
    expect(await q(sql`select 1 from auth."user" where email = ${email} or name = ${email}`)).toEqual([]);
    expect(await q(sql`select 1 from auth."session" where "userId" = ${u}`)).toEqual([]);
    const revoked = await q(
      sql<{ n: number }>`select count(*)::int as n from auth.revoked_session where user_id = ${u}`,
    );
    expect(revoked[0]?.n).toBe(2);
    expect(await q(sql`select 1 from auth.account where "userId" = ${u}`)).toEqual([]);
    expect(await q(sql`select 1 from auth."twoFactor" where "userId" = ${u}`)).toEqual([]);
    expect(
      await q(sql`select 1 from auth.verification where identifier = ${`sign-in-otp-${email}`}`),
    ).toEqual([]);
    expect(await q(sql`select 1 from auth.verification where identifier = ${otherOtp}`)).toHaveLength(1);
    expect(await q(sql`select 1 from auth.login_throttle where email_hash = ${emailHash}`)).toEqual([]);
    const members = await q(sql<{ status: string; revoked: boolean }>`
      select status, revoked_at is not null as revoked from memberships where auth_user_id = ${u} order by organization_id`);
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.status === "revoked" && m.revoked)).toBe(true);
    const audits = await q(sql<{ org: string; actor_type: string; reason: string }>`
      select organization_id as org, actor_type, reason from audit_events where action = 'member.account_deleted'
        and entity_id in (${tenant.membershipId}, ${coOwner.membershipId})`);
    expect(audits.map((x) => x.org).sort()).toEqual([A.orgId, B.orgId].sort());
    expect(audits.every((x) => x.actor_type === "worker" && x.reason === "dsar_delete")).toBe(true);
    expect(await q(sql`select 1 from product_events where actor_user_id = ${u}`)).toEqual([]);
    expect(
      await q(sql`select 1 from product_events where actor_user_id = ${A.ownerAuthUserId}`),
    ).toHaveLength(1);
    const file = (
      await q(sql<{ due: boolean }>`
      select delete_after <= (now() at time zone 'UTC')::date as due from files where id = ${fileId}`)
    )[0];
    expect(file?.due).toBe(true);
    // B vẫn còn owner active (đồng chủ còn lại); A không đổi owner.
    const owners = await q(sql<{ n: number }>`
      select count(*)::int as n from memberships where organization_id = ${B.orgId} and role = 'owner' and status = 'active'`);
    expect(owners[0]?.n).toBe(1);

    expect(await kept()).toEqual(before);
    expect(before?.consent).toBe(1);
    expect(before?.person).toBe("Người thuê Sẽ Xoá");

    const done = await reqRow(del.request.id);
    expect(done?.status).toBe("completed");
    expect(done?.completed_at).toBeInstanceOf(Date);
    expect(done?.legal_retention_note).toContain("88/2015/QH13");
    expect(done?.result_summary).toMatchObject({
      sessions_revoked: 2,
      sign_in_methods_removed: 1,
      mfa_removed: 1,
      memberships_revoked: 2,
      product_events_unlinked: 3,
      files_marked_for_deletion: 1,
    });
    expect(JSON.stringify(done?.result_summary)).not.toContain(email);
    expect(await reqRow(access.request.id)).toMatchObject({
      status: "rejected",
      result_summary: { reason: "account_deleted" },
    });
    expect(fake.puts).toEqual([]);
    // Chạy lại: không còn việc, không đổi gì.
    expect(await processDsarRequests(t.worker, { storage: fake })).toMatchObject({ deleted: 0, failed: 0 });
  });

  it("đã có gói truy cập còn hạn ⇒ xoá tài khoản làm gói hết hạn ngay và object bị xoá khỏi kho", async () => {
    await drain();
    const u = await newUser();
    const fake = fakeStorage();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    await processDsarRequests(t.worker, { storage: fake });
    const k = dsarObjectKey(u, a.request.id);
    expect(fake.objects.has(k)).toBe(true);
    await createDsarRequest(t.runtime, u, { type: "delete", reauthenticatedAt: now() });
    const r = await processDsarRequests(t.worker, { storage: fake });
    expect(r).toMatchObject({ deleted: 1, expired: 1 });
    expect(fake.objects.has(k)).toBe(false);
    expect((await reqRow(a.request.id))?.result_file_key).toBeNull();
  });

  it("owner duy nhất lúc worker chạy (owner kia vừa rời) ⇒ `rejected` last_owner, tài khoản và membership còn nguyên", async () => {
    await drain();
    const v = await newUser();
    const C = await seedOrg(t.admin, "Nhà nghỉ Hai Chủ", "rental", v);
    const w = await newUser();
    const other = await addMember(C, w, "owner", "Chủ kia", `kia-${randomUUID()}@example.com`);
    const del = await createDsarRequest(t.runtime, v, { type: "delete", reauthenticatedAt: now() });
    await sql`update memberships set status = 'revoked', revoked_at = now() where id = ${other.membershipId}`.execute(
      t.admin,
    );
    const r = await processDsarRequests(t.worker, { storage: fakeStorage() });
    expect(r).toMatchObject({ deleted: 0, rejected: 1 });
    expect(await reqRow(del.request.id)).toMatchObject({
      status: "rejected",
      result_summary: { reason: "last_owner", organizations: 1 },
    });
    const m = await sql<{ status: string }>`
      select status from memberships where auth_user_id = ${v} and organization_id = ${C.orgId}`.execute(
      t.admin,
    );
    expect(m.rows[0]?.status).toBe("active");
    const u = await sql<{ email: string }>`select email from auth."user" where id = ${v}`.execute(t.admin);
    expect(u.rows[0]?.email).not.toMatch(/deleted\.invalid$/);
  });

  it("hai worker chạy đồng thời: mỗi yêu cầu chỉ được xử lý một lần (SKIP LOCKED)", async () => {
    await drain();
    const users = await Promise.all([newUser(), newUser(), newUser()]);
    for (const u of users) await createDsarRequest(t.runtime, u, { type: "access" });
    const fake = fakeStorage();
    const [r1, r2] = await Promise.all([
      processDsarRequests(t.worker, { storage: fake }),
      processDsarRequests(t.worker, { storage: fake }),
    ]);
    expect((r1?.accessCompleted ?? 0) + (r2?.accessCompleted ?? 0)).toBe(3);
    for (const u of users) expect(fake.puts.filter((k) => k.startsWith(`dsar/${u}/`))).toHaveLength(1);
  });

  it("hai owner DUY NHẤT cùng xoá tài khoản song song ⇒ đúng một xong, một `rejected` last_owner; tổ chức còn 1 owner", async () => {
    await drain();
    const v = await newUser();
    const C = await seedOrg(t.admin, "Nhà nghỉ Hai Chủ Song Song", "rental", v);
    const w = await newUser();
    await addMember(C, w, "owner", "Chủ hai", `hai-${randomUUID()}@example.com`);
    const dv = await createDsarRequest(t.runtime, v, { type: "delete", reauthenticatedAt: now() });
    const dw = await createDsarRequest(t.runtime, w, { type: "delete", reauthenticatedAt: now() });
    await sql`update dsar_requests set status = 'processing', processing_started_at = now()
              where id in (${dv.request.id}, ${dw.request.id})`.execute(t.admin);
    const note = "giữ theo luật";
    let second: Promise<{ status?: string; reason?: string } | null> | undefined;
    const first = await t.worker.connection().execute(async (c) => {
      await sql`begin`.execute(c);
      const r1 = await sql<{ res: { status?: string } | null }>`
        select app.dsar_erase_account(${dv.request.id}::uuid, ${note}) as res`.execute(c);
      // Giao dịch thứ hai bắt đầu khi giao dịch thứ nhất CHƯA commit (write-skew nếu không khoá hàng owner của tổ chức).
      second = sql<{ res: { status?: string; reason?: string } | null }>`
        select app.dsar_erase_account(${dw.request.id}::uuid, ${note}) as res`
        .execute(t.worker)
        .then((r) => r.rows[0]?.res ?? null);
      await new Promise((r) => setTimeout(r, 300));
      await sql`commit`.execute(c);
      return r1.rows[0]?.res ?? null;
    });
    const res2 = await second;
    expect(first?.status).toBe("completed");
    expect(res2).toMatchObject({ status: "rejected", reason: "last_owner" });
    const owners = await q(sql<{ n: number }>`
      select count(*)::int as n from memberships where organization_id = ${C.orgId} and role = 'owner' and status = 'active'`);
    expect(owners[0]?.n).toBe(1);
    expect((await reqRow(dw.request.id))?.status).toBe("rejected");
  });

  it("đăng nhập dở dang trong lúc xoá tài khoản (INSERT phiên chờ khoá) ⇒ bị từ chối sau khi xoá commit, không còn phiên", async () => {
    await drain();
    const u = await newUser();
    const del = await createDsarRequest(t.runtime, u, { type: "delete", reauthenticatedAt: now() });
    await sql`update dsar_requests set status = 'processing', processing_started_at = now() where id = ${del.request.id}`.execute(
      t.admin,
    );
    let insert: Promise<unknown> | undefined;
    await t.worker.connection().execute(async (c) => {
      await sql`begin`.execute(c);
      await sql`select app.dsar_erase_account(${del.request.id}::uuid, ${"giữ theo luật"})`.execute(c);
      // Như Better Auth (vai trò app_runtime) ghi phiên sau khi đã kiểm mật khẩu.
      insert = sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId")
                   values (${randomUUID()}, now() + interval '1 day', ${randomUUID()}, now(), ${u}::uuid)`
        .execute(t.runtime)
        .then(
          () => "inserted",
          (e: unknown) => e,
        );
      await new Promise((r) => setTimeout(r, 300));
      await sql`commit`.execute(c);
    });
    expect(await insert).toMatchObject({ code: "42501", hint: "ACCOUNT_DELETED" });
    const s = await q(
      sql<{ n: number }>`select count(*)::int as n from auth."session" where "userId" = ${u}`,
    );
    expect(s[0]?.n).toBe(0);
    // Tài khoản thường vẫn ghi phiên được.
    const ok = await newUser();
    await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId")
              values (${randomUUID()}, now() + interval '1 day', ${randomUUID()}, now(), ${ok}::uuid)`.execute(
      t.runtime,
    );
  });

  it("gói đã `put` nhưng chốt lỗi (worker coi như chết) rồi tài khoản bị xoá ⇒ object vẫn bị dọn khỏi kho", async () => {
    await drain();
    const u = await newUser();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    const fake = fakeStorage();
    // CSDL lỗi đúng lúc chốt `app.dsar_complete_access` (sau khi object đã ghi vào kho).
    const failingComplete = t.worker.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes("dsar_complete_access")) throw new Error("mất kết nối CSDL");
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const r1 = await processDsarRequests(failingComplete, { storage: fake });
    expect(r1).toMatchObject({ accessCompleted: 0, failed: 1 });
    const k = dsarObjectKey(u, a.request.id);
    expect(fake.objects.has(k)).toBe(true);
    expect((await reqRow(a.request.id))?.status).toBe("processing");
    await createDsarRequest(t.runtime, u, { type: "delete", reauthenticatedAt: now() });
    const r2 = await processDsarRequests(t.worker, { storage: fake });
    expect(r2).toMatchObject({ deleted: 1 });
    expect(fake.objects.has(k)).toBe(false);
    const row = await q(sql<{ status: string; pending_file_key: string | null }>`
      select status, pending_file_key from dsar_requests where id = ${a.request.id}`);
    expect(row[0]).toEqual({ status: "rejected", pending_file_key: null });
    // Lượt sau không còn gì để dọn (khoá dự kiến đã gỡ sau khi xoá object).
    expect(await expireDsarResults(t.worker, { storage: fake })).toBe(0);
  });

  it("chốt gói thành công gỡ khoá dự kiến; app_runtime không tự đặt `pending_file_key`", async () => {
    await drain();
    const u = await newUser();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    await processDsarRequests(t.worker, { storage: fakeStorage() });
    const row = await q(sql<{
      status: string;
      pending_file_key: string | null;
      result_file_key: string | null;
    }>`
      select status, pending_file_key, result_file_key from dsar_requests where id = ${a.request.id}`);
    expect(row[0]).toEqual({
      status: "completed",
      pending_file_key: null,
      result_file_key: dsarObjectKey(u, a.request.id),
    });
    await expect(
      withUserContext(t.runtime, u, (trx) =>
        sql`insert into dsar_requests (id, subject_user_id, type, status, region, due_at, verified_at, pending_file_key)
            values (${randomUUID()}, ${u}::uuid, 'restrict', 'verified', 'VN', now() + interval '1 day', now(), 'x')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("yêu cầu `processing` treo quá 15 phút được nhận lại; chưa tới 15 phút thì không", async () => {
    await drain();
    const u = await newUser();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    await sql`update dsar_requests set status = 'processing', processing_started_at = now() - interval '14 minutes'
              where id = ${a.request.id}`.execute(t.admin);
    const fake = fakeStorage();
    expect((await processDsarRequests(t.worker, { storage: fake })).accessCompleted).toBe(0);
    await sql`update dsar_requests set processing_started_at = now() - interval '16 minutes' where id = ${a.request.id}`.execute(
      t.admin,
    );
    expect((await processDsarRequests(t.worker, { storage: fake })).accessCompleted).toBe(1);
  });

  it("kho lỗi khi ghi gói ⇒ đếm failed, yêu cầu giữ `processing` (không mất), yêu cầu khác vẫn chạy", async () => {
    await drain();
    const bad = await newUser();
    const good = await newUser();
    const rb = await createDsarRequest(t.runtime, bad, { type: "access" });
    await createDsarRequest(t.runtime, good, { type: "access" });
    const fake = fakeStorage();
    const flaky = {
      ...fake,
      async put(key: string, body: Uint8Array) {
        if (key.startsWith(`dsar/${bad}/`)) throw new Error("kho tạm lỗi");
        await fake.put(key, body);
      },
    };
    const logs: string[] = [];
    const r = await processDsarRequests(t.worker, { storage: flaky, log: (e) => logs.push(e) });
    expect(r).toMatchObject({ accessCompleted: 1, failed: 1 });
    expect(logs).toContain("dsar.request_failed");
    expect((await reqRow(rb.request.id))?.status).toBe("processing");
  });
});

describe("worker — truy cập: gói JSON của chính mình ở kho riêng tư, tải qua URL ký, hết hạn thì xoá", () => {
  it("gói chứa dữ liệu của chính người yêu cầu, không của người khác; B không tải được của A", async () => {
    const email = `truy-cap-${randomUUID()}@example.com`;
    const u = await newUser(email);
    const other = await newUser(`nguoi-khac-${randomUUID()}@example.com`);
    await addMember(A, u, "tenant", "Người thuê Xem Dữ Liệu", email);
    await addMember(A, other, "tenant", "Người thuê Khác", `khac-${randomUUID()}@example.com`);
    await grantConsent(t.runtime, u, { purpose: "analytics", channel: "portal" });
    await grantConsent(t.runtime, other, { purpose: "analytics", channel: "portal" });
    await sql`insert into product_events (id, organization_id, name, schema_version, actor_user_id)
              values (${randomUUID()}, ${A.orgId}, 'billing_period.created', 1, ${u}),
                     (${randomUUID()}, ${A.orgId}, 'billing_period.created', 1, ${other})`.execute(t.admin);
    await sql`insert into auth."session" (id, "expiresAt", token, "updatedAt", "userId", "userAgent")
              values (${randomUUID()}, now() + interval '1 day', ${`tok-${randomUUID()}`}, now(), ${u}, 'Trình duyệt thử')`.execute(
      t.admin,
    );
    await sql`insert into auth.account (id, "accountId", "providerId", "userId", password, "updatedAt")
              values (${randomUUID()}, ${u}, 'credential', ${u}, 'bam-mat-khau-gia-khong-xuat', now())`.execute(
      t.admin,
    );
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    // Chưa xử lý ⇒ chưa tải được.
    await expect(dsarDownloadUrl(t.runtime, storage, u, a.request.id)).rejects.toMatchObject({
      code: "EXPORT_NOT_READY",
    });
    const r = await processDsarRequests(t.worker, { storage });
    expect(r.accessCompleted).toBeGreaterThanOrEqual(1);

    const o = await dsarOverview(t.runtime, u);
    const mine = o.requests.find((x) => x.id === a.request.id);
    expect(mine?.status).toBe("completed");
    expect(mine?.resultExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);

    const { url, expiresIn } = await dsarDownloadUrl(t.runtime, storage, u, a.request.id);
    expect(expiresIn).toBeLessThanOrEqual(300);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const text = await res.text();
    const pkg = JSON.parse(text) as Record<string, unknown> & {
      account: { id: string; email: string };
      memberships: { person: { full_name: string } }[];
      consent_records: unknown[];
      product_events: unknown[];
      sessions: { user_agent: string }[];
      sign_in_methods: { provider: string }[];
      data_requests: { id: string }[];
    };
    expect(pkg.format).toBe("hm-dsar-access/1");
    expect(pkg.account).toMatchObject({ id: u, email });
    expect(pkg.memberships.map((m) => m.person.full_name)).toEqual(["Người thuê Xem Dữ Liệu"]);
    expect(pkg.consent_records).toHaveLength(1);
    expect(pkg.product_events).toHaveLength(1);
    expect(pkg.sessions.map((s) => s.user_agent)).toEqual(["Trình duyệt thử"]);
    expect(pkg.sign_in_methods.map((m) => m.provider)).toEqual(["credential"]);
    expect(pkg.data_requests.map((d) => d.id)).toContain(a.request.id);
    expect(text).not.toContain(other);
    expect(text).not.toContain("Người thuê Khác");
    expect(text).not.toContain("bam-mat-khau-gia-khong-xuat");

    // Người khác không tải được (không phân biệt với không tồn tại).
    await expect(dsarDownloadUrl(t.runtime, storage, other, a.request.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Hết hạn tải: dọn xoá object rồi gỡ khoá; tải ⇒ LINK_EXPIRED.
    const later = new Date(Date.now() + 73 * 3_600_000);
    await expect(dsarDownloadUrl(t.runtime, storage, u, a.request.id, later)).rejects.toMatchObject({
      code: "LINK_EXPIRED",
    });
    await sql`update dsar_requests set result_expires_at = now() - interval '1 second' where id = ${a.request.id}`.execute(
      t.admin,
    );
    expect(await expireDsarResults(t.worker, { storage })).toBeGreaterThanOrEqual(1);
    expect((await fetch(url)).status).toBe(404);
    expect((await reqRow(a.request.id))?.result_file_key).toBeNull();
    await expect(dsarDownloadUrl(t.runtime, storage, u, a.request.id)).rejects.toMatchObject({
      code: "LINK_EXPIRED",
    });
  });

  it("kho lỗi khi dọn ⇒ khoá còn, lượt sau thử lại (không object mồ côi)", async () => {
    const u = await newUser();
    const fake = fakeStorage();
    const a = await createDsarRequest(t.runtime, u, { type: "access" });
    await processDsarRequests(t.worker, { storage: fake });
    await sql`update dsar_requests set result_expires_at = now() - interval '1 second' where id = ${a.request.id}`.execute(
      t.admin,
    );
    const logs: string[] = [];
    const broken = {
      ...fake,
      async delete() {
        throw new Error("kho tạm lỗi");
      },
    };
    await expireDsarResults(t.worker, { storage: broken, log: (e) => logs.push(e) });
    expect(logs).toContain("dsar.expire_failed");
    expect((await reqRow(a.request.id))?.result_file_key).toBe(dsarObjectKey(u, a.request.id));
    await expireDsarResults(t.worker, { storage: fake });
    expect((await reqRow(a.request.id))?.result_file_key).toBeNull();
  });
});

describe("metric hm_dsar_overdue", () => {
  it("đếm đúng yêu cầu còn mở quá due_at; đã xong/đã từ chối/chưa tới hạn không tính", async () => {
    const base = async () =>
      (await sql<{ value: number }>`select value from app.dsar_metrics(now())`.execute(t.runtime)).rows[0]
        ?.value ?? 0;
    const start = await base();
    const u1 = await newUser();
    const u2 = await newUser();
    const u3 = await newUser();
    const overdueOpen = await createDsarRequest(t.runtime, u1, { type: "access" });
    const notDue = await createDsarRequest(t.runtime, u2, { type: "access" });
    const closed = await createDsarRequest(t.runtime, u3, { type: "restrict" });
    await sql`update dsar_requests set requested_at = now() - interval '11 days', due_at = now() - interval '1 day'
              where id in (${overdueOpen.request.id}, ${closed.request.id})`.execute(t.admin);
    expect(await base()).toBe(start + 1);
    expect(notDue.request.dueAt.getTime()).toBeGreaterThan(Date.now());
    const samples = await collectMetrics(t.runtime);
    expect(samples.find((s) => s.name === "hm_dsar_overdue")?.value).toBe(start + 1);
    // Xong ⇒ không còn quá hạn.
    await processDsarRequests(t.worker, { storage: fakeStorage() });
    expect(await base()).toBe(start);
  });
});

describe("hạn chế xử lý ⇒ analytics từ chối (nối bộ kiểm của T-2310)", () => {
  async function runCreate(org: SeededOrg, month: string) {
    const actor = await resolveActor(t.runtime, {
      authUserId: org.ownerAuthUserId,
      orgId: org.orgId,
      twoFactorEnabled: true,
    });
    return executeCommand(
      t.runtime,
      actor,
      {
        command: "billing.createPeriod",
        idempotencyKey: randomUUID(),
        payload: { month },
        correlationId: "c-dsar",
      },
      async (ctx) => ({ data: await createPeriod(ctx, { propertyId: org.propertyId, month }) }),
    );
  }
  const events = async (userId: string) =>
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from product_events where actor_user_id = ${userId}`.execute(t.admin)
    ).rows[0]?.n;

  it("có đồng ý ⇒ trackCommand ghi; bật hạn chế ⇒ lệnh sau không ghi dù vẫn đồng ý; hasConsent trả false", async () => {
    const R = await seedOrg(t.admin, "Nhà trọ Hạn Chế", "rental");
    const owner = R.ownerAuthUserId;
    configureAnalytics({ consent: createAnalyticsConsentCheck() });
    await grantConsent(t.runtime, owner, { purpose: "analytics", channel: "settings" });
    expect((await runCreate(R, "2027-04")).status).toBe("committed");
    expect(await events(owner)).toBe(1);
    expect(await hasConsent(t.runtime, owner, "analytics")).toBe(true);

    const r = await createDsarRequest(t.runtime, owner, { type: "restrict" });
    expect(r.request.status).toBe("completed");
    expect((await dsarOverview(t.runtime, owner)).restrictedAt).toBeInstanceOf(Date);
    expect(await hasConsent(t.runtime, owner, "analytics")).toBe(false);
    expect((await runCreate(R, "2027-05")).status).toBe("committed");
    expect(await events(owner)).toBe(1);
  });
});

describe("HTTP /api/v1/me/data-requests — được phép và bị từ chối", () => {
  const session = (userId: string, createdAt: Date) => ({ user: { id: userId }, session: { createdAt } });
  const deps = (
    userId: string | null,
    o: { createdAt?: Date; password?: string; revoked?: boolean } = {},
  ): DataRequestDeps => ({
    db: t.runtime,
    getSession: async () =>
      userId ? session(userId, o.createdAt ?? new Date(Date.now() - 3_600_000)) : null,
    isSessionRevoked: async () => o.revoked ?? false,
    services: testServices({ storage }),
    verifyPassword: async (_h, p) => p === (o.password ?? "mat-khau-dung-gia"),
  });
  const post = (body: unknown) =>
    new Request("http://localhost/api/v1/me/data-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (path = "/api/v1/me/data-requests") => new Request(`http://localhost${path}`);

  it("chưa đăng nhập ⇒ 401 (phiên bị thu hồi ⇒ SESSION_REVOKED); thân sai ⇒ 400/422", async () => {
    expect((await handleListDataRequests(get(), deps(null))).status).toBe(401);
    const revoked = await handleCreateDataRequest(post({ type: "access" }), deps(null, { revoked: true }));
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { code: string }).code).toBe("SESSION_REVOKED");
    const u = await newUser();
    expect((await handleCreateDataRequest(post("{không phải json"), deps(u))).status).toBe(400);
    expect((await handleCreateDataRequest(post({ type: "xoa" }), deps(u))).status).toBe(422);
    expect((await handleCreateDataRequest(post({ type: "access", them: 1 }), deps(u))).status).toBe(422);
  });

  it("truy cập ⇒ 202 rồi gửi lại ⇒ 200 cùng yêu cầu; GET chỉ trả yêu cầu của chính mình", async () => {
    const u = await newUser();
    const v = await newUser();
    const r1 = await handleCreateDataRequest(post({ type: "access" }), deps(u));
    expect(r1.status).toBe(202);
    const b1 = (await r1.json()) as { data: { status: string; request: { id: string; due_at: string } } };
    expect(b1.data.status).toBe("created");
    const r2 = await handleCreateDataRequest(post({ type: "access" }), deps(u));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as typeof b1).data.request.id).toBe(b1.data.request.id);
    await handleCreateDataRequest(post({ type: "access" }), deps(v));
    const list = (await (await handleListDataRequests(get(), deps(u))).json()) as {
      requests: { id: string }[];
      restricted_at: string | null;
    };
    expect(list.requests.map((x) => x.id)).toEqual([b1.data.request.id]);
    expect(list.restricted_at).toBeNull();
  });

  it("xoá: phiên cũ không mật khẩu ⇒ 401 REAUTH_REQUIRED; sai mật khẩu ⇒ 401 invalid_password; đúng ⇒ 202; phiên mới ⇒ 202", async () => {
    const u = await newUser();
    const noPw = await handleCreateDataRequest(post({ type: "delete" }), deps(u));
    expect(noPw.status).toBe(401);
    expect(await noPw.json()).toMatchObject({ code: "REAUTH_REQUIRED", reason: "reauth_required" });
    const wrong = await handleCreateDataRequest(post({ type: "delete", password: "sai-roi" }), deps(u));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: "REAUTH_REQUIRED", reason: "invalid_password" });
    expect((await dsarOverview(t.runtime, u)).requests).toEqual([]);
    const ok = await handleCreateDataRequest(
      post({ type: "delete", password: "mat-khau-dung-gia" }),
      deps(u),
    );
    expect(ok.status).toBe(202);

    const fresh = await newUser();
    const viaSession = await handleCreateDataRequest(
      post({ type: "delete" }),
      deps(fresh, { createdAt: new Date() }),
    );
    expect(viaSession.status).toBe(202);
  });

  it("nhập lại mật khẩu quá 5 lần/15 phút ⇒ 429 có Retry-After, kể cả khi lần sau đúng", async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++)
      expect(
        (await handleCreateDataRequest(post({ type: "delete", password: `sai-${i}` }), deps(u))).status,
      ).toBe(401);
    const blocked = await handleCreateDataRequest(
      post({ type: "delete", password: "mat-khau-dung-gia" }),
      deps(u),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("owner duy nhất ⇒ 409 LAST_OWNER", async () => {
    const v = await newUser();
    await seedOrg(t.admin, "Nhà nghỉ Một Chủ HTTP", "rental", v);
    const r = await handleCreateDataRequest(post({ type: "delete" }), deps(v, { createdAt: new Date() }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("LAST_OWNER");
  });

  it("tải: chưa xong 409; xong ⇒ 303 tới URL ký; người khác 404; id không phải uuid 404; hết hạn 410", async () => {
    const u = await newUser();
    const v = await newUser();
    const created = (await (await handleCreateDataRequest(post({ type: "access" }), deps(u))).json()) as {
      data: { request: { id: string } };
    };
    const id = created.data.request.id;
    const path = `/api/v1/me/data-requests/${id}/download`;
    expect((await handleDownloadDataRequest(get(path), deps(u), id)).status).toBe(409);
    await processDsarRequests(t.worker, { storage });
    const list = (await (await handleListDataRequests(get(), deps(u))).json()) as {
      requests: { id: string; download_url: string | null }[];
    };
    expect(list.requests.find((x) => x.id === id)?.download_url).toBe(path);
    const ok = await handleDownloadDataRequest(get(path), deps(u), id);
    expect(ok.status).toBe(303);
    const loc = ok.headers.get("location") ?? "";
    expect(loc).toContain(`dsar/${u}/${id}.json`);
    expect((await fetch(loc)).status).toBe(200);
    expect((await handleDownloadDataRequest(get(path), deps(v), id)).status).toBe(404);
    expect((await handleDownloadDataRequest(get(path), deps(u), "khong-phai-uuid")).status).toBe(404);
    expect((await handleDownloadDataRequest(get(path), deps(null), id)).status).toBe(401);
    await sql`update dsar_requests set result_expires_at = now() - interval '1 second' where id = ${id}`.execute(
      t.admin,
    );
    expect((await handleDownloadDataRequest(get(path), deps(u), id)).status).toBe(410);
  });
});
