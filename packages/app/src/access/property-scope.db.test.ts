// Phạm vi cơ sở (SPEC-access S-015, T012): lễ tân chỉ được giao CS1 thao tác sang CS2 cùng tổ chức → 404, không tạo gì.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHold, getUnitStatus } from "../inventory/inventory.ts";
import { listRooms } from "../inventory/rooms.ts";
import { createReservation } from "../stay/reservations.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";

let h: Hotel;
let unitCs2: string;
let propertyCs2: string;

const during = { start: new Date("2026-11-20T07:00:00Z"), end: new Date("2026-11-22T05:00:00Z") };

const count = async (table: "allocations" | "reservations", where = sql``) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${h.org.orgId} ${where}`.execute(
      h.t.admin,
    )
  ).rows[0]?.n ?? -1;

beforeAll(async () => {
  h = await seedHotel();
  propertyCs2 = randomUUID();
  unitCs2 = randomUUID();
  const floor = randomUUID();
  await sql`insert into properties (id, organization_id, name, template) values (${propertyCs2}, ${h.org.orgId}, 'KS Mai — CS2', 'hotel')`.execute(
    h.t.admin,
  );
  await sql`insert into floors (id, organization_id, property_id, name) values (${floor}, ${h.org.orgId}, ${propertyCs2}, 'Tầng 3')`.execute(
    h.t.admin,
  );
  await sql`insert into units (id, organization_id, property_id, floor_id, code) values (${unitCs2}, ${h.org.orgId}, ${propertyCs2}, ${floor}, '301')`.execute(
    h.t.admin,
  );
});

afterAll(async () => {
  await h?.t.drop();
});

describe("SPEC-access S-015: vượt phạm vi cơ sở", () => {
  it("lễ tân (phạm vi CS1) giữ phòng của CS2 → NOT_FOUND, không có allocation; owner thì giữ được", async () => {
    const before = await count("allocations");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) => createHold(ctx, { unitId: unitCs2, during, ttlMinutes: 15 })),
      ),
    ).toBe("NOT_FOUND");
    expect(await count("allocations")).toBe(before);
    expect(
      await codeOf(
        runAs(h.t, h.owner, (ctx) => createHold(ctx, { unitId: unitCs2, during, ttlMinutes: 15 })),
      ),
    ).toBe("COMMITTED");
    expect(await count("allocations")).toBe(before + 1);
  });

  it("lễ tân xem trạng thái phòng và danh sách phòng: CS2 không lộ; phòng CS1 xem được", async () => {
    await expect(getUnitStatus(h.t.runtime, h.frontDesk, unitCs2)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(getUnitStatus(h.t.runtime, h.frontDesk, h.units.r201)).resolves.toMatchObject({
      unitId: h.units.r201,
    });
    const rooms = await listRooms(h.t.runtime, h.frontDesk);
    expect(JSON.stringify(rooms)).not.toContain(unitCs2);
  });

  it("đổi phòng sang CS2 khi tạo booking → NOT_FOUND, không tạo booking", async () => {
    const before = await count("reservations");
    expect(
      await codeOf(
        runAs(h.t, h.frontDesk, (ctx) =>
          createReservation(ctx, {
            unitId: unitCs2,
            arrivalDate: "2026-11-20",
            departureDate: "2026-11-22",
            guests: 2,
            source: "direct",
            booker: { fullName: "Khách Giả", phone: "0912345678" },
          }),
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(await count("reservations")).toBe(before);
    // Đối chứng: cùng đầu vào ở phòng CS1 thành công → lỗi trên là do phạm vi, không do đầu vào.
    await okAs(h.t, h.frontDesk, (ctx) =>
      createReservation(ctx, {
        unitId: h.units.r201,
        arrivalDate: "2026-11-20",
        departureDate: "2026-11-22",
        guests: 2,
        source: "direct",
        booker: { fullName: "Khách Giả", phone: "0912345678" },
      }),
    );
  });
});
