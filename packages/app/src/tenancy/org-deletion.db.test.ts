// T-2312 (IND-SAAS-006, UX-CONTENT-005; D-121) — vòng đời xoá tổ chức trên Postgres 17 + SeaweedFS thật: yêu cầu (chỉ owner, xác thực lại
// ≤ 5 phút, gõ lại tên) → chờ 30 ngày (chỉ đọc + xuất; lệnh ghi 423) → huỷ một bước; purge sau hạn (đúng mốc 30 ngày) → truy vấn từng kho
// = rỗng trừ phần giữ có lý do; chứng nhận đúng số đếm + băm; chạy lại idempotent; đồng thời; quyền hàm/bảng; kế hoạch purge đối chiếu
// catalog (bảng tổ chức mới chưa xếp loại ⇒ đỏ).
import { createHash, randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedIssuedInvoice,
  seedOrg,
  type TestDb,
  testS3Config,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/index.ts";
import { ObjectStorage } from "../files/index.ts";
import { codeOf, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import {
  cancelOrgDeletion,
  myOrgDeletionCertificates,
  ORG_DELETION_GRACE_DAYS,
  orgDeletionStatus,
  processOrgPurges,
  purgeOrganization,
  requestOrgDeletion,
} from "./index.ts";

const DAY = 86_400_000;
let t: TestDb;
let storage: ObjectStorage;

beforeAll(async () => {
  t = await createTestDb();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
});
afterAll(async () => {
  await t?.drop();
});

const fresh = (a: Actor): Actor => ({ ...a, authenticatedAt: new Date(Date.now() - 30_000) });
const request = (a: Actor, confirmName: string) =>
  runAs(t, a, (ctx) => requestOrgDeletion(ctx, { confirmName }), { command: "org.requestDeletion" });
const cancel = (a: Actor) => runAs(t, a, (ctx) => cancelOrgDeletion(ctx), { command: "org.cancelDeletion" });
/** Một lệnh ghi bất kỳ (không thuộc danh sách được phép khi chờ xoá). */
const write = (a: Actor) =>
  runAs(t, a, async (ctx) => {
    await sql`update properties set name = name where organization_id = ${a.orgId}`.execute(ctx.trx);
    return 1;
  });
const count = async (table: string, orgId: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${orgId}`.execute(t.admin)
  ).rows[0]?.n ?? 0;
const plan = async () =>
  (
    await sql<{ table_name: string; action: string; reason: string | null }>`
      select table_name, action, reason from app.org_purge_plan() order by ord`.execute(t.admin)
  ).rows;

describe("kế hoạch purge đối chiếu catalog (bảng tổ chức mới không bị sót)", () => {
  it("mỗi bảng public có organization_id (+ organizations) có đúng một hành động; không mục thừa; giữ/ẩn danh luôn có lý do", async () => {
    const cat = await sql<{ table_name: string }>`
      select c.relname as table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and (c.relname = 'organizations' or exists (select 1 from pg_attribute a where a.attrelid = c.oid
             and a.attname = 'organization_id' and not a.attisdropped))
      order by 1`.execute(t.admin);
    const p = await plan();
    const names = p.map((x) => x.table_name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(cat.rows.map((r) => r.table_name));
    expect(cat.rows.length).toBeGreaterThan(60);
    for (const x of p) {
      expect(["delete", "anonymize", "retain"]).toContain(x.action);
      if (x.action !== "delete") expect(x.reason, x.table_name).toBeTruthy();
    }
  });

  it("bảng bị xoá không bị bảng giữ/ẩn danh tham chiếu (FK) — trừ files (chỉ xoá file không được tham chiếu)", async () => {
    const r = await sql<{ child: string; parent: string }>`
      select distinct cl.relname as child, pl.relname as parent from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid join pg_class pl on pl.oid = k.confrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where k.contype = 'f' and n.nspname = 'public'`.execute(t.admin);
    const p = await plan();
    const act = new Map(p.map((x) => [x.table_name, x.action]));
    const bad = r.rows.filter(
      (e) => act.get(e.parent) === "delete" && e.parent !== "files" && act.get(e.child) !== "delete",
    );
    expect(bad).toEqual([]);
    // Thứ tự xoá: con trước cha (bảng bị xoá tham chiếu bảng bị xoá khác ⇒ con có ord nhỏ hơn), trừ cặp FK hoãn blocks ↔ work_orders.
    const ord = new Map(p.map((x, i) => [x.table_name, i]));
    const misordered = r.rows.filter(
      (e) =>
        act.get(e.child) === "delete" &&
        act.get(e.parent) === "delete" &&
        e.child !== e.parent &&
        (ord.get(e.child) as number) > (ord.get(e.parent) as number) &&
        !(e.child === "work_orders" && e.parent === "blocks"),
    );
    expect(misordered).toEqual([]);
  });

  it("bảng tham chiếu files đúng tập đã biết (thêm FK tới files ⇒ phải xét lại app.org_purge_kept_object_keys)", async () => {
    const r = await sql<{ child: string }>`
      select distinct cl.relname as child from pg_constraint k join pg_class cl on cl.oid = k.conrelid
      where k.contype = 'f' and k.confrelid = 'public.files'::regclass order by 1`.execute(t.admin);
    expect(r.rows.map((x) => x.child)).toEqual([
      "export_jobs",
      "identity_documents",
      "import_batches",
      "meter_events",
      "meter_readings",
      "payment_claims",
      "residence_notices",
    ]);
  });
});

describe("yêu cầu / huỷ xoá (owner, xác thực lại, gõ lại tên)", () => {
  let A: SeededOrg;
  let owner: Actor;
  let manager: Actor;
  beforeAll(async () => {
    A = await seedOrg(t.admin, "Nhà nghỉ Xoá Thử");
    owner = await ownerOf(t, A);
    manager = await seedMember(t, A, "manager");
  });

  it("bị từ chối: manager ⇒ FORBIDDEN; owner chưa xác thực lại ⇒ REAUTH_REQUIRED; tên sai ⇒ CONFIRMATION_MISMATCH; không đổi gì", async () => {
    expect(await codeOf(request(fresh(manager), "Nhà nghỉ Xoá Thử"))).toBe("FORBIDDEN");
    expect(await codeOf(request(owner, "Nhà nghỉ Xoá Thử"))).toBe("REAUTH_REQUIRED");
    expect(
      await codeOf(
        request({ ...owner, authenticatedAt: new Date(Date.now() - 301_000) }, "Nhà nghỉ Xoá Thử"),
      ),
    ).toBe("REAUTH_REQUIRED");
    expect(await codeOf(request(fresh(owner), "nhà nghỉ xoá thử"))).toBe("CONFIRMATION_MISMATCH");
    expect(await codeOf(request(fresh(owner), ""))).toBe("CONFIRMATION_MISMATCH");
    expect((await orgDeletionStatus(t.runtime, owner)).state).toBe("active");
    const denied = await sql<{ n: number }>`select count(*)::int as n from audit_events
      where organization_id = ${A.orgId} and action = 'command.denied'`.execute(t.admin);
    expect(denied.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("owner xác thực lại + đúng tên (khoảng trắng thừa, NFD) ⇒ chờ xoá; hạn = yêu cầu + đúng 30 ngày; audit", async () => {
    const r = await request(fresh(owner), "  Nhà nghỉ Xoá Thử ".normalize("NFD"));
    expect(r.status).toBe("committed");
    const st = await orgDeletionStatus(t.runtime, manager);
    expect(st.state).toBe("pending");
    expect((st.dueAt as Date).getTime() - (st.requestedAt as Date).getTime()).toBe(
      ORG_DELETION_GRACE_DAYS * DAY,
    );
    const a = await sql<{ action: string }>`select action from audit_events
      where organization_id = ${A.orgId} and action = 'organization.deletion_requested'`.execute(t.admin);
    expect(a.rows).toHaveLength(1);
  });

  it("chờ xoá: lệnh ghi ⇒ 423 ORG_PENDING_DELETION; xuất dữ liệu vẫn chạy; yêu cầu lại ⇒ 423", async () => {
    expect(await codeOf(write(owner))).toBe("ORG_PENDING_DELETION");
    expect(await codeOf(write(manager))).toBe("ORG_PENDING_DELETION");
    const exp = await runAs(t, owner, async () => 1, { command: "exports.requestOrgExport" });
    expect(exp.status).toBe("committed");
    expect(await codeOf(request(fresh(owner), "Nhà nghỉ Xoá Thử"))).toBe("ORG_PENDING_DELETION");
  });

  it("CSDL: vai trò app không phải owner không đổi được cột xoá; không ai ngoài job đặt deleted_at", async () => {
    await expect(
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${manager.membershipId}, true)`.execute(
          trx,
        );
        await sql`update organizations set deletion_requested_at = null, deletion_due_at = null, deletion_requested_by = null
                  where id = ${A.orgId}`.execute(trx);
      }),
    ).rejects.toThrow(/chỉ owner/);
    await expect(
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true), set_config('app.actor_id', ${owner.membershipId}, true)`.execute(
          trx,
        );
        await sql`update organizations set deleted_at = deletion_due_at where id = ${A.orgId}`.execute(trx);
      }),
    ).rejects.toThrow(/deleted_at/);
    // Hạn phải đúng +30 ngày (CHECK).
    await expect(
      sql`update organizations set deletion_due_at = deletion_due_at + interval '1 second' where id = ${A.orgId}`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_organizations_deletion/);
  });

  it("huỷ: manager ⇒ FORBIDDEN; owner MỘT bước (không xác thực lại, không gõ gì) ⇒ bình thường, ghi lại được; huỷ lần nữa ⇒ 409", async () => {
    expect(await codeOf(cancel(manager))).toBe("FORBIDDEN");
    const r = await cancel(owner);
    expect(r.status).toBe("committed");
    expect((await orgDeletionStatus(t.runtime, owner)).state).toBe("active");
    expect(await codeOf(write(manager))).toBe("COMMITTED");
    expect(await codeOf(cancel(owner))).toBe("INVALID_TRANSITION");
    const a = await sql<{ action: string }>`select action from audit_events
      where organization_id = ${A.orgId} and action = 'organization.deletion_cancelled'`.execute(t.admin);
    expect(a.rows).toHaveLength(1);
  });

  it("đồng thời: hai yêu cầu song song ⇒ đúng một committed, bên kia 423", async () => {
    const codes = await Promise.all([
      codeOf(request(fresh(owner), "Nhà nghỉ Xoá Thử")),
      codeOf(request(fresh(owner), "Nhà nghỉ Xoá Thử")),
    ]);
    expect(codes.sort()).toEqual(["COMMITTED", "ORG_PENDING_DELETION"]);
    expect((await cancel(owner)).status).toBe("committed");
  });

  it("đã tới mốc purge ⇒ huỷ bị từ chối (409), không khôi phục nửa vời", async () => {
    expect((await request(fresh(owner), "Nhà nghỉ Xoá Thử")).status).toBe("committed");
    await sql`update organizations set deletion_requested_at = now() - interval '30 days 1 second',
                                       deletion_due_at = now() - interval '1 second' where id = ${A.orgId}`.execute(
      t.admin,
    );
    expect(await codeOf(cancel(owner))).toBe("INVALID_TRANSITION");
    expect((await orgDeletionStatus(t.runtime, owner)).state).toBe("pending");
    // Dọn để các nhóm sau (job duyệt MỌI tổ chức tới hạn) không purge tổ chức này.
    await sql`update organizations set deletion_requested_at = null, deletion_due_at = null, deletion_requested_by = null
              where id = ${A.orgId}`.execute(t.admin);
  });
});

describe("purge sau hạn: mọi kho rỗng trừ phần giữ có lý do; chứng nhận; idempotent", () => {
  let P: SeededOrg;
  let B: SeededOrg;
  let owner: Actor;
  let requestedAt: Date;
  let dueAt: Date;
  const objects: string[] = [];
  let otherKey = "";
  let keptPersons = 0;

  beforeAll(async () => {
    P = await seedOrg(t.admin, "Khách sạn Purge");
    B = await seedOrg(t.admin, "Khách sạn Giữ Nguyên");
    owner = await ownerOf(t, P);
    const payer = randomUUID();
    const stranger = randomUUID();
    for (const [id, name] of [
      [payer, "Người trả tiền (giả)"],
      [stranger, "Người không chứng từ (giả)"],
    ] as const)
      await sql`insert into persons (id, organization_id, full_name, email, phone, address)
                values (${id}, ${P.orgId}, ${name}, ${`p-${id.slice(0, 6)}@example.test`}, '0912345678', 'Số 1 (giả)')`.execute(
        t.admin,
      );
    keptPersons = 1;
    await seedIssuedInvoice(t.admin, {
      orgId: P.orgId,
      propertyId: P.propertyId,
      payerPersonId: payer,
      lines: [{ amount: 150_000 }],
    });
    // Phân tích, lời mời, giấy tờ (đã ẩn danh dạng), file + object, object mồ côi theo tiền tố.
    for (const org of [P, B])
      await sql`insert into product_events (organization_id, event, props) values (${org.orgId}, 'room.viewed', '{}'::jsonb),
                (${org.orgId}, 'stay.checked_in', '{}'::jsonb)`.execute(t.admin);
    await sql`insert into invitations (id, organization_id, email, role, token_hash, expires_at, invited_by)
              values (${randomUUID()}, ${P.orgId}, 'moi@example.test', 'manager', ${Buffer.alloc(32, 7)},
                      now() + interval '1 day', ${P.ownerMembershipId})`.execute(t.admin);
    await sql`insert into identity_documents (id, organization_id, person_id, doc_type, anonymized_at)
              values (${randomUUID()}, ${P.orgId}, ${stranger}, 'cccd', now())`.execute(t.admin);
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      const key = `${P.orgId}/identity_document/${id}`;
      await sql`insert into files (id, organization_id, owner_type, mime, size_bytes, sha256, status, storage_key)
                values (${id}, ${P.orgId}, 'identity_document', 'application/pdf', 3, ${"a".repeat(64)}, 'ready', ${key})`.execute(
        t.admin,
      );
      await storage.put(key, new Uint8Array([1, 2, 3]), "application/pdf");
      objects.push(key);
    }
    const orphan = `${P.orgId}/staging/${randomUUID()}`;
    await storage.put(orphan, new Uint8Array([9]), "application/pdf");
    objects.push(orphan);
    otherKey = `${B.orgId}/identity_document/${randomUUID()}`;
    await storage.put(otherKey, new Uint8Array([4]), "application/pdf");
    // Lệnh qua pipeline ⇒ idempotency_keys + audit; rồi yêu cầu xoá.
    expect(await codeOf(write(owner))).toBe("COMMITTED");
    expect((await request(fresh(owner), "Khách sạn Purge")).status).toBe("committed");
    const st = await orgDeletionStatus(t.runtime, owner);
    requestedAt = st.requestedAt as Date;
    dueAt = st.dueAt as Date;
  });

  it("ca biên: 1 ms trước mốc 30 ngày ⇒ không purge; đúng mốc ⇒ purge", async () => {
    const before = await processOrgPurges(t.worker, storage, { now: new Date(dueAt.getTime() - 1) });
    expect(before).toEqual({ purged: 0, failed: 0 });
    expect(await storage.listKeys(`${P.orgId}/`)).toHaveLength(objects.length);
    const pre = {
      product_events: await count("product_events", P.orgId),
      files: await count("files", P.orgId),
      invoices: await count("invoices", P.orgId),
      idempotency_keys: await count("idempotency_keys", P.orgId),
    };
    expect(pre.product_events).toBe(2);
    const b0 = { events: await count("product_events", B.orgId), persons: await count("persons", B.orgId) };

    const r = await processOrgPurges(t.worker, storage, { now: dueAt });
    expect(r).toEqual({ purged: 1, failed: 0 });

    // Từng kho "xoá" = rỗng (truy vấn trực tiếp từng bảng theo kế hoạch CSDL).
    for (const x of await plan())
      if (x.action === "delete") expect(await count(x.table_name, P.orgId), x.table_name).toBe(0);
    expect(await storage.listKeys(`${P.orgId}/`)).toEqual([]);
    // Tổ chức khác không bị đụng.
    expect(await storage.listKeys(`${B.orgId}/`)).toEqual([otherKey]);
    expect(await count("product_events", B.orgId)).toBe(b0.events);
    expect(await count("persons", B.orgId)).toBe(b0.persons);
    // Phần giữ: chứng từ tiền nguyên vẹn; người không gắn chứng từ ẩn danh; người trả tiền giữ tên, bỏ liên lạc; membership thu hồi.
    expect(await count("invoices", P.orgId)).toBe(pre.invoices);
    const ps = await sql<{
      full_name: string;
      email: string | null;
      phone: string | null;
      address: string | null;
      anon: boolean;
    }>`
      select full_name, email, phone, address, anonymized_at is not null as anon from persons where organization_id = ${P.orgId}
      order by full_name`.execute(t.admin);
    expect(ps.rows.every((p) => p.email === null && p.phone === null && p.address === null)).toBe(true);
    expect(ps.rows.filter((p) => !p.anon).map((p) => p.full_name)).toEqual(["Người trả tiền (giả)"]);
    const ms = await sql<{ n: number }>`select count(*)::int as n from memberships
      where organization_id = ${P.orgId} and status <> 'revoked'`.execute(t.admin);
    expect(ms.rows[0]?.n).toBe(0);
    const org = await sql<{
      name: string;
      deleted_at: Date;
    }>`select name, deleted_at from organizations where id = ${P.orgId}`.execute(t.admin);
    expect(org.rows[0]?.name).toBe("—");
    expect(org.rows[0]?.deleted_at.getTime()).toBe(dueAt.getTime());

    // Chứng nhận: số đếm + băm khớp; phần giữ có lý do.
    const c = await sql<{ content: string; content_sha256: string; requested_by: string; purged_at: Date }>`
      select content, content_sha256, requested_by, purged_at from org_deletion_certificates
      where organization_id = ${P.orgId}`.execute(t.admin);
    expect(c.rows).toHaveLength(1);
    const cert = c.rows[0] as {
      content: string;
      content_sha256: string;
      requested_by: string;
      purged_at: Date;
    };
    expect(createHash("sha256").update(cert.content, "utf8").digest("hex")).toBe(cert.content_sha256);
    expect(cert.requested_by).toBe(P.ownerAuthUserId);
    const body = JSON.parse(cert.content) as {
      organization_id: string;
      requested_at: string;
      erased: Record<string, number>;
      retained: { store: string; rows: number; reason: string }[];
    };
    expect(body.organization_id).toBe(P.orgId);
    expect(new Date(body.requested_at).getTime()).toBe(requestedAt.getTime());
    expect(body.erased.product_events).toBe(2);
    expect(body.erased.files).toBe(pre.files);
    expect(body.erased.objects).toBe(objects.length);
    expect(body.erased.invitations).toBe(1);
    expect(body.erased.identity_documents).toBe(1);
    expect(body.erased.idempotency_keys).toBe(pre.idempotency_keys);
    expect(body.erased.persons_anonymized).toBe(ps.rows.length - keptPersons);
    expect(body.retained).toContainEqual({
      store: "invoices",
      rows: 1,
      reason: "accounting_records_retention",
    });
    expect(body.retained).toContainEqual({
      store: "persons",
      rows: ps.rows.length,
      reason: "accounting_records_retention",
    });
    expect(body.retained.find((x) => x.store === "audit_events")?.reason).toBe("security_audit_trail");
    expect(body.retained.every((x) => x.reason.length > 0)).toBe(true);
    const audit = await sql<{ actor_type: string }>`select actor_type from audit_events
      where organization_id = ${P.orgId} and action = 'organization.purged'`.execute(t.admin);
    expect(audit.rows).toEqual([{ actor_type: "worker" }]);
  });

  it("sau purge: chủ cũ không còn vào tổ chức; tải được chứng nhận của mình; người khác không thấy", async () => {
    await expect(
      resolveActor(t.runtime, { authUserId: P.ownerAuthUserId, orgId: P.orgId, twoFactorEnabled: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const mine = await myOrgDeletionCertificates(t.runtime, P.ownerAuthUserId);
    expect(mine.map((c) => c.organizationId)).toEqual([P.orgId]);
    expect(
      createHash("sha256")
        .update(mine[0]?.content ?? "", "utf8")
        .digest("hex"),
    ).toBe(mine[0]?.contentSha256);
    expect(await myOrgDeletionCertificates(t.runtime, B.ownerAuthUserId)).toEqual([]);
    expect(await myOrgDeletionCertificates(t.runtime, "không-phải-uuid")).toEqual([]);
  });

  it("chạy lại idempotent: không còn trong danh sách tới hạn; gọi thẳng trả lại đúng chứng nhận cũ; vẫn một chứng nhận, một audit", async () => {
    expect(await processOrgPurges(t.worker, storage, { now: new Date(dueAt.getTime() + DAY) })).toEqual({
      purged: 0,
      failed: 0,
    });
    const again = await purgeOrganization(t.worker, storage, P.orgId, new Date(dueAt.getTime() + DAY));
    const c = await sql<{
      content: string;
    }>`select content from org_deletion_certificates where organization_id = ${P.orgId}`.execute(t.admin);
    expect(c.rows).toHaveLength(1);
    expect(again.certificate).toEqual(JSON.parse(c.rows[0]?.content ?? "{}"));
    const audit = await sql<{ n: number }>`select count(*)::int as n from audit_events
      where organization_id = ${P.orgId} and action = 'organization.purged'`.execute(t.admin);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("chứng nhận bất biến (không sửa/xoá, kể cả admin) và còn sau purge (không FK tới organizations)", async () => {
    await expect(
      sql`update org_deletion_certificates set content_sha256 = ${"0".repeat(64)} where organization_id = ${P.orgId}`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`delete from org_deletion_certificates where organization_id = ${P.orgId}`.execute(t.admin),
    ).rejects.toThrow(/append-only/);
    const fk = await sql<{ n: number }>`select count(*)::int as n from pg_constraint
      where contype = 'f' and conrelid = 'public.org_deletion_certificates'::regclass`.execute(t.admin);
    expect(fk.rows[0]?.n).toBe(0);
    await expect(
      sql`insert into org_deletion_certificates (organization_id, requested_by, requested_at, due_at, purged_at, content, content_sha256)
          values (${randomUUID()}, ${randomUUID()}, now() - interval '31 days', now() - interval '1 day', now(), '{}', ${"0".repeat(64)})`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_org_deletion_certificates_hash/);
  });

  it("tổ chức đã purge bất biến với vai trò app", async () => {
    await expect(
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${P.orgId}, true), set_config('app.actor_id', ${P.ownerMembershipId}, true)`.execute(
          trx,
        );
        await sql`update organizations set name = 'Hồi sinh' where id = ${P.orgId}`.execute(trx);
      }),
    ).rejects.toThrow(/đã xoá/);
  });
});

