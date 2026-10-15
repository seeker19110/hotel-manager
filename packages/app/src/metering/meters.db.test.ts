// PLAN đợt 2 T-112 — công tơ, chỉ số, đơn giá trên Postgres thật (SPEC-metering-billing S-005…S-010, S-017).
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedAuthUser, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import { toProblem } from "../pipeline/problem.ts";
import {
  acknowledgeAnomaly,
  missingReadings,
  periodConsumption,
  priceAt,
  readingRoute,
  recordReading,
  replaceMeter,
  setServicePrice,
  unresolvedAnomalies,
} from "./meters.ts";

let t: TestDb;
let A: SeededOrg;
let O: Actor;
let M: Actor;
let F: Actor;

async function member(role: string): Promise<Actor> {
  const user = await seedAuthUser(t.admin, `${role}+${randomUUID().slice(0, 6)}@example.test`);
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

function run<T>(actor: Actor, fn: Parameters<typeof executeCommand<T>>[3]) {
  const key = randomUUID();
  return executeCommand<T>(
    t.runtime,
    actor,
    { command: "meters.test", idempotencyKey: key, payload: { key }, correlationId: "c-meters" },
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
  return r.problem as { code: string; status: number; previous_value?: number; errors?: { field: string }[] };
}

/** Mỗi test dùng cơ sở riêng (kỳ thu không chồng theo cơ sở). */
async function property() {
  const propertyId = randomUUID();
  const floor1 = randomUUID();
  const floor2 = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${propertyId}, ${A.orgId}, ${`CS ${propertyId.slice(0, 4)}`}, 'rental')`.execute(
    t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name, sort_order) values
            (${floor2}, ${A.orgId}, ${propertyId}, 'Tầng 2', 2), (${floor1}, ${A.orgId}, ${propertyId}, 'Tầng 1', 1)`.execute(
    t.admin,
  );
  const roomType = randomUUID();
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${roomType}, ${A.orgId}, ${propertyId}, 'P', 'Phòng trọ', 2)`.execute(t.admin);
  for (const m of [M, F]) {
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${m.membershipId}, ${propertyId})`.execute(t.admin);
  }
  M = await resolveActor(t.runtime, { authUserId: M.authUserId, orgId: A.orgId, twoFactorEnabled: true });
  F = await resolveActor(t.runtime, { authUserId: F.authUserId, orgId: A.orgId, twoFactorEnabled: true });
  const unit = async (code: string, floor = floor1) => {
    const id = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
              values (${id}, ${A.orgId}, ${propertyId}, ${floor}, ${roomType}, ${code})`.execute(t.admin);
    return id;
  };
  const meter = async (unitId: string, kind: "electric" | "water", initial = 0) => {
    const id = randomUUID();
    await sql`insert into meters (id, organization_id, property_id, unit_id, kind, installed_on, initial_value)
              values (${id}, ${A.orgId}, ${propertyId}, ${unitId}, ${kind}, '2026-01-01', ${initial})`.execute(
      t.admin,
    );
    return id;
  };
  const period = async (month: string, status = "draft") => {
    const id = randomUUID();
    const start = `${month}-01`;
    await sql`insert into billing_periods (id, organization_id, property_id, period_start, period_end, status, issued_at)
              values (${id}, ${A.orgId}, ${propertyId}, ${start}::date, (${start}::date + interval '1 month' - interval '1 day')::date,
                      ${status}, ${status === "issued" || status === "locked" ? new Date() : null})`.execute(
      t.admin,
    );
    return id;
  };
  /** Chỉ số kỳ đã duyệt (như sau phát hành) — chèn khi kỳ còn nháp rồi mới đổi trạng thái. */
  const approved = async (meterId: string, periodId: string, value: number, readOn: string) => {
    await sql`insert into meter_readings (id, organization_id, property_id, meter_id, billing_period_id, read_on, value, status, source,
                                          approved_by)
              values (${randomUUID()}, ${A.orgId}, ${propertyId}, ${meterId}, ${periodId}, ${readOn}::date, ${value}, 'approved',
                      'period', ${A.ownerMembershipId})`.execute(t.admin);
  };
  return { propertyId, floor1, floor2, unit, meter, period, approved };
}

const record = (a: Actor, meterId: string, billingPeriodId: string, value: number, baseVersion?: number) =>
  run(a, async (ctx) => ({
    data: await recordReading(ctx, {
      meterId,
      billingPeriodId,
      value,
      ...(baseVersion ? { baseVersion } : {}),
    }),
  }));

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Trọ công tơ", "rental");
  O = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  M = await member("manager");
  F = await member("front_desk");
});

afterAll(async () => {
  await t.drop();
});

describe("S-005 chỉ số không giảm; kỳ đã phát hành; xung đột phiên bản", () => {
  it("1.340 < 1.350 đã duyệt → 422 METER_READING_DECREASED kèm previous_value, không lưu; 1.360 lưu nháp", async () => {
    const P = await property();
    const u = await P.unit("101");
    const m = await P.meter(u, "electric");
    const p9 = await P.period("2026-09");
    await P.approved(m, p9, 1350, "2026-09-30");
    const p10 = await P.period("2026-10");
    const bad = await fails(record(F, m, p10, 1340));
    expect(bad).toMatchObject({ code: "METER_READING_DECREASED", status: 422, previous_value: 1350 });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from meter_readings where billing_period_id = ${p10}`.execute(t.admin);
    expect(n.rows[0]?.n).toBe(0);
    const r = await ok(record(F, m, p10, 1360));
    expect(r).toMatchObject({ version: 1, consumption: 10, anomaly: null });
    // Nhập lại = cập nhật bản nháp; base_version cũ → VERSION_CONFLICT.
    expect((await ok(record(M, m, p10, 1365, 1))).version).toBe(2);
    expect(await fails(record(F, m, p10, 1370, 1))).toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("kỳ đã phát hành → 409 PERIOD_ISSUED (lệnh và CSDL)", async () => {
    const P = await property();
    const u = await P.unit("101");
    const m = await P.meter(u, "electric");
    const p = await P.period("2026-09");
    await P.approved(m, p, 100, "2026-09-30");
    await sql`update billing_periods set status = 'issued', issued_at = now() where id = ${p}`.execute(
      t.admin,
    );
    expect(await fails(record(M, m, p, 200))).toMatchObject({ code: "PERIOD_ISSUED", status: 409 });
    const direct = await sql`update meter_readings set value = 1 where billing_period_id = ${p}`
      .execute(t.admin)
      .catch((e: unknown) => e);
    expect(toProblem(direct)).toMatchObject({ code: "PERIOD_ISSUED", status: 409 });
  });
});

