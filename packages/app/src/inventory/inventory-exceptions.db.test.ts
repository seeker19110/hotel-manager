// SPEC-inventory-allocation (mục 2) trên Postgres thật — scenario còn thiếu của T-604 (PLAN đợt 7): S-013, S-017, S-018, S-019,
// S-020, S-021, S-023 (+ cổng ROOM_OCCUPIED của S-020). Fixture khách sạn dùng chung (Asia/Ho_Chi_Minh, nhận 14:00 / trả 12:00);
// ngày dùng tháng 11/2026 trở đi (sau đồng hồ thật của phiên chạy) và đồng hồ test truyền qua tham số `now`.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/index.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { type CommandResult, toProblem } from "../pipeline/index.ts";
import { checkIn, checkOut, createReservation, holdReservation } from "../stay/index.ts";
import { confirmReservation } from "../stay/reservations.ts";
import { okAs, runAs, seedMember } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { getCalendar, searchAvailability } from "./calendar.ts";
import {
  approveBlock,
  confirmHold,
  createHold,
  endBlock,
  getUnitStatus,
  moveAllocation,
  proposeBlock,
  releaseHold,
  resizeAllocation,
  setUnitAvailability,
} from "./inventory.ts";
import { detectOverdue } from "./jobs.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
/** Giờ địa phương Asia/Ho_Chi_Minh (UTC+7), dạng `YYYY-MM-DDTHH:MM` → thời điểm tuyệt đối. */
const loc = (dt: string) => new Date(`${dt}:00+07:00`);

beforeAll(async () => {
  h = await seedHotel();
}, 60_000);

afterAll(async () => {
  await h?.t.drop();
});

let seq = 0;
async function newFloor(name = `Tầng T${seq}`, sortOrder = 0): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into floors (id, organization_id, property_id, name, sort_order)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${`${name}-${seq}`}, ${sortOrder})`.execute(
    h.t.admin,
  );
  return id;
}

async function freshUnit(
  opts: { floorId?: string; roomTypeId?: string; status?: string; code?: string } = {},
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${opts.floorId ?? h.org.floorId},
                    ${opts.roomTypeId ?? h.org.roomTypeId}, ${opts.code ?? `T${String(seq).padStart(3, "0")}`},
                    ${opts.status ?? "inspected"})`.execute(h.t.admin);
  return id;
}

interface Booked {
  reservationId: string;
  stayId: string;
  allocationId: string;
  bookerPersonId: string;
}

/** Booking đã xác nhận (stay `expected`, allocation `stay`); có `checkedInAt` thì check-in luôn (stay `in_house`). */
async function booking(
  unitId: string,
  arrival: string,
  departure: string,
  o: { checkedInAt?: Date; booker?: string } = {},
): Promise<Booked> {
  seq += 1;
  const d = await okAs(h.t, h.frontDesk, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: arrival,
      departureDate: departure,
      guests: 1,
      source: "direct",
      booker: { fullName: o.booker ?? "Người đặt", phone: "0100000333" },
    }),
  );
  await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  const c = await okAs(h.t, h.frontDesk, (ctx) =>
    confirmReservation(ctx, { reservationId: d.reservationId }),
  );
  if (o.checkedInAt) {
    const at = o.checkedInAt;
    await okAs(h.t, h.frontDesk, (ctx) =>
      checkIn(ctx, pii, {
        reservationId: d.reservationId,
        guests: [
          {
            fullName: "Nguyễn Văn An",
            phone: "0100005678",
            docType: "cccd",
            docNumber: `0012${String(seq).padStart(8, "0")}`,
          },
        ],
        now: at,
      }),
    );
  }
  const a = await sql<{ id: string; booker: string }>`
    select a.id, r.booker_person_id as booker from allocations a
    join reservations r on r.id = ${d.reservationId}
    where a.source_type = 'stay' and a.source_id = ${c.stayId}`.execute(h.t.admin);
  return {
    reservationId: d.reservationId,
    stayId: c.stayId,
    allocationId: a.rows[0]?.id as string,
    bookerPersonId: a.rows[0]?.booker as string,
  };
}

async function failed<T>(p: Promise<CommandResult<T>>) {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra phải bị từ chối");
  return r.problem;
}

const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (err) {
    return toProblem(err).code;
  }
};

const exceptionsOf = async (allocationId: string) =>
  (
    await sql<{ id: string; type: string; status: string; related: string | null }>`
      select id, type, status, related_allocation_id as related from exceptions
      where allocation_id = ${allocationId} order by type, created_at`.execute(h.t.admin)
  ).rows;

const count = async (q: ReturnType<typeof sql<{ n: number }>>) =>
  (await q.execute(h.t.admin)).rows[0]?.n ?? 0;

/** Bằng chứng audit + outbox của một command (theo command_id), tách hàng thành công khỏi hàng `command.denied`. */
async function evidence(commandId: string) {
  const audit = await sql<{ action: string; correlation_id: string; outcome: string }>`
    select action, correlation_id, outcome from audit_events where command_id = ${commandId} order by created_at, id`.execute(
    h.t.admin,
  );
  const outbox = await sql<{ event_type: string; correlation_id: string }>`
    select event_type, correlation_id from outbox where command_id = ${commandId} order by created_at, id`.execute(
    h.t.admin,
  );
  return {
    audit: audit.rows.filter((a) => a.outcome === "success"),
    denied: audit.rows.filter((a) => a.outcome === "denied"),
    outbox: outbox.rows,
  };
}

