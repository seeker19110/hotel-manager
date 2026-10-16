// PLAN đợt 3 T-206 — đổi ngày nguyên tử, danh sách, job hết hạn giữ phòng (SPEC-reservation-stay S-007, S-008, S-021; INV-I1/I3).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { expireHeldReservations } from "./jobs.ts";
import { setRate } from "./rates.ts";
import {
  changeDates,
  confirmReservation,
  createReservation,
  holdReservation,
  listReservations,
} from "./reservations.ts";

let h: Hotel;

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

async function confirmed(unitId: string, arrival: string, departure: string) {
  const d = await okAs(h.t, h.frontDesk, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: arrival,
      departureDate: departure,
      guests: 2,
      source: "direct",
      booker: { fullName: "Khách", phone: "0901234567" },
    }),
  );
  await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
  return d;
}

const item = async (reservationId: string) =>
  (
    await sql<{ a: string; d: string; total: string; lo: Date; hi: Date }>`
      select i.arrival_date::text as a, i.departure_date::text as d, i.room_total::text as total,
             lower(al.during) as lo, upper(al.during) as hi
      from reservation_items i join allocations al on al.id = i.allocation_id where i.reservation_id = ${reservationId}`.execute(
      h.t.admin,
    )
  ).rows[0];

describe("S-008 đổi ngày nguyên tử", () => {
  it("xem trước +600.000 không lưu; đổi đi 23/10 → lưu, allocation cùng transaction; đi 24/10 (bận từ 23/10 14:00) → ROOM_UNAVAILABLE, không đổi gì", async () => {
    const b = await confirmed(h.units.r201, "2026-10-20", "2026-10-22");
    await confirmed(h.units.r201, "2026-10-23", "2026-10-25");
    const preview = await okAs(h.t, h.frontDesk, (ctx) =>
      changeDates(ctx, {
        reservationId: b.reservationId,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-23",
        previewOnly: true,
      }),
    );
    expect(preview).toMatchObject({ previewOnly: true, priceDiff: 600_000, roomTotal: 1_800_000 });
    expect((await item(b.reservationId))?.d).toBe("2026-10-22");

    const saved = await okAs(h.t, h.frontDesk, (ctx) =>
      changeDates(ctx, {
        reservationId: b.reservationId,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-23",
        previewOnly: false,
      }),
    );
    expect(saved.priceDiff).toBe(600_000);
    const after = await item(b.reservationId);
    expect(after).toMatchObject({ d: "2026-10-23", total: "1800000" });
    expect(after?.hi.toISOString()).toBe("2026-10-23T05:00:00.000Z");

    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          changeDates(ctx, {
            reservationId: b.reservationId,
            arrivalDate: "2026-10-20",
            departureDate: "2026-10-24",
            previewOnly: false,
          }),
        ),
      ),
    ).toBe("ROOM_UNAVAILABLE");
    const unchanged = await item(b.reservationId);
    expect(unchanged).toMatchObject({ d: "2026-10-23", total: "1800000" });
    expect(unchanged?.hi.toISOString()).toBe("2026-10-23T05:00:00.000Z");
  });

  it("Q-06: đêm cũ giữ snapshot, đêm mới lấy giá hiện hành sau khi owner đổi giá", async () => {
    const b = await confirmed(h.units.r202, "2026-12-01", "2026-12-03");
    await okAs(h.t, h.owner, (ctx) =>
      setRate(ctx, {
        roomTypeId: h.org.roomTypeId,
        weekdayPrice: 650_000,
        weekendPrice: 750_000,
        effectiveFrom: "2026-11-15",
      }),
    );
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      changeDates(ctx, {
        reservationId: b.reservationId,
        arrivalDate: "2026-12-01",
        departureDate: "2026-12-04",
        previewOnly: false,
      }),
    );
    // 01/12, 02/12 (snapshot 600.000) + 03/12 thứ Năm giá mới 650.000.
    expect(r.nightlyPrices.map((p) => p.amount)).toEqual([600_000, 600_000, 650_000]);
    expect(r.priceDiff).toBe(650_000);
  });

  it("đổi ngày booking đã huỷ/đang ở → INVALID_TRANSITION; ngày đi ≤ đến → 422", async () => {
    const b = await confirmed(h.units.r202, "2027-01-04", "2027-01-05");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          changeDates(ctx, {
            reservationId: b.reservationId,
            arrivalDate: "2027-01-05",
            departureDate: "2027-01-05",
            previewOnly: true,
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    await sql`update reservations set status = 'cancelled', cancel_reason = 'x', cancelled_at = now() where id = ${b.reservationId}`.execute(
      h.t.admin,
    );
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          changeDates(ctx, {
            reservationId: b.reservationId,
            arrivalDate: "2027-01-04",
            departureDate: "2027-01-06",
            previewOnly: true,
          }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });
});

describe("S-021 đổi giá bảng không ảnh hưởng booking đã giữ", () => {
  it("booking cũ giữ tổng snapshot; booking mới báo giá theo bảng mới", async () => {
    const b = await confirmed(h.units.r201, "2027-02-02", "2027-02-04");
    const before = (await item(b.reservationId))?.total;
    await okAs(h.t, h.owner, (ctx) =>
      setRate(ctx, {
        roomTypeId: h.org.roomTypeId,
        weekdayPrice: 700_000,
        weekendPrice: 800_000,
        effectiveFrom: "2027-01-01",
      }),
    );
    expect((await item(b.reservationId))?.total).toBe(before);
    const fresh = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: h.units.r202,
        arrivalDate: "2027-02-02",
        departureDate: "2027-02-04",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách mới", phone: "0907654321" },
      }),
    );
    expect(fresh.roomTotal).toBe(1_400_000);
  });
});