describe("S-006, S-007 thay công tơ", () => {
  it("S-006: (1.300 − 1.250) + (50 − 0) = 100 kWh → 300.000 đ với giá 3.000 đ/kWh", async () => {
    const P = await property();
    const u = await P.unit("101");
    const old = await P.meter(u, "electric");
    const p9 = await P.period("2026-09");
    await P.approved(old, p9, 1250, "2026-09-30");
    const p10 = await P.period("2026-10");
    const r = await ok(
      run(M, async (ctx) => ({
        data: await replaceMeter(ctx, {
          meterId: old,
          occurredOn: "2026-10-12",
          oldFinalValue: 1300,
          newInitialValue: 0,
        }),
      })),
    );
    const ev = await sql<{
      kind: string;
      old_final_value: string;
    }>`select kind, old_final_value::text from meter_events where id = ${r.eventId}`.execute(t.admin);
    expect(ev.rows[0]).toEqual({ kind: "replacement", old_final_value: "1300.000" });
    const rec = await ok(record(F, r.newMeterId, p10, 50));
    expect(rec.consumption).toBe(100);
    const svc = randomUUID();
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account, meter_kind)
              values (${svc}, ${A.orgId}, ${P.propertyId}, 'DIEN', 'Điện', 'metered', 'REV_UTIL', 'electric')`.execute(
      t.admin,
    );
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, { serviceId: svc, unitPrice: 3000, effectiveFrom: "2026-01-01" }),
      })),
    );
    const price = await t.admin.transaction().execute((trx) => priceAt(trx, A.orgId, svc, "2026-10-31"));
    expect((price as number) * rec.consumption).toBe(300_000);
    // Công tơ cũ đã tháo: không nhập chỉ số vào nữa; thay lần hai → 409.
    expect(await fails(record(F, old, p10, 1400))).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await replaceMeter(ctx, {
            meterId: old,
            occurredOn: "2026-10-13",
            oldFinalValue: 1300,
            newInitialValue: 0,
          }),
        })),
      ),
    ).toMatchObject({ code: "INVALID_TRANSITION" });
    // Chỉ số cuối công tơ cũ nhỏ hơn lần đọc trước → METER_READING_DECREASED.
    const u2 = await P.unit("102");
    const m2 = await P.meter(u2, "electric");
    await P.approved(m2, p9, 500, "2026-09-30");
    expect(
      await fails(
        run(M, async (ctx) => ({
          data: await replaceMeter(ctx, {
            meterId: m2,
            occurredOn: "2026-10-12",
            oldFinalValue: 499,
            newInitialValue: 0,
          }),
        })),
      ),
    ).toMatchObject({ code: "METER_READING_DECREASED", previous_value: 500 });
  });

  it("S-007: lễ tân thay công tơ → 403 FORBIDDEN", async () => {
    const P = await property();
    const m = await P.meter(await P.unit("101"), "water");
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await replaceMeter(ctx, {
            meterId: m,
            occurredOn: "2026-10-12",
            oldFinalValue: 10,
            newInitialValue: 0,
          }),
        })),
      ),
    ).toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

describe("S-008 bất thường, S-009 thiếu chỉ số, S-010 tuyến chốt", () => {
  it("S-008: 100/110/90 rồi 260 kWh → cảnh báo; ghi nhận có ghi chú thì hết", async () => {
    const P = await property();
    const u = await P.unit("101");
    const m = await P.meter(u, "electric", 1000);
    let v = 1000;
    for (const [month, c] of [
      ["2026-06", 100],
      ["2026-07", 110],
      ["2026-08", 90],
    ] as const) {
      v += c;
      await P.approved(m, await P.period(month), v, `${month}-28`);
    }
    const p9 = await P.period("2026-09");
    const r = await ok(record(F, m, p9, v + 260));
    expect(r.anomaly).toEqual({ average: 100 });
    const list = await t.admin.transaction().execute((trx) => unresolvedAnomalies(trx, A.orgId, p9));
    expect(list).toEqual([
      { reading_id: r.readingId, unit: "101", meter: "electric", consumption: 260, average: 100 },
    ]);
    expect(
      await fails(
        run(F, async (ctx) => ({
          data: await acknowledgeAnomaly(ctx, { readingId: r.readingId, note: "x" }),
        })),
      ),
    ).toMatchObject({ status: 403 });
    await ok(
      run(M, async (ctx) => ({
        data: await acknowledgeAnomaly(ctx, {
          readingId: r.readingId,
          note: "Khách dùng máy sấy, đã xác minh",
        }),
      })),
    );
    expect(await t.admin.transaction().execute((trx) => unresolvedAnomalies(trx, A.orgId, p9))).toEqual([]);
    // Thiếu lịch sử (< 3 kỳ) → không cảnh báo.
    const m2 = await P.meter(await P.unit("102"), "electric");
    expect((await ok(record(F, m2, p9, 999))).anomaly).toBeNull();
  });

  it("S-009: phòng có hợp đồng đang hiệu lực thiếu chỉ số kỳ, hoặc bàn giao import còn chờ chỉ số → liệt kê", async () => {
    const P = await property();
    const u1 = await P.unit("101");
    const u2 = await P.unit("102");
    const m1 = await P.meter(u1, "electric");
    await P.meter(u2, "electric");
    const p10 = await P.period("2026-10");
    const rep = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${rep}, ${A.orgId}, 'Người thuê')`.execute(
      t.admin,
    );
    const activate = async (unitId: string, readingsPending: boolean) => {
      const { leaseId } = await seedLease(t.admin, {
        orgId: A.orgId,
        propertyId: P.propertyId,
        representativePersonId: rep,
        unitId,
        effectiveFrom: "2026-09-01",
      });
      await t.admin.transaction().execute(async (trx) => {
        await sql`update lease_versions set signed_at = now(), terms_hash = ${"0".repeat(64)}, terms_snapshot = '{}' where lease_id = ${leaseId}`.execute(
          trx,
        );
        await sql`update leases set status = 'pending_signature' where id = ${leaseId}`.execute(trx);
        await sql`update leases set status = 'signed_awaiting_handover', signed_on = '2026-08-25' where id = ${leaseId}`.execute(
          trx,
        );
        await sql`insert into handovers (id, organization_id, property_id, lease_id, kind, handed_over_on, staff_confirmed_by,
                                         confirmed_at, source, readings_pending, confirmation_method)
                  values (${randomUUID()}, ${A.orgId}, ${P.propertyId}, ${leaseId}, 'move_in', '2026-09-01', ${A.ownerMembershipId},
                          now(), 'import', ${readingsPending}, 'import')`.execute(trx);
        await sql`update leases set status = 'active' where id = ${leaseId}`.execute(trx);
      });
    };
    await activate(u1, false);
    await activate(u2, true);
    const list = await t.admin.transaction().execute((trx) => missingReadings(trx, A.orgId, p10));
    expect(list.map((x) => [x.unit, x.meter, x.reason])).toEqual([
      ["101", "electric", "no_reading"],
      ["102", "electric", "no_reading"],
      ["102", null, "readings_pending"],
    ]);
    await ok(record(F, m1, p10, 10));
    const after = await t.admin.transaction().execute((trx) => missingReadings(trx, A.orgId, p10));
    expect(after.map((x) => x.unit)).toEqual(["102", "102"]);
  });

  it("S-010: tuyến chốt theo tầng rồi mã phòng, có chỉ số/ảnh trước và cờ đã nhập", async () => {
    const P = await property();
    const u201 = await P.unit("201", P.floor2);
    const u102 = await P.unit("102");
    const u101 = await P.unit("101");
    const e101 = await P.meter(u101, "electric", 5);
    await P.meter(u101, "water", 7);
    await P.meter(u102, "electric");
    await P.meter(u201, "electric");
    const p9 = await P.period("2026-09");
    await P.approved(e101, p9, 120, "2026-09-30");
    const p10 = await P.period("2026-10");
    await ok(record(F, e101, p10, 150));
    const route = await readingRoute(t.runtime, F, { billingPeriodId: p10 });
    expect(route.map((x) => [x.floor, x.unit])).toEqual([
      ["Tầng 1", "101"],
      ["Tầng 1", "102"],
      ["Tầng 2", "201"],
    ]);
    expect(route[0]?.meters.map((m) => [m.kind, m.previous_value, m.value, m.entered])).toEqual([
      ["electric", 120, 150, true],
      ["water", 7, null, false],
    ]);
  });
});

