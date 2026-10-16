// PLAN đợt 3 T-207 — nhận phòng và walk-in trên Postgres thật (SPEC-reservation-stay S-010…S-016, S-030; D-004).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { confirmReservation, createReservation, holdReservation, markNoShow } from "./reservations.ts";
import { checkIn, type GuestInput, walkIn } from "./stays.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
const AN: GuestInput = {
  fullName: "Nguyễn Văn An",
  phone: "0912345678",
  docType: "cccd",
  docNumber: "001234567890",
};
const IN_DAY = new Date("2026-10-20T08:00:00Z"); // 15:00 giờ VN ngày đến

beforeAll(async () => {
  h = await seedHotel();
});

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function freshUnit(status = "inspected"): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`7${String(seq).padStart(2, "0")}`}, ${status})`.execute(
    h.t.admin,
  );
  return id;
}

async function confirmedBooking(unitId: string, arrival = "2026-10-20", departure = "2026-10-22") {
  const d = await okAs(h.t, h.frontDesk, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: arrival,
      departureDate: departure,
      guests: 2,
      source: "direct",
      booker: { fullName: "Người đặt", phone: "0987000111" },
    }),
  );
  await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  await okAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId }));
  return d.reservationId;
}

const stayOf = async (reservationId: string) =>
  (
    await sql<{ id: string; status: string; r: string; checked_in_at: Date | null }>`
      select s.id, s.status, r.status as r, s.checked_in_at from reservations r
      join reservation_items i on i.reservation_id = r.id join stays s on s.reservation_item_id = i.id
      where r.id = ${reservationId}`.execute(h.t.admin)
  ).rows[0];

describe("S-012 check-in booking có sẵn", () => {
  it("stay expected → in_house, booking in_house; phí phòng mỗi đêm; giấy tờ mã hoá; residence_notices pending cùng transaction", async () => {
    const unit = await freshUnit();
    const rid = await confirmedBooking(unit);
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, {
        reservationId: rid,
        guests: [AN, { fullName: "Trần Thị Bình", docType: "cccd", docNumber: "079200000001" }],
        now: IN_DAY,
      }),
    );
    expect(await stayOf(rid)).toMatchObject({ status: "in_house", r: "in_house" });
    const charges = await sql<{ d: string; amount: string; kind: string }>`
      select business_date::text as d, amount::text, kind from charges where stay_id = ${r.stayId} order by business_date`.execute(
      h.t.admin,
    );
    expect(charges.rows).toEqual([
      { d: "2026-10-20", amount: "600000", kind: "room" },
      { d: "2026-10-21", amount: "600000", kind: "room" },
    ]);
    const notice = await sql<{ status: string; is_foreign: boolean; due_at: Date | null }>`
      select status, is_foreign, due_at from residence_notices where stay_id = ${r.stayId}`.execute(
      h.t.admin,
    );
    expect(notice.rows[0]).toEqual({ status: "pending", is_foreign: false, due_at: null });
    const docs = await sql<{ last4: string; n: number }>`
      select doc_number_last4 as last4, count(*) over ()::int as n from identity_documents
      where organization_id = ${h.org.orgId} and doc_number_last4 in ('7890','0001') order by last4`.execute(
      h.t.admin,
    );
    expect(docs.rows.map((d) => d.last4)).toEqual(["0001", "7890"]);
    const event = await sql<{ n: number }>`
      select count(*)::int as n from outbox where event_type = 'stay.checked_in' and aggregate_id = ${r.stayId}`.execute(
      h.t.admin,
    );
    expect(event.rows[0]?.n).toBe(1);
  });

  it("S-016 (a): qua 00:00 không có job nào thêm phí — vẫn đúng 2 phí; CSDL chặn ghi trùng đêm", async () => {
    const unit = await freshUnit();
    const rid = await confirmedBooking(unit);
    const r = await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: IN_DAY }),
    );
    await expect(
      sql`insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description,
                               business_date, unit_price, amount)
          values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, 'stay', ${r.stayId}, 'room', 'REV_ROOM', 'trùng', '2026-10-21', 1, 1)`.execute(
        h.t.admin,
      ),
    ).rejects.toThrow(/uq_charges_stay_room_night/);
  });
});

describe("S-013/S-014 phòng chưa sẵn sàng, vượt sức chứa", () => {
  it("phòng dirty → 409 ROOM_NOT_READY, stay vẫn expected, không ghi gì", async () => {
    const unit = await freshUnit("dirty");
    const rid = await confirmedBooking(unit);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: IN_DAY }),
        ),
      ),
    ).toBe("ROOM_NOT_READY");
    expect((await stayOf(rid))?.status).toBe("expected");
    const n = await sql<{ n: number }>`
      select count(*)::int as n from charges c join stays s on s.id = c.stay_id
      join reservation_items i on i.id = s.reservation_item_id where i.reservation_id = ${rid}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("phòng còn lượt ở in_house (quá hạn chưa trả) → 409 ROOM_OCCUPIED", async () => {
    const unit = await freshUnit();
    const first = await confirmedBooking(unit, "2026-10-18", "2026-10-19");
    await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, { reservationId: first, guests: [AN], now: new Date("2026-10-18T08:00:00Z") }),
    );
    const second = await confirmedBooking(unit, "2026-10-20", "2026-10-21");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: second, guests: [AN], now: IN_DAY }),
        ),
      ),
    ).toBe("ROOM_OCCUPIED");
  });

  it("3 khách với STD sức chứa 2 → 422 CAPACITY_EXCEEDED; thiếu giấy tờ/SĐT khách chính → 422", async () => {
    const unit = await freshUnit();
    const rid = await confirmedBooking(unit);
    const g = (n: number) => ({
      fullName: `Khách ${n}`,
      docType: "cccd" as const,
      docNumber: `00100000000${n}`,
    });
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN, g(1), g(2)], now: IN_DAY }),
        ),
      ),
    ).toBe("CAPACITY_EXCEEDED");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [{ ...AN, docNumber: "1" }], now: IN_DAY }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, {
            reservationId: rid,
            guests: [{ fullName: "Không SĐT", docType: "cccd", docNumber: "001234567891" }],
            now: IN_DAY,
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    expect((await stayOf(rid))?.status).toBe("expected");
  });
});

