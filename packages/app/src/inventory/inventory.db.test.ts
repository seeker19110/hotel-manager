// T-009 — lịch tài nguyên trên Postgres thật: INV-I1 (không chồng), INV-I2 ([start,end)), INV-I3 (hold nhả đúng một lần,
// không now() trong vị từ), chuyển phòng nguyên tử, block, ba chiều trạng thái. Kế hoạch §13: 100 lệnh tranh một phòng.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireHolds } from "../../../../apps/worker/src/jobs.ts";
import { type Actor, resolveActor } from "../access/actor.ts";
import { executeCommand } from "../pipeline/command.ts";
import {
  approveBlock,
  confirmHold,
  createHold,
  moveAllocation,
  proposeBlock,
  releaseHold,
  unitStatus,
} from "./inventory.ts";

let t: TestDb;
let A: SeededOrg;
let owner: Actor;
let unit2: string;

const H = (iso: string) => new Date(`2026-11-${iso}:00Z`);

function run<T>(fn: Parameters<typeof executeCommand<T>>[3], name = "inventory.test") {
  return executeCommand<T>(
    t.runtime,
    owner,
    { command: name, idempotencyKey: randomUUID(), payload: { r: randomUUID() }, correlationId: "c" },
    fn,
  );
}

async function activeCount(unitId: string): Promise<number> {
  const r = await sql<{
    n: number;
  }>`select count(*)::int as n from allocations where unit_id = ${unitId} and active`.execute(t.admin);
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS lịch");
  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  unit2 = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${unit2}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${A.roomTypeId}, '102')`.execute(
    t.admin,
  );
});

afterAll(async () => {
  await t.drop();
});

describe("INV-I1 — không chồng phòng (kế hoạch §13)", () => {
  it("100 lệnh song song giữ cùng phòng cùng khoảng → đúng 1 thành công, 99 ROOM_UNAVAILABLE", async () => {
    const unit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unit}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'R100')`.execute(
      t.admin,
    );
    const now = H("01T08:00");
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        run((ctx) =>
          createHold(ctx, {
            unitId: unit,
            during: { start: H("02T14:00"), end: H("03T12:00") },
            ttlMinutes: 15,
            now,
          }).then((data) => ({ data })),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    const failed = results.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(99);
    expect(new Set(failed.map((r) => r.status === "failed" && r.problem.code))).toEqual(
      new Set(["ROOM_UNAVAILABLE"]),
    );
    expect(await activeCount(unit)).toBe(1);
  });

  it("chồng một phần cũng bị từ chối, kể cả chèn trực tiếp bằng owner (ràng buộc ở CSDL)", async () => {
    const unit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unit}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'R101')`.execute(
      t.admin,
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unit}, 'stay', tstzrange(${H("05T14:00")}, ${H("07T12:00")}, '[)'))`.execute(
      t.admin,
    );
    await expect(
      sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unit}, 'stay', tstzrange(${H("06T14:00")}, ${H("08T12:00")}, '[)'))`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ex_allocations_no_overlap/);
  });
});

describe("INV-I2 — [start, end)", () => {
  it("khách sau nhận đúng lúc khách trước trả (đầu = cuối) → hợp lệ", async () => {
    const r1 = await run((ctx) =>
      createHold(ctx, {
        unitId: unit2,
        during: { start: H("10T14:00"), end: H("11T12:00") },
        ttlMinutes: 60,
        now: H("09T00:00"),
      }).then((data) => ({ data })),
    );
    const r2 = await run((ctx) =>
      createHold(ctx, {
        unitId: unit2,
        during: { start: H("11T12:00"), end: H("12T12:00") },
        ttlMinutes: 60,
        now: H("09T00:00"),
      }).then((data) => ({ data })),
    );
    expect([r1.status, r2.status]).toEqual(["committed", "committed"]);
  });

  it("kết thúc trước/bằng bắt đầu → VALIDATION_FAILED; khoảng mở chỉ cho hợp đồng", async () => {
    const bad = await run((ctx) =>
      createHold(ctx, {
        unitId: unit2,
        during: { start: H("13T12:00"), end: H("13T12:00") },
        ttlMinutes: 15,
      }).then((data) => ({ data })),
    );
    expect(bad).toMatchObject({ status: "failed", problem: { code: "VALIDATION_FAILED" } });
    await expect(
      sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unit2}, 'stay', tstzrange(${H("20T00:00")}, null, '[)'))`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ck_allocations_open_end/);
  });
});

