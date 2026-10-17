// PLAN đợt 2 T-110 — bàn giao, kích hoạt, phụ lục, nhắc hết hạn, quá hạn trên Postgres thật
// (SPEC-lease S-005…S-007, S-011, S-013…S-015; INV-G4, INV-I4).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import { activateLease, type RecordHandoverInput, recordHandover, renewLease } from "./handover.ts";
import { detectOverstay, remindExpiring } from "./jobs.ts";
import { createDraft, getLease, type LeaseTerms, signLease, submitForSignature } from "./lease.ts";

let t: TestDb;
let A: SeededOrg;
let M: Actor;
let F: Actor;
let H: Actor;

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${person}, ${A.orgId}, ${role}, '0100000000')`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "lease_handover.test", idempotencyKey: key, payload: { key }, correlationId: "c-handover" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<{ status: string; problem?: unknown }>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as { code: string; status: number; errors?: { field: string }[] };
}

/** Phòng mới có công tơ điện (chỉ số lắp 1.000) và nước (300). */
async function unitWithMeters(meters: ("electric" | "water")[] = ["electric", "water"]) {
  const unitId = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${unitId}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, ${`H${unitId.slice(0, 6)}`})`.execute(
    t.admin,
  );
  for (const kind of meters) {
    await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, ${kind}, '2026-01-01',
                      ${kind === "electric" ? 1000 : 300})`.execute(t.admin);
  }
  return unitId;
}

async function photo(ownerType = "handover"): Promise<string> {
  const id = randomUUID();
  await sql`insert into files (id, organization_id, property_id, owner_type, mime, size_bytes, sha256, storage_key, status, exif_stripped)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${ownerType}, 'image/jpeg', 1000, ${"a".repeat(64)},
                    ${`${A.orgId}/handover/${id}`}, 'ready', true)`.execute(t.admin);
  return id;
}

const TERMS: LeaseTerms = {
  effectiveFrom: "2026-11-01",
  effectiveTo: "2027-10-31",
  rentAmount: 3_000_000,
  depositAmount: 3_000_000,
  services: [],
};

/** Hợp đồng đã ký (signed_awaiting_handover). */
async function signedLease(unitId: string, terms: LeaseTerms = TERMS) {
  const rep = randomUUID();
  await sql`insert into persons (id, organization_id, full_name, phone) values (${rep}, ${A.orgId}, 'Người thuê A', '0100001111')`.execute(
    t.admin,
  );
  const { leaseId } = await ok(
    run(M, async (ctx) => ({
      data: await createDraft(ctx, {
        unitId,
        representativePersonId: rep,
        billingStartOn: terms.effectiveFrom,
        terms,
      }),
    })),
  );
  await ok(run(M, async (ctx) => ({ data: await submitForSignature(ctx, { leaseId }) })));
  await ok(
    run(M, async (ctx) => ({
      data: await signLease(ctx, { leaseId, signerPersonId: rep, now: new Date("2026-10-20T03:00:00Z") }),
    })),
  );
  return { leaseId, rep };
}

async function handoverInput(
  leaseId: string,
  over: Partial<RecordHandoverInput> = {},
): Promise<RecordHandoverInput> {
  return {
    leaseId,
    kind: "move_in",
    handedOverOn: "2026-11-01",
    readings: { electric: 1250, water: 340 },
    assets: [
      { name: "Giường", quantity: 1, condition: "Tốt", fileIds: [await photo()] },
      { name: "Tủ lạnh", quantity: 1, condition: "Trầy nhẹ" },
      { name: "Điều hoà", quantity: 1, condition: "Tốt" },
    ],
    keysCount: 2,
    photoFileIds: [await photo()],
    tenantConfirmation: { method: "in_person" },
    ...over,
  };
}

/** Hợp đồng đang hiệu lực (đã bàn giao + kích hoạt). */
async function activeLease(terms: LeaseTerms = TERMS) {
  const unitId = await unitWithMeters();
  const l = await signedLease(unitId, terms);
  await ok(
    run(F, async (ctx) => ({
      data: await recordHandover(ctx, await handoverInput(l.leaseId, { handedOverOn: terms.effectiveFrom })),
    })),
  );
  await ok(run(M, async (ctx) => ({ data: await activateLease(ctx, { leaseId: l.leaseId }) })));
  return { ...l, unitId };
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ bàn giao", "rental");
  M = await member("manager");
  F = await member("front_desk");
  H = await member("housekeeping");
});

afterAll(async () => {
  await t.drop();
});

describe("S-005…S-007 bàn giao và kích hoạt", () => {
  it("S-005: chưa có biên bản nhận phòng → 409 HANDOVER_REQUIRED, trạng thái không đổi (lệnh và CSDL)", async () => {
    const { leaseId } = await signedLease(await unitWithMeters());
    expect(
      await fails(run(M, async (ctx) => ({ data: await activateLease(ctx, { leaseId }) }))),
    ).toMatchObject({
      code: "HANDOVER_REQUIRED",
      status: 409,
    });
    expect((await getLease(t.runtime, M, leaseId)).status).toBe("signed_awaiting_handover");
    const direct = await sql`update leases set status = 'active' where id = ${leaseId}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "HANDOVER_REQUIRED", status: 409 });
  });

  it("S-006: lễ tân lập biên bản đủ mục → chỉ số nguồn handover đã duyệt; quản lý kích hoạt; allocation từ ngày bàn giao", async () => {
    const unitId = await unitWithMeters();
    const { leaseId } = await signedLease(unitId);
    const input = await handoverInput(leaseId, { handedOverOn: "2026-11-03" });
    const h = await ok(run(F, async (ctx) => ({ data: await recordHandover(ctx, input) })));
    expect(h.readingIds).toHaveLength(2);
    const readings = await sql<{
      kind: string;
      value: string;
      status: string;
      source: string;
      read_on: string;
    }>`
      select m.kind, r.value::text, r.status, r.source, r.read_on::text from meter_readings r join meters m on m.id = r.meter_id
      where r.handover_id = ${h.handoverId} order by m.kind`.execute(t.admin);
    expect(readings.rows).toEqual([
      { kind: "electric", value: "1250.000", status: "approved", source: "handover", read_on: "2026-11-03" },
      { kind: "water", value: "340.000", status: "approved", source: "handover", read_on: "2026-11-03" },
    ]);
    const row = await sql<{
      assets: unknown[];
      keys_count: number;
      confirmed_by_tenant_at: Date | null;
      staff_confirmed_by: string;
    }>`
      select assets, keys_count, confirmed_by_tenant_at, staff_confirmed_by from handovers where id = ${h.handoverId}`.execute(
      t.admin,
    );
    expect(row.rows[0]).toMatchObject({ keys_count: 2, staff_confirmed_by: F.membershipId });
    expect(row.rows[0]?.assets).toHaveLength(3);
    expect(row.rows[0]?.confirmed_by_tenant_at).not.toBeNull();
    // Lễ tân không kích hoạt (ma trận lease.manage); quản lý kích hoạt.
    expect(
      (await fails(run(F, async (ctx) => ({ data: await activateLease(ctx, { leaseId }) })))).status,
    ).toBe(403);
    await ok(run(M, async (ctx) => ({ data: await activateLease(ctx, { leaseId }) })));
    expect((await getLease(t.runtime, M, leaseId)).status).toBe("active");
    const al = await sql<{ lower: Date }>`
      select lower(during) as lower from allocations where source_id = ${leaseId} and active`.execute(
      t.admin,
    );
    expect(al.rows[0]?.lower.toISOString()).toBe("2026-11-02T17:00:00.000Z");
    // Biên bản đã xác nhận bất biến; lập lại cùng loại → 409.
    await expect(
      sql`update handovers set keys_count = 3 where id = ${h.handoverId}`.execute(t.admin),
    ).rejects.toMatchObject({
      hint: "DOCUMENT_IMMUTABLE",
    });
    await expect(sql`delete from handovers where id = ${h.handoverId}`.execute(t.admin)).rejects.toThrow();
  });

  it("S-007: thiếu chỉ số nước → 422 readings.water, không lưu biên bản dở; chỉ số giảm → METER_READING_DECREASED", async () => {
    const unitId = await unitWithMeters();
    const { leaseId } = await signedLease(unitId);
    const missing = await fails(
      run(F, async (ctx) => ({
        data: await recordHandover(ctx, await handoverInput(leaseId, { readings: { electric: 1250 } })),
      })),
    );
    expect(missing).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(missing.errors?.[0]?.field).toBe("readings.water");
    const decreased = await fails(
      run(F, async (ctx) => ({
        data: await recordHandover(
          ctx,
          await handoverInput(leaseId, { readings: { electric: 999, water: 340 } }),
        ),
      })),
    );
    expect(decreased).toMatchObject({ code: "METER_READING_DECREASED", status: 422 });
    expect(decreased.errors?.[0]?.field).toBe("readings.electric");
    const badPhoto = await fails(
      run(F, async (ctx) => ({
        data: await recordHandover(
          ctx,
          await handoverInput(leaseId, { photoFileIds: [await photo("identity_document")] }),
        ),
      })),
    );
    expect(badPhoto.errors?.[0]?.field).toBe("photo_file_ids");
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from handovers where lease_id = ${leaseId}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    // Buồng phòng không lập biên bản.
    expect(
      (
        await fails(
          run(H, async (ctx) => ({ data: await recordHandover(ctx, await handoverInput(leaseId)) })),
        )
      ).status,
    ).toBe(404);
  });
});

