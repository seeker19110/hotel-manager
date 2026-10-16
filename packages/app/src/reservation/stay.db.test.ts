// PLAN đợt 3 T-205 — nhận phòng trên Postgres thật (SPEC-reservation-stay S-012, S-013, S-014, S-015, S-016 b, S-025, Q-08, Q-11;
// ERD `stays`, `identity_documents`; INV-G1, INV-I1). Cơ sở `hotel`: nhận 14:00 / trả 12:00, giờ chốt ngày 04:00, UTC+7 (fixture SPEC).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { executeCommand } from "../pipeline/command.ts";
import { openShift } from "../shifts/shifts.ts";
import { setRatePlan } from "./rates.ts";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  holdReservation,
  markNoShow,
} from "./reservation.ts";
import { checkIn, type GuestInput, getStay, walkIn } from "./stay.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let F2: Actor;
let K: Actor;
let H: Actor;
let OB: Actor;
let deps: HttpDeps;
const users: Record<string, string> = {};

type Problem = {
  code: string;
  status: number;
  errors?: { field: string; code: string }[];
  alternatives?: { unit_id: string; code: string }[];
  from?: string;
  to?: string;
};

const NOW = new Date("2026-10-16T03:00:00Z"); // 10:00 giờ VN
const IN = new Date("2026-10-20T08:00:00Z"); // 20/10 15:00 giờ VN (bd = 20/10)
const iso = (d: Date | string) => new Date(d).toISOString();
const DOC = "079123456789";
const DOC_MASKED = "********6789";

async function member(role: string, org: SeededOrg = A): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  users[role] = user;
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${org.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role, all_properties)
            values (${membership}, ${org.orgId}, ${user}, ${person}, ${role}, ${role === "accountant"})`.execute(
    t.admin,
  );
  if (role !== "accountant") {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${org.orgId}, ${membership}, ${org.propertyId})`.execute(t.admin);
  }
  return resolveActor(t.runtime, { authUserId: user, orgId: org.orgId, twoFactorEnabled: true });
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "stay.test", idempotencyKey: key, payload: { key }, correlationId: "c-stay-test" },
    fn,
  );
}

async function ok<T>(p: Promise<Awaited<ReturnType<typeof run<T>>>>): Promise<T> {
  const r = await p;
  if (r.status !== "committed") throw new Error(JSON.stringify(r.problem));
  return r.data;
}

async function fails(p: Promise<Awaited<ReturnType<typeof run<unknown>>>>): Promise<Problem> {
  const r = await p;
  if (r.status !== "failed") throw new Error("lẽ ra thất bại");
  return r.problem as unknown as Problem;
}

async function pgError(p: PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

async function newRoomType(capacity = 2): Promise<string> {
  const id = randomUUID();
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${`T${id.slice(0, 6)}`}, 'Loại thử', ${capacity})`.execute(
    t.admin,
  );
  await ok(
    run(O, async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId: id,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    })),
  );
  return id;
}

async function newUnit(code: string, typeId: string = A.roomTypeId): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${typeId}, ${`${code}-${id.slice(0, 4)}`})`.execute(
    t.admin,
  );
  return id;
}

const setHk = (unitId: string, status: string) =>
  sql`update units set housekeeping_status = ${status} where id = ${unitId}`.execute(t.admin);

async function setSettings(settings: Record<string, unknown>) {
  await sql`update properties set settings = ${JSON.stringify(settings)}::jsonb where id = ${A.propertyId}`.execute(
    t.admin,
  );
}
const BASE_SETTINGS = { reservation: { confirm_without_payment: true } };

/** Booking đã xác nhận (không kèm tiền — cơ sở bật `confirm_without_payment`, T-204 D-007). */
async function confirmedBooking(unit?: string, arrival = "2026-10-20", departure = "2026-10-22", guests = 2) {
  const unitId = unit ?? (await newUnit("C"));
  const r = await ok(
    run(F, async (ctx) => ({
      data: await createReservation(ctx, {
        booker: { fullName: "Nguyễn Văn A", phone: "0901234567" },
        rooms: [{ unitId, guests }],
        arrivalDate: arrival,
        departureDate: departure,
      }),
    })),
  );
  await ok(run(F, async (ctx) => ({ data: await holdReservation(ctx, { reservationId: r.id, now: NOW }) })));
  const c = await ok(
    run(M, async (ctx) => ({ data: await confirmReservation(ctx, { reservationId: r.id, now: NOW }) })),
  );
  return { reservationId: r.id, unitId, stayId: c.stay_id, itemId: r.items[0]?.id as string };
}

const guest = (over: { [K in keyof GuestInput]?: GuestInput[K] | undefined } = {}): GuestInput => {
  const g: Record<string, unknown> = {
    fullName: "Nguyễn Văn A",
    phone: "0901234567",
    document: { type: "cccd", number: DOC },
    ...over,
  };
  for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k];
  return g as GuestInput;
};

const doCheckIn = (
  actor: Actor,
  reservationId: string,
  guests: GuestInput[] = [guest()],
  now = IN,
  key?: string,
  stayId?: string,
) =>
  run(
    actor,
    async (ctx) => ({
      data: await checkIn(ctx, { reservationId, guests, now, ...(stayId ? { stayId } : {}) }),
    }),
    key,
  );

const doWalkIn = (
  actor: Actor,
  unitId: string,
  departureDate: string,
  now: Date,
  guests: GuestInput[] = [guest()],
  key?: string,
  payment?: Parameters<typeof walkIn>[1]["payment"],
) =>
  run(
    actor,
    async (ctx) => ({
      data: await walkIn(ctx, { unitId, departureDate, guests, now, ...(payment ? { payment } : {}) }),
    }),
    key,
  );