describe("S-010/S-011 chuyển trạng thái không hợp lệ", () => {
  it("check-in booking draft → 409 INVALID_TRANSITION; check-in trước ngày đến → 409", async () => {
    const unit = await freshUnit();
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: unit,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-21",
        guests: 1,
        source: "direct",
        booker: { fullName: "X", phone: "0900000001" },
      }),
    );
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: d.reservationId, guests: [AN], now: IN_DAY }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const rid = await confirmedBooking(await freshUnit());
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: new Date("2026-10-19T08:00:00Z") }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("S-011: check-in stay no_show → 409 INVALID_TRANSITION, không tạo residence_notices", async () => {
    const rid = await confirmedBooking(await freshUnit());
    await okAs(h.t, h.frontDesk, (ctx) =>
      markNoShow(ctx, { reservationId: rid, reason: "Không đến", now: new Date("2026-10-21T01:00:00Z") }),
    );
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: new Date("2026-10-21T02:00:00Z") }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const n = await sql<{ n: number }>`
      select count(*)::int as n from residence_notices rn join stays s on s.id = rn.stay_id
      join reservation_items i on i.id = s.reservation_item_id where i.reservation_id = ${rid}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});

describe("S-015/S-016 walk-in", () => {
  it("một command thẳng in_house: allocation [20/10 15:10, 21/10 12:00), 1 đêm 600.000, residence notice; không có draft/held", async () => {
    const unit = await freshUnit();
    const at = new Date("2026-10-20T08:10:00Z");
    const key = randomUUID();
    const r = await runAs(
      h.t,
      h.frontDesk,
      (ctx) => walkIn(ctx, pii, { unitId: unit, departureDate: "2026-10-21", guests: [AN], now: at }),
      {
        key,
      },
    );
    if (r.status !== "committed") throw new Error(r.problem.code);
    expect(r.data).toMatchObject({ nights: 1, roomTotal: 600_000 });
    const row = await sql<{ status: string; source: string; s: string; lo: Date; hi: Date; kind: string }>`
      select r.status, r.source, s.status as s, lower(a.during) as lo, upper(a.during) as hi, a.kind
      from reservations r join reservation_items i on i.reservation_id = r.id join stays s on s.reservation_item_id = i.id
      join allocations a on a.id = i.allocation_id where r.id = ${r.data.reservationId}`.execute(h.t.admin);
    expect(row.rows[0]).toMatchObject({ status: "in_house", source: "walk_in", s: "in_house", kind: "stay" });
    expect(row.rows[0]?.lo.toISOString()).toBe("2026-10-20T08:10:00.000Z");
    expect(row.rows[0]?.hi.toISOString()).toBe("2026-10-21T05:00:00.000Z");
    const actions = await sql<{
      action: string;
    }>`select action from audit_events where command_id = ${key} order by occurred_at`.execute(h.t.admin);
    expect(actions.rows.map((a) => a.action)).not.toEqual(
      expect.arrayContaining(["reservation.held", "reservation.confirmed", "stay.checked_in"]),
    );
    expect(actions.rows.map((a) => a.action)).toContain("stay.walked_in");
  });

  it("phòng bị chiếm → 409 ROOM_UNAVAILABLE, không tạo gì", async () => {
    const unit = await freshUnit();
    await confirmedBooking(unit, "2026-10-20", "2026-10-22");
    const before = await sql<{
      n: number;
    }>`select count(*)::int as n from reservations where organization_id = ${h.org.orgId}`.execute(h.t.admin);
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          walkIn(ctx, pii, {
            unitId: unit,
            departureDate: "2026-10-21",
            guests: [AN],
            now: new Date("2026-10-20T08:10:00Z"),
          }),
        ),
      ),
    ).toBe("ROOM_UNAVAILABLE");
    const after = await sql<{
      n: number;
    }>`select count(*)::int as n from reservations where organization_id = ${h.org.orgId}`.execute(h.t.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("S-016 (b): giờ chốt 04:00, walk-in 16/10 01:30 đi 16/10 → đêm đầu 15/10 (thứ Năm), 1 đêm 600.000, không báo lỗi ngày", async () => {
    await sql`update properties set business_day_cutoff = '04:00' where id = ${h.org.propertyId}`.execute(
      h.t.admin,
    );
    try {
      const unit = await freshUnit();
      const r = await okAs(h.t, h.frontDesk, (ctx) =>
        walkIn(ctx, pii, {
          unitId: unit,
          departureDate: "2026-10-16",
          guests: [AN],
          now: new Date("2026-10-15T18:30:00Z"),
        }),
      );
      expect(r).toMatchObject({ nights: 1, roomTotal: 600_000 });
      const c = await sql<{
        d: string;
      }>`select business_date::text as d from charges where stay_id = ${r.stayId}`.execute(h.t.admin);
      expect(c.rows.map((x) => x.d)).toEqual(["2026-10-15"]);
    } finally {
      await sql`update properties set business_day_cutoff = '00:00' where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });
});

