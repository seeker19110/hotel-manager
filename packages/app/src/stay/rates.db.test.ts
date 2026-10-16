// PLAN đợt 3 T-204 — loại phòng, bảng giá, báo giá trên Postgres thật (SPEC-reservation-stay S-001, S-002, S-014, S-021).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { createTestDb, type SeededOrg, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { codeOf, okAs, ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { createRoomType, quote, setRate, updateRoomType } from "./rates.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let manager: Actor;
let frontDesk: Actor;
let housekeeping: Actor;
let ownerB: Actor;

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS giá");
  B = await seedOrg(t.admin, "KS khác");
  owner = await ownerOf(t, A);
  manager = await seedMember(t, A, "manager");
  frontDesk = await seedMember(t, A, "front_desk");
  housekeeping = await seedMember(t, A, "housekeeping");
  ownerB = await ownerOf(t, B);
  await okAs(t, owner, (ctx) =>
    setRate(ctx, {
      roomTypeId: A.roomTypeId,
      weekdayPrice: 600_000,
      weekendPrice: 700_000,
      effectiveFrom: "2026-01-01",
    }),
  );
});

afterAll(async () => {
  await t?.drop();
});

const q = (
  actor: Actor,
  arrivalDate: string,
  departureDate: string,
  guests = 2,
  by: object = { roomTypeId: A.roomTypeId },
) => quote(t.runtime, actor, { ...by, arrivalDate, departureDate, guests });

describe("S-001/S-002 báo giá", () => {
  it("S-001: STD 20/10 → 22/10, 2 khách: 2 đêm × 600.000 = 1.200.000, kèm điều kiện huỷ", async () => {
    const r = await q(frontDesk, "2026-10-20", "2026-10-22");
    expect(r.nights).toBe(2);
    expect(r.nightlyPrices).toEqual([
      { businessDate: "2026-10-20", amount: 600_000 },
      { businessDate: "2026-10-21", amount: 600_000 },
    ]);
    expect(r.roomTotal).toBe(1_200_000);
    expect(r.policy).toMatchObject({
      cancellation: "no_automatic_penalty",
      check_in_time: "14:00",
      check_out_time: "12:00",
    });
  });

  it("báo giá theo phòng cụ thể (unit_id) cho cùng kết quả", async () => {
    expect((await q(frontDesk, "2026-10-20", "2026-10-22", 1, { unitId: A.unitId })).roomTotal).toBe(
      1_200_000,
    );
  });

  it.each([
    ["mặc định đêm thứ Sáu + thứ Bảy", null, 2_000_000],
    ["cơ sở cấu hình đêm thứ Bảy + Chủ nhật", [6, 7], 1_900_000],
  ])("S-002 %s: 22/10 → 25/10", async (_n, weekend, total) => {
    await sql`update properties set settings = case when ${JSON.stringify(weekend)}::jsonb = 'null'::jsonb
                  then settings - 'weekend_nights' else jsonb_set(settings, '{weekend_nights}', ${JSON.stringify(weekend)}::jsonb) end
              where id = ${A.propertyId}`.execute(t.admin);
    expect((await q(frontDesk, "2026-10-22", "2026-10-25")).roomTotal).toBe(total);
  });
});

