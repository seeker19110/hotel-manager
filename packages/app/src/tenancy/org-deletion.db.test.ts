// PLAN T-2312 (IND-SAAS-006, UX-CONTENT-005; D-125; migration 0070) — vòng đời xoá tổ chức trên Postgres thật, bằng `app_runtime`
// (yêu cầu/huỷ/trạng thái, như request thật) và `app_worker` (purge, như job): chỉ owner + xác thực lại; chờ xoá khoá mọi đường trừ
// xuất dữ liệu và trạng thái/huỷ; huỷ một bước khôi phục; chưa tới hạn (đồng hồ CSDL) không purge; quá hạn ⇒ MỌI bảng có
// organization_id (từ catalog) = 0 hàng của tổ chức, tổ chức khác nguyên vẹn, object kho xoá TRƯỚC (lỗi kho ⇒ không purge), chứng
// nhận đúng số đếm + digest, chỉ người yêu cầu đọc; trigger append-only KHÔNG vượt được bằng GUC từ app_runtime/app_worker; hai
// purge đồng thời chỉ một chạy; job tắt mặc định ở production.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  activateLease,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedReservation,
  tenantTables,
} from "@hm/testkit";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError, type Actor, resolveActor } from "../access/actor.ts";
import { requestOrgExport } from "../exports/index.ts";
import { type HttpDeps, handleCommandStatus, handleQuery } from "../http/command-route.ts";
import {
  handleCancelOrgDeletion,
  handleGetOrgDeletion,
  handleRequestOrgDeletion,
} from "../http/org-deletion.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { collectMetrics } from "../observability/metrics.ts";
import { testServices } from "../server/services.ts";
import { type Hotel, runAs, seedHotel } from "../testing/index.ts";
import {
  cancelOrgDeletion,
  listOrgDeletionCertificates,
  ORG_DELETION_GRACE_DAYS,
  OrgDeletionError,
  orgDeletionStatus,
  orgPurgeEnabled,
  purgeDueOrganizations,
  requestOrgDeletion,
} from "./index.ts";

let h: Hotel;
let A: string;
let B: string;
let owner: Actor;
let deps: HttpDeps;
const fileKeys: string[] = [];
const seededCommandKey = randomUUID();
const exportCommandKey = randomUUID();

const fresh = (a: Actor): Actor => ({ ...a, authenticatedAt: new Date() });
const asOwner = (allowPendingDeletion = false) =>
  resolveActor(h.t.runtime, {
    authUserId: h.org.ownerAuthUserId,
    orgId: A,
    twoFactorEnabled: true,
    authenticatedAt: new Date(),
    ...(allowPendingDeletion ? { allowPendingDeletion: true } : {}),
  });

async function counts(db: Kysely<unknown>, org: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await tenantTables(db)) {
    const r = await sql<{ n: string }>`
      select count(*)::text as n from ${sql.table(table)} where organization_id = ${org}::uuid`.execute(db);
    out[table] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

async function ageDeletion(org: string, days = ORG_DELETION_GRACE_DAYS + 1) {
  await sql`update organizations
            set deletion_requested_at = deletion_requested_at - make_interval(days => ${days}),
                deletion_due_at = deletion_due_at - make_interval(days => ${days})
            where id = ${org}::uuid`.execute(h.t.admin);
}

/** Dữ liệu giả rải khắp các bảng (kể cả append-only, FK vòng inbox↔bank_transactions, file kho). */
async function populate(org: typeof h.org) {
  const admin = h.t.admin;
  await seedIssuedInvoice(admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    payerPersonId: org.ownerPersonId,
    lines: [{ amount: 150_000 }],
  });
  const lease = await seedLease(admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: org.ownerPersonId,
  });
  await activateLease(admin, { org, leaseId: lease.leaseId });
  await seedReservation(admin, { org, bookerPersonId: org.ownerPersonId });
  const inbox = randomUUID();
  const bank = randomUUID();
  const ra = randomUUID();
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${ra}, ${org.orgId}, ${org.propertyId}, '970436', '****1111', '0000001111', 'GIA')`.execute(
    admin,
  );
  await sql`insert into inbox (id, organization_id, provider, account, provider_event_id, payload_hash, raw, signature_verified)
            values (${inbox}, ${org.orgId}, 'sepay', ${ra}, ${randomUUID()}, ${"a".repeat(64)}, '{}'::jsonb, true)`.execute(
    admin,
  );
  await sql`insert into bank_transactions (id, organization_id, property_id, receiving_account_id, bank_txn_ref, amount, occurred_at,
                                           first_source, raw_hash, inbox_id)
            values (${bank}, ${org.orgId}, ${org.propertyId}, ${ra}, ${`REF-${bank.slice(0, 8)}`}, 50000, now(), 'webhook',
                    ${"b".repeat(64)}, ${inbox})`.execute(admin);
  await sql`update inbox set bank_transaction_id = ${bank} where id = ${inbox}`.execute(admin);
  const fileId = randomUUID();
  const key = `${org.orgId}/work_order/${fileId}`;
  await sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, exif_stripped)
            values (${fileId}, ${org.orgId}, 'work_order', 'application/pdf', 10, ${"c".repeat(64)}, 'ready', ${key}, true)`.execute(
    admin,
  );
  await sql`insert into product_events (id, organization_id, name, schema_version)
            values (${randomUUID()}, ${org.orgId}, 'command.committed', 1)`.execute(admin);
  return key;
}