// ------------------------------------------------------------------------------------------------------------- S-013
describe("SPEC-inventory S-013 sự cố bất ngờ trên phòng có khách sắp đến (setUnitAvailability)", () => {
  const NOW = loc("2026-11-20T09:00");

  it("S-013: ngừng khai thác → UNIT_OUT_OF_SERVICE cho hold/check-in mới; booking không bị huỷ; RELOCATION_REQUIRED cho mỗi stay/lease còn hiệu lực sau now, không cho hold/đoạn đã qua; audit có trước/sau", async () => {
    const unit = await freshUnit();
    const today = await booking(unit, "2026-11-20", "2026-11-22"); // lượt ở expected bắt đầu hôm nay 14:00
    const next = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${next}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'lease', 'lease', ${randomUUID()},
                      '[2027-01-01T00:00:00+07,)'::tstzrange)`.execute(h.t.admin); // hợp đồng khoảng mở
    const past = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${past}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'stay', 'stay', ${randomUUID()},
                      '[2026-11-10T14:00:00+07,2026-11-12T12:00:00+07)'::tstzrange)`.execute(h.t.admin);
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2026-12-01T14:00"), end: loc("2026-12-02T12:00") },
        ttlMinutes: 60,
      }),
    );

    const r = await runAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, {
        unitId: unit,
        availability: "out_of_service",
        reason: "Hỏng điều hoà",
        now: NOW,
      }),
    );
    if (r.status !== "committed") throw new Error(r.problem.code);
    expect(r.data.availability).toBe("out_of_service");
    expect(r.data.exceptionIds).toHaveLength(2);

    const u = await sql<{ availability: string; availability_reason: string }>`
      select availability, availability_reason from units where id = ${unit}`.execute(h.t.admin);
    expect(u.rows[0]).toEqual({ availability: "out_of_service", availability_reason: "Hỏng điều hoà" });
    // Mọi hold/check-in mới → UNIT_OUT_OF_SERVICE.
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            createHold(ctx, {
              unitId: unit,
              during: { start: loc("2027-06-01T14:00"), end: loc("2027-06-02T12:00") },
              ttlMinutes: 15,
            }),
          ),
        )
      ).code,
    ).toBe("UNIT_OUT_OF_SERVICE");
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            checkIn(ctx, pii, {
              reservationId: today.reservationId,
              guests: [
                {
                  fullName: "Trần Thị Bình",
                  phone: "0100009999",
                  docType: "cccd",
                  docNumber: "001200000001",
                },
              ],
              now: loc("2026-11-20T15:00"),
            }),
          ),
        )
      ).code,
    ).toBe("UNIT_OUT_OF_SERVICE");
    expect(await getUnitStatus(h.t.runtime, h.manager, unit, NOW)).toMatchObject({ sellable: false });

    // Booking không bị xoá/huỷ; ngoại lệ đúng cho stay + lease, không cho hold, không cho đoạn đã qua.
    const res = await sql<{
      status: string;
    }>`select status from reservations where id = ${today.reservationId}`.execute(h.t.admin);
    expect(res.rows[0]?.status).toBe("confirmed");
    const act = await sql<{
      active: boolean;
    }>`select active from allocations where id = ${today.allocationId}`.execute(h.t.admin);
    expect(act.rows[0]?.active).toBe(true);
    expect((await exceptionsOf(today.allocationId)).map((e) => [e.type, e.status])).toEqual([
      ["RELOCATION_REQUIRED", "open"],
    ]);
    expect((await exceptionsOf(next)).map((e) => [e.type, e.status])).toEqual([
      ["RELOCATION_REQUIRED", "open"],
    ]);
    expect(await exceptionsOf(hold.allocationId)).toEqual([]);
    expect(await exceptionsOf(past)).toEqual([]);

    // Audit trước/sau + lý do; outbox cùng command.
    const a = await sql<{
      before: { availability: string };
      after: { availability: string };
      reason: string;
    }>`
      select before, after, reason from audit_events
      where command_id = ${r.commandId} and action = 'unit.availability_changed'`.execute(h.t.admin);
    expect(a.rows).toEqual([
      {
        before: { availability: "active", availability_reason: null },
        after: { availability: "out_of_service", availability_reason: "Hỏng điều hoà" },
        reason: "Hỏng điều hoà",
      },
    ]);
    const ev = await evidence(r.commandId);
    expect(ev.audit.map((x) => x.action).sort()).toEqual([
      "exception.opened",
      "exception.opened",
      "unit.availability_changed",
    ]);
    expect(ev.outbox.map((x) => x.event_type).sort()).toEqual([
      "exception.opened",
      "exception.opened",
      "unit.availability_changed",
    ]);
  });

  it("S-013 ca biên: gọi lại không nhân bản ngoại lệ (cùng id, không audit thêm); bật lại active xoá lý do, không mở ngoại lệ mới", async () => {
    const unit = await freshUnit();
    const b = await booking(unit, "2026-11-25", "2026-11-27");
    const first = await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, { unitId: unit, availability: "out_of_service", reason: "Rò nước", now: NOW }),
    );
    const again = await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, { unitId: unit, availability: "out_of_service", reason: "Rò nước", now: NOW }),
    );
    expect(again.exceptionIds).toEqual(first.exceptionIds);
    expect(await exceptionsOf(b.allocationId)).toHaveLength(1);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where entity_type = 'exception' and entity_id = ${first.exceptionIds[0] ?? randomUUID()}`,
      ),
    ).toBe(1);
    const back = await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, { unitId: unit, availability: "active", now: NOW }),
    );
    expect(back.exceptionIds).toEqual([]);
    const u = await sql<{ availability: string; availability_reason: string | null }>`
      select availability, availability_reason from units where id = ${unit}`.execute(h.t.admin);
    expect(u.rows[0]).toEqual({ availability: "active", availability_reason: null });
    // Ngoại lệ đã mở vẫn còn đó để người quản lý xử lý (không tự đóng).
    expect((await exceptionsOf(b.allocationId))[0]?.status).toBe("open");
  });

  it("S-013 ca biên: lượt ở ĐANG diễn ra cũng nhận RELOCATION_REQUIRED; phòng trống ngừng khai thác → exceptionIds rỗng (không null)", async () => {
    const unit = await freshUnit();
    const b = await booking(unit, "2027-06-01", "2027-06-03", { checkedInAt: loc("2027-06-01T15:00") });
    const r = await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, {
        unitId: unit,
        availability: "out_of_service",
        reason: "Sơn lại",
        now: loc("2027-06-02T09:00"),
      }),
    );
    expect(r.exceptionIds).toHaveLength(1);
    expect((await exceptionsOf(b.allocationId))[0]?.type).toBe("RELOCATION_REQUIRED");
    const empty = await freshUnit();
    expect(
      (
        await okAs(h.t, h.manager, (ctx) =>
          setUnitAvailability(ctx, { unitId: empty, availability: "out_of_service", reason: "Sửa sàn" }),
        )
      ).exceptionIds,
    ).toEqual([]);
  });

  it("S-013 ca biên: thiếu/trống lý do → 422 reason required, phòng không đổi; chuyển phòng sang phòng ngừng khai thác → UNIT_OUT_OF_SERVICE", async () => {
    const unit = await freshUnit();
    for (const reason of [undefined, "", "   "]) {
      const p = await failed(
        runAs(h.t, h.manager, (ctx) =>
          setUnitAvailability(ctx, {
            unitId: unit,
            availability: "out_of_service",
            ...(reason !== undefined ? { reason } : {}),
          }),
        ),
      );
      expect(p).toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        errors: [{ field: "reason", code: "required" }],
      });
    }
    const av = await sql<{ availability: string }>`select availability from units where id = ${unit}`.execute(
      h.t.admin,
    );
    expect(av.rows[0]?.availability).toBe("active");

    const from = await freshUnit();
    const to = await freshUnit();
    const b = await booking(from, "2026-12-10", "2026-12-12");
    await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, { unitId: to, availability: "out_of_service", reason: "Hỏng" }),
    );
    const mv = await failed(
      runAs(h.t, h.frontDesk, (ctx) =>
        moveAllocation(ctx, {
          allocationId: b.allocationId,
          toUnitId: to,
          at: loc("2026-12-11T10:00"),
          reason: "Khách đổi phòng",
        }),
      ),
    );
    expect(mv.code).toBe("UNIT_OUT_OF_SERVICE");
  });

  it("S-013 quyền: chỉ owner/manager; lễ tân/buồng phòng → FORBIDDEN 403; tổ chức khác hoặc phòng không có → 404", async () => {
    const unit = await freshUnit();
    for (const who of [h.frontDesk, h.housekeeping, h.accountant]) {
      expect(
        (
          await failed(
            runAs(h.t, who, (ctx) =>
              setUnitAvailability(ctx, { unitId: unit, availability: "out_of_service", reason: "x" }),
            ),
          )
        ).code,
      ).toBe("FORBIDDEN");
    }
    for (const id of [unit, randomUUID()]) {
      expect(
        (
          await failed(
            runAs(h.t, h.ownerOther, (ctx) =>
              setUnitAvailability(ctx, { unitId: id, availability: "out_of_service", reason: "x" }),
            ),
          )
        ).code,
      ).toBe("NOT_FOUND");
    }
    const av = await sql<{ availability: string }>`select availability from units where id = ${unit}`.execute(
      h.t.admin,
    );
    expect(av.rows[0]?.availability).toBe("active");
  });

  it("S-013 ca biên: hold tạo TRƯỚC khi phòng ngừng khai thác không xác nhận được (confirmHold stay/lease, confirmReservation) → 409 UNIT_OUT_OF_SERVICE, hold/booking giữ nguyên; bật lại thì xác nhận được", async () => {
    const out = (unitId: string) =>
      okAs(h.t, h.manager, (ctx) =>
        setUnitAvailability(ctx, { unitId, availability: "out_of_service", reason: "Sập trần" }),
      );
    const kindOf = async (id: string) =>
      (await sql<{ kind: string }>`select kind from allocations where id = ${id}`.execute(h.t.admin)).rows[0]
        ?.kind;

    const unit = await freshUnit();
    const holdStay = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2027-05-01T14:00"), end: loc("2027-05-02T12:00") },
        ttlMinutes: 60,
      }),
    );
    const holdLease = await okAs(h.t, h.manager, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2027-06-01T00:00"), end: null },
        ttlMinutes: 60,
        sourceType: "lease",
        sourceId: randomUUID(),
      }),
    );
    await out(unit);
    for (const [id, kind] of [
      [holdStay.allocationId, "stay"],
      [holdLease.allocationId, "lease"],
    ] as const) {
      expect((await failed(runAs(h.t, h.manager, (ctx) => confirmHold(ctx, id, kind)))).code).toBe(
        "UNIT_OUT_OF_SERVICE",
      );
      expect(await kindOf(id)).toBe("hold");
    }
    await okAs(h.t, h.manager, (ctx) => setUnitAvailability(ctx, { unitId: unit, availability: "active" }));
    await okAs(h.t, h.frontDesk, (ctx) => confirmHold(ctx, holdStay.allocationId, "stay"));
    expect(await kindOf(holdStay.allocationId)).toBe("stay");

    // confirmReservation đi qua confirmHold: booking `held` trên phòng vừa ngừng khai thác bị chặn, vẫn `held`.
    const unit2 = await freshUnit();
    const d = await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: unit2,
        arrivalDate: "2027-05-10",
        departureDate: "2027-05-12",
        guests: 1,
        source: "direct",
        booker: { fullName: "Người đặt", phone: "0100000444" },
      }),
    );
    await okAs(h.t, h.frontDesk, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
    await out(unit2);
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) => confirmReservation(ctx, { reservationId: d.reservationId })),
        )
      ).code,
    ).toBe("UNIT_OUT_OF_SERVICE");
    const st = await sql<{
      status: string;
    }>`select status from reservations where id = ${d.reservationId}`.execute(h.t.admin);
    expect(st.rows[0]?.status).toBe("held");
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from stays where unit_id = ${unit2}`),
    ).toBe(0);
  });

  it("S-013 ca đua: confirmHold đồng thời với việc phòng ngừng khai thác (giữ khoá phòng) → confirmHold chờ khoá rồi thấy out_of_service → UNIT_OUT_OF_SERVICE, không thành lượt ở", async () => {
    const unit = await freshUnit();
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2027-07-01T14:00"), end: loc("2027-07-02T12:00") },
        ttlMinutes: 60,
      }),
    );
    let confirming: ReturnType<typeof runAs<void>> | undefined;
    await h.t.admin.transaction().execute(async (trx) => {
      await sql`select 1 from units where id = ${unit} for update`.execute(trx);
      confirming = runAs(h.t, h.frontDesk, (ctx) => confirmHold(ctx, hold.allocationId, "stay"));
      await new Promise((r) => setTimeout(r, 400)); // để confirmHold tới điểm chờ khoá phòng
      await sql`update units set availability = 'out_of_service', availability_reason = 'Sự cố' where id = ${unit}`.execute(
        trx,
      );
    });
    expect((await failed(confirming as NonNullable<typeof confirming>)).code).toBe("UNIT_OUT_OF_SERVICE");
    const al = await sql<{
      kind: string;
    }>`select kind from allocations where id = ${hold.allocationId}`.execute(h.t.admin);
    expect(al.rows[0]?.kind).toBe("hold");
  });
});