describe("INV-I3 — hold hết hạn nhả đúng một lần", () => {
  it("hold hết hạn: lệnh mới dọn dưới khoá phòng rồi giữ được; hold cũ inactive lý do expired", async () => {
    const unit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unit}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'R103')`.execute(
      t.admin,
    );
    const during = { start: H("15T14:00"), end: H("16T12:00") };
    const first = await run((ctx) =>
      createHold(ctx, { unitId: unit, during, ttlMinutes: 15, now: H("14T08:00") }).then((data) => ({
        data,
      })),
    );
    expect(first.status).toBe("committed");
    // Chưa hết hạn → người khác không giữ được.
    const blocked = await run((ctx) =>
      createHold(ctx, { unitId: unit, during, ttlMinutes: 15, now: H("14T08:10") }).then((data) => ({
        data,
      })),
    );
    expect(blocked).toMatchObject({ status: "failed", problem: { code: "ROOM_UNAVAILABLE" } });
    // Hết hạn → giữ được.
    const second = await run((ctx) =>
      createHold(ctx, { unitId: unit, during, ttlMinutes: 15, now: H("14T08:20") }).then((data) => ({
        data,
      })),
    );
    expect(second.status).toBe("committed");
    const rows = await sql<{ active: boolean; deactivated_reason: string | null }>`
      select active, deactivated_reason from allocations where unit_id = ${unit} order by created_at`.execute(
      t.admin,
    );
    expect(rows.rows).toEqual([
      { active: false, deactivated_reason: "expired" },
      { active: true, deactivated_reason: null },
    ]);
  });

  it("job worker và lệnh nhả cùng lúc → hold chỉ nhả MỘT lần (một audit)", async () => {
    const unit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unit}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'R104')`.execute(
      t.admin,
    );
    const held = await run((ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: H("18T14:00"), end: H("19T12:00") },
        ttlMinutes: 15,
        now: H("17T08:00"),
      }).then((data) => ({ data })),
    );
    if (held.status !== "committed") throw new Error("hold lỗi");
    const id = held.data.allocationId;
    // Job là toàn cục (có thể nhả cả hold hết hạn khác) — chỉ đếm việc nhả CHÍNH hold này.
    const [, manual, again] = await Promise.all([
      expireHolds(t.worker, H("17T09:00")),
      run((ctx) => releaseHold(ctx, id, H("17T09:00")).then((data) => ({ data }))),
      run((ctx) => releaseHold(ctx, id, H("17T09:00")).then((data) => ({ data }))),
    ]);
    const manualReleased = [manual, again].filter((r) => r.status === "committed" && r.data.released).length;
    const byJob = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${id} and action = 'allocation.expired'`.execute(
      t.admin,
    );
    expect((byJob.rows[0]?.n ?? 0) + manualReleased).toBe(1);
    const audits = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where entity_id = ${id} and action in ('allocation.expired','allocation.released')`.execute(
      t.admin,
    );
    expect(audits.rows[0]?.n).toBe(1);
  });

  it("không kích hoạt lại allocation đã nhả (trigger)", async () => {
    const r = await sql<{ id: string }>`select id from allocations where not active limit 1`.execute(t.admin);
    await expect(
      sql`update allocations set active = true where id = ${r.rows[0]?.id}`.execute(t.admin),
    ).rejects.toThrow(/không kích hoạt lại/);
  });

  it("không ràng buộc/index nào của allocations dùng now()/current_timestamp", async () => {
    const r = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'allocations'::regclass
      union all select pg_get_indexdef(indexrelid) from pg_index where indrelid = 'allocations'::regclass`.execute(
      t.admin,
    );
    for (const { def } of r.rows) expect(def).not.toMatch(/now\(\)|current_timestamp/i);
  });

  it("xác nhận hold đã hết hạn → HOLD_EXPIRED; còn hạn → thành stay, hết expires_at", async () => {
    const unit = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unit}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'R105')`.execute(
      t.admin,
    );
    const held = await run((ctx) =>
      createHold(ctx, {
        unitId: unit,
        during: { start: H("21T14:00"), end: H("22T12:00") },
        ttlMinutes: 15,
        now: H("20T08:00"),
      }).then((data) => ({ data })),
    );
    if (held.status !== "committed") throw new Error("hold lỗi");
    const late = await run((ctx) =>
      confirmHold(ctx, held.data.allocationId, "stay", H("20T09:00")).then(() => ({ data: null })),
    );
    expect(late).toMatchObject({ status: "failed", problem: { code: "HOLD_EXPIRED" } });
    const ok = await run((ctx) =>
      confirmHold(ctx, held.data.allocationId, "stay", H("20T08:05")).then(() => ({ data: null })),
    );
    expect(ok.status).toBe("committed");
    const row = await sql<{
      kind: string;
      expires_at: Date | null;
    }>`select kind, expires_at from allocations where id = ${held.data.allocationId}`.execute(t.admin);
    expect(row.rows[0]).toEqual({ kind: "stay", expires_at: null });
  });
});

