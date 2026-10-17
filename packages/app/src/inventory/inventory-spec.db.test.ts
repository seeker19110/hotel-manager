// SPEC-inventory-allocation (mục 2) trên Postgres thật — các scenario chưa có ở inventory.db.test.ts: S-001, S-002, S-006,
// S-007, S-011, S-014, S-015, S-022. Fixture khách sạn dùng chung (múi giờ Asia/Ho_Chi_Minh, nhận 14:00 / trả 12:00).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireHolds } from "../../../../apps/worker/src/jobs.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { checkIn, createReservation, holdReservation } from "../stay/index.ts";
import { expireHeldReservations } from "../stay/jobs.ts";
import { confirmReservation } from "../stay/reservations.ts";
import { okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { approveBlock, createHold, getUnitStatus, moveAllocation, proposeBlock } from "./inventory.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
/** Giờ địa phương Asia/Ho_Chi_Minh (UTC+7) → thời điểm tuyệt đối. */
const vn = (d: string, hhmm: string) => new Date(`2026-${d}T${hhmm}:00+07:00`);

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function freshUnit(opts: { status?: string; code?: string } = {}): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId},
                    ${opts.code ?? `9${String(seq).padStart(2, "0")}`}, ${opts.status ?? "inspected"})`.execute(
    h.t.admin,
  );
  return id;
}

const count = async (q: ReturnType<typeof sql<{ n: number }>>) =>
  (await q.execute(h.t.admin)).rows[0]?.n ?? 0;

describe("SPEC-inventory S-001 tạo hold thành công", () => {
  it("allocation hold active, during = giờ địa phương đổi sang UTC, expires_at = lúc commit + TTL; trả allocation_id và expires_at", async () => {
    const unit = await freshUnit();
    const now = new Date("2026-10-14T03:00:00Z");
    const r = await runAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: vn("10-15", "14:00"), end: vn("10-17", "12:00") },
        ttlMinutes: 15,
        now,
      }),
    );
    if (r.status !== "committed") throw new Error(r.problem.code);
    expect(r.httpStatus).toBe(200);
    expect(r.data.expiresAt).toEqual(new Date("2026-10-14T03:15:00Z"));
    const row = await sql<{ kind: string; active: boolean; lo: Date; hi: Date; expires_at: Date }>`
      select kind, active, lower(during) as lo, upper(during) as hi, expires_at from allocations
      where id = ${r.data.allocationId}`.execute(h.t.admin);
    expect(row.rows[0]).toEqual({
      kind: "hold",
      active: true,
      lo: new Date("2026-10-15T07:00:00Z"),
      hi: new Date("2026-10-17T05:00:00Z"),
      expires_at: new Date("2026-10-14T03:15:00Z"),
    });
  });
});

describe("SPEC-inventory S-002 chồng lấn bị DB từ chối (INV-I1)", () => {
  it("ROOM_UNAVAILABLE 409 kèm phòng cùng loại còn trống; không lộ lỗi SQL; không có hàng mới", async () => {
    const [busy, free, taken] = [
      await freshUnit({ code: "A01" }),
      await freshUnit({ code: "A02" }),
      await freshUnit({ code: "A03" }),
    ];
    const first = { start: vn("10-15", "14:00"), end: vn("10-17", "12:00") };
    const now = new Date("2026-10-14T03:00:00Z");
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, { unitId: busy, during: first, ttlMinutes: 15, now }),
    );
    // A03 cũng bận trong khoảng → không được gợi ý; A02 trống → được gợi ý.
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, { unitId: taken, during: first, ttlMinutes: 15, now }),
    );
    const before = await count(
      sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${busy}`,
    );
    const r = await runAs(h.t, h.manager, (ctx) =>
      createHold(ctx, {
        unitId: busy,
        during: { start: vn("10-16", "14:00"), end: vn("10-18", "12:00") },
        ttlMinutes: 15,
        now,
      }),
    );
    if (r.status !== "failed") throw new Error("lẽ ra phải bị từ chối");
    expect(r.httpStatus).toBe(409);
    expect(r.problem).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    // Gợi ý = phòng cùng loại còn trống (kể cả phòng của fixture chung); không gồm phòng bận hay chính phòng đang xin.
    expect(r.problem.alternatives).toContainEqual({ unit_id: free, code: "A02" });
    expect(r.problem.alternatives?.some((a) => a.unit_id === taken || a.unit_id === busy)).toBe(false);
    expect(JSON.stringify(r.problem)).not.toMatch(/23P01|ex_allocations|violates|exclusion/i);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${busy}`),
    ).toBe(before);
  });

  it("ca biên: không phòng nào cùng loại còn trống → alternatives rỗng (không null)", async () => {
    const only = await freshUnit({ code: "B01" });
    const now = new Date("2026-10-14T03:00:00Z");
    const during = { start: vn("11-01", "14:00"), end: vn("11-02", "12:00") };
    await okAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: only, during, ttlMinutes: 15, now }));
    // Khoảng này mọi phòng cùng loại đều phải bận để gợi ý rỗng: chiếm hết phòng còn lại của loại.
    const others = await sql<{ id: string }>`
      select id from units where room_type_id = ${h.org.roomTypeId} and id <> ${only}`.execute(h.t.admin);
    for (const u of others.rows) {
      await okAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: u.id, during, ttlMinutes: 15, now }));
    }
    const r = await runAs(h.t, h.manager, (ctx) =>
      createHold(ctx, { unitId: only, during, ttlMinutes: 15, now }),
    );
    expect(r).toMatchObject({ status: "failed", problem: { code: "ROOM_UNAVAILABLE", alternatives: [] } });
  });
});

describe("SPEC-inventory S-006 cùng lệnh gửi 100 lần (INV-G5)", () => {
  it("100 lệnh song song cùng Idempotency-Key và body → cùng allocation_id; đúng 1 allocation, 1 audit, 1 outbox", async () => {
    const unit = await freshUnit();
    const key = randomUUID();
    const body = { unit: unit, from: "2026-10-20", to: "2026-10-21" };
    const now = new Date("2026-10-19T03:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        runAs(
          h.t,
          h.frontDesk,
          (ctx) =>
            createHold(ctx, {
              unitId: unit,
              during: { start: vn("10-20", "14:00"), end: vn("10-21", "12:00") },
              ttlMinutes: 15,
              now,
            }),
          { command: "inventory.createHold", key, payload: body },
        ),
      ),
    );
    const ids = new Set<string>();
    for (const r of results) {
      if (r.status !== "committed") throw new Error(r.problem.code);
      ids.add(r.data.allocationId);
    }
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const id = [...ids][0] as string;
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${unit}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from audit_events where entity_id = ${id}`),
    ).toBe(1);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from outbox where aggregate_id = ${id}`),
    ).toBe(1);
  });

  it("cùng key nhưng khác nội dung → IDEMPOTENCY_CONFLICT, không tạo allocation thứ hai", async () => {
    const unit = await freshUnit();
    const key = randomUUID();
    const go = (to: string) =>
      runAs(
        h.t,
        h.frontDesk,
        (ctx) =>
          createHold(ctx, {
            unitId: unit,
            during: { start: vn("10-20", "14:00"), end: vn("10-21", "12:00") },
            ttlMinutes: 15,
          }),
        { command: "inventory.createHold", key, payload: { unit, to } },
      );
    expect((await go("2026-10-21")).status).toBe("committed");
    await expect(go("2026-10-22")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 422 });
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${unit}`),
    ).toBe(1);
  });
});

