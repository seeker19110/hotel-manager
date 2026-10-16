// PLAN đợt 3 T-203 — bảng giá và báo giá trên Postgres thật (SPEC-reservation-stay S-001, S-002, S-021; ERD `rate_plans`).
// Engine thuần đã có test riêng ở packages/domain/src/rates; ở đây kiểm phần CSDL: ràng buộc, RLS, `rate.set`, `reservation.quote`.
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import type { NightlyRate } from "@hm/domain";
import { createTestDb, type SeededOrg, seedAuthUser, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { COMMANDS, QUERIES } from "../http/registry.ts";
import { executeCommand } from "../pipeline/command.ts";
import { quoteReservation, quoteRoomType, setRatePlan } from "./rates.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;
let H: Actor;
let OB: Actor;
const users: Record<string, string> = {};
let deps: HttpDeps;

type Problem = {
  code: string;
  status: number;
  errors?: { field: string; code: string }[];
};

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
  users[role] = user;
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${role})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${A.orgId}, ${user}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${A.orgId}, ${membership}, ${A.propertyId})`.execute(t.admin);
  return resolveActor(t.runtime, { authUserId: user, orgId: A.orgId, twoFactorEnabled: true });
}

/** Loại phòng riêng cho mỗi test (bảng giá tách theo loại phòng). */
async function roomType(propertyId = A.propertyId, orgId = A.orgId): Promise<string> {
  const id = randomUUID();
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${id}, ${orgId}, ${propertyId}, ${`T${id.slice(0, 6)}`}, 'Loại thử', 2)`.execute(t.admin);
  return id;
}

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3], key: string = randomUUID()) {
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "rates.test", idempotencyKey: key, payload: { key }, correlationId: "c-rates-test" },
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
  return r.problem as Problem;
}

type SetInput = Parameters<typeof setRatePlan>[1];
const setRate = (actor: Actor, input: SetInput, key?: string) =>
  run(actor, async (ctx) => ({ data: await setRatePlan(ctx, input) }), key);

/** Bản giá đầu tiên của loại phòng: ngày hiệu lực tuỳ ý (chưa có bản nào), không phụ thuộc đồng hồ. */
const firstPlan = (rt: string, over: Partial<SetInput> = {}) =>
  ok(
    setRate(O, {
      roomTypeId: rt,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-01-01",
      ...over,
    }),
  );

const NOW = new Date("2026-10-10T05:00:00Z");

async function businessDate(at: Date): Promise<string> {
  const r = await sql<{
    d: string;
  }>`select app.business_date(${A.orgId}, ${A.propertyId}, ${at}::timestamptz)::text as d`.execute(t.admin);
  return r.rows[0]?.d as string;
}

async function plans(rt: string) {
  const r = await sql<{
    id: string;
    weekday_price: string;
    weekend_price: string;
    weekend_nights: number[];
    effective_from: string;
    effective_to: string | null;
    created_by: string | null;
  }>`select id, weekday_price::text, weekend_price::text, weekend_nights, effective_from::text, effective_to::text, created_by
     from rate_plans where room_type_id = ${rt} order by effective_from`.execute(t.admin);
  return r.rows;
}

const quote = (actor: Actor, rt: string, arrival: string, departure: string) =>
  quoteReservation(t.runtime, actor, { roomTypeId: rt, arrivalDate: arrival, departureDate: departure });

async function pgError(
  p: PromiseLike<unknown>,
): Promise<{ code?: string; constraint?: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string; hint?: string };
  }
  throw new Error("lẽ ra phải lỗi CSDL");
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS giá");
  B = await seedOrg(t.admin, "KS giá khác");
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
  H = await member("housekeeping");
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