describe("chuyển phòng nguyên tử", () => {
  async function stay(unit: string, from: string, to: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${id}, ${A.orgId}, ${A.propertyId}, ${unit}, 'stay', tstzrange(${H(from)}, ${H(to)}, '[)'))`.execute(
      t.admin,
    );
    return id;
  }

  it("phòng đích trống → cũ thu hẹp tới lúc chuyển, mới ở phòng đích tới hết; phòng cũ thành bẩn", async () => {
    const [u1, u2] = [randomUUID(), randomUUID()];
    for (const [u, c] of [
      [u1, "M1"],
      [u2, "M2"],
    ] as const) {
      await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${u}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${c})`.execute(
        t.admin,
      );
    }
    const id = await stay(u1, "23T14:00", "26T12:00");
    const r = await run((ctx) =>
      moveAllocation(ctx, { allocationId: id, toUnitId: u2, at: H("24T10:00") }).then((data) => ({ data })),
    );
    expect(r.status).toBe("committed");
    const rows = await sql<{ unit_id: string; lo: Date; hi: Date }>`
      select unit_id, lower(during) as lo, upper(during) as hi from allocations where active and unit_id in (${u1}, ${u2}) order by lower(during)`.execute(
      t.admin,
    );
    expect(rows.rows).toEqual([
      { unit_id: u1, lo: H("23T14:00"), hi: H("24T10:00") },
      { unit_id: u2, lo: H("24T10:00"), hi: H("26T12:00") },
    ]);
    const hk = await sql<{ s: string }>`select housekeeping_status as s from units where id = ${u1}`.execute(
      t.admin,
    );
    expect(hk.rows[0]?.s).toBe("dirty");
  });

  it("phòng đích bận → ROOM_UNAVAILABLE và allocation cũ KHÔNG đổi (rollback)", async () => {
    const [u1, u2] = [randomUUID(), randomUUID()];
    for (const [u, c] of [
      [u1, "N1"],
      [u2, "N2"],
    ] as const) {
      await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${u}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, ${c})`.execute(
        t.admin,
      );
    }
    const id = await stay(u1, "23T14:00", "26T12:00");
    await stay(u2, "25T00:00", "27T00:00");
    const r = await run((ctx) =>
      moveAllocation(ctx, { allocationId: id, toUnitId: u2, at: H("24T10:00") }).then((data) => ({ data })),
    );
    expect(r).toMatchObject({ status: "failed", problem: { code: "ROOM_UNAVAILABLE" } });
    const row = await sql<{
      hi: Date;
      active: boolean;
    }>`select upper(during) as hi, active from allocations where id = ${id}`.execute(t.admin);
    expect(row.rows[0]).toEqual({ hi: H("26T12:00"), active: true });
  });
});

describe("block bảo trì", () => {
  it("block đụng khách đã có → BLOCK_CONFLICT, block vẫn requested; khoảng trống → approved + allocation", async () => {
    const u = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${u}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'B1')`.execute(
      t.admin,
    );
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${u}, 'stay', tstzrange(${H("10T14:00")}, ${H("12T12:00")}, '[)'))`.execute(
      t.admin,
    );
    const p1 = await run((ctx) =>
      proposeBlock(ctx, {
        unitId: u,
        period: { start: H("11T00:00"), end: H("13T00:00") },
        reason: "Thấm trần",
      }).then((data) => ({ data })),
    );
    if (p1.status !== "committed") throw new Error("propose lỗi");
    const a1 = await run((ctx) => approveBlock(ctx, p1.data.blockId).then(() => ({ data: null })));
    expect(a1).toMatchObject({ status: "failed", problem: { code: "BLOCK_CONFLICT" } });
    const st = await sql<{ status: string }>`select status from blocks where id = ${p1.data.blockId}`.execute(
      t.admin,
    );
    expect(st.rows[0]?.status).toBe("requested");

    const p2 = await run((ctx) =>
      proposeBlock(ctx, {
        unitId: u,
        period: { start: H("13T00:00"), end: H("14T00:00") },
        reason: "Sơn",
      }).then((data) => ({ data })),
    );
    if (p2.status !== "committed") throw new Error("propose lỗi");
    expect((await run((ctx) => approveBlock(ctx, p2.data.blockId).then(() => ({ data: null })))).status).toBe(
      "committed",
    );
    const status = await t.runtime.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
      return unitStatus(trx, A.orgId, u, H("13T12:00"));
    });
    expect(status.occupancy).toBe("blocked");
  });
});

describe("ba chiều trạng thái độc lập (DOMAIN-MODEL §3)", () => {
  it("sạch không có nghĩa là trống; bẩn không có nghĩa là có khách", async () => {
    const u = randomUUID();
    await sql`insert into units (id, organization_id, property_id, floor_id, code, housekeeping_status)
              values (${u}, ${A.orgId}, ${A.propertyId}, ${A.floorId}, 'S1', 'clean')`.execute(t.admin);
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${u}, 'stay', tstzrange(${H("01T14:00")}, ${H("03T12:00")}, '[)'))`.execute(
      t.admin,
    );
    const at = (iso: string) =>
      t.runtime.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${A.orgId}, true)`.execute(trx);
        return unitStatus(trx, A.orgId, u, H(iso));
      });
    expect(await at("02T00:00")).toEqual({
      occupancy: "occupied",
      housekeeping: "clean",
      availability: "active",
    });
    await sql`update units set housekeeping_status = 'dirty' where id = ${u}`.execute(t.admin);
    expect(await at("04T00:00")).toEqual({
      occupancy: "vacant",
      housekeeping: "dirty",
      availability: "active",
    });
  });
});
