// T-202 — lịch phòng (SPEC-inventory-allocation S-021, S-022, Q-05) và trạng thái ba chiều (S-014) trên Postgres thật.
import { randomUUID } from "node:crypto";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedLease,
  seedOrg,
  seedReservation,
  type TestDb,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, resolveActor } from "../access/actor.ts";
import { type CalendarView, getCalendar, getUnitStatus, MAX_CALENDAR_DAYS } from "./calendar.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let housekeeping: Actor;
let frontDesk: Actor;
let tenantRole: Actor;
let floor2: string;
let typeDeluxe: string;
let u: Record<string, string>; // mã phòng → id
let leaseNumber: string;

const REP_NAME = "Nguyễn Thị Khách Thuê";
const STAY_GUEST = "Trần Văn Khách Lưu Trú";
const BLOCK_REASON = "Sơn lại tường (bảo trì)";
const iso = (s: string) => new Date(s);

async function addMember(orgId: string, propertyId: string, role: string, fullName: string): Promise<string> {
  const authUser = await seedAuthUser(t.admin, `cal+${randomUUID().slice(0, 8)}@example.test`);
  const person = randomUUID();
  const membership = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${orgId}, ${fullName})`.execute(
    t.admin,
  );
  await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
            values (${membership}, ${orgId}, ${authUser}, ${person}, ${role})`.execute(t.admin);
  await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
            values (${randomUUID()}, ${orgId}, ${membership}, ${propertyId})`.execute(t.admin);
  return authUser;
}

async function addUnit(code: string, floorId: string, typeId: string | null): Promise<string> {
  const id = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code)
            values (${id}, ${A.orgId}, ${A.propertyId}, ${floorId}, ${typeId}, ${code})`.execute(t.admin);
  return id;
}