describe("đồng thời và quyền", () => {
  it("hai lượt purge song song cùng tổ chức ⇒ đúng một chứng nhận, cả hai trả cùng nội dung", async () => {
    const C = await seedOrg(t.admin, "Nhà trọ Song Song", "rental");
    const o = await ownerOf(t, C);
    expect((await request(fresh(o), "Nhà trọ Song Song")).status).toBe("committed");
    const st = await orgDeletionStatus(t.runtime, o);
    const now = st.dueAt as Date;
    const [a, b] = await Promise.all([
      purgeOrganization(t.worker, null, C.orgId, now),
      purgeOrganization(t.worker, null, C.orgId, now),
    ]);
    expect(a.certificate).not.toBeNull();
    expect(a.certificate).toEqual(b.certificate);
    expect(await count("org_deletion_certificates", C.orgId)).toBe(1);
  });

  it("purge chưa tới hạn / tổ chức không chờ xoá ⇒ NULL, không đổi gì", async () => {
    const D = await seedOrg(t.admin, "Nhà nghỉ Bình Thường");
    const r = await purgeOrganization(t.worker, null, D.orgId, new Date(Date.now() + 365 * DAY));
    expect(r.certificate).toBeNull();
    expect(await count("memberships", D.orgId)).toBe(1);
  });

  it("được phép: app_worker gọi hàm purge; bị từ chối: app_runtime gọi purge/kế hoạch, app_worker/app_runtime đọc thẳng bảng chứng nhận", async () => {
    await expect(
      sql`select app.org_purge_execute(${randomUUID()}::uuid, now(), 0, 0)`.execute(t.runtime),
    ).rejects.toThrow(/permission denied/);
    await expect(sql`select * from app.org_deletion_due(now(), 1)`.execute(t.runtime)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`select * from org_deletion_certificates`.execute(t.worker)).rejects.toThrow(
      /permission denied|app\.org_id/,
    );
    await expect(sql`select * from org_deletion_certificates`.execute(t.runtime)).rejects.toThrow(
      /permission denied|app\.org_id/,
    );
    await expect(sql`select * from app.org_deletion_my_certificates()`.execute(t.worker)).rejects.toThrow(
      /permission denied/,
    );
    const ok = await sql`select * from app.org_deletion_due(now(), 1)`.execute(t.worker);
    expect(Array.isArray(ok.rows)).toBe(true);
  });
});