beforeAll(async () => {
  h = await seedHotel();
  A = h.org.orgId;
  B = h.other.orgId;
  fileKeys.push(await populate(h.org));
  await populate(h.other);
  owner = await asOwner();
  // Một lệnh qua pipeline thật ⇒ audit_events + idempotency_keys + outbox của A.
  await runAs(
    h.t,
    owner,
    async (ctx) => {
      await ctx.audit({ action: "test.seeded", entityType: "organization", entityId: A });
      await ctx.emit({
        eventType: "test.seeded",
        aggregateType: "organization",
        aggregateId: A,
        payload: {},
      });
      return 1;
    },
    { key: seededCommandKey },
  );
  deps = {
    db: h.t.runtime,
    getSession: async (hd) => {
      const id = hd.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true }, session: { createdAt: new Date() } } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
}, 120_000);

afterAll(async () => {
  await h.t.drop();
});

const req = (user: string, method = "GET", body?: unknown, path = "/api/v1/organization/deletion") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "x-test-user": user, "x-org-id": A, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("danh mục purge khớp catalog (bảng mới không bị sót)", () => {
  it("app.purge_organization liệt kê ĐÚNG mọi bảng có organization_id, thứ tự xoá theo FK", async () => {
    const src = await sql<{
      s: string;
    }>`select prosrc as s from pg_proc where oid = 'app.purge_organization(uuid, text[])'::regprocedure`.execute(
      h.t.admin,
    );
    const arr = /v_order text\[\] := ARRAY\[([^\]]+)\]/.exec(src.rows[0]?.s ?? "")?.[1] ?? "";
    const order = [...arr.matchAll(/'([a-z_+]+)'/g)].map((m) => m[1] as string);
    const flat = order.flatMap((x) => x.split("+"));
    expect([...flat].sort()).toEqual(await tenantTables(h.t.admin));
    expect(new Set(flat).size).toBe(flat.length);
    const pos = (t: string) => order.findIndex((x) => x.split("+").includes(t));
    const fks = await sql<{ a: string; b: string }>`
      select c.conrelid::regclass::text as a, c.confrelid::regclass::text as b from pg_constraint c
      where c.contype = 'f' and not c.condeferrable and c.conrelid <> c.confrelid
        and c.conrelid::regclass::text = any(${flat}) and c.confrelid::regclass::text = any(${flat})`.execute(
      h.t.admin,
    );
    expect(fks.rows.length).toBeGreaterThan(50);
    for (const fk of fks.rows) {
      if (pos(fk.a) === pos(fk.b)) continue; // cùng câu lệnh (inbox+bank_transactions)
      expect(pos(fk.a), `${fk.a} → ${fk.b}`).toBeLessThan(pos(fk.b));
    }
  });

  it("mọi trigger chặn/kiểm DELETE trên bảng theo tổ chức đều có lối purge (org_purge_active); TRUNCATE thì không", async () => {
    const r = await sql<{ tg: string; src: string; truncate_only: boolean }>`
      select t.tgname as tg, p.prosrc as src, (t.tgtype & 8) = 0 as truncate_only
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and (t.tgtype & 40) <> 0
        and t.tgrelid::regclass::text = any(${await tenantTables(h.t.admin)})`.execute(h.t.admin);
    const del = r.rows.filter((x) => !x.truncate_only);
    expect(del.length).toBeGreaterThan(20);
    for (const x of del) expect(x.src, x.tg).toContain("org_purge_active");
  });
});