describe("S-017 đơn giá theo ngày hiệu lực", () => {
  it("chưa đến ngày hiệu lực → không có giá; giá mới tự kết thúc giá cũ; trùng hiệu lực → 422", async () => {
    const P = await property();
    const wifi = randomUUID();
    await sql`insert into services (id, organization_id, property_id, code, name, kind, revenue_account)
              values (${wifi}, ${A.orgId}, ${P.propertyId}, 'WIFI', 'Wifi', 'fixed_per_unit', 'REV_SERVICE')`.execute(
      t.admin,
    );
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, {
          serviceId: wifi,
          unitPrice: 100_000,
          effectiveFrom: "2026-11-01",
        }),
      })),
    );
    const at = (d: string) => t.admin.transaction().execute((trx) => priceAt(trx, A.orgId, wifi, d));
    expect(await at("2026-10-31")).toBeNull();
    expect(await at("2026-11-01")).toBe(100_000);
    await ok(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, {
          serviceId: wifi,
          unitPrice: 120_000,
          effectiveFrom: "2027-01-01",
        }),
      })),
    );
    expect(await at("2026-12-31")).toBe(100_000);
    expect(await at("2027-01-01")).toBe(120_000);
    const overlap = await fails(
      run(O, async (ctx) => ({
        data: await setServicePrice(ctx, {
          serviceId: wifi,
          unitPrice: 1,
          effectiveFrom: "2026-12-01",
          effectiveTo: "2026-12-31",
        }),
      })),
    );
    expect(overlap.errors?.[0]?.field).toBe("effective_from");
    // Bảng giá chỉ chủ (ma trận "Loại phòng, bảng giá").
    expect(
      (
        await fails(
          run(M, async (ctx) => ({
            data: await setServicePrice(ctx, { serviceId: wifi, unitPrice: 1, effectiveFrom: "2028-01-01" }),
          })),
        )
      ).status,
    ).toBe(403);
  });
});

it("lượng tiêu thụ từ chỉ số bàn giao đầu kỳ", async () => {
  const P = await property();
  const m = await P.meter(await P.unit("101"), "water", 300);
  const p = await P.period("2026-10");
  const r = await ok(record(F, m, p, 340));
  expect(await t.admin.transaction().execute((trx) => periodConsumption(trx, A.orgId, r.readingId))).toBe(40);
});