async function alloc(
  unitId: string,
  kind: "hold" | "stay" | "lease" | "block",
  start: string,
  end: string | null,
  extra: { expiresAt?: string; sourceType?: string; sourceId?: string; active?: boolean } = {},
) {
  await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during, expires_at,
                                     active, deactivated_at, deactivated_reason)
            values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${unitId}, ${kind}, ${extra.sourceType ?? null},
                    ${extra.sourceId ?? null}, tstzrange(${iso(start)}, ${end ? iso(end) : null}, '[)'),
                    ${extra.expiresAt ? iso(extra.expiresAt) : null}, ${extra.active ?? true},
                    ${extra.active === false ? new Date() : null}, ${extra.active === false ? "cancelled" : null})`.execute(
    t.admin,
  );
}

const cal = (actor: Actor, over: Partial<Parameters<typeof getCalendar>[2]> = {}) =>
  getCalendar(t.runtime, actor, {
    propertyId: A.propertyId,
    from: "2026-10-15",
    to: "2026-10-21",
    now: iso("2026-10-16T03:00:00Z"),
    ...over,
  });

const codes = (v: CalendarView) => v.rooms.map((r) => r.code);
const WITHOUT_UNITS = "00000000-0000-0000-0000-00000000dead";

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS Lịch");
  B = await seedOrg(t.admin, "KS Khác");
  floor2 = randomUUID();
  typeDeluxe = randomUUID();
  await sql`insert into floors (id, organization_id, property_id, name, sort_order) values (${floor2}, ${A.orgId}, ${A.propertyId}, 'Tầng 2', 2)`.execute(
    t.admin,
  );
  await sql`insert into room_types (id, organization_id, property_id, code, name, capacity)
            values (${typeDeluxe}, ${A.orgId}, ${A.propertyId}, 'DLX', 'Cao cấp', 3)`.execute(t.admin);
  u = { "101": A.unitId };
  u["102"] = await addUnit("102", A.floorId, A.roomTypeId);
  u["204"] = await addUnit("204", A.floorId, null); // phòng chưa gán loại, đặt ở tầng 1
  u["201"] = await addUnit("201", floor2, typeDeluxe);
  u["202"] = await addUnit("202", floor2, A.roomTypeId);
  u["203"] = await addUnit("203", floor2, null);
  await sql`update units set availability = 'out_of_service', availability_reason = 'Vỡ ống nước' where id = ${u["203"] as string}`.execute(
    t.admin,
  );

  const person = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${person}, ${A.orgId}, ${REP_NAME})`.execute(
    t.admin,
  );
  const lease = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    representativePersonId: person,
    unitId: u["201"] as string,
  });
  const n = await sql<{ number: string }>`select number from leases where id = ${lease.leaseId}`.execute(
    t.admin,
  );
  leaseNumber = n.rows[0]?.number as string;
  // 201: hợp đồng mở cuối · 202: lượt ở 15/10 14:00 → 17/10 12:00 (giờ địa phương) · 101: hold còn hạn 18→19/10
  // 102: hold HẾT HẠN chưa nhả + block 19→20/10 · 203: lượt đã nhả + lượt bắt đầu đúng lúc `to` · 204: lượt kết thúc đúng lúc `from`
  await alloc(u["201"] as string, "lease", "2026-10-01T00:00:00+07:00", null, {
    sourceType: "lease",
    sourceId: lease.leaseId,
  });
  // 202: lượt ở THẬT (booking + stays + khách chính) để lịch hiện tên khách lưu trú cho vai trò được xem.
  const guest = randomUUID();
  await sql`insert into persons (id, organization_id, full_name) values (${guest}, ${A.orgId}, ${STAY_GUEST})`.execute(
    t.admin,
  );
  const bk = await seedReservation(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    bookerPersonId: guest,
    unitId: u["202"] as string,
    roomTypeId: A.roomTypeId,
    arrivalDate: "2026-10-15",
    departureDate: "2026-10-17",
  });
  const stayId = randomUUID();
  await sql`insert into stays (id, organization_id, property_id, reservation_item_id, unit_id, status, primary_guest_person_id,
                               checked_in_at)
            values (${stayId}, ${A.orgId}, ${A.propertyId}, ${bk.itemId}, ${u["202"] as string}, 'in_house', ${guest},
                    ${iso("2026-10-15T07:00:00Z")})`.execute(t.admin);
  await alloc(u["202"] as string, "stay", "2026-10-15T14:00:00+07:00", "2026-10-17T12:00:00+07:00", {
    sourceType: "stay",
    sourceId: stayId,
  });
  await alloc(u["101"] as string, "hold", "2026-10-18T14:00:00+07:00", "2026-10-19T12:00:00+07:00", {
    expiresAt: "2026-10-17T00:00:00Z",
  });
  await alloc(u["102"] as string, "hold", "2026-10-15T14:00:00+07:00", "2026-10-16T12:00:00+07:00", {
    expiresAt: "2026-10-16T02:00:00Z",
  });
  const blockId = randomUUID();
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into blocks (id, organization_id, property_id, unit_id, period, reason, requested_by, approved_by, status, approved_at)
              values (${blockId}, ${A.orgId}, ${A.propertyId}, ${u["102"] as string},
                      tstzrange(${iso("2026-10-19T08:00:00+07:00")}, ${iso("2026-10-20T17:00:00+07:00")}, '[)'), ${BLOCK_REASON},
                      ${A.ownerMembershipId}, ${A.ownerMembershipId}, 'approved', now())`.execute(trx);
    await sql`insert into allocations (id, organization_id, property_id, unit_id, kind, source_type, source_id, during)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${u["102"] as string}, 'block', 'block', ${blockId},
                      tstzrange(${iso("2026-10-19T08:00:00+07:00")}, ${iso("2026-10-20T17:00:00+07:00")}, '[)'))`.execute(
      trx,
    );
  });
  await alloc(u["203"] as string, "stay", "2026-10-16T14:00:00+07:00", "2026-10-17T12:00:00+07:00", {
    active: false,
  });
  await alloc(u["203"] as string, "stay", "2026-10-21T00:00:00+07:00", "2026-10-22T12:00:00+07:00");
  await alloc(u["204"] as string, "stay", "2026-10-14T14:00:00+07:00", "2026-10-15T00:00:00+07:00");

  owner = await resolveActor(t.runtime, {
    authUserId: A.ownerAuthUserId,
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  housekeeping = await resolveActor(t.runtime, {
    authUserId: await addMember(A.orgId, A.propertyId, "housekeeping", "Buồng Phòng"),
    orgId: A.orgId,
    twoFactorEnabled: false,
  });
  frontDesk = await resolveActor(t.runtime, {
    authUserId: await addMember(A.orgId, A.propertyId, "front_desk", "Lễ Tân"),
    orgId: A.orgId,
    twoFactorEnabled: true,
  });
  tenantRole = await resolveActor(t.runtime, {
    authUserId: await addMember(A.orgId, A.propertyId, "tenant", "Người thuê"),
    orgId: A.orgId,
    twoFactorEnabled: false,
  });
});

afterAll(async () => {
  await t.drop();
});

describe("S-021 lịch theo cơ sở/tầng/loại", () => {
  it("S-021 lọc tầng 2: chỉ phòng tầng 2; đoạn có kind/nguồn/trạng thái nguồn/giờ địa phương", async () => {
    const v = await cal(owner, { floorId: floor2 });
    expect(codes(v)).toEqual(["201", "202", "203"]);
    expect(v.timezone).toBe("Asia/Ho_Chi_Minh");
    const r201 = v.rooms.find((r) => r.code === "201");
    expect(r201?.segments).toHaveLength(1);
    expect(r201?.segments[0]).toMatchObject({
      kind: "lease",
      source_type: "lease",
      source_status: "draft",
      label: leaseNumber,
      end: null,
      end_local: null,
      start_local: "2026-10-01T00:00",
    });
    const r202 = v.rooms.find((r) => r.code === "202");
    expect(r202?.segments).toHaveLength(1);
    expect(r202?.segments[0]).toMatchObject({
      kind: "stay",
      start: "2026-10-15T07:00:00.000Z",
      end: "2026-10-17T05:00:00.000Z",
      start_local: "2026-10-15T14:00",
      end_local: "2026-10-17T12:00",
    });
    expect(r202).toMatchObject({
      occupancy: "occupied",
      housekeeping: "clean",
      availability: "active",
      floor: { name: "Tầng 2" },
      room_type: { name: "Tiêu chuẩn" },
    });
    expect(v.rooms.find((r) => r.code === "203")).toMatchObject({
      availability: "out_of_service",
      room_type: null,
    });
  });

  it("S-021 lọc loại phòng; phòng chưa gán loại không lọt; loại lạ → rỗng", async () => {
    expect(codes(await cal(owner, { roomTypeId: A.roomTypeId }))).toEqual(["101", "102", "202"]);
    expect(codes(await cal(owner, { roomTypeId: typeDeluxe }))).toEqual(["201"]);
    expect(codes(await cal(owner, { roomTypeId: randomUUID() }))).toEqual([]);
    expect(codes(await cal(owner, { floorId: floor2, roomTypeId: A.roomTypeId }))).toEqual(["202"]);
  });

  it("S-021 không lọc: sắp theo tầng → mã phòng; hold còn hạn hiện kèm expires_at, hold hết hạn chưa nhả thì ẩn, block hiện", async () => {
    const v = await cal(owner);
    expect(codes(v)).toEqual(["101", "102", "204", "201", "202", "203"]);
    const by = Object.fromEntries(v.rooms.map((r) => [r.code, r]));
    expect(by["101"]?.segments).toMatchObject([{ kind: "hold", expires_at: "2026-10-17T00:00:00.000Z" }]);
    expect(by["101"]?.occupancy).toBe("vacant");
    expect(by["102"]?.segments.map((s) => s.kind)).toEqual(["block"]); // hold hết hạn không hiện
    expect(v.next_cursor).toBeNull();
  });

  it("S-021 khoảng nửa mở [from, to): đoạn kết thúc đúng lúc from hoặc bắt đầu đúng lúc to không chồng; allocation đã nhả không hiện", async () => {
    const v = await cal(owner);
    expect(v.rooms.find((r) => r.code === "204")?.segments).toEqual([]); // kết thúc đúng 15/10 00:00 địa phương
    expect(v.rooms.find((r) => r.code === "203")?.segments).toEqual([]); // bắt đầu đúng 21/10 00:00; đoạn đã nhả
    const wider = await cal(owner, { to: "2026-10-22" });
    expect(wider.rooms.find((r) => r.code === "203")?.segments).toHaveLength(1);
    const narrow = await cal(owner, { from: "2026-10-18", to: "2026-10-19" });
    expect(narrow.rooms.find((r) => r.code === "202")?.segments).toEqual([]);
  });

  it("S-021 cơ sở chưa có phòng → rooms rỗng, không con trỏ (UI hiện 'Chưa có phòng — thêm phòng')", async () => {
    const empty = randomUUID();
    await sql`insert into properties (id, organization_id, name, template) values (${empty}, ${A.orgId}, 'CS trống', 'hotel')`.execute(
      t.admin,
    );
    const v = await getCalendar(t.runtime, owner, {
      propertyId: empty,
      from: "2026-10-15",
      to: "2026-10-16",
    });
    expect(v).toMatchObject({ rooms: [], next_cursor: null });
  });
});

describe("S-021 vai trò và dữ liệu nhạy cảm", () => {
  it("S-021 housekeeping nhận cùng lịch nhưng không có tên khách, lý do ngừng khai thác, số tiền", async () => {
    const hk = await cal(housekeeping);
    const own = await cal(owner);
    expect(hk.rooms.map((r) => [r.code, r.segments.map((s) => s.allocation_id)])).toEqual(
      own.rooms.map((r) => [r.code, r.segments.map((s) => s.allocation_id)]),
    );
    const hk201 = hk.rooms.find((r) => r.code === "201")?.segments[0];
    expect(hk201?.guest_name).toBeNull();
    // RLS của `leases` (0014) còn che hợp đồng khỏi vai trò không phải owner/manager/front_desk/accountant: đoạn vẫn hiện, nhãn nguồn rỗng.
    expect(hk201).toMatchObject({ kind: "lease", label: null, source_status: null });
    expect(hk.rooms.find((r) => r.code === "203")?.availability_reason).toBeNull();
    expect(JSON.stringify(hk)).not.toContain(REP_NAME);
    expect(JSON.stringify(hk)).not.toContain("Vỡ ống nước");
    expect(JSON.stringify(own)).not.toMatch(/amount|rent|deposit|price|total/i);
    expect(own.rooms.find((r) => r.code === "201")?.segments[0]?.guest_name).toBe(REP_NAME);
    expect(own.rooms.find((r) => r.code === "203")?.availability_reason).toBe("Vỡ ống nước");
  });

  it("review: đoạn lưu trú (stay) có tên khách chính cho owner/lễ tân, buồng phòng KHÔNG thấy; lý do block bị che như availability_reason", async () => {
    const seg = (v: CalendarView, code: string, kind: string) =>
      v.rooms.find((r) => r.code === code)?.segments.find((x) => x.kind === kind);
    for (const actor of [owner, frontDesk]) {
      const v = await cal(actor);
      expect(seg(v, "202", "stay")?.guest_name).toBe(STAY_GUEST);
      expect(seg(v, "102", "block")?.label).toBe(BLOCK_REASON);
    }
    const hk = await cal(housekeeping);
    expect(seg(hk, "202", "stay")).toBeDefined();
    expect(seg(hk, "202", "stay")?.guest_name).toBeNull();
    expect(seg(hk, "102", "block")).toBeDefined();
    expect(seg(hk, "102", "block")?.label).toBeNull();
    expect(JSON.stringify(hk)).not.toContain(STAY_GUEST);
    expect(JSON.stringify(hk)).not.toContain(BLOCK_REASON);
  });

  it("vai trò không có quyền xem lịch (tenant) → FORBIDDEN", async () => {
    await expect(cal(tenantRole)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("S-022 chéo tenant: cơ sở của tổ chức khác → NOT_FOUND; ngoài phạm vi cơ sở → NOT_FOUND", async () => {
    await expect(cal(owner, { propertyId: B.propertyId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(cal({ ...housekeeping, propertyIds: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cal(owner, { propertyId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S-021 giới hạn khoảng truy vấn (Q-05)", () => {
  it(`tối đa ${MAX_CALENDAR_DAYS} ngày: 62 ngày được, 63 ngày → VALIDATION_FAILED`, async () => {
    await expect(cal(owner, { from: "2026-10-01", to: "2026-12-02" })).resolves.toBeDefined();
    await expect(cal(owner, { from: "2026-10-01", to: "2026-12-03" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it.each([
    ["khoảng rỗng (from = to)", { from: "2026-10-15", to: "2026-10-15" }],
    ["khoảng ngược (to < from)", { from: "2026-10-16", to: "2026-10-15" }],
    ["ngày không có thật", { from: "2026-02-30", to: "2026-03-05" }],
    ["định dạng sai", { from: "15/10/2026", to: "2026-10-16" }],
    ["limit 0", { limit: 0 }],
    ["limit quá lớn", { limit: 201 }],
    ["con trỏ rác", { cursor: "khong-phai-con-tro" }],
    ["con trỏ sai cấu trúc", { cursor: Buffer.from('["a",1]').toString("base64url") }],
  ] as const)("%s → VALIDATION_FAILED", async (_name, over) => {
    await expect(cal(owner, over)).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });
});

describe("S-021 phân trang theo phòng", () => {
  async function pages(limit: number): Promise<CalendarView[]> {
    const out: CalendarView[] = [];
    let cursor: string | undefined;
    do {
      const v = await cal(owner, { limit, ...(cursor ? { cursor } : {}) });
      out.push(v);
      cursor = v.next_cursor ?? undefined;
    } while (cursor && out.length < 20);
    return out;
  }

  it.each([1, 2, 4, 6, 50])(
    "limit %i: gộp các trang = đúng toàn bộ phòng, không trùng, không sót, đúng thứ tự",
    async (limit) => {
      const all = (await pages(limit)).flatMap(codes);
      expect(all).toEqual(["101", "102", "204", "201", "202", "203"]);
    },
  );

  it("trang cuối đúng bằng limit → không con trỏ thừa; phòng thêm giữa các trang không làm trùng/sót phần còn lại", async () => {
    const exact = await cal(owner, { limit: 6 });
    expect(exact.next_cursor).toBeNull();
    const first = await cal(owner, { limit: 4 });
    expect(codes(first)).toEqual(["101", "102", "204", "201"]);
    const added = await addUnit("103", A.floorId, A.roomTypeId); // xếp TRƯỚC con trỏ
    try {
      const second = await cal(owner, {
        limit: 4,
        ...(first.next_cursor ? { cursor: first.next_cursor } : {}),
      });
      expect(codes(second)).toEqual(["202", "203"]);
      expect(second.next_cursor).toBeNull();
    } finally {
      await sql`delete from units where id = ${added}`.execute(t.admin);
    }
  });

  it("con trỏ không cho đọc phòng của tổ chức khác (RLS giữ ranh giới; con trỏ chỉ là vị trí sắp xếp)", async () => {
    const v = await cal(owner, {
      limit: 1,
      cursor: Buffer.from(JSON.stringify([0, "", "", WITHOUT_UNITS])).toString("base64url"),
    });
    expect(v.rooms.length).toBeGreaterThan(0);
    expect(v.rooms.every((r) => Object.values(u).includes(r.unit_id))).toBe(true);
  });
});

describe("S-014 getUnitStatus — ba chiều độc lập", () => {
  const AT = iso("2026-10-16T03:00:00Z");
  async function unit(code: string, hk: string, availability = "active"): Promise<string> {
    const id = await addUnit(code, A.floorId, A.roomTypeId);
    await sql`update units set housekeeping_status = ${hk}, availability = ${availability},
                availability_reason = ${availability === "active" ? null : "sự cố"} where id = ${id}`.execute(
      t.admin,
    );
    return id;
  }

  it.each([
    ["trống · inspected · active", "inspected", "active", null, "vacant", true, true],
    ["trống · dirty · active", "dirty", "active", null, "vacant", true, false],
    ["trống · clean · active", "clean", "active", null, "vacant", true, true],
    ["có khách · inspected · active", "inspected", "active", "stay", "occupied", false, false],
    ["trống · inspected · bị block", "inspected", "active", "block", "blocked", false, false],
    ["trống · clean · out_of_service", "clean", "out_of_service", null, "vacant", false, false],
  ] as const)("%s", async (name, hk, availability, alloc_kind, occupancy, sellable, ready) => {
    const id = await unit(`S14-${name.slice(0, 6)}-${randomUUID().slice(0, 4)}`, hk, availability);
    if (alloc_kind) await alloc(id, alloc_kind, "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z");
    const s = await getUnitStatus(t.runtime, owner, { unitId: id, at: AT });
    expect(s).toMatchObject({
      occupancy,
      housekeeping: hk,
      availability,
      sellable,
      ready_for_arrival: ready,
    });
  });

  it("hold còn hạn tại T → held, không bán được; hold hết hạn chưa nhả → vẫn trống", async () => {
    const a = await unit(`S14-h1-${randomUUID().slice(0, 4)}`, "clean");
    await alloc(a, "hold", "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z", {
      expiresAt: "2026-10-16T04:00:00Z",
    });
    expect(await getUnitStatus(t.runtime, owner, { unitId: a, at: AT })).toMatchObject({
      occupancy: "held",
      sellable: false,
    });
    const b = await unit(`S14-h2-${randomUUID().slice(0, 4)}`, "clean");
    await alloc(b, "hold", "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z", {
      expiresAt: "2026-10-16T02:00:00Z",
    });
    expect(await getUnitStatus(t.runtime, owner, { unitId: b, at: AT })).toMatchObject({
      occupancy: "vacant",
      sellable: true,
    });
  });

  it("phòng không có / phòng của tổ chức khác → NOT_FOUND; tenant → FORBIDDEN", async () => {
    await expect(getUnitStatus(t.runtime, owner, { unitId: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getUnitStatus(t.runtime, owner, { unitId: B.unitId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getUnitStatus(t.runtime, tenantRole, { unitId: A.unitId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