describe("hàng rào: không hàm SECURITY DEFINER nào khác xoá bảng có trigger chặn DELETE (lối vượt org_purge_active)", () => {
  it("chỉ app.purge_organization được chứa DELETE nhắm bảng append-only/guard; DELETE động (EXECUTE) cũng tính", async () => {
    // Lối vượt `app.org_purge_active` đúng khi current_user = owner hàm purge + GUC `app.purge_org` (người gọi tự đặt được) + tổ chức
    // tới hạn: MỌI hàm definer cùng owner đều thoả điều kiện role ⇒ hàm definer mới có DELETE trên các bảng này là lỗ thủng.
    const guarded = (
      await sql<{ tbl: string }>`
        select distinct t.tgrelid::regclass::text as tbl from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and (t.tgtype & 8) <> 0 and p.prosrc like '%org_purge_active%'`.execute(
        h.t.admin,
      )
    ).rows.map((r) => r.tbl);
    expect(guarded).toEqual(
      expect.arrayContaining(["audit_events", "journal_lines", "invoices", "memberships"]),
    );
    const fns = (
      await sql<{ fn: string; src: string }>`
        select p.oid::regprocedure::text as fn, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`.execute(h.t.admin)
    ).rows;
    expect(fns.length).toBeGreaterThan(20);
    const allowed = new Set(["app.purge_organization(uuid,text[])"]);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = new RegExp(
      `\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(?:public\\.)?"?(${guarded.map(esc).join("|")})"?\\b`,
      "i",
    );
    const dynamic = /EXECUTE\s+(?:format\s*\(\s*)?'DELETE/i;
    const offenders = fns
      .filter((f) => !allowed.has(f.fn.replace(/\s+/g, "")))
      .filter((f) => direct.test(f.src) || dynamic.test(f.src))
      .map((f) => f.fn);
    expect(offenders).toEqual([]);
    // Ca âm: hàm definer mới xoá audit_events ⇒ bị bắt.
    expect(direct.test("BEGIN DELETE FROM audit_events WHERE organization_id = p; END")).toBe(true);
    expect(dynamic.test("EXECUTE format('DELETE FROM %I WHERE x', t)")).toBe(true);
  });
});

describe("yêu cầu xoá: chỉ owner, xác thực lại", () => {
  it("không phải owner ⇒ FORBIDDEN (lớp app và HTTP); owner thiếu xác thực lại ⇒ REAUTH_REQUIRED; không đổi trạng thái", async () => {
    await expect(
      requestOrgDeletion(h.t.runtime, fresh(h.manager), {
        reauthenticatedAt: new Date(),
        correlationId: "t",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await handleRequestOrgDeletion(req(h.manager.authUserId, "POST", {}), deps);
    expect(res.status).toBe(403);
    await expect(
      requestOrgDeletion(h.t.runtime, owner, {
        reauthenticatedAt: new Date(Date.now() - 10 * 60_000),
        correlationId: "t",
      }),
    ).rejects.toBeInstanceOf(OrgDeletionError);
    // HTTP: mật khẩu sai (không có verifyPassword ⇒ sai) ⇒ 401 invalid_password; schema strict ⇒ 422.
    const bad = await handleRequestOrgDeletion(req(h.org.ownerAuthUserId, "POST", { password: "sai" }), deps);
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { reason: string }).reason).toBe("invalid_password");
    const extra = await handleRequestOrgDeletion(req(h.org.ownerAuthUserId, "POST", { force: true }), deps);
    expect(extra.status).toBe(422);
    // app_runtime không tự gọi được purge, cũng không tự đặt cột xoá (không cấp quyền cột).
    await expect(
      sql`select app.purge_organization(${A}::uuid, '{}'::text[])`.execute(h.t.runtime),
    ).rejects.toMatchObject({
      code: "42501",
    });
    expect((await orgDeletionStatus(h.t.runtime, owner)).status).toBe("active");
  });

  it("owner + phiên mới ⇒ 202 pending_deletion, hạn = +30 ngày (CSDL); gửi lại ⇒ 200 cùng hạn; có audit", async () => {
    const res = await handleRequestOrgDeletion(req(h.org.ownerAuthUserId, "POST", {}), deps);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { status: string; requested_at: string; due_at: string } };
    expect(body.data.status).toBe("pending_deletion");
    const ms = Date.parse(body.data.due_at) - Date.parse(body.data.requested_at);
    expect(ms).toBe(ORG_DELETION_GRACE_DAYS * 24 * 3600 * 1000);
    const again = await handleRequestOrgDeletion(req(h.org.ownerAuthUserId, "POST", {}), deps);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { due_at: string } }).data.due_at).toBe(body.data.due_at);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where organization_id = ${A} and action = 'organization.deletion_requested'`.execute(
      h.t.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("app_runtime (có UPDATE bảng organizations) KHÔNG tự đổi status/deletion_*: cả đặt chờ xoá quá hạn lẫn gỡ về active", async () => {
    const asRuntime = (org: string, stmt: ReturnType<typeof sql>) =>
      withTenant(h.t.runtime, { orgId: org }, (trx) => stmt.execute(trx)).catch((e: unknown) => e);
    // B đang active: tự đặt pending_deletion với mốc quá khứ (tới hạn purge ngay) ⇒ chặn.
    expect(
      await asRuntime(
        B,
        sql`update organizations set status = 'pending_deletion', deletion_requested_by = ${h.other.ownerAuthUserId},
              deletion_requested_at = now() - interval '40 days', deletion_due_at = now() - interval '10 days'
            where id = ${B}`,
      ),
    ).toMatchObject({ code: "42501", hint: "FORBIDDEN" });
    // A đang chờ xoá: tự gỡ về active (huỷ không qua owner) ⇒ chặn; đổi riêng một cột deletion_* cũng chặn.
    expect(
      await asRuntime(
        A,
        sql`update organizations set status = 'active', deletion_requested_at = null, deletion_due_at = null,
              deletion_requested_by = null where id = ${A}`,
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await asRuntime(
        A,
        sql`update organizations set deletion_due_at = deletion_due_at + interval '1 day' where id = ${A}`,
      ),
    ).toMatchObject({ code: "42501" });
    // UPDATE hợp lệ khác của app_runtime (settings) vẫn chạy.
    expect(
      await asRuntime(B, sql`update organizations set settings = settings || '{}'::jsonb where id = ${B}`),
    ).toMatchObject({ numAffectedRows: 1n });
    const st = await sql<{ id: string; status: string }>`
      select id, status from organizations where id in (${A}, ${B}) order by id`.execute(h.t.admin);
    expect(Object.fromEntries(st.rows.map((r) => [r.id, r.status]))).toEqual({
      [A]: "pending_deletion",
      [B]: "active",
    });
  });

  it("CSDL giữ ≥ 30 ngày: đặt hạn sớm hơn bằng tay vi phạm CHECK", async () => {
    await expect(
      sql`update organizations set deletion_due_at = deletion_requested_at + interval '1 day' where id = ${A}`.execute(
        h.t.admin,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("đang chờ xoá: khoá mọi đường trừ xuất dữ liệu + trạng thái/huỷ", () => {
  it("resolveActor mặc định ⇒ 423 ORG_PENDING_DELETION (owner lẫn nhân viên); có cờ ⇒ được", async () => {
    for (const userId of [h.org.ownerAuthUserId, h.frontDesk.authUserId]) {
      const err = await resolveActor(h.t.runtime, {
        authUserId: userId,
        orgId: A,
        twoFactorEnabled: true,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("ORG_PENDING_DELETION");
      expect((err as AccessError).status).toBe(423);
    }
    expect((await asOwner(true)).orgId).toBe(A);
    // Tổ chức khác không bị ảnh hưởng.
    expect(
      (
        await resolveActor(h.t.runtime, {
          authUserId: h.other.ownerAuthUserId,
          orgId: B,
          twoFactorEnabled: true,
        })
      ).orgId,
    ).toBe(B);
  });

  it("HTTP: truy vấn nghiệp vụ ⇒ 423; xuất (listMine) + trạng thái ⇒ 200; chỉ lệnh xuất được đánh dấu cho phép", async () => {
    const q = (name: string, user: string) =>
      handleQuery(
        QUERIES[name] as never,
        req(user, "GET", undefined, `/api/v1/${name.replace(".", "/")}`),
        deps,
      );
    expect((await q("today.getSummary", h.org.ownerAuthUserId)).status).toBe(423);
    expect((await q("exports.listMine", h.org.ownerAuthUserId)).status).toBe(200);
    expect((await handleGetOrgDeletion(req(h.frontDesk.authUserId), deps)).status).toBe(200);
    const allowed = [
      ...Object.entries(COMMANDS)
        .filter(([, d]) => d.allowPendingDeletion)
        .map(([n]) => n),
      ...Object.entries(QUERIES)
        .filter(([, d]) => d.allowPendingDeletion)
        .map(([n]) => n),
    ].sort();
    expect(allowed).toEqual([
      "exports.download",
      "exports.getStatus",
      "exports.listMine",
      "exports.requestOrgExport",
    ]);
  });

  it("xuất toàn bộ dữ liệu vẫn tạo được trong thời gian giữ", async () => {
    const r = await runAs(h.t, await asOwner(true), (ctx) => requestOrgExport(ctx), {
      command: "exports.requestOrgExport",
      key: exportCommandKey,
    });
    expect(r.status).toBe("committed");
  });

  it("GET /api/v1/commands/{id} khi chờ xoá: chỉ trả kết quả lệnh exports.*; lệnh khác ⇒ 423", async () => {
    const status = (key: string) =>
      handleCommandStatus(key, req(h.org.ownerAuthUserId, "GET", undefined, `/api/v1/commands/${key}`), deps);
    const ok = await status(exportCommandKey);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("committed");
    const locked = await status(seededCommandKey);
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as { code: string }).code).toBe("ORG_PENDING_DELETION");
    // Không lộ sự tồn tại: id lạ vẫn 404 như thường.
    expect((await status(randomUUID())).status).toBe(404);
  });

  it("huỷ: nhân viên bị từ chối; owner một bước ⇒ active, cột xoá rỗng, truy cập trở lại; huỷ lần hai ⇒ false", async () => {
    const staff = await resolveActor(h.t.runtime, {
      authUserId: h.manager.authUserId,
      orgId: A,
      twoFactorEnabled: true,
      allowPendingDeletion: true,
    });
    await expect(cancelOrgDeletion(h.t.runtime, staff, { correlationId: "t" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const res = await handleCancelOrgDeletion(req(h.org.ownerAuthUserId, "DELETE"), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { cancelled: boolean; status: string } }).data).toMatchObject({
      cancelled: true,
      status: "active",
    });
    const o = await sql<Record<string, unknown>>`
      select deletion_requested_at, deletion_due_at, deletion_requested_by from organizations where id = ${A}`.execute(
      h.t.admin,
    );
    expect(o.rows[0]).toEqual({
      deletion_requested_at: null,
      deletion_due_at: null,
      deletion_requested_by: null,
    });
    expect((await asOwner()).orgId).toBe(A);
    expect(await cancelOrgDeletion(h.t.runtime, await asOwner(), { correlationId: "t" })).toBe(false);
  });
});

describe("purge", () => {
  it("chưa tới hạn (đồng hồ CSDL) ⇒ không purge dù worker đưa mốc tương lai", async () => {
    await requestOrgDeletion(h.t.runtime, await asOwner(), {
      reauthenticatedAt: new Date(),
      correlationId: "t",
    });
    const storage = { deleted: [] as string[], delete: async (k: string) => void storage.deleted.push(k) };
    const far = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    expect(await purgeDueOrganizations(h.t.worker, { storage, now: far })).toMatchObject({
      due: 0,
      purged: 0,
    });
    const direct = await sql<{
      r: unknown;
    }>`select app.purge_organization(${A}::uuid, '{}'::text[]) as r`.execute(h.t.worker);
    expect(direct.rows[0]?.r).toBeNull();
    expect(storage.deleted).toEqual([]);
    const o = await sql<{ n: number }>`select count(*)::int as n from organizations where id = ${A}`.execute(
      h.t.admin,
    );
    expect(o.rows[0]?.n).toBe(1);
  });

  it("trigger append-only KHÔNG vượt được bằng GUC từ app_runtime/app_worker (kể cả khi tổ chức đã tới hạn)", async () => {
    await ageDeletion(A);
    // Cấp TẠM quyền DELETE (bình thường không có) để chứng minh chính trigger chặn — không chỉ thiếu quyền bảng.
    await sql`grant delete on audit_events, journal_lines, invoices to app_runtime, app_worker`.execute(
      h.t.admin,
    );
    try {
      for (const db of [h.t.runtime, h.t.worker]) {
        for (const stmt of [
          sql`delete from audit_events where organization_id = ${A}::uuid`,
          sql`delete from journal_lines where organization_id = ${A}::uuid`,
          sql`delete from invoices where organization_id = ${A}::uuid`,
        ]) {
          const err = await db
            .transaction()
            .execute(async (trx) => {
              await sql`select set_config('app.org_id', ${A}, true), set_config('app.purge_org', ${A}, true),
                             set_config('app.actor_id', ${h.org.ownerMembershipId}, true)`.execute(trx);
              expect(
                (await sql<{ a: boolean }>`select app.org_purge_active(${A}::uuid) as a`.execute(trx)).rows[0]
                  ?.a,
              ).toBe(false);
              await stmt.execute(trx);
            })
            .catch((e: { code?: string }) => e);
          expect((err as { code?: string }).code).toBe("55000"); // trigger append-only, không phải thiếu quyền
        }
      }
    } finally {
      await sql`revoke delete on audit_events, journal_lines, invoices from app_runtime, app_worker`.execute(
        h.t.admin,
      );
    }
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_events where organization_id = ${A}`.execute(h.t.admin);
    expect(n.rows[0]?.n).toBeGreaterThan(0);
  });

  it("lỗi kho object ⇒ KHÔNG purge (hai pha: object trước), lượt sau thử lại", async () => {
    const logs: string[] = [];
    const broken = {
      delete: async () => {
        throw new Error("kho lỗi");
      },
    };
    const r = await purgeDueOrganizations(h.t.worker, { storage: broken, log: (e) => logs.push(e) });
    expect(r).toMatchObject({ due: 1, purged: 0, failed: 1 });
    expect(logs).toContain("tenancy.purge_failed");
    const st = await sql<{ status: string }>`select status from organizations where id = ${A}`.execute(
      h.t.admin,
    );
    expect(st.rows[0]?.status).toBe("pending_deletion");
  });

  it("file MỚI ghi giữa lúc liệt kê khoá và purge ⇒ không purge (deferred), lượt sau làm lại — không object mồ côi", async () => {
    const extraId = randomUUID();
    const extraKey = `${A}/export_job/${extraId}`;
    let wrote = false;
    const storage = {
      deleted: [] as string[],
      delete: async (k: string) => {
        storage.deleted.push(k);
        if (wrote) return;
        wrote = true;
        // Như bản xuất trong thời gian giữ: ghi file mới sau khi worker đã liệt kê khoá.
        await sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key, exif_stripped)
                  values (${extraId}, ${A}, 'work_order', 'application/pdf', 10, ${"d".repeat(64)}, 'ready', ${extraKey}, true)`.execute(
          h.t.admin,
        );
      },
    };
    const logs: string[] = [];
    const r = await purgeDueOrganizations(h.t.worker, { storage, log: (e) => logs.push(e) });
    expect(r).toMatchObject({ due: 1, purged: 0, deferred: 1, failed: 0, objectsDeleted: 0 });
    expect(logs).toContain("tenancy.purge_deferred");
    expect(storage.deleted).not.toContain(extraKey);
    const st = await sql<{ status: string }>`select status from organizations where id = ${A}`.execute(
      h.t.admin,
    );
    expect(st.rows[0]?.status).toBe("pending_deletion");
    fileKeys.push(extraKey); // lượt purge sau phải xoá cả object này
  });

  it("quá hạn ⇒ object xoá, MỌI bảng theo tổ chức (catalog) = 0 hàng của A, B nguyên vẹn, chứng nhận đúng số đếm", async () => {
    const before = await counts(h.t.admin, A);
    const beforeB = await counts(h.t.admin, B);
    const populated = Object.entries(before)
      .filter(([, n]) => n > 0)
      .map(([t]) => t);
    // Có dữ liệu thật ở các bảng append-only/bất biến và cặp FK vòng.
    for (const t of [
      "audit_events",
      "invoices",
      "invoice_lines",
      "journal_entries",
      "journal_lines",
      "leases",
      "inbox",
      "bank_transactions",
      "files",
      "memberships",
      "persons",
    ])
      expect(populated, t).toContain(t);
    const metricsBefore = await collectMetrics(h.t.runtime, new Date());
    expect(
      metricsBefore.find((x) => x.name === "hm_org_pending_deletion" && x.labels?.state === "due")?.value,
    ).toBe(1);

    const storage = { deleted: [] as string[], delete: async (k: string) => void storage.deleted.push(k) };
    const r = await purgeDueOrganizations(h.t.worker, { storage });
    expect(r).toMatchObject({ due: 1, purged: 1, failed: 0, objectsDeleted: before.files });
    expect(storage.deleted.sort()).toEqual([...fileKeys].sort());

    const after = await counts(h.t.admin, A);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    const org = await sql<{
      n: number;
    }>`select count(*)::int as n from organizations where id = ${A}`.execute(h.t.admin);
    expect(org.rows[0]?.n).toBe(0);
    expect(await counts(h.t.admin, B)).toEqual(beforeB);
    expect(
      (
        await resolveActor(h.t.runtime, {
          authUserId: h.other.ownerAuthUserId,
          orgId: B,
          twoFactorEnabled: true,
        })
      ).orgId,
    ).toBe(B);

    // Chứng nhận: chỉ người yêu cầu thấy; số đếm = trước purge; digest tính lại khớp.
    const mine = await listOrgDeletionCertificates(h.t.runtime, h.org.ownerAuthUserId);
    expect(mine).toHaveLength(1);
    const c = mine[0] as (typeof mine)[number];
    expect(c.organizationId).toBe(A);
    expect(c.counts).toEqual({ ...before, organizations: 1 });
    expect(c.totalRows).toBe(Object.values(before).reduce((s, n) => s + n, 0) + 1);
    expect(c.objectsDeleted).toBe(before.files);
    const dg = await sql<{ d: string }>`
      select encode(sha256(convert_to(deleted_organization_id::text || '|' ||
             to_char(purged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || counts::text, 'UTF8')), 'hex') as d
      from org_deletion_certificates where id = ${c.id}`.execute(h.t.admin);
    expect(dg.rows[0]?.d).toBe(c.digest);
    expect(await listOrgDeletionCertificates(h.t.runtime, h.other.ownerAuthUserId)).toEqual([]);
    // Chứng nhận append-only.
    await expect(
      sql`delete from org_deletion_certificates where id = ${c.id}`.execute(h.t.admin),
    ).rejects.toMatchObject({
      code: "55000",
    });
  });
});

describe("đồng thời + job", () => {
  it("hai purge cùng lúc trên một tổ chức tới hạn ⇒ đúng một chứng nhận", async () => {
    const user = await seedAuthUser(h.t.admin, `chu+${randomUUID().slice(0, 6)}@example.test`);
    const org = randomUUID();
    const person = randomUUID();
    const m = randomUUID();
    await sql`insert into organizations (id, name, created_by) values (${org}, 'Song song', ${user})`.execute(
      h.t.admin,
    );
    await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org}, 'Chủ')`.execute(
      h.t.admin,
    );
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
              values (${m}, ${org}, ${user}, ${person}, 'owner', true)`.execute(h.t.admin);
    await sql`update organizations set status = 'pending_deletion', deletion_requested_by = ${user},
                deletion_requested_at = now() - interval '40 days', deletion_due_at = now() - interval '10 days'
              where id = ${org}`.execute(h.t.admin);
    const run = () =>
      sql<{ r: unknown }>`select app.purge_organization(${org}::uuid, '{}'::text[]) as r`.execute(h.t.worker);
    const [x, y] = await Promise.all([run(), run()]);
    expect([x.rows[0]?.r, y.rows[0]?.r].filter((v) => v !== null)).toHaveLength(1);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from org_deletion_certificates where deleted_organization_id = ${org}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });

  it("job tenancy.purge TẮT mặc định ở production, bật ở dev/test, ghi đè được bằng tuỳ chọn runtime", () => {
    expect(orgPurgeEnabled("production")).toBe(false);
    expect(orgPurgeEnabled("development")).toBe(true);
    expect(orgPurgeEnabled("test")).toBe(true);
    expect(orgPurgeEnabled(undefined)).toBe(true);
    expect(orgPurgeEnabled("production", true)).toBe(true);
    expect(orgPurgeEnabled("development", false)).toBe(false);
  });
});