describe("ca biên báo giá", () => {
  it("S-014: 3 khách với STD sức chứa 2 → 422 CAPACITY_EXCEEDED", async () => {
    await expect(q(frontDesk, "2026-10-20", "2026-10-22", 3)).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
      status: 422,
    });
  });

  it("ngày không có giá → 422 RATE_NOT_CONFIGURED; loại phòng chưa có bảng giá cũng vậy", async () => {
    await expect(q(frontDesk, "2025-12-30", "2026-01-02")).rejects.toMatchObject({
      code: "RATE_NOT_CONFIGURED",
    });
    const { roomTypeId } = await okAs(t, owner, (ctx) =>
      createRoomType(ctx, { propertyId: A.propertyId, code: "VIP", name: "Hạng sang", capacity: 3 }),
    );
    await expect(q(frontDesk, "2026-10-20", "2026-10-22", 2, { roomTypeId })).rejects.toMatchObject({
      code: "RATE_NOT_CONFIGURED",
    });
  });

  it("31 đêm (Q-10 tối đa 30) và ngày đi ≤ ngày đến → 422 VALIDATION_FAILED", async () => {
    await expect(q(frontDesk, "2026-10-01", "2026-11-01")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(q(frontDesk, "2026-10-22", "2026-10-22")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("buồng phòng báo giá → 403; tổ chức khác → 404", async () => {
    await expect(q(housekeeping, "2026-10-20", "2026-10-22")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(q(ownerB, "2026-10-20", "2026-10-22")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S-021 rate.set giữ lịch sử, chỉ owner", () => {
  it("owner đổi giá từ 01/11: bản cũ đóng 31/10, bản mới mở; báo giá theo đêm của từng bản", async () => {
    const r = await okAs(t, owner, (ctx) =>
      setRate(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 650_000,
        weekendPrice: 750_000,
        effectiveFrom: "2026-11-01",
      }),
    );
    expect(r.effectiveFrom).toBe("2026-11-01");
    const rows = await sql<{ f: string; t: string | null; wd: string }>`
      select effective_from::text as f, effective_to::text as t, weekday_price::text as wd from rate_plans
      where room_type_id = ${A.roomTypeId} order by effective_from`.execute(t.admin);
    expect(rows.rows).toEqual([
      { f: "2026-01-01", t: "2026-10-31", wd: "600000" },
      { f: "2026-11-01", t: null, wd: "650000" },
    ]);
    // Đêm 28/10 (thứ Tư) giá cũ, 02/11 (thứ Hai) giá mới.
    const mixed = await q(frontDesk, "2026-10-28", "2026-10-29");
    const after = await q(frontDesk, "2026-11-02", "2026-11-03");
    expect([mixed.roomTotal, after.roomTotal]).toEqual([600_000, 650_000]);
  });

  it("cùng ngày hiệu lực → sửa giá bản đó; lùi trước bản đang mở → 422", async () => {
    await okAs(t, owner, (ctx) =>
      setRate(ctx, {
        roomTypeId: A.roomTypeId,
        weekdayPrice: 660_000,
        weekendPrice: 760_000,
        effectiveFrom: "2026-11-01",
      }),
    );
    expect((await q(frontDesk, "2026-11-02", "2026-11-03")).roomTotal).toBe(660_000);
    expect(
      await codeOf(
        runAs(t, owner, (ctx) =>
          setRate(ctx, {
            roomTypeId: A.roomTypeId,
            weekdayPrice: 1,
            weekendPrice: 1,
            effectiveFrom: "2026-10-15",
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("quản lý/lễ tân đặt giá → 403 (D-008, ma trận); RLS chặn ghi thẳng", async () => {
    for (const a of [manager, frontDesk]) {
      expect(
        await codeOf(
          runAs(t, a, (ctx) => setRate(ctx, { roomTypeId: A.roomTypeId, weekdayPrice: 1, weekendPrice: 1 })),
        ),
      ).toBe("FORBIDDEN");
    }
    await expect(
      withTenant(t.runtime, { orgId: A.orgId, actorId: manager.membershipId }, (trx) =>
        sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.roomTypeId}, 1, 1, '2030-01-01')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("CSDL chặn hai bảng giá chồng hiệu lực và giá ≤ 0", async () => {
    await expect(
      sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from, effective_to)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.roomTypeId}, 1, 1, '2026-10-01', '2026-10-05')`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/ex_rate_plans_no_overlap/);
    await expect(
      sql`insert into rate_plans (id, organization_id, property_id, room_type_id, weekday_price, weekend_price, effective_from, effective_to)
          values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${A.roomTypeId}, 0, 1, '2020-01-01', '2020-01-02')`.execute(
        t.admin,
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe("room_type.create/update", () => {
  it("mã trùng trong cơ sở → 422; đổi sức chứa có audit; buồng phòng → 403", async () => {
    expect(
      await codeOf(
        runAs(t, owner, (ctx) =>
          createRoomType(ctx, { propertyId: A.propertyId, code: "STD", name: "Trùng", capacity: 2 }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    await okAs(t, owner, (ctx) => updateRoomType(ctx, { roomTypeId: A.roomTypeId, capacity: 3 }));
    expect((await q(frontDesk, "2026-10-20", "2026-10-21", 3)).roomTotal).toBe(600_000);
    await okAs(t, owner, (ctx) => updateRoomType(ctx, { roomTypeId: A.roomTypeId, capacity: 2 }));
    expect(
      await codeOf(
        runAs(t, housekeeping, (ctx) =>
          createRoomType(ctx, { propertyId: A.propertyId, code: "HK", name: "x", capacity: 1 }),
        ),
      ),
    ).toBe("FORBIDDEN");
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from audit_events where organization_id = ${A.orgId} and action = 'room_type.updated'`.execute(
      t.admin,
    );
    expect(audit.rows[0]?.n).toBe(2);
  });
});