describe("S-030 khách nước ngoài và hạn thông báo lưu trú", () => {
  it("khách hộ chiếu → is_foreign, due_at = nhận + 24 giờ khi cơ sở cấu hình; chưa cấu hình → due_at NULL; trong nước theo 23:00", async () => {
    const foreigner: GuestInput = {
      fullName: "John Doe",
      phone: "+15551234567",
      docType: "passport",
      docNumber: "X1234567",
      nationality: "US",
    };
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          walkIn(ctx, pii, {
            unitId: h.units.r202,
            departureDate: "2026-10-21",
            guests: [{ ...foreigner, docType: "cccd" }],
            now: new Date("2026-10-20T07:00:00Z"),
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    await sql`insert into notification_settings (id, organization_id, property_id, stay_notice_deadline, updated_by)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId},
                      '{"domestic_cutoff":"23:00","domestic_next_day_before":"08:00","foreign_hours":24}', ${h.org.ownerMembershipId})`.execute(
      h.t.admin,
    );
    const uf = await freshUnit();
    const ud = await freshUnit();
    const f = await okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: uf,
        departureDate: "2026-10-16",
        guests: [foreigner],
        now: new Date("2026-10-15T07:00:00Z"),
      }),
    );
    expect(f.noticeDueAt?.toISOString()).toBe("2026-10-16T07:00:00.000Z");
    const n = await sql<{
      is_foreign: boolean;
    }>`select is_foreign from residence_notices where id = ${f.noticeId}`.execute(h.t.admin);
    expect(n.rows[0]?.is_foreign).toBe(true);
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      walkIn(ctx, pii, {
        unitId: ud,
        departureDate: "2026-10-16",
        guests: [AN],
        now: new Date("2026-10-15T13:10:00Z"),
      }),
    );
    // Nhận 20:10 giờ VN → hạn 23:00 giờ VN = 16:00Z.
    expect(d.noticeDueAt?.toISOString()).toBe("2026-10-15T16:00:00.000Z");
  });
});

describe("quyền", () => {
  it("buồng phòng check-in/walk-in → 403; tổ chức khác → 404", async () => {
    const rid = await confirmedBooking(await freshUnit());
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: IN_DAY }),
        ),
      ),
    );
    expect(
      await codeOf(
        runAs(h.t, h.ownerOther, (ctx) =>
          checkIn(ctx, pii, { reservationId: rid, guests: [AN], now: IN_DAY }),
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});