describe("SPEC-inventory S-007 worker nhả hold hết hạn đúng một lần (INV-I3)", () => {
  it("2 worker expireHolds đồng thời → hold inactive, đúng 1 audit allocation.hold_expired; booking nguồn held → expired đúng một lần", async () => {
    const unit = await freshUnit();
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: unit,
        arrivalDate: "2027-03-01",
        departureDate: "2027-03-02",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách giữ phòng", phone: "0100002222" },
      }),
    );
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      holdReservation(ctx, { reservationId: d.reservationId }),
    );
    const alloc = (
      await sql<{
        id: string;
      }>`select i.allocation_id as id from reservation_items i where i.reservation_id = ${d.reservationId}`.execute(
        h.t.admin,
      )
    ).rows[0]?.id as string;
    const tick = new Date(hold.expiresAt.getTime() + 1000);
    // Trước hạn 1 ms: chưa nhả (job là toàn cục nên chỉ kiểm hold của chính test này).
    await expireHolds(h.t.worker, new Date(hold.expiresAt.getTime() - 1));
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from allocations where id = ${alloc} and active`,
      ),
    ).toBe(1);
    await Promise.all([expireHolds(h.t.worker, tick), expireHolds(h.t.worker, tick)]);
    await Promise.all([expireHeldReservations(h.t.worker, tick), expireHeldReservations(h.t.worker, tick)]);
    const row = await sql<{ active: boolean; status: string }>`
      select a.active, r.status from allocations a, reservations r where a.id = ${alloc} and r.id = ${d.reservationId}`.execute(
      h.t.admin,
    );
    expect(row.rows[0]).toEqual({ active: false, status: "expired" });
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where entity_id = ${alloc} and action = 'allocation.hold_expired'`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where entity_id = ${d.reservationId} and action = 'reservation.expired'`,
      ),
    ).toBe(1);
  });

  it("ca biên: expires_at đúng bằng now được coi là hết hạn", async () => {
    const unit = await freshUnit();
    const now = new Date("2026-10-20T03:00:00Z");
    const held = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: vn("10-25", "14:00"), end: vn("10-26", "12:00") },
        ttlMinutes: 15,
        now,
      }),
    );
    // Job là toàn cục: chỉ kiểm hold của chính test này.
    await expireHolds(h.t.worker, held.expiresAt);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from allocations where id = ${held.allocationId} and not active`,
      ),
    ).toBe(1);
  });
});