describe("S-001, S-002 báo giá qua query", () => {
  it("S-001: STD 20/10 → 22/10 = 2 đêm × 600.000 = 1.200.000 (lễ tân báo được)", async () => {
    const rt = await roomType();
    await firstPlan(rt);
    const q = await quote(F, rt, "2026-10-20", "2026-10-22");
    expect(q).toMatchObject({ nights: 2, room_total: 1_200_000, currency: "VND", property_id: A.propertyId });
    expect(q.nightly_prices.map((n) => [n.business_date, n.day_kind, n.amount])).toEqual([
      ["2026-10-20", "weekday", 600_000],
      ["2026-10-21", "weekday", 600_000],
    ]);
    expect(Number.isInteger(q.room_total)).toBe(true);
    expect(q.nightly_prices[0]?.rate_plan_id).toEqual(expect.any(String));
  });

  it("S-002: 22/10 (thứ Năm) → 25/10: cuối tuần = T6+T7 → 2.000.000; cuối tuần = T7+CN → 1.900.000", async () => {
    const rtFriSat = await roomType();
    await firstPlan(rtFriSat);
    expect((await quote(M, rtFriSat, "2026-10-22", "2026-10-25")).room_total).toBe(2_000_000);
    const rtSatSun = await roomType();
    await firstPlan(rtSatSun, { weekendNights: [6, 0] });
    const q = await quote(M, rtSatSun, "2026-10-22", "2026-10-25");
    expect(q.room_total).toBe(1_900_000);
    expect(q.nightly_prices.map((n) => n.day_kind)).toEqual(["weekday", "weekday", "weekend"]);
  });

  it("báo giá qua ranh giới hai bản giá: mỗi đêm theo bản hiệu lực của chính đêm đó", async () => {
    const rt = await roomType();
    await firstPlan(rt);
    await ok(
      setRate(O, {
        roomTypeId: rt,
        weekdayPrice: 650_000,
        weekendPrice: 800_000,
        effectiveFrom: "2026-10-21",
        now: NOW,
      }),
    );
    const q = await quote(F, rt, "2026-10-19", "2026-10-23");
    expect(q.nightly_prices.map((n) => n.amount)).toEqual([600_000, 600_000, 650_000, 650_000]);
    expect(new Set(q.nightly_prices.map((n) => n.rate_plan_id)).size).toBe(2);
  });

  it("đêm trước bản giá đầu tiên / loại phòng chưa có giá → 422 RATE_NOT_CONFIGURED, không giá đoán", async () => {
    const rt = await roomType();
    await expect(quote(F, rt, "2026-10-20", "2026-10-22")).rejects.toMatchObject({
      code: "RATE_NOT_CONFIGURED",
      status: 422,
    });
    await firstPlan(rt, { effectiveFrom: "2026-10-21" });
    await expect(quote(F, rt, "2026-10-20", "2026-10-22")).rejects.toMatchObject({
      code: "RATE_NOT_CONFIGURED",
    });
    expect((await quote(F, rt, "2026-10-21", "2026-10-22")).room_total).toBe(600_000);
  });

  it("ngày đi ≤ ngày đến / ngày không có thật → 422 VALIDATION_FAILED đúng trường", async () => {
    const rt = await roomType();
    await firstPlan(rt);
    for (const [a, d] of [
      ["2026-10-20", "2026-10-20"],
      ["2026-10-22", "2026-10-20"],
    ] as const) {
      await expect(quote(F, rt, a, d)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        extensions: { errors: [{ field: "departure_date", code: "DEPARTURE_NOT_AFTER_ARRIVAL" }] },
      });
    }
    await expect(quote(F, rt, "2026-02-30", "2026-03-02")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      extensions: { errors: [{ field: "arrival_date" }] },
    });
    await expect(quote(F, rt, "2026-10-20", "2028-10-20")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      extensions: { errors: [{ code: "STAY_TOO_LONG" }] },
    });
  });

  it("quyền: owner/manager/lễ tân báo giá được; buồng phòng 403; tổ chức khác 404; cơ sở ngoài phạm vi 404", async () => {
    const rt = await roomType();
    await firstPlan(rt);
    for (const a of [O, M, F])
      expect((await quote(a, rt, "2026-10-20", "2026-10-21")).room_total).toBe(600_000);
    await expect(quote(H, rt, "2026-10-20", "2026-10-21")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(quote(OB, rt, "2026-10-20", "2026-10-21")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(quote(F, randomUUID(), "2026-10-20", "2026-10-21")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(quote(F, "không-phải-uuid", "2026-10-20", "2026-10-21")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Cơ sở thứ hai trong cùng tổ chức mà lễ tân không được cấp phạm vi.
    const p2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${p2}, ${A.orgId}, 'CS2', 'hotel')`.execute(
      t.admin,
    );
    const rt2 = await roomType(p2);
    await expect(quote(F, rt2, "2026-10-20", "2026-10-21")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Loại phòng đã lưu trữ không báo giá.
    await sql`update room_types set archived_at = now() where id = ${rt}`.execute(t.admin);
    await expect(quote(F, rt, "2026-10-20", "2026-10-21")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rate.set", () => {
  it("bản đầu: ghi giá, tập cuối tuần mặc định {5,6}, người lập, audit; không đóng bản nào", async () => {
    const rt = await roomType();
    const r = await firstPlan(rt);
    expect(r.closedRatePlanId).toBeNull();
    expect(await plans(rt)).toEqual([
      {
        id: r.ratePlanId,
        weekday_price: "600000",
        weekend_price: "700000",
        weekend_nights: [5, 6],
        effective_from: "2026-01-01",
        effective_to: null,
        created_by: A.ownerMembershipId,
      },
    ]);
    const audit = await sql<{ action: string; property_id: string }>`
      select action, property_id from audit_events where entity_id = ${r.ratePlanId}`.execute(t.admin);
    expect(audit.rows).toEqual([{ action: "rate_plan.set", property_id: A.propertyId }]);
  });

  it("bản mới từ ngày X: đóng bản cũ (effective_to = X − 1), thêm bản mở cuối, kế thừa cuối tuần; một bản đang mở", async () => {
    const rt = await roomType();
    const first = await firstPlan(rt, { weekendNights: [6, 0] });
    const second = await ok(
      setRate(O, {
        roomTypeId: rt,
        weekdayPrice: 650_000,
        weekendPrice: 750_000,
        effectiveFrom: "2026-10-20",
        now: NOW,
      }),
    );
    expect(second.closedRatePlanId).toBe(first.ratePlanId);
    const rows = await plans(rt);
    expect(rows.map((r) => [r.weekday_price, r.effective_from, r.effective_to, r.weekend_nights])).toEqual([
      ["600000", "2026-01-01", "2026-10-19", [0, 6]],
      ["650000", "2026-10-20", null, [0, 6]],
    ]);
    // Có thể ghi đè tập cuối tuần ở bản mới (lưu theo thứ tự tăng dần).
    await ok(
      setRate(O, {
        roomTypeId: rt,
        weekdayPrice: 650_000,
        weekendPrice: 750_000,
        effectiveFrom: "2026-11-01",
        weekendNights: [6, 5, 4],
        now: NOW,
      }),
    );
    expect((await plans(rt)).at(-1)?.weekend_nights).toEqual([4, 5, 6]);
  });

  it("S-021: đổi giá ngày thường 650.000 không đổi báo giá dựng từ snapshot; booking mới nhận giá mới", async () => {
    const rt = await roomType();
    await firstPlan(rt);
    const before = await quote(F, rt, "2026-10-20", "2026-10-22");
    expect(before.room_total).toBe(1_200_000);
    const snapshot: NightlyRate[] = before.nightly_prices.map((n) => ({
      businessDate: n.business_date,
      amount: n.amount,
      ...(n.rate_plan_id ? { ratePlanId: n.rate_plan_id } : {}),
    }));
    await ok(
      setRate(O, {
        roomTypeId: rt,
        weekdayPrice: 650_000,
        weekendPrice: 700_000,
        effectiveFrom: "2026-10-20",
        now: NOW,
      }),
    );
    // Booking đã giữ: engine nhận snapshot → vẫn 1.200.000 dù bảng giá đã đổi.
    const kept = await withTenant(t.runtime, { orgId: A.orgId, actorId: F.membershipId }, (trx) =>
      quoteRoomType(trx, {
        orgId: A.orgId,
        roomTypeId: rt,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-22",
        nightlyRates: snapshot,
      }),
    );
    expect(kept.total).toBe(1_200_000);
    // Booking mới: giá mới 650.000/đêm.
    const fresh = await quote(F, rt, "2026-10-20", "2026-10-22");
    expect(fresh.room_total).toBe(1_300_000);
    // Đổi ngày: đêm cũ giữ snapshot, đêm mới (22/10) lấy giá hiện hành.
    const extended = await withTenant(t.runtime, { orgId: A.orgId, actorId: F.membershipId }, (trx) =>
      quoteRoomType(trx, {
        orgId: A.orgId,
        roomTypeId: rt,
        arrivalDate: "2026-10-20",
        departureDate: "2026-10-23",
        nightlyRates: snapshot,
      }),
    );
    expect(extended.nights.map((n) => n.amount)).toEqual([600_000, 600_000, 650_000]);
  });

  it("quy tắc hiệu lực: phải sau bản gần nhất (NOT_AFTER_CURRENT), không hồi tố (IN_THE_PAST), đúng ngày hôm nay thì được", async () => {
    const rt = await roomType();
    await firstPlan(rt, { effectiveFrom: "2026-09-01" });
    const today = await businessDate(NOW);
    const price = { roomTypeId: rt, weekdayPrice: 650_000, weekendPrice: 750_000, now: NOW } as const;
    // Bằng ngày bắt đầu bản gần nhất, hoặc trước nó → không ghi đè lịch sử.
    for (const d of ["2026-09-01", "2026-08-01"]) {
      expect(await fails(setRate(O, { ...price, effectiveFrom: d }))).toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        errors: [{ field: "effective_from", code: "NOT_AFTER_CURRENT" }],
      });
    }
    // Sau bản gần nhất nhưng trước hôm nay → hồi tố.
    expect(await fails(setRate(O, { ...price, effectiveFrom: "2026-09-15" }))).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ field: "effective_from", code: "IN_THE_PAST" }],
    });
    expect(await plans(rt)).toHaveLength(1);
    expect((await plans(rt))[0]?.effective_to).toBeNull();
    // Đúng ngày kinh doanh hôm nay → được.
    const r = await ok(setRate(O, { ...price, effectiveFrom: today }));
    expect(r.closedRatePlanId).not.toBeNull();
    // Bản mới nhất bắt đầu trong tương lai: đặt bản nữa phải sau nó, kể cả khi ≥ hôm nay.
    await ok(setRate(O, { ...price, effectiveFrom: "2026-12-01" }));
    expect(await fails(setRate(O, { ...price, effectiveFrom: "2026-11-15" }))).toMatchObject({
      errors: [{ code: "NOT_AFTER_CURRENT" }],
    });
    const rows = await plans(rt);
    expect(rows.map((x) => [x.effective_from, x.effective_to])).toEqual([
      ["2026-09-01", new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)],
      [today, "2026-11-30"],
      ["2026-12-01", null],
    ]);
  });

  it("đầu vào sai → 422 đúng trường, không ghi gì (giá ≤ 0, không nguyên, vượt trần; cuối tuần ngoài 0..6, trùng, rỗng; ngày)", async () => {
    const rt = await roomType();
    const base = {
      roomTypeId: rt,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-10-20",
      now: NOW,
    };
    const cases: [Partial<SetInput>, string][] = [
      [{ weekdayPrice: 0 }, "weekday_price"],
      [{ weekdayPrice: -1 }, "weekday_price"],
      [{ weekendPrice: 700_000.5 }, "weekend_price"],
      [{ weekendPrice: Number.MAX_SAFE_INTEGER + 2 }, "weekend_price"],
      [{ weekendPrice: Number.NaN }, "weekend_price"],
      [{ weekendNights: [7] }, "weekend_nights"],
      [{ weekendNights: [-1, 5] }, "weekend_nights"],
      [{ weekendNights: [5, 5] }, "weekend_nights"],
      [{ weekendNights: [] }, "weekend_nights"],
      [{ weekendNights: [0, 1, 2, 3, 4, 5, 6, 6] }, "weekend_nights"],
      [{ weekendNights: [1.5] }, "weekend_nights"],
      [{ effectiveFrom: "2026-02-30" }, "effective_from"],
      [{ effectiveFrom: "26-10-20" }, "effective_from"],
      [{ effectiveFrom: "1999-12-31" }, "effective_from"],
      [{ effectiveFrom: "2101-01-01" }, "effective_from"],
    ];
    for (const [over, field] of cases) {
      const p = await fails(setRate(O, { ...base, ...over }));
      expect(p, JSON.stringify(over)).toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        errors: [{ field }],
      });
    }
    // Cả bảy thứ (không trùng) là hợp lệ: mọi đêm đều là cuối tuần.
    await ok(setRate(O, { ...base, weekendNights: [0, 1, 2, 3, 4, 5, 6] }));
    expect(await plans(rt)).toHaveLength(1);
  });

  it("chỉ owner ghi: quản lý/lễ tân/buồng phòng 403; tổ chức khác 404 (RLS che loại phòng); loại phòng không có/đã lưu trữ 404", async () => {
    const rt = await roomType();
    const input = {
      roomTypeId: rt,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-10-20",
    };
    for (const a of [M, F, H])
      expect(await fails(setRate(a, input))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await fails(setRate(OB, input))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await fails(setRate(O, { ...input, roomTypeId: randomUUID() }))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await fails(setRate(O, { ...input, roomTypeId: "xyz" }))).toMatchObject({ code: "NOT_FOUND" });
    await sql`update room_types set archived_at = now() where id = ${rt}`.execute(t.admin);
    expect(await fails(setRate(O, input))).toMatchObject({ code: "NOT_FOUND" });
    expect(await plans(rt)).toHaveLength(0);
  });

  it("idempotency: cùng key + cùng nội dung → một bản ghi, kết quả phát lại; cùng key khác nội dung → 409", async () => {
    const rt = await roomType();
    const key = randomUUID();
    const exec = (input: SetInput) =>
      executeCommand(
        t.runtime,
        O,
        { command: "rate.set", idempotencyKey: key, payload: input, correlationId: "c-rates-idem" },
        async (ctx) => {
          const r = await setRatePlan(ctx, input);
          return { data: r, httpStatus: 201 };
        },
      );
    const input = {
      roomTypeId: rt,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-10-20",
    };
    const r1 = await exec(input);
    const r2 = await exec(input);
    expect(r1).toMatchObject({ status: "committed", replayed: false });
    expect(r2).toMatchObject({ status: "committed", replayed: true, data: (r1 as { data: unknown }).data });
    expect(await plans(rt)).toHaveLength(1);
    await expect(exec({ ...input, weekdayPrice: 610_000 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(await plans(rt)).toHaveLength(1);
  });

  it("đua: hai rate.set cùng loại phòng, cùng ngày → đúng một thắng, luôn còn đúng một bản mở cuối", async () => {
    const rt = await roomType();
    await firstPlan(rt, { effectiveFrom: "2026-09-01" });
    const mk = (price: number) =>
      setRate(O, {
        roomTypeId: rt,
        weekdayPrice: price,
        weekendPrice: price + 100_000,
        effectiveFrom: "2026-10-20",
        now: NOW,
      });
    const results = await Promise.all([mk(650_000), mk(660_000), mk(670_000)]);
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "failed"))
      expect((r as { problem: Problem }).problem).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    const rows = await plans(rt);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.effective_to === null)).toHaveLength(1);
    expect(rows[0]?.effective_to).toBe("2026-10-19");
  });
});

describe("ràng buộc CSDL của rate_plans", () => {
  const insert = (rt: string, over: Record<string, unknown> = {}) => {
    const v = {
      weekday: 600_000,
      weekend: 700_000,
      nights: null as string | null,
      from: "2026-01-01",
      to: null as string | null,
      property: A.propertyId,
      ...over,
    };
    return sql`
      insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, weekend_nights,
                              effective_from, effective_to)
      values (${randomUUID()}, ${A.orgId}, ${v.property as string}, ${rt}, ${v.weekday as number}, ${v.weekend as number},
              coalesce(${v.nights as string | null}::smallint[], '{5,6}'::smallint[]), ${v.from as string}::date,
              ${v.to as string | null}::date)`.execute(t.admin);
  };

  it("EXCLUDE: hai bản chồng hiệu lực của cùng loại phòng bị từ chối; loại phòng khác hoặc kề nhau thì được", async () => {
    const rt = await roomType();
    await insert(rt, { from: "2026-01-01", to: "2026-06-30" });
    for (const [from, to] of [
      ["2026-06-30", "2026-12-31"],
      ["2026-03-01", "2026-03-31"],
      ["2025-12-01", null],
    ] as const) {
      const e = await pgError(insert(rt, { from, to }));
      expect(e.code, `${from}→${to}`).toBe("23P01");
      expect(e.constraint).toBe("ex_rate_plans_no_overlap");
    }
    await insert(rt, { from: "2026-07-01", to: null });
    await insert(await roomType(), { from: "2026-03-01", to: null });
  });

  it("chỉ một bản mở cuối mỗi loại phòng", async () => {
    const rt = await roomType();
    await insert(rt, { from: "2026-01-01", to: null });
    const e = await pgError(insert(rt, { from: "2027-01-01", to: null }));
    expect(["23P01", "23505"]).toContain(e.code);
    const idx = await sql<{ n: number }>`
      select count(*)::int as n from pg_indexes where indexname = 'uq_rate_plans_open'`.execute(t.admin);
    expect(idx.rows[0]?.n).toBe(1);
  });

  it("CHECK giá > 0 và ≤ 2^53−1; effective_to ≥ effective_from", async () => {
    const rt = await roomType();
    for (const over of [
      { weekday: 0 },
      { weekday: -5 },
      { weekend: 0 },
      { weekend: 9_007_199_254_740_992 },
      { from: "2026-02-02", to: "2026-02-01" },
    ]) {
      expect((await pgError(insert(rt, over))).code, JSON.stringify(over)).toBe("23514");
    }
    await insert(rt, { weekday: 1, weekend: 9_007_199_254_740_991, from: "2026-02-01", to: "2026-02-01" });
  });

  it("CHECK weekend_nights: mặc định {5,6}; ngoài 0..6, trùng, rỗng, NULL, nhiều chiều → 23514", async () => {
    const rt = await roomType();
    await insert(rt, { from: "2026-01-01", to: "2026-01-31" });
    const def = await sql<{
      w: number[];
    }>`select weekend_nights as w from rate_plans where room_type_id = ${rt}`.execute(t.admin);
    expect(def.rows[0]?.w).toEqual([5, 6]);
    for (const nights of [
      "{7}",
      "{-1}",
      "{5,5}",
      "{}",
      "{5,NULL}",
      "{{1,2},{3,4}}",
      "{0,1,2,3,4,5,6,6}",
      "{32767}",
    ]) {
      const e = await pgError(insert(rt, { nights, from: "2027-01-01", to: "2027-01-31" }));
      expect(e.code, nights).toBe("23514");
      expect(e.constraint, nights).toBe("ck_rate_plans_weekend_nights");
    }
    // Biên hợp lệ: một phần tử 0 và 6; đủ bảy.
    await insert(rt, { nights: "{0}", from: "2027-02-01", to: "2027-02-28" });
    await insert(rt, { nights: "{6}", from: "2027-03-01", to: "2027-03-31" });
    await insert(rt, { nights: "{0,1,2,3,4,5,6}", from: "2027-04-01", to: null });
    // NULL tường minh bị NOT NULL chặn.
    const e = await pgError(
      sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, weekend_nights, effective_from)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${rt}, 1, 1, null, '2030-01-01')`.execute(
        t.admin,
      ),
    );
    expect(e.code).toBe("23502");
  });

  it("FK ghép ba cột: property_id phải khớp loại phòng; loại phòng của tổ chức khác không gắn được", async () => {
    const rt = await roomType();
    const p2 = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${p2}, ${A.orgId}, 'CS3', 'hotel')`.execute(
      t.admin,
    );
    expect((await pgError(insert(rt, { property: p2 }))).code).toBe("23503");
    const rtB = await roomType(B.propertyId, B.orgId);
    expect((await pgError(insert(rtB))).code).toBe("23503");
  });

  it("lịch sử bất biến: chỉ cho đóng bản đang mở; sửa giá/ngày hay mở lại → 55000 DOCUMENT_IMMUTABLE", async () => {
    const rt = await roomType();
    await insert(rt, { from: "2026-01-01", to: null });
    for (const set of [
      sql`weekday_price = 1`,
      sql`weekend_price = 1`,
      sql`weekend_nights = '{1}'`,
      sql`effective_from = '2025-12-01'`,
      sql`currency = 'USD'`,
      sql`created_by = ${A.ownerMembershipId}`,
    ]) {
      const e = await pgError(sql`update rate_plans set ${set} where room_type_id = ${rt}`.execute(t.admin));
      expect(e.hint).toBe("DOCUMENT_IMMUTABLE");
    }
    await sql`update rate_plans set effective_to = '2026-06-30' where room_type_id = ${rt}`.execute(t.admin);
    const reopen = await pgError(
      sql`update rate_plans set effective_to = null where room_type_id = ${rt}`.execute(t.admin),
    );
    expect(reopen.hint).toBe("DOCUMENT_IMMUTABLE");
    const move = await pgError(
      sql`update rate_plans set effective_to = '2026-07-31' where room_type_id = ${rt}`.execute(t.admin),
    );
    expect(move.hint).toBe("DOCUMENT_IMMUTABLE");
    // Cập nhật không đổi nội dung (version/updated_at tự tăng) không bị chặn.
    await sql`update rate_plans set effective_to = effective_to where room_type_id = ${rt}`.execute(t.admin);
  });

  it("RLS: chỉ owner ghi (quản lý/lễ tân chèn bị chặn); đọc theo vai trò + phạm vi; tổ chức khác không thấy", async () => {
    const rt = await roomType();
    await insert(rt, { from: "2026-01-01", to: null });
    const as = (a: Actor) => ({ orgId: a.orgId, actorId: a.membershipId });
    const rowsFor = (a: Actor) =>
      withTenant(t.runtime, as(a), async (trx) => {
        const r = await sql<{
          n: number;
        }>`select count(*)::int as n from rate_plans where room_type_id = ${rt}`.execute(trx);
        return r.rows[0]?.n;
      });
    expect(await rowsFor(O)).toBe(1);
    expect(await rowsFor(M)).toBe(1);
    expect(await rowsFor(F)).toBe(1);
    expect(await rowsFor(H)).toBe(0);
    expect(await rowsFor(OB)).toBe(0);
    const tryInsert = (a: Actor, from: string) =>
      pgError(
        withTenant(t.runtime, as(a), (trx) =>
          sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${rt}, 1, 1, ${from}::date)`.execute(trx),
        ),
      );
    expect((await tryInsert(M, "2027-01-01")).code).toBe("42501");
    expect((await tryInsert(F, "2027-01-01")).code).toBe("42501");
    // Owner tổ chức khác: ngữ cảnh org B không ghi được hàng của org A (WITH CHECK).
    const crossOrg = await pgError(
      withTenant(t.runtime, as(OB), (trx) =>
        sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${rt}, 1, 1, '2027-01-01')`.execute(trx),
      ),
    );
    expect(crossOrg.code).toBe("42501");
    // Quản lý không UPDATE được (đóng bản) — số hàng bị ảnh hưởng = 0, bản vẫn mở.
    await withTenant(t.runtime, as(M), (trx) =>
      sql`update rate_plans set effective_to = '2026-06-30' where room_type_id = ${rt}`.execute(trx),
    );
    expect((await plans(rt))[0]?.effective_to).toBeNull();
    // Không ai (kể cả owner) xoá được lịch sử qua runtime.
    const del = await pgError(
      withTenant(t.runtime, as(O), (trx) =>
        sql`delete from rate_plans where room_type_id = ${rt}`.execute(trx),
      ),
    );
    expect(del.code).toBe("42501");
  });
});

describe("HTTP: rate.set và reservation.quote", () => {
  async function call(name: string, body: unknown, as: string, key: string = randomUUID()) {
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
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { errors?: unknown } };
  }
  async function ask(params: Record<string, string>, as: string) {
    const def = QUERIES["reservation.quote"];
    if (!def) throw new Error("thiếu query reservation.quote");
    const res = await handleQuery(
      def,
      new Request(`http://local.test/api/v1/reservation/quote?${new URLSearchParams(params)}`, {
        headers: { "x-test-user": users[as] as string, "x-org-id": A.orgId },
      }),
      deps,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("owner đặt giá (201) rồi lễ tân báo giá (200); thiếu giá → 422 RATE_NOT_CONFIGURED; ngày đi ≤ ngày đến → 422", async () => {
    const rt = await roomType();
    const none = await ask(
      { room_type_id: rt, arrival_date: "2026-10-20", departure_date: "2026-10-22" },
      "front_desk",
    );
    expect(none).toMatchObject({ status: 422, body: { code: "RATE_NOT_CONFIGURED" } });

    const set = await call(
      "rate.set",
      { room_type_id: rt, weekday_price: 600_000, weekend_price: 700_000, effective_from: "2026-01-01" },
      "owner",
    );
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({
      data: { rate_plan_id: expect.any(String), closed_rate_plan_id: null },
    });

    const q = await ask(
      { room_type_id: rt, arrival_date: "2026-10-20", departure_date: "2026-10-22" },
      "front_desk",
    );
    expect(q).toMatchObject({
      status: 200,
      body: { data: { nights: 2, room_total: 1_200_000, currency: "VND" } },
    });

    const bad = await ask(
      { room_type_id: rt, arrival_date: "2026-10-22", departure_date: "2026-10-22" },
      "front_desk",
    );
    expect(bad).toMatchObject({
      status: 422,
      body: { code: "VALIDATION_FAILED", errors: [{ field: "departure_date" }] },
    });
  });

  it("schema chặt: giá 0, cuối tuần ngoài 0..6, trường lạ → 422; quản lý/lễ tân đặt giá → 403", async () => {
    const rt = await roomType();
    const ok1 = {
      room_type_id: rt,
      weekday_price: 600_000,
      weekend_price: 700_000,
      effective_from: "2026-10-20",
    };
    for (const over of [
      { weekday_price: 0 },
      { weekend_price: 1.5 },
      { weekend_nights: [7] },
      { weekend_nights: [] },
      { effective_from: "20/10/2026" },
      { note: "lạ" },
    ]) {
      const r = await call("rate.set", { ...ok1, ...over }, "owner");
      expect(r.status, JSON.stringify(over)).toBe(422);
    }
    for (const as of ["manager", "front_desk", "housekeeping"]) {
      expect((await call("rate.set", ok1, as)).status, as).toBe(403);
    }
    const hk = await ask(
      { room_type_id: rt, arrival_date: "2026-10-20", departure_date: "2026-10-21" },
      "housekeeping",
    );
    expect(hk.status).toBe(403);
    expect(await plans(rt)).toHaveLength(0);
  });
});
