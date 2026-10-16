// PLAN đợt 3 T-217 — portal người thuê trên Postgres thật + object storage thật (SPEC-portal S-001…S-011, S-021).
// Ví dụ chung: phiếu kỳ 10/2026 phòng 101 tổng 3.580.000, đã phân bổ 2.000.000, còn 1.580.000; cọc 3.000.000.
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedLease,
  seedOrg,
  type TestDb,
  testS3Config,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { uploadFile } from "../files/files.ts";
import { eicarOnlyScanner } from "../files/inspect.ts";
import { ObjectStorage } from "../files/storage.ts";
import { collectCash } from "../payments/payments.ts";
import { openShift } from "../shifts/shifts.ts";
import { codeOf, okAs, ownerOf, runAs } from "../testing/helpers.ts";
import {
  createRequest,
  getMyInvoice,
  getMyLease,
  getPaymentInstructions,
  listMyInvoices,
  listMyMeterReadings,
  listMyRequests,
  listPaymentClaims,
  submitPaymentClaim,
} from "./tenant.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let an: Actor;
let binh: Actor;
let anLease: { leaseId: string; unitId: string };
let binhLease: { leaseId: string; unitId: string };
let storage: ObjectStorage;
let issued: string;
let draft: string;
let invAn: string;
let invBinh: string;
const meta = { correlationId: "test-corr-portal" };

async function tenant(
  org: SeededOrg,
  name: string,
): Promise<{ actor: Actor; lease: { leaseId: string; unitId: string } }> {
  const personId = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${org.orgId}, ${name})`.execute(
    t.admin,
  );
  const lease = await seedLease(t.admin, {
    orgId: org.orgId,
    propertyId: org.propertyId,
    representativePersonId: personId,
    effectiveFrom: "2026-09-01",
    rentAmount: 3_000_000,
    depositAmount: 3_000_000,
  });
  await t.admin.transaction().execute(async (trx) => {
    await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}'
              where lease_id = ${lease.leaseId}`.execute(trx);
    await sql`update leases set status = 'pending_signature' where id = ${lease.leaseId}`.execute(trx);
    await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${lease.leaseId}`.execute(
      trx,
    );
    await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                     confirmed_at, source, readings_pending, confirmation_method)
              values (${randomUUID()}, ${org.orgId}, ${org.propertyId}, ${lease.leaseId}, 'move_in', '2026-09-01', ${org.ownerMembershipId},
                      now(), 'import', false, 'import')`.execute(trx);
    await sql`update leases set status = 'active' where id = ${lease.leaseId}`.execute(trx);
  });
  const uid = await seedAuthUser(t.admin, `${randomUUID().slice(0, 8)}@example.test`);
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${randomUUID()}, ${org.orgId}, ${uid}, ${personId}, 'tenant')`.execute(t.admin);
  return {
    actor: await resolveActor(t.runtime, { authUserId: uid, orgId: org.orgId, twoFactorEnabled: false }),
    lease,
  };
}

async function period(start: string, status: "issued" | "draft"): Promise<string> {
  const id = randomUUID();
  const end = `${start.slice(0, 8)}28`;
  await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status, issued_at, issued_by)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${start}::date, ${end}::date, ${status},
                    ${status === "issued" ? new Date() : null}, ${status === "issued" ? A.ownerMembershipId : null})`.execute(
    t.admin,
  );
  return id;
}