describe("SPEC-inventory S-011 đề xuất và duyệt block", () => {
  it("kỹ thuật đề xuất → chưa có allocation, phòng vẫn bán được; kỹ thuật không tự duyệt (FORBIDDEN); quản lý duyệt → block chặn phòng", async () => {
    const unit = await freshUnit();
    const tech = await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật K" });
    const period = { start: vn("10-22", "08:00"), end: vn("10-24", "17:00") };
    const mid = vn("10-23", "12:00");
    const p = await runAs(h.t, tech, (ctx) =>
      proposeBlock(ctx, { unitId: unit, period, reason: "Thay bình nóng lạnh" }),
    );
    if (p.status !== "committed") throw new Error(p.problem.code);
    const blockId = p.data.blockId;
    const blk = () =>
      sql<{
        status: string;
        approved_by: string | null;
      }>`select status, approved_by from blocks where id = ${blockId}`.execute(h.t.admin);
    expect((await blk()).rows[0]).toEqual({ status: "requested", approved_by: null });
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${unit}`),
    ).toBe(0);
    expect(await getUnitStatus(h.t.runtime, h.frontDesk, unit, mid)).toMatchObject({
      occupancy: "vacant",
      sellable: true,
    });

    const self = await runAs(h.t, tech, (ctx) => approveBlock(ctx, blockId));
    expect(self).toMatchObject({ status: "failed", problem: { code: "FORBIDDEN", status: 403 } });
    expect((await blk()).rows[0]?.status).toBe("requested");

    await okAs(h.t, h.manager, (ctx) => approveBlock(ctx, blockId));
    expect((await blk()).rows[0]).toEqual({ status: "approved", approved_by: h.manager.membershipId });
    const al = await sql<{ kind: string; active: boolean; source_id: string }>`
      select kind, active, source_id from allocations where unit_id = ${unit}`.execute(h.t.admin);
    expect(al.rows).toEqual([{ kind: "block", active: true, source_id: blockId }]);
    expect(await getUnitStatus(h.t.runtime, h.frontDesk, unit, mid)).toMatchObject({
      occupancy: "blocked",
      sellable: false,
    });
    const hold = await runAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: vn("10-23", "14:00"), end: vn("10-24", "12:00") },
        ttlMinutes: 15,
      }),
    );
    expect(hold).toMatchObject({ status: "failed", problem: { code: "ROOM_UNAVAILABLE", status: 409 } });
  });
});

describe("SPEC-inventory S-014 ba chiều trạng thái độc lập", () => {
  const T = new Date("2026-10-20T08:00:00Z");
  const during = `[2026-10-20T00:00:00Z,2026-10-21T00:00:00Z)`;

  async function setup(o: { hk: string; availability?: string; alloc?: "stay" | "block" }): Promise<string> {
    const u = await freshUnit({ status: o.hk });
    if (o.availability)
      await sql`update units set availability = ${o.availability}, availability_reason = 'Hỏng điều hoà' where id = ${u}`.execute(
        h.t.admin,
      );
    if (o.alloc) {
      await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
                values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${u}, ${o.alloc}, ${during}::tstzrange)`.execute(
        h.t.admin,
      );
    }
    return u;
  }

  const cases: {
    name: string;
    o: Parameters<typeof setup>[0];
    sellable: boolean;
    ready: boolean;
  }[] = [
    { name: "trống · inspected · active", o: { hk: "inspected" }, sellable: true, ready: true },
    { name: "trống · dirty · active", o: { hk: "dirty" }, sellable: true, ready: false },
    { name: "trống · clean · active", o: { hk: "clean" }, sellable: true, ready: true },
    {
      name: "có khách · inspected · active",
      o: { hk: "inspected", alloc: "stay" },
      sellable: false,
      ready: false,
    },
    {
      name: "trống · inspected · blocked",
      o: { hk: "inspected", alloc: "block" },
      sellable: false,
      ready: false,
    },
    {
      name: "trống · clean · out_of_service",
      o: { hk: "clean", availability: "out_of_service" },
      sellable: false,
      ready: false,
    },
  ];
  for (const c of cases) {
    it(`${c.name} → sellable=${c.sellable ? "có" : "không"}, ready_for_arrival=${c.ready ? "có" : "không"}`, async () => {
      const u = await setup(c.o);
      expect(await getUnitStatus(h.t.runtime, h.manager, u, T)).toMatchObject({
        sellable: c.sellable,
        readyForArrival: c.ready,
      });
    });
  }

  it("cơ sở bắt buộc inspected: phòng clean trống không sẵn sàng nhận khách nhưng vẫn bán được", async () => {
    const u = await setup({ hk: "clean" });
    await sql`update properties set require_inspected = true where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    try {
      expect(await getUnitStatus(h.t.runtime, h.manager, u, T)).toMatchObject({
        sellable: true,
        readyForArrival: false,
      });
    } finally {
      await sql`update properties set require_inspected = false where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("SPEC-inventory S-015 chuyển phòng nguyên tử", () => {
  it("stay đang ở: cũ thu hẹp tới lúc chuyển, mới ở phòng đích cùng source; phí và công nợ không đổi; phòng cũ bẩn + việc dọn; một audit có trước/sau", async () => {
    const from = await freshUnit({ code: "M01" });
    const to = await freshUnit({ code: "M02" });
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: from,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-22",
        guests: 1,
        source: "direct",
        booker: { fullName: "Người đặt", phone: "0100000333" },
      }),
    );
    await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
    const stay = await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, {
        reservationId: d.reservationId,
        guests: [
          { fullName: "Nguyễn Văn An", phone: "0100005678", docType: "cccd", docNumber: "001234567891" },
        ],
        now: new Date("2026-10-20T08:00:00Z"),
      }),
    );
    const alloc = (
      await sql<{
        id: string;
      }>`select id from allocations where source_id = ${stay.stayId} and active`.execute(h.t.admin)
    ).rows[0]?.id as string;
    const money = async () =>
      (
        await sql<{ charges: string; lines: number; sum: string }>`
          select (select coalesce(sum(amount), 0)::text from charges where stay_id = ${stay.stayId}) as charges,
                 (select count(*)::int from journal_lines where organization_id = ${h.org.orgId}) as lines,
                 (select coalesce(sum(debit - credit), 0)::text from journal_lines where organization_id = ${h.org.orgId}) as sum`.execute(
          h.t.admin,
        )
      ).rows[0];
    const before = await money();
    expect(before?.charges).toBe("1200000");

    const at = vn("10-21", "10:00");
    const moved = await okAs(h.t, h.frontDesk, (ctx) =>
      moveAllocation(ctx, { allocationId: alloc, toUnitId: to, at, reason: "Phòng cũ ồn" }),
    );

    const rows = await sql<{
      unit_id: string;
      source_id: string;
      source_type: string;
      lo: Date;
      hi: Date;
      active: boolean;
    }>`
      select unit_id, source_id, source_type, lower(during) as lo, upper(during) as hi, active from allocations
      where source_id = ${stay.stayId} order by lower(during)`.execute(h.t.admin);
    expect(rows.rows).toEqual([
      {
        unit_id: from,
        source_id: stay.stayId,
        source_type: "stay",
        lo: new Date("2026-10-20T07:00:00Z"),
        hi: at,
        active: true,
      },
      {
        unit_id: to,
        source_id: stay.stayId,
        source_type: "stay",
        lo: at,
        hi: new Date("2026-10-22T05:00:00Z"),
        active: true,
      },
    ]);
    expect(await money()).toEqual(before);
    const hk = await sql<{ s: string; tasks: number; source_type: string }>`
      select (select housekeeping_status from units where id = ${from}) as s,
             (select count(*)::int from tasks where unit_id = ${from} and kind = 'cleaning' and status = 'open') as tasks,
             (select source_type from tasks where unit_id = ${from} and kind = 'cleaning') as source_type`.execute(
      h.t.admin,
    );
    expect(hk.rows[0]).toEqual({ s: "dirty", tasks: 1, source_type: "move" });
    const audits = await sql<{
      reason: string;
      before: { unit_id: string };
      after: { unit_id: string; new_allocation: string };
    }>`
      select reason, before, after from audit_events where entity_id = ${alloc} and action = 'allocation.moved'`.execute(
      h.t.admin,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({
      reason: "Phòng cũ ồn",
      before: { unit_id: from },
      after: { unit_id: to, new_allocation: moved.newAllocationId },
    });
  });

  it("ca biên: chuyển đúng lúc bắt đầu → allocation cũ nhả (moved), không có khoảng rỗng; thiếu lý do → VALIDATION_FAILED", async () => {
    const [a, b] = [await freshUnit(), await freshUnit()];
    const id = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${a}, 'stay',
                      tstzrange(${vn("11-10", "14:00")}, ${vn("11-12", "12:00")}, '[)'))`.execute(h.t.admin);
    const noReason = await runAs(h.t, h.manager, (ctx) =>
      moveAllocation(ctx, { allocationId: id, toUnitId: b, at: vn("11-10", "14:00"), reason: "  " }),
    );
    expect(noReason).toMatchObject({ status: "failed", problem: { code: "VALIDATION_FAILED" } });
    await okAs(h.t, h.manager, (ctx) =>
      moveAllocation(ctx, { allocationId: id, toUnitId: b, at: vn("11-10", "14:00"), reason: "Đổi phòng" }),
    );
    const old = await sql<{ active: boolean; reason: string }>`
      select active, deactivated_reason as reason from allocations where id = ${id}`.execute(h.t.admin);
    expect(old.rows[0]).toEqual({ active: false, reason: "moved" });
    expect(
      await count(
        sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${b} and active`,
      ),
    ).toBe(1);
  });
});

describe("SPEC-inventory S-022 chéo tenant (INV-G1)", () => {
  it("người dùng tổ chức A giữ/xem phòng của tổ chức B → 404 NOT_FOUND; không allocation nào được tạo", async () => {
    const uB = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              values (${uB}, ${h.other.orgId}, ${h.other.propertyId}, ${h.other.floorId}, ${h.other.roomTypeId}, 'B-101')`.execute(
      h.t.admin,
    );
    const r = await runAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: uB,
        during: { start: vn("10-15", "14:00"), end: vn("10-17", "12:00") },
        ttlMinutes: 15,
      }),
    );
    expect(r).toMatchObject({ status: "failed", httpStatus: 404, problem: { code: "NOT_FOUND" } });
    await expect(getUnitStatus(h.t.runtime, h.frontDesk, uB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${uB}`),
    ).toBe(0);
  });
});