async function rows<T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>): Promise<T[]> {
  return (await q.execute(t.admin)).rows;
}
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>) =>
  (await rows(q))[0] as T;

const stayRow = (id: string) =>
  one(
    sql<{
      status: string;
      checked_in_at: Date | null;
      primary_guest_person_id: string;
      additional_guest_person_ids: string[];
    }>`select status, checked_in_at, primary_guest_person_id, additional_guest_person_ids from stays where id = ${id}`,
  );
const resStatus = async (id: string) =>
  (await one(sql<{ s: string }>`select status as s from reservations where id = ${id}`)).s;
const charges = (stayId: string) =>
  rows(
    sql<{
      business_date: string;
      amount: string;
      kind: string;
      source_type: string;
      revenue_account: string;
    }>`
      select business_date::text, amount::text, kind, source_type, revenue_account from charges
      where stay_id = ${stayId} order by business_date`,
  );
const allocsOf = (unitId: string) =>
  rows(
    sql<{
      kind: string;
      source_type: string | null;
      source_id: string | null;
      active: boolean;
      lo: Date;
      hi: Date;
    }>`
      select kind, source_type, source_id, active, lower(during) as lo, upper(during) as hi
      from allocations where unit_id = ${unitId} order by created_at, id`,
  );
const count = async (table: string) =>
  (
    await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${A.orgId}`,
    )
  ).n;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS nhận phòng", "hotel");
  B = await seedOrg(t.admin, "KS khác", "hotel");
  await sql`update properties set check_in_time = '14:00', check_out_time = '12:00', business_day_cutoff = '04:00'
            where id = ${A.propertyId}`.execute(t.admin);
  await setSettings(BASE_SETTINGS);
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  users.owner = A.ownerAuthUserId;
  OB = await resolveActor(t.runtime, {
    authUserId: B.ownerAuthUserId,
    orgId: B.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
  F2 = await member("front_desk");
  K = await member("accountant");
  H = await member("housekeeping");
  await ok(
    run(O, async (ctx) => ({
      data: await setRatePlan(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 600_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-01-01",
      }),
    })),
  );
  await ok(
    run(F, async (ctx) => ({ data: await openShift(ctx, { propertyId: A.propertyId, openingCash: 0 }) })),
  );
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
  };
});

afterAll(async () => {
  await t.drop();
});

describe("S-012 check-in booking có sẵn", () => {
  it("expected → in_house, booking in_house, giờ nhận thực tế; allocation `stay` liên tục (không khoảng trống/chồng); tiền phòng 2 đêm theo snapshot", async () => {
    const b = await confirmedBooking();
    const before = await allocsOf(b.unitId);
    expect(before).toHaveLength(1);
    const r = await ok(doCheckIn(F, b.reservationId));
    expect(r).toMatchObject({
      status: "in_house",
      stay_id: b.stayId,
      reservation_id: b.reservationId,
      unit_id: b.unitId,
      business_date: "2026-10-20",
      is_foreign: false,
      room_charges: 2,
      room_total: 1_200_000,
    });
    expect(r.guests).toEqual([
      { person_id: expect.any(String), doc_type: "cccd", doc_number_masked: DOC_MASKED },
    ]);
    const s = await stayRow(b.stayId);
    expect(s.status).toBe("in_house");
    expect(iso(s.checked_in_at as Date)).toBe(IN.toISOString());
    expect(s.primary_guest_person_id).toBe(r.guests[0]?.person_id);
    expect(await resStatus(b.reservationId)).toBe("in_house");
    // Đến sau giờ nhận: allocation giữ nguyên [20/10 07:00Z, 22/10 05:00Z) — một dòng, kind stay, đang hiệu lực.
    const a = await allocsOf(b.unitId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "stay", source_type: "stay", source_id: b.stayId, active: true });
    expect(iso(a[0]?.lo as Date)).toBe("2026-10-20T07:00:00.000Z");
    expect(iso(a[0]?.hi as Date)).toBe("2026-10-22T05:00:00.000Z");
    // Q-11: mỗi đêm một khoản tiền phòng, giá theo snapshot.
    expect(await charges(b.stayId)).toEqual([
      {
        business_date: "2026-10-20",
        amount: "600000",
        kind: "room",
        source_type: "stay",
        revenue_account: "REV_ROOM",
      },
      {
        business_date: "2026-10-21",
        amount: "600000",
        kind: "room",
        source_type: "stay",
        revenue_account: "REV_ROOM",
      },
    ]);
    const ev = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from outbox where event_type = 'stay.checked_in' and aggregate_id = ${b.stayId}`,
    );
    expect(ev.n).toBe(1);
  });

  it("đến sớm hơn giờ nhận (10:00): allocation kéo đầu về giờ thực tế, vẫn một dòng liên tục", async () => {
    const b = await confirmedBooking();
    const early = new Date("2026-10-20T03:00:00Z");
    await ok(doCheckIn(F, b.reservationId, [guest()], early));
    const a = await allocsOf(b.unitId);
    expect(a).toHaveLength(1);
    expect(iso(a[0]?.lo as Date)).toBe(early.toISOString());
    expect(iso(a[0]?.hi as Date)).toBe("2026-10-22T05:00:00.000Z");
  });

  it("ranh giới ngày: trước ngày đến và từ ngày đi trở đi → 409 INVALID_TRANSITION; stay vẫn expected", async () => {
    const b = await confirmedBooking();
    // 20/10 03:30 giờ VN còn thuộc ngày kinh doanh 19/10 (giờ chốt 04:00).
    for (const at of ["2026-10-19T20:30:00Z", "2026-10-19T08:00:00Z", "2026-10-22T08:00:00Z"]) {
      expect(await fails(doCheckIn(F, b.reservationId, [guest()], new Date(at)))).toMatchObject({
        code: "INVALID_TRANSITION",
        status: 409,
      });
    }
    expect((await stayRow(b.stayId)).status).toBe("expected");
    // 20/10 04:00 giờ VN = 19/10 21:00Z đã sang ngày kinh doanh 20/10 → nhận được.
    await ok(doCheckIn(F, b.reservationId, [guest()], new Date("2026-10-19T21:00:00Z")));
  });

  it("hai lễ tân check-in cùng booking (khác khoá): đúng một bên thắng, bên kia 409 INVALID_TRANSITION; chỉ một bộ tiền phòng", async () => {
    const b = await confirmedBooking();
    const results = await Promise.all([
      doCheckIn(F, b.reservationId, [guest()], IN, randomUUID()),
      doCheckIn(
        F2,
        b.reservationId,
        [guest({ document: { type: "cccd", number: "079000111222" } })],
        IN,
        randomUUID(),
      ),
    ]);
    const won = results.filter((r) => r.status === "committed");
    const lost = results.filter((r) => r.status === "failed");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as unknown as { problem: Problem }).problem).toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
    expect(await charges(b.stayId)).toHaveLength(2);
    expect((await stayRow(b.stayId)).status).toBe("in_house");
  });

  it("idempotency: cùng khoá → cùng kết quả (replay), không nhận hai lần; cùng khoá khác nội dung → IDEMPOTENCY_CONFLICT", async () => {
    const b = await confirmedBooking();
    const key = randomUUID();
    const first = await doCheckIn(F, b.reservationId, [guest()], IN, key);
    const again = await doCheckIn(F, b.reservationId, [guest()], IN, key);
    expect(first.status).toBe("committed");
    expect(again).toMatchObject({ status: "committed", replayed: true });
    expect((again as { data: unknown }).data).toEqual((first as { data: unknown }).data);
    expect(await charges(b.stayId)).toHaveLength(2);
    // Khác nội dung cùng khoá: `run` băm `payload: { key }` nên dùng executeCommand trực tiếp với payload khác.
    await expect(
      executeCommand(
        t.runtime,
        F,
        { command: "stay.test", idempotencyKey: key, payload: { other: 1 }, correlationId: "c" },
        async () => ({ data: 1 }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("booking draft/held, đã huỷ, no-show → INVALID_TRANSITION (S-011 lần 3: không check-in từ no_show); booking nhiều lần nhận → lần sau 409", async () => {
    const unit = await newUnit("NS");
    const b = await confirmedBooking(unit);
    // Chưa qua ngày đến: no-show lần đầu bị từ chối; sau ngày kinh doanh 20/10 → no_show.
    const late = new Date("2026-10-21T08:00:00Z");
    await ok(
      run(F, async (ctx) => ({
        data: await markNoShow(ctx, { reservationId: b.reservationId, reason: "Khách không đến", now: late }),
      })),
    );
    expect(await fails(doCheckIn(F, b.reservationId, [guest()], IN))).toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
    const c = await confirmedBooking();
    await ok(
      run(F, async (ctx) => ({
        data: await cancelReservation(ctx, {
          reservationId: c.reservationId,
          reason: "Khách đổi ý",
          now: NOW,
        }),
      })),
    );
    expect(await fails(doCheckIn(F, c.reservationId))).toMatchObject({ code: "INVALID_TRANSITION" });
    // draft (chưa giữ phòng)
    const d = await ok(
      run(F, async (ctx) => ({
        data: await createReservation(ctx, {
          booker: { fullName: "K", phone: "0901112223" },
          rooms: [{ unitId: await newUnit("D"), guests: 1 }],
          arrivalDate: "2026-10-20",
          departureDate: "2026-10-21",
        }),
      })),
    );
    expect(await fails(doCheckIn(F, d.id))).toMatchObject({ code: "INVALID_TRANSITION" });
    // lần hai trên booking đã nhận
    const e = await confirmedBooking();
    await ok(doCheckIn(F, e.reservationId));
    expect(await fails(doCheckIn(F, e.reservationId))).toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("S-013 phòng chưa sạch hoặc còn khách", () => {
  it("phòng dirty → 409 ROOM_NOT_READY kèm phòng sạch cùng loại gợi ý; stay vẫn expected, không tiền phòng, không tạo người/giấy tờ", async () => {
    const b = await confirmedBooking();
    const spare = await newUnit("SPARE");
    await setHk(spare, "inspected");
    await setHk(b.unitId, "dirty");
    const persons = await count("persons");
    const docs = await count("identity_documents");
    const p = await fails(doCheckIn(F, b.reservationId));
    expect(p).toMatchObject({ code: "ROOM_NOT_READY", status: 409 });
    expect(p.alternatives?.map((x) => x.unit_id)).toContain(spare);
    expect(p.alternatives?.map((x) => x.unit_id)).not.toContain(b.unitId);
    expect((await stayRow(b.stayId)).status).toBe("expected");
    expect(await resStatus(b.reservationId)).toBe("confirmed");
    expect(await charges(b.stayId)).toHaveLength(0);
    expect(await count("persons")).toBe(persons);
    expect(await count("identity_documents")).toBe(docs);
    // Dọn xong (clean) thì nhận được.
    await setHk(b.unitId, "clean");
    await ok(doCheckIn(F, b.reservationId));
  });

  it("cơ sở bật require_inspected: `clean` chưa đủ, `inspected` mới nhận được", async () => {
    await sql`update properties set require_inspected = true where id = ${A.propertyId}`.execute(t.admin);
    try {
      const b = await confirmedBooking();
      await setHk(b.unitId, "clean");
      expect(await fails(doCheckIn(F, b.reservationId))).toMatchObject({ code: "ROOM_NOT_READY" });
      for (const st of ["assigned", "cleaning"]) {
        await setHk(b.unitId, st);
        expect(await fails(doCheckIn(F, b.reservationId))).toMatchObject({ code: "ROOM_NOT_READY" });
      }
      await setHk(b.unitId, "inspected");
      await ok(doCheckIn(F, b.reservationId));
    } finally {
      await sql`update properties set require_inspected = false where id = ${A.propertyId}`.execute(t.admin);
    }
  });

  it("còn lượt ở in_house quá hạn (khách cũ chưa trả) → 409 ROOM_OCCUPIED; stay vẫn expected", async () => {
    const unit = await newUnit("OCC");
    const old = await confirmedBooking(unit, "2026-10-18", "2026-10-19");
    await ok(doCheckIn(F, old.reservationId, [guest()], new Date("2026-10-18T08:00:00Z")));
    const next = await confirmedBooking(unit, "2026-10-19", "2026-10-21");
    // 19/10 15:00 giờ VN: khách cũ (đi 19/10 12:00) chưa check-out.
    const p = await fails(doCheckIn(F2, next.reservationId, [guest()], new Date("2026-10-19T08:00:00Z")));
    expect(p).toMatchObject({ code: "ROOM_OCCUPIED", status: 409 });
    expect((await stayRow(next.stayId)).status).toBe("expected");
    expect(await resStatus(next.reservationId)).toBe("confirmed");
  });

  it("allocation `stay` liên tục sau khi nhận sớm: block không chen vào khoảng đã nhận (EXCLUDE, INV-I1)", async () => {
    const b = await confirmedBooking();
    const range = "[2026-10-20T03:00:00Z,2026-10-20T06:00:00Z)";
    await ok(doCheckIn(F, b.reservationId, [guest()], new Date("2026-10-20T03:00:00Z")));
    const err = await pgError(
      sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, during)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${b.unitId}, 'block', 'block', ${range}::tstzrange)`.execute(
        t.admin,
      ),
    );
    expect(err.code).toBe("23P01");
  });
});

describe("S-014 sức chứa và thông tin khách bắt buộc (Q-08)", () => {
  it("3 khách vào phòng sức chứa 2 → 422 CAPACITY_EXCEEDED, stay vẫn expected", async () => {
    const cap2 = await newRoomType(2);
    const b = await confirmedBooking(await newUnit("CAP", cap2));
    const three = [
      guest(),
      guest({ fullName: "Trần B", document: { type: "cccd", number: "079000000002" } }),
      guest({ fullName: "Lê C", document: { type: "cccd", number: "079000000003" } }),
    ];
    expect(await fails(doCheckIn(F, b.reservationId, three))).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      status: 422,
    });
    expect((await stayRow(b.stayId)).status).toBe("expected");
    // đủ sức chứa (2 khách) → nhận được, người thứ hai nằm ở additional_guest_person_ids
    const r = await ok(doCheckIn(F, b.reservationId, three.slice(0, 2)));
    const s = await stayRow(b.stayId);
    expect(s.additional_guest_person_ids).toEqual([r.guests[1]?.person_id]);
  });

  it("thiếu trường bắt buộc → 422 VALIDATION_FAILED theo trường; không ghi gì", async () => {
    const b = await confirmedBooking();
    const cases: [GuestInput[], string, string][] = [
      [[], "guests", "COUNT"],
      [[guest({ document: undefined })], "guests[0].document", "REQUIRED"],
      [[guest({ phone: undefined })], "guests[0].phone", "REQUIRED"],
      [[guest({ phone: "abc" })], "guests[0].phone", "INVALID"],
      [[guest({ fullName: "   " })], "guests[0].full_name", "INVALID"],
      [[guest({ document: { type: "cccd", number: "12345" } })], "guests[0].document.number", "INVALID"],
      [[guest({ document: { type: "passport", number: "ab" } })], "guests[0].document.number", "INVALID"],
      [[guest({ nationality: "Viet" })], "guests[0].nationality", "INVALID"],
      [[guest(), guest({ fullName: "Trần B", document: undefined })], "guests[1].document", "REQUIRED"],
      [
        [guest(), guest({ fullName: "Trần B", document: { type: "cccd", number: DOC } })],
        "guests[1].document.number",
        "DUPLICATE_GUEST",
      ],
      [[{ personId: randomUUID(), fullName: "X" }], "guests[0].person_id", "PERSON_OR_NAME"],
      [
        [{ personId: randomUUID(), document: { type: "cccd", number: DOC } }],
        "guests[0].person_id",
        "NOT_FOUND",
      ],
    ];
    const docs = await count("identity_documents");
    for (const [guests, field, code] of cases) {
      const p = await fails(doCheckIn(F, b.reservationId, guests));
      expect(p, `${field}/${code}`).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
      expect(p.errors?.[0], `${field}/${code}`).toMatchObject({ field, code });
    }
    expect((await stayRow(b.stayId)).status).toBe("expected");
    expect(await count("identity_documents")).toBe(docs);
  });

  it("khách nước ngoài: cần quốc tịch + hộ chiếu (CCCD bị từ chối); hợp lệ → is_foreign; người đặt dùng lại bằng person_id", async () => {
    const b = await confirmedBooking();
    const foreign = guest({
      fullName: "John Smith",
      nationality: "us",
      document: { type: "cccd", number: DOC },
    });
    expect(await fails(doCheckIn(F, b.reservationId, [foreign]))).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ field: "guests[0].document.type", code: "PASSPORT_REQUIRED" }],
    });
    const r = await ok(
      doCheckIn(F, b.reservationId, [{ ...foreign, document: { type: "passport", number: "C1234567" } }]),
    );
    expect(r.is_foreign).toBe(true);
    expect(r.guests[0]).toMatchObject({ doc_type: "passport", doc_number_masked: "****4567" });
    const p = await one(
      sql<{
        nationality: string;
      }>`select nationality from persons where id = ${r.guests[0]?.person_id as string}`,
    );
    expect(p.nationality.trim()).toBe("US");

    // Người đặt (đã có SĐT) làm đại diện qua person_id, kèm giấy tờ; nhận lại cùng giấy tờ ở booking sau → không nhân bản.
    const c = await confirmedBooking();
    const booker = (
      await one(
        sql<{ p: string }>`select booker_person_id as p from reservations where id = ${c.reservationId}`,
      )
    ).p;
    const r2 = await ok(
      doCheckIn(F, c.reservationId, [
        { personId: booker, document: { type: "cccd", number: "079555666777" } },
      ]),
    );
    expect(r2.guests[0]?.person_id).toBe(booker);
    expect(r2.guests[0]?.doc_number_masked).toBe("********6777");
    const d = await confirmedBooking();
    // Booking khác cùng người: không nhập lại giấy tờ → dùng giấy tờ đã có (không trùng dòng).
    const r3 = await ok(doCheckIn(F, d.reservationId, [{ personId: booker }]));
    expect(r3.guests[0]?.doc_number_masked).toBe("********6777");
    const n = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from identity_documents where person_id = ${booker} and doc_number = '079555666777'`,
    );
    expect(n.n).toBe(1);
  });

  it("không lưu ảnh giấy tờ mặc định: file_id bị từ chối khi store_id_images=false; identity_documents.file_id luôn NULL", async () => {
    const b = await confirmedBooking();
    const p = await fails(
      doCheckIn(F, b.reservationId, [
        guest({ document: { type: "cccd", number: DOC, fileId: randomUUID() } }),
      ]),
    );
    expect(p).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ field: "guests[0].document.file_id", code: "ID_IMAGE_NOT_ALLOWED" }],
    });
    await ok(doCheckIn(F, b.reservationId));
    const withImage = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from identity_documents where organization_id = ${A.orgId} and file_id is not null`,
    );
    expect(withImage.n).toBe(0);
    // Bật store_id_images: file không tồn tại vẫn bị từ chối (NOT_FOUND), không bỏ qua kiểm.
    await setSettings({ ...BASE_SETTINGS, store_id_images: true });
    try {
      const c = await confirmedBooking();
      const q = await fails(
        doCheckIn(F, c.reservationId, [
          guest({ document: { type: "cccd", number: DOC, fileId: randomUUID() } }),
        ]),
      );
      expect(q).toMatchObject({ errors: [{ field: "guests[0].document.file_id", code: "NOT_FOUND" }] });
    } finally {
      await setSettings(BASE_SETTINGS);
    }
  });

  it("PII: số giấy tờ đầy đủ không có trong audit, outbox, kết quả lệnh lưu ở idempotency_keys; CSDL chỉ giữ ở identity_documents", async () => {
    const number = "079987654321";
    const b = await confirmedBooking();
    const key = randomUUID();
    await ok(doCheckIn(F, b.reservationId, [guest({ document: { type: "cccd", number } })], IN, key));
    const leaks = await one(sql<{ a: number; o: number; i: number; d: number }>`
      select (select count(*)::int from audit_events where organization_id = ${A.orgId} and (before::text like ${`%${number}%`} or after::text like ${`%${number}%`})) as a,
             (select count(*)::int from outbox where payload::text like ${`%${number}%`}) as o,
             (select count(*)::int from idempotency_keys where organization_id = ${A.orgId} and response::text like ${`%${number}%`}) as i,
             (select count(*)::int from identity_documents where organization_id = ${A.orgId} and doc_number = ${number}) as d`);
    expect(leaks).toEqual({ a: 0, o: 0, i: 0, d: 1 });
  });
});

describe("S-015 walk-in một bước + S-016 b ngày kinh doanh", () => {
  it("20/10 15:10, 202 trống & inspected, đi 21/10, 1 khách → booking walk_in in_house + stay in_house + allocation [15:10, 21/10 12:00) + 1 đêm 600.000; audit chỉ một sự kiện tạo", async () => {
    const unit = await newUnit("202");
    await setHk(unit, "inspected");
    const at = new Date("2026-10-20T08:10:00Z");
    const r = await ok(doWalkIn(F, unit, "2026-10-21", at));
    expect(r).toMatchObject({
      status: "in_house",
      unit_id: unit,
      business_date: "2026-10-20",
      departure_date: "2026-10-21",
      nights: 1,
      room_total: 600_000,
      room_charges: 1,
      number: expect.stringMatching(/^R-\d+$/),
      payment_id: null,
    });
    const res = await one(
      sql<{
        status: string;
        source: string;
        booker: string;
      }>`select status, source, booker_person_id as booker from reservations where id = ${r.reservation_id}`,
    );
    expect(res).toMatchObject({ status: "in_house", source: "walk_in", booker: r.guests[0]?.person_id });
    expect((await stayRow(r.stay_id)).status).toBe("in_house");
    expect(iso((await stayRow(r.stay_id)).checked_in_at as Date)).toBe(at.toISOString());
    const a = await allocsOf(unit);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "stay", source_type: "stay", source_id: r.stay_id, active: true });
    expect(iso(a[0]?.lo as Date)).toBe(at.toISOString());
    expect(iso(a[0]?.hi as Date)).toBe("2026-10-21T05:00:00.000Z");
    expect(await charges(r.stay_id)).toMatchObject([
      { business_date: "2026-10-20", amount: "600000", kind: "room" },
    ]);
    // Không có bước trung gian: audit/outbox của booking + stay chỉ một sự kiện tạo, không `stay.checked_in`/`reservation.*`.
    const audit = await rows(
      sql<{ action: string }>`select action from audit_events where organization_id = ${A.orgId}
        and entity_type in ('stay', 'reservation') and entity_id in (${r.stay_id}, ${r.reservation_id})`,
    );
    expect(audit.map((x) => x.action)).toEqual(["stay.walk_in"]);
  });

  it("202 đã bị chiếm → 409 ROOM_UNAVAILABLE (có gợi ý) và không tạo gì; phòng dirty → ROOM_NOT_READY và không tạo gì", async () => {
    const unit = await newUnit("BUSY");
    await confirmedBooking(unit, "2026-10-20", "2026-10-22");
    const snapshot = async () => [
      await count("reservations"),
      await count("reservation_items"),
      await count("stays"),
      await count("persons"),
      await count("identity_documents"),
      await count("charges"),
    ];
    const before = await snapshot();
    const p = await fails(doWalkIn(F, unit, "2026-10-21", new Date("2026-10-20T08:10:00Z")));
    expect(p).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    expect(await snapshot()).toEqual(before);

    const dirty = await newUnit("DIRTY");
    await setHk(dirty, "dirty");
    const before2 = await snapshot();
    expect(await fails(doWalkIn(F, dirty, "2026-10-21", new Date("2026-10-20T08:10:00Z")))).toMatchObject({
      code: "ROOM_NOT_READY",
      status: 409,
    });
    expect(await snapshot()).toEqual(before2);
    expect(await allocsOf(dirty)).toHaveLength(0);
  });

  it("hai walk-in cùng lúc vào một phòng: một bên thắng, bên kia 409 ROOM_UNAVAILABLE; một lượt ở in_house", async () => {
    const unit = await newUnit("RACE");
    const at = new Date("2026-10-20T08:10:00Z");
    const results = await Promise.all([
      doWalkIn(F, unit, "2026-10-21", at),
      doWalkIn(F2, unit, "2026-10-21", at, [guest({ document: { type: "cccd", number: "079000999888" } })]),
    ]);
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    const lost = results.find((r) => r.status === "failed") as unknown as { problem: Problem };
    expect(lost.problem).toMatchObject({ code: "ROOM_UNAVAILABLE", status: 409 });
    const n = await one(
      sql<{
        n: number;
      }>`select count(*)::int as n from stays where unit_id = ${unit} and status = 'in_house'`,
    );
    expect(n.n).toBe(1);
  });

  it("S-016 b: walk-in 16/10 01:30 (giờ chốt 04:00), đi 16/10 → đêm đầu 15/10, nights=1, 600.000 (thứ Năm); không lỗi 'ngày đi phải sau ngày đến'", async () => {
    const unit = await newUnit("NIGHT");
    const r = await ok(doWalkIn(F, unit, "2026-10-16", new Date("2026-10-15T18:30:00Z")));
    expect(r).toMatchObject({ business_date: "2026-10-15", nights: 1, room_total: 600_000 });
    expect(await charges(r.stay_id)).toMatchObject([{ business_date: "2026-10-15", amount: "600000" }]);
    const a = await allocsOf(unit);
    expect(iso(a[0]?.lo as Date)).toBe("2026-10-15T18:30:00.000Z");
    expect(iso(a[0]?.hi as Date)).toBe("2026-10-16T05:00:00.000Z");
  });

  it("ranh giới giờ chốt: 03:59 → hôm trước (đi cùng ngày được); đúng 04:00 → ngày mới, đi 16/10 là ngày đi ≤ ngày đến → 422", async () => {
    const u1 = await newUnit("B1");
    await ok(doWalkIn(F, u1, "2026-10-16", new Date("2026-10-15T20:59:00Z")));
    const u2 = await newUnit("B2");
    const p = await fails(doWalkIn(F, u2, "2026-10-16", new Date("2026-10-15T21:00:00Z")));
    expect(p).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    expect(p.errors?.[0]?.field).toBe("departure_date");
    expect(await allocsOf(u2)).toHaveLength(0);
    // 04:00 đi 17/10 → 1 đêm của 16/10.
    const r = await ok(doWalkIn(F, u2, "2026-10-17", new Date("2026-10-15T21:00:00Z")));
    expect(r).toMatchObject({ business_date: "2026-10-16", nights: 1 });
  });

  it("đêm cuối tuần 700.000; vượt 30 đêm → 422; vượt sức chứa → 422 CAPACITY_EXCEEDED; người đại diện thiếu SĐT → 422", async () => {
    const u = await newUnit("WE");
    // 17/10/2026 là thứ Bảy.
    const r = await ok(doWalkIn(F, u, "2026-10-18", new Date("2026-10-17T08:00:00Z")));
    expect(r).toMatchObject({ business_date: "2026-10-17", room_total: 700_000 });
    const u2 = await newUnit("LONG");
    expect(await fails(doWalkIn(F, u2, "2026-12-30", NOW))).toMatchObject({ code: "VALIDATION_FAILED" });
    const cap = await newUnit("CAP2", await newRoomType(2));
    const three = [1, 2, 3].map((i) =>
      guest({ fullName: `Khách ${i}`, document: { type: "cccd", number: `07911111111${i}` } }),
    );
    expect(await fails(doWalkIn(F, cap, "2026-10-21", IN, three))).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      status: 422,
    });
    expect(await fails(doWalkIn(F, cap, "2026-10-21", IN, [guest({ phone: undefined })]))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await allocsOf(cap)).toHaveLength(0);
  });

  it("ứng trước tiền mặt kèm walk-in: payment xác nhận trong cùng transaction; thiếu chứng cứ chuyển khoản → rollback toàn bộ", async () => {
    const u = await newUnit("ADV");
    const r = await ok(
      doWalkIn(F, u, "2026-10-21", IN, [guest()], undefined, {
        kind: "advance",
        method: "cash",
        amount: 200_000,
      }),
    );
    expect(r.payment_id).toEqual(expect.any(String));
    const pay = await one(
      sql<{
        status: string;
        amount: string;
      }>`select status, amount::text from payments where id = ${r.payment_id as string}`,
    );
    expect(pay).toEqual({ status: "confirmed", amount: "200000" });
    const u2 = await newUnit("ADV2");
    const before = await count("reservations");
    const p = await fails(
      doWalkIn(F, u2, "2026-10-21", IN, [guest()], undefined, {
        kind: "advance",
        method: "bank_transfer",
        amount: 200_000,
      }),
    );
    expect(p.status).toBeGreaterThanOrEqual(400);
    expect(await count("reservations")).toBe(before);
    expect(await allocsOf(u2)).toHaveLength(0);
  });

  it("idempotency: cùng khoá → cùng kết quả, một booking; chỉ một khoản tiền phòng", async () => {
    const u = await newUnit("IDEM");
    const key = randomUUID();
    const first = await doWalkIn(F, u, "2026-10-21", IN, [guest()], key);
    const again = await doWalkIn(F, u, "2026-10-21", IN, [guest()], key);
    expect(first.status).toBe("committed");
    expect(again).toMatchObject({ status: "committed", replayed: true });
    expect((again as { data: unknown }).data).toEqual((first as { data: unknown }).data);
    const n = await one(sql<{ n: number }>`select count(*)::int as n from stays where unit_id = ${u}`);
    expect(n.n).toBe(1);
  });
});

describe("ràng buộc CSDL (0026)", () => {
  it("một phòng chỉ một lượt in_house; mỗi đêm một khoản tiền phòng; một giấy tờ một dòng", async () => {
    const u = await newUnit("DB");
    const w = await ok(doWalkIn(F, u, "2026-10-21", IN));
    const other = await seedReservation(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      bookerPersonId: w.guests[0]?.person_id as string,
      unitId: u,
      roomTypeId: A.roomTypeId,
      arrivalDate: "2027-01-10",
      departureDate: "2027-01-11",
    });
    const e1 = await pgError(
      sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id, checked_in_at)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${other.itemId}, ${u}, 'in_house', ${w.guests[0]?.person_id as string}, now())`.execute(
        t.admin,
      ),
    );
    expect(e1).toMatchObject({ code: "23505", constraint: "uq_stays_unit_in_house" });
    const e2 = await pgError(
      sql`insert into charges (id, organization_id, property_id, source_type, stay_id, kind, revenue_account, description, business_date, quantity, unit_price, amount)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, 'stay', ${w.stay_id}, 'room', 'REV_ROOM', 'trùng', '2026-10-20', 1, 600000, 600000)`.execute(
        t.admin,
      ),
    );
    expect(e2).toMatchObject({ code: "23505", constraint: "uq_charges_stay_room_night" });
    const e3 = await pgError(
      sql`insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${w.guests[0]?.person_id as string}, 'cccd', ${DOC})`.execute(
        t.admin,
      ),
    );
    expect(e3).toMatchObject({ code: "23505", constraint: "uq_identity_documents_person_doc" });
  });
});