async function invoice(
  payer: Actor,
  leaseId: string,
  periodId: string,
  lines: [string, string, number][],
): Promise<string> {
  const id = randomUUID();
  const total = lines.reduce((s, l) => s + l[2], 0);
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, lease_id, billing_period_id, number, memo_ref, payer_person_id,
                                    business_date, due_on, total)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'periodic', ${leaseId}, ${periodId}, ${`P-${id.slice(0, 8)}`},
                      ${`HM${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`}, ${payer.personId}, '2026-10-01', '2026-10-10', ${total})`.execute(
      trx,
    );
    for (const [n, [kind, desc, amount]] of lines.entries())
      await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                           quantity, unit_price, amount, rounding_rule, formula_version)
                values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${id}, ${n + 1}, ${kind}, ${desc}, 'REV_ROOM', 1, ${amount},
                        ${amount}, 'HALF_UP_1', 1)`.execute(trx);
  });
  return id;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ khác");
  owner = await ownerOf(t, A);
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
  const a = await tenant(A, "An");
  const b = await tenant(A, "Bình");
  an = a.actor;
  anLease = a.lease;
  binh = b.actor;
  binhLease = b.lease;
  issued = await period("2026-10-01", "issued");
  draft = await period("2026-11-01", "draft");
  invAn = await invoice(an, anLease.leaseId, issued, [
    ["room", "Tiền phòng", 3_000_000],
    ["utility", "Điện (1.350 − 1.250) × 3.000", 300_000],
    ["utility", "Nước 12 × 15.000", 180_000],
    ["fee", "Phí dịch vụ", 100_000],
  ]);
  await invoice(an, anLease.leaseId, draft, [["room", "Tiền phòng (nháp)", 3_000_000]]);
  invBinh = await invoice(binh, binhLease.leaseId, issued, [["room", "Tiền phòng", 2_500_000]]);
  await okAs(t, owner, (ctx) => openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }));
  await okAs(t, owner, (ctx) => collectCash(ctx, { invoiceId: invAn, amount: 2_000_000 }));
  await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, '970436', '****6789', '0123456789', 'NHA TRO HOA SEN')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t?.drop();
});