describe("S-011, S-013 phụ lục", () => {
  it("S-011: phụ lục gia hạn giá mới, phiên bản 1 giữ nguyên, allocation kéo dài; S-013: chồng hiệu lực → LEASE_VERSION_OVERLAP", async () => {
    const { leaseId } = await activeLease();
    const v2: LeaseTerms = {
      ...TERMS,
      effectiveFrom: "2027-11-01",
      effectiveTo: "2028-10-31",
      rentAmount: 3_300_000,
    };
    const r = await ok(run(M, async (ctx) => ({ data: await renewLease(ctx, { leaseId, terms: v2 }) })));
    expect(r.versionNo).toBe(2);
    const l = await getLease(t.runtime, M, leaseId);
    expect(
      l.versions.map((v) => [v.version_no, v.kind, v.rent_amount, v.effective_from, v.effective_to]),
    ).toEqual([
      [1, "original", 3_000_000, "2026-11-01", "2027-10-31"],
      [2, "appendix", 3_300_000, "2027-11-01", "2028-10-31"],
    ]);
    expect(l.versions[1]?.terms_hash).toMatch(/^[0-9a-f]{64}$/);
    const al = await sql<{
      upper: Date;
    }>`select upper(during) as upper from allocations where source_id = ${leaseId} and active`.execute(
      t.admin,
    );
    expect(al.rows[0]?.upper.toISOString()).toBe("2028-10-31T17:00:00.000Z");
    const overlap = await fails(
      run(M, async (ctx) => ({
        data: await renewLease(ctx, { leaseId, terms: { ...v2, effectiveFrom: "2027-10-15" } }),
      })),
    );
    expect(overlap).toMatchObject({ code: "LEASE_VERSION_OVERLAP", status: 409 });
    await expect(
      sql`update lease_versions set rent_amount = 1 where lease_id = ${leaseId} and version_no = 2`.execute(
        t.admin,
      ),
    ).rejects.toMatchObject({ hint: "DOCUMENT_IMMUTABLE" });
  });

  it("phụ lục khi phòng đã có người sau hạn cũ → ROOM_UNAVAILABLE, không tạo phiên bản", async () => {
    const { leaseId, unitId } = await activeLease();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay',
                      tstzrange('2027-11-05T07:00:00Z', '2027-11-07T05:00:00Z', '[)'))`.execute(t.admin);
    const p = await fails(
      run(M, async (ctx) => ({
        data: await renewLease(ctx, {
          leaseId,
          terms: { ...TERMS, effectiveFrom: "2027-11-01", effectiveTo: "2028-10-31" },
        }),
      })),
    );
    expect(p).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect((await getLease(t.runtime, M, leaseId)).versions).toHaveLength(1);
  });
});

describe("SPEC-inventory S-020 phòng hợp đồng quá hạn: RELOCATION_REQUIRED, ROOM_OCCUPIED khi bàn giao, đóng ngoại lệ khi trả phòng", () => {
  it("SPEC-inventory S-020: job lease.detectOverstay mở RELOCATION_REQUIRED cho booking đã xác nhận kế tiếp (không cho hold), chạy lại không nhân; bàn giao trả phòng đóng cả hai ngoại lệ", async () => {
    const { leaseId, unitId } = await activeLease();
    const next = randomUUID();
    const hold = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${next}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay',
                      tstzrange('2027-10-31T17:00:00Z', '2027-11-03T05:00:00Z', '[)'))`.execute(t.admin);
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${hold}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'hold',
                      tstzrange('2027-11-10T07:00:00Z', '2027-11-11T05:00:00Z', '[)'), '2099-01-01T00:00:00Z')`.execute(
      t.admin,
    );
    const at = new Date("2027-10-31T18:00:00Z");
    await detectOverstay(t.worker, at);
    await detectOverstay(t.worker, at);
    const ex = (allocationId: string) =>
      sql<{ type: string; status: string; related_allocation_id: string | null; resolution: string | null }>`
        select type, status, related_allocation_id, resolution from exceptions where allocation_id = ${allocationId} order by type`.execute(
        t.admin,
      );
    const leaseAlloc = (
      await sql<{ id: string }>`select id from allocations where source_id = ${leaseId}`.execute(t.admin)
    ).rows[0]?.id as string;
    expect((await ex(next)).rows).toEqual([
      { type: "RELOCATION_REQUIRED", status: "open", related_allocation_id: leaseAlloc, resolution: null },
    ]);
    expect((await ex(hold)).rows).toEqual([]);
    expect((await ex(leaseAlloc)).rows.map((r) => [r.type, r.status])).toEqual([["LEASE_OVERSTAY", "open"]]);

    await ok(
      run(F, async (ctx) => ({
        data: await recordHandover(
          ctx,
          await handoverInput(leaseId, { kind: "move_out", handedOverOn: "2027-11-01" }),
        ),
      })),
    );
    expect((await ex(leaseAlloc)).rows).toEqual([
      { type: "LEASE_OVERSTAY", status: "resolved", related_allocation_id: next, resolution: "moved_out" },
    ]);
    expect((await ex(next)).rows.map((r) => [r.type, r.status])).toEqual([
      ["RELOCATION_REQUIRED", "resolved"],
    ]);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where action = 'exception.resolved' and entity_id in
        (select id from exceptions where allocation_id in (${leaseAlloc}, ${next}))`.execute(t.admin);
    expect(audit.rows[0]?.n).toBe(2);
  });

  it("SPEC-inventory S-020: bàn giao nhận phòng (move_in) vào phòng còn hợp đồng cũ quá hạn chưa trả → 409 ROOM_OCCUPIED, không ghi biên bản; đóng ngoại lệ thì bàn giao được", async () => {
    const unitId = await unitWithMeters();
    const { leaseId } = await signedLease(unitId);
    const prev = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${prev}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'lease', 'lease', ${randomUUID()},
                      tstzrange('2026-01-01T00:00:00+07', '2026-11-01T00:00:00+07', '[)'))`.execute(t.admin);
    const ex = randomUUID();
    await sql`insert into exceptions (id, organization_id, property_id, type, allocation_id)
              values (${ex}, ${A.orgId}, ${A.propertyId}, 'LEASE_OVERSTAY', ${prev})`.execute(t.admin);
    const go = async () =>
      run(F, async (ctx) => ({ data: await recordHandover(ctx, await handoverInput(leaseId)) }));
    expect(await fails(go())).toMatchObject({ code: "ROOM_OCCUPIED", status: 409 });
    const none = await sql<{
      n: number;
    }>`select count(*)::int as n from handovers where lease_id = ${leaseId}`.execute(t.admin);
    expect(none.rows[0]?.n).toBe(0);
    await sql`update exceptions set status = 'resolved', resolution = 'moved_out', resolved_by = ${M.membershipId}, resolved_at = now()
              where id = ${ex}`.execute(t.admin);
    await ok(go());
    const done = await sql<{
      n: number;
    }>`select count(*)::int as n from handovers where lease_id = ${leaseId}`.execute(t.admin);
    expect(done.rows[0]?.n).toBe(1);
  });
});

describe("S-014, S-015 job", () => {
  it("S-014: nhắc hết hạn 30 ngày chạy 3 lần trong ngày → đúng 1 outbox (lease, phiên bản, 30)", async () => {
    const { leaseId } = await activeLease();
    const at = new Date("2027-10-01T01:00:00Z"); // 08:00 giờ VN ngày 01/10/2027
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push(await remindExpiring(t.worker, at));
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(counts.slice(1)).toEqual([0, 0]);
    const o = await sql<{ dedupe_key: string }>`
      select dedupe_key from outbox where event_type = 'lease.expiring' and aggregate_id = ${leaseId}`.execute(
      t.admin,
    );
    expect(o.rows).toEqual([{ dedupe_key: `lease.expiring:${leaseId}:1:30` }]);
    // 17:05 UTC hôm trước = 00:05 giờ VN ngày 24/10 → mốc 7 ngày theo NGÀY ĐỊA PHƯƠNG.
    await remindExpiring(t.worker, new Date("2027-10-23T17:05:00Z"));
    const o7 = await sql<{ n: number }>`
      select count(*)::int as n from outbox where dedupe_key = ${`lease.expiring:${leaseId}:1:7`}`.execute(
      t.admin,
    );
    expect(o7.rows[0]?.n).toBe(1);
  });

  it("S-015: quá hạn chưa trả phòng → LEASE_OVERSTAY ghi allocation bị đụng; allocation không tự kết thúc; chạy lại không nhân", async () => {
    const { leaseId, unitId } = await activeLease();
    const next = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${next}, ${A.orgId}, ${A.propertyId}, ${unitId}, 'stay',
                      tstzrange('2027-10-31T17:00:00Z', '2027-11-03T05:00:00Z', '[)'))`.execute(t.admin);
    const at = new Date("2027-10-31T18:00:00Z"); // 01:00 giờ VN ngày 01/11/2027
    expect(await detectOverstay(t.worker, new Date("2027-10-31T16:00:00Z"))).toBe(0); // vẫn 31/10 giờ VN
    const opened = [
      await detectOverstay(t.worker, at),
      await detectOverstay(t.worker, at),
      await detectOverstay(t.worker, at),
    ];
    expect(opened.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    const ex = await sql<{ type: string; related_allocation_id: string; status: string }>`
      select e.type, e.related_allocation_id, e.status from exceptions e join allocations a on a.id = e.allocation_id
      where a.source_id = ${leaseId}`.execute(t.admin);
    expect(ex.rows).toEqual([{ type: "LEASE_OVERSTAY", related_allocation_id: next, status: "open" }]);
    const al = await sql<{
      active: boolean;
    }>`select active from allocations where source_id = ${leaseId}`.execute(t.admin);
    expect(al.rows.every((r) => r.active)).toBe(true);
  });
});