describe("S-025 quyền, tenant và che giấy tờ (INV-G1)", () => {
  it("tổ chức khác → 404; buồng phòng check-in → 404, walk-in → 403; kế toán không ghi (403)", async () => {
    const b = await confirmedBooking();
    for (const actor of [OB, H]) {
      expect(await fails(doCheckIn(actor, b.reservationId))).toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    }
    expect(await fails(doCheckIn(K, b.reservationId))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    const unit = await newUnit("PERM");
    expect(await fails(doWalkIn(OB, unit, "2026-10-21", IN))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    for (const actor of [H, K]) {
      expect(await fails(doWalkIn(actor, unit, "2026-10-21", IN))).toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
    }
    expect(await allocsOf(unit)).toHaveLength(0);
    expect((await stayRow(b.stayId)).status).toBe("expected");
    // Quản lý và chủ nhận phòng được.
    await ok(doCheckIn(M, b.reservationId));
    await ok(
      doWalkIn(O, unit, "2026-10-21", IN, [guest({ document: { type: "cccd", number: "079222333444" } })]),
    );
  });

  it("stay.get: lễ tân/quản lý thấy khách + số đã che; kế toán thấy lượt ở nhưng không có giấy tờ; buồng phòng và tổ chức khác → 404", async () => {
    const b = await confirmedBooking();
    const r = await ok(
      doCheckIn(F, b.reservationId, [guest({ document: { type: "cccd", number: "079321321321" } })]),
    );
    const v = await getStay(t.runtime, F, r.stay_id);
    expect(v).toMatchObject({
      id: r.stay_id,
      status: "in_house",
      unit_id: b.unitId,
      reservation_id: b.reservationId,
    });
    expect(v.guests).toHaveLength(1);
    expect(v.guests[0]).toMatchObject({ is_primary: true, full_name: "Nguyễn Văn A", phone: "0901234567" });
    expect(v.guests[0]?.documents).toEqual([
      { id: expect.any(String), doc_type: "cccd", doc_number_masked: "********1321", has_image: false },
    ]);
    expect(JSON.stringify(v)).not.toContain("079321321321");
    expect((await getStay(t.runtime, M, r.stay_id)).guests[0]?.documents).toHaveLength(1);
    expect((await getStay(t.runtime, K, r.stay_id)).guests[0]?.documents).toEqual([]);
    for (const actor of [H, OB]) {
      await expect(getStay(t.runtime, actor, r.stay_id)).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    }
    await expect(getStay(t.runtime, F, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getStay(t.runtime, F, "không-phải-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("RLS identity_documents: buồng phòng, kế toán, tổ chức khác đọc 0 dòng (kể cả số đầy đủ); lễ tân/quản lý/chủ đọc được; buồng phòng không đọc stays", async () => {
    const b = await confirmedBooking();
    await ok(doCheckIn(F, b.reservationId, [guest({ document: { type: "cccd", number: "079444555666" } })]));
    const read = (actor: Actor, table: "identity_documents" | "stays") =>
      withTenant(
        t.runtime,
        { orgId: actor.orgId, actorId: actor.membershipId },
        async (trx) =>
          (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(trx)).rows[0]
            ?.n,
      );
    for (const actor of [H, K, OB]) expect(await read(actor, "identity_documents")).toBe(0);
    for (const actor of [F, M, O]) expect(await read(actor, "identity_documents")).toBeGreaterThan(0);
    expect(await read(H, "stays")).toBe(0);
    expect(await read(OB, "stays")).toBe(0);
    const masked = await withTenant(
      t.runtime,
      { orgId: F.orgId, actorId: F.membershipId },
      async (trx) =>
        (
          await sql<{
            m: string;
          }>`select doc_number_masked as m from identity_documents where doc_number = '079444555666'`.execute(
            trx,
          )
        ).rows[0]?.m,
    );
    expect(masked).toBe("********5666");
  });

  it("HTTP: stay.walkIn → 201, stay.checkIn → 200, stay.get → masked; lỗi trả problem+json đúng mã", async () => {
    async function http(name: string, body: unknown, as: string, key: string = randomUUID()) {
      const def = COMMANDS[name];
      if (!def) throw new Error(`thiếu lệnh ${name}`);
      const res = await handleCommand(
        def,
        new Request(`http://local.test/api/v1/${name.replace(".", "/")}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-test-user": users[as] as string,
            "x-org-id": A.orgId,
          },
          body: JSON.stringify(body),
        }),
        deps,
      );
      // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
      return { status: res.status, body: (await res.json()) as any };
    }
    const u = await newUnit("HTTP");
    const w = await http(
      "stay.walkIn",
      {
        unit_id: u,
        departure_date: "2026-10-21",
        guests: [
          {
            full_name: "Khách HTTP",
            phone: "0908887776",
            document: { type: "cccd", number: "079888777666" },
          },
        ],
      },
      "front_desk",
    );
    expect(w.status).toBe(201);
    expect(w.body.data).toMatchObject({ status: "in_house", unit_id: u });
    expect(JSON.stringify(w.body)).not.toContain("079888777666");
    const g = await (async () => {
      const def = QUERIES["stay.get"];
      const res = await handleQuery(
        def as NonNullable<typeof def>,
        new Request(`http://local.test/api/v1/stay/get?stay_id=${w.body.data.stay_id}`, {
          headers: { "x-test-user": users.front_desk as string, "x-org-id": A.orgId },
        }),
        deps,
      );
      // biome-ignore lint/suspicious/noExplicitAny: thân phản hồi kiểm bằng toMatchObject
      return { status: res.status, body: (await res.json()) as any };
    })();
    expect(g.status).toBe(200);
    expect(g.body.data.guests[0].documents[0].doc_number_masked).toBe("********7666");
    // Body sai: vừa person_id vừa full_name → 422; thiếu khoá idempotency xử lý ở route chung.
    const bad = await http(
      "stay.walkIn",
      { unit_id: u, departure_date: "2026-10-21", guests: [{ person_id: randomUUID(), full_name: "X" }] },
      "front_desk",
    );
    expect(bad.status).toBe(422);
    // Phòng đã có người: 409 ROOM_UNAVAILABLE.
    const busy = await http(
      "stay.walkIn",
      {
        unit_id: u,
        departure_date: "2026-10-21",
        guests: [
          {
            full_name: "Khách khác",
            phone: "0908887775",
            document: { type: "cccd", number: "079888777555" },
          },
        ],
      },
      "front_desk",
    );
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("ROOM_UNAVAILABLE");
    // Buồng phòng: 403 walk-in.
    const forbidden = await http(
      "stay.walkIn",
      {
        unit_id: await newUnit("H2"),
        departure_date: "2026-10-21",
        guests: [
          { full_name: "Khách", phone: "0908887774", document: { type: "cccd", number: "079888777444" } },
        ],
      },
      "housekeeping",
    );
    expect(forbidden.status).toBe(403);
  });
});