describe("S-001/S-021 danh sách kỳ thu", () => {
  it("chỉ phiếu kỳ đã phát hành của mình: 3.580.000 / đã trả 2.000.000 / còn 1.580.000, nhãn Còn nợ; kỳ nháp không hiện", async () => {
    const list = await listMyInvoices(t.runtime, an);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: invAn,
      period: "10/2026",
      total: 3_580_000,
      paid: 2_000_000,
      balance: 1_580_000,
      statusLabel: "Còn nợ",
    });
    expect(await listMyInvoices(t.runtime, an, { status: "paid" })).toEqual([]);
  });

  it("chưa có phiếu phát hành → [] (không lỗi); nhân viên gọi portal → 403", async () => {
    const c = await tenant(A, "Cúc");
    expect(await listMyInvoices(t.runtime, c.actor)).toEqual([]);
    await expect(listMyInvoices(t.runtime, owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("S-002…S-004 chi tiết phiếu và truy cập chéo", () => {
  it("dòng phiếu cộng đúng tổng + phân bổ 2.000.000", async () => {
    const d = await getMyInvoice(t.runtime, an, invAn, meta);
    expect(d.lines.map((l) => l.amount)).toEqual([3_000_000, 300_000, 180_000, 100_000]);
    expect(d.lines.reduce((s, l) => s + l.amount, 0)).toBe(d.total);
    expect(d.allocations.map((a) => a.amount)).toEqual([2_000_000]);
  });

  it("phiếu của Bình → 404 không lộ dữ liệu + audit portal.access_denied có correlation_id; tổ chức khác → 404", async () => {
    const err = await getMyInvoice(t.runtime, an, invBinh, meta).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(JSON.stringify({ message: err.message })).not.toMatch(/2\.?500\.?000|Bình/);
    const a = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'portal.access_denied' and entity_id = ${invBinh}
        and actor_person_id = ${an.personId} and correlation_id = ${meta.correlationId}`.execute(t.admin);
    expect(a.rows[0]?.n).toBe(1);
    const other = await tenant(B, "Người B");
    await expect(getMyInvoice(t.runtime, other.actor, invAn, meta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("S-006 hợp đồng và cọc", () => {
  it("phiên bản đang hiệu lực + cọc tách nhãn; không có giấy tờ", async () => {
    await sql`insert into deposits (id, organization_id, property_id, lease_id, payer_person_id, amount)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${anLease.leaseId}, ${an.personId}, 3000000)`.execute(
      t.admin,
    );
    const l = await getMyLease(t.runtime, an);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({
      id: anLease.leaseId,
      status: "active",
      currentVersion: { versionNo: 1, rentAmount: 3_000_000 },
      deposit: { amount: 3_000_000, balance: 3_000_000, label: "Cọc — không phải tiền đã trả cho phiếu" },
    });
    expect(JSON.stringify(l)).not.toMatch(/doc_number|cccd|passport/i);
  });
});

describe("S-007 chỉ số đã duyệt", () => {
  it("thấy 1.350 đã duyệt kèm URL ảnh ký ngắn hạn; không thấy 1.420 nháp; không thấy công tơ phòng Bình", async () => {
    const meter = randomUUID();
    const meterB = randomUUID();
    const photo = randomUUID();
    for (const [id, unit] of [
      [meter, anLease.unitId],
      [meterB, binhLease.unitId],
    ])
      await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on)
                values (${id}, ${A.orgId}, ${A.propertyId}, ${unit}, 'electric', '2026-09-01')`.execute(
        t.admin,
      );
    const key = `${A.orgId}/meter_reading/${photo}`;
    await storage.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
    await sql`insert into files (id, organization_id, property_id, owner_type, storage_key, mime, size_bytes, sha256, status, exif_stripped,
                                 uploaded_by)
              values (${photo}, ${A.orgId}, ${A.propertyId}, 'meter_reading', ${key}, 'image/jpeg', 4, ${"b".repeat(64)}, 'ready', true,
                      ${A.ownerMembershipId})`.execute(t.admin);
    const reading = (m: string, readOn: string, value: number, status: string, file: string | null) =>
      sql`insert into meter_readings (id, organization_id, property_id, meter_id, read_on, value, photo_file_id, status, source,
                                      entered_by, approved_by)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${m}, ${readOn}::date, ${value}, ${file}, ${status}, 'import',
                  ${A.ownerMembershipId}, ${status === "approved" ? A.ownerMembershipId : null})`.execute(
        t.admin,
      );
    await reading(meter, "2026-10-31", 1350, "approved", photo);
    await reading(meter, "2026-11-30", 1420, "draft", null);
    await reading(meterB, "2026-10-31", 999, "approved", null);
    const r = await listMyMeterReadings(t.runtime, an, { storage });
    expect(r.map((x) => [x.kind, x.readOn, x.value])).toEqual([["electric", "2026-10-31", 1350]]);
    expect(r[0]?.photoUrl).toMatch(/X-Amz-Expires=300/);
    expect((await fetch(r[0]?.photoUrl as string)).status).toBe(200);
  });
});

describe("S-008/S-009 yêu cầu sửa chữa", () => {
  it("gửi kèm 1 ảnh JPEG → 201, phiếu open phòng mình, nhãn Đã tiếp nhận; trạng thái đổi → nhãn tiếng Việt, không tên nhân viên", async () => {
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      16,
      ...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
      0xff,
      0xda,
      0,
      8,
      1,
      1,
      0,
      0,
      0x3f,
      0,
      0x12,
      0x34,
      0xff,
      0xd9,
    ]);
    const f = await okAs(t, an, (ctx) =>
      uploadFile(
        ctx,
        { storage, scanner: eicarOnlyScanner },
        { ownerType: "work_order", propertyId: A.propertyId, bytes: jpeg },
      ),
    );
    expect(f.status).toBe("ready");
    const key = randomUUID();
    const r = await runAs(
      t,
      an,
      (ctx) =>
        createRequest(ctx, {
          unitId: anLease.unitId,
          title: "Vòi nước rò",
          description: "Rò dưới bồn rửa",
          fileIds: [f.fileId],
        }),
      { key, command: "portal.createRequest", payload: { unit_id: anLease.unitId } },
    );
    if (r.status !== "committed") throw new Error(JSON.stringify(r));
    expect(r.data.statusLabel).toBe("Đã tiếp nhận");
    expect(r.data.rejectedFileIds).toEqual([]);
    // Phòng của Bình → 404.
    expect(
      await codeOf(
        runAs(t, an, (ctx) => createRequest(ctx, { unitId: binhLease.unitId, title: "x", description: "y" })),
      ),
    ).toBe("NOT_FOUND");
    // Mô tả rỗng → 422.
    expect(
      await codeOf(
        runAs(t, an, (ctx) => createRequest(ctx, { unitId: anLease.unitId, title: "x", description: "  " })),
      ),
    ).toBe("VALIDATION_FAILED");
    await sql`update work_orders set status = 'assigned', assignee_membership_id = ${A.ownerMembershipId}
              where id = ${r.data.requestId}`.execute(t.admin);
    const list = await listMyRequests(t.runtime, an);
    expect(list.map((x) => x.statusLabel)).toEqual(["Đã giao thợ"]);
    expect(list[0]?.updatedAtLocal).toMatch(/^\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    expect(JSON.stringify(list)).not.toMatch(/assignee|membership/i);
    expect(await listMyRequests(t.runtime, binh)).toEqual([]);
  });
});

describe("S-010/S-011 QR + Tôi đã chuyển", () => {
  it("QR + mã tham chiếu của phiếu mình; phiếu Bình → 404", async () => {
    const p = await getPaymentInstructions(t.runtime, an, invAn, meta);
    expect(p).toMatchObject({ amountDue: 1_580_000, account: { accountNumber: "0123456789" } });
    expect(p.qrPayload).toContain("0123456789");
    await expect(getPaymentInstructions(t.runtime, an, invBinh, meta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("báo chuyển submitted, số dư không đổi, không payment/bút toán mới; cùng key → kết quả cũ, khác thân → 409; nhân viên thấy hàng chờ", async () => {
    const before = await sql<{ p: number; j: number }>`
      select (select count(*)::int from payments where organization_id = ${A.orgId}) as p,
             (select count(*)::int from journal_entries where organization_id = ${A.orgId}) as j`.execute(
      t.admin,
    );
    const key = randomUUID();
    const send = (amount: number) =>
      runAs(t, an, (ctx) => submitPaymentClaim(ctx, { invoiceId: invAn, amount }), {
        key,
        command: "portal.submitPaymentClaim",
        payload: { invoice_id: invAn, amount },
      });
    const r1 = await send(1_580_000);
    if (r1.status !== "committed") throw new Error(JSON.stringify(r1));
    expect(r1.data.message).toBe("Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền");
    expect(await send(1_580_000)).toMatchObject({ status: "committed", replayed: true });
    await expect(send(1_000_000)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    const after = await sql<{ p: number; j: number; c: number; open: string }>`
      select (select count(*)::int from payments where organization_id = ${A.orgId}) as p,
             (select count(*)::int from journal_entries where organization_id = ${A.orgId}) as j,
             (select count(*)::int from payment_claims where invoice_id = ${invAn}) as c,
             (select open_amount::text from invoices where id = ${invAn}) as open`.execute(t.admin);
    expect(after.rows[0]).toEqual({ p: before.rows[0]?.p, j: before.rows[0]?.j, c: 1, open: "1580000" });
    const q = await listPaymentClaims(t.runtime, owner, { propertyId: A.propertyId });
    expect(q.map((c) => [c.invoiceId, c.amount])).toEqual([[invAn, 1_580_000]]);
    // Người thuê khác không thấy báo chuyển của An; số tiền ≤ 0 → 422; phiếu của người khác → 404 + audit.
    const theirs = await sql<{ n: number }>`select count(*)::int as n from payment_claims`.execute(t.admin);
    expect(theirs.rows[0]?.n).toBe(1);
    expect(
      await codeOf(runAs(t, an, (ctx) => submitPaymentClaim(ctx, { invoiceId: invAn, amount: 0 }))),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(runAs(t, an, (ctx) => submitPaymentClaim(ctx, { invoiceId: invBinh, amount: 1 }))),
    ).toBe("NOT_FOUND");
    const d = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'portal.access_denied' and entity_id = ${invBinh}`.execute(
      t.admin,
    );
    expect(d.rows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("ảnh chứng từ (Q-07): gắn vào báo chuyển; owner xem được, người thuê khác không; ảnh của người khác → 422", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const f = await okAs(t, an, (ctx) =>
      uploadFile(
        ctx,
        { storage, scanner: eicarOnlyScanner },
        { ownerType: "payment_claim", propertyId: A.propertyId, bytes: pdf },
      ),
    );
    expect(f.status).toBe("ready");
    expect(
      await codeOf(
        runAs(t, binh, (ctx) =>
          submitPaymentClaim(ctx, { invoiceId: invBinh, amount: 10, proofFileId: f.fileId }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    const r = await okAs(t, an, (ctx) =>
      submitPaymentClaim(ctx, { invoiceId: invAn, amount: 500_000, proofFileId: f.fileId }),
    );
    const { withTenant } = await import("@hm/db");
    const sees = (a: Actor) =>
      withTenant(
        t.runtime,
        { orgId: A.orgId, actorId: a.membershipId },
        async (trx) =>
          (await sql<{ n: number }>`select count(*)::int as n from files where id = ${f.fileId}`.execute(trx))
            .rows[0]?.n,
      );
    expect(await sees(owner)).toBe(1);
    expect(await sees(an)).toBe(1);
    expect(await sees(binh)).toBe(0);
    const c = await sql<{ proof_file_id: string; owner_id: string }>`
      select c.proof_file_id, f.owner_id from payment_claims c join files f on f.id = c.proof_file_id where c.id = ${r.claimId}`.execute(
      t.admin,
    );
    expect(c.rows[0]).toEqual({ proof_file_id: f.fileId, owner_id: r.claimId });
  });
});
