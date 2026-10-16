// T-223 — cơ sở trong phạm vi cho màn vận hành: phạm vi, ngày kinh doanh theo giờ chốt, ca mở của chính người xem, quyền.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openShift } from "../shifts/shifts.ts";
import { okAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { opsProperties } from "./properties.ts";

let h: Hotel;

beforeAll(async () => {
  h = await seedHotel({ cutoff: "04:00" });
});

afterAll(async () => {
  await h?.t.drop();
});

describe("opsProperties", () => {
  it("trả cơ sở trong phạm vi với múi giờ + ngày kinh doanh theo giờ chốt 04:00 (01:30 địa phương → ngày hôm trước)", async () => {
    // 2026-10-20 18:30Z = 01:30 ngày 21/10 giờ Việt Nam → trước giờ chốt 04:00 → ngày kinh doanh 20/10.
    const before = await opsProperties(h.t.runtime, h.owner, new Date("2026-10-20T18:30:00Z"));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      id: h.org.propertyId,
      template: "hotel",
      timezone: "Asia/Ho_Chi_Minh",
      businessDate: "2026-10-20",
      openShift: false,
    });
    // 05:00 địa phương = sau giờ chốt → ngày 21/10.
    const after = await opsProperties(h.t.runtime, h.owner, new Date("2026-10-20T22:00:00Z"));
    expect(after[0]?.businessDate).toBe("2026-10-21");
  });

  it("openShift chỉ đúng với người đang mở ca (người khác cùng cơ sở: false)", async () => {
    await okAs(h.t, h.frontDesk, (ctx) => openShift(ctx, { propertyId: h.org.propertyId, openingCash: 0 }));
    expect((await opsProperties(h.t.runtime, h.frontDesk))[0]?.openShift).toBe(true);
    expect((await opsProperties(h.t.runtime, h.frontDesk2))[0]?.openShift).toBe(false);
  });

  it("phạm vi: nhân viên chỉ thấy cơ sở được giao; cơ sở lưu trữ và tổ chức khác không lộ", async () => {
    expect((await opsProperties(h.t.runtime, h.ownerOther)).map((p) => p.id)).not.toContain(h.org.propertyId);
    await sql`update properties set archived_at = now() where id = ${h.other.propertyId}`.execute(h.t.admin);
    expect(await opsProperties(h.t.runtime, h.ownerOther)).toEqual([]);
  });

  it("vai trò không xem được lịch phòng (không có quyền calendar.read_status) → FORBIDDEN", async () => {
    await expect(opsProperties(h.t.runtime, { ...h.housekeeping, role: "tenant" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