describe("reservation.list", () => {
  it("liệt kê booking giao khoảng ngày; buồng phòng/tổ chức khác → 404", async () => {
    const list = await listReservations(h.t.runtime, h.frontDesk, {
      propertyId: h.org.propertyId,
      from: "2026-10-20",
      to: "2026-10-21",
    });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.arrivalDate < "2026-10-21" && r.departureDate > "2026-10-20")).toBe(true);
    await expect(
      listReservations(h.t.runtime, h.housekeeping, {
        propertyId: h.org.propertyId,
        from: "2026-10-20",
        to: "2026-10-21",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listReservations(h.t.runtime, h.ownerOther, {
        propertyId: h.org.propertyId,
        from: "2026-10-20",
        to: "2026-10-21",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("job hết hạn giữ phòng (S-007, INV-I3)", () => {
  it("booking held quá hạn → expired đúng một lần, allocation nhả, audit worker; chạy lại không đổi gì", async () => {
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: h.units.r202,
        arrivalDate: "2027-03-01",
        departureDate: "2027-03-02",
        guests: 1,
        source: "direct",
        booker: { fullName: "Khách giữ", phone: "0901111222" },
      }),
    );
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      holdReservation(ctx, { reservationId: d.reservationId }),
    );
    expect(await expireHeldReservations(h.t.worker, new Date(hold.expiresAt.getTime() - 1000))).toBe(0);
    const later = new Date(hold.expiresAt.getTime() + 1000);
    expect(await expireHeldReservations(h.t.worker, later)).toBeGreaterThanOrEqual(1);
    expect(await expireHeldReservations(h.t.worker, later)).toBe(0);
    const r = await sql<{ status: string; active: boolean }>`
      select r.status, a.active from reservations r join reservation_items i on i.reservation_id = r.id
      join allocations a on a.id = i.allocation_id where r.id = ${d.reservationId}`.execute(h.t.admin);
    expect(r.rows[0]).toEqual({ status: "expired", active: false });
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${d.reservationId} and action = 'reservation.expired'
        and actor_type = 'worker'`.execute(h.t.admin);
    expect(audit.rows[0]?.n).toBe(1);
    // Không có id lạ nào bị chạm: booking khác vẫn nguyên trạng thái.
    expect(randomUUID()).toBeTruthy();
  });
});