// ------------------------------------------------------------------------------------------------------------- S-017
describe("SPEC-inventory S-017 quá hạn chưa trả phòng (detectOverdue)", () => {
  it("S-017: quá giờ trả + ngưỡng 60 phút → đúng 1 STAY_OVERSTAY (chạy lại không thêm), allocation không tự kết thúc, booking xác nhận kế tiếp nhận RELOCATION_REQUIRED, lịch 'Quá hạn trả', check-in/giữ chỗ mới → ROOM_OCCUPIED", async () => {
    const floor = await newFloor();
    const unit = await freshUnit({ floorId: floor, code: "O101" });
    const s1 = await booking(unit, "2026-11-15", "2026-11-17", { checkedInAt: loc("2026-11-15T15:00") });
    const r2 = await booking(unit, "2026-11-17", "2026-11-18"); // đã xác nhận, bắt đầu 17/11 14:00
    const t0 = loc("2026-11-17T13:00"); // đúng giờ trả 12:00 + 60 phút

    expect(await detectOverdue(h.t.worker, new Date(t0.getTime() - 1000))).toBe(0); // thiếu 1 giây: chưa quá hạn
    expect(await exceptionsOf(s1.allocationId)).toEqual([]);

    const opened = [
      await detectOverdue(h.t.worker, t0),
      await detectOverdue(h.t.worker, t0),
      await detectOverdue(h.t.worker, t0),
    ];
    expect(opened).toEqual([1, 0, 0]);
    expect(await exceptionsOf(s1.allocationId)).toEqual([
      expect.objectContaining({ type: "STAY_OVERSTAY", status: "open", related: r2.allocationId }),
    ]);
    expect(await exceptionsOf(r2.allocationId)).toEqual([
      expect.objectContaining({ type: "RELOCATION_REQUIRED", status: "open", related: s1.allocationId }),
    ]);
    const al = await sql<{
      active: boolean;
      hi: Date;
    }>`select active, upper(during) as hi from allocations where id = ${s1.allocationId}`.execute(h.t.admin);
    expect(al.rows[0]).toEqual({ active: true, hi: loc("2026-11-17T12:00") });
    const st = await sql<{ status: string }>`select status from stays where id = ${s1.stayId}`.execute(
      h.t.admin,
    );
    expect(st.rows[0]?.status).toBe("in_house");

    // Audit do worker + outbox, mỗi ngoại lệ đúng một lần dù chạy 3 lần.
    const ids = (await exceptionsOf(s1.allocationId))
      .concat(await exceptionsOf(r2.allocationId))
      .map((e) => e.id);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where actor_type = 'worker' and action = 'exception.opened' and entity_id = any(${ids}::uuid[])`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from outbox where event_type = 'exception.opened' and aggregate_id = any(${ids}::uuid[])`,
      ),
    ).toBe(2);

    // Lịch hiển thị "Quá hạn trả" cho s1, không cho r2.
    const cal = await getCalendar(
      h.t.runtime,
      h.manager,
      { propertyId: h.org.propertyId, from: "2026-11-15", to: "2026-11-20", floorId: floor },
      t0,
    );
    const segs = cal.rooms[0]?.segments ?? [];
    expect(segs.map((s) => [s.allocationId, s.overdue])).toEqual([
      [s1.allocationId, true],
      [r2.allocationId, false],
    ]);

    // Check-in booking kế tiếp và giữ chỗ mới vào phòng → 409 ROOM_OCCUPIED.
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            checkIn(ctx, pii, {
              reservationId: r2.reservationId,
              guests: [
                { fullName: "Lê Văn Cường", phone: "0100007777", docType: "cccd", docNumber: "001200000002" },
              ],
              now: loc("2026-11-17T14:30"),
            }),
          ),
        )
      ).code,
    ).toBe("ROOM_OCCUPIED");
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            createHold(ctx, {
              unitId: unit,
              during: { start: loc("2026-11-20T14:00"), end: loc("2026-11-21T12:00") },
              ttlMinutes: 15,
            }),
          ),
        )
      ).code,
    ).toBe("ROOM_OCCUPIED");
  });

  it("S-017 ca biên: hold chưa xác nhận kế tiếp KHÔNG nhận RELOCATION_REQUIRED; stay 'expected' (chưa check-in) quá hạn KHÔNG bị coi là quá hạn trả", async () => {
    const unit = await freshUnit();
    const s = await booking(unit, "2026-12-01", "2026-12-03", { checkedInAt: loc("2026-12-01T15:00") });
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2026-12-03T14:00"), end: loc("2026-12-04T12:00") },
        ttlMinutes: 24 * 60 * 400,
      }),
    );
    const ghost = await freshUnit();
    const noShow = await booking(ghost, "2026-12-01", "2026-12-03"); // không check-in
    await detectOverdue(h.t.worker, loc("2026-12-03T14:00"));
    expect((await exceptionsOf(s.allocationId)).map((e) => [e.type, e.related])).toEqual([
      ["STAY_OVERSTAY", hold.allocationId],
    ]);
    expect(await exceptionsOf(hold.allocationId)).toEqual([]);
    expect(await exceptionsOf(noShow.allocationId)).toEqual([]);
  });

  it("S-017 ngưỡng cấu hình theo cơ sở (Q-03): properties.overstay_grace_minutes = 0 → quá hạn đúng giờ trả; 120 → chưa quá hạn sau 60 phút", async () => {
    const setGrace = (m: number) =>
      sql`update properties set overstay_grace_minutes = ${m} where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    try {
      const u0 = await freshUnit();
      const a0 = await booking(u0, "2027-02-01", "2027-02-03", { checkedInAt: loc("2027-02-01T15:00") });
      await setGrace(120);
      await detectOverdue(h.t.worker, loc("2027-02-03T13:30"));
      expect(await exceptionsOf(a0.allocationId)).toEqual([]);
      await detectOverdue(h.t.worker, loc("2027-02-03T14:00"));
      expect((await exceptionsOf(a0.allocationId)).map((e) => e.type)).toEqual(["STAY_OVERSTAY"]);

      const u1 = await freshUnit();
      const a1 = await booking(u1, "2027-02-10", "2027-02-12", { checkedInAt: loc("2027-02-10T15:00") });
      await setGrace(0);
      await detectOverdue(h.t.worker, new Date(loc("2027-02-12T12:00").getTime() - 1000));
      expect(await exceptionsOf(a1.allocationId)).toEqual([]);
      await detectOverdue(h.t.worker, loc("2027-02-12T12:00"));
      expect((await exceptionsOf(a1.allocationId)).map((e) => e.type)).toEqual(["STAY_OVERSTAY"]);
    } finally {
      await sql`update properties set overstay_grace_minutes = 60 where id = ${h.org.propertyId}`.execute(
        h.t.admin,
      );
    }
  });

  it("S-017 INV-G1: job ghi ngoại lệ đúng tổ chức của lượt ở quá hạn (không lẫn sang tổ chức khác)", async () => {
    const o = h.other;
    const guest = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${guest}, ${o.orgId}, 'Khách tổ chức B')`.execute(
      h.t.admin,
    );
    const resId = randomUUID();
    const itemId = randomUUID();
    await sql`insert into reservations (id, organization_id, property_id, number, status, source, booker_person_id, created_by)
              values (${resId}, ${o.orgId}, ${o.propertyId}, ${`R-${Math.floor(Math.random() * 1e9)}`}, 'in_house', 'direct', ${guest}, ${o.ownerMembershipId})`.execute(
      h.t.admin,
    );
    await sql`insert into reservation_items (id, organization_id, property_id, reservation_id, unit_id, room_type_id, arrival_date, departure_date, guests, nightly_prices, room_total)
              values (${itemId}, ${o.orgId}, ${o.propertyId}, ${resId}, ${o.unitId}, ${o.roomTypeId}, '2026-09-01', '2026-09-03', 1,
                      '[{"businessDate":"2026-09-01","amount":1},{"businessDate":"2026-09-02","amount":1}]'::jsonb, 2)`.execute(
      h.t.admin,
    );
    const stayId = randomUUID();
    await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id, checked_in_at, checked_in_by)
              values (${stayId}, ${o.orgId}, ${o.propertyId}, ${itemId}, ${o.unitId}, 'in_house', ${guest}, '2026-09-01T08:00:00Z', ${o.ownerMembershipId})`.execute(
      h.t.admin,
    );
    const alloc = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${alloc}, ${o.orgId}, ${o.propertyId}, ${o.unitId}, 'stay', 'stay', ${stayId}, '[2026-09-01T07:00:00Z,2026-09-03T05:00:00Z)'::tstzrange)`.execute(
      h.t.admin,
    );
    await detectOverdue(h.t.worker, loc("2026-09-04T09:00"));
    const ex = await sql<{
      organization_id: string;
      type: string;
    }>`select organization_id, type from exceptions where allocation_id = ${alloc}`.execute(h.t.admin);
    expect(ex.rows).toEqual([{ organization_id: o.orgId, type: "STAY_OVERSTAY" }]);
    const au = await sql<{ organization_id: string; actor_type: string }>`
      select organization_id, actor_type from audit_events where action = 'exception.opened' and entity_id = ${ex.rows[0] ? (await exceptionsOf(alloc))[0]?.id : randomUUID()}`.execute(
      h.t.admin,
    );
    expect(au.rows).toEqual([{ organization_id: o.orgId, actor_type: "worker" }]);
  });

  it("S-017: trả phòng muộn → ngoại lệ STAY_OVERSTAY (và RELOCATION_REQUIRED do nó gây ra) được đóng với resolution, phòng hết bị chặn", async () => {
    const unit = await freshUnit();
    const s = await booking(unit, "2026-11-25", "2026-11-27", { checkedInAt: loc("2026-11-25T15:00") });
    const next = await booking(unit, "2026-11-27", "2026-11-28");
    await detectOverdue(h.t.worker, loc("2026-11-27T13:30"));
    expect(await exceptionsOf(s.allocationId)).toHaveLength(1);
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            createHold(ctx, {
              unitId: unit,
              during: { start: loc("2026-12-20T14:00"), end: loc("2026-12-21T12:00") },
              ttlMinutes: 15,
            }),
          ),
        )
      ).code,
    ).toBe("ROOM_OCCUPIED");

    const out = await runAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        allowBalance: { debtorPersonId: s.bookerPersonId, dueDate: "2026-12-30" },
        now: loc("2026-11-27T13:45"),
      }),
    );
    if (out.status !== "committed") throw new Error(out.problem.code);
    const ex = await sql<{ status: string; resolution: string | null; resolved_by: string | null }>`
      select status, resolution, resolved_by from exceptions where allocation_id = ${s.allocationId}`.execute(
      h.t.admin,
    );
    expect(ex.rows).toEqual([
      { status: "resolved", resolution: "checked_out", resolved_by: h.manager.membershipId },
    ]);
    expect((await exceptionsOf(next.allocationId)).map((e) => [e.type, e.status])).toEqual([
      ["RELOCATION_REQUIRED", "resolved"],
    ]);
    const ev = await evidence(out.commandId);
    expect(ev.audit.filter((a) => a.action === "exception.resolved")).toHaveLength(2);
    expect(ev.outbox.filter((o) => o.event_type === "exception.resolved")).toHaveLength(2);
    // Phòng hết chặn: giữ chỗ tương lai được; job chạy lại không mở lại ngoại lệ (stay đã check_out).
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2026-12-20T14:00"), end: loc("2026-12-21T12:00") },
        ttlMinutes: 15,
      }),
    );
    await detectOverdue(h.t.worker, loc("2026-11-27T20:00"));
    expect((await exceptionsOf(s.allocationId)).filter((e) => e.status === "open")).toEqual([]);
  });

  it("S-017 chuyển phòng rồi detectOverdue: chỉ allocation CUỐI của lượt ở (phòng mới) quá hạn; đoạn cũ đã thu về [lo, at) không báo STAY_OVERSTAY và booking sau đó trên phòng cũ không nhận RELOCATION_REQUIRED", async () => {
    const oldUnit = await freshUnit();
    const newUnit = await freshUnit();
    const s = await booking(oldUnit, "2026-12-10", "2026-12-12", { checkedInAt: loc("2026-12-10T15:00") });
    const moved = await okAs(h.t, h.manager, (ctx) =>
      moveAllocation(ctx, {
        allocationId: s.allocationId,
        toUnitId: newUnit,
        at: loc("2026-12-11T10:00"),
        reason: "Điều hoà hỏng",
      }),
    );
    const afterOnOld = await booking(oldUnit, "2026-12-11", "2026-12-12"); // đặt vào phòng cũ sau khi chuyển
    const afterOnNew = await booking(newUnit, "2026-12-12", "2026-12-13"); // kế tiếp thật sự trên phòng mới
    const t0 = loc("2026-12-12T13:00");

    await detectOverdue(h.t.worker, t0);
    expect(await exceptionsOf(s.allocationId)).toEqual([]);
    expect(await exceptionsOf(afterOnOld.allocationId)).toEqual([]);
    expect(await exceptionsOf(moved.newAllocationId)).toEqual([
      expect.objectContaining({ type: "STAY_OVERSTAY", status: "open", related: afterOnNew.allocationId }),
    ]);
    expect(await exceptionsOf(afterOnNew.allocationId)).toEqual([
      expect.objectContaining({
        type: "RELOCATION_REQUIRED",
        status: "open",
        related: moved.newAllocationId,
      }),
    ]);
    // Phòng cũ không bị coi là còn người: giữ chỗ vào phòng cũ không bị ROOM_OCCUPIED.
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: oldUnit,
        during: { start: loc("2026-12-20T14:00"), end: loc("2026-12-21T12:00") },
        ttlMinutes: 15,
      }),
    );
    await detectOverdue(h.t.worker, t0);
    expect(await exceptionsOf(s.allocationId)).toEqual([]);
  });

  it("S-017 + S-013 chuỗi: quá hạn → phòng ngừng khai thác → check-out: RELOCATION_REQUIRED của booking kế tiếp KHÔNG bị đóng khi phòng còn out_of_service (STAY_OVERSTAY vẫn đóng)", async () => {
    const unit = await freshUnit();
    const s = await booking(unit, "2026-11-28", "2026-11-30", { checkedInAt: loc("2026-11-28T15:00") });
    const next = await booking(unit, "2026-11-30", "2026-12-01");
    const t0 = loc("2026-11-30T13:30");
    await detectOverdue(h.t.worker, t0);
    expect((await exceptionsOf(next.allocationId)).map((e) => [e.type, e.status, e.related])).toEqual([
      ["RELOCATION_REQUIRED", "open", s.allocationId],
    ]);
    await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, {
        unitId: unit,
        availability: "out_of_service",
        reason: "Ngập nước",
        now: t0,
      }),
    );
    expect((await exceptionsOf(next.allocationId)).map((e) => [e.type, e.status])).toEqual([
      ["RELOCATION_REQUIRED", "open"],
    ]); // dùng chung một ngoại lệ mở cho hai nguyên nhân

    await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        allowBalance: { debtorPersonId: s.bookerPersonId, dueDate: "2026-12-30" },
        now: loc("2026-11-30T13:45"),
      }),
    );
    expect(
      (await exceptionsOf(s.allocationId)).filter((e) => e.type === "STAY_OVERSTAY").map((e) => e.status),
    ).toEqual(["resolved"]);
    expect((await exceptionsOf(next.allocationId)).map((e) => [e.type, e.status])).toEqual([
      ["RELOCATION_REQUIRED", "open"], // phòng vẫn out_of_service ⇒ booking vẫn phải được dời
    ]);

    // Phòng hoạt động lại rồi mới trả phòng muộn ở lượt khác: ngoại lệ do quá hạn vẫn đóng như thường (đã có ca ở trên).
    const other = await freshUnit();
    const s2 = await booking(other, "2026-11-28", "2026-11-30", { checkedInAt: loc("2026-11-28T15:00") });
    const n2 = await booking(other, "2026-11-30", "2026-12-01");
    await detectOverdue(h.t.worker, t0);
    await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: s2.stayId,
        allowBalance: { debtorPersonId: s2.bookerPersonId, dueDate: "2026-12-30" },
        now: loc("2026-11-30T13:45"),
      }),
    );
    expect((await exceptionsOf(n2.allocationId)).map((e) => e.status)).toEqual(["resolved"]);
  });

  it("S-017 lịch: khoảng xem bắt đầu SAU giờ trả dự kiến vẫn hiện đoạn 'Quá hạn trả' (ngoại lệ mở, bất kể khoảng xem); đoạn đã qua không có ngoại lệ thì không hiện; trả phòng xong thì đoạn biến mất", async () => {
    const floor = await newFloor();
    const unit = await freshUnit({ floorId: floor, code: "Q101" });
    const calm = await freshUnit({ floorId: floor, code: "Q102" });
    const s = await booking(unit, "2027-03-01", "2027-03-03", { checkedInAt: loc("2027-03-01T15:00") });
    await booking(calm, "2027-03-01", "2027-03-03"); // chưa check-in: không phải quá hạn trả
    const t0 = loc("2027-03-04T09:00"); // quá hạn trả từ 03/03 12:00 (+ ngưỡng 60 phút)
    await detectOverdue(h.t.worker, t0);
    const view = (from: string, to: string) =>
      getCalendar(h.t.runtime, h.manager, { propertyId: h.org.propertyId, from, to, floorId: floor }, t0);

    const late = await view("2027-03-04", "2027-03-07"); // bắt đầu sau giờ trả dự kiến
    expect(late.rooms.map((r) => [r.code, r.segments.map((x) => [x.allocationId, x.overdue])])).toEqual([
      ["Q101", [[s.allocationId, true]]],
      ["Q102", []],
    ]);
    const edge = await view("2027-03-03", "2027-03-05"); // from ngay sau giờ trả (kết thúc 12:00 ngày 03 vẫn chồng ngày 03)
    expect(edge.rooms[0]?.segments.map((x) => [x.allocationId, x.overdue])).toEqual([[s.allocationId, true]]);
    const inside = await view("2027-03-01", "2027-03-05"); // khoảng xem chứa đoạn: chỉ một đoạn, không nhân đôi
    expect(inside.rooms[0]?.segments).toHaveLength(1);

    await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        allowBalance: { debtorPersonId: s.bookerPersonId, dueDate: "2027-03-30" },
        now: loc("2027-03-04T09:30"),
      }),
    );
    const done = await view("2027-03-04", "2027-03-07");
    expect(done.rooms.map((r) => r.segments)).toEqual([[], []]);
  });

  it("S-017/S-020: MỖI booking đã xác nhận (stay và lease) đứng sau allocation quá hạn nhận RELOCATION_REQUIRED, không chỉ booking kế tiếp; hold chưa xác nhận không nhận; chạy lại không nhân; trả phòng đóng tất cả", async () => {
    const unit = await freshUnit();
    const s = await booking(unit, "2027-04-10", "2027-04-12", { checkedInAt: loc("2027-04-10T15:00") });
    const r2 = await booking(unit, "2027-04-12", "2027-04-13");
    const r3 = await booking(unit, "2027-04-14", "2027-04-15");
    const hold = await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2027-04-16T14:00"), end: loc("2027-04-17T12:00") },
        ttlMinutes: 24 * 60 * 400,
      }),
    );
    const lease = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${lease}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'lease', 'lease', ${randomUUID()},
                      '[2027-04-20T00:00:00+07,)'::tstzrange)`.execute(h.t.admin);
    const t0 = loc("2027-04-12T13:30");
    await detectOverdue(h.t.worker, t0);
    await detectOverdue(h.t.worker, t0);
    for (const id of [r2.allocationId, r3.allocationId, lease]) {
      expect(
        (await exceptionsOf(id)).map((e) => [e.type, e.status, e.related]),
        id,
      ).toEqual([["RELOCATION_REQUIRED", "open", s.allocationId]]);
    }
    expect(await exceptionsOf(hold.allocationId)).toEqual([]);

    await okAs(h.t, h.manager, (ctx) =>
      checkOut(ctx, {
        stayId: s.stayId,
        allowBalance: { debtorPersonId: s.bookerPersonId, dueDate: "2027-04-30" },
        now: loc("2027-04-12T13:45"),
      }),
    );
    for (const id of [r2.allocationId, r3.allocationId, lease]) {
      expect(
        (await exceptionsOf(id)).map((e) => e.status),
        id,
      ).toEqual(["resolved"]);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------- S-018, S-019
describe("SPEC-inventory S-018 gia hạn đụng booking đã xác nhận (resizeAllocation)", () => {
  it("S-018: 409 ROOM_UNAVAILABLE kèm exception_id (EXTENSION_CONFLICT ghi ở transaction riêng); s1 và r2 giữ nguyên; constraint vẫn còn; gửi lại cùng key/khác key không nhân ngoại lệ", async () => {
    const unit = await freshUnit();
    const s1 = await booking(unit, "2026-11-15", "2026-11-17");
    const r2 = await booking(unit, "2026-11-17", "2026-11-18"); // confirmed từ 17/11 14:00
    const before = await sql<{
      id: string;
      during: string;
    }>`select id, during::text from allocations where id in (${s1.allocationId}, ${r2.allocationId}) order by id`.execute(
      h.t.admin,
    );
    const key = randomUUID();
    const run = (k: string) =>
      runAs(
        h.t,
        h.manager,
        (ctx) => resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2026-11-18T12:00") }),
        {
          key: k,
          payload: { allocation_id: s1.allocationId, end: "2026-11-18T12:00" },
        },
      );
    const r = await run(key);
    if (r.status !== "failed") throw new Error("lẽ ra phải bị từ chối");
    expect(r.httpStatus).toBe(409);
    expect(r.problem).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    const exId = r.problem.exception_id as string;
    expect(exId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await exceptionsOf(s1.allocationId)).toEqual([
      { id: exId, type: "EXTENSION_CONFLICT", status: "open", related: r2.allocationId },
    ]);
    // Không có SQL/constraint lộ ra; s1, r2 không đổi.
    expect(JSON.stringify(r.problem)).not.toMatch(/23P01|ex_allocations|violates|exclusion/i);
    const after = await sql<{
      id: string;
      during: string;
    }>`select id, during::text from allocations where id in (${s1.allocationId}, ${r2.allocationId}) order by id`.execute(
      h.t.admin,
    );
    expect(after.rows).toEqual(before.rows);
    // Ràng buộc EXCLUDE còn nguyên, không hoãn.
    const c = await sql<{
      deferrable: boolean;
    }>`select condeferrable as deferrable from pg_constraint where conname = 'ex_allocations_no_overlap'`.execute(
      h.t.admin,
    );
    expect(c.rows).toEqual([{ deferrable: false }]);
    // Replay cùng key → cùng kết quả; key khác → vẫn một ngoại lệ, cùng exception_id.
    const replay = await run(key);
    expect(replay).toMatchObject({ status: "failed", replayed: true, problem: { exception_id: exId } });
    const other = await run(randomUUID());
    expect(other).toMatchObject({
      status: "failed",
      problem: { code: "ROOM_UNAVAILABLE", exception_id: exId },
    });
    expect(await exceptionsOf(s1.allocationId)).toHaveLength(1);
    // Audit + outbox của ngoại lệ ghi đúng một lần cùng command.
    const ev = await evidence(r.commandId);
    expect(ev.audit.map((a) => a.action)).toEqual(["exception.opened"]);
    expect(ev.denied.map((a) => a.action)).toEqual(["command.denied"]);
    expect(ev.outbox.map((o) => o.event_type)).toEqual(["exception.opened"]);
  });

  it("S-018 ca biên: bên chiếm chỉ là hold chưa xác nhận → ROOM_UNAVAILABLE KHÔNG có exception_id và không có ngoại lệ", async () => {
    const unit = await freshUnit();
    const s1 = await booking(unit, "2026-12-05", "2026-12-07");
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: loc("2026-12-07T14:00"), end: loc("2026-12-08T12:00") },
        ttlMinutes: 60,
      }),
    );
    const p = await failed(
      runAs(h.t, h.manager, (ctx) =>
        resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2026-12-08T12:00") }),
      ),
    );
    expect(p.code).toBe("ROOM_UNAVAILABLE");
    expect(p.exception_id).toBeUndefined();
    expect(await exceptionsOf(s1.allocationId)).toEqual([]);
  });

  it("S-018 ca biên: hold hết hạn nằm chắn đường được dọn (audit một lần) và gia hạn thành công; rút ngắn luôn được; sát biên [) không chồng", async () => {
    const unit = await freshUnit();
    const s1 = await booking(unit, "2026-12-15", "2026-12-17");
    const stale = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${stale}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'hold', '[2026-12-17T14:00:00+07,2026-12-18T12:00:00+07)'::tstzrange, '2026-01-01T00:00:00Z')`.execute(
      h.t.admin,
    );
    const r = await okAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2026-12-18T12:00") }),
    );
    expect(r.end).toBe(loc("2026-12-18T12:00").toISOString());
    const st = await sql<{ active: boolean }>`select active from allocations where id = ${stale}`.execute(
      h.t.admin,
    );
    expect(st.rows[0]?.active).toBe(false);
    expect(
      await count(
        sql<{
          n: number;
        }>`select count(*)::int as n from audit_events where entity_id = ${stale} and action = 'allocation.hold_expired'`,
      ),
    ).toBe(1);
    // Rút ngắn, rồi sát biên với allocation kế tiếp (kết thúc đúng lúc bắt đầu) không chồng.
    const next = await booking(await freshUnit(), "2026-12-15", "2026-12-16");
    await okAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2026-12-16T12:00") }),
    );
    await okAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, {
        allocationId: s1.allocationId,
        start: loc("2026-12-15T10:00"),
        end: loc("2026-12-17T14:00"),
      }),
    );
    expect(next.allocationId).toBeTruthy();
  });

  it("S-018 đầu vào/quyền: end ≤ start hoặc thiếu cả hai → 422; end null cho stay → 422; id lạ/tổ chức khác → 404; buồng phòng/kế toán → 403; hold hết hạn → HOLD_EXPIRED", async () => {
    const unit = await freshUnit();
    const s1 = await booking(unit, "2027-01-10", "2027-01-12");
    const code = async (who: Actor, input: Parameters<typeof resizeAllocation>[1]) =>
      (await failed(runAs(h.t, who, (ctx) => resizeAllocation(ctx, input)))).code;
    expect(await code(h.manager, { allocationId: s1.allocationId, end: loc("2027-01-10T14:00") })).toBe(
      "VALIDATION_FAILED",
    );
    expect(await code(h.manager, { allocationId: s1.allocationId, end: loc("2027-01-10T13:00") })).toBe(
      "VALIDATION_FAILED",
    );
    expect(await code(h.manager, { allocationId: s1.allocationId })).toBe("VALIDATION_FAILED");
    expect(await code(h.manager, { allocationId: s1.allocationId, end: null })).toBe("VALIDATION_FAILED");
    expect(await code(h.manager, { allocationId: randomUUID(), end: loc("2027-01-13T12:00") })).toBe(
      "NOT_FOUND",
    );
    expect(await code(h.ownerOther, { allocationId: s1.allocationId, end: loc("2027-01-13T12:00") })).toBe(
      "NOT_FOUND",
    );
    expect(await code(h.housekeeping, { allocationId: s1.allocationId, end: loc("2027-01-13T12:00") })).toBe(
      "FORBIDDEN",
    );
    expect(await code(h.accountant, { allocationId: s1.allocationId, end: loc("2027-01-13T12:00") })).toBe(
      "FORBIDDEN",
    );
    const stale = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${stale}, ${h.org.orgId}, ${h.org.propertyId}, ${await freshUnit()}, 'hold', '[2027-03-01T00:00:00Z,2027-03-02T00:00:00Z)'::tstzrange, '2026-01-01T00:00:00Z')`.execute(
      h.t.admin,
    );
    expect(await code(h.manager, { allocationId: stale, end: loc("2027-03-03T12:00") })).toBe("HOLD_EXPIRED");
    const same = await sql<{
      during: string;
    }>`select during::text from allocations where id = ${s1.allocationId}`.execute(h.t.admin);
    expect(same.rows[0]?.during).toContain("2027-01-10 07:00:00+00"); // 14:00 giờ VN, không đổi
  });

  it("S-018 ca đua (INV-I1): resize gia hạn đồng thời với hold khác vào đúng khoảng gia hạn → đúng một bên thắng, không allocation active nào chồng nhau", async () => {
    for (let round = 0; round < 6; round++) {
      const unit = await freshUnit();
      const s1 = await booking(unit, "2027-04-01", "2027-04-03");
      const [rz, hd] = await Promise.all([
        runAs(h.t, h.manager, (ctx) =>
          resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2027-04-04T12:00") }),
        ),
        runAs(h.t, h.frontDesk2, (ctx) =>
          createHold(ctx, {
            unitId: unit,
            during: { start: loc("2027-04-03T14:00"), end: loc("2027-04-04T10:00") },
            ttlMinutes: 60,
          }),
        ),
      ]);
      const wins = [rz, hd].filter((r) => r.status === "committed").length;
      expect(wins, `vòng ${round}`).toBe(1);
      const loser = [rz, hd].find((r) => r.status === "failed");
      expect(loser?.status === "failed" && loser.problem.code).toBe("ROOM_UNAVAILABLE");
      const overlaps = await count(sql<{ n: number }>`
        select count(*)::int as n from allocations a join allocations b
          on a.organization_id = b.organization_id and a.unit_id = b.unit_id and a.id < b.id and a.active and b.active and a.during && b.during
        where a.unit_id = ${unit}`);
      expect(overlaps).toBe(0);
    }
  });

  it("S-018 ca đua: hai resize ngược chiều vào cùng khoảng trống (kéo dài s1 / kéo sớm r2) → đúng một bên thắng; bên thua là booking xác nhận → EXTENSION_CONFLICT", async () => {
    const unit = await freshUnit();
    const s1 = await booking(unit, "2027-05-01", "2027-05-03"); // kết thúc 03/05 12:00
    const r2 = await booking(unit, "2027-05-03", "2027-05-05"); // bắt đầu 03/05 14:00 — khe trống 12:00–14:00
    const [a, b] = await Promise.all([
      runAs(h.t, h.manager, (ctx) =>
        resizeAllocation(ctx, { allocationId: s1.allocationId, end: loc("2027-05-03T13:30") }),
      ),
      runAs(h.t, h.manager, (ctx) =>
        resizeAllocation(ctx, { allocationId: r2.allocationId, start: loc("2027-05-03T12:30") }),
      ),
    ]);
    expect([a, b].filter((r) => r.status === "committed")).toHaveLength(1);
    const loser = [a, b].find((r) => r.status === "failed");
    expect(loser?.status === "failed" && loser.problem.code).toBe("ROOM_UNAVAILABLE");
    expect(loser?.status === "failed" && loser.problem.exception_id).toBeTruthy();
    const open = await sql<{ type: string }>`
      select type from exceptions where allocation_id in (${s1.allocationId}, ${r2.allocationId}) and status = 'open'`.execute(
      h.t.admin,
    );
    expect(open.rows).toEqual([{ type: "EXTENSION_CONFLICT" }]);
  });
});

describe("SPEC-inventory S-019 hợp đồng không thời hạn (khoảng mở)", () => {
  it("S-019: hold chồng hợp đồng mở → ROOM_UNAVAILABLE; sau resizeAllocation đặt end = 31/12 24:00, giữ từ 01/01 trở đi → thành công; sát biên [) và trước biên 1 phút", async () => {
    const unit = await freshUnit();
    const lease = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${lease}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'lease', 'lease', ${randomUUID()}, '[2026-11-01T00:00:00+07,)'::tstzrange)`.execute(
      h.t.admin,
    );
    const hold = (start: string, end: string) =>
      runAs(h.t, h.frontDesk, (ctx) =>
        createHold(ctx, { unitId: unit, during: { start: loc(start), end: loc(end) }, ttlMinutes: 15 }),
      );
    expect((await failed(hold("2027-03-10T14:00", "2027-03-11T12:00"))).code).toBe("ROOM_UNAVAILABLE");

    // Báo trả: đặt end = 31/12 24:00. Lễ tân không được đổi allocation hợp đồng (lease.manage).
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            resizeAllocation(ctx, { allocationId: lease, end: loc("2027-01-01T00:00") }),
          ),
        )
      ).code,
    ).toBe("FORBIDDEN");
    const r = await okAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, { allocationId: lease, end: loc("2027-01-01T00:00") }),
    );
    expect(r.end).toBe(loc("2027-01-01T00:00").toISOString());
    expect((await failed(hold("2026-12-31T23:59", "2027-01-01T12:00"))).code).toBe("ROOM_UNAVAILABLE"); // trước biên 1 phút
    expect((await hold("2027-01-01T00:00", "2027-01-01T12:00")).status).toBe("committed"); // sát biên
    expect((await hold("2027-03-10T14:00", "2027-03-11T12:00")).status).toBe("committed");

    // Mở lại khoảng mở khi không còn gì chắn: chắn bởi hold → ROOM_UNAVAILABLE (không exception_id), không chắn thì được.
    const reopenBlocked = await failed(
      runAs(h.t, h.manager, (ctx) => resizeAllocation(ctx, { allocationId: lease, end: null })),
    );
    expect(reopenBlocked.code).toBe("ROOM_UNAVAILABLE");
    expect(reopenBlocked.exception_id).toBeUndefined();
    const lone = await freshUnit();
    const leaseLone = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${leaseLone}, ${h.org.orgId}, ${h.org.propertyId}, ${lone}, 'lease', 'lease', ${randomUUID()}, '[2026-11-01T00:00:00+07,2027-01-01T00:00:00+07)'::tstzrange)`.execute(
      h.t.admin,
    );
    const reopened = await okAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, { allocationId: leaseLone, end: null }),
    );
    expect(reopened.end).toBeNull();
    const up = await sql<{
      open: boolean;
    }>`select upper_inf(during) as open from allocations where id = ${leaseLone}`.execute(h.t.admin);
    expect(up.rows[0]?.open).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------- S-020
describe("SPEC-inventory S-020 hợp đồng hết hạn nhưng chưa bàn giao trả (searchAvailability + ROOM_OCCUPIED)", () => {
  async function leaseEnded(opts: { overstay: boolean }) {
    const unit = await freshUnit({ code: `L${String(++seq).padStart(3, "0")}` });
    const alloc = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${alloc}, ${h.org.orgId}, ${h.org.propertyId}, ${unit}, 'lease', 'lease', ${randomUUID()},
                      '[2026-11-01T00:00:00+07,2027-01-01T00:00:00+07)'::tstzrange)`.execute(h.t.admin);
    if (opts.overstay)
      await sql`insert into exceptions (id, organization_id, property_id, type, allocation_id)
                values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, 'LEASE_OVERSTAY', ${alloc})`.execute(
        h.t.admin,
      );
    return { unit, alloc };
  }
  const q = { start: loc("2027-01-02T14:00"), end: loc("2027-01-03T12:00") };

  it("S-020: khi LEASE_OVERSTAY còn mở → searchAvailability loại phòng, createHold → 409 ROOM_OCCUPIED, phòng cùng hợp đồng hết hạn nhưng không quá hạn vẫn bán được", async () => {
    const stuck = await leaseEnded({ overstay: true });
    const free = await leaseEnded({ overstay: false });
    const ids = async (actor: Actor) =>
      (await searchAvailability(h.t.runtime, actor, { propertyId: h.org.propertyId, ...q })).rooms.map(
        (r) => r.unitId,
      );
    const listed = await ids(h.frontDesk);
    expect(listed).not.toContain(stuck.unit);
    expect(listed).toContain(free.unit);
    expect(
      (
        await failed(
          runAs(h.t, h.frontDesk, (ctx) =>
            createHold(ctx, { unitId: stuck.unit, during: { start: q.start, end: q.end }, ttlMinutes: 15 }),
          ),
        )
      ).code,
    ).toBe("ROOM_OCCUPIED");
    expect(
      (
        await runAs(h.t, h.frontDesk, (ctx) =>
          createHold(ctx, { unitId: free.unit, during: { start: q.start, end: q.end }, ttlMinutes: 15 }),
        )
      ).status,
    ).toBe("committed");

    // Đóng ngoại lệ (người đã trả phòng) → phòng bán được lại và hold nhận được.
    await sql`update exceptions set status = 'resolved', resolution = 'moved_out', resolved_by = ${h.manager.membershipId}, resolved_at = now()
              where allocation_id = ${stuck.alloc}`.execute(h.t.admin);
    expect(await ids(h.frontDesk)).toContain(stuck.unit);
    expect(
      (
        await runAs(h.t, h.frontDesk, (ctx) =>
          createHold(ctx, { unitId: stuck.unit, during: { start: q.start, end: q.end }, ttlMinutes: 15 }),
        )
      ).status,
    ).toBe("committed");
  });

  it("S-020: check-in booking đã xác nhận từ trước vào phòng còn LEASE_OVERSTAY mở → 409 ROOM_OCCUPIED; đóng ngoại lệ thì vào lại được tới bước kiểm phòng sẵn sàng", async () => {
    const stuck = await leaseEnded({ overstay: false });
    const b = await booking(stuck.unit, "2027-01-02", "2027-01-03"); // xác nhận khi hợp đồng còn hạn tới 01/01 00:00
    await sql`insert into exceptions (id, organization_id, property_id, type, allocation_id)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, 'LEASE_OVERSTAY', ${stuck.alloc})`.execute(
      h.t.admin,
    );
    const guest = [
      { fullName: "Võ Văn Em", phone: "0100008888", docType: "cccd" as const, docNumber: "001200000003" },
    ];
    const go = () =>
      runAs(h.t, h.frontDesk, (ctx) =>
        checkIn(ctx, pii, { reservationId: b.reservationId, guests: guest, now: loc("2027-01-02T15:00") }),
      );
    expect((await failed(go())).code).toBe("ROOM_OCCUPIED");
    await sql`update exceptions set status = 'resolved', resolution = 'moved_out', resolved_by = ${h.manager.membershipId}, resolved_at = now()
              where allocation_id = ${stuck.alloc}`.execute(h.t.admin);
    expect((await go()).status).toBe("committed");
  });

  it("S-020 searchAvailability: loại phòng out_of_service, hold CÒN hạn, block, stay chồng; hold hết hạn không loại; lọc sức chứa/loại phòng; sát biên [) vẫn trống", async () => {
    const floor = await newFloor();
    const [held, expired, blocked, stayed, oos, free] = [
      await freshUnit({ floorId: floor }),
      await freshUnit({ floorId: floor }),
      await freshUnit({ floorId: floor }),
      await freshUnit({ floorId: floor }),
      await freshUnit({ floorId: floor }),
      await freshUnit({ floorId: floor }),
    ];
    const range = { start: loc("2027-02-20T14:00"), end: loc("2027-02-21T12:00") };
    await okAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: held, during: range, ttlMinutes: 60 }));
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${expired}, 'hold', ${`[${range.start.toISOString()},${range.end.toISOString()})`}::tstzrange, '2026-01-01T00:00:00Z')`.execute(
      h.t.admin,
    );
    const blk = await okAs(h.t, h.manager, (ctx) =>
      proposeBlock(ctx, { unitId: blocked, period: range, reason: "Sửa" }),
    );
    await okAs(h.t, h.manager, (ctx) => approveBlock(ctx, blk.blockId));
    await booking(stayed, "2027-02-20", "2027-02-21");
    await okAs(h.t, h.manager, (ctx) =>
      setUnitAvailability(ctx, { unitId: oos, availability: "out_of_service", reason: "Hỏng" }),
    );
    // Allocation kết thúc đúng lúc khoảng tìm bắt đầu: không chồng.
    const edge = await freshUnit({ floorId: floor });
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${edge}, 'stay', ${`[2027-02-19T14:00:00+07,${range.start.toISOString()})`}::tstzrange)`.execute(
      h.t.admin,
    );

    const res = await searchAvailability(h.t.runtime, h.housekeeping, {
      propertyId: h.org.propertyId,
      ...range,
    });
    const mine = res.rooms
      .map((r) => r.unitId)
      .filter((id) => [held, expired, blocked, stayed, oos, free, edge].includes(id));
    expect(mine.sort()).toEqual([expired, free, edge].sort());
    // Lọc sức chứa: 3 khách > sức chứa 2 → không có phòng nào của loại này.
    expect(
      (
        await searchAvailability(h.t.runtime, h.manager, {
          propertyId: h.org.propertyId,
          ...range,
          guests: 3,
        })
      ).rooms,
    ).toEqual([]);
    expect(
      (
        await searchAvailability(h.t.runtime, h.manager, {
          propertyId: h.org.propertyId,
          ...range,
          guests: 2,
          roomTypeId: h.org.roomTypeId,
        })
      ).rooms.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await searchAvailability(h.t.runtime, h.manager, {
          propertyId: h.org.propertyId,
          ...range,
          roomTypeId: randomUUID(),
        })
      ).rooms,
    ).toEqual([]);
  });

  it("S-020 đầu vào/quyền: end ≤ start, ngày không hợp lệ, guests 0/51 → 422; tổ chức khác → 404; tenant không có quyền", async () => {
    const base = { propertyId: h.org.propertyId, start: q.start, end: q.end };
    expect(await errCode(searchAvailability(h.t.runtime, h.manager, { ...base, end: q.start }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await errCode(searchAvailability(h.t.runtime, h.manager, { ...base, start: new Date("x") }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await errCode(searchAvailability(h.t.runtime, h.manager, { ...base, guests: 0 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await errCode(searchAvailability(h.t.runtime, h.manager, { ...base, guests: 51 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await errCode(searchAvailability(h.t.runtime, h.ownerOther, base))).toBe("NOT_FOUND");
    expect(
      await errCode(searchAvailability(h.t.runtime, h.manager, { ...base, propertyId: "không-phải-uuid" })),
    ).toBe("NOT_FOUND");
    const tenant = await seedMember(h.t, h.org, "tenant", { properties: [], name: "Người thuê" });
    expect(await errCode(searchAvailability(h.t.runtime, tenant, base))).toBe("FORBIDDEN");
  });
});

// ------------------------------------------------------------------------------------------------------------- S-021
describe("SPEC-inventory S-021 lịch phòng theo cơ sở/tầng/loại (getCalendar)", () => {
  const FROM = "2026-11-15";
  const TO = "2026-11-21";
  let floor2: string;
  let floor3: string;
  let typeB: string;
  let u: { hold: string; stay: string; block: string; lease: string; other: string };
  let stayBooked: Booked;

  beforeAll(async () => {
    floor2 = await newFloor("Tầng 2", 20);
    floor3 = await newFloor("Tầng 3", 30);
    typeB = randomUUID();
    await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
              values (${typeB}, ${h.org.orgId}, ${h.org.propertyId}, 'DLX', 'Cao cấp', 3)`.execute(h.t.admin);
    u = {
      hold: await freshUnit({ floorId: floor2, code: "C201", status: "dirty" }),
      stay: await freshUnit({ floorId: floor2, code: "C202" }),
      block: await freshUnit({ floorId: floor2, code: "C203", roomTypeId: typeB }),
      lease: await freshUnit({ floorId: floor2, code: "C204", roomTypeId: typeB }),
      other: await freshUnit({ floorId: floor3, code: "C301" }),
    };
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: u.hold,
        during: { start: loc("2026-11-16T14:00"), end: loc("2026-11-17T12:00") },
        ttlMinutes: 60,
      }),
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${u.hold}, 'hold', '[2026-11-19T14:00:00+07,2026-11-20T12:00:00+07)'::tstzrange, '2026-01-01T00:00:00Z')`.execute(
      h.t.admin,
    );
    stayBooked = await booking(u.stay, "2026-11-17", "2026-11-19", { booker: "Phạm Thị Dung" });
    // Block kết thúc đúng lúc `from` (không hiện) và block nằm trong khoảng xem (hiện).
    for (const [s, e] of [
      ["2026-11-14T08:00", "2026-11-15T00:00"],
      ["2026-11-18T08:00", "2026-11-19T17:00"],
    ] as const) {
      const b = await okAs(h.t, h.manager, (ctx) =>
        proposeBlock(ctx, {
          unitId: u.block,
          period: { start: loc(s), end: loc(e) },
          reason: "Thay bình nóng lạnh",
        }),
      );
      await okAs(h.t, h.manager, (ctx) => approveBlock(ctx, b.blockId));
    }
    await sql`update units set availability = 'out_of_service', availability_reason = 'Hỏng' where id = ${u.block}`.execute(
      h.t.admin,
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${randomUUID()}, ${h.org.orgId}, ${h.org.propertyId}, ${u.lease}, 'lease', 'lease', ${randomUUID()}, '[2026-11-01T00:00:00+07,)'::tstzrange)`.execute(
      h.t.admin,
    );
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: u.other,
        during: { start: loc("2026-11-16T14:00"), end: loc("2026-11-17T12:00") },
        ttlMinutes: 60,
      }),
    );
  });

  const cal = (actor: Actor, extra: Partial<Parameters<typeof getCalendar>[2]> = {}) =>
    getCalendar(h.t.runtime, actor, {
      propertyId: h.org.propertyId,
      from: FROM,
      to: TO,
      floorId: floor2,
      ...extra,
    });

  it("S-021: lọc tầng 2 → chỉ phòng tầng 2; mỗi phòng có đoạn {kind, nguồn, trạng thái nguồn, khoảng theo giờ địa phương}, vệ sinh và khả dụng; hold hết hạn và đoạn kết thúc đúng lúc `from` không hiện", async () => {
    const c = await cal(h.manager);
    expect(c).toMatchObject({
      propertyId: h.org.propertyId,
      timezone: "Asia/Ho_Chi_Minh",
      from: FROM,
      to: TO,
      nextCursor: null,
    });
    expect(c.rooms.map((r) => r.code)).toEqual(["C201", "C202", "C203", "C204"]);
    const by = (code: string) => c.rooms.find((r) => r.code === code);
    expect(by("C201")).toMatchObject({
      housekeeping: "dirty",
      availability: "active",
      floorName: expect.stringContaining("Tầng 2"),
    });
    expect(by("C201")?.segments.map((s) => [s.kind, s.startLocal, s.endLocal])).toEqual([
      ["hold", "2026-11-16T14:00", "2026-11-17T12:00"],
    ]);
    expect(by("C202")?.segments).toEqual([
      expect.objectContaining({
        kind: "stay",
        sourceType: "stay",
        sourceStatus: "expected",
        allocationId: stayBooked.allocationId,
        startLocal: "2026-11-17T14:00",
        endLocal: "2026-11-19T12:00",
        overdue: false,
      }),
    ]);
    expect(by("C203")).toMatchObject({ availability: "out_of_service", roomTypeName: "Cao cấp" });
    expect(by("C203")?.segments.map((s) => [s.kind, s.sourceStatus, s.startLocal, s.endLocal])).toEqual([
      ["block", "approved", "2026-11-18T08:00", "2026-11-19T17:00"],
    ]);
    expect(by("C204")?.segments.map((s) => [s.kind, s.endLocal, s.end])).toEqual([["lease", null, null]]);
  });

  it("S-021: housekeeping/maintenance nhận cùng lịch nhưng KHÔNG có tên khách và số tiền (khoá vắng hẳn, không null); lễ tân/kế toán có tên, tiền theo money.read", async () => {
    const stripped = await cal(h.housekeeping);
    expect(stripped.rooms.map((r) => r.code)).toEqual(["C201", "C202", "C203", "C204"]);
    for (const actor of [h.housekeeping, await seedMember(h.t, h.org, "maintenance", { name: "Kỹ thuật" })]) {
      for (const r of (await cal(actor)).rooms)
        for (const s of r.segments) {
          expect("guestName" in s).toBe(false);
          expect("roomTotal" in s).toBe(false);
        }
    }
    const dbTotal = (
      await sql<{
        t: string;
      }>`select room_total::text as t from reservation_items where reservation_id = ${stayBooked.reservationId}`.execute(
        h.t.admin,
      )
    ).rows[0]?.t;
    for (const actor of [h.frontDesk, h.accountant, h.manager]) {
      const seg = (await cal(actor)).rooms.find((r) => r.code === "C202")?.segments[0];
      expect(seg).toMatchObject({ guestName: "Phạm Thị Dung", roomTotal: Number(dbTotal) });
    }
    expect(Number(dbTotal)).toBeGreaterThan(0);
  });

  it("S-021: lọc loại phòng; lọc tầng không có phòng → rooms rỗng; phân trang theo phòng (limit/cursor) liền mạch không trùng không sót", async () => {
    expect((await cal(h.manager, { roomTypeId: typeB })).rooms.map((r) => r.code)).toEqual(["C203", "C204"]);
    expect((await cal(h.manager, { floorId: randomUUID() })).rooms).toEqual([]);
    const p1 = await cal(h.manager, { limit: 3 });
    expect(p1.rooms.map((r) => r.code)).toEqual(["C201", "C202", "C203"]);
    expect(p1.nextCursor).toBe("3");
    const p2 = await cal(h.manager, { limit: 3, ...(p1.nextCursor ? { cursor: p1.nextCursor } : {}) });
    expect(p2.rooms.map((r) => r.code)).toEqual(["C204"]);
    expect(p2.nextCursor).toBeNull();
    expect(await errCode(cal(h.manager, { cursor: "abc" }))).toBe("VALIDATION_FAILED");
    expect(await errCode(cal(h.manager, { cursor: "-1" }))).toBe("VALIDATION_FAILED");
  });

  it("S-021 ca biên: khoảng xem tối đa 62 ngày (63 → 422), to ≤ from và ngày lịch không tồn tại → 422; đúng 62 ngày được", async () => {
    expect((await cal(h.manager, { from: "2026-11-01", to: "2027-01-02" })).rooms).toHaveLength(4); // 62 ngày
    expect(await errCode(cal(h.manager, { from: "2026-11-01", to: "2027-01-03" }))).toBe("VALIDATION_FAILED");
    expect(await errCode(cal(h.manager, { from: TO, to: FROM }))).toBe("VALIDATION_FAILED");
    expect(await errCode(cal(h.manager, { from: FROM, to: FROM }))).toBe("VALIDATION_FAILED");
    expect(await errCode(cal(h.manager, { from: "2026-02-30", to: TO }))).toBe("VALIDATION_FAILED");
  });

  it("S-021 ca biên rỗng/múi giờ/phạm vi: cơ sở chưa có phòng → rooms [] (không lỗi); giờ địa phương theo múi giờ CỦA CƠ SỞ; lễ tân ngoài phạm vi cơ sở → NOT_FOUND (không lộ cơ sở); tổ chức khác → NOT_FOUND", async () => {
    const empty = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${empty}, ${h.org.orgId}, 'Cơ sở trống', 'hotel')`.execute(
      h.t.admin,
    );
    const e = await getCalendar(h.t.runtime, h.owner, { propertyId: empty, from: FROM, to: TO });
    expect(e).toMatchObject({ rooms: [], nextCursor: null });
    expect(
      await errCode(getCalendar(h.t.runtime, h.frontDesk, { propertyId: empty, from: FROM, to: TO })),
    ).toBe("NOT_FOUND");
    expect(
      await errCode(
        getCalendar(h.t.runtime, h.ownerOther, { propertyId: h.org.propertyId, from: FROM, to: TO }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await errCode(getCalendar(h.t.runtime, h.owner, { propertyId: randomUUID(), from: FROM, to: TO })),
    ).toBe("NOT_FOUND");

    const ny = randomUUID();
    const nyFloor = randomUUID();
    const nyUnit = randomUUID();
    await sql`insert into properties (id, organization_id, name, template, timezone) values (${ny}, ${h.org.orgId}, 'Cơ sở NY', 'hotel', 'America/New_York')`.execute(
      h.t.admin,
    );
    await sql`insert into floors (id, organization_id, property_id, name) values (${nyFloor}, ${h.org.orgId}, ${ny}, 'T1')`.execute(
      h.t.admin,
    );
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${nyUnit}, ${h.org.orgId}, ${ny}, ${nyFloor}, 'N1')`.execute(
      h.t.admin,
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during, expires_at)
              values (${randomUUID()}, ${h.org.orgId}, ${ny}, ${nyUnit}, 'hold', '[2026-11-20T19:00:00Z,2026-11-21T17:00:00Z)'::tstzrange, '2099-01-01T00:00:00Z')`.execute(
      h.t.admin,
    );
    const n = await getCalendar(h.t.runtime, h.owner, {
      propertyId: ny,
      from: "2026-11-20",
      to: "2026-11-22",
    });
    expect(n.timezone).toBe("America/New_York");
    expect(n.rooms[0]?.segments[0]).toMatchObject({
      startLocal: "2026-11-20T14:00",
      endLocal: "2026-11-21T12:00",
    });
    expect(n.rooms[0]?.roomTypeId).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------- S-023
describe("SPEC-inventory S-023 audit + outbox cùng transaction cho mọi command của module (INV-G6)", () => {
  /** Chạy một command; commit → đúng 1 audit + 1 outbox của hành động chính, cùng correlation_id và command_id. */
  async function expectEvidence<T>(
    actor: Actor,
    fn: Parameters<typeof runAs<T>>[2],
    audit: string,
    event: string,
    extraEvents: string[] = [],
  ) {
    const r = await runAs(h.t, actor, fn);
    if (r.status !== "committed") throw new Error(`${audit}: ${r.problem.code}`);
    const ev = await evidence(r.commandId);
    expect(
      ev.audit.filter((a) => a.action === audit),
      `audit ${audit}`,
    ).toHaveLength(1);
    expect(
      ev.outbox.filter((o) => o.event_type === event),
      `outbox ${event}`,
    ).toHaveLength(1);
    for (const x of extraEvents) expect(ev.outbox.map((o) => o.event_type)).toContain(x);
    for (const row of [...ev.audit, ...ev.outbox]) expect(row.correlation_id).toBe("test-corr");
    return r;
  }

  it("S-023 commit: createHold, releaseHold, confirmHold, moveAllocation, resizeAllocation, requestBlock, approveBlock, endBlock, setUnitAvailability — mỗi lệnh một audit + một outbox cùng correlation_id", async () => {
    const during = { start: loc("2027-07-01T14:00"), end: loc("2027-07-02T12:00") };
    const u = await freshUnit();
    const held = await expectEvidence(
      h.frontDesk,
      (ctx) => createHold(ctx, { unitId: u, during, ttlMinutes: 60 }),
      "allocation.held",
      "allocation.held",
    );
    await expectEvidence(
      h.frontDesk,
      (ctx) => releaseHold(ctx, held.data.allocationId),
      "allocation.released",
      "allocation.released",
    );
    const u2 = await freshUnit();
    const h2 = await okAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: u2, during, ttlMinutes: 60 }));
    await expectEvidence(
      h.frontDesk,
      (ctx) => confirmHold(ctx, h2.allocationId, "stay"),
      "allocation.confirmed",
      "allocation.confirmed",
    );
    // Chuyển phòng/gia hạn trên booking thật.
    const from = await freshUnit();
    const to = await freshUnit();
    const b = await booking(from, "2027-07-10", "2027-07-12");
    await expectEvidence(
      h.manager,
      (ctx) => resizeAllocation(ctx, { allocationId: b.allocationId, end: loc("2027-07-12T14:00") }),
      "allocation.resized",
      "allocation.resized",
    );
    await expectEvidence(
      h.frontDesk,
      (ctx) =>
        moveAllocation(ctx, {
          allocationId: b.allocationId,
          toUnitId: to,
          at: loc("2027-07-11T10:00"),
          reason: "Khách đổi phòng",
        }),
      "allocation.moved",
      "allocation.moved",
      ["housekeeping.task_created"],
    );
    // Block.
    const bu = await freshUnit();
    const blk = await expectEvidence(
      h.manager,
      (ctx) => proposeBlock(ctx, { unitId: bu, period: during, reason: "Sửa vòi" }),
      "block.requested",
      "block.requested",
    );
    await expectEvidence(
      h.manager,
      (ctx) => approveBlock(ctx, blk.data.blockId),
      "block.approved",
      "block.approved",
    );
    await expectEvidence(h.manager, (ctx) => endBlock(ctx, blk.data.blockId), "block.ended", "block.ended");
    await expectEvidence(
      h.manager,
      (ctx) => setUnitAvailability(ctx, { unitId: bu, availability: "out_of_service", reason: "Sơn lại" }),
      "unit.availability_changed",
      "unit.availability_changed",
    );
  });

  it("S-023 lỗi: createHold chồng (23P01), moveAllocation sang phòng bận, resize bị chắn → không audit thành công và không outbox của lệnh đó (chỉ command.denied); allocation không đổi", async () => {
    const during = { start: loc("2027-08-01T14:00"), end: loc("2027-08-02T12:00") };
    const busy = await freshUnit();
    await okAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: busy, during, ttlMinutes: 60 }));
    const n0 = await count(
      sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${busy}`,
    );
    const dup = await runAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, { unitId: busy, during, ttlMinutes: 60 }),
    );
    if (dup.status !== "failed") throw new Error("lẽ ra bị từ chối");
    const ev = await evidence(dup.commandId);
    expect(ev.audit).toEqual([]);
    expect(ev.outbox).toEqual([]);
    expect(ev.denied.map((a) => a.action)).toEqual(["command.denied"]);
    expect(
      await count(sql<{ n: number }>`select count(*)::int as n from allocations where unit_id = ${busy}`),
    ).toBe(n0);

    const src = await freshUnit();
    const b = await booking(src, "2027-08-10", "2027-08-12");
    const target = await freshUnit();
    await okAs(h.t, h.frontDesk, (ctx) =>
      createHold(ctx, {
        unitId: target,
        during: { start: loc("2027-08-11T14:00"), end: loc("2027-08-12T12:00") },
        ttlMinutes: 60,
      }),
    );
    const mv = await runAs(h.t, h.frontDesk, (ctx) =>
      moveAllocation(ctx, {
        allocationId: b.allocationId,
        toUnitId: target,
        at: loc("2027-08-11T10:00"),
        reason: "Đổi",
      }),
    );
    if (mv.status !== "failed") throw new Error("lẽ ra bị từ chối");
    const evMv = await evidence(mv.commandId);
    expect(evMv.audit).toEqual([]);
    expect(evMv.outbox).toEqual([]);
    const still = await sql<{
      active: boolean;
      unit_id: string;
    }>`select active, unit_id from allocations where id = ${b.allocationId}`.execute(h.t.admin);
    expect(still.rows).toEqual([{ active: true, unit_id: src }]);

    const rz = await runAs(h.t, h.manager, (ctx) =>
      resizeAllocation(ctx, { allocationId: b.allocationId, end: loc("2027-08-13T12:00") }),
    );
    expect(rz.status).toBe("committed"); // đối chứng: không bị chắn thì có đủ bằng chứng
    const evRz = await evidence(rz.commandId);
    expect(evRz.audit.map((a) => a.action)).toEqual(["allocation.resized"]);
  });
});
